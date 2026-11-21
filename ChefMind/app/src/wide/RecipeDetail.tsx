/**
 * One recipe in the detail pane: folder, title, Cook / Edit / variant, each
 * ingredient tagged In pantry or To buy, and the numbered steps.
 */
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { isRecipeNote, type Rec } from '@calmind/core';
import { useStore } from '../store';
import { themed, T } from '../theme';
import { Pill, Scroll } from '../ui';
import { okColor } from '../components/chefui';
import { pantryTexts } from '../addToShopping';
import { cookSteps, readRecipe } from '../chefflows';
import { buyCount, ingredientStates, stillToBuyHeading } from '../wideflows';
import { DetailTop } from './parts';

export function RecipeDetail({ note, folderName, variantId, onVariant, onCook, onEdit, onClose }: {
  note: Rec<'note'>;
  folderName: string;
  variantId: string | null;
  onVariant: (id: string | null) => void;
  onCook: () => void;
  onEdit: () => void;
  onClose: () => void;
}) {
  const { recs } = useStore();
  const [menu, setMenu] = useState(false);
  const recipe = isRecipeNote(note.payload);
  const variants = note.payload.variants ?? [];
  const activeVariant = variants.find((v) => v.id === variantId) ?? null;
  const parts = useMemo(() => (recipe ? readRecipe(note, activeVariant ? activeVariant.id : null) : null), [note, recipe, activeVariant]);
  const pantry = useMemo(() => pantryTexts(recs), [recs]);
  const states = useMemo(() => (parts ? ingredientStates(parts.ingredients, pantry) : []), [parts, pantry]);
  const steps = useMemo(() => (parts ? cookSteps(parts.steps) : []), [parts]);

  return (
    <View style={s.root} testID="recipe-detail">
      <DetailTop label={folderName} onClose={onClose} />
      <Scroll style={s.body} contentContainerStyle={s.bodyIn}>
        <Text testID="detail-title" style={s.title}>{note.payload.title}</Text>
        <View style={s.actions}>
          {recipe && <Pill testID="detail-cook" primary label="Cook" onPress={onCook} />}
          <Pill testID="detail-edit" label="Edit" onPress={onEdit} />
          {recipe && variants.length > 0 && (
            <Pressable testID="detail-variant" accessibilityRole="button" onPress={() => setMenu((m) => !m)} style={[s.variant, activeVariant && s.variantOn]}>
              <Text style={[s.variantText, activeVariant && s.variantTextOn]} numberOfLines={1}>{activeVariant ? activeVariant.name : 'Whole recipe'} ▾</Text>
            </Pressable>
          )}
        </View>
        {menu && (
          <View style={s.menu}>
            {[{ id: null as string | null, name: 'Whole recipe' }, ...variants].map((v) => (
              <Pressable key={v.id ?? 'all'} testID={`detail-variant-${v.name}`} accessibilityRole="button" onPress={() => { onVariant(v.id); setMenu(false); }} style={[s.menuRow, variantId === v.id && s.menuRowOn]}>
                <Text style={[s.menuText, variantId === v.id && s.menuTextOn]}>{v.name}</Text>
              </Pressable>
            ))}
          </View>
        )}
        {!recipe && <Text style={s.plain}>{note.payload.body.trim() === '' ? 'Nothing written yet.' : note.payload.body}</Text>}
        {recipe && (
          <>
            <Text style={s.sec}>{stillToBuyHeading(buyCount(parts?.ingredients ?? [], pantry), states.filter((x) => !x.heading).length)}</Text>
            {states.map((x, i) => x.heading ? (
              <Text key={i} style={s.sub}>{x.text}</Text>
            ) : (
              <View key={i} style={s.ing}>
                <Text style={s.ingText}>{x.text}</Text>
                <Text testID={x.have ? 'ing-have' : 'ing-buy'} style={[s.tag, x.have ? s.tagHave : s.tagBuy]}>{x.have ? 'In pantry' : 'To buy'}</Text>
              </View>
            ))}
            <Text style={[s.sec, s.gap]}>{steps.length === 0 ? 'No steps written yet' : 'Steps'}</Text>
            {steps.map((st) => (
              <View key={st.n}>
                {st.heading ? <Text style={s.sub}>{st.heading}</Text> : null}
                <View style={s.step}>
                  <Text style={s.stepN}>{st.n}</Text>
                  <Text style={s.stepText}>{st.text}</Text>
                </View>
              </View>
            ))}
          </>
        )}
      </Scroll>
    </View>
  );
}

const s = themed(() => StyleSheet.create({
  root: { flex: 1, minHeight: 0 },
  body: { flex: 1 },
  bodyIn: { paddingHorizontal: 20, paddingTop: 6, paddingBottom: 32 },
  title: { color: T.text, fontSize: 24, fontWeight: '800', lineHeight: 30 },
  actions: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 14 },
  variant: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: T.line, maxWidth: 180 },
  variantOn: { backgroundColor: T.accentSoft, borderColor: T.accent },
  variantText: { color: T.dim, fontSize: 14, fontWeight: '600' },
  variantTextOn: { color: T.accent },
  menu: { marginTop: 8, borderWidth: 1, borderColor: T.line, borderRadius: 10, overflow: 'hidden' },
  menuRow: { paddingHorizontal: 12, paddingVertical: 10 },
  menuRowOn: { backgroundColor: T.accentSoft },
  menuText: { color: T.text, fontSize: 14 },
  menuTextOn: { color: T.accent, fontWeight: '700' },
  plain: { color: T.dim, fontSize: 15, lineHeight: 22, marginTop: 16 },
  sec: { color: T.gold, fontSize: 12, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 20, marginBottom: 4 },
  gap: { marginTop: 24 },
  sub: { color: T.dim, fontSize: 13, fontWeight: '700', marginTop: 10 },
  ing: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: T.lineSoft },
  ingText: { flex: 1, color: T.text, fontSize: 15, lineHeight: 21 },
  tag: { fontSize: 12, fontWeight: '700', paddingTop: 3, flexShrink: 0 },
  tagHave: { color: okColor() },
  tagBuy: { color: T.gold },
  step: { flexDirection: 'row', gap: 10, paddingVertical: 7 },
  stepN: { color: T.muted, fontSize: 15, fontWeight: '800', width: 22 },
  stepText: { flex: 1, color: T.text, fontSize: 15, lineHeight: 22 },
}));
