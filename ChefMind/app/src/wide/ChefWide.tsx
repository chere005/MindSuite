/**
 * ChefMind at desktop size (window >= 900): a sidebar, a main pane and a
 * detail pane, in the suite's shared WideFrame. Every ChefMind action lives
 * here — the MindSuite bar above the page only switches apps.
 *
 * Which pane shows what:
 *   Recipes   main = the recipe table (or the Review, or the editor);
 *             detail = the open recipe (or, in the Review, the picked recipes)
 *   Shopping  main = the aisle list;       detail = Done shopping, or a row
 *   Pantry    main = aisle columns;        detail = the open pantry item
 *   Cook      takes the whole window (Gather left, steps right, Finish in a
 *             right-hand panel)
 *
 * The flows themselves (ShoppingReview, DoneShopping, PantryItem, CookView) are
 * the same pane-ready components the phone wraps in sheets; only the frame
 * differs. Selection (what is picked) lives here so the Review's detail pane and
 * the tray agree. Below 900 App never mounts this.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { byRecOrd, newId, ordBetween, defaultNoteTitle, searchRecords, type Rec } from '@calmind/core';
import { useStore } from '../store';
import { themed, T } from '../theme';
import { Field, Scroll } from '../ui';
import { SidebarItem, SidebarLabel, SidebarTitle, WideFrame, useWide } from '../components/WideFrame';
import { SyncDot } from '../components/SyncDot';
import { useToast } from '../components/Toast';
import { ShoppingReview } from '../components/ShoppingReview';
import { DoneShopping } from '../components/DoneShopping';
import { PantryItem } from '../components/PantryItem';
import { CookView } from '../components/CookView';
import { PageIcon, TickCircleIcon } from '../components/KindIcons';
import { NavCtx, type Tab } from '../nav';
import { Notes } from '../screens/Notes';
import { Settings } from '../screens/Settings';
import { pantryTexts } from '../addToShopping';
import { listOf } from '../chefflows';
import { newCook, newReview, useChefSession } from '../session';
import { hitSection, isTextTarget, recipeFacts, recipeFolders, recipeRows } from '../wideflows';
import { wideColors } from './parts';
import { WideRecipes } from './WideRecipes';
import { RecipeDetail } from './RecipeDetail';
import { PickedPane } from './PickedPane';
import { ShoppingRowDetail, WidePantry, WideShopping } from './WideLists';

type View_ = 'list' | 'edit';

export function ChefWide({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
  const { recs, mutate, session, signOut, undoLastDelete } = useStore();
  const toast = useToast();
  const colors = wideColors();
  const { detailBeside } = useWide();
  const [pickedPane, setPickedPane] = useState(false);

  const [query, setQuery] = useState('');
  const [folderId, setFolderId] = useState<string | null>(null);
  const [canMake, setCanMake] = useState(false);
  // Picks, Review and Cook are the session's, shared with the phone layout.
  const { picked, setPicked, review, setReview, cook, setCook, setCookState } = useChefSession();
  const [view, setView] = useState<View_>('list');
  const [openId, setOpenId] = useState<string | null>(null);
  const [variantFor, setVariantFor] = useState<{ id: string; variantId: string | null } | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [doneOpen, setDoneOpen] = useState(false);
  const [rowId, setRowId] = useState<string | null>(null);
  const [itemId, setItemId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  /* ── Data ── */
  const pantry = useMemo(() => pantryTexts(recs), [recs]);
  const cache = useRef(new Map<string, { body: string; key: string; fact: { ingredients: number; buy: number | null } }>());
  const allNotes = useMemo(() => recs.filter((r): r is Rec<'note'> => r.type === 'note' && !r.deleted), [recs]);
  const facts = useMemo(() => recipeFacts(allNotes, pantry, cache.current), [allNotes, pantry]);
  const folders = useMemo(() => recipeFolders(recs), [recs]);
  const folderName = useCallback((id: string) => folders.find((f) => f.id === id)?.payload.name ?? '', [folders]);
  const rows = useMemo(() => recipeRows(recs, { folderId, canMake, facts }), [recs, folderId, canMake, facts]);
  const noteById = (id: string | null) => (id ? allNotes.find((n) => n.id === id) : undefined);
  const shopCount = listOf(recs, 'shopping')?.rows.length ?? 0;
  const pantryCount = listOf(recs, 'pantry')?.rows.length ?? 0;
  const pickedNotes = picked.map(noteById).filter((n): n is Rec<'note'> => !!n);
  const reviewNotes = (review?.ids ?? []).map(noteById).filter((n): n is Rec<'note'> => !!n);
  const hits = useMemo(
    () => (query.trim() === '' ? [] : searchRecords(recs, query, { kinds: ['reminder', 'note'], sort: 'relevance', desc: false })),
    [recs, query],
  );

  /* ── Moves ── */
  const go = (t: Tab, fid: string | null = null) => {
    setQuery(''); setView('list'); setReview(null); setFolderId(fid); onTab(t);
  };
  const openRecipe = (id: string) => { setQuery(''); setView('list'); setFolderId(null); setCanMake(false); setOpenId(id); onTab('notes'); };
  const togglePick = (id: string) => setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const startCook = (ids: string[], first?: string, variantId?: string | null) => { setView('list'); setCook(newCook(ids, first, variantId ?? null)); };
  const startReview = () => {
    if (picked.length === 0) { toast('Tick the recipes you are making first.'); return; }
    setReview(newReview(recs, pickedNotes));
  };
  const removeFromReview = (id: string) => {
    const next = reviewNotes.filter((n) => n.id !== id);
    setPicked((cur) => cur.filter((x) => x !== id));
    // A different set of recipes is a different plan: freeze it afresh.
    setReview(next.length === 0 ? null : newReview(recs, next));
  };
  const newRecipe = () => {
    const fid = folderId ?? folders[0]?.id;
    const sec = recs.filter((r): r is Rec<'section'> => r.type === 'section' && !r.deleted && r.payload.folderId === fid).sort(byRecOrd)[0];
    if (!fid || !sec) { toast('Make a recipe folder first.'); return; }
    const id = newId();
    const first = allNotes.filter((n) => n.payload.sectionId === sec.id).sort(byRecOrd)[0];
    mutate((e) => e.put({
      id, type: 'note', updated: 0,
      payload: { title: defaultNoteTitle(), body: '', date: null, folderId: fid, sectionId: sec.id, ord: ordBetween(null, first?.payload.ord ?? null) },
    }));
    setEditId(id); setView('edit'); setOpenId(null);
  };
  const closeDetail = () => {
    if (tab === 'notes') { if (review) setPickedPane(false); else setOpenId(null); }
    else if (tab === 'shopping') { if (doneOpen) setDoneOpen(false); else setRowId(null); }
    else setItemId(null);
  };

  // Esc closes the detail pane (Cook and the editor handle their own).
  const escRef = useRef(closeDetail);
  escRef.current = closeDetail;
  const escOk = !cook && view !== 'edit';
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined' || !escOk) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // In a text field the first Esc leaves the field (a half-typed rename
      // stays put); only Esc with no field focused closes the pane.
      if (isTextTarget(e.target) || isTextTarget(document.activeElement)) {
        const el = (isTextTarget(e.target) ? e.target : document.activeElement) as HTMLElement;
        el.blur();
        return;
      }
      escRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [escOk]);

  const noop = useCallback(() => {}, []);
  const nav = useMemo(() => ({ canBack: false, goBack: () => {}, openSearch: () => {}, openTab: (t: Tab) => go(t), openNote: openRecipe }), []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Cook takes the whole window ── */
  if (cook) {
    const cookNotes = cook.ids.map(noteById).filter((n): n is Rec<'note'> => !!n);
    return (
      <NavCtx.Provider value={nav}>
        <View style={[s.cookRoot, { backgroundColor: colors.background }]} testID="wide-cook">
          <CookView
            wide
            notes={cookNotes}
            {...(cook.first !== undefined ? { initialId: cook.first } : {})}
            initialVariantId={cook.variantId}
            state={cook.state}
            onState={setCookState}
            onClose={() => setCook(null)}
            wrapFinish={(panel, close) => (
              <View style={StyleSheet.absoluteFill}>
                <Pressable testID="cook-finish-backdrop" accessibilityLabel="Close" onPress={close} style={[StyleSheet.absoluteFill, s.backdrop]} />
                <View testID="cook-finish-panel" style={s.finishPanel}>{panel}</View>
              </View>
            )}
          />
        </View>
      </NavCtx.Provider>
    );
  }

  /* ── Main pane ── */
  let main: ReactNode;
  if (query.trim() !== '') {
    main = (
      <View style={s.fill} testID="wide-search">
        <View style={s.searchHead}>
          <Text style={s.h1}>Search</Text>
          <Text style={s.sub}>{hits.length === 0 ? 'Nothing matches.' : `${hits.length} ${hits.length === 1 ? 'match' : 'matches'} for “${query.trim()}”`}</Text>
        </View>
        <Scroll style={s.fill} contentContainerStyle={s.searchIn}>
          {hits.map((h) => (
            <Pressable key={`${h.kind}-${h.id}`} testID="search-row" accessibilityRole="button" style={s.hit}
              onPress={() => {
                if (h.kind === 'note') openRecipe(h.id);
                else if (hitSection(recs, h.id) === 'pantry') { go('pantry'); setItemId(h.id); }
                else { go('shopping'); setDoneOpen(false); setRowId(h.id); }
              }}>
              {h.kind === 'note' ? <PageIcon size={16} /> : <TickCircleIcon size={16} />}
              <Text style={s.hitText} numberOfLines={1}>{h.text}</Text>
              <Text style={s.hitKind}>{h.kind === 'note' ? 'Recipe' : hitSection(recs, h.id) === 'pantry' ? 'Pantry' : 'Shopping'}</Text>
            </Pressable>
          ))}
        </Scroll>
      </View>
    );
  } else if (review) {
    main = (
      <View style={s.fill} testID="wide-review">
        <View style={s.backRow}>
          <Pressable testID="review-back" accessibilityRole="button" onPress={() => setReview(null)} style={s.backLink}>
            <Text style={s.backText}>‹ Recipes</Text>
          </Pressable>
          {!detailBeside && (
            <Pressable testID="review-picked" accessibilityRole="button" onPress={() => setPickedPane(true)} style={s.backLink}>
              <Text style={s.backText}>Picked recipes · {review.ids.length}</Text>
            </Pressable>
          )}
        </View>
        <View style={s.reviewCol}>
          <ShoppingReview
            fill
            review={review}
            onChange={setReview}
            onCancel={() => setReview(null)}
            onAdded={() => { setPicked([]); setReview(null); go('shopping'); }}
          />
        </View>
      </View>
    );
  } else if (tab === 'shopping') {
    main = <WideShopping openRowId={rowId} onOpenRow={(id) => { setDoneOpen(false); setRowId(id); }} doneOpen={doneOpen} onDoneShopping={() => { setRowId(null); setDoneOpen(true); }} />;
  } else if (tab === 'pantry') {
    main = <WidePantry openItemId={itemId} onOpenItem={setItemId} />;
  } else if (view === 'edit' && editId) {
    main = (
      <View style={s.editWrap} testID="wide-edit">
        <View style={s.editCol}>
          <Notes
            openNoteId={editId}
            onOpenConsumed={noop}
            wide={{
              onExit: () => { setView('list'); setOpenId(editId); },
              onCook: (id, variantId) => startCook([id], id, variantId),
            }}
          />
        </View>
      </View>
    );
  } else {
    main = (
      <WideRecipes
        title={folderId ? folderName(folderId) : 'All recipes'}
        rows={rows}
        facts={facts}
        folderName={folderName}
        picked={picked}
        openId={openId}
        canMake={canMake}
        onCanMake={() => setCanMake((v) => !v)}
        onNew={newRecipe}
        onPick={togglePick}
        onOpen={(id) => setOpenId(id)}
        onClear={() => setPicked([])}
        onCook={() => startCook(picked)}
        onShop={startReview}
        pickedTitles={pickedNotes.map((n) => n.payload.title)}
      />
    );
  }

  /* ── Detail pane ── */
  let detail: ReactNode = null;
  if (query.trim() === '') {
    if (review) {
      // Beside the Review when there is room; otherwise only on request, so it
      // never covers the Add button.
      if (detailBeside || pickedPane) detail = <PickedPane review={review} notes={reviewNotes} folderName={folderName} onRemove={removeFromReview} onAnother={() => setReview(null)} onClose={() => setPickedPane(false)} />;
    } else if (tab === 'notes') {
      if (view === 'list') {
        const n = noteById(openId);
        if (n) {
          const variantId = variantFor?.id === n.id ? variantFor.variantId : null;
          detail = (
            <RecipeDetail
              key={n.id}
              note={n}
              folderName={folderName(n.payload.folderId)}
              variantId={variantId}
              onVariant={(v) => setVariantFor({ id: n.id, variantId: v })}
              onCook={() => startCook([n.id], n.id, variantId)}
              onEdit={() => { setEditId(n.id); setView('edit'); }}
              onClose={() => setOpenId(null)}
            />
          );
        }
      }
    } else if (tab === 'shopping') {
      if (doneOpen) detail = <DoneShopping fill onCancel={() => setDoneOpen(false)} onDone={() => setDoneOpen(false)} />;
      else if (rowId) detail = <ShoppingRowDetail key={rowId} rowId={rowId} onClose={() => setRowId(null)} />;
    } else if (itemId) {
      detail = <PantryItem fill key={itemId} rowId={itemId} onClose={() => setItemId(null)} onOpenRecipe={openRecipe} />;
    }
  }

  /* ── Sidebar ── */
  const onRecipes = query.trim() === '' && tab === 'notes';
  const sidebar = (
    <>
      <SidebarTitle title="ChefMind" colors={colors} />
      <Field testID="wide-search-field" value={query} onChangeText={setQuery} placeholder="Search" style={s.search} />
      <SidebarItem testID="side-recipes" label="Recipes" count={allNotes.length} active={onRecipes && folderId === null} onPress={() => go('notes')} colors={colors} />
      <SidebarItem testID="side-shopping" label="Shopping" count={shopCount} active={query.trim() === '' && tab === 'shopping'} onPress={() => go('shopping')} colors={colors} />
      <SidebarItem testID="side-pantry" label="Pantry" count={pantryCount} active={query.trim() === '' && tab === 'pantry'} onPress={() => go('pantry')} colors={colors} />
      {folders.length > 0 && <SidebarLabel label="Folders" colors={colors} />}
      {folders.map((f) => (
        <SidebarItem
          key={f.id}
          testID={`side-folder-${f.payload.name}`}
          label={f.payload.name}
          count={allNotes.filter((n) => n.payload.folderId === f.id).length}
          active={onRecipes && folderId === f.id}
          onPress={() => go('notes', f.id)}
          colors={colors}
          leading={<View style={[s.dot, { backgroundColor: f.payload.color }]} />}
        />
      ))}
      <SidebarLabel label={session?.username ?? 'Account'} colors={colors} />
      <SidebarItem testID="side-settings" label="Settings" onPress={() => setSettingsOpen(true)} colors={colors} />
      <SidebarItem testID="side-undo" label="Undo last delete" onPress={() => {
        const back = undoLastDelete();
        toast(back === null ? 'Nothing to undo' : `Restored “${back}”`, 2600);
      }} colors={colors} />
      <SidebarItem testID="side-signout" label="Sign out" onPress={() => { void signOut(); }} colors={colors} trailing={<SyncDot withText />} />
    </>
  );

  return (
    <NavCtx.Provider value={nav}>
      <WideFrame sidebar={sidebar} main={main} detail={detail} onCloseDetail={closeDetail} colors={colors} />
      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
    </NavCtx.Provider>
  );
}

const s = themed(() => StyleSheet.create({
  fill: { flex: 1, minHeight: 0 },
  cookRoot: { flex: 1 },
  backdrop: { backgroundColor: 'rgba(0,0,0,0.25)' },
  finishPanel: { position: 'absolute', top: 0, right: 0, bottom: 0, width: 380, backgroundColor: T.surface, borderLeftWidth: 1, borderLeftColor: T.line },
  search: { marginHorizontal: 4, marginBottom: 10, fontSize: 14, paddingVertical: 8 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  backRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  backLink: { alignSelf: 'flex-start', paddingHorizontal: 24, paddingTop: 18, paddingBottom: 2 },
  backText: { color: T.accent, fontSize: 14, fontWeight: '700' },
  reviewCol: { flex: 1, minHeight: 0, width: '100%', maxWidth: 760, paddingHorizontal: 8 },
  editWrap: { flex: 1, alignItems: 'center' },
  editCol: { flex: 1, width: '100%', maxWidth: 760 },
  searchHead: { paddingHorizontal: 24, paddingTop: 18, paddingBottom: 8 },
  h1: { color: T.text, fontSize: 24, fontWeight: '800' },
  sub: { color: T.dim, fontSize: 14, marginTop: 2 },
  searchIn: { paddingHorizontal: 24, paddingBottom: 24 },
  hit: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, borderBottomWidth: 1, borderBottomColor: T.lineSoft },
  hitText: { flex: 1, color: T.text, fontSize: 15 },
  hitKind: { color: T.dim, fontSize: 12 },
}));
