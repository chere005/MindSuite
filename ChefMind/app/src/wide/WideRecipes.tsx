/**
 * Recipes at desktop size: the table (pick, recipe, folder, ingredients, still
 * to buy) and the bar at its foot.
 *
 * A tap on a row SELECTS that one recipe, as in a file list: it replaces the
 * set, the detail pane shows it, and the bar comes up for it — Cook and Add to
 * shopping list, no tick box needed. The tick adds to the set instead, which is
 * what several recipes are picked FOR: one grocery list (the owner, 2026-11-21:
 * "selections are more for the grocery lists"). Tapping the only selected row
 * again, Clear or Esc deselects. What the bar offers is `recipeBarActions`.
 */
import { Pressable, StyleSheet, type PressableStateCallbackType, Text, View } from 'react-native';
import { useFolds } from '../folds';
import { Chevron } from '../components/Chevron';
import { themed, T } from '../theme';
import { Pill, Scroll } from '../ui';
import { TickBox, okColor } from '../components/chefui';
import { toBuyLabel } from '../chefflows';
import { groupedNotes, pickedNames, recipeBarActions, selectedLabel, type RecipeFact, type RecipeGroup } from '../wideflows';
import { PaneHead, centred, gutterMatch, scrollGutter } from './parts';

// The table's widest: 24 + pick 36 + name 520 + ingredients 112 + still to
// buy 128 + 24. Past it the header, the table and the tray's contents are one
// block centred in the pane rather than a left column beside a dead strip.
const NAME_MAX = 520;
const TABLE_MAX = 24 + 36 + NAME_MAX + 112 + 128 + 24;
const block = centred(TABLE_MAX);

export type WideRecipesProps = {
  title: string;
  groups: RecipeGroup[];
  facts: ReadonlyMap<string, RecipeFact>;
  picked: readonly string[];
  /** The recipe the detail pane shows (`shownRecipe`). */
  shownId: string | null;
  onNew: () => void;
  /** The tick: in or out of the set. */
  onTick: (id: string) => void;
  /** The row: select just this one (or, already alone, deselect). */
  onTap: (id: string) => void;
  onClear: () => void;
  /** Cook the one selected recipe. */
  onCook: () => void;
  /** The selected recipes to the Review (one or several). */
  onShop: () => void;
  pickedTitles: string[];
};

export function WideRecipes(p: WideRecipesProps) {
  const pickedSet = new Set(p.picked);
  // The phone's folder fold state, same key: what is shut there is shut here.
  const folds = useFolds('calmind.foldedFolders.notes');
  const total = groupedNotes(p.groups).length;
  return (
    <View style={s.root} testID="wide-recipes">
      {/* The header and thead keep the list's scrollbar gutter, so the
          columns above line up with the rows below (`gutterMatch`). */}
      <View style={gutterMatch}>
        <PaneHead
          maxWidth={TABLE_MAX}
          sub={`${p.title} · ${total} ${total === 1 ? 'recipe' : 'recipes'}`}
          right={(
            <>
              <Pill testID="recipes-new" primary label="New recipe" onPress={p.onNew} />
            </>
          )}
        />
        <View style={[s.thead, block]}>
          <View style={s.cPick} />
          <Text style={[s.th, s.cName]}>Recipe</Text>
          <Text style={[s.th, s.cIng]} numberOfLines={1}>Ingredients</Text>
          <Text style={[s.th, s.cBuy]} numberOfLines={1}>Still to buy</Text>
        </View>
      </View>
      <Scroll style={[s.list, scrollGutter]} contentContainerStyle={s.listIn}>
        <View style={block}>
          {total === 0 && p.groups.length === 0 && <Text style={s.empty}>No recipes here yet.</Text>}
          {p.groups.map((g) => {
            const open = folds.isOpen(g.folder.id);
            return (
              <View key={g.folder.id}>
                <Pressable
                  testID={`wide-fold-${g.folder.payload.name}`}
                  accessibilityRole="button"
                  accessibilityLabel={`${g.folder.payload.name}, ${open ? 'collapse' : 'expand'}`}
                  accessibilityState={{ expanded: open }}
                  onPress={() => folds.toggle(g.folder.id)}
                  onLongPress={() => folds.foldAll(p.groups.map((x) => x.folder.id), open)}
                  style={s.head}
                >
                  <View style={s.chev}><Chevron open={open} color={T.text} /></View>
                  <View style={[s.dot, { backgroundColor: g.folder.payload.color }]} />
                  <Text style={s.headName} numberOfLines={1}>{g.folder.payload.name}</Text>
                  <Text style={s.headCount}>{g.notes.length}</Text>
                </Pressable>
                {open && g.notes.map((n) => {
                  const f = p.facts.get(n.id);
                  const on = pickedSet.has(n.id);
                  return (
                    <Pressable
                      key={n.id}
                      testID="recipe-row"
                      accessibilityRole="button"
                      accessibilityState={{ selected: on }}
                      onPress={() => p.onTap(n.id)}
                      style={(st: PressableStateCallbackType) => [s.row, (st as { hovered?: boolean }).hovered && s.rowHover, on && s.rowPicked, p.shownId === n.id && s.rowShown]}
                    >
                      <View style={s.cPick}>
                        <TickBox testID={`wide-pick-${n.payload.title}`} on={on} label={`Pick ${n.payload.title}`} onPress={() => p.onTick(n.id)} />
                      </View>
                      <Text style={[s.td, s.cName, s.name]} numberOfLines={1}>{n.payload.title}</Text>
                      <Text style={[s.td, s.cIng, s.num]}>{f && f.buy !== null ? f.ingredients : '–'}</Text>
                      <Text style={[s.td, s.cBuy, f?.buy === 0 && s.have]} numberOfLines={1}>{f && f.buy !== null ? toBuyLabel(f.buy) : '–'}</Text>
                    </Pressable>
                  );
                })}
              </View>
            );
          })}
        </View>
      </Scroll>
      {p.picked.length > 0 && (
        <View style={[s.tray, gutterMatch]} testID="recipes-tray">
          <View style={[s.trayIn, block]}>
            <View style={s.trayText}>
              <Text style={s.trayCount}>{p.picked.length === 1 ? p.pickedTitles[0] ?? selectedLabel(1) : selectedLabel(p.picked.length)}</Text>
              <Text style={s.trayNames} numberOfLines={1}>{p.picked.length === 1 ? selectedLabel(1) : pickedNames(p.pickedTitles)}</Text>
            </View>
            <Pill testID="tray-clear" label="Clear" onPress={p.onClear} />
            {/* Primary last, nearest the right edge — the order the phone bar keeps. */}
            {recipeBarActions(p.picked.length).slice().reverse().map((a) => (
              <Pill
                key={a.id}
                testID={a.id === 'cook' ? 'tray-cook' : 'tray-shop'}
                primary={a.primary}
                label={a.label}
                onPress={a.id === 'cook' ? p.onCook : p.onShop}
              />
            ))}
          </View>
        </View>
      )}
    </View>
  );
}

const s = themed(() => StyleSheet.create({
  root: { flex: 1, minHeight: 0 },
  thead: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 24, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: T.line },
  th: { color: T.muted, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  list: { flex: 1 },
  listIn: { paddingBottom: 16 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 24, minHeight: 46, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: T.lineSoft },
  rowPicked: { backgroundColor: T.accentSoft },
  // The one the detail pane shows: an accent edge, so it is findable among several ticked.
  rowShown: { borderLeftWidth: 3, borderLeftColor: T.accent, paddingLeft: 21 },
  rowHover: { backgroundColor: T.surface },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 24, minHeight: 40, backgroundColor: T.surface, borderBottomWidth: 1, borderBottomColor: T.lineSoft },
  chev: { width: 20, alignItems: 'center' },
  dot: { width: 10, height: 10, borderRadius: 5 },
  headName: { color: T.text, fontSize: 15, fontWeight: '700', flexShrink: 1 },
  headCount: { color: T.muted, fontSize: 13, fontVariant: ['tabular-nums'] },
  cPick: { width: 36 },
  // Capped so the numbers stay a reading distance from the names on a wide window
  // (the owner, 2026-11-21: "keep reasonable distance between columns").
  cName: { flex: 1, minWidth: 120, maxWidth: NAME_MAX, paddingRight: 12 },
  cIng: { width: 112, textAlign: 'right', paddingRight: 12 },
  cBuy: { width: 128, textAlign: 'right' },
  td: { color: T.text, fontSize: 15 },
  name: { fontWeight: '600' },
  dim: { color: T.dim, fontSize: 14 },
  num: { color: T.dim, fontVariant: ['tabular-nums'] },
  have: { color: okColor(), fontWeight: '600' },
  empty: { color: T.muted, fontSize: 14, padding: 24, lineHeight: 20 },
  // The bar spans the pane; what is in it lines up with the table above.
  tray: { paddingVertical: 12, borderTopWidth: 1, borderTopColor: T.line, backgroundColor: T.surface },
  trayIn: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 24 },
  trayText: { flex: 1, minWidth: 0 },
  trayCount: { color: T.text, fontSize: 15, fontWeight: '700' },
  trayNames: { color: T.dim, fontSize: 13, marginTop: 1 },
}));
