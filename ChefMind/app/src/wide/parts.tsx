/**
 * Small pieces the desktop-size panes share: the colour map the shared
 * WideFrame wants, the main pane's header, and the detail pane's header.
 */
import { type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { WideColors } from '../components/WideFrame';
import { themed, T } from '../theme';

/** ChefMind's palette in the frame's terms. Read at render: `T` is live. */
export function wideColors(): WideColors {
  return {
    background: T.bg, sidebar: T.surface, surface: T.surface, line: T.line,
    text: T.text, dim: T.dim, accent: T.accent, selected: T.accentSoft, selectedText: T.text,
  };
}

/** The main pane's heading: a title, one quiet line under it, actions on the right. */
export function PaneHead({ title, sub, right, back }: { title: string; sub?: string; right?: ReactNode; back?: { label: string; onPress: () => void } }) {
  return (
    <View style={s.head}>
      {back && (
        <Pressable testID="pane-back" accessibilityRole="button" onPress={back.onPress} style={s.back}>
          <Text style={s.backText}>‹ {back.label}</Text>
        </Pressable>
      )}
      <View style={s.headRow}>
        <View style={s.headText}>
          <Text testID="pane-title" style={s.title} numberOfLines={1}>{title}</Text>
          {sub ? <Text style={s.sub} numberOfLines={1}>{sub}</Text> : null}
        </View>
        {right ? <View style={s.actions}>{right}</View> : null}
      </View>
    </View>
  );
}

/** The detail pane's top line: a small label and a close. */
export function DetailTop({ label, onClose }: { label: string; onClose: () => void }) {
  return (
    <View style={s.detailTop}>
      <Text style={s.detailLabel} numberOfLines={1}>{label}</Text>
      <Pressable testID="detail-close" accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} hitSlop={8} style={s.x}>
        <Text style={s.xText}>✕</Text>
      </Pressable>
    </View>
  );
}

export const s = themed(() => StyleSheet.create({
  head: { paddingHorizontal: 24, paddingTop: 18, paddingBottom: 12 },
  back: { alignSelf: 'flex-start', paddingVertical: 4, marginBottom: 4 },
  backText: { color: T.accent, fontSize: 14, fontWeight: '700' },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  headText: { flex: 1, minWidth: 200 },
  title: { color: T.text, fontSize: 24, fontWeight: '800' },
  sub: { color: T.dim, fontSize: 14, marginTop: 2 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 0 },
  detailTop: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 14, paddingBottom: 2 },
  detailLabel: { flex: 1, color: T.gold, fontSize: 12, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.6 },
  x: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  xText: { color: T.dim, fontSize: 15 },
}));
