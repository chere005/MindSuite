/**
 * One pantry row, opened: its name, its aisle, which of your recipes use it,
 * and the three things you do with it — Ran out (back onto the shopping list),
 * Remove, Rename.
 *
 * A pantry row is "something you have", so it has no tick; tapping it opens
 * this. "Used by" is core's `pantryUsedBy` over every recipe note, each
 * tappable (`onOpenRecipe`).
 *
 * PANE-READY: renders inline, no Modal. Takes the row's id; closes itself
 * through `onClose` after any action.
 */
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ingredientAisle, ingredientParts, isRecipeNote, mergeIntoList, pantryUsedBy, type Rec } from '@calmind/core';
import { useStore } from '../store';
import { themed, T } from '../theme';
import { Field, Pill, Scroll } from '../ui';
import { useToast } from './Toast';
import { ingredientsOf } from '../addToShopping';
import { applyOps, listOf, ranOutOps, renameOp } from '../chefflows';

export type PantryItemProps = {
  rowId: string;
  onClose: () => void;
  /** A tapped "used by" recipe. The host closes this and opens the recipe. */
  onOpenRecipe?: (noteId: string) => void;
};

export function PantryItem({ rowId, onClose, onOpenRecipe }: PantryItemProps) {
  const { recs, mutate } = useStore();
  const toast = useToast();
  const row = listOf(recs, 'pantry')?.rows.find((r) => r.id === rowId);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(row?.payload.text ?? '');
  const used = useMemo(() => {
    if (!row) return [];
    const notes = recs.filter((r): r is Rec<'note'> => r.type === 'note' && !r.deleted && isRecipeNote(r.payload));
    return pantryUsedBy(row.payload.text, notes.map((n) => ({ id: n.id, title: n.payload.title, ingredients: ingredientsOf(n) })));
  }, [recs, row]);

  if (!row) return (
    <View style={s.root}><Text style={s.note}>That pantry item is gone.</Text><View style={s.bar}><Pill label="Close" onPress={onClose} /></View></View>
  );
  const text = row.payload.text;
  const p = ingredientParts(text);
  const aisle = ingredientAisle(p.name || text, p.unit);

  const commit = (ops: Parameters<typeof applyOps>[1], msg: string) => {
    try { mutate((e) => applyOps(e, ops)); } catch { toast('Could not save. Nothing was changed.'); return; }
    toast(msg);
    onClose();
  };
  const ranOut = () => {
    const w = ranOutOps(recs, rowId, mergeIntoList);
    if (!w.ok) { toast('The shopping list is not ready yet. Try again in a moment.'); return; }
    commit(w.ops, `${text} added to the shopping list.`);
  };
  const remove = () => commit([{ kind: 'del', id: rowId }], `${text} removed from the pantry.`);
  const rename = () => {
    const r = renameOp(recs, rowId, name);
    if (!r.ok) { toast(r.why === 'duplicate' ? 'Already in the pantry.' : 'Type a name first.'); return; }
    commit([r.op], 'Renamed.');
  };

  return (
    <View style={s.root} testID="pantry-item">
      <View style={s.head}>
        <Text testID="pantry-item-name" style={s.h1}>{text}</Text>
        <Text style={s.sub}>{aisle}</Text>
      </View>
      <Scroll style={s.body} contentContainerStyle={s.bodyIn}>
        <Text style={s.sec}>{used.length === 0 ? 'Not used by your recipes' : `Used by ${used.length} of your recipes`}</Text>
        {used.map((u) => (
          <Pressable key={u.id} testID="pantry-used" accessibilityRole="button" onPress={() => onOpenRecipe?.(u.id)} style={s.used}>
            <Text style={s.usedTitle}>{u.title}</Text>
            <Text style={s.usedLine}>{u.line}</Text>
          </Pressable>
        ))}
        <Text style={s.note}>Recipes count this as on hand, and shopping lists skip it.</Text>
        {renaming && (
          <View style={s.renameRow}>
            <Field testID="pantry-rename-field" value={name} onChangeText={setName} autoFocus onSubmitEditing={rename} style={s.renameField} />
            <Pill testID="pantry-rename-save" primary compact label="Save" onPress={rename} />
          </View>
        )}
      </Scroll>
      <View style={s.bar}>
        <Pill testID="pantry-ranout" primary label="Ran out: add to shopping" onPress={ranOut} />
        <View style={s.barRow}>
          <Pill testID="pantry-rename" label="Rename" onPress={() => setRenaming((v) => !v)} />
          <Pill testID="pantry-remove" label="Remove" onPress={remove} />
          <Pill testID="pantry-item-close" label="Close" onPress={onClose} />
        </View>
      </View>
    </View>
  );
}

const s = themed(() => StyleSheet.create({
  root: { flexShrink: 1, minHeight: 0 },
  head: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 },
  h1: { color: T.text, fontSize: 22, fontWeight: '800' },
  sub: { color: T.dim, fontSize: 14, marginTop: 2 },
  body: { flexGrow: 0, flexShrink: 1 },
  bodyIn: { paddingHorizontal: 16, paddingBottom: 12 },
  sec: { color: T.gold, fontSize: 13, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 6 },
  used: { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: T.lineSoft },
  usedTitle: { color: T.text, fontSize: 16, fontWeight: '600' },
  usedLine: { color: T.dim, fontSize: 13, marginTop: 1 },
  note: { color: T.dim, fontSize: 13, marginTop: 12, lineHeight: 18 },
  renameRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
  renameField: { flex: 1 },
  bar: { gap: 8, padding: 12, borderTopWidth: 1, borderTopColor: T.line, alignItems: 'stretch' },
  barRow: { flexDirection: 'row', gap: 8, justifyContent: 'flex-end' },
}));
