// Tipsy Village Money: owner dashboard built from uploaded Chase statements.
// Data: fin_statements/<account>_<start> (one per statement, with its transactions)
//       fin/prefs { payee: {payee: category}, tx: {txId: category} } (your corrections)
//       fin/ledger { file, importedAt, rows: [...] } (partners' workbook: what each paid personally)
// All are owner-only in the database rules. Open with ?local to keep everything in this
// browser instead (testing / offline); nothing is sent anywhere in that mode.
import { pdfLines, parseStatement } from './parser.js';
import { CATEGORIES, GROUPS, GROUP_OF, OPEN_DATE, PARTNERS, categorize, bookAmount, startupAmount, partnerOf, isLoan } from './rules.js';
import * as A from '../access.js';

const $ = id => document.getElementById(id);
const esc = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const money = (v, dp = 0) => (v < -0.004 ? '−' : '') + '$' + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
const pct = v => isFinite(v) ? (v * 100).toFixed(1) + '%' : '–';
const mName = (m, long) => new Date(m + '-15T12:00:00').toLocaleDateString(undefined, { month: long ? 'long' : 'short', year: 'numeric' });
const dName = d => new Date(d + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const sum = (a, f) => a.reduce((p, t) => p + f(t), 0);

let RO = false; // view-only owner
let store = null, STMTS = [], PREFS = { payee: {}, tx: {} }, LEDGER = null, TX = [], MONTHS = [], PERIOD = null, VIEW = 'overview', CAT = null, SCAT = null;

// ---------- storage ----------
const localStore = {
  async statements() { try { return JSON.parse(localStorage.getItem('fin-statements')) || []; } catch { return []; } },
  async saveStatement(s) { const a = await this.statements(), i = a.findIndex(x => x.key === s.key); if (i >= 0) a[i] = s; else a.push(s); localStorage.setItem('fin-statements', JSON.stringify(a)); },
  async removeStatement(k) { localStorage.setItem('fin-statements', JSON.stringify((await this.statements()).filter(x => x.key !== k))); },
  async prefs() { try { return JSON.parse(localStorage.getItem('fin-prefs')) || {}; } catch { return {}; } },
  async savePrefs(p) { localStorage.setItem('fin-prefs', JSON.stringify(p)); },
  async ledger() { try { return JSON.parse(localStorage.getItem('fin-ledger')); } catch { return null; } },
  async saveLedger(l) { localStorage.setItem('fin-ledger', JSON.stringify(l)); },
};

async function start() {
  if (new URLSearchParams(location.search).has('local')) {
    store = localStore; $('who').textContent = 'Offline test mode (this browser only)'; $('signout').hidden = true;
    return load();
  }
  const B = 'https://www.gstatic.com/firebasejs/10.12.2/';
  const { initializeApp } = await import(B + 'firebase-app.js');
  const authMod = await import(B + 'firebase-auth.js');
  const { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, onAuthStateChanged, signOut } = authMod;
  const { getFirestore, doc, getDoc, getDocs, setDoc, deleteDoc, collection } = await import(B + 'firebase-firestore.js');
  const fb = initializeApp(window.FIREBASE_CONFIG), auth = getAuth(fb), db = getFirestore(fb);
  store = {
    statements: async () => (await getDocs(collection(db, 'fin_statements'))).docs.map(d => d.data()),
    saveStatement: s => setDoc(doc(db, 'fin_statements', s.key), s),
    removeStatement: k => deleteDoc(doc(db, 'fin_statements', k)),
    prefs: async () => { const s = await getDoc(doc(db, 'fin', 'prefs')); return s.exists() ? s.data() : {}; },
    savePrefs: p => setDoc(doc(db, 'fin', 'prefs'), p),
    ledger: async () => { const s = await getDoc(doc(db, 'fin', 'ledger')); return s.exists() ? s.data() : null; },
    saveLedger: l => setDoc(doc(db, 'fin', 'ledger'), l),
  };
  $('signin').onclick = async () => {
    const p = new GoogleAuthProvider(); p.setCustomParameters({ prompt: 'select_account' });
    try { await signInWithPopup(auth, p); }
    catch (e) { if (/popup-blocked|not-supported/.test(e.code)) signInWithRedirect(auth, p); else if (!/popup-closed|cancelled/.test(e.code)) $('gateMsg').textContent = 'Sign-in did not finish (' + e.code + ').'; }
  };
  const out = () => signOut(auth).then(() => location.reload());
  $('signout').onclick = out; $('gateOut').onclick = out;
  onAuthStateChanged(auth, async u => {
    if (!u) { $('gate').hidden = false; $('app').hidden = true; $('signin').hidden = false; $('gateOut').hidden = true; $('gateMsg').textContent = A.idleMessage(); return; }
    $('signin').hidden = true; $('gateMsg').textContent = 'Loading…';
    const mail = (u.email || '').toLowerCase();
    try {
      const role = await A.roleOf({ getDoc, doc }, db, mail, String(window.OWNER_EMAIL || '').toLowerCase());
      if (role === 'staff') { $('gateOut').hidden = false; $('gateMsg').textContent = `${mail} isn't an owner. This page is only for the planner's owners.`; return; }
      A.ownerSession(authMod, auth, () => { A.markIdle(); signOut(auth).then(() => location.reload()); });
      RO = role === 'view'; document.body.classList.toggle('ro', RO);
      $('who').textContent = mail + (RO ? ' · view only' : '');
      await load();
    } catch (e) {
      $('gateOut').hidden = false;
      $('gateMsg').textContent = e.code === 'permission-denied' ? `${mail} isn't an owner. This page is only for the planner's owners.` : 'Could not load (' + (e.code || e.message) + ').';
    }
  });
}

async function load() {
  const [st, pr, lg] = await Promise.all([store.statements(), store.prefs(), store.ledger()]);
  STMTS = st; PREFS = { payee: pr.payee || {}, tx: pr.tx || {} }; LEDGER = lg;
  $('gate').hidden = true; $('app').hidden = false;
  rebuild();
  if (!MONTHS.length) show('statements');
  render();
}

// ---------- model ----------
function rebuild() {
  const m = new Map();
  for (const s of STMTS) for (const t of s.txns) if (!m.has(t.id)) m.set(t.id, { ...t, acct: s.account.id, kind: s.kind });
  TX = [...m.values()].sort((a, b) => b.date.localeCompare(a.date) || a.amount - b.amount);
  for (const t of TX) { t.cat = categorize(t, PREFS); t.group = GROUP_OF[t.cat] || 'review'; t.book = bookAmount(t, t.cat); t.startup = startupAmount(t, t.cat); }
  // months the bank statements cover, from the month the cafe opened (earlier = Startup tab)
  const cov = new Set();
  for (const s of STMTS.filter(s => s.kind === 'bank')) { cov.add(s.start.slice(0, 7)); cov.add(s.end.slice(0, 7)); }
  MONTHS = [...cov].filter(m => m >= OPEN_DATE.slice(0, 7)).sort();
  const opts = [...MONTHS].reverse().map(m => [m, mName(m, true)]);
  if (MONTHS.length > 1) opts.unshift(['last3', 'Last 3 months'], ['ytd', 'Year to date'], ['all', 'All months']);
  if (!PERIOD || !opts.some(o => o[0] === PERIOD)) PERIOD = MONTHS.length ? MONTHS[MONTHS.length - 1] : null;
  $('period').innerHTML = opts.map(([v, l]) => `<option value="${v}"${v === PERIOD ? ' selected' : ''}>${l}</option>`).join('');
  $('coverage').textContent = MONTHS.length ? `${STMTS.length} statements · ${mName(MONTHS[0], true)} – ${mName(MONTHS[MONTHS.length - 1], true)} · ${TX.length} transactions` : 'No statements yet: upload some to begin.';
}
function periodMonths(p = PERIOD) {
  if (!p) return [];
  if (p === 'all') return MONTHS;
  if (p === 'last3') return MONTHS.slice(-3);
  if (p === 'ytd') { const y = MONTHS[MONTHS.length - 1].slice(0, 4); return MONTHS.filter(m => m.startsWith(y)); }
  return [p];
}
// operating-period transactions in these months (days before opening belong to the Startup tab)
const inMonths = ms => t => t.date >= OPEN_DATE && ms.includes(t.date.slice(0, 7));
function totals(ms) {
  const tx = TX.filter(inMonths(ms)), g = k => sum(tx.filter(t => t.group === k), t => t.book);
  const r = { revenue: g('revenue'), cogs: g('cogs'), labor: g('labor'), operating: g('operating'), tax: g('tax') };
  r.expenses = r.cogs + r.labor + r.operating; r.profit = r.revenue - r.expenses;
  const bank = tx.filter(t => t.kind === 'bank'), card = tx.filter(t => t.kind === 'card');
  r.bankIn = sum(bank.filter(t => t.amount > 0), t => t.amount); r.bankOut = -sum(bank.filter(t => t.amount < 0), t => t.amount);
  r.cardSpent = -sum(card.filter(t => t.amount < 0), t => t.amount);
  r.cardPaid = -sum(bank.filter(t => t.cat === 'Credit card payment'), t => t.amount);
  const own = tx.filter(t => t.group === 'owner' || t.cat === 'Owner money (assign)');
  r.ownerIn = sum(own.filter(t => t.amount > 0), t => t.amount); r.ownerOut = -sum(own.filter(t => t.amount < 0), t => t.amount);
  r.review = tx.filter(t => t.group === 'review');
  return r;
}
// latest statement balance on or before the end of the period
function balance(kind, ms) {
  const end = ms[ms.length - 1] + '-31';
  const s = STMTS.filter(s => s.kind === kind && s.end <= end).sort((a, b) => b.end.localeCompare(a.end))[0];
  return s ? { v: s.ending, on: s.end } : null;
}

// ---------- rendering ----------
function render() {
  const rv = TX.filter(t => t.group === 'review').length;
  $('reviewCount').hidden = !rv; $('reviewCount').textContent = rv;
  if (!PERIOD) { renderStatements(); return; }
  ({ overview: renderOverview, expenses: renderExpenses, txns: renderTxns, review: renderReview, startup: renderStartup, statements: renderStatements })[VIEW]();
}
function show(v) {
  VIEW = v;
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  document.querySelectorAll('.view').forEach(s => s.hidden = s.id !== 'v-' + v);
}
document.querySelectorAll('.tab').forEach(b => b.onclick = () => { show(b.dataset.v); render(); });
$('period').onchange = e => { PERIOD = e.target.value; CAT = null; render(); };

function renderOverview() {
  const ms = periodMonths(), r = totals(ms);
  // compare a single month with the month before
  let prev = null;
  if (ms.length === 1) { const i = MONTHS.indexOf(ms[0]); if (i > 0) prev = totals([MONTHS[i - 1]]); }
  const delta = (k, good = 1) => { if (!prev || !prev[k]) return ''; const d = (r[k] - prev[k]) / Math.abs(prev[k]); const up = d >= 0;
    return `<div class="d">${up ? '▲' : '▼'} ${pct(Math.abs(d))} vs ${mName(MONTHS[MONTHS.indexOf(ms[0]) - 1])}</div>`; };
  const prime = r.revenue ? (r.cogs + r.labor) / r.revenue : NaN;
  const tile = (l, v, extra = '', cls = '') => `<div class="kpi"><div class="l">${l}</div><div class="v ${cls}">${v}</div>${extra}</div>`;
  $('kpis').innerHTML =
    tile('Revenue', money(r.revenue), delta('revenue')) +
    tile('Expenses', money(r.expenses), delta('expenses')) +
    tile('Profit', money(r.profit), `<div class="d">${pct(r.revenue ? r.profit / r.revenue : NaN)} of revenue</div>`, r.profit < 0 ? 'neg' : '') +
    tile('Prime cost', pct(prime), '<div class="d">goods + labor ÷ revenue</div>') +
    tile('Needs review', r.review.length ? String(r.review.length) : '0', r.review.length ? `<div class="d">${money(sum(r.review, t => Math.abs(t.amount)))} not yet counted</div>` : '<div class="d">all sorted</div>', r.review.length ? 'neg' : '');

  const bb = balance('bank', ms), cb = balance('card', ms);
  const row = (l, v, note = '') => `<tr><td>${l}${note ? `<div class="desc">${note}</div>` : ''}</td><td class="n">${v}</td></tr>`;
  $('cashTable').innerHTML =
    `<tr><th>Bank (checking)</th><th class="n">${ms.length === 1 ? mName(ms[0]) : 'Period'}</th></tr>` +
    row('Money in', money(r.bankIn)) + row('Money out', money(r.bankOut)) +
    (bb ? row('Balance', money(bb.v), 'on ' + dName(bb.on)) : '') +
    `<tr><th>Credit card</th><th></th></tr>` +
    row('Spent on the card', money(r.cardSpent)) + row('Paid off from the bank', money(r.cardPaid)) +
    (r.cardPaid > r.cardSpent ? row('Of that, toward the older balance', money(r.cardPaid - r.cardSpent), 'paying down the construction-era card balance, not a new expense') : '') +
    (cb ? row('Still owed', money(cb.v), 'statement balance on ' + dName(cb.on)) : '') +
    `<tr><th>Other</th><th></th></tr>` +
    row('Taxes paid', money(r.tax), 'sales tax and other tax payments') +
    row('Owner money put in', money(r.ownerIn), 'loans or investment from you; not revenue') +
    row('Owner money taken out', money(r.ownerOut), 'loan repayments or draws; not an expense');

  monthChart();
  cardDebt();
  ownerMoney();
  cashBridge();
  const all = MONTHS.map(m => [m, totals([m])]), sel = new Set(ms);
  const cell = v => `<td class="n${v < 0 ? ' neg' : ''}">${money(v)}</td>`;
  $('plTable').innerHTML = `<tr><th>Month</th><th class="n">Revenue</th><th class="n">Cost of goods</th><th class="n">Labor</th><th class="n">Operating</th><th class="n">Profit</th><th class="n">Margin</th><th class="n">Taxes</th></tr>` +
    all.map(([m, t]) => `<tr class="click${sel.has(m) ? ' sel' : ''}" data-m="${m}"><td>${mName(m, true)}</td>${cell(t.revenue)}${cell(t.cogs)}${cell(t.labor)}${cell(t.operating)}${cell(t.profit)}<td class="n">${pct(t.revenue ? t.profit / t.revenue : NaN)}</td>${cell(t.tax)}</tr>`).join('') +
    (() => { const t = totals(MONTHS); return `<tr><td><b>All months</b></td>${[t.revenue, t.cogs, t.labor, t.operating, t.profit].map(v => `<td class="n"><b>${money(v)}</b></td>`).join('')}<td class="n"><b>${pct(t.revenue ? t.profit / t.revenue : NaN)}</b></td><td class="n"><b>${money(t.tax)}</b></td></tr>`; })();
  $('plTable').querySelectorAll('tr[data-m]').forEach(tr => tr.onclick = () => pick(tr.dataset.m));
}
function pick(m) { PERIOD = m; $('period').value = m; render(); }

// Why profit isn't the bank balance: everything that moved the bank, from the day the account
// opened to the latest bank statement, grouped so the steps add up to the statement's balance
function cashBridge() {
  const bankSt = STMTS.filter(s => s.kind === 'bank').sort((a, b) => a.end.localeCompare(b.end)), last = bankSt[bankSt.length - 1];
  if (!last) { $('bridgeTable').innerHTML = ''; return; }
  const tx = TX.filter(t => t.date <= last.end), s = f => sum(tx.filter(f), t => t.amount);
  const startBal = bankSt[0].opening || 0;
  const op = t => t.date >= OPEN_DATE;
  const profit = s(t => op(t) && ['revenue', 'cogs', 'labor', 'operating'].includes(t.group));
  const partners = s(t => t.group === 'owner');
  const startup = s(t => Math.abs(t.startup) > 0.004);
  const tax = s(t => op(t) && t.group === 'tax');
  const review = s(t => t.group === 'review');
  const transfer = s(t => t.group === 'transfer');
  const card = s(t => t.kind === 'card');
  const all = s(() => true), other = all - profit - partners - startup - tax - review - transfer;
  const bank = startBal + all - card;                       // the card's own entries never touch the bank
  const rows = [
    ['Profit since opening', profit, 'sales minus expenses'],
    ["Partners' money", partners, 'investments and loans in, less anything paid back or drawn'],
    ['Startup costs', startup, 'building the café, before opening'],
    ['Taxes paid', tax, 'sales tax and other taxes: never part of profit'],
    ['Not yet labelled', review, 'checks and cash withdrawals: label them in Needs review'],
    ['Card bill not yet paid', -card + transfer, 'expenses already counted, cash still in the bank until you pay the card'],
    ...(Math.abs(other) > 0.5 ? [['Other', other, 'income or refunds before opening, personal items']] : []),
    ...(startBal ? [['Starting balance', startBal, '']] : []),
  ];
  $('bridgeTable').innerHTML = rows.map(([l, v, n]) => `<tr><td>${l}<div class="desc">${n}</div></td><td class="n${v < 0 ? ' neg' : ''}">${v >= 0 ? '+' : ''}${money(v, 2)}</td></tr>`).join('') +
    `<tr><td><b>Bank balance on ${dName(last.end)}, ${last.end.slice(0, 4)}</b></td><td class="n"><b>${money(bank, 2)}</b>${Math.abs(bank - last.ending) < 0.01 ? ' <span class="ok">✓ matches the statement</span>' : ` <span class="bad">statement says ${money(last.ending, 2)}</span>`}</td></tr>`;
}

// Loans partners made to the business: what is still owed to each (Overview panel)
function ownerMoney() {
  const loans = TX.filter(t => t.group === 'owner' && isLoan(t.cat)).sort((a, b) => a.date.localeCompare(b.date));
  const open = TX.filter(t => t.cat === 'Owner money (assign)');
  const by = {};
  for (const t of loans) { const p = partnerOf(t.cat) || 'Unnamed partner'; by[p] = by[p] || { lent: 0, repaid: 0 }; if (t.amount > 0) by[p].lent += t.amount; else by[p].repaid -= t.amount; }
  const owed = Object.entries(by).filter(([, v]) => Math.abs(v.lent - v.repaid) > 0.004);
  $('ownerSummary').innerHTML = (owed.length ? 'The business still owes ' + owed.map(([p, v]) => `<b>${esc(p)} ${money(v.lent - v.repaid, 2)}</b> (lent ${money(v.lent, 2)}, paid back ${money(v.repaid, 2)})`).join('; ') + '.'
    : 'The business owes no partner loans right now.') +
    ' What each partner invested is on the Startup &amp; partners tab.' +
    (open.length ? ` <span class="bad">${open.length} transfer${open.length > 1 ? 's' : ''} with a partner's account still need${open.length > 1 ? '' : 's'} a label</span> in Needs review.` : '');
  $('ownerTable').innerHTML = loans.length ? `<tr><th>Date</th><th>Partner</th><th class="n">Lent</th><th class="n">Paid back</th></tr>` +
    loans.map(t => `<tr><td>${dName(t.date)}, ${t.date.slice(0, 4)}</td><td>${esc(partnerOf(t.cat) || '–')}</td><td class="n">${t.amount > 0 ? money(t.amount, 2) : ''}</td><td class="n">${t.amount < 0 ? money(-t.amount, 2) : ''}</td></tr>`).join('') : '<tr><td class="note">No partner loans.</td></tr>';
}

// The card carried build-out spending into the opening. Paying the card is never an expense
// (that would count purchases twice, or count startup costs as monthly costs), so this panel
// shows the debt itself: balance per statement, new spending, payments, and the equipment plan.
function cardDebt() {
  const st = STMTS.filter(s => s.kind === 'card').sort((a, b) => a.start.localeCompare(b.start));
  if (!st.length) { $('debtSummary').textContent = 'Upload credit card statements to see the card balance.'; $('debtTable').innerHTML = ''; return; }
  const last = st[st.length - 1];
  const atOpen = st.find(s => s.end >= OPEN_DATE) || st[0];        // first statement closing after opening
  const since = st.filter(s => s.start > atOpen.end);
  const spent = s => sum(s.txns.filter(t => t.amount < 0), t => -t.amount);
  const paid = s => sum(s.txns.filter(t => t.section === 'card-payment'), t => t.amount);
  const firstPlan = st.find(s => s.plan), planNow = last.plan ? last.plan.remaining : 0;
  const paidOff = st.find(s => s.plan && s.plan.remaining === 0);
  const interest = sum(st, s => s.interest || 0);
  const open = atOpen.ending, close = last.ending;
  $('debtSummary').innerHTML = `Around opening (${dName(atOpen.end)}, ${atOpen.end.slice(0, 4)}) the card owed <b>${money(open, 2)}</b>, mostly build-out purchases. On ${dName(last.end)}, ${last.end.slice(0, 4)} it owed <b>${money(close, 2)}</b>: ` +
    (open > close ? `<span class="ok">${money(open - close, 2)} paid down</span>.` : `<span class="bad">${money(close - open, 2)} higher</span>.`) +
    (since.length ? ` Since then you paid ${money(sum(since, paid), 2)} to the card and spent ${money(sum(since, spent), 2)} on it; that spending is already in Expenses.` : '') +
    (firstPlan ? ` The ${money(firstPlan.plan.original, 2)} equipment plan (Pay Over Time)` +
      (paidOff ? ` was <span class="ok">paid off by ${dName(paidOff.end)}, ${paidOff.end.slice(0, 4)}</span>.` : ` has ${money(planNow, 2)} left.`) : '') +
    (interest > 0 ? ` Interest charged so far: <span class="bad">${money(interest, 2)}</span>.` : '');
  $('debtTable').innerHTML = `<tr><th>Statement</th><th class="n">New spending</th><th class="n">Paid</th><th class="n">Interest</th><th class="n">Equipment plan left</th><th class="n">Balance owed</th></tr>` +
    st.map(s => `<tr${s === atOpen ? ' class="sel"' : ''}><td>${dName(s.start)} – ${dName(s.end)}, ${s.end.slice(0, 4)}</td><td class="n">${money(spent(s), 2)}</td><td class="n">${money(paid(s), 2)}</td><td class="n">${s.interest ? money(s.interest, 2) : '–'}</td><td class="n">${s.plan ? money(s.plan.remaining, 2) : '–'}</td><td class="n"><b>${money(s.ending, 2)}</b></td></tr>`).join('');
}

// grouped bars: revenue and expenses per month, one $ axis
function monthChart() {
  const data = MONTHS.map(m => ({ m, ...totals([m]) })), sel = new Set(periodMonths());
  const W = 640, H = 230, L = 46, B = 24, T = 8, plotW = W - L - 6, plotH = H - B - T;
  const max = Math.max(1, ...data.map(d => Math.max(d.revenue, d.expenses)));
  const step = [1000, 2000, 5000, 10000, 20000, 50000].find(s => max / s <= 5) || 100000;
  const top = Math.ceil(max / step) * step, y = v => T + plotH - (v / top) * plotH;
  const slot = plotW / data.length, bw = Math.max(4, Math.min(22, (slot - 10) / 2));
  const bar = (x, v, c) => { const h = Math.max(0, y(0) - y(v)), r = Math.min(4, h, bw / 2), yt = y(v);
    return h <= 0 ? '' : `<path d="M${x},${y(0)}V${yt + r}Q${x},${yt} ${x + r},${yt}H${x + bw - r}Q${x + bw},${yt} ${x + bw},${yt + r}V${y(0)}Z" fill="var(${c})"/>`; };
  let g = '';
  for (let v = 0; v <= top; v += step) g += `<line x1="${L}" x2="${W - 6}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v ? '$' + v / 1000 + 'k' : '$0'}</text>`;
  data.forEach((d, i) => {
    const x0 = L + i * slot + (slot - (bw * 2 + 2)) / 2;
    if (sel.has(d.m)) g += `<rect x="${L + i * slot + 1}" y="${T}" width="${slot - 2}" height="${plotH}" fill="var(--accent-soft)" rx="4"/>`;
    g += bar(x0, d.revenue, '--series-1') + bar(x0 + bw + 2, d.expenses, '--series-2');
    g += `<text x="${L + i * slot + slot / 2}" y="${H - 6}" text-anchor="middle">${new Date(d.m + '-15T12:00:00').toLocaleDateString(undefined, { month: 'short' })}</text>`;
    g += `<rect class="hit" data-i="${i}" x="${L + i * slot}" y="${T}" width="${slot}" height="${plotH + B}" fill="transparent" style="cursor:pointer"/>`;
  });
  const el = $('monthChart');
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Revenue and expenses by month">${g}<line x1="${L}" x2="${W - 6}" y1="${y(0)}" y2="${y(0)}" stroke="var(--muted)"/></svg><div class="tip" hidden></div>`;
  const tip = el.querySelector('.tip'), svg = el.querySelector('svg');
  el.querySelectorAll('.hit').forEach(h => {
    const d = data[+h.dataset.i];
    h.onmouseenter = () => {
      const k = svg.getBoundingClientRect().width / W;
      tip.innerHTML = `<b>${mName(d.m, true)}</b><br>Revenue ${money(d.revenue)}<br>Expenses ${money(d.expenses)}<br>Profit ${money(d.profit)}`;
      tip.style.left = (L + (+h.dataset.i + 0.5) * slot) * k + 'px'; tip.style.top = (y(Math.max(d.revenue, d.expenses)) * k - 6) + 'px'; tip.hidden = false;
    };
    h.onmouseleave = () => tip.hidden = true;
    h.onclick = () => pick(d.m);
  });
}

function renderExpenses() {
  const ms = periodMonths(), tx = TX.filter(inMonths(ms));
  $('expTitle').textContent = 'Expenses · ' + (ms.length === 1 ? mName(ms[0], true) : $('period').selectedOptions[0].text);
  const by = {};
  for (const t of tx) if (['cogs', 'labor', 'operating', 'tax'].includes(t.group)) by[t.cat] = (by[t.cat] || 0) + t.book;
  const max = Math.max(1, ...Object.values(by));
  let h = '';
  for (const g of ['cogs', 'labor', 'operating', 'tax']) {
    const cats = Object.entries(by).filter(([c]) => GROUP_OF[c] === g).sort((a, b) => b[1] - a[1]);
    if (!cats.length) continue;
    h += `<div class="grp">${GROUPS[g]} · ${money(sum(cats, c => c[1]))}</div>` + cats.map(([c, v]) =>
      `<div class="hbar${c === CAT ? ' sel' : ''}" data-c="${esc(c)}" role="button" tabindex="0"><span>${esc(c)}</span><div class="track"><div class="fill" style="width:${Math.max(0.5, v / max * 100)}%"></div></div><span class="amt">${money(v)}</span></div>`).join('');
  }
  $('catBars').innerHTML = h || '<p class="note">No expenses in this period.</p>';
  $('catBars').querySelectorAll('.hbar').forEach(b => b.onclick = b.onkeydown = e => { if (e.type === 'keydown' && e.key !== 'Enter') return; CAT = b.dataset.c; renderExpenses(); });
  if (!CAT || !by[CAT]) { $('catDetail').innerHTML = '<p class="note">Pick a category to see its suppliers and transactions.</p>'; return; }
  const list = tx.filter(t => t.cat === CAT), pay = {};
  for (const t of list) { pay[t.payee] = pay[t.payee] || [0, 0]; pay[t.payee][0]++; pay[t.payee][1] += t.book; }
  $('catDetail').innerHTML = `<h2>${esc(CAT)} · ${money(by[CAT], 2)}</h2>
    <div class="scroll"><table><tr><th>Supplier / payee</th><th class="n">#</th><th class="n">Amount</th></tr>${Object.entries(pay).sort((a, b) => b[1][1] - a[1][1]).map(([p, [n, v]]) => `<tr><td>${esc(p)}</td><td class="n">${n}</td><td class="n">${money(v, 2)}</td></tr>`).join('')}</table></div>
    <h2>Transactions</h2><div class="scroll"><table id="catTx"></table></div>`;
  txRows($('catTx'), list);
}

function catSelect(t) {
  return `<select class="cat" data-id="${esc(t.id)}" aria-label="Category">${Object.entries(GROUPS).map(([g, gl]) =>
    `<optgroup label="${gl}">${CATEGORIES.filter(c => c.group === g).map(c => `<option${c.name === t.cat ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</optgroup>`).join('')}</select>`;
}
const acctLabel = t => t.kind === 'card' ? 'Card' : 'Bank';
function txRows(table, list, opts = {}) {
  const shown = list.slice(0, opts.limit || 500);
  table.innerHTML = `<tr><th>Date</th><th>Account</th><th>Payee</th><th class="n">Amount</th><th>Category</th>${opts.rule ? '<th>All from payee</th>' : ''}</tr>` +
    shown.map(t => `<tr><td>${dName(t.date)}</td><td>${acctLabel(t)}</td><td>${esc(t.payee)}<div class="desc">${esc(t.desc.length > 120 ? t.desc.slice(0, 120) + '…' : t.desc)}</div></td><td class="n${t.amount > 0 ? ' ok' : ''}">${t.amount > 0 ? '+' : ''}${money(t.amount, 2)}</td><td>${catSelect(t)}</td>${opts.rule ? `<td><input type="checkbox" data-rule="${esc(t.id)}" aria-label="Use for all from ${esc(t.payee)}"${/^Check #|ATM cash/.test(t.payee) ? ' disabled' : ''}></td>` : ''}</tr>`).join('') +
    (list.length > shown.length ? `<tr><td colspan="6" class="note">Showing ${shown.length} of ${list.length}. Narrow the search to see more.</td></tr>` : '');
  table.querySelectorAll('select.cat').forEach(s => s.onchange = () => {
    const t = TX.find(x => x.id === s.dataset.id), rule = table.querySelector(`input[data-rule="${CSS.escape(t.id)}"]`);
    setCategory(t, s.value, rule && rule.checked);
  });
}
async function setCategory(t, cat, allPayee) {
  if (RO) return;
  if (allPayee) { PREFS.payee[t.payee] = cat; for (const x of TX) if (x.payee === t.payee) delete PREFS.tx[x.id]; }
  else PREFS.tx[t.id] = cat;
  rebuild(); render();
  const others = TX.filter(x => x.payee === t.payee && x.id !== t.id && x.cat !== cat).length;
  toast(allPayee ? `All from ${t.payee} are now ${cat}.` : `Saved as ${cat}.`,
    !allPayee && others && !/^Check #|ATM cash/.test(t.payee) ? [`Use for all ${others + 1} from ${t.payee}`, () => setCategory(t, cat, true)] : null);
  try { await store.savePrefs(PREFS); } catch (e) { toast('Could not save (' + (e.code || e.message) + ').'); }
}
let toastT;
function toast(msg, action) {
  let el = $('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.setAttribute('role', 'status');
    el.style.cssText = 'position:fixed;left:50%;bottom:20px;transform:translateX(-50%);background:var(--fg);color:var(--bg);padding:10px 14px;border-radius:8px;display:flex;gap:12px;align-items:center;z-index:9;max-width:92vw;font-size:.9rem';
    document.body.appendChild(el); }
  el.innerHTML = esc(msg); el.hidden = false;
  if (action) { const b = document.createElement('button'); b.textContent = action[0]; b.onclick = () => { el.hidden = true; action[1](); }; el.appendChild(b); }
  clearTimeout(toastT); toastT = setTimeout(() => el.hidden = true, action ? 9000 : 3500);
}

function renderTxns() {
  const ms = periodMonths();
  if (!$('fAcct').options.length) {
    $('fAcct').innerHTML = '<option value="">All accounts</option><option value="bank">Bank</option><option value="card">Card</option>';
    $('fCat').innerHTML = '<option value="">All categories</option>' + CATEGORIES.map(c => `<option>${esc(c.name)}</option>`).join('');
    ['q', 'fAcct', 'fCat'].forEach(id => $(id).oninput = renderTxns);
  }
  const q = $('q').value.trim().toLowerCase(), a = $('fAcct').value, c = $('fCat').value;
  const list = TX.filter(inMonths(ms)).filter(t => (!a || t.kind === a) && (!c || t.cat === c) && (!q || (t.payee + ' ' + t.desc).toLowerCase().includes(q)));
  $('txCount').textContent = `${list.length} transactions · in ${money(sum(list.filter(t => t.amount > 0), t => t.amount))} · out ${money(-sum(list.filter(t => t.amount < 0), t => t.amount))}`;
  txRows($('txTable'), list);
}
function renderReview() {
  const list = TX.filter(t => t.group === 'review');
  if (!list.length) { $('reviewTable').innerHTML = '<tr><td class="note">Nothing to review. Everything has a category.</td></tr>'; return; }
  txRows($('reviewTable'), list, { rule: true });
}

// ---------- startup & partners ----------
// Startup costs come from the statements (everything spent before opening, plus startup
// categories later). What partners paid out of their own pockets is not in any statement,
// so it comes from the partners' workbook, imported once and re-imported when it changes.
function partnerTotals() {
  const P = {}, row = p => P[p] = P[p] || { bank: 0, bankBefore: 0, bankAfter: 0, personal: 0, lent: 0, repaid: 0, draws: 0, wbDeposits: 0 };
  PARTNERS.forEach(row);
  for (const t of TX.filter(t => t.group === 'owner')) {
    const p = partnerOf(t.cat) || 'Unnamed partner'; row(p);
    if (/investment$/.test(t.cat)) { P[p].bank += t.amount; if (t.date < OPEN_DATE) P[p].bankBefore += t.amount; else P[p].bankAfter += t.amount; }
    else if (isLoan(t.cat)) { if (t.amount > 0) P[p].lent += t.amount; else P[p].repaid -= t.amount; }
    else if (/draw$/.test(t.cat)) P[p].draws -= t.amount;
  }
  for (const r of (LEDGER && LEDGER.rows) || []) {
    if (!r.partner) continue; row(r.partner);
    if (r.kind === 'paid') P[r.partner].personal += r.amount;
    if (r.kind === 'deposit') P[r.partner].wbDeposits += r.amount;
  }
  return P;
}
function renderStartup() {
  const pre = TX.filter(t => Math.abs(t.startup) > 0.004);
  const total = sum(pre, t => t.startup), deposit = sum(pre.filter(t => t.cat === 'Lease security deposit'), t => t.startup);
  const rows = (LEDGER && LEDGER.rows) || [];
  const personal = sum(rows.filter(r => r.kind === 'paid'), r => r.amount), cash = sum(rows.filter(r => r.kind === 'cash'), r => r.amount);
  const P = partnerTotals(), bankIn = sum(Object.values(P), v => v.bank);
  const review = TX.filter(t => t.date < OPEN_DATE && t.group === 'review');
  const tile = (l, v, d) => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}</div><div class="d">${d}</div></div>`;
  $('suKpis').innerHTML =
    tile('Cost to open', money(total + personal + cash), `opened ${dName(OPEN_DATE)}, ${OPEN_DATE.slice(0, 4)}`) +
    tile("Paid from the café's account & card", money(total), 'before opening' + (deposit ? `; includes ${money(deposit)} lease deposit` : '')) +
    tile('Paid by partners personally', LEDGER ? money(personal + cash) : '–', LEDGER ? 'from the workbook' : 'import the workbook below') +
    tile('Partners put in (bank)', money(bankIn), 'deposits, wires and transfers') +
    (review.length ? tile('Still to label', String(review.length), `${money(sum(review, t => Math.abs(t.amount)))} before opening, in Needs review`) : '');

  // startup costs by category
  const by = {};
  for (const t of pre) by[t.cat] = (by[t.cat] || 0) + t.startup;
  const cats = Object.entries(by).filter(([, v]) => Math.abs(v) > 0.004).sort((a, b) => b[1] - a[1]), max = Math.max(1, ...cats.map(c => c[1]));
  $('suBars').innerHTML = cats.length ? cats.map(([c, v]) =>
    `<div class="hbar${c === SCAT ? ' sel' : ''}" data-c="${esc(c)}" role="button" tabindex="0"><span>${esc(c)}</span><div class="track"><div class="fill" style="width:${Math.max(0.5, v / max * 100)}%"></div></div><span class="amt">${money(v)}</span></div>`).join('')
    : '<p class="note">No startup spending in the statements yet.</p>';
  $('suBars').querySelectorAll('.hbar').forEach(b => b.onclick = b.onkeydown = e => { if (e.type === 'keydown' && e.key !== 'Enter') return; SCAT = b.dataset.c; renderStartup(); });
  if (SCAT && by[SCAT]) { $('suDetail').hidden = false; $('suDetailTitle').textContent = `${SCAT} · ${money(by[SCAT], 2)}`; txRows($('suTx'), pre.filter(t => t.cat === SCAT)); }
  else $('suDetail').hidden = true;

  // partners: with the workbook, its deposits + personal payments (the partners' own record) plus
  // money added after opening from the bank; without it, only what the bank shows
  const names = Object.keys(P), commit = (LEDGER && LEDGER.commit) || {};
  const net = v => LEDGER ? v.wbDeposits + v.personal + v.bankAfter + (v.lent - v.repaid) - v.draws : v.bank + (v.lent - v.repaid) - v.draws;
  const c2 = v => `<td class="n">${money(v, 2)}</td>`, tot = k => sum(names, p => P[p][k]);
  const diff = p => commit[p] ? net(P[p]) - (P[p].lent - P[p].repaid) - commit[p] : null;   // loans don't count toward the commitment
  $('partnerTable').innerHTML = LEDGER
    ? `<tr><th>Partner</th><th class="n">Committed</th><th class="n">Deposited (workbook)</th><th class="n">Paid personally (workbook)</th><th class="n">Added since opening (bank)</th><th class="n">Loan still owed</th><th class="n">Total put in</th><th class="n">vs commitment</th></tr>` +
      names.map(p => { const v = P[p], d = diff(p); return `<tr><td>${esc(p)}</td><td class="n">${commit[p] ? money(commit[p]) : '–'}</td>${c2(v.wbDeposits)}${c2(v.personal)}${c2(v.bankAfter)}${c2(v.lent - v.repaid)}<td class="n"><b>${money(net(v), 2)}</b></td><td class="n">${d == null ? '–' : `<span class="${d >= 0 ? 'ok' : 'bad'}">${d >= 0 ? money(d, 2) + ' over' : money(-d, 2) + ' short'}</span>`}</td></tr>`; }).join('') +
      `<tr><td><b>All partners</b></td><td class="n"><b>${money(sum(names, p => commit[p] || 0))}</b></td>${['wbDeposits', 'personal', 'bankAfter'].map(k => `<td class="n"><b>${money(tot(k), 2)}</b></td>`).join('')}<td class="n"><b>${money(sum(names, p => P[p].lent - P[p].repaid), 2)}</b></td><td class="n"><b>${money(sum(names, p => net(P[p])), 2)}</b></td><td></td></tr>`
    : `<tr><th>Partner</th><th class="n">Into the bank</th><th class="n">Loan still owed</th><th class="n">Total put in</th></tr>` +
      names.map(p => { const v = P[p]; return `<tr><td>${esc(p)}</td>${c2(v.bank)}${c2(v.lent - v.repaid)}<td class="n"><b>${money(net(v), 2)}</b></td></tr>`; }).join('');
  // the workbook's deposits vs what reached the bank before opening, so differences are easy to spot
  $('partnerCheck').innerHTML = LEDGER ? 'Check, deposits before opening, workbook vs bank: ' + names.filter(p => P[p].wbDeposits || P[p].bankBefore).map(p => {
    const d = P[p].wbDeposits - P[p].bankBefore; return `${esc(p)} ${money(P[p].wbDeposits)} vs ${money(P[p].bankBefore)}${Math.abs(d) > 0.5 ? ` <span class="bad">(${money(Math.abs(d))} ${d > 0 ? 'not seen in the bank' : 'more in the bank'})</span>` : ' <span class="ok">✓</span>'}`; }).join(' · ') +
    '. A deposit "not seen in the bank" may have gone straight to a contractor or be recorded under another name.' : 'Import the workbook to add commitments and what each partner paid personally.';

  // workbook rows, per partner
  $('ledgerMsg').textContent = LEDGER ? `Imported ${LEDGER.file}: ${rows.length} rows on ${dName(LEDGER.importedAt.slice(0, 10))}, ${LEDGER.importedAt.slice(0, 4)}.` : 'Not imported yet.';
  const groups = [...PARTNERS.map(p => [p, rows.filter(r => r.partner === p && r.kind === 'paid')]), ['Café cash', rows.filter(r => r.kind === 'cash')]].filter(([, l]) => l.length);
  $('ledgerDetail').innerHTML = groups.map(([p, l]) => `<details><summary>${esc(p)}: ${l.length} payments, ${money(sum(l, r => r.amount), 2)}</summary><div class="scroll"><table><tr><th>Date</th><th>What</th><th class="n">Amount</th><th>Note</th></tr>${
    l.map(r => `<tr><td>${r.date ? dName(r.date) + ', ' + r.date.slice(0, 4) : '–'}</td><td>${esc(r.purpose)}</td><td class="n">${money(r.amount, 2)}</td><td class="desc">${esc(r.comments)}</td></tr>`).join('')}</table></div></details>`).join('');
}

let XLSX = null;
async function getXlsx() {
  if (!XLSX) {
    await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'; s.onload = res; s.onerror = () => rej(new Error('Could not load the spreadsheet reader')); document.head.appendChild(s); });
    XLSX = window.XLSX;
  }
  return XLSX;
}
const isoLocal = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
// First sheet, header row with Name / Purpose / (Date) / Amount / Deposits / Not paid / Comments.
// Partner rows: Amount = paid personally, Deposits = money put into the bank. "… Cash" rows were paid
// from the café's cash. Business rows (e.g. Musche LLC) are skipped: those are in the statements.
// Names are trimmed, so "Scherize Hamirani " with a trailing space still counts as Scherize.
// If the sheet has the Partners / Deposits+payments / "Amount to Deposit More" summary, each
// partner's commitment is read from it (total + amount still to deposit).
function parseLedger(X, wb) {
  const grid = X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, blankrows: false });
  const hi = grid.findIndex(r => r.some(v => /^name$/i.test(String(v ?? '').trim())) && r.some(v => /^amount$/i.test(String(v ?? '').trim())));
  if (hi < 0) throw new Error('The first sheet needs a header row with "Name" and "Amount".');
  const H = grid[hi].map(v => String(v ?? '').trim().toLowerCase()), col = n => H.findIndex(h => h.startsWith(n));
  const c = { name: col('name'), purpose: col('purpose'), date: col('date'), amount: col('amount'), deposit: H.findIndex(h => h === 'deposits' || h === 'deposit'), comments: col('comment'),
    partners: col('partners'), total: col('deposits+payments'), more: col('amount to deposit') };
  const commit = {};
  if (c.partners >= 0 && c.total >= 0 && c.more >= 0) for (const r of grid.slice(hi + 1)) {
    const p = PARTNERS.find(p => p.toLowerCase() === String(r[c.partners] ?? '').trim().split(/\s+/)[0].toLowerCase());
    const t = Number(r[c.total]), m = Number(r[c.more]);
    if (p && isFinite(t) && isFinite(m)) commit[p] = Math.round((t + m) * 100) / 100;
  }
  const rows = [];
  for (const r of grid.slice(hi + 1)) {
    const name = String(r[c.name] ?? '').trim(); if (!name) continue;
    const partner = PARTNERS.find(p => p.toLowerCase() === name.split(/\s+/)[0].toLowerCase()) || '';
    const cash = !partner && /cash/i.test(name);
    const d = c.date >= 0 ? r[c.date] : null;
    const base = { name, partner, purpose: String(r[c.purpose] ?? '').trim(), date: d instanceof Date ? isoLocal(d) : '', comments: c.comments >= 0 ? String(r[c.comments] ?? '').trim() : '' };
    const amt = Number(r[c.amount]), dep = c.deposit >= 0 ? Number(r[c.deposit]) : NaN;
    if (amt && isFinite(amt) && (partner || cash)) rows.push({ ...base, amount: amt, kind: partner ? 'paid' : 'cash' });
    if (dep && isFinite(dep) && partner) rows.push({ ...base, amount: dep, kind: 'deposit' });
  }
  return { rows, commit };
}
$('ledgerFile').onchange = async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f || RO) return;
  $('ledgerMsg').textContent = `Reading ${f.name}…`;
  try {
    const X = await getXlsx(), { rows, commit } = parseLedger(X, X.read(await f.arrayBuffer(), { type: 'array', cellDates: true }));
    if (!rows.length) throw new Error('No partner rows found. Names should start with ' + PARTNERS.join(', ') + '.');
    LEDGER = { file: f.name, importedAt: new Date().toISOString(), rows, commit };
    await store.saveLedger(LEDGER);
    renderStartup();
  } catch (err) { $('ledgerMsg').textContent = 'Not imported: ' + (err.code || err.message); }
};

// ---------- statements: upload + list ----------
let pdfjs = null;
async function getPdfjs() {
  if (!pdfjs) {
    pdfjs = await import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs';
  }
  return pdfjs;
}
async function upload(files) {
  if (RO) return;
  const log = $('uploadLog');
  for (const f of files) {
    const li = document.createElement('p'); li.className = 'note'; li.textContent = `Reading ${f.name}…`; log.prepend(li);
    try {
      const s = parseStatement(await pdfLines(await getPdfjs(), new Uint8Array(await f.arrayBuffer())));
      const bad = s.checks.filter(c => !c.ok);
      const label = `${s.account.name}, ${dName(s.start)} – ${dName(s.end)}, ${s.txns.length} transactions`;
      if (bad.length) { li.innerHTML = `<span class="bad">✗ Not saved.</span> ${esc(f.name)}: ${esc(label)}. These totals don't match the statement: ${bad.map(b => `${esc(b.what)} (read ${money(b.parsed, 2)}, statement says ${money(b.statement, 2)})`).join('; ')}.`; continue; }
      const rec = { key: `${s.account.id}_${s.start}`, file: f.name, kind: s.kind, account: s.account, start: s.start, end: s.end,
        opening: s.opening ?? null, ending: s.ending ?? null, interest: s.interest ?? null, plan: s.plan ?? null,
        checks: s.checks, txns: s.txns, uploadedAt: new Date().toISOString() };
      await store.saveStatement(rec);
      const i = STMTS.findIndex(x => x.key === rec.key); if (i >= 0) STMTS[i] = rec; else STMTS.push(rec);
      li.innerHTML = `<span class="ok">✓ Saved.</span> ${esc(label)}. All totals match the statement.`;
    } catch (e) { li.innerHTML = `<span class="bad">✗ ${esc(f.name)}:</span> ${esc(e.code || e.message)}`; }
  }
  rebuild(); render();
}
$('files').onchange = e => { upload([...e.target.files]); e.target.value = ''; };
const drop = $('drop');
drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); upload([...e.dataTransfer.files].filter(f => /\.pdf$/i.test(f.name))); };

function renderStatements() {
  const list = [...STMTS].sort((a, b) => b.start.localeCompare(a.start) || a.kind.localeCompare(b.kind));
  $('stmtTable').innerHTML = list.length ? `<tr><th>Account</th><th>Period</th><th class="n">Transactions</th><th>Totals</th><th>File</th><th></th></tr>` +
    list.map(s => `<tr><td>${esc(s.account.name)}</td><td>${dName(s.start)} – ${dName(s.end)}, ${s.end.slice(0, 4)}</td><td class="n">${s.txns.length}</td><td class="ok">✓ match</td><td class="desc">${esc(s.file)}</td><td><button data-rm="${esc(s.key)}">Remove</button></td></tr>`).join('')
    : '<tr><td class="note">No statements saved yet.</td></tr>';
  $('stmtTable').querySelectorAll('[data-rm]').forEach(b => b.onclick = async () => {
    if (RO) return;
    const s = STMTS.find(x => x.key === b.dataset.rm);
    if (!confirm(`Remove the ${s.account.name} statement for ${dName(s.start)} – ${dName(s.end)}? Its transactions leave the dashboard. You can upload it again later.`)) return;
    await store.removeStatement(s.key); STMTS = STMTS.filter(x => x.key !== s.key); rebuild(); render();
  });
}

start();
