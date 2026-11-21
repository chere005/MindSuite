/**
 * The wide layout's detail pane: what an event, reminder or recipe opens into
 * instead of the phone's modal. App owns the one open item (DetailProvider);
 * a screen asks for it with <ItemSheet> (the editor — the very form the phone
 * modal shows, drawn inline) or <ReadOnlySheet> (an imported calendar's event,
 * a planned recipe: fields as text and one line naming where to edit).
 *
 * Both sheets render NOTHING themselves on a wide window — they register with
 * the pane on mount and leave it on unmount, so the caller's own
 * "which item is open" state stays the single source of truth, exactly as it is
 * with the phone modal. Under WIDE_MIN_WIDTH <ItemSheet> is the unchanged
 * ItemModal.
 */
import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { themed, T } from '../theme';
import { Pill, Scroll } from '../ui';
import { ItemEditor, ItemModal, type ItemEditorProps } from './ItemModal';
import { useWide } from './WideFrame';

export type DetailItem =
  | { key: string; type: 'edit'; props: ItemEditorProps; onClose: () => void }
  | { key: string; type: 'readonly'; view: ReadOnlyView; onClose: () => void };

export type ReadOnlyView = {
  heading: string;
  title: string;
  swatch?: string;
  rows: { label: string; value: string }[];
  /** The amber line: why it is read-only and where to edit it. */
  note: string;
  action?: { label: string; onPress: () => void; testID?: string };
};

type Ctx = { item: DetailItem | null; open: (item: DetailItem) => void; close: (key: string) => void };
const DetailCtx = createContext<Ctx>({ item: null, open: () => {}, close: () => {} });
export const useDetail = () => useContext(DetailCtx);

export function DetailProvider({ children }: { children: React.ReactNode }) {
  const [item, setItem] = useState<DetailItem | null>(null);
  const value = React.useMemo<Ctx>(() => ({
    item,
    open: (next) => setItem(next),
    // Only the item that is still open may close itself: a screen switching
    // from one row to another unmounts the old sheet AFTER the new one opened.
    close: (key) => setItem((cur) => (cur && cur.key === key ? null : cur)),
  }), [item]);
  return <DetailCtx.Provider value={value}>{children}</DetailCtx.Provider>;
}

let seq = 0;

/** The editor: a modal on the phone, the detail pane on a wide window. */
export function ItemSheet(props: ItemEditorProps) {
  const { wide } = useWide();
  return wide ? <WideEditSheet {...props} /> : <ItemModal {...props} />;
}

function WideEditSheet(props: ItemEditorProps) {
  const detail = useDetail();
  const latest = useRef(props);
  latest.current = props;
  const ident = `${props.mode}:${props.rec?.id ?? 'new'}:${props.dest0 ?? ''}:${props.date ?? ''}:${props.text0 ?? ''}`;
  const { open, close } = detail;
  useEffect(() => {
    const key = `${ident}#${++seq}`;
    // Stable wrappers: the pane may keep this item open across the caller's
    // re-renders, and the callbacks must always reach the latest closures.
    const onClose = () => latest.current.onClose();
    open({
      key, type: 'edit', onClose,
      props: { ...latest.current, onClose, onSaved: (id, kind) => latest.current.onSaved?.(id, kind) },
    });
    return () => close(key);
  }, [ident]);
  return null;
}

/** A read-only view in the detail pane (wide only; the phone never opens one). */
export function ReadOnlySheet({ view, onClose }: { view: ReadOnlyView; onClose: () => void }) {
  const detail = useDetail();
  const latest = useRef({ view, onClose });
  latest.current = { view, onClose };
  const { open, close } = detail;
  const ident = JSON.stringify([view.heading, view.title, view.rows]);
  useEffect(() => {
    const key = `ro:${ident}#${++seq}`;
    open({ key, type: 'readonly', view: latest.current.view, onClose: () => latest.current.onClose() });
    return () => close(key);
  }, [ident]);
  return null;
}

/** What WideFrame's detail slot draws. */
export function DetailBody({ item }: { item: DetailItem }) {
  if (item.type === 'edit') {
    return <ItemEditor key={item.key} {...item.props} inline />;
  }
  const { view } = item;
  return (
    <Scroll key={item.key} testID="detail-readonly" contentContainerStyle={s.scroll}>
      <View style={s.head}>
        <Text style={s.heading}>{view.heading}</Text>
        <Pill label="Close" onPress={item.onClose} />
      </View>
      <View style={s.titleRow}>
        {view.swatch && <View style={[s.swatch, { backgroundColor: view.swatch }]} />}
        <Text testID="detail-title" style={s.title}>{view.title}</Text>
      </View>
      {view.rows.map((r) => (
        <View key={r.label} style={s.row}>
          <Text style={s.label}>{r.label}</Text>
          <Text style={s.value}>{r.value}</Text>
        </View>
      ))}
      <View testID="detail-banner" style={s.banner}>
        <Text style={s.bannerText}>{view.note}</Text>
      </View>
      {view.action && (
        <Pressable testID={view.action.testID} accessibilityRole="button" onPress={view.action.onPress} style={s.action}>
          <Text style={s.actionText}>{view.action.label}</Text>
        </Pressable>
      )}
    </Scroll>
  );
}

const s = themed(() => StyleSheet.create({
  scroll: { padding: 16, gap: 12 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  heading: { color: T.text, fontSize: 18, fontWeight: '700' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  swatch: { width: 12, height: 12, borderRadius: 3 },
  title: { color: T.text, fontSize: 16, fontWeight: '600', flex: 1 },
  row: { flexDirection: 'row', gap: 12 },
  label: { color: T.dim, fontSize: 13, width: 72 },
  value: { color: T.text, fontSize: 14, flex: 1 },
  banner: { borderWidth: 1, borderColor: T.gold, backgroundColor: T.gold + '22', borderRadius: 8, padding: 10 },
  bannerText: { color: T.text, fontSize: 13 },
  action: { alignSelf: 'flex-start', borderWidth: 1, borderColor: T.line, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  actionText: { color: T.accent, fontSize: 14, fontWeight: '600' },
}));
