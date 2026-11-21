/**
 * Recipes at desktop size: the table (pick, recipe, folder, ingredients, still
 * to buy) and the tray of what is picked. Clicking a row opens it in the detail
 * pane; the tick picks without opening.
 */
import { Pressable, StyleSheet, type PressableStateCallbackType, Text, View } from 'react-native';
import type { Rec } from '@calmind/core';
import { themed, T } from '../theme';
import { Pill, Scroll } from '../ui';
import { TickBox, okColor } from '../components/chefui';
import { toBuyLabel } from '../chefflows';
import { pickedNames, type RecipeFact } from '../wideflows';
import { PaneHead } from './parts';

export type WideRecipesProps = {
  title: string;
  rows: Rec<'note'>[];
  facts: ReadonlyMap<string, RecipeFact>;
  folderName: (folderId: string) => string;
  picked: readonly string[];
  openId: string | null;
  canMake: boolean;
  onCanMake: () => void;
  onNew: () => void;
  onPick: (id: string) => void;
  onOpen: (id: string) => void;
  onClear: () => void;
  onCook: () => void;
  onShop: () => void;
  pickedTitles: string[];
};

export function WideRecipes(p: WideRecipesProps) {
  const pickedSet = new Set(p.picked);
  return (
    <View style={s.root} testID="wide-recipes">
      <PaneHead
        title={p.title}
        sub={`${p.rows.length} ${p.rows.length === 1 ? 'recipe' : 'recipes'}`}
        right={(
          <>
            <Pressable testID="recipes-canmake" accessibilityRole="button" accessibilityState={{ selected: p.canMake }} onPress={p.onCanMake} style={[s.chip, p.canMake && s.chipOn]}>
              <Text style={[s.chipText, p.canMake && s.chipTextOn]}>Can make now</Text>
            </Pressable>
            <Pill testID="recipes-new" primary label="New recipe" onPress={p.onNew} />
          </>
        )}
      />
      <View style={s.thead}>
        <View style={s.cPick} />
        <Text style={[s.th, s.cName]}>Recipe</Text>
        <Text style={[s.th, s.cFolder]}>Folder</Text>
        <Text style={[s.th, s.cIng]} numberOfLines={1}>Ingredients</Text>
        <Text style={[s.th, s.cBuy]} numberOfLines={1}>Still to buy</Text>
      </View>
      <Scroll style={s.list} contentContainerStyle={s.listIn}>
        {p.rows.length === 0 && (
          <Text style={s.empty}>{p.canMake ? 'Nothing you can make right now. Turn off Can make now to see every recipe.' : 'No recipes here yet.'}</Text>
        )}
        {p.rows.map((n) => {
          const f = p.facts.get(n.id);
          const on = pickedSet.has(n.id);
          return (
            <Pressable
              key={n.id}
              testID="recipe-row"
              accessibilityRole="button"
              accessibilityState={{ selected: p.openId === n.id }}
              onPress={() => p.onOpen(n.id)}
              style={(st: PressableStateCallbackType) => [s.row, on && s.rowPicked, p.openId === n.id && s.rowOpen, (st as { hovered?: boolean }).hovered && s.rowHover]}
            >
              <View style={s.cPick}>
                <TickBox testID={`wide-pick-${n.payload.title}`} on={on} label={`Pick ${n.payload.title}`} onPress={() => p.onPick(n.id)} />
              </View>
              <Text style={[s.td, s.cName, s.name]} numberOfLines={1}>{n.payload.title}</Text>
              <Text style={[s.td, s.cFolder, s.dim]} numberOfLines={1}>{p.folderName(n.payload.folderId)}</Text>
              <Text style={[s.td, s.cIng, s.num]}>{f && f.buy !== null ? f.ingredients : '–'}</Text>
              <Text style={[s.td, s.cBuy, f?.buy === 0 && s.have]} numberOfLines={1}>{f && f.buy !== null ? toBuyLabel(f.buy) : '–'}</Text>
            </Pressable>
          );
        })}
      </Scroll>
      {p.picked.length > 0 && (
        <View style={s.tray} testID="recipes-tray">
          <View style={s.trayText}>
            <Text style={s.trayCount}>{p.picked.length} picked</Text>
            <Text style={s.trayNames} numberOfLines={1}>{pickedNames(p.pickedTitles)}</Text>
          </View>
          <Pill testID="tray-clear" label="Clear" onPress={p.onClear} />
          <Pill testID="tray-cook" label="Cook these" onPress={p.onCook} />
          <Pill testID="tray-shop" primary label="Make shopping list" onPress={p.onShop} />
        </View>
      )}
    </View>
  );
}

const s = themed(() => StyleSheet.create({
  root: { flex: 1, minHeight: 0 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: T.line },
  chipOn: { backgroundColor: T.accentSoft, borderColor: T.accent },
  chipText: { color: T.dim, fontSize: 14, fontWeight: '600' },
  chipTextOn: { color: T.accent },
  thead: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 24, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: T.line },
  th: { color: T.muted, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  list: { flex: 1 },
  listIn: { paddingBottom: 16 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 24, minHeight: 46, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: T.lineSoft },
  rowPicked: { backgroundColor: T.accentSoft },
  rowOpen: { backgroundColor: T.surface2 },
  rowHover: { backgroundColor: T.surface },
  cPick: { width: 36 },
  cName: { flex: 1, minWidth: 120, paddingRight: 12 },
  cFolder: { width: 112, paddingRight: 8 },
  cIng: { width: 112, textAlign: 'right', paddingRight: 12 },
  cBuy: { width: 128, textAlign: 'right' },
  td: { color: T.text, fontSize: 15 },
  name: { fontWeight: '600' },
  dim: { color: T.dim, fontSize: 14 },
  num: { color: T.dim, fontVariant: ['tabular-nums'] },
  have: { color: okColor(), fontWeight: '600' },
  empty: { color: T.muted, fontSize: 14, padding: 24, lineHeight: 20 },
  tray: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 24, paddingVertical: 12, borderTopWidth: 1, borderTopColor: T.line, backgroundColor: T.surface },
  trayText: { flex: 1, minWidth: 0 },
  trayCount: { color: T.text, fontSize: 15, fontWeight: '700' },
  trayNames: { color: T.dim, fontSize: 13, marginTop: 1 },
}));
