/**
 * Fourteen months of a ledger for the Reports tab, dated back from today so
 * "Last 12 months" is always full and "All time" reaches further: two
 * paychecks and interest a month, five groups of lines, refunds, unfiled
 * purchases, a deleted line's leftovers, a transfer to savings and a card
 * payment every month (unfiled pairs, which reports leave out), and two
 * expensive months that run a deficit.
 */
const pad = (n: number) => String(n).padStart(2, '0');

/** Day `d` of the month `back` months before this one, never later than today in this month. */
const day = (back: number, d: number): string => {
  const now = new Date();
  const x = new Date(now.getFullYear(), now.getMonth() - back, 1);
  const last = new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate();
  const cap = back === 0 ? Math.min(last, now.getDate()) : last;
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(Math.min(d, cap))}`;
};
const rec = { created: 1, updated: 1 };

export const MONTHS = 14;

export function reportsLedger(): string {
  const accounts = [
    { id: 'a-chk', name: 'Checking', color: '#4c8bf0', order: 0, ...rec },
    { id: 'a-sav', name: 'Savings', color: '#66d695', order: 1, ...rec },
    { id: 'a-cc', name: 'Credit card', color: '#f39849', order: 2, ...rec },
  ];
  const categories = [
    { id: 'c-home', name: 'Housing', color: '#4c8bf0', order: 0, ...rec },
    { id: 'c-food', name: 'Food', color: '#66d695', order: 1, ...rec },
    { id: 'c-car', name: 'Transport', color: '#f39849', order: 2, ...rec },
    { id: 'c-fun', name: 'Fun', color: '#9e5ce0', order: 3, ...rec },
    { id: 'c-health', name: 'Health', color: '#ea5853', order: 4, ...rec },
  ];
  const line = (id: string, name: string, category: string, order: number, deleted = false) =>
    ({ id, name, category, budget: 0, needs: 0, snoozed: false, order: order * 1024, ...rec, ...(deleted ? { deleted: true as const } : {}) });
  const lines = [
    line('l-rent', 'Rent', 'c-home', 1), line('l-util', 'Utilities', 'c-home', 2),
    line('l-groc', 'Groceries', 'c-food', 1), line('l-dine', 'Dining out', 'c-food', 2),
    line('l-fuel', 'Fuel', 'c-car', 1), line('l-transit', 'Transit', 'c-car', 2), line('l-repair', 'Repairs', 'c-car', 3),
    line('l-stream', 'Streaming', 'c-fun', 1), line('l-hobby', 'Hobbies', 'c-fun', 2), line('l-travel', 'Travel', 'c-fun', 3),
    line('l-pharm', 'Pharmacy', 'c-health', 1),
    line('l-old', 'Old gym line', 'c-health', 2, true),
  ];
  let n = 0;
  const txns: Record<string, unknown>[] = [];
  const t = (name: string, amount: number, date: string, account: string, category: string | null) => {
    n += 1;
    txns.push({ id: `r${n}`, name, description: '', amount, date, account, category, order: 0, created: 1000 + n, updated: 1000 + n, cleared: true });
  };
  // Deterministic wobble, 0..1, so amounts vary month to month but never between runs.
  const w = (i: number, k: number) => ((i * 37 + k * 11) % 17) / 16;
  for (let b = MONTHS - 1; b >= 0; b--) {
    t('Paycheck', 312500, day(b, 1), 'a-chk', 'income');
    if (b !== 0 || new Date().getDate() >= 15) t('Paycheck', 312500, day(b, 15), 'a-chk', 'income');
    t('Interest', 300 + Math.round(w(b, 1) * 200), day(b, 28), 'a-sav', 'income');
    t('Rent', -185000, day(b, 2), 'a-chk', 'l-rent');
    t('Electric and water', -(9500 + Math.round(w(b, 2) * 6000)), day(b, 9), 'a-chk', 'l-util');
    for (let k = 0; k < 4; k++) t('Grocery store', -(9000 + Math.round(w(b, k + 3) * 9000)), day(b, 3 + k * 7), 'a-cc', 'l-groc');
    for (let k = 0; k < 3; k++) t(['Noodle bar', 'Pizza', 'Coffee shop'][k]!, -(1200 + Math.round(w(b, k + 7) * 5000)), day(b, 5 + k * 8), 'a-cc', 'l-dine');
    t('Gas', -(4000 + Math.round(w(b, 10) * 3000)), day(b, 6), 'a-cc', 'l-fuel');
    t('Gas', -(3800 + Math.round(w(b, 11) * 3000)), day(b, 20), 'a-cc', 'l-fuel');
    t('Transit pass', -4500, day(b, 1), 'a-cc', 'l-transit');
    t('Streaming', -1599, day(b, 12), 'a-cc', 'l-stream');
    if (b % 3 === 1) t('Craft supplies', -(2500 + Math.round(w(b, 12) * 6000)), day(b, 18), 'a-cc', 'l-hobby');
    if (b % 4 === 2) t('Pharmacy', -(1800 + Math.round(w(b, 13) * 2500)), day(b, 22), 'a-cc', 'l-pharm');
    // Refunds: money back on a line takes that line's spending down.
    if (b % 2 === 0) t('Refund: groceries', 1850, day(b, 24), 'a-cc', 'l-groc');
    // Unfiled purchases, and one row still on a line that was deleted.
    t('Hardware store', -(2000 + Math.round(w(b, 14) * 4000)), day(b, 11), 'a-cc', null);
    if (b === 5) t('Gym', -3900, day(b, 4), 'a-cc', 'l-old');
    // Transfers between the owner's own accounts: unfiled, out and in.
    t('Transfer to savings', -50000, day(b, 16), 'a-chk', null);
    t('Transfer from checking', 50000, day(b, 16), 'a-sav', null);
    const card = 150000 + Math.round(w(b, 15) * 60000);
    t('Card payment', -card, day(b, 25), 'a-chk', null);
    t('Card payment received', card, day(b, 26), 'a-cc', null);
  }
  // Two months that cost more than came in.
  t('Car repair', -245000, day(7, 13), 'a-cc', 'l-repair');
  t('Flights', -410000, day(3, 8), 'a-cc', 'l-travel');
  t('Hotel', -186000, day(3, 9), 'a-cc', 'l-travel');
  return JSON.stringify({ v: 4, txns, accounts, categories, lines, budgets: [], settings: [] });
}
