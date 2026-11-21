import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  EMPTY_TXN_FILTER, formatDay, today, validTxnDateRange,
  type Category, type CategoryChoice, type TxnFilter,
} from '@acctmind/core';
import { CategoryMenu, NO_CATEGORY } from './CategoryPick';
import { DayPicker } from './DayPicker';
import { XIcon } from './Icons';
import { SPACE, T, TAP } from './theme';

const DATES = [['from', 'From'], ['through', 'Through']] as const;
const STATUSES = [['any', 'Any status'], ['cleared', 'Cleared'], ['uncleared', 'Uncleared']] as const;

export function TransactionFilters({ value, categories, choices, onApply, onClose }: {
  value: TxnFilter;
  categories: readonly Category[];
  choices: readonly CategoryChoice[];
  onApply: (filter: TxnFilter) => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState(value);
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [date, setDate] = useState<'from' | 'through' | null>(null);
  const valid = validTxnDateRange(draft);
  const choice = choices.find((row) => row.id === draft.category);
  const group = categories.find((row) => row.id === choice?.category);
  const categoryName = draft.category === undefined ? 'Any category' : draft.category === null ? NO_CATEGORY
    : choice === undefined ? 'Unavailable category'
    : group ? `${group.name} / ${choice.name}` : choice.name;

  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <View style={[styles.backdrop, { paddingTop: insets.top + SPACE.lg, paddingBottom: insets.bottom + SPACE.lg }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityElementsHidden />
        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.title} accessibilityRole="header" testID="txn-filters-title">Filters</Text>
            <Pressable onPress={onClose} style={styles.button} accessibilityRole="button" testID="txn-filters-cancel">
              <Text style={styles.secondary}>Cancel</Text>
            </Pressable>
          </View>
          <ScrollView style={styles.scroll} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
            <Text style={styles.label}>Category</Text>
            <Pressable
              onPress={() => setCategoryOpen(true)}
              style={styles.category}
              accessibilityRole="button"
              accessibilityLabel={`Category, ${categoryName}`}
              testID="txn-filter-category"
            >
              <Text style={styles.value} numberOfLines={1}>{categoryName}</Text>
              <Text style={styles.secondary}>⌄</Text>
            </Pressable>
            <Text style={styles.label}>Date range</Text>
            <View style={styles.columns}>
              {DATES.map(([key, label]) => (
                <View key={key} style={styles.boundary}>
                  <Text style={styles.label}>{label}</Text>
                  <View style={styles.dateRow}>
                    <Pressable
                      onPress={() => setDate(key)}
                      style={styles.date}
                      accessibilityRole="button"
                      accessibilityLabel={`${label}, ${draft[key] ?? 'any date'}`}
                      testID={`txn-filter-${key}`}
                    >
                      <Text style={styles.value} numberOfLines={1}>{draft[key] ? formatDay(draft[key]) : 'Any date'}</Text>
                    </Pressable>
                    {draft[key] !== null && (
                      <Pressable
                        onPress={() => setDraft((current) => ({ ...current, [key]: null }))}
                        style={styles.clearDate}
                        accessibilityRole="button"
                        accessibilityLabel={`Clear ${label.toLowerCase()} date`}
                      >
                        <XIcon color={T.dim} size={12} />
                      </Pressable>
                    )}
                  </View>
                </View>
              ))}
            </View>
            {!valid && <Text style={styles.error} accessibilityRole="alert">Choose an end date on or after the start date.</Text>}
            <Text style={styles.label}>Cleared status</Text>
            <View style={styles.columns}>
              {STATUSES.map(([status, label]) => (
                <Pressable
                  key={status}
                  onPress={() => setDraft((current) => ({ ...current, status }))}
                  style={[styles.status, draft.status === status && styles.selected]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: draft.status === status }}
                  testID={`txn-filter-status-${status}`}
                >
                  <Text style={[styles.statusText, draft.status === status && styles.statusOn]}>{label}</Text>
                </Pressable>
              ))}
            </View>
          </ScrollView>
          <View style={styles.footer}>
            <Pressable
              onPress={() => setDraft({ ...EMPTY_TXN_FILTER, query: value.query })}
              style={styles.button}
              accessibilityRole="button"
              testID="txn-filters-reset"
            >
              <Text style={styles.secondary}>Reset</Text>
            </Pressable>
            <Pressable
              onPress={() => onApply(draft)}
              disabled={!valid}
              style={styles.button}
              accessibilityRole="button"
              testID="txn-filters-apply"
            >
              <Text style={[styles.primary, !valid && styles.disabled]}>Apply</Text>
            </Pressable>
          </View>
        </View>
      </View>
      {categoryOpen && (
        <CategoryMenu
          categories={categories}
          lines={choices}
          onPick={(category) => setDraft((current) => ({ ...current, category }))}
          onPickAny={() => setDraft((current) => ({ ...current, category: undefined }))}
          onClose={() => setCategoryOpen(false)}
        />
      )}
      {date !== null && (
        <DayPicker
          visible
          value={draft[date] ?? draft.from ?? draft.through ?? today()}
          onPick={(day) => {
            setDraft((current) => ({ ...current, [date]: day }));
            setDate(null);
          }}
          onCancel={() => setDate(null)}
        />
      )}
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#00000088', paddingHorizontal: SPACE.md },
  card: { width: '100%', maxWidth: 420, maxHeight: '100%', borderRadius: 16, overflow: 'hidden', backgroundColor: T.card },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: SPACE.md },
  title: { color: T.text, fontSize: 20, fontWeight: '700' },
  button: { minHeight: TAP, justifyContent: 'center', paddingHorizontal: SPACE.sm },
  primary: { color: T.accent, fontWeight: '700', fontSize: 16 },
  secondary: { color: T.dim, fontSize: 15 },
  disabled: { color: T.faint },
  scroll: { flexGrow: 0, flexShrink: 1 },
  body: { padding: SPACE.md, gap: SPACE.sm },
  label: { color: T.dim, fontSize: 13 },
  category: {
    flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: TAP,
    backgroundColor: T.bg, paddingHorizontal: SPACE.sm, borderRadius: 8,
  },
  value: { flexShrink: 1, color: T.text, fontSize: 15 },
  columns: { flexDirection: 'row', gap: SPACE.sm },
  boundary: { flex: 1, minWidth: 0, gap: SPACE.xs },
  dateRow: { flexDirection: 'row', alignItems: 'center', borderRadius: 8, backgroundColor: T.bg },
  date: { flex: 1, minHeight: TAP, justifyContent: 'center', paddingLeft: SPACE.sm },
  clearDate: { width: TAP, height: TAP, alignItems: 'center', justifyContent: 'center' },
  error: { color: T.danger, fontSize: 13 },
  status: { flex: 1, minHeight: TAP, borderRadius: 8, backgroundColor: T.bg, justifyContent: 'center', alignItems: 'center' },
  selected: { backgroundColor: T.accent },
  statusText: { color: T.text, fontSize: 14 },
  statusOn: { color: '#fff', fontWeight: '600' },
  footer: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: SPACE.md },
});
