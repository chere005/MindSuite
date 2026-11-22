/**
 * The detail pane for one transaction: the phone's form (Name, Amount with the
 * minus toggle, Date, Account, Category, Description, Cleared) at normal
 * control sizes, Delete on the left and Cancel / Save on the right. Read-only
 * mode shows the same facts as text.
 */
import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  formatAmount, formatDay, INCOME, INCOME_NAME,
  type Account, type AmountMode, type Category, type CategoryChoice, type CategoryRule, type Draft, type Txn,
} from '@acctmind/core';
import { useTxnForm } from '../TransactionForm';
import { T } from '../theme';
import { Btn, Fact, PaneHead } from './shared';

export function TxnEditor({
  txn, account, readOnly, accounts, categories, lines, rules, mode, onSave, onDelete, onClose,
}: {
  /** The row being edited, or null for a new transaction. */
  txn: Txn | null;
  /** The account a new one starts in. */
  account: string;
  readOnly: boolean;
  accounts: readonly Account[];
  categories: readonly Category[];
  lines: readonly CategoryChoice[];
  rules: readonly CategoryRule[];
  mode: AmountMode;
  onSave: (draft: Draft, cleared: boolean, changed: ReadonlySet<keyof Draft | 'cleared'>) => void;
  onDelete: (txn: Txn) => void;
  onClose: () => void;
}) {
  const form = useTxnForm({
    active: true, onSave, editing: txn ?? undefined, mode, account, categories, lines, rules, accounts,
  });
  const [armed, setArmed] = useState(false);
  const fuse = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(fuse.current), []);

  if (readOnly) {
    if (txn === null) return null;
    const nameOf = (id: string | null) => id === INCOME ? INCOME_NAME : lines.find((l) => l.id === id)?.name ?? 'Uncategorized';
    const acct = accounts.find((a) => a.id === txn.account);
    return (
      <View style={styles.fill} testID="txn-detail-readonly">
        <PaneHead title="Transaction" onClose={onClose} />
        <ScrollView contentContainerStyle={styles.body}>
          <Fact label="Name">{txn.name}</Fact>
          <Fact label="Amount">{formatAmount(txn.amount)}</Fact>
          <Fact label="Date">{formatDay(txn.date)}</Fact>
          <Fact label="Account">{acct?.name ?? '—'}</Fact>
          {txn.splits === undefined ? (
            <Fact label="Category">{nameOf(txn.category)}</Fact>
          ) : (
            // A split, read-only: each part on its own line, as filed.
            <Fact label="Split">
              {txn.splits.map((p, i) => `${i > 0 ? '\n' : ''}${nameOf(p.category)}  ${formatAmount(p.amount)}`).join('')}
            </Fact>
          )}
          {txn.description !== '' && <Fact label="Description">{txn.description}</Fact>}
          <Fact label="Cleared">{txn.cleared === true ? 'Yes' : 'No'}</Fact>
          <Text style={styles.note}>Read-only here. Edit this on your iPhone or in the AcctMind Mac app.</Text>
        </ScrollView>
      </View>
    );
  }

  const del = () => {
    if (txn === null) return;
    if (!armed) {
      setArmed(true);
      fuse.current = setTimeout(() => setArmed(false), 2500);
      return;
    }
    onDelete(txn);
  };

  return (
    <View style={styles.fill} testID="txn-detail">
      <PaneHead title={txn === null ? 'New transaction' : 'Transaction'} onClose={onClose} />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {form.wideFields}
        <View style={styles.actions}>
          {txn !== null ? <Btn label={armed ? 'Tap again to delete' : 'Delete'} danger onPress={del} testID="delete-button" /> : <View />}
          <View style={styles.right}>
            <Btn label="Cancel" onPress={onClose} testID="cancel-button" />
            <Btn label="Save" primary onPress={form.submit} testID="save-button" />
          </View>
        </View>
      </ScrollView>
      {form.dayPicker}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  body: { padding: 16, paddingTop: 4, gap: 14 },
  actions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 },
  right: { flexDirection: 'row', gap: 8 },
  note: { color: T.dim, fontSize: 13, marginTop: 8 },
});
