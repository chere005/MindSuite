/**
 * Which budget LINE a transaction belongs to — a dropdown you can type into.
 *
 * It picked a category until v4, when the money moved down a level: a
 * category is a heading now and a line is what actually holds a budget, so a
 * line is what a transaction has to be filed against. The rows are grouped
 * under their category, because two lines called `Coffee` in different
 * categories are a real thing to have and a list that showed both without
 * saying which is which would be unusable.
 *
 * The filter is the point. A ledger grows lines faster than anything else in
 * it, and a list of forty is a list nobody scrolls; typing three letters is
 * how a person picks the one they already have in mind. Matching is
 * case-insensitive and on a SUBSTRING, not a prefix, because people remember
 * "groceries" out of "Food & groceries".
 */
import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { INCOME, INCOME_NAME, filterByName, type Category, type CategoryChoice } from '@acctmind/core';
import { Dot } from './Dot';
import { SPACE, T, TAP } from './theme';

/** What an unfiled transaction reads as — the Budget tab's word for it too. */
export const NO_CATEGORY = 'No Category';

export function CategoryPick({ categories, lines, value, onPick, allowNone = true, compact = false }: {
  categories: readonly Category[];
  lines: readonly CategoryChoice[];
  value: string | null;
  onPick: (id: string | null) => void;
  allowNone?: boolean;
  /** The wide detail pane's size: the same 14 point value as its Account field. */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const line = lines.find((l) => l.id === value) ?? null;
  const chosen = value === INCOME ? { name: INCOME_NAME, color: T.positive }
    : line === null ? null
    : { name: line.name, color: categories.find((c) => c.id === line.category)?.color ?? T.faint };

  const label = chosen?.name ?? (allowNone ? NO_CATEGORY : 'Category');
  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        style={[styles.field, compact && styles.fieldCompact]}
        accessibilityRole="button"
        accessibilityLabel={label}
        testID="category-button"
      >
        {chosen !== null && <Dot colors={[chosen.color]} size={12} />}
        <Text style={[styles.value, compact && styles.valueCompact, chosen === null && styles.none]} numberOfLines={1} testID="category-value">
          {label}
        </Text>
        <Text style={styles.chev}>⌄</Text>
      </Pressable>

      {open && (
        <CategoryMenu
          categories={categories}
          lines={lines}
          allowNone={allowNone}
          onPick={onPick}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/**
 * The dropdown on its own, for a caller that draws its own trigger.
 *
 * The owner, 2026-09-25: "clicking the category in the row brings a dropdown to
 * select category". The ledger row's category word IS the trigger there, so
 * the list the add form opens is split out rather than drawn twice — one
 * filter, one "No Category" that is never filtered away, one grouping, on
 * both paths. Mounted only while open, so the filter starts empty each time.
 */
export function CategoryMenu({ categories, lines, onPick, onClose, onPickAny, allowNone = true }: {
  categories: readonly Category[];
  lines: readonly CategoryChoice[];
  onPick: (id: string | null) => void;
  onClose: () => void;
  onPickAny?: () => void;
  allowNone?: boolean;
}) {
  const [query, setQuery] = useState('');
  const insets = useSafeAreaInsets();
  const shown = filterByName(lines, query);
  const pick = (id: string | null) => { onClose(); onPick(id); };

  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      {/* Its own window: the app's safe area does not reach in here. */}
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={[styles.menu, { marginTop: insets.top + SPACE.xl }]} onPress={() => {}}>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Filter"
            placeholderTextColor={T.faint}
            autoFocus
            autoCorrect={false}
            style={styles.search}
            testID="category-filter"
          />
          <ScrollView keyboardShouldPersistTaps="handled">
            {onPickAny && (
              <Pressable onPress={() => { onClose(); onPickAny(); }} style={styles.row} testID="category-any">
                <Text style={styles.rowText}>Any category</Text>
              </Pressable>
            )}
            {/* Keep the option to clear a transaction available during filtering. */}
            {allowNone && (
              <Pressable onPress={() => pick(null)} style={styles.row} testID="category-none">
                <Text style={[styles.rowText, styles.none]}>{NO_CATEGORY}</Text>
              </Pressable>
            )}
            {shown.map((choice) => {
              const income = choice.id === INCOME;
              const group = categories.find((c) => c.id === choice.category);
              return (
                <Pressable
                  key={choice.id}
                  onPress={() => pick(choice.id)}
                  style={styles.row}
                  testID={income ? 'category-income' : `category-opt-${choice.id}`}
                >
                  <Dot colors={[income ? T.positive : group?.color ?? T.faint]} size={12} />
                  <Text style={styles.rowText} numberOfLines={1}>{choice.name}</Text>
                  {group && <Text style={styles.rowGroup} numberOfLines={1}>{group.name}</Text>}
                </Pressable>
              );
            })}
            {shown.length === 0 && (
              <Text style={styles.nothing} testID="category-nomatch">
                Nothing matches “{query.trim()}”.
              </Text>
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  field: {
    flexDirection: 'row', alignItems: 'center', gap: SPACE.sm,
    // T.card with a hairline, matching `styles.input` in AddTransaction.
    // It was T.field — pure black, no border — so on the one form that shows
    // all four boxes at once, Category was visibly a different control from
    // Name, Description and Amount.
    minHeight: TAP, backgroundColor: T.card, borderRadius: 10,
    paddingHorizontal: SPACE.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: T.cardEdge,
  },
  value: { color: T.text, fontSize: 17, flex: 1 },
  fieldCompact: { minHeight: 36, borderRadius: 8 },
  valueCompact: { fontSize: 14, fontWeight: '400' },
  none: { color: T.dim },
  chev: { color: T.dim, fontSize: 13 },
  rowGroup: { color: T.gold, fontSize: 13, flexShrink: 0 },
  backdrop: { flex: 1, backgroundColor: '#00000088' },
  menu: {
    marginHorizontal: SPACE.lg, maxHeight: 380, borderRadius: 14,
    backgroundColor: T.card, borderWidth: StyleSheet.hairlineWidth, borderColor: T.cardEdge,
    overflow: 'hidden',
  },
  search: {
    minHeight: TAP, color: T.text, fontSize: 17, paddingHorizontal: SPACE.lg,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: T.cardEdge,
  },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: SPACE.md,
    minHeight: TAP, paddingHorizontal: SPACE.lg,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: T.cardEdge,
  },
  rowText: { color: T.text, fontSize: 16, flex: 1 },
  nothing: { color: T.dim, fontSize: 15, padding: SPACE.lg },
});
