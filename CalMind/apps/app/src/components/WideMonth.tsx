/**
 * The wide layout's month (and fortnight) grid: every cell fills its share of
 * the window and lists what is on its day as TEXT — the phone's cells only
 * have room for marks. A line opens its item; the bare cell selects the day.
 * Pure layout: Calendar builds the lines from the same core calls the day
 * panel uses, so the two cannot disagree about what is on a day.
 */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View, type GestureResponderHandlers } from 'react-native';
import { themed, T } from '../theme';
import { CalGlyph, ChefHatGlyph, PageGlyph, TickBoxGlyph } from './KindIcons';

export type CellLine = {
  key: string;
  kind: 'event' | 'reminder' | 'note' | 'recipe' | 'sub';
  text: string;
  /** The time, drawn before the words ("9:00am"). */
  time?: string | null;
  color: string;
  done?: boolean;
  overdue?: boolean;
  onPress: () => void;
  /** Reminders only: the box ticks it. */
  onTick?: () => void;
};

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LINE_H = 18;
const HEAD_H = 26;

export function WideMonth({ cells, ym, day, today, weekMode, lines, onDay, panHandlers }: {
  cells: string[]; ym: string; day: string; today: string; weekMode: boolean;
  lines: Map<string, CellLine[]>; onDay: (d: string) => void; panHandlers?: GestureResponderHandlers;
}) {
  const [h, setH] = useState(0);
  const rows: string[][] = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));
  const rowH = h > 0 ? (h - HEAD_H) / rows.length : 90;
  // As many lines as the cell is tall enough for, the last one giving way to
  // "+n more" when the day holds more.
  const cap = Math.max(1, Math.floor((rowH - 30) / LINE_H));
  return (
    <View testID="cal-grid" style={s.grid} onLayout={(e) => setH(e.nativeEvent.layout.height)} {...panHandlers}>
      <View style={s.dowRow}>
        {DOW.map((w) => <Text key={w} style={s.dow}>{w}</Text>)}
      </View>
      {rows.map((row, ri) => (
        <View key={ri} style={s.row}>
          {row.map((d) => {
            const all = lines.get(d) ?? [];
            const over = all.length > cap;
            const shown = over ? all.slice(0, Math.max(0, cap - 1)) : all;
            const other = !weekMode && !d.startsWith(ym);
            return (
              <Pressable key={d} testID="cal-cell" onPress={() => onDay(d)} style={[s.cell, d === day && s.cellPicked]}>
                <View style={s.numSlot}>
                  {d === today ? (
                    <View style={s.todayWrap}><Text style={s.todayNum}>{Number(d.slice(8))}</Text></View>
                  ) : (
                    <Text style={[s.num, other && s.numOther]}>{Number(d.slice(8))}</Text>
                  )}
                </View>
                {shown.map((l) => (
                  <View key={l.key} style={s.line}>
                    {l.kind === 'reminder' ? (
                      <Pressable testID="cell-tick" onPress={l.onTick} hitSlop={4}>
                        <TickBoxGlyph size={12} color={l.overdue ? T.overdue : l.color} done={l.done} />
                      </Pressable>
                    ) : l.kind === 'event' || l.kind === 'sub' ? (
                      <CalGlyph size={12} color={l.color} />
                    ) : l.kind === 'recipe' ? (
                      <ChefHatGlyph size={12} color={T.accent} />
                    ) : (
                      <PageGlyph size={12} color={l.color} />
                    )}
                    <Pressable testID="cell-line" style={s.lineBody} onPress={l.onPress}>
                      <Text numberOfLines={1} style={[s.lineText, other && s.numOther, l.done && s.lineDone]}>
                        {l.time ? <Text style={s.lineTime}>{l.time} </Text> : null}{l.text}
                      </Text>
                    </Pressable>
                  </View>
                ))}
                {over && <Text style={s.more}>+{all.length - shown.length} more</Text>}
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

const s = themed(() => StyleSheet.create({
  grid: { flex: 1, minHeight: 0, userSelect: 'none', borderTopWidth: 1, borderTopColor: T.lineSoft },
  dowRow: { flexDirection: 'row', height: HEAD_H, alignItems: 'center' },
  dow: { flex: 1, color: T.muted, fontSize: 12, paddingHorizontal: 8 },
  row: { flex: 1, flexDirection: 'row', minHeight: 0 },
  cell: { flex: 1, minWidth: 0, overflow: 'hidden', paddingHorizontal: 6, paddingTop: 4, paddingBottom: 4, gap: 1, borderRightWidth: 1, borderBottomWidth: 1, borderColor: T.lineSoft },
  cellPicked: { backgroundColor: T.surface2 },
  numSlot: { height: 22, justifyContent: 'center', alignItems: 'flex-start' },
  num: { color: T.text, fontSize: 13, fontWeight: '600' },
  numOther: { color: T.muted, opacity: 0.75 },
  todayWrap: { backgroundColor: T.accent, borderRadius: 11, minWidth: 22, height: 22, paddingHorizontal: 5, alignItems: 'center', justifyContent: 'center' },
  todayNum: { color: T.accentInk, fontSize: 13, fontWeight: '700' },
  line: { flexDirection: 'row', alignItems: 'center', gap: 5, height: LINE_H },
  lineBody: { flex: 1, minWidth: 0 },
  lineText: { color: T.text, fontSize: 12 },
  lineTime: { color: T.dim },
  lineDone: { color: T.dim, textDecorationLine: 'line-through' },
  more: { color: T.dim, fontSize: 11, paddingTop: 1 },
}));
