/**
 * Cook's "+ Add a recipe": search, then the recipes folder by folder as the
 * table groups them, minus the ones already cooking (`cookPickGroups`). A tap
 * puts that recipe on the stove alongside the others, in its own tab.
 *
 * PANE-READY: renders inline, no Modal. The phone wraps it in a sheet, the
 * wide Cook in its right-hand panel.
 */
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useStore } from '../store';
import { themed, T } from '../theme';
import { Field, Scroll } from '../ui';
import { cookPickGroups, recipeGroups } from '../wideflows';

export function CookAddPicker({ cooking, onPick, onClose, tall = false }: {
  /** Ids already on the stove: not offered again. */
  cooking: readonly string[];
  onPick: (id: string) => void;
  onClose: () => void;
  /** Desktop panel: let the list use the height. */
  tall?: boolean;
}) {
  const { recs } = useStore();
  const [query, setQuery] = useState('');
  const groups = useMemo(() => cookPickGroups(recipeGroups(recs, { folderId: null }), query, cooking), [recs, query, cooking]);
  return (
    <View style={[s.root, tall && s.rootTall]} testID="cook-add">
      <View style={s.head}>
        <Text style={s.h}>Cook another recipe</Text>
        <Pressable testID="cook-add-close" accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} hitSlop={8} style={s.x}>
          <Text style={s.xText}>✕</Text>
        </Pressable>
      </View>
      <Text style={s.sub}>It opens in its own tab beside the one you are cooking.</Text>
      <Field testID="cook-add-search" value={query} onChangeText={setQuery} placeholder="Search recipes" autoFocus={tall} style={s.search} />
      <Scroll style={[s.list, tall ? s.listTall : s.listShort]} contentContainerStyle={s.listIn} keyboardShouldPersistTaps="handled">
        {groups.length === 0 && (
          <Text style={s.empty}>{query.trim() === '' ? 'No other recipes to add.' : 'No recipes match.'}</Text>
        )}
        {groups.map((g) => (
          <View key={g.folder.id}>
            <View style={s.folder}>
              <View style={[s.dot, { backgroundColor: g.folder.payload.color }]} />
              <Text style={s.folderName} numberOfLines={1}>{g.folder.payload.name}</Text>
            </View>
            {g.notes.map((n) => (
              <Pressable key={n.id} testID={`cook-add-${n.payload.title}`} accessibilityRole="button" onPress={() => onPick(n.id)} style={s.row}>
                <Text style={s.rowText} numberOfLines={1}>{n.payload.title}</Text>
                <Text style={s.plus}>+</Text>
              </Pressable>
            ))}
          </View>
        ))}
      </Scroll>
    </View>
  );
}

const s = themed(() => StyleSheet.create({
  root: { padding: 16, flexShrink: 1, minHeight: 0 },
  rootTall: { flexGrow: 1, flexBasis: 0, minHeight: 0 },
  head: { flexDirection: 'row', alignItems: 'center' },
  h: { flex: 1, color: T.text, fontSize: 20, fontWeight: '800' },
  x: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  xText: { color: T.dim, fontSize: 15 },
  sub: { color: T.dim, fontSize: 14, marginTop: 2, marginBottom: 10 },
  search: { fontSize: 15, paddingVertical: 8 },
  // Longhands only: react-native-web lets a longhand beat the `flex` shorthand
  // whatever the order, and a list with flexGrow 0 and flexBasis 0 is 0 tall.
  list: { flexShrink: 1, marginTop: 8 },
  listShort: { flexGrow: 0, maxHeight: 420 },
  listTall: { flexGrow: 1, flexBasis: 0, minHeight: 0 },
  listIn: { paddingBottom: 8 },
  empty: { color: T.muted, fontSize: 14, paddingVertical: 16 },
  folder: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 12, paddingBottom: 4 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  folderName: { color: T.gold, fontSize: 12, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.6, flexShrink: 1 },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 44, paddingHorizontal: 4, borderBottomWidth: 1, borderBottomColor: T.lineSoft },
  rowText: { flex: 1, color: T.text, fontSize: 16 },
  plus: { color: T.accent, fontSize: 20, fontWeight: '700', paddingLeft: 8 },
}));
