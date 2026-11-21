import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { availableOf, formatAmount, formatDay, sortTxns, total, type Txn } from '@acctmind/core';
import { SPACE, T, TAP } from './theme';

const INITIAL_ROWS = 5;

export function SpendingPreview({ name, month, txns, budget, onClose }: {
  name: string;
  month: string;
  txns: readonly Txn[];
  budget?: { assigned: number; carry: number; toAssign: number | null; onAssign: () => void } | undefined;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [showAll, setShowAll] = useState(false);
  const spent = total(txns);
  const ordered = sortTxns(txns);
  const shown = showAll ? ordered : ordered.slice(0, INITIAL_ROWS);
  const amounts = budget === undefined ? [{ label: 'Spent', cents: spent }] : [
    { label: 'Carryover', cents: budget.carry },
    { label: 'Assigned', cents: budget.assigned },
    { label: 'Spent', cents: spent },
    { label: 'Available', cents: availableOf(budget.assigned, spent, budget.carry) },
  ];
  const toAssign = budget?.toAssign ?? null;
  const covered = toAssign !== null && toAssign === budget?.assigned;

  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <View style={[styles.backdrop, { paddingTop: insets.top + SPACE.lg, paddingBottom: insets.bottom + SPACE.lg }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityElementsHidden />
        <View style={styles.card}>
          <View style={styles.header}>
            <View style={styles.heading}>
              <Text style={styles.title} accessibilityRole="header" testID="spent-preview-title">{name}</Text>
              <Text style={styles.caption}>{month}</Text>
            </View>
            <Pressable style={styles.button} accessibilityRole="button" onPress={onClose} testID="spent-preview-close">
              <Text style={styles.action}>Done</Text>
            </Pressable>
          </View>
          <ScrollView style={styles.scroll} keyboardShouldPersistTaps="handled">
            <View style={styles.amounts}>
              {amounts.map(({ label, cents }) => (
                <View key={label} style={styles.amount}>
                  <Text style={styles.caption}>{label}</Text>
                  <Text style={styles.money} testID={`spent-preview-${label.toLowerCase()}`}>
                    {formatAmount(cents)}
                  </Text>
                </View>
              ))}
            </View>
            {budget && toAssign !== null && txns.length > 0 && (
              covered ? (
                <Text style={styles.covered} testID="spent-preview-covered">Spending covered</Text>
              ) : (
                <Pressable style={styles.assign} accessibilityRole="button" onPress={budget.onAssign} testID="spent-preview-assign">
                  <Text style={styles.action}>Set Assigned to {formatAmount(toAssign)}</Text>
                </Pressable>
              )
            )}
            {shown.map((txn) => (
              <View key={txn.id} style={styles.row} testID={`spent-preview-txn-${txn.id}`}>
                <View style={styles.heading}>
                  <Text style={styles.name} numberOfLines={1}>{txn.name}</Text>
                  <Text style={styles.caption}>{formatDay(txn.date)}</Text>
                </View>
                <Text style={styles.money}>{formatAmount(txn.amount)}</Text>
              </View>
            ))}
            {shown.length === 0 && <Text style={styles.empty}>No transactions this month</Text>}
            {!showAll && ordered.length > INITIAL_ROWS && (
              <Pressable style={styles.assign} accessibilityRole="button" onPress={() => setShowAll(true)}>
                <Text style={styles.action}>Show all {ordered.length} transactions</Text>
              </Pressable>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#00000088', paddingHorizontal: SPACE.md },
  card: { width: '100%', maxWidth: 450, maxHeight: '100%', backgroundColor: T.card, borderRadius: 16, overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md, paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm },
  heading: { flex: 1, minWidth: 0 },
  title: { color: T.text, fontSize: 20, fontWeight: '700' },
  caption: { color: T.dim, fontSize: 13 },
  action: { color: T.accent, fontSize: 15, fontWeight: '600' },
  button: { minHeight: TAP, paddingHorizontal: SPACE.sm, justifyContent: 'center' },
  scroll: { flexGrow: 0, flexShrink: 1 },
  amounts: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: SPACE.md, paddingBottom: SPACE.sm },
  amount: { width: '50%', gap: SPACE.xs, paddingTop: SPACE.sm },
  money: { color: T.text, fontSize: 15, fontVariant: ['tabular-nums'] },
  assign: { minHeight: TAP, justifyContent: 'center', paddingHorizontal: SPACE.md },
  covered: { color: T.positive, fontSize: 14, padding: SPACE.md },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: SPACE.md, padding: SPACE.md,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: T.cardEdge,
  },
  name: { color: T.text, fontSize: 15, marginBottom: SPACE.xs },
  empty: { color: T.dim, padding: SPACE.md },
});
