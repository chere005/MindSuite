/**
 * The wide Transactions screen: a table (Date, Name, Category, Amount, then
 * Balance for ONE account or Account for all of them, and Cleared), a foot
 * with the shown rows' count and totals, and — when the ledger is editable —
 * the quick-entry row on top. Every rule is core's (`ledgerTable`, `quickDraft`).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  EMPTY_TXN_FILTER, INCOME, INCOME_NAME, formatAmount, formatDay, ledgerTable, quickDraft, today,
  type Account, type AmountMode, type CategoryChoice, type CategoryRule, type Draft, type Txn,
} from '@acctmind/core';
import { T } from '../theme';
import { Btn, SELECTED_ROW } from './shared';

const W = { date: 72, cat: 124, acct: 112, amount: 104, balance: 104, cleared: 56 } as const;

export function WideTransactions({
  txns, accounts, account, choices, rules, mode, selectedId, readOnly, banner, quickAccount,
  onSelect, onCleared, onQuickAdd, onNew,
}: {
  txns: readonly Txn[];
  accounts: readonly Account[];
  /** The one account shown, or null for all of them. */
  account: string | null;
  choices: readonly CategoryChoice[];
  rules: readonly CategoryRule[];
  /** The cog's Whole dollars: how bare digits in the Amount cell are read. */
  mode: AmountMode;
  selectedId: string | null;
  readOnly: boolean;
  banner: React.ReactNode;
  /** Where quick entry files a row when "All accounts" is shown. */
  quickAccount: string;
  onSelect: (txn: Txn) => void;
  onCleared: (txn: Txn, cleared: boolean) => void;
  onQuickAdd: (draft: Draft) => void;
  onNew: () => void;
}) {
  const [query, setQuery] = useState('');
  const [uncleared, setUncleared] = useState(false);
  const filter = useMemo(
    () => ({ ...EMPTY_TXN_FILTER, query, status: uncleared ? 'uncleared' as const : 'any' as const }),
    [query, uncleared],
  );
  const { rows, foot } = useMemo(() => ledgerTable(txns, accounts, account, filter), [txns, accounts, account, filter]);
  const one = account !== null;
  const acctName = (id: string) => accounts.find((a) => a.id === id)?.name ?? '';
  const catName = (id: string | null) => id === null ? null : id === INCOME ? INCOME_NAME : choices.find((c) => c.id === id)?.name ?? null;
  const head = one ? acctName(account) : 'All accounts';

  return (
    <View style={styles.fill} testID="wide-transactions">
      {banner}
      <View style={styles.head}>
        <Text style={styles.h1} numberOfLines={1} testID="wide-title">{head}</Text>
        <View style={styles.grow} />
        <TextInput
          value={query} onChangeText={setQuery} placeholder="Search" placeholderTextColor={T.faint}
          accessibilityLabel="Search transactions" style={styles.search} testID="wide-search"
        />
        <Pressable
          onPress={() => setUncleared((u) => !u)} accessibilityRole="button" accessibilityState={{ selected: uncleared }}
          style={[styles.toggle, uncleared && styles.toggleOn]} testID="wide-uncleared"
        >
          <Text style={styles.toggleText}>Uncleared only</Text>
        </Pressable>
        {!readOnly && <Btn label="New transaction" primary onPress={onNew} testID="wide-new" />}
      </View>

      <View style={[styles.row, styles.thead]} testID="wide-thead">
        <Text style={[styles.th, { width: W.date }]}>Date</Text>
        <Text style={[styles.th, styles.grow, styles.nameCol]}>Name</Text>
        <Text style={[styles.th, { width: W.cat }]}>Category</Text>
        {!one && <Text style={[styles.th, { width: W.acct }]} testID="col-account">Account</Text>}
        <Text style={[styles.th, styles.num, { width: W.amount }]}>Amount</Text>
        {one && <Text style={[styles.th, styles.num, { width: W.balance }]} testID="col-balance">Balance</Text>}
        <Text style={[styles.th, styles.mid, { width: W.cleared }]}>Cleared</Text>
      </View>

      <ScrollView style={styles.grow} contentContainerStyle={styles.tbody}>
        {!readOnly && (
          <QuickRow
            account={one ? account : quickAccount} accounts={accounts} choices={choices} rules={rules} mode={mode}
            showAccount={!one} showBalance={one} onAdd={onQuickAdd}
          />
        )}
        {rows.map(({ txn, balance }) => {
          const cat = catName(txn.category);
          return (
            <Pressable
              key={txn.id} onPress={() => onSelect(txn)} accessibilityRole="button"
              style={[styles.row, styles.trow, txn.id === selectedId && { backgroundColor: SELECTED_ROW }]}
              testID="wide-row"
            >
              <Text style={[styles.td, styles.dim, { width: W.date }]} numberOfLines={1}>{formatDay(txn.date)}</Text>
              <Text style={[styles.td, styles.grow, styles.nameCol, styles.name]} numberOfLines={1} testID="wide-row-name">{txn.name}</Text>
              <Text style={[styles.td, cat === null && styles.dim, { width: W.cat }]} numberOfLines={1}>{cat ?? 'Uncategorized'}</Text>
              {!one && <Text style={[styles.td, styles.dim, { width: W.acct }]} numberOfLines={1}>{acctName(txn.account)}</Text>}
              <Text style={[styles.td, styles.num, txn.amount > 0 && styles.pos, { width: W.amount }]} numberOfLines={1} testID="wide-row-amount">
                {txn.amount > 0 ? '+' : ''}{formatAmount(txn.amount)}
              </Text>
              {one && <Text style={[styles.td, styles.num, { width: W.balance }]} numberOfLines={1} testID="wide-row-balance">{formatAmount(balance ?? 0)}</Text>}
              <View style={[styles.mid, { width: W.cleared }]}>
                {readOnly ? (
                  <Text style={styles.tick}>{txn.cleared === true ? '✓' : ''}</Text>
                ) : (
                  <Pressable
                    onPress={() => onCleared(txn, txn.cleared !== true)} accessibilityRole="checkbox"
                    accessibilityState={{ checked: txn.cleared === true }} accessibilityLabel="Cleared"
                    style={[styles.box, txn.cleared === true && styles.boxOn]} testID="wide-row-cleared"
                  >
                    {txn.cleared === true && <Text style={styles.boxTick}>✓</Text>}
                  </Pressable>
                )}
              </View>
            </Pressable>
          );
        })}
        {rows.length === 0 && <Text style={styles.empty} testID="wide-empty">No transactions.</Text>}
      </ScrollView>

      <View style={styles.foot} testID="wide-foot">
        <Text style={styles.footText} numberOfLines={1}>
          {foot.count} {foot.count === 1 ? 'transaction' : 'transactions'}
          {' · in '}<Text style={styles.pos}>{formatAmount(foot.moneyIn)}</Text>
          {' · out '}{formatAmount(foot.moneyOut)}
          {' · net '}<Text style={styles.bold}>{formatAmount(foot.net)}</Text>
        </Text>
      </View>
    </View>
  );
}

/**
 * The quick-entry row: date, name, category, amount. Return adds it through
 * core's `quickDraft` (Draft + validateDraft), then focus goes back to the name
 * for the next one. ⌘N (Ctrl+N elsewhere) focuses it.
 */
function QuickRow({ account, accounts, choices, rules, mode, showAccount, showBalance, onAdd }: {
  account: string; accounts: readonly Account[]; choices: readonly CategoryChoice[]; rules: readonly CategoryRule[]; mode: AmountMode;
  showAccount: boolean; showBalance: boolean; onAdd: (draft: Draft) => void;
}) {
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const nameRef = useRef<TextInput>(null);
  const acct = showAccount ? pick ?? account : account;

  const focus = useCallback(() => { nameRef.current?.focus(); }, []);
  useEffect(() => {
    if (Platform.OS !== 'web') return undefined;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focus]);

  const submit = () => {
    const { draft, errors } = quickDraft({ date, name, category, amount }, { account: acct, choices, rules, mode, today: today() });
    const first = Object.values(errors)[0];
    if (first !== undefined) { setError(first); return; }
    setError(null);
    onAdd(draft);
    setName(''); setCategory(''); setAmount('');
    // Keep the date: a run of entries is usually one day.
    requestAnimationFrame(focus);
  };
  const common = { onSubmitEditing: submit, placeholderTextColor: T.faint, returnKeyType: 'done' as const };
  const cycle = () => {
    const ids = accounts.map((a) => a.id);
    setPick(ids[(ids.indexOf(acct) + 1) % ids.length] ?? acct);
  };
  return (
    <View style={styles.quickWrap} testID="quick-entry">
      <View style={[styles.row, styles.quick]}>
        <TextInput {...common} value={date} onChangeText={setDate} placeholder="Today" accessibilityLabel="Date"
          style={[styles.cell, { width: W.date }]} testID="quick-date" />
        <TextInput {...common} ref={nameRef} value={name} onChangeText={setName} placeholder="Name" accessibilityLabel="Name"
          style={[styles.cell, styles.grow, styles.nameCol]} testID="quick-name" />
        <TextInput {...common} value={category} onChangeText={setCategory} placeholder="Category" accessibilityLabel="Category"
          style={[styles.cell, { width: W.cat }]} testID="quick-category" />
        {showAccount && (
          <Pressable onPress={cycle} style={[styles.cell, styles.acctCell, { width: W.acct }]} accessibilityRole="button"
            accessibilityLabel="Account" testID="quick-account">
            <Text style={styles.td} numberOfLines={1}>{accounts.find((a) => a.id === acct)?.name ?? ''}</Text>
          </Pressable>
        )}
        <TextInput {...common} value={amount} onChangeText={setAmount} placeholder="−0.00" accessibilityLabel="Amount"
          style={[styles.cell, styles.num, { width: W.amount }]} testID="quick-amount" />
        {showBalance && <Text style={[styles.hint, { width: W.balance }]}>Return adds it</Text>}
        <View style={{ width: W.cleared }} />
      </View>
      {error !== null && <Text style={styles.error} testID="quick-error">{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, minHeight: 0 },
  grow: { flex: 1, minWidth: 0 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 10, flexWrap: 'wrap' },
  h1: { color: T.text, fontSize: 20, fontWeight: '600', flexShrink: 1 },
  search: {
    width: 180, minHeight: 32, borderRadius: 8, paddingHorizontal: 10, color: T.text, fontSize: 14,
    backgroundColor: T.card, borderWidth: StyleSheet.hairlineWidth, borderColor: T.faint,
  },
  toggle: { minHeight: 32, paddingHorizontal: 12, borderRadius: 8, justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: T.faint },
  toggleOn: { backgroundColor: 'rgba(10,132,255,0.28)', borderColor: T.accent },
  toggleText: { color: T.text, fontSize: 14 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 8 },
  thead: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: T.cardEdge, paddingVertical: 6 },
  th: { color: T.dim, fontSize: 12, fontWeight: '500' },
  tbody: { paddingBottom: 8 },
  trow: { minHeight: 38, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: T.lineSoft },
  td: { color: T.text, fontSize: 14 },
  name: { fontWeight: '500' },
  nameCol: { minWidth: 100 },
  dim: { color: T.dim },
  num: { textAlign: 'right', fontVariant: ['tabular-nums'] },
  mid: { alignItems: 'center', justifyContent: 'center' },
  pos: { color: T.positive },
  bold: { fontWeight: '600', color: T.text },
  tick: { color: T.positive, fontSize: 14 },
  box: { width: 18, height: 18, borderRadius: 5, borderWidth: 1, borderColor: T.dim, alignItems: 'center', justifyContent: 'center' },
  boxOn: { backgroundColor: T.accent, borderColor: T.accent },
  boxTick: { color: '#fff', fontSize: 11, lineHeight: 13 },
  empty: { color: T.dim, padding: 24, textAlign: 'center' },
  foot: { paddingHorizontal: 16, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: T.cardEdge, backgroundColor: T.card },
  footText: { color: T.dim, fontSize: 13, fontVariant: ['tabular-nums'] },
  quickWrap: { backgroundColor: 'rgba(10,132,255,0.08)', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: T.accent },
  quick: { minHeight: 44 },
  cell: {
    minHeight: 30, borderRadius: 6, paddingHorizontal: 8, color: T.text, fontSize: 14,
    backgroundColor: T.bg, borderWidth: StyleSheet.hairlineWidth, borderColor: T.faint,
  },
  acctCell: { justifyContent: 'center' },
  hint: { color: T.dim, fontSize: 12 },
  error: { color: T.danger, fontSize: 12, paddingHorizontal: 16, paddingBottom: 6 },
});
