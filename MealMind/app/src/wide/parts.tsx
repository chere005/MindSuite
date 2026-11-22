/**
 * Small pieces the desktop-size panes share: the colour map the shared
 * WideFrame wants, the main pane's header, and the detail pane's header.
 */
import { type ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import type { WideColors } from '../components/WideFrame';
import { themed, T } from '../theme';

/** MealMind's palette in the frame's terms. Read at render: `T` is live. */
export function wideColors(): WideColors {
  return {
    background: T.bg, sidebar: T.surface, surface: T.surface, line: T.line,
    text: T.text, dim: T.dim, accent: T.accent, selected: T.accentSoft, selectedText: T.text,
  };
}

/**
 * A block capped at `maxWidth` and CENTRED in a wider pane (the owner,
 * 2026-11-21: "things that are narrower than the whole page are at least
 * centered"). Header, table and bar each wear the same cap, so they stay one
 * aligned column however wide the window is.
 */
export function centred(maxWidth: number): ViewStyle {
  return { width: '100%', maxWidth, alignSelf: 'center' };
}

/**
 * A classic scrollbar (a Mac with a mouse, "always show scrollbars", Windows,
 * Linux) takes its width out of a scrolling list but not out of the header and
 * bars around it, so a centred list sat half a scrollbar left of its centred
 * header and the columns no longer lined up. The list reserves its gutter
 * (`scrollGutter`) and each full-width piece outside it reserves the same one
 * (`gutterMatch`: overflow hidden, so the gutter is there with no scrollbar in
 * it); all of them then centre in the same width. Overlay scrollbars take no
 * width, so both are 0 there. Web only: native lists have no gutter.
 */
export const scrollGutter: ViewStyle = Platform.OS === 'web' ? ({ scrollbarGutter: 'stable' } as unknown as ViewStyle) : {};
export const gutterMatch: ViewStyle = Platform.OS === 'web' ? ({ overflow: 'hidden', scrollbarGutter: 'stable' } as unknown as ViewStyle) : {};

/**
 * The main pane's heading, under the suite's top bar: one quiet line and the
 * pane's actions on the right. The section's title is the bar's (as on the
 * phone), so `title` is only for a pane that needs a second, smaller one.
 * `maxWidth` caps and centres it over a capped table or list below.
 */
export function PaneHead({ title, sub, right, back, maxWidth }: { title?: string; sub?: string; right?: ReactNode; back?: { label: string; onPress: () => void }; maxWidth?: number }) {
  return (
    <View style={[s.head, maxWidth !== undefined && centred(maxWidth)]}>
      {back && (
        <Pressable testID="pane-back" accessibilityRole="button" onPress={back.onPress} style={s.back}>
          <Text style={s.backText}>‹ {back.label}</Text>
        </Pressable>
      )}
      <View style={s.headRow}>
        <View style={s.headText}>
          {title ? <Text testID="pane-title" style={s.title} numberOfLines={1}>{title}</Text> : null}
          {sub ? <Text style={s.sub} numberOfLines={1}>{sub}</Text> : null}
        </View>
        {right ? <View style={s.actions}>{right}</View> : null}
      </View>
    </View>
  );
}

/** The detail pane's top line: a small label, any quiet controls (`extra`, a
 *  "⋯" menu), and a close. */
export function DetailTop({ label, onClose, extra }: { label: string; onClose: () => void; extra?: ReactNode }) {
  return (
    <View style={s.detailTop}>
      <Text style={s.detailLabel} numberOfLines={1}>{label}</Text>
      {extra}
      <Pressable testID="detail-close" accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} hitSlop={8} style={s.x}>
        <Text style={s.xText}>✕</Text>
      </Pressable>
    </View>
  );
}

export const s = themed(() => StyleSheet.create({
  head: { paddingHorizontal: 24, paddingTop: 2, paddingBottom: 12 },
  back: { alignSelf: 'flex-start', paddingVertical: 4, marginBottom: 4 },
  backText: { color: T.accent, fontSize: 14, fontWeight: '700' },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  headText: { flex: 1, minWidth: 200 },
  title: { color: T.text, fontSize: 18, fontWeight: '700' },
  sub: { color: T.dim, fontSize: 14, marginTop: 2 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 0 },
  detailTop: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 14, paddingBottom: 2 },
  detailLabel: { flex: 1, color: T.gold, fontSize: 12, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.6 },
  x: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  xText: { color: T.dim, fontSize: 15 },
}));
