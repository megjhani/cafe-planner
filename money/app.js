// Tipsy Village Money: owner dashboard built from uploaded Chase statements.
// Data: fin_statements/<account>_<start> (one per statement, with its transactions)
//       fin/prefs { payee: {payee: category}, tx: {txId: category} } (your corrections)
// Both are owner-only in the database rules. Open with ?local to keep everything in this
// browser instead (testing / offline); nothing is sent anywhere in that mode.
import { pdfLines, parseStatement } from './parser.js';
import { CATEGORIES, GROUPS, GROUP_OF, categorize, bookAmount } from './rules.js';
import * as A from '../access.js';

const $ = id => document.getElementById(id);
const esc = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const money = (v, dp = 0) => (v < -0.004 ? '−' : '') + '$' + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
const pct = v => isFinite(v) ? (v * 100).toFixed(1) + '%' : '–';
const mName = (m, long) => new Date(m + '-15T12:00:00').toLocaleDateString(undefined, { month: long ? 'long' : 'short', year: 'numeric' });
const dName = d => new Date(d + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const sum = (a, f) => a.reduce((p, t) => p + f(t), 0);

let RO = false; // view-only owner
let store = null, STMTS = [], PREFS = { payee: {}, tx: {} }, TX = [], MONTHS = [], PERIOD = null, VIEW = 'overview', CAT = null;

// ---------- storage ----------
const localStore = {
  async statements() { try { return JSON.parse(localStorage.getItem('fin-statements')) || []; } catch { return []; } },
  async saveStatement(s) { const a = await this.statements(), i = a.findIndex(x => x.key === s.key); if (i >= 0) a[i] = s; else a.push(s); localStorage.setItem('fin-statements', JSON.stringify(a)); },
  async removeStatement(k) { localStorage.setItem('fin-statements', JSON.stringify((await this.statements()).filter(x => x.key !== k))); },
  async prefs() { try { return JSON.parse(localStorage.getItem('fin-prefs')) || {}; } catch { return {}; } },
  async savePrefs(p) { localStorage.setItem('fin-prefs', JSON.stringify(p)); },
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
  const [st, pr] = await Promise.all([store.statements(), store.prefs()]);
  STMTS = st; PREFS = { payee: pr.payee || {}, tx: pr.tx || {} };
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
  for (const t of TX) { t.cat = categorize(t, PREFS); t.group = GROUP_OF[t.cat] || 'review'; t.book = bookAmount(t, t.cat); }
  // months the bank statements cover (the card's first statement starts a few days early)
  const cov = new Set();
  for (const s of STMTS.filter(s => s.kind === 'bank')) { cov.add(s.start.slice(0, 7)); cov.add(s.end.slice(0, 7)); }
  MONTHS = [...cov].sort();
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
const inMonths = ms => t => ms.includes(t.date.slice(0, 7));
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
  ({ overview: renderOverview, expenses: renderExpenses, txns: renderTxns, review: renderReview, statements: renderStatements })[VIEW]();
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
  const all = MONTHS.map(m => [m, totals([m])]), sel = new Set(ms);
  const cell = v => `<td class="n${v < 0 ? ' neg' : ''}">${money(v)}</td>`;
  $('plTable').innerHTML = `<tr><th>Month</th><th class="n">Revenue</th><th class="n">Cost of goods</th><th class="n">Labor</th><th class="n">Operating</th><th class="n">Profit</th><th class="n">Margin</th><th class="n">Taxes</th></tr>` +
    all.map(([m, t]) => `<tr class="click${sel.has(m) ? ' sel' : ''}" data-m="${m}"><td>${mName(m, true)}</td>${cell(t.revenue)}${cell(t.cogs)}${cell(t.labor)}${cell(t.operating)}${cell(t.profit)}<td class="n">${pct(t.revenue ? t.profit / t.revenue : NaN)}</td>${cell(t.tax)}</tr>`).join('') +
    (() => { const t = totals(MONTHS); return `<tr><td><b>All months</b></td>${[t.revenue, t.cogs, t.labor, t.operating, t.profit].map(v => `<td class="n"><b>${money(v)}</b></td>`).join('')}<td class="n"><b>${pct(t.revenue ? t.profit / t.revenue : NaN)}</b></td><td class="n"><b>${money(t.tax)}</b></td></tr>`; })();
  $('plTable').querySelectorAll('tr[data-m]').forEach(tr => tr.onclick = () => pick(tr.dataset.m));
}
function pick(m) { PERIOD = m; $('period').value = m; render(); }

// Owner money over all statements: loans the business still owes back, money invested, draws taken
function ownerMoney() {
  const own = TX.filter(t => t.group === 'owner' || t.cat === 'Owner money (assign)').sort((a, b) => a.date.localeCompare(b.date));
  const loans = own.filter(t => t.cat === 'Owner loan / repayment'), open = own.filter(t => t.cat === 'Owner money (assign)');
  const lent = sum(loans.filter(t => t.amount > 0), t => t.amount), repaid = -sum(loans.filter(t => t.amount < 0), t => t.amount);
  const inv = sum(own.filter(t => t.cat === 'Owner investment'), t => t.amount), draws = -sum(own.filter(t => t.cat === 'Owner draw'), t => t.amount);
  $('ownerSummary').innerHTML = `The business still owes you <b>${money(lent - repaid, 2)}</b>: you lent ${money(lent, 2)} and it has paid back ${money(repaid, 2)}.` +
    (inv ? ` Invested (not paid back): ${money(inv, 2)}.` : '') + (draws ? ` Draws taken: ${money(draws, 2)}.` : '') +
    (open.length ? ` <span class="bad">${open.length} transfer${open.length > 1 ? 's' : ''} with your other account still need${open.length > 1 ? '' : 's'} a label</span> (loan, investment or draw) in Needs review.` : '');
  $('ownerTable').innerHTML = own.length ? `<tr><th>Date</th><th>What</th><th class="n">In</th><th class="n">Out</th></tr>` +
    own.map(t => `<tr><td>${dName(t.date)}, ${t.date.slice(0, 4)}</td><td>${esc(t.cat)}<div class="desc">${esc(t.desc)}</div></td><td class="n">${t.amount > 0 ? money(t.amount, 2) : ''}</td><td class="n">${t.amount < 0 ? money(-t.amount, 2) : ''}</td></tr>`).join('') : '<tr><td class="note">No owner money yet.</td></tr>';
}

// The card started 2026 carrying construction-era debt. Paying the card is never an expense
// (that would count purchases twice, or count 2025 construction as 2026 costs), so this panel
// shows the debt itself: balance per statement, new spending, payments, and the equipment plan.
function cardDebt() {
  const st = STMTS.filter(s => s.kind === 'card').sort((a, b) => a.start.localeCompare(b.start));
  if (!st.length) { $('debtSummary').textContent = 'Upload credit card statements to see the card balance.'; $('debtTable').innerHTML = ''; return; }
  const first = st[0], last = st[st.length - 1];
  const spent = s => sum(s.txns.filter(t => t.amount < 0), t => -t.amount);
  const paid = s => sum(s.txns.filter(t => t.section === 'card-payment'), t => t.amount);
  const planNow = last.plan ? last.plan.remaining : 0;
  const paidOff = st.find(s => s.plan && s.plan.remaining === 0);
  const interest = sum(st, s => s.interest || 0);
  const open = first.opening ?? null, close = last.ending;
  $('debtSummary').innerHTML = (open != null ? `The card started at <b>${money(open, 2)}</b> on ${dName(first.start)}, ${first.start.slice(0, 4)} (construction-era spending) and was <b>${money(close, 2)}</b> on ${dName(last.end)}, ${last.end.slice(0, 4)}: ` +
    (open > close ? `<span class="ok">${money(open - close, 2)} paid down</span>.` : `<span class="bad">${money(close - open, 2)} higher</span>.`) : '') +
    ` Since then you paid ${money(sum(st, paid), 2)} to the card and spent ${money(sum(st, spent), 2)} on it. That spending is already in Expenses.` +
    (first.plan ? ` The ${money(first.plan.original, 2)} equipment plan (Pay Over Time) had ${money(first.plan.remaining, 2)} left after the first statement` +
      (paidOff ? ` and was <span class="ok">paid off by ${dName(paidOff.end)}</span>.` : `; ${money(planNow, 2)} is left.`) : '') +
    (interest > 0 ? ` Interest charged so far: <span class="bad">${money(interest, 2)}</span>.` : '');
  $('debtTable').innerHTML = `<tr><th>Statement</th><th class="n">New spending</th><th class="n">Paid</th><th class="n">Interest</th><th class="n">Equipment plan left</th><th class="n">Balance owed</th></tr>` +
    st.map(s => `<tr><td>${dName(s.start)} – ${dName(s.end)}</td><td class="n">${money(spent(s), 2)}</td><td class="n">${money(paid(s), 2)}</td><td class="n">${s.interest ? money(s.interest, 2) : '–'}</td><td class="n">${s.plan ? money(s.plan.remaining, 2) : '–'}</td><td class="n"><b>${money(s.ending, 2)}</b></td></tr>`).join('');
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
