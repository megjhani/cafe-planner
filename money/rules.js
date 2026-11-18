// Categories and the rules that sort transactions into them.
//
// Every category belongs to a group, and the group decides how it counts:
//   revenue    money the business earned
//   cogs       what you sell: coffee, food, groceries
//   labor      payroll and payroll taxes
//   operating  everything else it costs to run the cafe
//   tax        sales tax and other tax payments (shown apart from profit)
//   transfer   money moving between your own accounts, e.g. paying the credit card: never counted
//   owner      money you lend, invest or take out: never counted, tracked as "owed to owners"
//   personal   not the business: never counted
//   review     needs you to say what it is (checks, cash withdrawals, unknown)
// A refund (money coming back) in an expense category lowers that category.

export const GROUPS = {
  revenue: 'Revenue', cogs: 'Cost of goods', labor: 'Labor', operating: 'Operating',
  tax: 'Taxes', transfer: 'Transfers (not counted)', owner: 'Owner money (not counted)', personal: 'Personal (not counted)', review: 'Needs review',
};

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
  ['Credit card payment', 'transfer'],
  // owner money: in = you lent or put money into the business, out = it paid you back or you took it out
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

// [pattern tested on "payee | description", category]. First match wins.
const RULES = [
  // transfers first: card payments seen from both sides, and moves between your own accounts
  [/Chase Credit Crd|Payment To Chase Card|AUTOMATIC PAYMENT|Payment Thank You/i, 'Credit card payment'],
  // your own account: a loan, an investment or a draw; you say which (see KNOWN and Needs review)
  [/Online Transfer (From|To) Chk/i, 'Owner money (assign)'],
  // revenue
  [/Merch Bnkcd.*· Deposit/i, 'Card sales (Clover)'],
  [/Doordash, Inc|Uber USA 6787|Grubhub/i, 'Delivery apps'],
  [/Uber USA, LLC.*Partner/i, 'Other income'],
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
  [/Uticafirst|Hartford|Insurance|NEXT INSUR/i, 'Insurance'],
  // cost of goods
  [/Odeko/i, 'Coffee & cafe supplies'],
  [/Patisserie|Proper Hospitali|Savor Sabor|Bakery|Restaurant Depot|Baldor|Sysco/i, 'Bakery & food suppliers'],
  [/Wine|Liquor|Spirits|Beer|Southern Glazer|Breakthru|Johnson Brothers/i, 'Alcohol & beverages'],
  [/TRADER JOE|NUTS FACTORY|WHOLEFDS|Amazon Groce|Amazon Grocery|INSTACART|ALDI|C-TOWN|FOODTOWN|APNA BAZAR|DASHMART|COSTCO|BJ'?S|KEY FOOD|STOP & SHOP/i, 'Groceries'],
  // supplies & equipment
  [/WEBSTAURANT|AMAZON|Amazon\.com|Prime Now|TOSSWARE|LOLLICUP|WAYFAIR|WF \*|TARGET|MARSHALLS|BRICKMAN|CVS|HOME DEPOT|STAPLES|IKEA/i, 'Supplies & equipment'],
  [/Trivedi Law|\bCPA\b|Accounting|Legal/i, 'Legal & accounting'],
  [/VISTAPRINT|Facebk|Meta Ads|Google Ads|Yelp|Instagram/i, 'Marketing'],
  [/UBER|LYFT|MTA\*|EMPOWER|Via Transport/i, 'Travel & transport'],
  [/Sling|Hulu|Netflix|Spotify|Apple\.com|Google \*|Squarespace/i, 'Subscriptions'],
  [/INTEREST CHARGE|LATE FEE|Service Fee|Monthly Service/i, 'Bank fees & interest'],
  [/DON CHICKEN|DOORDASH(?!.*DASHMART)|GRUBHUB|SEAMLESS/i, 'Other expense'],
];

// category for a transaction: your choice for this transaction, else your rule for its payee,
// else the built-in rules; checks and ATM withdrawals wait for you to assign them
// Transactions the owner explained in person, matched by date + amount + text
const KNOWN = [
  // Murad lent the business $2,000 to cover April rent, then took $1,000 back (Nov 2026)
  ['2026-04-03', 2000, /Online Transfer From Chk/i, 'Owner loan / repayment'],
  ['2026-04-08', -1000, /Online Transfer To Chk/i, 'Owner loan / repayment'],
];

export function categorize(t, prefs = {}) {
  const byTx = prefs.tx || {}, byPayee = prefs.payee || {};
  if (byTx[t.id]) return byTx[t.id];
  for (const [d, a, re, cat] of KNOWN) if (t.date === d && Math.abs(t.amount - a) < 0.005 && re.test(t.desc)) return cat;
  if (byPayee[t.payee]) return byPayee[t.payee];
  const hay = `${t.payee} | ${t.desc}`;
  for (const [re, cat] of RULES) if (re.test(hay)) return cat;
  if (t.section === 'check') return 'Checks (assign)';
  if (t.section === 'atm' && /ATM Withdrawal/i.test(t.desc)) return 'Cash withdrawals (assign)';
  // branch, cash or check deposits: could be sales, a loan or your own money
  if (t.section === 'deposit') return 'Deposits (assign)';
  return 'Uncategorized';
}

// signed effect on the books: revenue positive, expenses positive, refunds negative.
// Transfers, personal and items needing review return 0 (shown separately).
export function bookAmount(t, cat) {
  const g = GROUP_OF[cat] || 'review';
  if (g === 'revenue') return t.amount;
  if (g === 'cogs' || g === 'labor' || g === 'operating' || g === 'tax') return -t.amount;
  return 0;
}
