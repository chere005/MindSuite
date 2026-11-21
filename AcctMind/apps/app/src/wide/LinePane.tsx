/**
 * The detail pane for one budget line: name, group, target, allocated (the
 * phone's =/+/− amount), snooze, and this month's spending in the line.
 * Read-only mode shows the same as text.
 */
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { formatAmount, formatDay, parseAmount, amountInput, type Category, type SheetLine, type Txn } from '@acctmind/core';
import { OpAmount } from '../OpAmount';
import { T } from '../theme';
import { Btn, Fact, PaneHead } from './shared';

export type LineEdit = { name: string; category: string; target: number; allocated: number; snoozed: boolean };

export function LinePane({
  row, groupName, categories, spending, readOnly, onSave, onDelete, onClose, onOpenTxn,
}: {
  row: SheetLine;
  groupName: string;
  categories: readonly Category[];
  spending: readonly Txn[];
  readOnly: boolean;
  onSave: (edit: LineEdit) => void;
  onDelete: () => void;
  onClose: () => void;
  onOpenTxn: (txn: Txn) => void;
}) {
  const [name, setName] = useState(row.line.name);
  const [category, setCategory] = useState(row.line.category);
  const [target, setTarget] = useState(amountInput(row.target));
  const [allocated, setAllocated] = useState(row.allocated);
  const [snoozed, setSnoozed] = useState(row.snoozed);
  const [armed, setArmed] = useState(false);
  const fuse = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(fuse.current), []);

  const spentTotal = spending.reduce((n, t) => n + t.amount, 0);
  const list = (
    <View style={styles.spend} testID="line-spending">
      <Text style={styles.label}>This month's spending · {formatAmount(spentTotal)}</Text>
      {spending.length === 0 && <Text style={styles.dim}>Nothing filed here this month.</Text>}
      {spending.map((t) => (
        <Pressable key={t.id} onPress={() => onOpenTxn(t)} style={styles.spendRow} accessibilityRole="button">
          <Text style={[styles.dim, styles.spendDate]}>{formatDay(t.date)}</Text>
          <Text style={styles.spendName} numberOfLines={1}>{t.name}</Text>
          <Text style={styles.num}>{formatAmount(t.amount)}</Text>
        </Pressable>
      ))}
    </View>
  );

  if (readOnly) {
    return (
      <View style={styles.fill} testID="line-detail-readonly">
        <PaneHead title="Budget line" onClose={onClose} />
        <ScrollView contentContainerStyle={styles.body}>
          <Fact label="Name">{row.line.name}</Fact>
          <Fact label="Group">{groupName}</Fact>
          <Fact label="Target each month">{formatAmount(row.target)}</Fact>
          <Fact label="Allocated">{formatAmount(row.allocated)}</Fact>
          <Fact label="Remaining">{formatAmount(row.remaining)}</Fact>
          <Fact label="Snoozed">{row.snoozed ? 'Yes' : 'No'}</Fact>
          {list}
          <Text style={styles.dim}>Read-only here. Change allocations on your iPhone or in the AcctMind Mac app.</Text>
        </ScrollView>
      </View>
    );
  }

  const targetCents = parseAmount(target);
  const save = () => {
    if (name.trim() === '' || targetCents === null) return;
    onSave({ name: name.trim(), category, target: Math.max(0, targetCents), allocated, snoozed });
  };
  const del = () => {
    if (!armed) { setArmed(true); fuse.current = setTimeout(() => setArmed(false), 2500); return; }
    onDelete();
  };

  return (
    <View style={styles.fill} testID="line-detail">
      <PaneHead title="Budget line" onClose={onClose} />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <View style={styles.f}>
          <Text style={styles.label}>Name</Text>
          <TextInput value={name} onChangeText={setName} style={styles.input} placeholderTextColor={T.faint} testID="line-name-input" />
        </View>
        <View style={styles.f}>
          <Text style={styles.label}>Group</Text>
          <View style={styles.chips}>
            {categories.map((c) => (
              <Pressable key={c.id} onPress={() => setCategory(c.id)} accessibilityRole="button"
                style={[styles.chip, c.id === category && styles.chipOn]} testID={`line-group-${c.id}`}>
                <Text style={styles.chipText}>{c.name || 'Untitled'}</Text>
              </Pressable>
            ))}
          </View>
        </View>
        <View style={styles.f}>
          <Text style={styles.label}>Target each month</Text>
          <TextInput value={target} onChangeText={setTarget} style={[styles.input, styles.right]} inputMode="decimal"
            placeholderTextColor={T.faint} testID="line-target-input" />
          {targetCents === null && <Text style={styles.err}>That is not an amount</Text>}
        </View>
        <View style={styles.f}>
          <Text style={styles.label}>Allocated</Text>
          <OpAmount value={allocated} onValue={setAllocated} testID="line-alloc" compact />
        </View>
        <Pressable onPress={() => setSnoozed((x) => !x)} style={styles.snooze} accessibilityRole="switch"
          accessibilityState={{ checked: snoozed }} testID="line-snooze-switch">
          <Text style={styles.value}>Snoozed</Text>
          <View style={[styles.track, snoozed && styles.trackOn]}><View style={[styles.knob, snoozed && styles.knobOn]} /></View>
        </Pressable>
        {list}
        <View style={styles.actions}>
          <Btn label={armed ? 'Tap again to delete' : 'Delete'} danger onPress={del} testID="line-delete" />
          <View style={styles.rightRow}>
            <Btn label="Cancel" onPress={onClose} testID="line-cancel" />
            <Btn label="Save" primary onPress={save} testID="line-save" />
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  body: { padding: 16, paddingTop: 4, gap: 14 },
  f: { gap: 5 },
  label: { color: T.dim, fontSize: 13 },
  value: { color: T.text, fontSize: 14 },
  dim: { color: T.dim, fontSize: 13 },
  err: { color: T.danger, fontSize: 12 },
  input: {
    backgroundColor: T.bg, color: T.text, fontSize: 14, minHeight: 36, borderRadius: 8, paddingHorizontal: 12,
    borderWidth: StyleSheet.hairlineWidth, borderColor: T.faint,
  },
  right: { textAlign: 'right', fontVariant: ['tabular-nums'] },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { paddingHorizontal: 12, minHeight: 30, justifyContent: 'center', borderRadius: 15, borderWidth: StyleSheet.hairlineWidth, borderColor: T.faint },
  chipOn: { backgroundColor: 'rgba(10,132,255,0.28)', borderColor: T.accent },
  chipText: { color: T.text, fontSize: 13 },
  snooze: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 36 },
  track: { width: 40, height: 24, borderRadius: 12, backgroundColor: T.faint, padding: 2, justifyContent: 'center' },
  trackOn: { backgroundColor: T.positive },
  knob: { width: 20, height: 20, borderRadius: 10, backgroundColor: '#fff' },
  knobOn: { alignSelf: 'flex-end' },
  spend: { gap: 2 },
  spendRow: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 30, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: T.cardEdge },
  spendDate: { width: 64 },
  spendName: { flex: 1, color: T.text, fontSize: 14 },
  num: { color: T.text, fontSize: 14, fontVariant: ['tabular-nums'] },
  actions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 },
  rightRow: { flexDirection: 'row', gap: 8 },
});
