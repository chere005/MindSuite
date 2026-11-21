/**
 * The wide Budget screen: ONE compact totals line (Unassigned, Overspent,
 * Short of target) and the category groups with their lines — Target,
 * Allocated, Spent, Remaining and a status pill from core's `lineTone`.
 */
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { formatAmount, monthLabel, type LineTone, type SheetGroup } from '@acctmind/core';
import { Dot } from '../Dot';
import { T } from '../theme';
import { Btn, SELECTED_ROW } from './shared';

const W = { target: 92, alloc: 96, spent: 92, rem: 96, status: 76 } as const;

const TONE: Record<LineTone, { label: string; bg: string; fg: string }> = {
  funded: { label: 'Funded', bg: 'rgba(48,209,88,0.18)', fg: '#7be39a' },
  short: { label: 'Short', bg: 'rgba(240,180,41,0.18)', fg: '#f0c25a' },
  over: { label: 'Over', bg: 'rgba(255,69,58,0.2)', fg: '#ff8a82' },
  snoozed: { label: 'Snoozed', bg: 'rgba(142,142,147,0.2)', fg: T.dim },
};

const month = (m: string) => monthLabel(`${m}-01`);
const step = (m: string, by: number) => {
  const n = Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1 + by;
  return `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, '0')}`;
};

export function WideBudget({
  groups, totals, budgetMonth, onMonth, selectedId, readOnly, banner, onSelect, onAddLine,
}: {
  groups: readonly SheetGroup[];
  totals: { unassigned: number; overspent: number; short: number };
  budgetMonth: string;
  onMonth: (m: string) => void;
  selectedId: string | null;
  readOnly: boolean;
  banner: React.ReactNode;
  onSelect: (lineId: string) => void;
  onAddLine: () => void;
}) {
  return (
    <View style={styles.fill} testID="wide-budget">
      {banner}
      <View style={styles.head}>
        <Text style={styles.h1} testID="wide-title">Budget</Text>
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
        <Text style={styles.total}><Text style={styles.dim}>Short of target </Text><Text style={styles.b}>{formatAmount(totals.short)}</Text></Text>
      </View>

      <View style={[styles.row, styles.thead]}>
        <Text style={[styles.th, styles.grow]}>Line</Text>
        <Text style={[styles.th, styles.num, { width: W.target }]}>Target</Text>
        <Text style={[styles.th, styles.num, { width: W.alloc }]}>Allocated</Text>
        <Text style={[styles.th, styles.num, { width: W.spent }]}>Spent</Text>
        <Text style={[styles.th, styles.num, { width: W.rem }]}>Remaining</Text>
        <Text style={[styles.th, { width: W.status }]}>Status</Text>
      </View>
      <ScrollView style={styles.grow}>
        {groups.map((g) => (
          <View key={g.category.id}>
            <View style={styles.group} testID={`wide-group-${g.category.id}`}>
              <Dot colors={[g.category.color]} size={10} />
              <Text style={styles.groupText}>{g.category.name || 'Untitled'}</Text>
            </View>
            {g.lines.map((l) => {
              const tone = TONE[l.tone];
              return (
                <Pressable
                  key={l.line.id} onPress={() => onSelect(l.line.id)} accessibilityRole="button"
                  style={[styles.row, styles.trow, l.line.id === selectedId && { backgroundColor: SELECTED_ROW }]}
                  testID="wide-line"
                >
                  <Text style={[styles.td, styles.grow, styles.indent]} numberOfLines={1}>{l.line.name}</Text>
                  <Text style={[styles.td, styles.dim, styles.num, { width: W.target }]}>{formatAmount(l.target)}</Text>
                  <Text style={[styles.td, styles.num, { width: W.alloc }]}>{formatAmount(l.allocated)}</Text>
                  <Text style={[styles.td, styles.num, { width: W.spent }]}>{formatAmount(l.spent)}</Text>
                  <Text style={[styles.td, styles.num, l.remaining < 0 && styles.neg, { width: W.rem }]}>{formatAmount(l.remaining)}</Text>
                  <View style={{ width: W.status }}>
                    <View style={[styles.pill, { backgroundColor: tone.bg }]} testID="wide-tone">
                      <Text style={[styles.pillText, { color: tone.fg }]}>{tone.label}</Text>
                    </View>
                  </View>
                </Pressable>
              );
            })}
            {g.lines.length === 0 && <Text style={[styles.dim, styles.indent, styles.none]}>No lines</Text>}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, minHeight: 0 },
  grow: { flex: 1, minWidth: 0 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 10 },
  h1: { color: T.text, fontSize: 20, fontWeight: '600' },
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
  pill: { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10 },
  pillText: { fontSize: 12, fontWeight: '500' },
});
