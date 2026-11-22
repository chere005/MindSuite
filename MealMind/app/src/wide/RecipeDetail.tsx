/**
 * One recipe in the detail pane, read-only: folder, title, Cook and the variant,
 * each ingredient tagged In pantry or To buy, and the numbered steps.
 *
 * Cook is the one prominent action. Editing is rare (the owner, 2026-11-21:
 * "there should be some other interface to enter edit recipe, editing the
 * recipe is not common"), so Edit recipe and Duplicate sit behind the quiet
 * "⋯" in the pane's top line.
 */
import { useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { isRecipeNote, type Rec } from '@calmind/core';
import { useStore } from '../store';
import { themed, T } from '../theme';
import { Pill, Scroll } from '../ui';
import { okColor } from '../components/chefui';
import { pantryTexts } from '../addToShopping';
import { cookSteps, readRecipe } from '../chefflows';
import { buyCount, ingredientStates, stillToBuyHeading } from '../wideflows';
import { DetailTop } from './parts';

export function RecipeDetail({ note, folderName, variantId, onVariant, onCook, onEdit, onDuplicate, onClose }: {
  note: Rec<'note'>;
  folderName: string;
  variantId: string | null;
  onVariant: (id: string | null) => void;
  onCook: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onClose: () => void;
}) {
  const { recs } = useStore();
  const [menu, setMenu] = useState(false);
  const [more, setMore] = useState(false);
  // Esc shuts the "⋯" menu before it reaches the frame (which would deselect):
  // capture phase, and the frame skips a key already handled.
  useEffect(() => {
    if (!more || Platform.OS !== 'web' || typeof document === 'undefined') return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); setMore(false); } };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [more]);
  const recipe = isRecipeNote(note.payload);
  const variants = note.payload.variants ?? [];
  const activeVariant = variants.find((v) => v.id === variantId) ?? null;
  const parts = useMemo(() => (recipe ? readRecipe(note, activeVariant ? activeVariant.id : null) : null), [note, recipe, activeVariant]);
  const pantry = useMemo(() => pantryTexts(recs), [recs]);
  const states = useMemo(() => (parts ? ingredientStates(parts.ingredients, pantry) : []), [parts, pantry]);
  const steps = useMemo(() => (parts ? cookSteps(parts.steps) : []), [parts]);

  return (
    <View style={s.root} testID="recipe-detail">
      <DetailTop
        label={folderName}
        onClose={onClose}
        extra={(
          <Pressable testID="detail-more" accessibilityRole="button" accessibilityLabel="More" accessibilityState={{ expanded: more }} onPress={() => setMore((m) => !m)} hitSlop={8} style={[s.more, more && s.moreOn]}>
            <Text style={s.moreText}>⋯</Text>
          </Pressable>
        )}
      />
      <Scroll style={s.body} contentContainerStyle={s.bodyIn}>
        <Text testID="detail-title" style={s.title}>{note.payload.title}</Text>
        <View style={s.actions}>
          {recipe && <Pill testID="detail-cook" primary label="Cook" onPress={onCook} />}
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
      {more && (
        <>
          <Pressable testID="detail-more-backdrop" accessibilityLabel="Close menu" onPress={() => setMore(false)} style={StyleSheet.absoluteFill} />
          <View testID="detail-more-menu" style={s.moreMenu}>
            <Pressable testID="detail-edit" accessibilityRole="menuitem" onPress={() => { setMore(false); onEdit(); }} style={s.moreRow}>
              <Text style={s.moreRowText}>Edit recipe</Text>
            </Pressable>
            <Pressable testID="detail-duplicate" accessibilityRole="menuitem" onPress={() => { setMore(false); onDuplicate(); }} style={s.moreRow}>
              <Text style={s.moreRowText}>Duplicate</Text>
            </Pressable>
          </View>
        </>
      )}
    </View>
  );
}

const s = themed(() => StyleSheet.create({
  root: { flex: 1, minHeight: 0 },
  body: { flex: 1 },
  bodyIn: { paddingHorizontal: 20, paddingTop: 6, paddingBottom: 32 },
  title: { color: T.text, fontSize: 24, fontWeight: '800', lineHeight: 30 },
  more: { width: 32, height: 28, borderRadius: 8, alignItems: 'center', justifyContent: 'center', marginRight: 2 },
  moreOn: { backgroundColor: T.surface2 },
  moreText: { color: T.dim, fontSize: 18, fontWeight: '800', lineHeight: 20 },
  moreMenu: { position: 'absolute', top: 44, right: 44, minWidth: 170, backgroundColor: T.surface, borderWidth: 1, borderColor: T.line, borderRadius: 10, paddingVertical: 4, shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 12, shadowOffset: { width: 0, height: 4 } },
  moreRow: { paddingHorizontal: 14, paddingVertical: 10 },
  moreRowText: { color: T.text, fontSize: 14, fontWeight: '600' },
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
