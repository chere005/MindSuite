/**
 * Shopping and Pantry at desktop size.
 *
 * Shopping is the aisle-ordered list with the cart ticks; "Done shopping" and a
 * row's own detail open in the detail pane. The pantry has no ticks: its aisle
 * groups run as columns across the width, a click opens the item in the detail
 * pane, and a receipt scan shows its proposal inline above the list, not in a
 * modal. Both read and write the same reminder records the phone lists do.
 */
import { useMemo, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, type PressableStateCallbackType, Text, View, type ViewStyle } from 'react-native';
import { newId, ordBetween, pantryHas, pantryItemsFromPages } from '@calmind/core';
import { useStore } from '../store';
import { themed, T } from '../theme';
import { Field, Pill, Scroll } from '../ui';
import { PickBar } from '../components/PickBar';
import { TickBox } from '../components/chefui';
import { useToast } from '../components/Toast';
import { OCR_UNSUPPORTED, ocrImages, ocrSupported, pickPhotoUris } from '../components/ocr';
import { applyOps, listOf, newRow, toggleCartOp, type ListKind } from '../chefflows';
import { aisleOfRow, aisleRuns, filterRows, pantrySummary, shoppingSummary } from '../wideflows';
import { DetailTop, PaneHead } from './parts';

function useList(kind: ListKind) {
  const { recs } = useStore();
  return useMemo(() => listOf(recs, kind), [recs, kind]);
}

/** Add one typed row at the end of a list. Returns false if nothing was added. */
function useAdder(kind: ListKind) {
  const { mutate } = useStore();
  const toast = useToast();
  const list = useList(kind);
  return (raw: string): boolean => {
    const text = raw.trim();
    if (!text || !list) return false;
    if (kind === 'pantry' && pantryHas(list.rows.map((r) => r.payload.text), text)) { toast('Already in the pantry.'); return false; }
    const last = list.rows[list.rows.length - 1];
    const r = newRow(list, text, last?.payload.ord ?? null, newId());
    mutate((e) => e.put(r.rec));
    return true;
  };
}

/* ── Shopping ───────────────────────────────────────────────────────────── */

export function WideShopping({ openRowId, onOpenRow, doneOpen, onDoneShopping }: {
  openRowId: string | null;
  onOpenRow: (id: string) => void;
  doneOpen: boolean;
  onDoneShopping: () => void;
}) {
  const { mutate } = useStore();
  const toast = useToast();
  const list = useList('shopping');
  const add = useAdder('shopping');
  const [field, setField] = useState('');
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const rows = list?.rows ?? [];
  const runs = useMemo(() => aisleRuns(rows.map((r) => ({ text: r.payload.text, row: r }))), [rows]);
  const ids = new Set(rows.map((r) => r.id));
  const picked = selected.filter((id) => ids.has(id));
  const inCart = rows.filter((r) => r.payload.done).length;

  const submit = () => { if (add(field)) setField(''); };
  const toggle = (id: string) => setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const deleteSelected = () => {
    if (picked.length === 0) return;
    mutate((e) => { for (const id of picked) e.del(id); });
    setSelected([]);
    toast(picked.length === 1 ? '1 removed.' : `${picked.length} removed.`);
  };

  return (
    <View style={s.root} testID="wide-shopping">
      <PaneHead
        title="Shopping"
        sub={shoppingSummary(rows.length, inCart)}
        right={(
          <>
            <Pill testID="shopping-select" label={selecting ? 'Stop selecting' : 'Select'} onPress={() => { setSelecting((v) => !v); setSelected([]); }} />
            <Pill testID="shopping-done" primary disabled={inCart === 0 || doneOpen} label="Done shopping" onPress={onDoneShopping} />
          </>
        )}
      />
      <Scroll style={s.scroll} contentContainerStyle={s.scrollIn} keyboardShouldPersistTaps="handled">
        <View style={s.column}>
          <View style={s.addRow}>
            <Field testID="shopping-add" value={field} onChangeText={setField} placeholder="Add an item" onSubmitEditing={submit} style={s.addField} />
            <Pill testID="shopping-add-go" label="Add" onPress={submit} />
          </View>
          {rows.length === 0 && <Text style={s.empty}>Nothing to buy. Pick recipes in Recipes to fill this in.</Text>}
          {runs.map((g) => (
            <View key={g.aisle} style={s.group}>
              <Text testID={`shopping-aisle-${g.aisle}`} style={s.aisle}>{g.aisle}</Text>
              {g.rows.map(({ row }) => (
                <Pressable key={row.id} testID="shopping-row" accessibilityRole="button" onPress={() => onOpenRow(row.id)}
                  style={(st: PressableStateCallbackType) => [s.row, openRowId === row.id && s.rowOpen, (st as { hovered?: boolean }).hovered && s.rowHover]}>
                  {selecting
                    ? <TickBox round testID="shopping-pick" on={picked.includes(row.id)} label={`Select ${row.payload.text}`} onPress={() => toggle(row.id)} />
                    : <TickBox testID="shopping-cart" on={row.payload.done} label={`${row.payload.text} in my cart`} onPress={() => mutate((e) => applyOps(e, [toggleCartOp(row)]))} />}
                  <Text style={[s.rowText, row.payload.done && s.rowDone]}>{row.payload.text}</Text>
                </Pressable>
              ))}
            </View>
          ))}
        </View>
      </Scroll>
      {selecting && (
        <PickBar prefix="shopping" count={picked.length} onAll={() => setSelected(rows.map((r) => r.id))} onClear={() => setSelected([])} onDelete={deleteSelected} />
      )}
    </View>
  );
}

/** A shopping row's own pane: its aisle, its name to edit, in cart, Delete. */
export function ShoppingRowDetail({ rowId, onClose }: { rowId: string; onClose: () => void }) {
  const { mutate } = useStore();
  const list = useList('shopping');
  const row = list?.rows.find((r) => r.id === rowId);
  const [name, setName] = useState(row?.payload.text ?? '');
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  if (!row) return (
    <View style={s.root}><DetailTop label="Shopping" onClose={onClose} /><Text style={s.detailNote}>That item is gone.</Text></View>
  );
  const save = () => {
    const t = name.trim();
    if (t === '') { mutate((e) => e.del(row.id)); onClose(); return; }
    if (t !== row.payload.text) mutate((e) => e.put({ ...row, payload: { ...row.payload, text: t } }));
  };
  const del = () => {
    if (!armed) { setArmed(true); clearTimeout(timer.current); timer.current = setTimeout(() => setArmed(false), 2500); return; }
    mutate((e) => e.del(row.id));
    onClose();
  };
  return (
    <View style={s.root} testID="shopping-row-detail">
      <DetailTop label={aisleOfRow(row.payload.text)} onClose={onClose} />
      <View style={s.detailBody}>
        <Field testID="shopping-row-name" value={name} onChangeText={setName} onBlur={save} onSubmitEditing={save} style={s.detailField} />
        <Text style={s.detailNote}>{row.payload.done ? 'In your cart.' : 'Not in your cart yet.'} The aisle comes from the name.</Text>
        <View style={s.detailBar}>
          <Pill testID="shopping-row-delete" label={armed ? 'Delete?' : 'Delete'} onPress={del} />
          <Pill testID="shopping-row-close" label="Close" onPress={onClose} />
        </View>
      </View>
    </View>
  );
}

/* ── Pantry ─────────────────────────────────────────────────────────────── */

const gridStyle: ViewStyle = Platform.OS === 'web'
  ? ({ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', columnGap: 28, rowGap: 6, alignItems: 'start' } as unknown as ViewStyle)
  : { flexDirection: 'row', flexWrap: 'wrap', gap: 28 };

export function WidePantry({ openItemId, onOpenItem }: { openItemId: string | null; onOpenItem: (id: string) => void }) {
  const { mutate } = useStore();
  const toast = useToast();
  const list = useList('pantry');
  const add = useAdder('pantry');
  const [field, setField] = useState('');
  const [find, setFind] = useState('');
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState('');
  const [scanned, setScanned] = useState<{ name: string; on: boolean }[] | null>(null);
  const rows = list?.rows ?? [];
  const shown = useMemo(() => filterRows(rows.map((r) => ({ text: r.payload.text, row: r })), find), [rows, find]);
  const runs = useMemo(() => aisleRuns(shown), [shown]);
  const ids = new Set(rows.map((r) => r.id));
  const picked = selected.filter((id) => ids.has(id));

  const submit = () => { if (add(field)) setField(''); };
  const say = (msg: string) => { setBusy(msg); setTimeout(() => setBusy((cur) => (cur === msg ? '' : cur)), 5000); };

  const scan = async () => {
    if (!ocrSupported()) { say(OCR_UNSUPPORTED); return; }
    try {
      const photos = await pickPhotoUris();
      if (photos.length === 0) return;
      setBusy(`Reading 0/${photos.length}…`);
      const pages = await ocrImages(photos, (d, t) => setBusy(`Reading ${d}/${t}…`)).catch((err: unknown) => {
        const carried = (err as { pages?: string[] })?.pages;
        if (carried?.length) return carried;
        throw err;
      });
      const found = pantryItemsFromPages(pages, rows.map((r) => r.payload.text));
      setBusy('');
      if (found.length === 0) { say('Nothing new found in that photo. Try a straighter, brighter shot.'); return; }
      setScanned(found.map((name) => ({ name, on: true })));
    } catch (err) {
      say(err instanceof Error ? err.message : 'That photo could not be read.');
    }
  };
  const addScanned = () => {
    const have = rows.map((r) => r.payload.text);
    const names: string[] = [];
    for (const x of scanned ?? []) {
      if (!x.on || pantryHas([...have, ...names], x.name)) continue;
      names.push(x.name);
    }
    setScanned(null);
    if (names.length === 0 || !list) return;
    mutate((e) => {
      let prev = rows[rows.length - 1]?.payload.ord ?? null;
      for (const text of names) {
        prev = ordBetween(prev, null);
        e.put({ id: newId(), type: 'reminder', updated: 0, payload: { text, due: null, time: null, done: false, repeat: null, folderId: list.folderId, sectionId: list.sectionId, indent: 0, ord: prev } });
      }
    });
    toast(names.length === 1 ? '1 added to the pantry.' : `${names.length} added to the pantry.`);
  };
  const toggle = (id: string) => setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const deleteSelected = () => {
    if (picked.length === 0) return;
    mutate((e) => { for (const id of picked) e.del(id); });
    setSelected([]);
    toast(picked.length === 1 ? '1 removed.' : `${picked.length} removed.`);
  };

  return (
    <View style={s.root} testID="wide-pantry">
      <PaneHead
        title="Pantry"
        sub={pantrySummary(rows.length)}
        right={(
          <>
            <Pill testID="pantry-scan" label="Scan receipt" onPress={() => void scan()} />
            <Pill testID="pantry-select" label={selecting ? 'Stop selecting' : 'Select'} onPress={() => { setSelecting((v) => !v); setSelected([]); }} />
          </>
        )}
      />
      <Scroll style={s.scroll} contentContainerStyle={s.scrollIn} keyboardShouldPersistTaps="handled">
        <View style={s.toolRow}>
          <Field testID="pantry-add" value={field} onChangeText={setField} placeholder="Add something you have" onSubmitEditing={submit} style={s.toolField} />
          <Pill testID="pantry-add-go" label="Add" onPress={submit} />
          <Field testID="pantry-find" value={find} onChangeText={setFind} placeholder="Find in pantry" style={s.toolField} />
        </View>
        {busy !== '' && <Text testID="pantry-scan-busy" style={s.busy}>{busy}</Text>}
        {scanned && (
          <View style={s.proposal} testID="pantry-proposal">
            <Text style={s.propH}>Found on your receipt · {scanned.length}</Text>
            <Text style={s.propNote}>Untick anything that is not on the shelf.</Text>
            <View style={s.propList}>
              {scanned.map((x, i) => (
                <Pressable key={`${i}-${x.name}`} testID="pantry-scan-row" accessibilityRole="checkbox" accessibilityState={{ checked: x.on }} accessibilityLabel={x.name}
                  onPress={() => setScanned((cur) => cur && cur.map((y, j) => (j === i ? { ...y, on: !y.on } : y)))} style={s.propRow}>
                  <View style={[s.box, x.on && s.boxOn]}>{x.on && <Text style={s.boxTick}>✓</Text>}</View>
                  <Text style={[s.propText, !x.on && s.propOff]}>{x.name}</Text>
                </Pressable>
              ))}
            </View>
            <View style={s.propBar}>
              <Pill testID="pantry-scan-cancel" label="Cancel" onPress={() => setScanned(null)} />
              <Pill testID="pantry-scan-add" primary disabled={!scanned.some((x) => x.on)} label={`Add ${scanned.filter((x) => x.on).length} to the pantry`} onPress={addScanned} />
            </View>
          </View>
        )}
        {rows.length === 0 && <Text style={s.empty}>Nothing on hand yet. Anything listed here is left off the shopping list.</Text>}
        {rows.length > 0 && shown.length === 0 && <Text style={s.empty}>Nothing in the pantry matches that.</Text>}
        <View style={[s.grid, gridStyle]}>
          {runs.map((g) => (
            <View key={g.aisle} style={s.pgroup}>
              <Text testID={`pantry-aisle-${g.aisle}`} style={s.aisle}>{g.aisle}</Text>
              {g.rows.map(({ row }) => (
                <Pressable key={row.id} testID="pantry-row" accessibilityRole="button" accessibilityState={{ selected: openItemId === row.id }}
                  onPress={() => (selecting ? toggle(row.id) : onOpenItem(row.id))}
                  style={(st: PressableStateCallbackType) => [s.prow, openItemId === row.id && s.rowOpen, (st as { hovered?: boolean }).hovered && s.rowHover]}>
                  {selecting && <TickBox round testID="pantry-pick" on={picked.includes(row.id)} label={`Select ${row.payload.text}`} onPress={() => toggle(row.id)} />}
                  <Text style={s.rowText} numberOfLines={2}>{row.payload.text}</Text>
                </Pressable>
              ))}
            </View>
          ))}
        </View>
      </Scroll>
      {selecting && (
        <PickBar prefix="pantry" count={picked.length} onAll={() => setSelected(rows.map((r) => r.id))} onClear={() => setSelected([])} onDelete={deleteSelected} />
      )}
    </View>
  );
}

const s = themed(() => StyleSheet.create({
  root: { flex: 1, minHeight: 0 },
  scroll: { flex: 1 },
  scrollIn: { paddingHorizontal: 24, paddingBottom: 32 },
  column: { maxWidth: 720, width: '100%' },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  addField: { flex: 1 },
  toolRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  toolField: { flexGrow: 1, flexBasis: 220, maxWidth: 340 },
  empty: { color: T.muted, fontSize: 14, marginTop: 18, lineHeight: 20 },
  group: { marginTop: 8 },
  aisle: { color: T.dim, fontSize: 11, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase', marginTop: 12, marginBottom: 4, paddingLeft: 2 },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 40, paddingHorizontal: 8, borderRadius: 8 },
  rowOpen: { backgroundColor: T.surface2 },
  rowHover: { backgroundColor: T.surface },
  rowText: { flex: 1, color: T.text, fontSize: 15 },
  rowDone: { color: T.muted, textDecorationLine: 'line-through' },
  grid: { marginTop: 4 },
  pgroup: { minWidth: 0 },
  prow: { flexDirection: 'row', alignItems: 'center', minHeight: 34, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
  busy: { color: T.dim, fontSize: 14, marginBottom: 8 },
  proposal: { borderWidth: 1, borderColor: T.accent, backgroundColor: T.surface, borderRadius: 12, padding: 16, marginTop: 6, marginBottom: 12, maxWidth: 720 },
  propH: { color: T.text, fontSize: 16, fontWeight: '800' },
  propNote: { color: T.dim, fontSize: 13, marginTop: 2, marginBottom: 6 },
  propList: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 24 },
  propRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6, minWidth: 180 },
  propText: { color: T.text, fontSize: 15 },
  propOff: { color: T.muted, textDecorationLine: 'line-through' },
  propBar: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 10 },
  box: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: T.muted, alignItems: 'center', justifyContent: 'center' },
  boxOn: { backgroundColor: T.accent, borderColor: T.accent },
  boxTick: { color: T.accentInk, fontSize: 12, fontWeight: '700', lineHeight: 14 },
  detailBody: { paddingHorizontal: 16, paddingTop: 8 },
  detailField: { marginTop: 4 },
  detailNote: { color: T.dim, fontSize: 13, lineHeight: 18, marginTop: 12, paddingHorizontal: 0 },
  detailBar: { flexDirection: 'row', gap: 8, justifyContent: 'flex-end', marginTop: 16 },
}));
