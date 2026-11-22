/**
 * MealMind at desktop size (window >= 900): a sidebar, a main pane and a
 * detail pane, in the suite's shared WideFrame. Every MealMind action lives
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
 * the bar agree: a tap on a row selects that one recipe and shows it, a tick
 * adds to the set (`tapRecipe` / `tickRecipe` / `shownRecipe` in wideflows).
 * Cook is one recipe; another is added from inside Cook. Below 900 App never
 * mounts this.
 *
 * The main pane wears the suite's top bar (chrome.tsx's TopBar, as CalMind's
 * wide layout does): the section's title, the folder pie on Recipes, and the
 * username pill with Account, Settings, Search, Undo last delete and Sign out.
 * The sidebar holds navigation only.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { byRecOrd, duplicateItem, newId, ordBetween, defaultNoteTitle, searchRecords, type Rec } from '@calmind/core';
import { useStore } from '../store';
import { APP_NAME } from '../brand';
import { themed, T } from '../theme';
import { Field, Scroll } from '../ui';
import { SidebarItem, SidebarLabel, SidebarTitle, WideFrame, useWide } from '../components/WideFrame';
import { AccountMenu, type AccountMenuItem } from '../components/SuiteTopBar';
import { PieDot } from '../components/PieDot';
import { FolderManager } from '../components/FolderManager';
import { useToast } from '../components/Toast';
import { ShoppingReview } from '../components/ShoppingReview';
import { DoneShopping } from '../components/DoneShopping';
import { PantryItem } from '../components/PantryItem';
import { CookView } from '../components/CookView';
import { PageIcon, TickCircleIcon } from '../components/KindIcons';
import { NavCtx, type Tab } from '../nav';
import { Notes } from '../screens/Notes';
import { TopBar } from '../chrome';
import { pantryTexts } from '../addToShopping';
import { listOf } from '../chefflows';
import { addToCook, dropFromCook, newCook, newReview, useChefSession } from '../session';
import { NO_SELECTION, closeRecipePane, hitSection, isTextTarget, recipeFacts, recipeFolders, recipeGroups, selectOnly, shownRecipe, tapRecipe, tickRecipe, type RecipeSel } from '../wideflows';
import { wideColors } from './parts';
import { WideRecipes } from './WideRecipes';
import { RecipeDetail } from './RecipeDetail';
import { PickedPane } from './PickedPane';
import { ShoppingRowDetail, WidePantry, WideShopping } from './WideLists';

type View_ = 'list' | 'edit';

export function ChefWide({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
  const { recs, mutate } = useStore();
  const toast = useToast();
  const colors = wideColors();
  const { detailBeside } = useWide();
  const [pickedPane, setPickedPane] = useState(false);

  const [query, setQuery] = useState('');
  const [folderId, setFolderId] = useState<string | null>(null);
  // Picks, Review and Cook are the session's, shared with the phone layout.
  const { picked, setPicked, review, setReview, cook, setCook, setCookState } = useChefSession();
  const [view, setView] = useState<View_>('list');
  const [openId, setOpenId] = useState<string | null>(null);
  const [variantFor, setVariantFor] = useState<{ id: string; variantId: string | null } | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [doneOpen, setDoneOpen] = useState(false);
  const [rowId, setRowId] = useState<string | null>(null);
  const [itemId, setItemId] = useState<string | null>(null);
  const [manageFolders, setManageFolders] = useState(false);
  // The sidebar's search field, so the account menu's Search can focus it.
  const searchField = useRef<TextInput | null>(null);

  /* ── Data ── */
  const pantry = useMemo(() => pantryTexts(recs), [recs]);
  const cache = useRef(new Map<string, { body: string; key: string; fact: { ingredients: number; buy: number | null } }>());
  const allNotes = useMemo(() => recs.filter((r): r is Rec<'note'> => r.type === 'note' && !r.deleted), [recs]);
  const facts = useMemo(() => recipeFacts(allNotes, pantry, cache.current), [allNotes, pantry]);
  const folders = useMemo(() => recipeFolders(recs), [recs]);
  const folderName = useCallback((id: string) => folders.find((f) => f.id === id)?.payload.name ?? '', [folders]);
  const groups = useMemo(() => recipeGroups(recs, { folderId }), [recs, folderId]);
  const noteById = (id: string | null) => (id ? allNotes.find((n) => n.id === id) : undefined);
  const shopCount = listOf(recs, 'shopping')?.rows.length ?? 0;
  const pantryCount = listOf(recs, 'pantry')?.rows.length ?? 0;
  const pickedNotes = picked.map(noteById).filter((n): n is Rec<'note'> => !!n);
  // The selection: the session's picked set plus the recipe last opened. What
  // the detail pane shows is READ off the two (`shownRecipe`), so a set cleared
  // or pruned anywhere else closes the pane by itself.
  const sel: RecipeSel = { picked, openId };
  const setSel = (next: RecipeSel) => { setPicked(next.picked as string[]); setOpenId(next.openId); };
  const shownId = shownRecipe(sel);
  const variantOf = (id: string) => (variantFor?.id === id ? variantFor.variantId : null);
  const reviewNotes = (review?.ids ?? []).map(noteById).filter((n): n is Rec<'note'> => !!n);
  const hits = useMemo(
    () => (query.trim() === '' ? [] : searchRecords(recs, query, { kinds: ['reminder', 'note'], sort: 'relevance', desc: false })),
    [recs, query],
  );

  /* ── Moves ── */
  const go = (t: Tab, fid: string | null = null) => {
    setQuery(''); setView('list'); setReview(null); setFolderId(fid); onTab(t);
  };
  const openRecipe = (id: string) => { setQuery(''); setView('list'); setFolderId(null); setSel(selectOnly(id)); onTab('notes'); };
  // ONE recipe; a second is added from inside Cook ("+ Add a recipe").
  const startCook = (id: string, variantId: string | null) => { setView('list'); setCook(newCook([id], id, variantId)); };
  const duplicate = (id: string) => {
    const copyId = newId();
    const res = duplicateItem(recs, id, () => copyId);
    if ('error' in res) { toast('Could not duplicate that recipe.'); return; }
    mutate((e) => res.put.forEach((r) => e.put(r)));
    setSel(selectOnly(copyId));
    toast('Duplicated.');
  };
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
    if (tab === 'notes') { if (review) setPickedPane(false); else setSel(closeRecipePane(sel)); }
    else if (tab === 'shopping') { if (doneOpen) setDoneOpen(false); else setRowId(null); }
    else setItemId(null);
  };

  // Esc closes the detail pane (Cook and the editor handle their own); on the
  // recipe table it deselects, ticks and all.
  const escRef = useRef(closeDetail);
  escRef.current = tab === 'notes' && !review && query.trim() === '' ? () => setSel(NO_SELECTION) : closeDetail;
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
  // Search, from the account menu: after the menu has closed and handed focus
  // back to its button, the sidebar's field takes it.
  const openSearch = () => { setTimeout(() => searchField.current?.focus(), 60); };
  const nav = useMemo(() => ({ canBack: false, goBack: () => {}, openSearch, openTab: (t: Tab) => go(t), openNote: openRecipe }), []); // eslint-disable-line react-hooks/exhaustive-deps

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
            onAdd={(id) => setCook((c) => (c ? addToCook(c, id) : c))}
            onDrop={(id) => setCook((c) => (c ? dropFromCook(c, id) : c))}
            wrapFinish={(panel, close) => (
              <View style={StyleSheet.absoluteFill}>
                <Pressable testID="cook-finish-backdrop" accessibilityLabel="Close" onPress={close} style={[StyleSheet.absoluteFill, s.backdrop]} />
                <View testID="cook-finish-panel" style={s.finishPanel}>{panel}</View>
              </View>
            )}
            wrapAdd={(panel, close) => (
              <View style={StyleSheet.absoluteFill}>
                <Pressable testID="cook-add-backdrop" accessibilityLabel="Close" onPress={close} style={[StyleSheet.absoluteFill, s.backdrop]} />
                <View testID="cook-add-panel" style={s.finishPanel}>{panel}</View>
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
              onExit: () => { setView('list'); setSel(selectOnly(editId)); },
              onCook: (id, variantId) => startCook(id, variantId),
            }}
          />
        </View>
      </View>
    );
  } else {
    main = (
      <WideRecipes
        title={folderId ? folderName(folderId) : 'All recipes'}
        groups={groups}
        facts={facts}
        picked={picked}
        shownId={shownId}
        onNew={newRecipe}
        onTick={(id) => setSel(tickRecipe(sel, id))}
        onTap={(id) => setSel(tapRecipe(sel, id))}
        onClear={() => setSel(NO_SELECTION)}
        onCook={() => { const id = picked[0]; if (id && picked.length === 1) startCook(id, variantOf(id)); }}
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
        const n = noteById(shownId);
        if (n) {
          const variantId = variantOf(n.id);
          detail = (
            <RecipeDetail
              key={n.id}
              note={n}
              folderName={folderName(n.payload.folderId)}
              variantId={variantId}
              onVariant={(v) => setVariantFor({ id: n.id, variantId: v })}
              onCook={() => startCook(n.id, variantId)}
              onEdit={() => { setEditId(n.id); setView('edit'); }}
              onDuplicate={() => duplicate(n.id)}
              onClose={() => setSel(closeRecipePane(sel))}
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
      <SidebarTitle title={APP_NAME} colors={colors} />
      <Field testID="wide-search-field" {...({ ref: (el: TextInput | null) => { searchField.current = el; } } as object)}
        value={query} onChangeText={setQuery} placeholder="Search" style={s.search} />
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
    </>
  );

  /* ── The bar over the main pane: the phone's title, the folder pie, the username pill ── */
  const barTitle = query.trim() !== '' ? 'Search' : tab === 'shopping' ? 'Shopping' : tab === 'pantry' ? 'Pantry' : 'Recipes';
  const shownFolder = folderId ? folders.find((f) => f.id === folderId) : undefined;
  const folderItems: AccountMenuItem[] = [
    { key: 'all', label: 'All recipes', testID: 'wide-folder-all', leading: <PieDot rainbow colors={[]} size={14} />,
      trailing: !shownFolder ? <Text style={s.tick}>✓</Text> : undefined, onPress: () => go('notes') },
    ...folders.map((f) => ({
      key: f.id, label: f.payload.name, testID: `wide-folder-${f.payload.name}`,
      leading: <View style={[s.dot, { backgroundColor: f.payload.color }]} />,
      trailing: shownFolder?.id === f.id ? <Text style={s.tick}>✓</Text> : undefined, onPress: () => go('notes', f.id),
    })),
    { key: 'manage', label: 'Manage folders…', testID: 'wide-folder-manage', onPress: () => setManageFolders(true) },
  ];
  const picker = onRecipes && !review ? (
    <AccountMenu
      colors={{ background: T.bg, surface: T.surface, line: T.line, text: T.text, dim: T.dim, accent: T.accent }}
      testID="pick-notes"
      label={`Folders: ${shownFolder ? shownFolder.payload.name : 'All recipes'}`}
      trigger={shownFolder
        ? <PieDot colors={[shownFolder.payload.color]} size={16} />
        : <PieDot rainbow colors={folders.map((f) => f.payload.color)} size={16} />}
      items={folderItems}
    />
  ) : undefined;

  return (
    <NavCtx.Provider value={nav}>
      <WideFrame sidebar={sidebar} main={<View style={s.fill}><TopBar title={barTitle} controls={picker} />{main}</View>}
        detail={detail} onCloseDetail={closeDetail} colors={colors} />
      {manageFolders && <FolderManager app="notes" onClose={() => setManageFolders(false)} />}
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
  tick: { color: T.accent, fontSize: 14, fontWeight: '700' },
  // The Review's back row and its column are one block, centred in the pane.
  backRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', width: '100%', maxWidth: 760, alignSelf: 'center' },
  backLink: { alignSelf: 'flex-start', paddingHorizontal: 24, paddingTop: 2, paddingBottom: 2 },
  backText: { color: T.accent, fontSize: 14, fontWeight: '700' },
  reviewCol: { flex: 1, minHeight: 0, width: '100%', maxWidth: 760, alignSelf: 'center', paddingHorizontal: 8 },
  editWrap: { flex: 1, alignItems: 'center' },
  editCol: { flex: 1, width: '100%', maxWidth: 760 },
  searchHead: { paddingHorizontal: 24, paddingTop: 2, paddingBottom: 8 },
  sub: { color: T.dim, fontSize: 14, marginTop: 2 },
  searchIn: { paddingHorizontal: 24, paddingBottom: 24 },
  hit: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, borderBottomWidth: 1, borderBottomColor: T.lineSoft },
  hitText: { flex: 1, color: T.text, fontSize: 15 },
  hitKind: { color: T.dim, fontSize: 12 },
}));
