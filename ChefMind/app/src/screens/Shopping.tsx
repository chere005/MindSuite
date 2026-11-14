/**
 * The shopping list, and the pantry beside it (the owner, 2026-08-21 / 2026-08-22).
 *
 * ONE SCREEN, TWO TABS. Both are a flat list of things named in a line of
 * text, both are ordinary `reminder` records, and the only difference between
 * them is which folder flag they read — so they are one component taking a
 * flag rather than two files that have to be kept in step. The pantry is a
 * list of what you HAVE; the shopping list is what you need. See the `pantry`
 * flag's own comment in core's types.ts.
 *
 * The shopping list fills from the Recipes tab: pick several in edit mode and
 * their ingredients arrive here, combined by core's shoppingLines — which
 * leaves out anything already in the pantry. Typing straight into the field at
 * the top works on both, because the thing you forgot is never in a recipe.
 *
 * BY AISLE, not by the order you dragged them (the owner, 2026-08-22: "shopping
 * should separate ingredients by the categories you might find them in the
 * grocery store"). A shopping list is walked, so the useful order is the route
 * through the shop. Dragging still works and still writes `ord` — but the
 * display sorts by aisle FIRST, so a drag reorders within its own aisle and a
 * row dragged into another one returns to its own. That is deliberate: the
 * aisle is derived from what the row says, so moving the row cannot change it,
 * and pretending otherwise would mean a row that silently snapped back with no
 * reason given.
 */
import { memo, useMemo, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View, type PanResponderInstance } from 'react-native';
import { AISLES, byRecOrd, duplicateItem, ingredientAisle, ingredientParts, newId, ordBetween, pantryHas, pantryItemsFromPages, type Aisle, type Rec } from '@calmind/core';
import { useStore } from '../store';
import { themed, T } from '../theme';
import { TopBar } from '../chrome';
import { useRowDrag } from '../components/rowdrag';
import { useSwipeLeft } from '../components/swiperow';
import { EditExit } from '../components/EditExit';
import { PickBar } from '../components/PickBar';
import { useToast } from '../components/Toast';
import { OCR_UNSUPPORTED, ocrImages, ocrSupported } from '../components/ocr';
import { CircleBtn, ConfirmDelete, Field, Pill, Scroll, WebHitSlop } from '../ui';

type Row = Rec<'reminder'>;

/** A row lifted from one index and set down at another. */
function moveAt<T>(rows: T[], from: number, to: number): T[] {
  const out = rows.slice();
  const [row] = out.splice(from, 1);
  if (row === undefined) return rows;
  out.splice(to, 0, row);
  return out;
}

/** The aisle a row's text belongs to — its ingredient name and its unit, the
 *  same two things core files a recipe line by. */
function aisleOf(text: string): Aisle {
  const p = ingredientParts(text);
  return ingredientAisle(p.name || text, p.unit);
}

const AISLE_INDEX = new Map<Aisle, number>(AISLES.map((a, i) => [a, i]));

type Kind = 'shopping' | 'pantry';

const COPY: Record<Kind, { title: string; add: string; empty: string; prefix: string }> = {
  shopping: {
    title: 'Shopping',
    add: 'Add an item',
    empty: 'Nothing to buy. Pick recipes in the Recipes tab to fill this in.',
    prefix: 'shopping',
  },
  pantry: {
    title: 'Pantry',
    add: 'Add something you have',
    // Says what the list DOES, because an empty pantry is indistinguishable
    // from a broken one otherwise — and the consequence (nothing is skipped)
    // is the thing worth knowing before you go shopping.
    empty: 'Nothing on hand yet. Anything listed here is left off the shopping list.',
    prefix: 'pantry',
  },
};

export function Shopping() { return <FlagList kind="shopping" />; }
export function Pantry() { return <FlagList kind="pantry" />; }

function FlagList({ kind }: { kind: Kind }) {
  const { recs, mutate } = useStore();
  const toast = useToast();
  const copy = COPY[kind];
  const [field, setField] = useState('');
  const [pageEdit, setPageEdit] = useState(false);
  /**
   * The rows picked in edit mode — for deleting several at once, and for
   * Refresh (the owner, 2026-08-22). Edit mode here used to mean reordering and
   * nothing else; it means both now, which is what makes one gesture on this
   * screen match the one the Recipes tab already had.
   *
   * Cleared whenever edit mode ends, so coming back never arrives holding a
   * selection nobody can see.
   */
  const [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const swipe = useSwipeLeft();
  /**
   * A hold JUST HAPPENED, so the click it ends with is not a tap.
   *
   * react-native-web's Pressable fires `onPress` on the click that follows a
   * long press — the timer and the click are independent — so holding a row
   * turned edit mode on and then immediately opened the row's rename field
   * over it, which reads as "there is no edit mode here" (the owner, 2026-09-16).
   * Native does not do this, which is exactly why it was easy to miss.
   *
   * A ref, not state: it must be true for the click that is already on its
   * way, and a re-render is neither needed nor wanted in between.
   */
  const justHeld = useRef(false);
  /**
   * The pantry's 📷 — the owner, 2026-10-01: "add a button to do ocr to look at a
   * receipt or list of ingredients to add them to the pantry". The same OCR
   * the recipe importer reads cards with; core's `pantryItemsFromPages` turns
   * the pages into names. What it finds is a PROPOSAL, shown with every row
   * ticked, because a receipt always carries something that is not food —
   * the store's name, a bag charge — and unticking it is cheaper than
   * deleting it from the pantry afterwards.
   */
  const [scanBusy, setScanBusy] = useState('');
  const [scanned, setScanned] = useState<{ name: string; on: boolean }[] | null>(null);

  const { folder, section, rows, groups } = useMemo(() => {
    const f = recs.find(
      (r): r is Rec<'folder'> => r.type === 'folder' && !r.deleted && r.payload[kind] === true,
    );
    const sec = f
      ? recs.filter((r): r is Rec<'section'> => r.type === 'section' && !r.deleted && r.payload.folderId === f.id).sort(byRecOrd)[0]
      : undefined;
    const all = sec
      ? recs.filter((r): r is Row => r.type === 'reminder' && !r.deleted && r.payload.sectionId === sec.id).sort(byRecOrd)
      : [];
    const list = all;
    // Aisle first, stored order within it. A stable sort is what makes the
    // second half of that true — Array.prototype.sort has been stable since
    // ES2019, and the list arrives already sorted by ord.
    const withAisle = list.map((r) => ({ r, aisle: aisleOf(r.payload.text) }));
    const ordered = withAisle
      .slice()
      .sort((a, b) => (AISLE_INDEX.get(a.aisle) ?? 99) - (AISLE_INDEX.get(b.aisle) ?? 99));
    // Runs, not a map: the display walks them in order and each needs its
    // heading drawn once, above the first row that belongs to it.
    const runs: { aisle: Aisle; rows: Row[] }[] = [];
    for (const { r, aisle } of ordered) {
      const last = runs[runs.length - 1];
      if (last && last.aisle === aisle) last.rows.push(r);
      else runs.push({ aisle, rows: [r] });
    }
    return { folder: f, section: sec, rows: ordered.map((x) => x.r), groups: runs };
  }, [recs, kind]);

  /**
   * Reordering writes a key per row from its new neighbour, walking forward —
   * exactly as the recipes-to-shopping import does, and for the same reason:
   * ordBetween(prev, null) is deterministic, so asking it the same question
   * for every row hands them all one key.
   *
   * It runs over the DISPLAY order, which is already aisle-major, so the keys
   * it writes agree with what is on screen and a drag inside an aisle lands
   * where it was dropped.
   */
  const drag = useRowDrag(rows.length, (from, to) => {
    swipe.clear();
    const moved = moveAt(rows, from, to);
    // Every row is on screen, so the walk below sees every row: nothing can
    // be left holding a stale key the way hidden rows once could.
    const next = moved;
    mutate((e) => {
      let prev: string | null = null;
      for (const r of next) {
        prev = ordBetween(prev, null);
        if (r.payload.ord !== prev) e.put({ ...r, payload: { ...r.payload, ord: prev } });
      }
    });
  }, { keyOf: (i) => rows[i]?.id ?? null });

  const add = () => {
    const text = field.trim();
    setField('');
    if (!text || !folder || !section) return;
    // The pantry holds each ingredient once, however the quantity was typed.
    if (kind === 'pantry' && pantryHas(rows.map((r) => r.payload.text), text)) { toast('Already in the pantry.'); return; }
    const last = rows[rows.length - 1];
    mutate((e) =>
      e.put({
        id: newId(),
        type: 'reminder',
        updated: 0,
        payload: {
          text, due: null, time: null, done: false, repeat: null,
          folderId: folder.id, sectionId: section.id, indent: 0,
          ord: ordBetween(last?.payload.ord ?? null, null),
        },
      }),
    );
  };

  const say = (msg: string) => {
    setScanBusy(msg);
    setTimeout(() => setScanBusy((cur) => (cur === msg ? '' : cur)), 5000);
  };

  const scanPhotos = async () => {
    // Asked before the picker opens, as the recipe importer does.
    if (!ocrSupported()) { say(OCR_UNSUPPORTED); return; }
    try {
      const ImagePicker = await import('expo-image-picker');
      const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: true, quality: 0.9 });
      if (picked.canceled || picked.assets.length === 0) return;
      setScanBusy(`Reading 0/${picked.assets.length}…`);
      const pages = await ocrImages(picked.assets.map((a) => a.uri), (d, t) => setScanBusy(`Reading ${d}/${t}…`))
        .catch((err: unknown) => {
          // A partial failure still carries the pages that DID read.
          const carried = (err as { pages?: string[] })?.pages;
          if (carried?.length) return carried;
          throw err;
        });
      const found = pantryItemsFromPages(pages, rows.map((r) => r.payload.text));
      setScanBusy('');
      if (found.length === 0) { say('Nothing new found in that photo — try a straighter, brighter shot.'); return; }
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
    if (names.length === 0 || !folder || !section) return;
    mutate((e) => {
      let prev = rows[rows.length - 1]?.payload.ord ?? null;
      for (const text of names) {
        // Walked forward, one key per row — ordBetween(prev, null) asked the
        // same question twice answers it the same way twice.
        prev = ordBetween(prev, null);
        e.put({
          id: newId(), type: 'reminder', updated: 0,
          payload: { text, due: null, time: null, done: false, repeat: null, folderId: folder.id, sectionId: section.id, indent: 0, ord: prev },
        });
      }
    });
    toast(names.length === 1 ? '1 added to the pantry.' : `${names.length} added to the pantry.`);
  };

  const commitEdit = (r: Row) => {
    const text = editText.trim();
    setEditing(null);
    // An emptied line deletes it, the way an empty add adds nothing.
    if (text === '') mutate((e) => e.del(r.id));
    else if (kind === 'pantry' && pantryHas(rows.map((x) => x.payload.text), text, rows.findIndex((x) => x.id === r.id))) toast('Already in the pantry.');
    else if (text !== r.payload.text) mutate((e) => e.put({ ...r, payload: { ...r.payload, text } }));
  };

  /* Edit mode and the selection are separate things now, exactly as they are
   * on Recipes: leaving edit mode puts the grips away and leaves what you
   * picked alone. Clear is in the bar, an inch from the count. */
  const endEdit = () => setPageEdit(false);
  const toggleSelected = (id: string) =>
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  /**
   * Select all — and INTO edit mode from outside it, which is the one way this
   * differs from the same button on Recipes (the owner, 2026-08-22: "a select all
   * button that goes into edit mode with all things selected"). Tidying the
   * whole list is the common case here, so the two presses that would have
   * taken are one.
   *
   * It still toggles: pressing it with everything already picked clears the
   * lot rather than doing nothing twice.
   */
  /**
   * All means ALL. It used to un-pick when everything was already picked —
   * the top-bar circle was one control with two meanings — and Clear is its
   * own button beside it in the bar now (the owner, 2026-09-16).
   */
  const selectAll = () => {
    setPageEdit(true);
    setSelected(rows.map((r) => r.id));
  };

  const deleteSelected = () => {
    const ids = selected.slice();
    if (ids.length === 0) return;
    mutate((e) => { for (const id of ids) e.del(id); });
    setSelected([]);
    toast(ids.length === 1 ? '1 removed.' : `${ids.length} removed.`);
  };

  /*
   * NO REFRESH, AND NO BROOM. The owner, 2026-09-16 named this bar exactly: "N
   * Selected, All, Clear, space, Delete". Refresh (core's `recombineLines`,
   * which still has its own suite) had no other way in, and the broom cleared
   * ticks that no longer exist — both went with the tick, and select-and-
   * delete is how a bought row leaves the list now.
   */

  // The flat display index of a row, which is what the drag hook counts in.
  // One pass per list change, not a scan per row per render.
  const idxById = useMemo(() => new Map(rows.map((r, i) => [r.id, i])), [rows]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  /**
   * PERFORMANCE: every pointermove of a drag re-renders this component (the
   * drag hook keeps its position in state), and a tick re-renders it too. The
   * rows are memoised (`ShopRow`) so a move or a tick re-renders only the rows
   * whose own props changed; what makes that possible is that everything a row
   * calls is reached through ONE stable `h` that reads the latest closures from
   * a ref, so no row's props change just because this render made new
   * closures.
   */
  const live = useRef<LiveRow>(null as unknown as LiveRow);
  live.current = {
    drag, swipe, justHeld, toggleSelected, setPageEdit, setEditText, commitEdit,
    startEdit: (r) => { setEditing(r.id); setEditText(r.payload.text); },
    dup: (id) => {
      const res = duplicateItem(recs, id, newId);
      if (!('error' in res)) mutate((e) => res.put.forEach((x) => e.put(x)));
    },
    del: (id) => mutate((e) => e.del(id)),
    swipeDel: (id) => { swipe.clear(); mutate((e) => e.del(id)); },
  };
  const h = useMemo<RowHandlers>(() => {
    const regs = new Map<number, (ref: View | null) => void>();
    return {
      reg: (i) => {
        let f = regs.get(i);
        if (!f) { f = (ref) => live.current.drag.registerRow(i)(ref); regs.set(i, f); }
        return f;
      },
      grip: (i) => live.current.drag.handleFor(i),
      swipeHandlers: (id) => live.current.swipe.handlersFor(id),
      onPick: (id) => {
        const l = live.current;
        if (l.justHeld.current) { l.justHeld.current = false; return; }
        if (l.swipe.justSwiped()) return;
        l.toggleSelected(id);
      },
      onHold: () => { const l = live.current; l.justHeld.current = true; l.setPageEdit(true); },
      onRowPress: (r) => {
        const l = live.current;
        if (l.justHeld.current) { l.justHeld.current = false; return; }
        if (l.swipe.justSwiped()) return;
        if (l.swipe.swiped) { l.swipe.clear(); return; }
        // A tap EDITS, in edit mode as much as out of it — the dot beside it
        // is what picks, so the row keeps one meaning (the owner, 2026-09-16).
        l.startEdit(r);
      },
      setEditText: (t) => live.current.setEditText(t),
      commitEdit: (r) => live.current.commitEdit(r),
      dup: (id) => live.current.dup(id),
      del: (id) => live.current.del(id),
      swipeDel: (id) => live.current.swipeDel(id),
    };
  }, []);

  return (
    <View style={s.page}>
      {/*
        NO CONTROLS. The pencil is gone (the owner, 2026-09-16: "get rid of the
        edit button on the top bar") — holding a row is the way in, which is
        the gesture Recipes already had and the one this screen now shares.
        The broom and the Show-completed switch went with the tick.
      */}
      <TopBar title={copy.title} />
      <Scroll contentContainerStyle={s.scrollWrap} scrollEnabled={drag.dragIdx === null}>
        <EditExit
          active={pageEdit || swipe.swiped !== null}
          onExit={() => { if (swipe.swiped !== null) swipe.clear(); else endEdit(); }}
          style={s.scroll}
        >
          <View style={s.addRow}>
            <Field
              testID={`${copy.prefix}-add`}
              value={field}
              onChangeText={setField}
              placeholder={copy.add}
              onSubmitEditing={add}
              style={s.addField}
            />
            {kind === 'pantry' && (
              <CircleBtn testID="pantry-scan" glyph="📷" label="Read a receipt or list" size={26} onPress={() => void scanPhotos()} />
            )}
            <CircleBtn testID={`${copy.prefix}-add-go`} glyph="+" label="Add" color={T.accent} size={26} onPress={add} />
          </View>
          {scanBusy !== '' && <Text testID="pantry-scan-busy" style={s.busy}>{scanBusy}</Text>}

          {rows.length === 0 && <Text style={s.empty}>{copy.empty}</Text>}

          {groups.map((g) => (
            <View key={g.aisle}>
              {/* One heading per run. Drawn even when a single row is under
                  it: a list where some rows wear an aisle and others do not
                  reads as a bug rather than as a tidy shortcut. */}
              <Text testID={`${copy.prefix}-aisle-${g.aisle}`} style={s.aisle}>{g.aisle}</Text>
              {g.rows.map((r) => {
                const i = idxById.get(r.id) ?? -1;
                // A SELECTOR DOT, ALWAYS, on both lists (the owner, 2026-09-16:
                // "the Pantry and Shopping page should now have the same
                // always visible selector dots"): a bought row leaves by being
                // selected and deleted, one idea instead of two.
                return (
                  <ShopRow
                    key={r.id}
                    r={r}
                    idx={i}
                    prefix={copy.prefix}
                    pageEdit={pageEdit}
                    picked={selectedSet.has(r.id)}
                    slotHere={drag.slot === i}
                    dragDy={drag.dragIdx === i ? drag.dragDy : null}
                    editing={editing === r.id}
                    editText={editing === r.id ? editText : ''}
                    swiped={swipe.swiped === r.id}
                    h={h}
                  />
                );
              })}
            </View>
          ))}
          {drag.slot === rows.length && <View style={s.dropLine} />}
          {pageEdit && <Pressable style={s.editBackdropFill} onPress={endEdit} />}
        </EditExit>
      </Scroll>
      {/* The Recipes tab's bar, the same component, ending at Delete: on these
          two lists the selection IS for deleting, so there is nothing to put
          to the right of it. */}
      {/* ALWAYS SHOWING (the owner, 2026-09-16), on all three lists. It was the
          only thing that said how many were picked, and it appeared only once
          something was — so the count you wanted before choosing was the one
          thing you could not see, and All was behind a mode. */}
      {scanned && (
        <Modal transparent animationType="fade" onRequestClose={() => setScanned(null)}>
          <Pressable style={s.backdrop} onPress={() => setScanned(null)}>
            <Pressable style={s.card} onPress={() => {}}>
              <Text style={s.h2}>Add to the pantry</Text>
              <Text style={s.cardNote}>Untick anything that is not on the shelf.</Text>
              <Scroll style={s.cardList}>
                {scanned.map((x, i) => (
                  <Pressable
                    key={`${i}-${x.name}`}
                    testID="pantry-scan-row"
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: x.on }}
                    accessibilityLabel={x.name}
                    onPress={() => setScanned((cur) => cur && cur.map((y, j) => (j === i ? { ...y, on: !y.on } : y)))}
                    style={s.scanRow}
                  >
                    <View style={[s.box, s.boxCircle, x.on && s.boxOn]}>
                      {x.on && <Text style={s.boxTick}>✓</Text>}
                    </View>
                    <Text style={[s.rowText, !x.on && s.scanOff]}>{x.name}</Text>
                  </Pressable>
                ))}
              </Scroll>
              <View style={s.cardBar}>
                <Pill testID="pantry-scan-cancel" label="Cancel" onPress={() => setScanned(null)} />
                <Pill
                  testID="pantry-scan-add"
                  primary
                  label={`Add ${scanned.filter((x) => x.on).length}`}
                  disabled={!scanned.some((x) => x.on)}
                  onPress={addScanned}
                />
              </View>
            </Pressable>
          </Pressable>
        </Modal>
      )}
      {(
        <PickBar
          prefix={copy.prefix}
          count={selected.length}
          onAll={selectAll}
          onClear={() => setSelected([])}
          onDelete={deleteSelected}
        />
      )}
    </View>
  );
}

type LiveRow = {
  drag: ReturnType<typeof useRowDrag>;
  swipe: ReturnType<typeof useSwipeLeft>;
  justHeld: { current: boolean };
  toggleSelected: (id: string) => void;
  setPageEdit: (v: boolean) => void;
  setEditText: (t: string) => void;
  commitEdit: (r: Row) => void;
  startEdit: (r: Row) => void;
  dup: (id: string) => void;
  del: (id: string) => void;
  swipeDel: (id: string) => void;
};

/** Stable handlers a row reaches its screen through (see `live` in FlagList). */
type RowHandlers = {
  reg: (i: number) => (ref: View | null) => void;
  grip: (i: number) => PanResponderInstance['panHandlers'];
  swipeHandlers: (id: string) => PanResponderInstance['panHandlers'];
  onPick: (id: string) => void;
  onHold: () => void;
  onRowPress: (r: Row) => void;
  setEditText: (t: string) => void;
  commitEdit: (r: Row) => void;
  dup: (id: string) => void;
  del: (id: string) => void;
  swipeDel: (id: string) => void;
};

type ShopRowProps = {
  r: Row;
  idx: number;
  prefix: string;
  pageEdit: boolean;
  picked: boolean;
  /** The drag's drop line sits above this row. */
  slotHere: boolean;
  /** Non-null only on the row being dragged: its travel. */
  dragDy: number | null;
  editing: boolean;
  editText: string;
  swiped: boolean;
  h: RowHandlers;
};

/** One list row. Memoised: a pointermove or a tick re-renders only the rows whose props moved. */
const ShopRow = memo(function ShopRow({ r, idx, prefix, pageEdit, picked, slotHere, dragDy, editing, editText, swiped, h }: ShopRowProps) {
  return (
    <View>
      {slotHere && <View style={s.dropLine} />}
      <View
        ref={h.reg(idx)}
        {...(pageEdit ? {} : h.swipeHandlers(r.id))}
        style={[s.row, s.rowNoSelect, dragDy !== null && { opacity: 0.55, transform: [{ translateY: dragDy }] }]}
      >
        <View
          testID={`${prefix}-grip`}
          {...(pageEdit ? h.grip(idx) : {})}
          style={[s.grip, !pageEdit && s.gripHidden]}
          pointerEvents={pageEdit ? 'auto' : 'none'}
          hitSlop={6}
        >
          <WebHitSlop slop={6} />
          <Text style={s.gripText}>≡</Text>
        </View>
        <Pressable
          testID={`${prefix}-pick`}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: picked }}
          accessibilityLabel={`Select ${r.payload.text}`}
          onPress={() => h.onPick(r.id)}
          onLongPress={h.onHold}
          delayLongPress={350}
          hitSlop={8}
          style={s.boxWrap}
        >
          <WebHitSlop slop={8} />
          <View style={[s.box, s.boxCircle, picked && s.boxOn]}>
            {picked && <Text style={s.boxTick}>✓</Text>}
          </View>
        </Pressable>
        {editing ? (
          <Field
            testID={`${prefix}-edit-field`}
            value={editText}
            onChangeText={h.setEditText}
            autoFocus
            onBlur={() => h.commitEdit(r)}
            onSubmitEditing={() => h.commitEdit(r)}
            style={s.editField}
          />
        ) : (
          <Pressable
            testID={`${prefix}-row`}
            style={s.rowBody}
            onPress={() => h.onRowPress(r)}
            // The way into edit mode, now that the pencil is gone from the bar above.
            onLongPress={h.onHold}
            delayLongPress={350}
          >
            <Text style={s.rowText}>{r.payload.text}</Text>
          </Pressable>
        )}
        {/* Duplicate and delete, the pair Recipes puts in edit mode beside its grip. */}
        {pageEdit && (
          <>
            <CircleBtn testID={`${prefix}-dup`} glyph="⧉" label="Duplicate" size={22} onPress={() => h.dup(r.id)} />
            <ConfirmDelete testID={`${prefix}-del`} onDelete={() => h.del(r.id)} />
          </>
        )}
        {swiped && !pageEdit && (
          <ConfirmDelete testID={`${prefix}-swipedel`} onDelete={() => h.swipeDel(r.id)} />
        )}
      </View>
    </View>
  );
});

const s = themed(() => StyleSheet.create({
  page: { flex: 1, backgroundColor: T.bg },
  scrollWrap: { flexGrow: 1 },
  scroll: { paddingHorizontal: 12, paddingBottom: 24, flexGrow: 1 },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  addField: { flex: 1 },
  empty: { color: T.muted, fontSize: 14, marginTop: 18, textAlign: 'center', lineHeight: 20 },
  // Quieter than a row and clearly above one: this is a signpost in a shop,
  // not a thing to buy, so it must never be mistaken for a line item.
  aisle: {
    color: T.dim, fontSize: 11, fontWeight: '700', letterSpacing: 0.8,
    textTransform: 'uppercase', marginTop: 14, marginBottom: 2, paddingLeft: 2,
  },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 7, gap: 2 },
  /* a swipe row permits only VERTICAL panning, so a horizontal swipe never scrolls the list under it on web — the owner, 2026-09-06 */
  rowNoSelect: { userSelect: 'none', touchAction: 'pan-y' } as import('react-native').ViewStyle,
  grip: { width: 22, alignItems: 'center' },
  gripHidden: { opacity: 0, width: 0 },
  gripText: { color: T.muted, fontSize: 16 },
  boxWrap: { paddingRight: 10, paddingLeft: 2 },
  box: {
    width: 20, height: 20, borderRadius: 5,
    borderWidth: 2, borderColor: T.muted,
    alignItems: 'center', justifyContent: 'center',
  },
  // ROUND in edit mode, square out of it. A checkbox is a thing you tick as
  // you shop; a circle is a thing you select. The shape is the only signal
  // that the control's meaning has changed, so it has to be unmistakable at a
  // glance — 20pt of it, at arm's length, in a shop.
  boxCircle: { borderRadius: 10 },
  boxOn: { backgroundColor: T.accent, borderColor: T.accent },
  boxTick: { color: T.accentInk, fontSize: 12, fontWeight: '700', lineHeight: 14 },
  rowBody: { flex: 1, paddingVertical: 2 },
  rowText: { color: T.text, fontSize: 16 },
  // Struck through and dimmed, kept in place: a bought item that JUMPS to the
  // bottom takes your eye off the shelf you are standing at.
  editField: { flex: 1 },
  dropLine: { height: 2, backgroundColor: T.accent, borderRadius: 1, marginVertical: 2 },
  editBackdropFill: { flexGrow: 1, minHeight: 160 },
  busy: { color: T.dim, fontSize: 14, marginBottom: 8 },
  backdrop: { flex: 1, backgroundColor: '#000a', alignItems: 'center', justifyContent: 'center', padding: 16 },
  card: { width: '100%', maxWidth: 440, maxHeight: '85%', backgroundColor: T.surface, borderWidth: 1, borderColor: T.line, borderRadius: 16, padding: 16, gap: 8 },
  h2: { color: T.text, fontSize: 18, fontWeight: '700' },
  cardNote: { color: T.dim, fontSize: 13 },
  cardList: { flexGrow: 0 },
  scanRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 7 },
  scanOff: { color: T.muted, textDecorationLine: 'line-through' },
  cardBar: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 4 },
}));
