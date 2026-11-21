/**
 * Suite presentation only: the wide (desktop-size) frame — sidebar, main
 * pane and an optional detail pane. Apps supply the content and the colors;
 * nothing here knows a record type.
 *
 * The owner, 2026-11-21: the same app at desktop size, "readable and
 * text-first", sidebar on the left, the detail pane collapsing FIRST when
 * the window narrows, and every action inside the app's own frame (the
 * MindSuite bar above it only switches apps). Below WIDE_MIN_WIDTH the apps
 * keep their phone column and tab bar, unchanged.
 */
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

export type WideColors = {
  background: string; sidebar: string; surface: string; line: string;
  text: string; dim: string; accent: string; selected: string; selectedText: string;
};

/** At or above this window width an app uses the wide frame. */
export const WIDE_MIN_WIDTH = 900;
/** Below this the detail pane stops sitting beside the main pane and opens over it. */
export const DETAIL_BESIDE_MIN_WIDTH = 1180;
export const SIDEBAR_WIDTH = 232;
export const DETAIL_WIDTH = 380;

export function useWide(): { wide: boolean; detailBeside: boolean; width: number } {
  const { width } = useWindowDimensions();
  return { wide: width >= WIDE_MIN_WIDTH, detailBeside: width >= DETAIL_BESIDE_MIN_WIDTH, width };
}

export function WideFrame({ sidebar, main, detail, onCloseDetail, colors, testID = 'wide-frame' }: {
  sidebar: React.ReactNode; main: React.ReactNode; detail?: React.ReactNode | null;
  /** Called by the backdrop when the detail pane is open OVER the main pane. */
  onCloseDetail?: () => void; colors: WideColors; testID?: string;
}) {
  const { detailBeside } = useWide();
  const hasDetail = detail != null && detail !== false;
  // The pane keeps ONE place in the tree whether it sits beside the main pane
  // or over it: only its style changes, so crossing 1180 px never remounts
  // the form inside it and never loses what was typed there.
  return (
    <View testID={testID} style={[s.row, { backgroundColor: colors.background }]}>
      <View testID="wide-sidebar" style={[s.sidebar, { backgroundColor: colors.sidebar, borderRightColor: colors.line }]}>
        <ScrollView contentContainerStyle={s.sidebarInner}>{sidebar}</ScrollView>
      </View>
      <View testID="wide-main" style={s.main}>{main}</View>
      {hasDetail && !detailBeside && (
        <Pressable key="backdrop" testID="wide-detail-backdrop" accessibilityLabel="Close" onPress={onCloseDetail}
          style={[StyleSheet.absoluteFill, s.backdrop]} />
      )}
      {hasDetail && (
        <View key="detail" testID="wide-detail"
          style={[s.detail, !detailBeside && s.detailOver, { backgroundColor: colors.surface, borderLeftColor: colors.line }]}>
          {detail}
        </View>
      )}
    </View>
  );
}

/** The app's name at the top of the sidebar. */
export function SidebarTitle({ title, colors, right }: { title: string; colors: WideColors; right?: React.ReactNode }) {
  return (
    <View style={s.titleRow}>
      <Text style={[s.title, { color: colors.text }]} numberOfLines={1}>{title}</Text>
      {right}
    </View>
  );
}

/** A small heading over a group of sidebar items ("Calendars", "Accounts"). */
export function SidebarLabel({ label, colors }: { label: string; colors: WideColors }) {
  return <Text style={[s.label, { color: colors.dim }]}>{label}</Text>;
}

/** One sidebar row: a section, a folder, an account. */
export function SidebarItem({ label, count, active = false, onPress, colors, testID, leading, trailing }: {
  label: string; count?: string | number | null; active?: boolean; onPress?: () => void; colors: WideColors;
  testID?: string; leading?: React.ReactNode; trailing?: React.ReactNode;
}) {
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityState={{ selected: active }} onPress={onPress}
      style={({ pressed }) => [s.item, active && { backgroundColor: colors.selected }, pressed && !active && { opacity: 0.7 }]}>
      {leading}
      <Text style={[s.itemText, { color: active ? colors.selectedText : colors.text }, active && s.itemActive]} numberOfLines={1}>{label}</Text>
      {count != null && count !== '' && <Text style={[s.count, { color: active ? colors.selectedText : colors.dim }]}>{count}</Text>}
      {trailing}
    </Pressable>
  );
}

const s = StyleSheet.create({
  row: { flex: 1, flexDirection: 'row', minHeight: 0 },
  sidebar: { width: SIDEBAR_WIDTH, borderRightWidth: StyleSheet.hairlineWidth },
  sidebarInner: { paddingHorizontal: 10, paddingVertical: 12, gap: 2 },
  main: { flex: 1, minWidth: 0 },
  detail: { width: DETAIL_WIDTH, borderLeftWidth: StyleSheet.hairlineWidth },
  detailOver: { position: 'absolute', top: 0, right: 0, bottom: 0 },
  backdrop: { backgroundColor: 'rgba(0,0,0,0.25)' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8, paddingTop: 2, paddingBottom: 10 },
  title: { flex: 1, fontSize: 18, fontWeight: '600' },
  label: { fontSize: 12, fontWeight: '500', paddingHorizontal: 8, paddingTop: 14, paddingBottom: 4 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 32, paddingHorizontal: 8, paddingVertical: 6, borderRadius: 6 },
  itemText: { flex: 1, fontSize: 14 },
  itemActive: { fontWeight: '600' },
  count: { fontSize: 13, fontVariant: ['tabular-nums'] },
});
