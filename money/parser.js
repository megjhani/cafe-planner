// Chase statement reader: turns a statement PDF into transactions.
// Works in the browser (pdf.js from cdnjs) and in Node tests (pdfjs-dist).
//
// Two layouts are supported:
//   bank  Chase Business Complete Checking: sections marked *start*... *end*,
//         each transaction "MM/DD | description | amount" plus continuation lines.
//   card  Chase credit card: ACCOUNT ACTIVITY lines "MM/DD | merchant | amount",
//         negative amounts are payments and refunds.
// Every statement is checked against the totals Chase prints on it.

// Rebuild text lines from positioned text items: same y = same line, sorted by x.
// Items further apart than a word gap are joined with " | " so columns stay separate.
export async function pdfLines(pdfjs, data) {
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  const out = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    const rows = [];
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const x = it.transform[4], y = it.transform[5];
      let r = rows.find(r => Math.abs(r.y - y) < 2.5);
      if (!r) rows.push(r = { y, items: [] });
      r.items.push({ x, s: it.str, w: it.width });
    }
    rows.sort((a, b) => b.y - a.y);
    for (const r of rows) {
      r.items.sort((a, b) => a.x - b.x);
      let line = '', end = null;
      for (const it of r.items) {
        if (end !== null) line += it.x - end > 8 ? ' | ' : it.x - end > 0.5 ? ' ' : '';
        line += it.s; end = it.x + it.w;
      }
      out.push({ page: p, x: r.items[0].x, text: line.replace(/\s+/g, ' ').trim() });
    }
  }
  return out;
}

const num = s => +String(s).replace(/[$,\s]/g, '');
const cents = v => Math.round(v * 100);
const MONTHS = { January: 1, February: 2, March: 3, April: 4, May: 5, June: 6, July: 7, August: 8, September: 9, October: 10, November: 11, December: 12 };
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

// MM/DD inside a statement that ends in endY-endM: a later month belongs to the year before
const dateIn = (md, endY, endM) => { const [m, d] = md.split('/').map(Number); return iso(m > endM ? endY - 1 : endY, m, d); };

// short, stable id so the same transaction from two uploads is stored once
function txId(acct, t, n) {
  const s = `${acct}|${t.date}|${cents(t.amount)}|${t.desc}|${n}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return acct + '-' + t.date.replace(/-/g, '') + '-' + (h >>> 0).toString(36);
}
function withIds(acct, txns) {
  const seen = {};
  return txns.map(t => { const k = t.date + t.amount + t.desc; seen[k] = (seen[k] || 0) + 1; return { ...t, id: txId(acct, t, seen[k]) }; });
}

export function parseStatement(lines) {
  const all = lines.map(l => l.text).join('\n');
  if (/Chase Business Complete Checking|CHECKING SUMMARY/.test(all)) return parseBank(lines);
  if (/ACCOUNT ?ACTIVITY|ACCOUNTACCOUNT ACTIVITYACTIVITY/.test(all) && /Opening\/Closing Date/.test(all)) return parseCard(lines);
  throw new Error('Not a Chase checking or credit card statement this app knows');
}

// ---- Chase business checking ----
const BANK_SECTIONS = [
  ['deposits and additions', 'deposit', 1, /^Deposits and Additions\b/],
  ['checks paid', 'check', -1, /^Checks Paid\b/],
  ['atm debit withdrawal', 'atm', -1, /^ATM & Debit Card Withdrawals\b/],
  ['electronic withdrawal', 'electronic', -1, /^Electronic Withdrawals\b/],
  ['other withdrawal', 'other', -1, /^Other Withdrawals\b/],
  ['fees section', 'fee', -1, /^Fees\b/],
];
function parseBank(lines) {
  const text = lines.map(l => l.text);
  const per = text.join('\n').match(/([A-Z][a-z]+) (\d{2}), (\d{4}) through ([A-Z][a-z]+) (\d{2}), (\d{4})/);
  if (!per) throw new Error('Could not find the statement period');
  const start = iso(+per[3], MONTHS[per[1]], +per[2]), end = iso(+per[6], MONTHS[per[4]], +per[5]);
  const endY = +per[6], endM = MONTHS[per[4]];
  const acctNo = (text.join(' ').match(/Account Number: \| 0*(\d+)/) || [])[1] || '';
  const last4 = acctNo.slice(-4);

  // summary totals printed on page 1: section -> amount
  const reported = {};
  let beginning = null, ending = null;
  for (const t of text) {
    for (const [, key, , re] of BANK_SECTIONS) if (re.test(t)) { const m = t.match(/(-?\$?[\d,]+\.\d\d)$/); if (m && reported[key] == null) reported[key] = Math.abs(num(m[1])); }
    let m;
    if ((m = t.match(/^Beginning Balance \| (-?\$?[\d,]+\.\d\d)/)) && beginning == null) beginning = num(m[1]);
    if ((m = t.match(/^Ending Balance \|.*?(-?\$?[\d,]+\.\d\d)$/)) && ending == null) ending = num(m[1]);
  }

  const txns = [];
  let sec = null, cur = null;
  const flush = () => { if (cur) { cur.desc = cur.desc.replace(/\s*\|\s*/g, ' ').replace(/\s+/g, ' ').trim(); txns.push(cur); cur = null; } };
  for (const l of lines) {
    const t = l.text;
    const st = t.match(/^\*start\*(.+)$/), en = t.match(/^\*end\*(.+)$/);
    // newer downloads drop spaces in the markers: "*start*electronicwithdrawal"
    if (st) { flush(); const nm = st[1].replace(/\s/g, ''); sec = BANK_SECTIONS.find(([k]) => nm.startsWith(k.replace(/\s/g, ''))) || null; continue; }
    if (en) { flush(); sec = null; continue; }
    if (!sec) continue;
    const [, key, sign] = sec;
    if (/^Total /.test(t) || /^(DATE|CHECK NO\.)\b/.test(t) || /^\(continued\)$/.test(t)) { flush(); continue; }
    if (key === 'check') {
      // "107 ^ | 01/07 | $484.00" (several checks may share one line)
      // also "141 * ^ | 02/13 | 1,005.00" and "131 | ^ | 08/03 | $170.00"
      const re = /(\d{2,8})(?:\s*[*^|])*\s*(?:([A-Za-z][^|]*?)\s*\|\s*)?(\d{2}\/\d{2})\s*\|\s*\$?([\d,]+\.\d\d)/g;
      let m, any = false;
      while ((m = re.exec(t))) { any = true; txns.push({ date: dateIn(m[3], endY, endM), desc: `Check #${m[1]}${m[2] && !/^\d{2}\/\d{2}$/.test(m[2]) ? ' ' + m[2] : ''}`, amount: -num(m[4]), section: key, check: m[1] }); }
      if (any) continue;
    }
    const m = t.match(/^(\d{2}\/\d{2}) \| (.*?) \| \$?(-?[\d,]+\.\d\d)$/);
    if (m) { flush(); cur = { date: dateIn(m[1], endY, endM), desc: m[2], amount: sign * Math.abs(num(m[3])), section: key }; continue; }
    // continuation line of the transaction above (ignore stray barcode numbers)
    if (cur && l.x > 60 && !/^\d{15,}$/.test(t)) cur.desc += ' ' + t.replace(/\s*\|\s*\d{15,}$/, '');
  }
  flush();
  for (const t of txns) { t.payee = bankPayee(t); t.desc = tidyAch(t.desc); }

  // check every section against the printed totals
  const checks = [];
  for (const [, key] of BANK_SECTIONS) {
    const got = cents(Math.abs(txns.filter(t => t.section === key).reduce((p, t) => p + t.amount, 0)));
    const want = reported[key] == null ? 0 : cents(reported[key]);
    if (got || want) checks.push({ what: key, parsed: got / 100, statement: want / 100, ok: got === want });
  }
  if (beginning != null && ending != null) {
    const got = cents(beginning + txns.reduce((p, t) => p + t.amount, 0));
    checks.push({ what: 'ending balance', parsed: got / 100, statement: ending, ok: got === cents(ending) });
  }
  return { kind: 'bank', account: { id: 'chk' + last4, last4, name: 'Chase checking …' + last4 }, start, end, txns: withIds('chk' + last4, txns), checks, opening: beginning, ending };
}

// Bank transfer (ACH) text carries trace numbers, internal IDs and people's names. Keep only
// who it was and what kind: "Orig CO Name:Accountantsworld ... Descr:Payrolldbtsec:CCD ..." -> "Accountantsworld · Payrolldbt"
function tidyAch(d) {
  const co = d.match(/Orig CO Name:(.+?)\s+Orig ID:/);
  if (!co) return d.replace(/\s*Transaction#:\s*\d+/, '');
  const de = d.match(/Descr:\s*(.*?)\s*(?:sec:|Sec:|\||$)/);
  return co[1].trim() + (de && de[1] ? ' · ' + de[1].trim() : '');
}

// "Orig CO Name:Allen House Ll Orig ID:..." -> "Allen House Ll"
function bankPayee(t) {
  const d = t.desc;
  let m;
  if ((m = d.match(/Orig CO Name:(.+?)\s+Orig ID:/))) return m[1].trim();
  if ((m = d.match(/^(Online Transfer (?:From|To) \S+ \S+)/))) return m[1];
  if ((m = d.match(/^(Zelle Payment (?:To|From) .+?)(?: Jpm\w+| \d{6,}|$)/))) return m[1];
  if (/ATM Withdrawal/i.test(d)) return 'ATM cash withdrawal';
  // debit card: "Card Purchase 06/26 Amazon.Com*Fa3I31N33 Amzn.Com/Bill WA Card 6531"
  if ((m = d.match(/^(?:Recurring )?Card Purchase(?: With Pin)?\s+\d{2}\/\d{2}\s+(.+?)\s+Card \d{4}/i))) return cardPayee(m[1].toUpperCase());
  if ((m = d.match(/^Reversal: (.+?)\s+\d{2}\/\d{2}/))) return cardPayee(m[1].toUpperCase());
  if ((m = d.match(/^Card Purchase Return\s+\d{2}\/\d{2}\s+(.+?)\s+Card \d{4}/i))) return cardPayee(m[1].toUpperCase());
  if (t.section === 'check') return d;
  // "08/03 Payment To Chase Card Ending IN 0000" -> "Payment To Chase Card Ending IN 0000"
  return d.replace(/^\d{2}\/\d{2}\s+/, '').split(/ \d{2}\/\d{2} | Card \d{4}| Transaction#/)[0].slice(0, 60);
}

// ---- Chase credit card ----
function parseCard(lines) {
  const text = lines.map(l => l.text);
  const all = text.join('\n');
  const oc = all.match(/Opening\/Closing Date \| (\d{2})\/(\d{2})\/(\d{2}) - (\d{2})\/(\d{2})\/(\d{2})/);
  if (!oc) throw new Error('Could not find the statement period');
  const start = iso(2000 + +oc[3], +oc[1], +oc[2]), end = iso(2000 + +oc[6], +oc[4], +oc[5]);
  const endY = 2000 + +oc[6], endM = +oc[4];
  const last4 = (all.match(/Account Number: XXXX XXXX XXXX (\d{4})/) || [])[1] || '';
  const get = re => { const m = all.match(re); return m ? num(m[1]) : null; };
  const reported = {
    previous: get(/Previous Balance \| (-?\$?[\d,]+\.\d\d)/),
    credits: get(/Payment, Credits \| (-?\$?[\d,]+\.\d\d)/),
    purchases: get(/Purchases \| \+?(-?\$?[\d,]+\.\d\d)/),
    cash: get(/Cash Advances \| \+?(-?\$?[\d,]+\.\d\d)/),
    fees: get(/Fees Charged \| \+?(-?\$?[\d,]+\.\d\d)/),
    interest: get(/Interest Charged \| \+?(-?\$?[\d,]+\.\d\d)/),
    newBal: get(/New Balance \| (-?\$?[\d,]+\.\d\d)/),
  };

  const txns = [];
  let inAct = false;
  for (const t of text) {
    if (/ACCOUNT ?ACTIVITY|ACCOUNTACCOUNT ACTIVITYACTIVITY/.test(t)) { inAct = true; continue; }
    if (/Totals Year-to-Date|INTEREST ?CHARGES|INTERESTINTEREST/.test(t)) { inAct = false; continue; }
    if (!inAct) continue;
    const m = t.match(/^(\d{2}\/\d{2}) \| (.*) \| (-?[\d,]*\.\d\d)$/);
    if (!m) continue;
    const desc = m[2].replace(/\s*\|\s*/g, ' ').replace(/\s+/g, ' ').trim();
    // card statement: positive = you spent, negative = payment/refund. Store as money out = negative.
    const amt = -num(m[3]);
    txns.push({ date: dateIn(m[1], endY, endM), desc, amount: amt, payee: cardPayee(desc),
      section: /AUTOMATIC PAYMENT|^Payment Thank You|PAYMENT - THANK YOU/i.test(desc) ? 'card-payment' : amt > 0 ? 'refund' : /INTEREST CHARGE|LATE FEE|ANNUAL MEMBERSHIP FEE|FEE$/i.test(desc) ? 'card-fee' : 'purchase' });
  }

  const sum = f => cents(txns.filter(f).reduce((p, t) => p + t.amount, 0)) / 100;
  const checks = [];
  const spent = -sum(t => t.amount < 0);       // purchases + fees + interest on the card
  const credited = sum(t => t.amount > 0);     // payments + refunds
  const want = (reported.purchases || 0) + (reported.cash || 0) + (reported.fees || 0) + (reported.interest || 0);
  checks.push({ what: 'purchases + fees', parsed: spent, statement: cents(want) / 100, ok: cents(spent) === cents(want) });
  if (reported.credits != null) checks.push({ what: 'payments + credits', parsed: credited, statement: Math.abs(reported.credits), ok: cents(credited) === cents(Math.abs(reported.credits)) });
  if (reported.previous != null && reported.newBal != null) {
    const got = cents(reported.previous + spent - credited) / 100;
    checks.push({ what: 'new balance', parsed: got, statement: reported.newBal, ok: cents(got) === cents(reported.newBal) });
  }
  // Chase "Pay Over Time" plans: "PLAN TOTALS | $original | $remaining | ..." (older purchases paid monthly)
  const plan = all.match(/PLAN TOTALS \| \$([\d,]+\.\d\d) \| \$([\d,]+\.\d\d)/);
  return { kind: 'card', account: { id: 'card' + last4, last4, name: 'Chase card …' + last4 }, start, end, txns: withIds('card' + last4, txns), checks,
    opening: reported.previous, ending: reported.newBal, interest: reported.interest || 0,
    plan: plan ? { original: num(plan[1]), remaining: num(plan[2]) } : null };
}

// "AMAZON MKTPL*0H08O2UG3 Amzn.com/bill WA" -> "AMAZON MKTPL"; "TRADER JOE S #538 NEW YORK NY" -> "TRADER JOE S"
function cardPayee(d) {
  return d.replace(/\*.*$/, '').replace(/\s+#\s*\d+.*$/, '').replace(/\s+\d{3}-\d{3}-\d{4}.*$/, '')
    .replace(/\s+(NEW YORK|BROOKLYN|QUEENS|FOREST HILLS|LONG IS(LAND)? CITY|ASTORIA|REGO PARK|JERSEY CITY)\b.*$/i, '')
    .replace(/\s+[A-Z]{2}$/, '').replace(/\s+\d{5,}.*$/, '').trim() || d;
}
