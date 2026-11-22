/**
 * The wide Budget screen: ONE compact totals line (Unassigned, Overspent,
 * Short of target) and the category groups with their lines — Target,
 * Allocated, Spent, Remaining (tinted by core's `lineTone`) and a Snooze box.
 *
 * The owner, 2026-11-21: "the status tab is overkill.. just a snooze check
 * mark column and lightly color the available amount to indicate status
 * instead". So there is no Status column: the tone is the Remaining amount's
 * text colour, and snoozing is a box per line for the month on screen.
 */
import { useContext } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { formatAmount, monthLabel, type LineTone, type SheetGroup, type SheetLine } from '@acctmind/core';
import { Dot } from '../Dot';
import { T } from '../theme';
import { Btn, CHECK, SELECTED_ROW } from './shared';
import { SnoozeLineContext, type SnoozeLine } from './snooze';

/**
 * Widest the column (month row, totals, table) grows: about 396 for the line
 * name plus the five fixed columns. A wider pane centres it.
 */
const TABLE_MAX = 900;
const W = { target: 92, alloc: 96, spent: 92, rem: 96, snooze: 56 } as const;

/**
 * Remaining's text colour per tone — the one place it is decided. LIGHT tints
 * (text only, no pill or ground), each readable on the dark rows and on the
 * selected row: funded a soft green, short a soft amber, over a soft red,
 * snoozed the dim grey every "not asking" thing on these screens wears.
 */
const REMAINING_TONE: Record<LineTone, string> = {
  funded: '#7be39a',
  short: '#f0c25a',
  over: '#ff8a82',
  snoozed: T.dim,
};

const month = (m: string) => monthLabel(`${m}-01`);
const step = (m: string, by: number) => {
  const n = Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1 + by;
  return `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, '0')}`;
};

export function WideBudget({
  groups, totals, budgetMonth, onMonth, selectedId, readOnly, onSelect, onAddLine,
}: {
  groups: readonly SheetGroup[];
  totals: { unassigned: number; overspent: number; short: number };
  budgetMonth: string;
  onMonth: (m: string) => void;
  selectedId: string | null;
  readOnly: boolean;
  onSelect: (lineId: string) => void;
  onAddLine: () => void;
}) {
  const snooze = useContext(SnoozeLineContext);
  return (
    <View style={styles.fill} testID="wide-budget">
      {/*
        One centred column, capped: the month row, the totals and the table
        share its edges, so "+ Line" ends where the Snooze column does and the
        numbers sit a reading distance after the names at any window width.
        The title is the top bar's (WideApp): the month and its arrows lead the row.
      */}
      <View style={styles.col} testID="wide-col">
      <View style={styles.head} testID="wide-head">
        <Pressable onPress={() => onMonth(step(budgetMonth, -1))} accessibilityRole="button" accessibilityLabel="Previous month" style={styles.step} testID="wide-month-prev">
          <Text style={styles.stepText}>‹</Text>
        </Pressable>
        <Text style={styles.month} testID="wide-month">{month(budgetMonth)}</Text>
        <Pressable onPress={() => onMonth(step(budgetMonth, 1))} accessibilityRole="button" accessibilityLabel="Next month" style={styles.step} testID="wide-month-next">
          <Text style={styles.stepText}>›</Text>
        </Pressable>
        <View style={styles.grow} />
        {!readOnly && <Btn label="+ Line" onPress={onAddLine} testID="wide-add-line" />}
      </View>

      <View style={styles.totals} testID="wide-totals">
        <Text style={styles.total}><Text style={styles.dim}>Unassigned </Text><Text style={[styles.b, totals.unassigned < 0 && styles.neg]}>{formatAmount(totals.unassigned)}</Text></Text>
        <Text style={styles.total}><Text style={styles.dim}>Overspent </Text><Text style={[styles.b, totals.overspent > 0 && styles.neg]}>{formatAmount(totals.overspent)}</Text></Text>
        <Text style={styles.total}><Text style={styles.dim}>Short of target </Text><Text style={styles.b} testID="wide-short">{formatAmount(totals.short)}</Text></Text>
      </View>

      <View style={styles.table} testID="wide-table">
      <View style={[styles.row, styles.thead]}>
        <Text style={[styles.th, styles.grow]}>Line</Text>
        <Text style={[styles.th, styles.num, { width: W.target }]}>Target</Text>
        <Text style={[styles.th, styles.num, { width: W.alloc }]}>Allocated</Text>
        <Text style={[styles.th, styles.num, { width: W.spent }]}>Spent</Text>
        <Text style={[styles.th, styles.num, { width: W.rem }]} testID="wide-th-remaining">Remaining</Text>
        <Text style={[styles.th, styles.center, { width: W.snooze }]} testID="wide-th-snooze">Snooze</Text>
      </View>
      <ScrollView style={styles.grow}>
        {groups.map((g) => (
          <View key={g.category.id}>
            <View style={styles.group} testID={`wide-group-${g.category.id}`}>
              <Dot colors={[g.category.color]} size={10} />
              <Text style={styles.groupText}>{g.category.name || 'Untitled'}</Text>
            </View>
            {g.lines.map((l) => (
                <Pressable
                  key={l.line.id} onPress={() => onSelect(l.line.id)} accessibilityRole="button"
                  style={[styles.row, styles.trow, l.line.id === selectedId && { backgroundColor: SELECTED_ROW }]}
                  testID="wide-line"
                >
                  <Text style={[styles.td, styles.grow, styles.indent]} numberOfLines={1}>{l.line.name}</Text>
                  <Text style={[styles.td, styles.dim, styles.num, { width: W.target }]}>{formatAmount(l.target)}</Text>
                  <Text style={[styles.td, styles.num, { width: W.alloc }]}>{formatAmount(l.allocated)}</Text>
                  <Text style={[styles.td, styles.num, { width: W.spent }]}>{formatAmount(l.spent)}</Text>
                  <Text style={[styles.td, styles.num, { width: W.rem, color: REMAINING_TONE[l.tone] }]} testID="wide-line-remaining">
                    {formatAmount(l.remaining)}
                  </Text>
                  <View style={[styles.mid, { width: W.snooze }]}>
                    <SnoozeBox row={l} month={month(budgetMonth)} snooze={readOnly ? null : snooze} />
                  </View>
                </Pressable>
            ))}
            {g.lines.length === 0 && <Text style={[styles.dim, styles.indent, styles.none]}>No lines</Text>}
          </View>
        ))}
      </ScrollView>
      </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, minHeight: 0 },
  grow: { flex: 1, minWidth: 0 },
  col: { flex: 1, minHeight: 0, width: '100%', maxWidth: TABLE_MAX, alignSelf: 'center' },
  table: { flex: 1, minHeight: 0 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingTop: 0, paddingBottom: 10 },
  month: { color: T.text, fontSize: 15, fontWeight: '500', minWidth: 120, textAlign: 'center' },
  step: { width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: T.faint },
  stepText: { color: T.text, fontSize: 18 },
  totals: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 22, rowGap: 2, paddingHorizontal: 16, paddingBottom: 10 },
  total: { fontSize: 14, color: T.text, fontVariant: ['tabular-nums'] },
  b: { fontWeight: '600', color: T.text },
  neg: { color: T.danger },
  dim: { color: T.dim },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 8 },
  thead: { borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: T.cardEdge, paddingVertical: 6 },
  th: { color: T.dim, fontSize: 12, fontWeight: '500' },
  num: { textAlign: 'right', fontVariant: ['tabular-nums'] },
  group: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 7, backgroundColor: T.card },
  groupText: { color: T.text, fontSize: 13, fontWeight: '600' },
  trow: { minHeight: 38, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: T.lineSoft },
  td: { color: T.text, fontSize: 14 },
  indent: { paddingLeft: 18 },
  none: { paddingVertical: 8, fontSize: 13 },
  center: { textAlign: 'center' },
  mid: { alignItems: 'center', justifyContent: 'center', alignSelf: 'stretch' },
  // The box is the ledger's Cleared box (shared CHECK); the Pressable around
  // it is the cell's full height and width, so the target is not 18 px.
  hit: { alignSelf: 'stretch', flex: 1, alignItems: 'center', justifyContent: 'center' },
});

/**
 * One line's Snooze box for the month on screen. Click, Enter or Space flips
 * it. `snooze` null (read-only) draws what the ledger's read-only Cleared
 * column draws: no box, a ✓ or nothing.
 */
function SnoozeBox({ row, month: label, snooze }: { row: SheetLine; month: string; snooze: SnoozeLine | null }) {
  const on = row.snoozed;
  const name = `Snooze ${row.line.name || 'Untitled'} for ${label}`;
  if (snooze === null) {
    return (
      <View style={styles.hit} accessibilityRole="checkbox" aria-checked={on} aria-disabled
        accessibilityLabel={name} testID="wide-line-snooze">
        <Text style={CHECK.tick}>{on ? '✓' : ''}</Text>
      </View>
    );
  }
  const flip = () => snooze(row.line.id, !on);
  // RNW's Pressable answers Enter for any role but Space only for a button,
  // and a checkbox is toggled with Space, so Space is handled here. The row
  // around the box is a native <button>: Enter's default action would click
  // it too (opening the line), and Space's would scroll the page.
  const web = Platform.OS === 'web' ? {
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); return; }   // RNW presses on keyup
      if (e.key !== ' ' && e.key !== 'Spacebar') return;
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) flip();
    },
  } : {};
  return (
    <Pressable
      // aria-checked, not accessibilityState: react-native-web 0.21 no longer
      // maps the latter, so the box's state never reached the page.
      onPress={flip} accessibilityRole="checkbox" aria-checked={on}
      accessibilityLabel={name} style={styles.hit} testID="wide-line-snooze"
      {...web}
    >
      <View style={[CHECK.box, on && CHECK.boxOn]}>
        {on && <Text style={CHECK.boxTick}>✓</Text>}
      </View>
    </Pressable>
  );
}
