/**
 * Cook — a recipe's steps in big type, one at a time, with the screen kept on.
 *
 * Cook opens on ONE recipe. Tabs across the top are the recipes being cooked
 * tonight, and "+ Add a recipe" at the end of them puts another on the stove
 * (`CookAddPicker`); with two or more, each tab has a ✕ to take it off. The
 * owner, 2026-11-21: "usually it would just be one recipe, then some other ux to
 * add another one for simultaneous cooking". Each tab has a Gather
 * list (ticks are screen state, never saved), its steps with the current one
 * lit, Back / Next step, and a variant picker when the card has variants. On
 * the web Space is next and Shift+Space back, only while this is mounted.
 * "Finish" (`CookFinish`) asks what ran out and takes it off the pantry,
 * optionally onto the shopping list.
 *
 * Steps and ingredients come from the recipe body exactly as the Recipe page
 * reads them (`readRecipe`: the recipe block through splitRecipeBody and
 * recipeFromPages, with the variant's sections applied).
 *
 * PANE-READY: renders inline, no Modal. `PhoneSheet full` wraps it on the phone.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { mergeIntoList, pantryUsedIn, type Rec } from '@calmind/core';
import { useStore } from '../store';
import { themed, T } from '../theme';
import { CircleBtn, Pill, Scroll } from '../ui';
import { useToast } from './Toast';
import { pantryTexts } from '../addToShopping';
import { newCookState, type CookState, type CookTabState } from '../session';
import { applyOps, cookKey, cookSteps, finishCookingOps, gatherItems, readRecipe, stepTo } from '../chefflows';
import { useScreenAwake } from '../keepawake';
import { PhoneSheet, TickBox, okColor } from './chefui';
import { CookAddPicker } from './CookAddPicker';

export type CookViewProps = {
  /** The recipes to cook, one tab each. */
  notes: Rec<'note'>[];
  /** Which tab opens first (a note id); default the first. */
  initialId?: string;
  /** The variant the recipe page was showing, for the first tab. */
  initialVariantId?: string | null;
  onClose: () => void;
  /** Wraps the Finish panel. The phone passes a sheet; a pane can pass its own
   *  or omit it, in which case the panel renders inline above the bar. */
  wrapFinish?: (panel: React.ReactNode, close: () => void) => React.ReactNode;
  /** Desktop layout: Gather on the left, the steps large on the right, a text
   *  "‹ <closeLabel>" link instead of the round back, and Esc leaves (or, with
   *  Finish open, closes Finish first). */
  wide?: boolean;
  closeLabel?: string;
  /** The Cook's own state (tab, step, ticks), held by the host so it survives a
   *  layout change. Omit both and the view keeps it itself. */
  state?: CookState;
  onState?: (fn: (s: CookState) => CookState) => void;
  /** Put another recipe on the stove (its own tab). Given, the tab row ends in
   *  "+ Add a recipe". */
  onAdd?: (id: string) => void;
  /** Take one off; offered on each tab once there are two or more. */
  onDrop?: (id: string) => void;
  /** Wraps the "+ Add a recipe" picker, as `wrapFinish` wraps Finish; defaults
   *  to it. */
  wrapAdd?: (panel: React.ReactNode, close: () => void) => React.ReactNode;
};

type Tab = CookTabState;

export function CookView({ notes, initialId, initialVariantId = null, onClose, wrapFinish, wide = false, closeLabel = 'Recipes', state, onState, onAdd, onDrop, wrapAdd }: CookViewProps) {
  const awake = useScreenAwake();
  const [local, setLocal] = useState<CookState>(() => newCookState(Math.max(0, notes.findIndex((n) => n.id === initialId))));
  const cs = state ?? local;
  const setCs = onState ?? ((fn: (s: CookState) => CookState) => setLocal(fn));
  const { active, tabs, finishOpen } = cs;
  const setActive = (i: number) => setCs((x) => ({ ...x, active: i }));
  const setFinishOpen = (v: boolean) => setCs((x) => ({ ...x, finishOpen: v }));
  const [gatherOpen, setGatherOpen] = useState(true);
  const [adding, setAdding] = useState(false);
  const note = notes[active] ?? notes[0];
  const tabDefault = (id: string): Tab => ({ step: 0, gathered: [], variantId: id === (initialId ?? notes[0]?.id) ? initialVariantId : null });
  const tab = (id: string): Tab => tabs[id] ?? tabDefault(id);
  const setTab = (id: string, fn: (t: Tab) => Tab) => setCs((x) => ({ ...x, tabs: { ...x.tabs, [id]: fn(x.tabs[id] ?? tabDefault(id)) } }));

  const recipeOf = (n: Rec<'note'>) => readRecipe(n, tab(n.id).variantId);
  const cur = note ? recipeOf(note) : { ingredients: [], steps: [] };
  const steps = useMemo(() => cookSteps(cur.steps), [cur.steps.join('\n')]); // eslint-disable-line react-hooks/exhaustive-deps
  const gather = useMemo(() => gatherItems(cur.ingredients), [cur.ingredients.join('\n')]); // eslint-disable-line react-hooks/exhaustive-deps
  const t = note ? tab(note.id) : null;
  const step = t ? Math.min(t.step, Math.max(0, steps.length - 1)) : 0;
  const ingCount = gather.filter((g) => !g.heading).length;

  const go = (dir: 1 | -1) => { if (note) setTab(note.id, (x) => ({ ...x, step: stepTo(Math.min(x.step, Math.max(0, steps.length - 1)), dir, steps.length) })); };
  // The key handler reads the latest closure through a ref: it is registered
  // once, and must neither go stale nor stack a listener per render.
  const goRef = useRef(go);
  goRef.current = go;
  const blocked = useRef(false);
  blocked.current = finishOpen || adding;
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const onKey = (e: KeyboardEvent) => {
      if (blocked.current) return;
      const k = cookKey(e as unknown as Parameters<typeof cookKey>[0]);
      if (!k) return;
      e.preventDefault();
      e.stopPropagation(); // a focused button must not ALSO act on the Space
      goRef.current(k === 'next' ? 1 : -1);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  // Desktop: Esc closes Finish if it is open, otherwise leaves Cook.
  const escRef = useRef<() => void>(() => {});
  escRef.current = () => { if (adding) setAdding(false); else if (finishOpen) setFinishOpen(false); else onClose(); };
  useEffect(() => {
    if (!wide || Platform.OS !== 'web' || typeof document === 'undefined') return;
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) escRef.current(); };
    document.addEventListener('keydown', onEsc);
    return () => document.removeEventListener('keydown', onEsc);
  }, [wide]);

  // Keep the current step on screen.
  const scroller = useRef<ScrollView>(null);
  const ys = useRef<number[]>([]);
  useEffect(() => {
    const y = ys.current[step];
    if (y !== undefined) scroller.current?.scrollTo({ y: Math.max(0, y - 16), animated: true });
  }, [step, note?.id]);

  if (!note || !t) {
    return (
      <View style={s.root} testID="cook-empty">
        <View style={s.top}>
          {wide ? (
            <Pressable testID="cook-close" accessibilityRole="button" accessibilityLabel="Close Cook" onPress={onClose} style={s.backLink}>
              <Text style={s.backLinkText}>‹ {closeLabel}</Text>
            </Pressable>
          ) : (
            <CircleBtn testID="cook-close" glyph="‹" size={32} targetSize={44} label="Close Cook" onPress={onClose} />
          )}
          <Text style={s.topTitle}>Cook</Text>
        </View>
        <Text testID="cook-nothing" style={s.emptyText}>Nothing to cook. The recipe you were cooking is gone.</Text>
      </View>
    );
  }
  const allIngredients = notes.flatMap((n) => recipeOf(n).ingredients);
  const last = step >= steps.length - 1;
  const variants = note.payload.variants ?? [];
  const wrapPanel = wrapAdd ?? wrapFinish;
  const addPanel = (
    <CookAddPicker
      tall={wide}
      cooking={notes.map((n) => n.id)}
      onClose={() => setAdding(false)}
      onPick={(id) => { setAdding(false); onAdd?.(id); }}
    />
  );
  const finishPanel = (
    <CookFinish tall={wide} ticked={cs.ticked} shop={cs.shop} onTicked={(v) => setCs((x) => ({ ...x, ticked: v }))} onShop={(v) => setCs((x) => ({ ...x, shop: v }))} ingredients={allIngredients} onCancel={() => setFinishOpen(false)} onFinished={() => { setFinishOpen(false); onClose(); }} />
  );

  return (
    <View style={s.root} testID="cook">
      <View style={s.top}>
        {wide ? (
          <Pressable testID="cook-close" accessibilityRole="button" accessibilityLabel="Close Cook" onPress={onClose} style={s.backLink}>
            <Text style={s.backLinkText}>‹ {closeLabel}</Text>
          </Pressable>
        ) : (
          <CircleBtn testID="cook-close" glyph="‹" size={32} targetSize={44} label="Close Cook" onPress={onClose} />
        )}
        <Text style={s.topTitle} numberOfLines={1}>Cook</Text>
        {awake && <Text testID="cook-awake" style={s.awake}>Screen stays on</Text>}
        <View style={s.grow} />
        <Pill testID="cook-finish-open" compact label="Finish" onPress={() => setFinishOpen(true)} />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.tabsWrap} contentContainerStyle={s.tabs}>
        {notes.map((n, i) => (
          <View key={n.id} style={[s.tab, i === active && s.tabOn]}>
            <Pressable testID={`cook-tab-${i}`} accessibilityRole="tab" accessibilityState={{ selected: i === active }} onPress={() => setActive(i)} style={s.tabHit}>
              <Text style={[s.tabText, i === active && s.tabTextOn]} numberOfLines={1}>{n.payload.title}</Text>
            </Pressable>
            {/* Off the stove: only once there is another to cook, so Cook
                never empties itself from a tab (the back link leaves). */}
            {onDrop && notes.length > 1 && (
              <Pressable testID={`cook-drop-${i}`} accessibilityRole="button" accessibilityLabel={`Stop cooking ${n.payload.title}`} onPress={() => onDrop(n.id)} hitSlop={6} style={s.tabX}>
                <Text style={[s.tabXText, i === active && s.tabTextOn]}>✕</Text>
              </Pressable>
            )}
          </View>
        ))}
        {onAdd && (
          <Pressable testID="cook-add-open" accessibilityRole="button" accessibilityLabel="Add a recipe to cook alongside" onPress={() => { setFinishOpen(false); setAdding(true); }} style={s.addTab}>
            {/* Shortened on the phone once tabs fill the row, so it stays in view. */}
            <Text style={s.addTabText} numberOfLines={1}>{!wide && notes.length > 1 ? '+ Add' : '+ Add a recipe'}</Text>
          </Pressable>
        )}
      </ScrollView>

      {wide ? (
        <View style={s.wideBody}>
          <Scroll style={s.wideLeft} contentContainerStyle={s.bodyIn}>
        <Text style={s.title}>{note.payload.title}</Text>
        {variants.length > 0 && (
          <View style={s.variants}>
            {[{ id: null as string | null, name: 'Whole recipe' }, ...variants].map((v) => (
              <Pressable key={v.id ?? 'all'} testID={`cook-variant-${v.name}`} accessibilityRole="button" onPress={() => setTab(note.id, (x) => ({ ...x, variantId: v.id, step: 0, gathered: [] }))} style={[s.chip, t.variantId === v.id && s.chipOn]}>
                <Text style={[s.chipText, t.variantId === v.id && s.chipTextOn]}>{v.name}</Text>
              </Pressable>
            ))}
          </View>
        )}

        <Pressable testID="cook-gather-head" accessibilityRole="button" onPress={() => setGatherOpen((o) => !o)} style={s.gatherHead}>
          <Text style={s.sec}>Gather · {gather.filter((g, i) => !g.heading && t.gathered.includes(i)).length} of {ingCount}</Text>
          <Text style={s.caret}>{gatherOpen ? '▾' : '▸'}</Text>
        </Pressable>
        {gatherOpen && gather.map((g, i) => g.heading ? (
          <Text key={i} style={s.gHeading}>{g.text}</Text>
        ) : (
          <View key={i} style={s.gRow}>
            <TickBox testID="cook-gather" on={t.gathered.includes(i)} label={g.text} onPress={() => setTab(note.id, (x) => {
              return { ...x, gathered: x.gathered.includes(i) ? x.gathered.filter((g) => g !== i) : [...x.gathered, i] };
            })} />
            <Text style={[s.gText, t.gathered.includes(i) && s.gDone]}>{g.text}</Text>
          </View>
        ))}

          </Scroll>
          <Scroll ref={scroller} style={s.wideRight} contentContainerStyle={s.wideRightIn}>
        <Text style={[s.sec, s.stepsSec]}>{steps.length === 0 ? 'No steps written yet' : `Step ${step + 1} of ${steps.length}`}</Text>
        {steps.map((st, i) => (
          <View key={i} onLayout={(e) => { ys.current[i] = e.nativeEvent.layout.y; }}>
            {st.heading && <Text style={s.stepHeading}>{st.heading}</Text>}
            <Pressable testID={`cook-step-${i}`} accessibilityRole="button" accessibilityState={{ selected: i === step }} onPress={() => setTab(note.id, (x) => ({ ...x, step: i }))} style={[s.step, i === step && s.stepOn]}>
              <Text style={[s.stepN, wide && s.stepNWide, i === step && s.stepNOn]}>{st.n}</Text>
              <Text style={[s.stepText, wide && s.stepTextWide, i !== step && s.stepDim]}>{st.text}</Text>
            </Pressable>
          </View>
        ))}
        {Platform.OS === 'web' && steps.length > 0 && <Text style={s.hint}>Space for next, Shift+Space for back</Text>}
          </Scroll>
        </View>
      ) : (
      <Scroll ref={scroller} style={s.body} contentContainerStyle={s.bodyIn}>
        <Text style={s.title}>{note.payload.title}</Text>
        {variants.length > 0 && (
          <View style={s.variants}>
            {[{ id: null as string | null, name: 'Whole recipe' }, ...variants].map((v) => (
              <Pressable key={v.id ?? 'all'} testID={`cook-variant-${v.name}`} accessibilityRole="button" onPress={() => setTab(note.id, (x) => ({ ...x, variantId: v.id, step: 0, gathered: [] }))} style={[s.chip, t.variantId === v.id && s.chipOn]}>
                <Text style={[s.chipText, t.variantId === v.id && s.chipTextOn]}>{v.name}</Text>
              </Pressable>
            ))}
          </View>
        )}

        <Pressable testID="cook-gather-head" accessibilityRole="button" onPress={() => setGatherOpen((o) => !o)} style={s.gatherHead}>
          <Text style={s.sec}>Gather · {gather.filter((g, i) => !g.heading && t.gathered.includes(i)).length} of {ingCount}</Text>
          <Text style={s.caret}>{gatherOpen ? '▾' : '▸'}</Text>
        </Pressable>
        {gatherOpen && gather.map((g, i) => g.heading ? (
          <Text key={i} style={s.gHeading}>{g.text}</Text>
        ) : (
          <View key={i} style={s.gRow}>
            <TickBox testID="cook-gather" on={t.gathered.includes(i)} label={g.text} onPress={() => setTab(note.id, (x) => {
              return { ...x, gathered: x.gathered.includes(i) ? x.gathered.filter((g) => g !== i) : [...x.gathered, i] };
            })} />
            <Text style={[s.gText, t.gathered.includes(i) && s.gDone]}>{g.text}</Text>
          </View>
        ))}

        <Text style={[s.sec, s.stepsSec]}>{steps.length === 0 ? 'No steps written yet' : `Step ${step + 1} of ${steps.length}`}</Text>
        {steps.map((st, i) => (
          <View key={i} onLayout={(e) => { ys.current[i] = e.nativeEvent.layout.y; }}>
            {st.heading && <Text style={s.stepHeading}>{st.heading}</Text>}
            <Pressable testID={`cook-step-${i}`} accessibilityRole="button" accessibilityState={{ selected: i === step }} onPress={() => setTab(note.id, (x) => ({ ...x, step: i }))} style={[s.step, i === step && s.stepOn]}>
              <Text style={[s.stepN, wide && s.stepNWide, i === step && s.stepNOn]}>{st.n}</Text>
              <Text style={[s.stepText, wide && s.stepTextWide, i !== step && s.stepDim]}>{st.text}</Text>
            </Pressable>
          </View>
        ))}
        {Platform.OS === 'web' && steps.length > 0 && <Text style={s.hint}>Space for next, Shift+Space for back</Text>}
      </Scroll>
      )}

      <View style={s.bar}>
        <Pill testID="cook-back" label="Back" disabled={step === 0} onPress={() => go(-1)} />
        <View style={s.grow} />
        {last
          ? <Pill testID="cook-next" primary label="Finish" onPress={() => setFinishOpen(true)} />
          : <Pill testID="cook-next" primary label="Next step" onPress={() => go(1)} />}
      </View>
      {finishOpen && (wrapFinish ? wrapFinish(finishPanel, () => setFinishOpen(false)) : finishPanel)}
      {adding && (wrapPanel ? wrapPanel(addPanel, () => setAdding(false)) : addPanel)}
    </View>
  );
}

/**
 * When you finish — "Anything run out?". Lists the pantry rows these recipes
 * use (`pantryUsedIn`), unticked; ticked rows leave the pantry, and with the
 * box on go onto the shopping list in the same write (`finishCookingOps`).
 *
 * PANE-READY: renders inline, no Modal.
 */
export function CookFinish({ ingredients, onCancel, onFinished, tall = false, ticked: tickedProp, shop: shopProp, onTicked, onShop }: {
  ingredients: readonly string[];
  onCancel: () => void;
  onFinished: () => void;
  /** Desktop panel: let the list use the height. */
  tall?: boolean;
  /** Held by the Cook session when given, so Finish survives a layout change. */
  ticked?: string[];
  shop?: boolean;
  onTicked?: (v: string[]) => void;
  onShop?: (v: boolean) => void;
}) {
  const { recs, mutate } = useStore();
  const toast = useToast();
  const used = useMemo(() => pantryUsedIn(ingredients, pantryTexts(recs)), [ingredients, recs]);
  const [localTicked, setLocalTicked] = useState<string[]>([]);
  const [localShop, setLocalShop] = useState(true);
  const tickedList = tickedProp ?? localTicked;
  const setTickedList = onTicked ?? setLocalTicked;
  const shop = shopProp ?? localShop;
  const setShop = onShop ?? setLocalShop;
  const ticked = new Set(tickedList);
  const ran = used.filter((u) => ticked.has(u));

  const finish = () => {
    if (ran.length === 0) { onFinished(); return; }
    const w = finishCookingOps(recs, ran, shop, mergeIntoList);
    if (!w.ok) { toast('The lists are not ready yet. Try again in a moment.'); return; }
    try { mutate((e) => applyOps(e, w.ops)); } catch { toast('Could not save. Nothing was changed.'); return; }
    toast(shop && w.added + w.merged > 0
      ? `${w.removed} off the pantry, on the shopping list.`
      : `${w.removed} off the pantry.`);
    onFinished();
  };

  return (
    <View style={s.fin} testID="cook-finish">
      <Text style={s.finH}>When you finish</Text>
      <Text style={s.finSub}>Anything run out? Ticked items leave the pantry.</Text>
      <Scroll style={[s.finBody, tall && s.finBodyTall]}>
        {used.length === 0 && <Text style={s.finNote}>None of your pantry items are used by this.</Text>}
        {used.map((u) => (
          <View key={u} style={s.gRow}>
            <TickBox testID="cook-ranout" on={ticked.has(u)} label={`${u} ran out`} onPress={() => setTickedList(ticked.has(u) ? tickedList.filter((x) => x !== u) : [...tickedList, u])} />
            <Text style={s.gText}>{u}</Text>
          </View>
        ))}
      </Scroll>
      <View style={s.gRow}>
        <TickBox testID="cook-addshop" on={shop} label="Add them to the shopping list" onPress={() => setShop(!shop)} />
        <Text style={s.gText}>Add them to the shopping list</Text>
      </View>
      <Text style={s.finNote}>Only pantry items these recipes use are listed. Ticks on this screen are not saved.</Text>
      <View style={s.finBar}>
        <Pill testID="cook-finish-cancel" label="Keep cooking" onPress={onCancel} />
        <Pill testID="cook-finish-go" primary label={ran.length > 0 ? `Finish: ${ran.length} ran out` : 'Finish'} onPress={finish} />
      </View>
    </View>
  );
}

/** The phone's wrapper for the Finish panel: a card over the cook screen. */
export const phoneFinish = (panel: React.ReactNode, close: () => void) => <PhoneSheet onClose={close}>{panel}</PhoneSheet>;

const s = themed(() => StyleSheet.create({
  root: { flex: 1, backgroundColor: T.bg },
  top: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingTop: 8, paddingBottom: 6 },
  topTitle: { color: T.text, fontSize: 18, fontWeight: '800' },
  awake: { color: okColor(), fontSize: 12, fontWeight: '600' },
  grow: { flex: 1 },
  tabsWrap: { flexGrow: 0, borderBottomWidth: 1, borderBottomColor: T.line },
  tabs: { paddingHorizontal: 12, gap: 6, paddingBottom: 8 },
  tab: { flexDirection: 'row', alignItems: 'center', borderRadius: 999, borderWidth: 1, borderColor: T.line, maxWidth: 260 },
  tabHit: { paddingHorizontal: 14, paddingVertical: 8, flexShrink: 1 },
  tabX: { paddingRight: 12, paddingLeft: 2, paddingVertical: 8 },
  tabXText: { color: T.muted, fontSize: 13, fontWeight: '700' },
  addTab: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderStyle: 'dashed', borderColor: T.accent },
  addTabText: { color: T.accent, fontSize: 14, fontWeight: '700' },
  tabOn: { backgroundColor: T.accentSoft, borderColor: T.accent },
  tabText: { color: T.dim, fontSize: 14, fontWeight: '600' },
  tabTextOn: { color: T.accent },
  body: { flex: 1 },
  bodyIn: { paddingHorizontal: 16, paddingBottom: 24 },
  title: { color: T.text, fontSize: 26, fontWeight: '800', marginTop: 14 },
  variants: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: T.line },
  chipOn: { backgroundColor: T.accentSoft, borderColor: T.accent },
  chipText: { color: T.dim, fontSize: 14 },
  chipTextOn: { color: T.accent, fontWeight: '700' },
  gatherHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 18, paddingVertical: 4 },
  sec: { color: T.gold, fontSize: 13, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.5 },
  stepsSec: { marginTop: 22, marginBottom: 6 },
  caret: { color: T.dim, fontSize: 14 },
  gHeading: { color: T.dim, fontSize: 13, fontWeight: '700', marginTop: 8 },
  gRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6 },
  gText: { color: T.text, fontSize: 16, flex: 1 },
  gDone: { color: T.muted, textDecorationLine: 'line-through' },
  stepHeading: { color: T.dim, fontSize: 14, fontWeight: '700', marginTop: 10, marginBottom: 2 },
  step: { flexDirection: 'row', gap: 12, paddingVertical: 12, paddingHorizontal: 12, borderRadius: 14, borderWidth: 1, borderColor: 'transparent', marginTop: 4 },
  stepOn: { backgroundColor: T.accentSoft, borderColor: T.accent },
  stepN: { color: T.muted, fontSize: 22, fontWeight: '800', width: 28 },
  stepNOn: { color: T.accent },
  stepText: { color: T.text, fontSize: 22, lineHeight: 31, flex: 1 },
  stepDim: { color: T.muted },
  backLink: { paddingVertical: 8, paddingRight: 6 },
  backLinkText: { color: T.accent, fontSize: 15, fontWeight: '700' },
  wideBody: { flex: 1, flexDirection: 'row', minHeight: 0 },
  wideLeft: { width: 340, flexGrow: 0, flexShrink: 0, borderRightWidth: 1, borderRightColor: T.line },
  wideRight: { flex: 1, minWidth: 0 },
  wideRightIn: { paddingHorizontal: 32, paddingTop: 20, paddingBottom: 40, maxWidth: 860 },
  stepTextWide: { fontSize: 28, lineHeight: 40 },
  stepNWide: { fontSize: 28, width: 40 },
  emptyText: { color: T.dim, fontSize: 16, padding: 24 },
  hint: { color: T.muted, fontSize: 12, marginTop: 14, textAlign: 'center' },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, borderTopWidth: 1, borderTopColor: T.line, backgroundColor: T.surface },
  fin: { padding: 16, flexShrink: 1, minHeight: 0 },
  finH: { color: T.text, fontSize: 20, fontWeight: '800' },
  finSub: { color: T.dim, fontSize: 14, marginTop: 2, marginBottom: 8 },
  finBody: { flexGrow: 0, flexShrink: 1, maxHeight: 280 },
  finBodyTall: { maxHeight: 560 },
  finNote: { color: T.dim, fontSize: 13, marginTop: 8, lineHeight: 18 },
  finBar: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 12 },
}));
