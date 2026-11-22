/**
 * AcctMind at desktop size: the shared WideFrame (sidebar, main pane, detail
 * pane) filled with AcctMind's screens. App.tsx renders this instead of the
 * phone column and tab bar at 900 px and up.
 *
 * The main pane wears the suite's top bar, as CalMind's wide layout does: the
 * tab's title, the section pie (accounts on Transactions, categories on
 * Budget: the phone's picker, the same ring) and the account pill or cog in
 * the top-right corner. The sidebar holds navigation and the More list.
 *
 * Plumbing only. What a table shows, what the totals are, who may edit and
 * how a quick-entry row is read are core's (`ledgerTable`, `budgetSheet`,
 * `quickDraft`, `ledgerAccess`).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import {
  addTxn, accountBalances, applyDraft, draftOf, budgetSheet, budgetStart, formatAmount, live, makeTxn, monthSet, newId,
  putBudget, putLine, putSnooze, REORDER_GAP, setCleared, syncLine, tombstone, touch, updateTxn,
  type AmountMode, type CategoryChoice, type CategoryRule, type Draft, type Store, type SyncInfo, type Txn,
} from '@acctmind/core';
import { SidebarItem, SidebarLabel, SidebarTitle, WideFrame } from '../components/WideFrame';
import { Dot } from '../Dot';
import { SectionPick } from '../SectionPick';
import { TopBar } from '../TopBar';
import { T } from '../theme';
import type { Tab } from '../Tabs';
import { LinePane, type LineEdit } from './LinePane';
import { TxnEditor } from './TxnEditor';
import { WideBudget } from './WideBudget';
import { WideReports } from './WideReports';
import { WideTransactions } from './WideTransactions';
import { WIDE_COLORS } from './shared';

export type WideActions = {
  onImport: () => void;
  onExport: () => void;
  onMatch: () => void;
  onManage: (what: 'accounts' | 'categories') => void;
};

export function WideApp({
  store, commit, tab, onTab, budgetMonth, onBudgetMonth, mode, rules, choices, readOnly, banner, info,
  menu, actions,
}: {
  store: Store;
  commit: (next: Store) => void;
  tab: Tab;
  onTab: (t: Tab) => void;
  budgetMonth: string;
  onBudgetMonth: (m: string) => void;
  mode: AmountMode;
  rules: readonly CategoryRule[];
  choices: readonly CategoryChoice[];
  readOnly: boolean;
  banner: React.ReactNode;
  info: SyncInfo;
  menu: React.ReactNode;
  actions: WideActions;
}) {
  const [account, setAccount] = useState<string | null>(null);
  /** A transaction id, 'new' for a blank form, or null. */
  const [selTxn, setSelTxn] = useState<string | null>(null);
  const [lineSelection, setLineSelection] = useState<{ id: string; month: string } | null>(null);
  const selLine = lineSelection?.month === budgetMonth ? lineSelection.id : null;
  const selectLine = (id: string) => setLineSelection({ id, month: budgetMonth });
  /** The Budget's category pie: one category's groups, or null for all (the phone's `view`). */
  const [budgetCat, setBudgetCat] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  const txns = useMemo(() => live(store.txns), [store.txns]);
  const accounts = useMemo(() => live(store.accounts), [store.accounts]);
  const categories = useMemo(() => live(store.categories), [store.categories]);
  const balances = useMemo(() => accountBalances(accounts, txns), [accounts, txns]);
  const start = budgetStart(store);
  const sheet = useMemo(
    () => budgetSheet(store, budgetMonth, start),
    [store, budgetMonth, start],
  );

  // A filtered-away or deleted account falls back to all of them.
  const shownAccount = account !== null && accounts.some((a) => a.id === account) ? account : null;
  const firstAccount = shownAccount ?? accounts[0]?.id ?? '';

  const closeDetail = useCallback(() => { setSelTxn(null); setLineSelection(null); }, []);
  useEffect(() => {
    if (Platform.OS !== 'web') return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeDetail(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeDetail]);

  const goTab = (t: Tab) => { closeDetail(); onTab(t); };
  const goAccount = (id: string | null) => { closeDetail(); setAccount(id); onTab('transactions'); };

  /* ---------------- transactions ---------------- */
  const editing = selTxn !== null && selTxn !== 'new' ? txns.find((t) => t.id === selTxn) ?? null : null;
  const saveTxn = (draft: Draft, cleared: boolean, changed: ReadonlySet<keyof Draft | 'cleared'>) => {
    if (readOnly) return;
    const now = Date.now();
    if (editing !== null) {
      // Only what the person changed in the form, written onto the record as it
      // is NOW (`editing` is re-read from the store each render): a Cleared tick
      // made in the table while this was open must not be reverted by a rename.
      const patch: Partial<Draft> = {};
      for (const k of Object.keys(draft) as (keyof Draft)[]) {
        if (changed.has(k)) (patch as Record<string, unknown>)[k] = draft[k];
      }
      let t = applyDraft(editing, { ...draftOf(editing), ...patch }, now);
      if (changed.has('cleared') && (t.cleared === true) !== cleared) t = setCleared(t, cleared, now);
      commit(updateTxn(store, t));
    } else {
      let t = makeTxn(draft, `txn-${newId()}`, now);
      if (cleared) t = setCleared(t, true, now);
      commit(addTxn(store, t));
    }
    closeDetail();
  };
  const deleteTxn = (t: Txn) => {
    if (readOnly) return;
    commit(updateTxn(store, tombstone(t, Date.now())));
    closeDetail();
  };
  const quickAdd = (draft: Draft) => {
    if (readOnly) return;
    commit(addTxn(store, makeTxn(draft, `txn-${newId()}`, Date.now())));
  };

  /* ---------------- budget lines ---------------- */
  const set = monthSet(budgetMonth);
  const lineRow = selLine === null ? null
    : sheet.groups.flatMap((g) => g.lines).find((l) => l.line.id === selLine) ?? null;
  const addLine = () => {
    if (readOnly) return;
    const cat = lineRow?.line.category ?? categories[0]?.id;
    if (cat === undefined) return;
    const now = Date.now();
    const siblings = live(store.lines).filter((l) => l.category === cat);
    const line = {
      id: `line-${newId()}`, name: 'New line', category: cat, budget: 0, needs: 0, snoozed: false,
      order: siblings.reduce((n, l) => Math.max(n, l.order), 0) + REORDER_GAP, created: now, updated: now,
    };
    commit(putLine(store, line));
    selectLine(line.id);
  };
  const saveLine = (edit: LineEdit) => {
    if (readOnly || lineRow === null) return;
    const now = Date.now();
    const line = lineRow.line;
    let next = putLine(store, touch({
      ...line, name: edit.name, needs: edit.target, category: edit.category,
    }, now));
    if (edit.allocated !== lineRow.allocated) {
      next = { ...next, budgets: putBudget(next, set, line.id, edit.allocated, now) };
    }
    if (edit.snoozed !== lineRow.snoozed) {
      next = { ...next, settings: putSnooze(next, set, line.id, edit.snoozed, now) };
    }
    commit(next);
    closeDetail();
  };
  const deleteLine = () => {
    if (readOnly || lineRow === null) return;
    commit(putLine(store, tombstone(lineRow.line, Date.now())));
    closeDetail();
  };

  /* ---------------- panes ---------------- */
  let detail: React.ReactNode = null;
  if (tab === 'transactions' && selTxn !== null && (selTxn === 'new' ? !readOnly : editing !== null)) {
    detail = (
      <TxnEditor
        key={selTxn} txn={editing} account={firstAccount} readOnly={readOnly} accounts={accounts}
        categories={categories} lines={choices} rules={rules} mode={mode}
        onSave={saveTxn} onDelete={deleteTxn} onClose={closeDetail}
      />
    );
  } else if (tab === 'budget' && lineRow !== null) {
    const group = categories.find((c) => c.id === lineRow.line.category);
    detail = (
      <LinePane
        key={lineRow.line.id} row={lineRow} groupName={group?.name ?? ''} categories={categories}
        spending={sheet.spending(lineRow.line.id)} readOnly={readOnly}
        onSave={saveLine} onDelete={deleteLine} onClose={closeDetail}
        onOpenTxn={(t) => { setAccount(null); onTab('transactions'); setLineSelection(null); setSelTxn(t.id); }}
      />
    );
  }

  /* ---------------- sidebar ---------------- */
  const c = WIDE_COLORS;
  const sidebar = (
    <>
      <SidebarTitle title="AcctMind" colors={c} />
      <Text style={styles.sync} numberOfLines={2} testID="wide-sync">{syncLine(info, Date.now())}</Text>
      <View style={styles.gap} />
      <SidebarItem label="Budget" active={tab === 'budget'} onPress={() => goTab('budget')} colors={c} testID="wide-nav-budget" />
      <SidebarItem label="Transactions" active={tab === 'transactions'} onPress={() => goAccount(shownAccount)} colors={c} testID="wide-nav-transactions" />
      <SidebarItem label="Reports" active={tab === 'reports'} onPress={() => goTab('reports')} colors={c} testID="wide-nav-reports" />
      <SidebarLabel label="Accounts" colors={c} />
      <SidebarItem
        label="All accounts" count={formatAmount(balances.all)} colors={c} testID="wide-account-all"
        active={tab === 'transactions' && shownAccount === null} onPress={() => goAccount(null)}
      />
      {balances.rows.map(({ account: a, balance }) => (
        <SidebarItem
          key={a.id} label={a.name || 'Untitled'} count={formatAmount(balance)} colors={c} testID={`wide-account-${a.id}`}
          leading={<Dot colors={[a.color]} size={10} />}
          active={tab === 'transactions' && shownAccount === a.id} onPress={() => goAccount(a.id)}
        />
      ))}
      <SidebarLabel label="More" colors={c} />
      {!readOnly && <SidebarItem label="Import from CSV" onPress={actions.onImport} colors={c} testID="wide-more-import" />}
      <SidebarItem label="Export budget" onPress={actions.onExport} colors={c} testID="wide-more-export" />
      {!readOnly && <SidebarItem label="Categories" onPress={() => actions.onManage('categories')} colors={c} testID="wide-more-categories" />}
      {!readOnly && <SidebarItem label="Auto-categorize rules" onPress={actions.onMatch} colors={c} testID="wide-more-match" leading={<View style={{ width: 14 }} />} />}
      {!readOnly && <SidebarItem label="Accounts" onPress={() => actions.onManage('accounts')} colors={c} testID="wide-more-accounts" />}
    </>
  );

  const shownCat = budgetCat !== null && categories.some((x) => x.id === budgetCat) ? budgetCat : null;
  const content = tab === 'reports' ? <WideReports store={store} banner={banner} /> : tab === 'budget' ? (
    <WideBudget
      groups={shownCat === null ? sheet.groups : sheet.groups.filter((g) => g.category.id === shownCat)} totals={sheet} budgetMonth={budgetMonth} onMonth={(m) => { closeDetail(); onBudgetMonth(m); }}
      selectedId={selLine} readOnly={readOnly} banner={banner} onSelect={selectLine} onAddLine={addLine}
    />
  ) : (
    <WideTransactions
      txns={txns} accounts={accounts} account={shownAccount} choices={choices} rules={rules} mode={mode}
      selectedId={selTxn} readOnly={readOnly} banner={banner} quickAccount={firstAccount}
      onSelect={(t) => setSelTxn(t.id)}
      onCleared={(t, v) => { if (!readOnly) commit(updateTxn(store, setCleared(t, v, Date.now()))); }}
      onQuickAdd={quickAdd} onNew={() => setSelTxn('new')}
    />
  );

  const picker = tab === 'reports' ? undefined : (
    <SectionPick
      compact
      label={tab === 'budget' ? 'Categories' : 'Accounts'}
      sections={(tab === 'budget' ? categories : accounts).map((x) => ({ id: x.id, name: x.name, color: x.color }))}
      value={tab === 'budget' ? shownCat : shownAccount}
      onPick={(id) => { if (tab === 'budget') { closeDetail(); setBudgetCat(id); } else goAccount(id); }}
      visible={picking}
      onOpen={() => setPicking(true)}
      onClose={() => setPicking(false)}
      onManage={readOnly ? undefined : () => actions.onManage(tab === 'budget' ? 'categories' : 'accounts')}
    />
  );
  const title = tab === 'reports' ? 'Reports' : tab === 'budget' ? 'Budget' : 'Transactions';
  const main = (
    <View style={styles.main}>
      <TopBar title={title} titleTestID="wide-title" picker={picker} menu={menu} />
      {content}
    </View>
  );

  return <WideFrame sidebar={sidebar} main={main} detail={detail} onCloseDetail={closeDetail} colors={c} />;
}

const styles = StyleSheet.create({
  main: { flex: 1, minHeight: 0 },
  sync: { color: T.dim, fontSize: 12, paddingHorizontal: 8, lineHeight: 16, marginTop: -6 },
  gap: { height: 10 },
});
