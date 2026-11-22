/**
 * A realistic ledger for the wide layout: three accounts, four groups with
 * lines and targets, a few dozen transactions this month and last (a long
 * payee, one uncategorized row, expenses and income), and this month's
 * allocations. Dates are relative to today so the Budget tab always has a month
 * with spending in it.
 */
import { monthBudget, thisMonthSet } from './helpers';

const d = (back: number): string => {
  const x = new Date();
  x.setDate(x.getDate() - back);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};
const rec = { created: 1, updated: 1 };

/**
 * `snoozed`: line ids snoozed for this month (the wide Budget's Snooze box).
 * `overspend`: a $50 Vacation charge today, so that line (nothing allocated)
 * is over this month.
 */
export function wideLedger(o: { snoozed?: readonly string[]; overspend?: boolean } = {}): string {
  const accounts = [
    { id: 'a-chk', name: 'Checking', color: '#4c8bf0', order: 0, ...rec },
    { id: 'a-sav', name: 'Savings', color: '#66d695', order: 1, ...rec },
    { id: 'a-cc', name: 'Credit card', color: '#f39849', order: 2, ...rec },
  ];
  const categories = [
    { id: 'c-home', name: 'Housing', color: '#4c8bf0', order: 0, ...rec },
    { id: 'c-bills', name: 'Bills', color: '#9e5ce0', order: 1, ...rec },
    { id: 'c-food', name: 'Food', color: '#66d695', order: 2, ...rec },
    { id: 'c-save', name: 'Savings', color: '#f39849', order: 3, ...rec },
  ];
  const line = (id: string, name: string, category: string, needs: number, order: number) =>
    ({ id, name, category, budget: 0, needs, snoozed: false, order: order * 1024, ...rec });
  const lines = [
    line('l-rent', 'Rent', 'c-home', 185000, 1),
    line('l-elec', 'Electric', 'c-bills', 12000, 1),
    line('l-net', 'Internet', 'c-bills', 6500, 2),
    line('l-groc', 'Groceries', 'c-food', 60000, 1),
    line('l-dine', 'Dining', 'c-food', 8000, 2),
    line('l-emerg', 'Emergency fund', 'c-save', 20000, 1),
    line('l-vac', 'Vacation', 'c-save', 15000, 2),
  ];
  let n = 0;
  const t = (name: string, amount: number, back: number, account: string, category: string | null, cleared = false) => ({
    id: `t${++n}`, name, description: '', amount, date: d(back), account, category, order: 0,
    created: 1000 + n, updated: 1000 + n, ...(cleared ? { cleared: true as const } : {}),
  });
  const txns = [
    t('Opening balance', 250000, 60, 'a-chk', 'income', true),
    t('Opening balance', 410000, 60, 'a-sav', 'income', true),
    t('Paycheck', 312500, 20, 'a-chk', 'income', true),
    t('Paycheck', 312500, 2, 'a-chk', 'income', false),
    t('Rent', -185000, 19, 'a-chk', 'l-rent', true),
    t('Electric', -9412, 17, 'a-chk', 'l-elec', true),
    t('Internet', -6500, 16, 'a-chk', 'l-net', true),
    t('Coffee shop', -675, 15, 'a-cc', 'l-dine', true),
    t('Noodle bar', -4200, 14, 'a-cc', 'l-dine', true),
    t('Pizza', -4800, 13, 'a-cc', 'l-dine', true),
    t('Grocery store', -12840, 12, 'a-cc', 'l-groc', true),
    t('Farmers market', -3350, 11, 'a-cc', 'l-groc', true),
    t('Grocery store', -9875, 9, 'a-cc', 'l-groc', true),
    t('Bookshop', -2499, 8, 'a-cc', null, true),
    t('Transfer to savings', -20000, 7, 'a-chk', 'l-emerg', true),
    t('Transfer from checking', 20000, 7, 'a-sav', 'income', true),
    t('Interest', 412, 6, 'a-sav', 'income', true),
    t('Coffee shop', -575, 5, 'a-cc', 'l-dine', false),
    t('Grocery store', -15620, 4, 'a-cc', 'l-groc', false),
    t('Riverside Community Credit Union annual membership and safe deposit box renewal fee', -4500, 3, 'a-chk', 'l-net', false),
    t('Lunch', -1450, 3, 'a-cc', 'l-dine', false),
    t('Refund: headphones', 5999, 2, 'a-cc', null, false),
    t('Groceries', -8830, 1, 'a-cc', 'l-groc', false),
    t('Coffee shop', -625, 0, 'a-cc', 'l-dine', false),
    t('Coffee shop', -675, 33, 'a-cc', 'l-dine', true),
    t('Grocery store', -11200, 35, 'a-cc', 'l-groc', true),
    t('Rent', -185000, 49, 'a-chk', 'l-rent', true),
    t('Electric', -10120, 47, 'a-chk', 'l-elec', true),
    t('Paycheck', 312500, 50, 'a-chk', 'income', true),
    t('Gym', -3900, 40, 'a-cc', null, true),
    t('Dinner out', -6850, 38, 'a-cc', 'l-dine', true),
    t('Hardware store', -2740, 30, 'a-cc', null, true),
    t('Streaming', -1599, 28, 'a-cc', 'l-net', true),
    t('Pharmacy', -1840, 26, 'a-cc', null, true),
    t('Gas', -4210, 24, 'a-cc', null, true),
    t('Paycheck', 312500, 36, 'a-chk', 'income', true),
    ...(o.overspend === true ? [t('Flights deposit', -5000, 0, 'a-cc', 'l-vac')] : []),
  ];
  const budgets = [
    monthBudget('l-rent', 185000), monthBudget('l-elec', 12000), monthBudget('l-net', 12000),
    monthBudget('l-groc', 60000), monthBudget('l-dine', 15000), monthBudget('l-emerg', 20000),
  ];
  const settings = [
    { id: 'budgetStart', value: `${d(0).slice(0, 8)}01`, ...rec },
    ...(o.snoozed ?? []).map((id) => ({ id: `snooze:${thisMonthSet()}|${id}`, value: '1', ...rec })),
  ];
  return JSON.stringify({ v: 4, txns, accounts, categories, lines, budgets, settings });
}
