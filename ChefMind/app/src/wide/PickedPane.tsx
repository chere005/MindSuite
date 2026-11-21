/**
 * The detail pane beside the Review: the recipes being shopped, each with
 * Remove, and where the ingredients went.
 */
import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { Rec } from '@calmind/core';
import { useStore } from '../store';
import { themed, T } from '../theme';
import { Pill, Scroll } from '../ui';
import { okColor } from '../components/chefui';
import { ingredientsOf, pantryTexts } from '../addToShopping';
import { planFor, reviewSummary } from '../chefflows';
import { whereWent } from '../wideflows';
import { DetailTop } from './parts';

export function PickedPane({ notes, folderName, onRemove, onAnother, onClose }: {
  notes: Rec<'note'>[];
  folderName: (folderId: string) => string;
  onRemove: (id: string) => void;
  onAnother: () => void;
  /** Hide the pane (it is only closable when it opens over the Review). */
  onClose: () => void;
}) {
  const { recs } = useStore();
  const sources = useMemo(() => notes.map((n) => ({ title: n.payload.title as string | null, ingredients: ingredientsOf(n) })), [notes]);
  const plan = useMemo(() => planFor(recs, sources, pantryTexts(recs)), [recs, sources]);
  const w = whereWent(plan, reviewSummary(sources).ingredients);
  return (
    <View style={s.root} testID="picked-pane">
      <DetailTop label="Picked recipes" onClose={onClose} />
      <Scroll style={s.body} contentContainerStyle={s.bodyIn}>
        {notes.map((n) => (
          <View key={n.id} style={s.pick}>
            <View style={s.pickText}>
              <Text style={s.pickName} numberOfLines={2}>{n.payload.title}</Text>
              <Text style={s.pickSub}>{folderName(n.payload.folderId)}</Text>
            </View>
            <Pill testID={`picked-remove-${n.payload.title}`} compact label="Remove" onPress={() => onRemove(n.id)} />
          </View>
        ))}
        <View style={s.another}><Pill testID="picked-another" label="Pick another recipe" onPress={onAnother} /></View>
        <Text style={s.sec}>Where the {w.total} went</Text>
        <View style={s.line}><Text style={s.lineText}>To buy</Text><Text style={s.n}>{w.toBuy}</Text></View>
        <View style={s.line}><Text style={s.lineText}>Covered by the pantry</Text><Text style={[s.n, s.have]}>{w.covered}</Text></View>
        <View style={s.line}><Text style={s.lineText}>Same item in two recipes, combined</Text><Text style={s.n}>{w.combined}</Text></View>
      </Scroll>
    </View>
  );
}

const s = themed(() => StyleSheet.create({
  root: { flex: 1, minHeight: 0 },
  body: { flex: 1 },
  bodyIn: { paddingHorizontal: 20, paddingBottom: 28 },
  pick: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: T.lineSoft },
  pickText: { flex: 1, minWidth: 0 },
  pickName: { color: T.text, fontSize: 15, fontWeight: '700' },
  pickSub: { color: T.dim, fontSize: 13, marginTop: 1 },
  another: { alignSelf: 'flex-start', marginTop: 12 },
  sec: { color: T.gold, fontSize: 12, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 26, marginBottom: 6 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: T.lineSoft },
  lineText: { flex: 1, color: T.text, fontSize: 14 },
  n: { color: T.text, fontSize: 16, fontWeight: '800', fontVariant: ['tabular-nums'] },
  have: { color: okColor() },
}));
