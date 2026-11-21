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
import { ItemEditor, ItemModal, type DraftRef, type ItemEditorProps } from './ItemModal';

export type DetailItem =
  | { key: string; type: 'edit'; props: ItemEditorProps; draft: DraftRef; onClose: () => void }
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

/**
 * True for the commit in which the window crosses WIDE_MIN_WIDTH. Root swaps
 * the whole frame then, so the screens (and their <ItemSheet>s) unmount and
 * mount again; the open item must outlive that, so a sheet that unmounts in
 * such a commit leaves it open. App sets and clears this.
 */
export const layoutCrossing = { now: false };

/**
 * The ONE open item lives here, above both frames — which is what lets it
 * survive the window being resized across 900 px: it is drawn by the wide
 * frame's detail pane or, below 900, by <PhoneItemHost>, from the same record
 * and the same draft of unsaved values.
 */
export function DetailProvider({ children }: { children: React.ReactNode }) {
  const [item, setItem] = useState<DetailItem | null>(null);
  const cur = useRef<DetailItem | null>(null);
  const value = React.useMemo<Ctx>(() => ({
    item,
    open: (next) => {
      const old = cur.current;
      cur.current = next;
      setItem(next);
      // Something else was open — an editor, a read-only view, possibly from
      // another sheet. Its owner keeps "which item is open" in its own state,
      // and that state has to be told, or its next open of the SAME item sets
      // nothing and the control goes dead.
      if (old && old.key !== next.key) old.onClose();
    },
    // Only the item that is still open may close itself.
    close: (key) => {
      if (cur.current && cur.current.key === key) {
        cur.current = null;
        setItem(null);
      }
    },
  }), [item]);
  return <DetailCtx.Provider value={value}>{children}</DetailCtx.Provider>;
}

let seq = 0;

/**
 * An item's editor. Draws nothing itself: it hands the item to the provider
 * (drawn as the phone's modal or the wide layout's pane) and keeps the
 * caller's own "which item is open" state the single source of truth, as the
 * old modal did.
 */
export function ItemSheet(props: ItemEditorProps) {
  const detail = useDetail();
  const latest = useRef(props);
  latest.current = props;
  const ident = `${props.mode}:${props.rec?.id ?? 'new'}:${props.dest0 ?? ''}:${props.date ?? ''}:${props.text0 ?? ''}`;
  const { open, close } = detail;
  useEffect(() => {
    const key = `${ident}#${++seq}`;
    // Stable wrappers: the item may stay open across the caller's re-renders
    // (or its remount), and must always reach the latest closures. onClose
    // also closes the item itself, so a caller that is gone still closes it.
    const onClose = () => { latest.current.onClose(); close(key); };
    open({
      key, type: 'edit', onClose, draft: { current: null },
      props: { ...latest.current, onClose, onSaved: (id, kind) => latest.current.onSaved?.(id, kind) },
    });
    return () => { if (!layoutCrossing.now) close(key); };
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
    open({ key, type: 'readonly', view: latest.current.view, onClose: () => { latest.current.onClose(); close(key); } });
    return () => { if (!layoutCrossing.now) close(key); };
  }, [ident]);
  return null;
}

/** Below 900 px: the open item as the phone's modal, as it always was. */
export function PhoneItemHost() {
  const { item } = useDetail();
  // A read-only view is a wide-layout thing: if the window shrank under one, let it go.
  useEffect(() => { if (item?.type === 'readonly') item.onClose(); }, [item]);
  if (item?.type !== 'edit') return null;
  return <ItemModal key={item.key} {...item.props} draft={item.draft} />;
}

/** What WideFrame's detail slot draws. */
export function DetailBody({ item }: { item: DetailItem }) {
  if (item.type === 'edit') {
    return <ItemEditor key={item.key} {...item.props} draft={item.draft} inline />;
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
