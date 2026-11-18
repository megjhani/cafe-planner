// Categories and the rules that sort transactions into them.
//
// Every category belongs to a group, and the group decides how it counts:
//   revenue    money the business earned
//   cogs       what you sell: coffee, food, groceries
//   labor      payroll and payroll taxes
//   operating  everything else it costs to run the cafe
//   tax        sales tax and other tax payments (shown apart from profit)
//   startup    building the cafe: construction, equipment, lease deposit. Never in monthly profit;
//              shown on the Startup & partners tab
//   transfer   money moving between your own accounts, e.g. paying the credit card: never counted
//   owner      money a partner puts in, lends or takes out: never counted, tracked per partner
//   personal   not the business: never counted
//   review     needs you to say what it is (checks, cash withdrawals, unknown)
// A refund (money coming back) in an expense category lowers that category.
//
// Everything dated before OPEN_DATE is the startup phase: it never counts in monthly profit,
// whatever its category, and is totalled on the Startup & partners tab instead.

export const OPEN_DATE = '2025-12-13';      // the cafe opened
export const PARTNERS = ['Murad', 'Scherize', 'Altaf'];

export const GROUPS = {
  revenue: 'Revenue', cogs: 'Cost of goods', labor: 'Labor', operating: 'Operating',
  tax: 'Taxes', startup: 'Startup & build-out', transfer: 'Transfers (not counted)',
  owner: 'Partner money (not counted)', personal: 'Personal (not counted)', review: 'Needs review',
};

// a partner's money: "investment" stays in the business, "loan / repayment" is paid back
// (in = lent, out = repaid), "draw" is money taken out as the partner's share
export const partnerCat = (p, kind) => `${p} · ${kind}`;
const PARTNER_KINDS = ['investment', 'loan / repayment', 'draw'];

export const CATEGORIES = [
  ['Card sales (Clover)', 'revenue'],
  ['Delivery apps', 'revenue'],
  ['Cash & check deposits', 'revenue'],
  ['Other income', 'revenue'],
  ['Coffee & cafe supplies', 'cogs'],
  ['Bakery & food suppliers', 'cogs'],
  ['Groceries', 'cogs'],
  ['Alcohol & beverages', 'cogs'],
  ['Payroll', 'labor'],
  ['Payroll taxes & fees', 'labor'],
  ['Staff paid by check/cash', 'labor'],
  ['Rent', 'operating'],
  ['Utilities & internet', 'operating'],
  ['Trash hauling', 'operating'],
  ['Insurance', 'operating'],
  ['Card processing fees', 'operating'],
  ['Supplies & equipment', 'operating'],
  ['Repairs & maintenance', 'operating'],
  ['Legal & accounting', 'operating'],
  ['Comedy & entertainment', 'operating'],
  ['Marketing', 'operating'],
  ['Travel & transport', 'operating'],
  ['Subscriptions', 'operating'],
  ['Bank fees & interest', 'operating'],
  ['Other expense', 'operating'],
  ['Sales tax', 'tax'],
  ['Income & other taxes', 'tax'],
  ['Construction & build-out', 'startup'],
  ['Equipment & furniture', 'startup'],
  ['Licenses, permits & insurance', 'startup'],
  ['Lease security deposit', 'startup'],
  ['Credit card payment', 'transfer'],
  ...PARTNERS.flatMap(p => PARTNER_KINDS.map(k => [partnerCat(p, k), 'owner'])),
  // older labels without a partner name, kept so earlier choices still work
  ['Owner loan / repayment', 'owner'],
  ['Owner investment', 'owner'],
  ['Owner draw', 'owner'],
  ['Personal', 'personal'],
  ['Owner money (assign)', 'review'],
  ['Deposits (assign)', 'review'],
  ['Checks (assign)', 'review'],
  ['Cash withdrawals (assign)', 'review'],
  ['Uncategorized', 'review'],
].map(([name, group]) => ({ name, group }));
export const GROUP_OF = Object.fromEntries(CATEGORIES.map(c => [c.name, c.group]));

// which partner a partner-money category belongs to ('' for the older unnamed ones)
export const partnerOf = cat => (cat.match(/^(\w+) · /) || [])[1] || '';
export const isLoan = cat => /loan \/ repayment$/.test(cat);

// [pattern tested on "payee | description", category]. First match wins.
const RULES = [
  // transfers first: card payments seen from both sides
  [/Chase Credit Crd|Payment To Chase Card|AUTOMATIC PAYMENT|Payment Thank You/i, 'Credit card payment'],
  // partners: Murad's personal account (…XXXX) and the partners' own wires in
  [/Online Transfer From Chk \.\.\.XXXX/i, partnerCat('Murad', 'investment')],
  [/Online Transfer (From|To) Chk/i, 'Owner money (assign)'],
  [/B\/O:.*Murad/i, partnerCat('Murad', 'investment')],
  [/B\/O:.*Altaf/i, partnerCat('Altaf', 'investment')],
  [/B\/O:.*(Scherize|Hamirani)/i, partnerCat('Scherize', 'investment')],
  // revenue
  [/Merch Bnkcd.*· Deposit|First Data Rapid Depos/i, 'Card sales (Clover)'],
  [/Doordash, Inc|Uber USA 6787|Grubhub/i, 'Delivery apps'],
  [/Uber USA, LLC.*Partner/i, 'Other income'],
  [/STATEMENT CREDIT/i, 'Other income'],
  // processing fees (Clover's processor takes its discount, fees and adjustments out of the bank)
  [/Merch Bnkcd|Clover Fees|Cash Deposit Immediate/i, 'Card processing fees'],
  // labor
  [/Accountantsworld/i, 'Payroll'],
  [/Payrolltax|Payrollbilling|Nys Dol Ui|Nys Dtf Wt/i, 'Payroll taxes & fees'],
  // taxes
  [/Nys Dtf Sales/i, 'Sales tax'],
  [/Nys Dtf Pit|\bIRS\b|Usataxpymt|NYDOF|Nyc Dof|Betax/i, 'Income & other taxes'],
  // rent, utilities, insurance
  [/Allen House/i, 'Rent'],
  [/Con Ed|CONED|Spectrum|National Grid|Verizon|T-Mobile/i, 'Utilities & internet'],
  [/WCI|HAULING/i, 'Trash hauling'],
  [/Uticafirst|Hartford|Insurance|NEXT INSUR|Prism/i, 'Insurance'],
  // equipment bought for the build-out
  [/DRINKRIPPLES|MAJESTIC/i, 'Equipment & furniture'],
  // cost of goods
  [/Odeko|WB LAW COFFEE/i, 'Coffee & cafe supplies'],
  [/Patisserie|Proper Hospitali|Savor Sabor|Bakery|Restaurant Depot|Baldor|Sysco/i, 'Bakery & food suppliers'],
  [/Wine|Liquor|Spirits|Beer|Southern Glazer|Breakthru|Johnson Brothers/i, 'Alcohol & beverages'],
  [/TRADER JOE|NUTS FACTORY|WHOLEFDS|FRESHCO|Amazon Groce|Amazon Grocery|INSTACART|ALDI|C-TOWN|FOODTOWN|APNA BAZAR|DASHMART|COSTCO|BJ'?S|KEY FOOD|STOP & SHOP/i, 'Groceries'],
  // supplies & equipment
  [/WEBSTAURANT|AMAZON|Amazon\.com|Prime Now|TOSSWARE|LOLLICUP|WAYFAIR|WF \*|TARGET|MARSHALLS|BRICKMAN|CVS|HOME DEPOT|STAPLES|IKEA|Check OR Supply/i, 'Supplies & equipment'],
  [/SPEEDY LOCK|Locksmith|Plumb|Electric/i, 'Repairs & maintenance'],
  [/Trivedi Law|\bCPA\b|Accounting|Legal/i, 'Legal & accounting'],
  [/VISTAPRINT|Facebk|Meta Ads|Google Ads|Yelp|Instagram/i, 'Marketing'],
  [/UBER|LYFT|MTA\*|EMPOWER|Via Transport/i, 'Travel & transport'],
  [/Sling|Hulu|Netflix|Spotify|Apple\.com|Google \*|Squarespace/i, 'Subscriptions'],
  [/INTEREST CHARGE|LATE FEE|Service Fee|Monthly Service|Wire Fee|Night Drop/i, 'Bank fees & interest'],
  [/Acctverify/i, 'Payroll taxes & fees'],
  [/DON CHICKEN|DOORDASH(?!.*DASHMART)|GRUBHUB|SEAMLESS/i, 'Other expense'],
];

// Transactions the owners explained, matched by date + amount + text (Nov 2026, from Murad
// and the partners' workbook "Musche Expenses and Deposits.xlsx")
const KNOWN = [
  // partners' money in during setup
  ['2025-06-23', 10000, /^Deposit \d/, partnerCat('Scherize', 'investment')],
  ['2025-06-24', 9600, /^Deposit \d/, partnerCat('Scherize', 'investment')],
  ['2025-06-24', 400, /^Deposit \d/, partnerCat('Scherize', 'investment')],
  ['2025-06-27', 6000, /^Deposit \d/, partnerCat('Scherize', 'investment')],
  ['2025-10-20', 2000, /ATM Cash Deposit/i, partnerCat('Scherize', 'investment')],
  ['2025-12-10', 6000, /^Deposit \d/, partnerCat('Murad', 'investment')],
  ['2026-02-06', 9500, /^Deposit \d/, partnerCat('Altaf', 'investment')],
  // Murad lent the business $2,000 to cover April rent, then took $1,000 back
  ['2026-04-03', 2000, /Online Transfer From Chk/i, partnerCat('Murad', 'loan / repayment')],
  ['2026-04-08', -1000, /Online Transfer To Chk/i, partnerCat('Murad', 'loan / repayment')],
  // setup spending
  ['2025-06-25', -32000, /Check #7816/, 'Lease security deposit'],
  ['2025-06-25', -8000, /Check #7817/, 'Lease security deposit'],
  ['2025-07-02', -973, /Check #7818/, 'Licenses, permits & insurance'],     // Prism insurance
  ['2025-10-22', -775, /Check #102\b/, 'Licenses, permits & insurance'],    // Prism, construction cover
  ['2025-09-15', -14384.22, /WEBSTAURANT/i, 'Equipment & furniture'],        // equipment order (paid over time)
  ['2025-10-01', -6000, /Check #101\b/, 'Construction & build-out'],         // HVAC
  ['2025-10-14', -10000, /Withdrawal/i, 'Construction & build-out'],         // Lin, contractor
  ['2025-10-31', -5000, /Withdrawal/i, 'Construction & build-out'],          // Lin, contractor
  ['2025-11-04', -2100, /ATM Withdrawal/i, 'Construction & build-out'],      // Lin, bricks
];

// category for a transaction: your choice for this transaction, else what the owners
// explained, else your rule for its payee, else the built-in rules; checks, ATM cash and
// branch deposits wait for you to assign them
// older labels without a partner name, and the kind each one means
const UNNAMED_OWNER = { 'Owner investment': 'investment', 'Owner loan / repayment': 'loan / repayment', 'Owner draw': 'draw' };

export function categorize(t, prefs = {}) {
  const byTx = prefs.tx || {}, byPayee = prefs.payee || {};
  const chosen = byTx[t.id] || null;
  if (chosen && !UNNAMED_OWNER[chosen]) return chosen;
  const auto = autoCategory(t, byPayee);
  // a choice saved before partners had names: keep its kind, take the partner from the
  // owners' explanations or the rules (the $10,000 and $9,500 deposits, for example)
  if (chosen) return partnerOf(auto) ? partnerCat(partnerOf(auto), UNNAMED_OWNER[chosen]) : chosen;
  return auto;
}

function autoCategory(t, byPayee) {
  for (const [d, a, re, cat] of KNOWN) if (t.date === d && Math.abs(t.amount - a) < 0.005 && re.test(t.desc)) return cat;
  const own = byPayee[t.payee];
  if (own && !UNNAMED_OWNER[own]) return own;
  const hay = `${t.payee} | ${t.desc}`;
  for (const [re, cat] of RULES) if (re.test(hay)) return own && partnerOf(cat) ? partnerCat(partnerOf(cat), UNNAMED_OWNER[own]) : own || cat;
  if (own) return own;
  if (t.section === 'check') return 'Checks (assign)';
  if (t.section === 'atm' && /ATM Withdrawal/i.test(t.desc)) return 'Cash withdrawals (assign)';
  // branch, cash or check deposits: could be sales, a loan or a partner's money
  if (t.section === 'deposit') return 'Deposits (assign)';
  return 'Uncategorized';
}

// signed effect on monthly profit: revenue positive, expenses positive, refunds negative.
// The startup phase, startup costs, transfers, partner money, personal and items needing
// review return 0 (shown separately).
export function bookAmount(t, cat) {
  if (t.date < OPEN_DATE) return 0;
  const g = GROUP_OF[cat] || 'review';
  if (g === 'revenue') return t.amount;
  if (g === 'cogs' || g === 'labor' || g === 'operating' || g === 'tax') return -t.amount;
  return 0;
}

// cost of building the cafe: anything spent before opening (other than transfers, partner
// money and personal) plus startup categories used after opening; refunds lower it
export function startupAmount(t, cat) {
  const g = GROUP_OF[cat] || 'review';
  if (g === 'startup') return -t.amount;
  if (t.date >= OPEN_DATE) return 0;
  if (g === 'cogs' || g === 'labor' || g === 'operating' || g === 'tax') return -t.amount;
  return 0;
}
