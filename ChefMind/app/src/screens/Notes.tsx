/**
 * Recipes — the Notes screen, renamed on the owner's word (2026-08-21): this app
 * holds recipes and nothing else, and it uses CalMind's recipe and text
 * interface unchanged. Only the LABELS moved. The record type is still 'note',
 * the folder's app is still 'notes', and every stored preference still says
 * notes — renaming those would be a migration of his data to change a word on
 * screen.
 *
 * Folder blocks with gold sections, a row opens the editor — title
 * plus a plain-text body autosaving on the store's debounce. Notes never
 * convert out and never repeat; a date in the title puts one on the calendar.
 */
import React, { memo, useEffect, useMemo, useState, useRef } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View, type PanResponderInstance } from 'react-native';
import { LONG_PRESS_MS, defaultNoteTitle, looksLikeDefaultNoteTitle, deleteSection, renameSection, sectionNameTaken, byRecOrd, findVariant, ingredientParts, isRecipeNote, joinRecipeBody, liveSections, recipeSections, richLines, scaleRecipeBody, splitRecipeBody, variantBody, duplicateItem, prefsPut, moveNote, moveSection, moveSectionEmptyingFolder, newId, nowStr, ordBetween, parseWhenFromText, todayStr, type Rec, type RecipeVariant } from '@calmind/core';
import * as Clipboard from 'expo-clipboard';
import { useStore } from '../store';
import { UnitBadge } from '../components/IngredientBadge';
import { RichText } from '../components/RichText';
import { useNav } from '../nav';
import { themed, T } from '../theme';
import { TopBar } from '../chrome';
import { FolderDot, FolderPick, useFolderView } from '../components/FolderPick';
import { CircleBtn, ConfirmDelete, DayPickBtn, DeletePill, Field, FoldCaret, Pill, Scroll, TOPBAR_CTRL, TOPBAR_DOT_TOP, WebHitSlop } from '../ui';
import { useFolds } from '../folds';
import { DayPick } from '../components/DayPick';
import { Dropdown } from '../components/Dropdown';
import { flatKey, useRowDrag } from '../components/rowdrag';
import { dropTarget, slotEntries } from '../components/rowslots';
import { useSectionDrag, type SectionSlot } from '../components/sectiondrag';
import { useSwipeLeft } from '../components/swiperow';
import { PickBar } from '../components/PickBar';
import { Chevron } from '../components/Chevron';
import { SyncDot, syncWord } from '../components/SyncDot';
import { useToast } from '../components/Toast';
import { addToShopping, ingredientsOf, shopMessage } from '../addToShopping';
import { EditExit } from '../components/EditExit';
import { RecipeEditor } from './RecipeEditor';
import { ItemModal } from '../components/ItemModal';

// Half, as written, and double — the three a cook actually asks for.
// The id stays ASCII: it reaches native as an accessibility identifier, and
// adb/XCUITest are no place to be matching on '½'.
const SCALES: [number, string, string][] = [[0.5, '½×', 'half'], [1, '1×', 'one'], [2, '2×', 'double']];

/**
 * State that belongs to whichever note is open, and lets go by itself.
 *
 * Three real bugs tonight were one shape: something the screen remembered
 * about the note you just left. A half-typed draft shown as the next note's
 * body, an armed delete turning the next note's two-press delete into one
 * press, a text selection measured in a body that is no longer on screen.
 * Each was safe alone and dangerous the moment you moved between notes, which
 * is simply how anyone reads a recipe collection.
 *
 * Resetting them in an effect works and has to be remembered every time a new
 * piece of state is added — and being remembered every time is exactly what
 * this failed at. Declared through here instead, state resets during the
 * render in which the note changes, so the wrong value is never shown even
 * once, and the next person gets it for free.
 */
const NO_SECTIONS: Rec<'section'>[] = [];
const NO_NOTES: Rec<'note'>[] = [];

function useNoteScoped<T>(noteId: string | null, initial: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(initial);
  const [seen, setSeen] = useState(noteId);
  if (seen !== noteId) {
    setSeen(noteId);
    setValue(initial);
  }
  return [value, setValue];
}

/**
 * The rendered body — one renderer for the own and the shared note, so the
 * treatment cannot drift. An ingredient bullet wears its measure as the
 * iconized badge (the owner, 2026-08-18) with only the NAME in the line's text; a
 * bullet is an ingredient while the walk is inside the **Ingredients**
 * heading and no other bold heading has ended it — the same structural read
 * fromMarkers makes, done here on richLines' output. Scaling costs nothing:
 * the caller hands in the already-scaled body, so the badge reads "3 cups"
 * at 1½× exactly as the text used to.
 *
 * `badges` is passed only by the recipe CARD. A plain note that happens to
 * carry the heading — the owner's hand-written ones do — keeps every word of its
 * lines exactly as typed (2026-08-19: the raw text, like it was).
 */
function RichBody({ body, onLine, badges }: { body: string; onLine?: (text: string) => void; badges?: boolean }) {
  let inIngredients = false;
  return (
    <>
      {richLines(body).map((ln, i) => {
        const boldHead = ln.kind === 'plain' && ln.runs.length === 1 && !!ln.runs[0]!.bold;
        // A bold line ending in ':' is a SUBHEADER ("For the béchamel:") —
        // it subdivides the block it is in rather than ending it, so the
        // bullets after it keep their badges.
        if (boldHead && !/:$/.test(ln.runs[0]!.text.trim())) inIngredients = /^ingredients$/i.test(ln.runs[0]!.text.trim());
        const raw = ln.runs.map((r) => r.text).join('');
        const parts = badges && !boldHead && inIngredients && ln.kind === 'bullet' ? ingredientParts(raw) : null;
        // Tap an ingredient or a step and it becomes a REMINDER (the owner,
        // 2026-08-18) — only where the caller offers the handler, which is
        // the recipe card of your own note and nowhere else.
        const press = onLine && !boldHead && (ln.kind === 'number' || (inIngredients && ln.kind === 'bullet'))
          ? () => onLine(raw)
          : undefined;
        const content = parts?.qty ? (
          <>
            {/* RichText, not a bare <Text>: this branch joined the runs back
                into a plain string to get at the name, which printed the
                asterisks it had just parsed away (the owner, 2026-08-20). */}
            <RichText text={parts.name || raw} style={s.rtText} />
            <UnitBadge qty={parts.qty} unit={parts.unit} />
          </>
        ) : (
          <Text style={[s.rtText, ln.kind === 'quote' && s.rtQuoteText]}>
            {ln.runs.map((r, j) => (
              <Text key={j} style={[r.bold && s.rtBold, r.italic && s.rtItalic, r.under && s.rtUnder]}>
                {r.text || (ln.runs.length === 1 ? ' ' : '')}
              </Text>
            ))}
          </Text>
        );
        return (
          <View key={i} style={[s.rtLine, ln.kind === 'quote' && s.rtQuote, ln.kind === 'number' && s.rtStep]}>
            {ln.kind === 'bullet' && <Text style={s.rtDot}>•</Text>}
            {ln.kind === 'number' && <Text style={s.rtNum}>{ln.num}</Text>}
            {press ? (
              <Pressable testID="recipe-line" style={s.rtPress} onPress={press}>
                {content}
              </Pressable>
            ) : (
              content
            )}
          </View>
        );
      })}
    </>
  );
}

/**
 * The whole rendered body: prose on its banks, the recipe as an INSET card
 * (the owner, 2026-08-18: "recipes should have a nice inset formatting in the
 * note"). The card is for notes the Recipe page SAVED — `recipe` here is
 * core's isRecipeNote — not for any body wearing the marker shape: the owner's
 * hand-written notes wear it and stay plain (2026-08-19). The tap-to-remind
 * handler and the badges reach only the card's rows.
 */
function NoteBody({ body, recipe, onLine }: { body: string; recipe: boolean; onLine?: (text: string) => void }) {
  const split = recipe ? splitRecipeBody(body) : null;
  if (!split) return <RichBody body={body} />;
  return (
    <>
      {split.before !== '' && <RichBody body={split.before} />}
      <View testID="recipe-card" style={s.recipeCard}>
        <Text style={s.recipeTag}>Recipe</Text>
        <RichBody body={split.recipe} onLine={onLine} badges />
      </View>
      {split.after !== '' && <RichBody body={split.after} />}
    </>
  );
}

export function Notes({ openNoteId, onOpenConsumed }: { openNoteId?: string | null; onOpenConsumed?: () => void }) {
  const { recs, mutate, sharedRecs, sharedPartnerLabel, syncState, persistFailed } = useStore();
  const nav = useNav();
  const { view, visible: visibleFolders, visibleShared, sharedView, sharedPartner } = useFolderView('notes');
  const setNotePrefs = (lastView: string) => mutate((e) => e.put(prefsPut(recs, 'notes', { lastView })));
  const [openId, setOpenId] = useState<string | null>(null);
  /** The folder picker's card, raised from the username menu's Folders row. */
  const [pickOpen, setPickOpen] = useState(false);
  const [sel, setSel] = useNoteScoped(openId, { start: 0, end: 0 });
  const [dateOpen, setDateOpen] = useNoteScoped(openId, false);
  const [bodyEditing, setBodyEditing] = useNoteScoped(openId, false);
  // While the cursor is in the body, the field holds its own copy of the text.
  // The record still gets every keystroke — this only stops the 30s poll from
  // pulling a newer version from another device out from under a half-typed
  // sentence. Reading stale text for as long as you are typing is the same
  // bargain every editor makes; losing the sentence is not.
  const [draft, setDraft] = useNoteScoped<string | null>(openId, null);
  // The title has no edit mode — it is always a live field — so it needs the
  // same shelter, scoped to having focus rather than to a mode.
  const [titleDraft, setTitleDraft] = useNoteScoped<string | null>(openId, null);
  // Doubling a recipe is a way of READING it, not an edit — nothing is
  // written, and 1× is always one tap away.
  const [scale, setScale] = useNoteScoped(openId, 1);
  /**
   * Which VARIANT of this card is being shown, and whether the manage window
   * is open. Note-scoped like the scale, and for the same reason: a variant
   * chosen on one recipe means nothing on the next, and carrying it across
   * would show a card filtered by a section it does not have.
   *
   * Deliberately NOT stored. Which variant you last looked at is a view, like
   * the scale — it is not a fact about the recipe, and syncing it would make
   * two devices argue about what the card says.
   */
  const [variantId, setVariantId] = useNoteScoped(openId, null as string | null);
  const [variantMenu, setVariantMenu] = useNoteScoped(openId, false);
  const [variantsOpen, setVariantsOpen] = useState(false);
  /**
   * Which variant's checkboxes are open in the manage window — the owner's rule:
   * "only show the check boxes for the varients when tapped on a varient which
   * allows renaming the varient and modifying the selected sections". One at a
   * time, so a window with four variants is four rows rather than four lists.
   */
  const [openVariantId, setOpenVariantId] = useState<string | null>(null);
  const [recipeOpen, setRecipeOpen] = useNoteScoped(openId, false);
  // The recipe-note editor splits into [above][blob][below] (the owner,
  // 2026-08-18): the blob is the marker region, not editable here and not
  // removable at all — its content is the Recipe page's business. The two
  // banks keep their own drafts so a trailing newline mid-thought is not
  // trimmed away by the canonical join the STORE receives.
  const [beforeDraft, setBeforeDraft] = useNoteScoped<string | null>(openId, null);
  const [afterDraft, setAfterDraft] = useNoteScoped<string | null>(openId, null);
  // A hop between the two banks must not read as leaving the editor: each
  // blur arms a short fuse, the other's focus defuses it.
  const partsBlurTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const partFocus = () => {
    if (partsBlurTimer.current) {
      clearTimeout(partsBlurTimer.current);
      partsBlurTimer.current = null;
    }
  };
  const partBlur = () => {
    partsBlurTimer.current = setTimeout(() => {
      partsBlurTimer.current = null;
      setBodyEditing(false);
      setDraft(null);
      setBeforeDraft(null);
      setAfterDraft(null);
    }, 120);
  };
  // What a tapped ingredient or step is becoming: the reminder sheet's text.
  const [remindText, setRemindText] = useState<string | null>(null);

  const swipe = useSwipeLeft();
  // The suite's page edit mode: long-press a row to enter, tap away or
  // Escape to leave; grips and row controls exist only inside it.
  const [pageEdit, setPageEdit] = useState(false);
  /**
   * The recipes ticked, for "add to the shopping list".
   *
   * INDEPENDENT OF EDIT MODE since 2026-09-16 — the owner: "always show the
   * selection circles, not just in edit mode.. edit mode just brings up
   * dragging icons and other buttons.. when an item is selected, it brings up
   * the 1 Selected pane". Selection used to BE what edit mode was for, which
   * made the commonest thing on this screen — pick three recipes, send them
   * to the list — cost a mode you first had to know how to enter.
   *
   * So the circle is always drawn, the PickBar answers to the SELECTION
   * rather than to the mode, and leaving edit mode no longer clears what you
   * picked: nothing about it was ever invisible, and Clear is right there in
   * the bar. What edit mode still owns is the grips, the date chips, the
   * duplicate and delete buttons — the things that change a recipe rather
   * than choose one.
   */
  const [selected, setSelected] = useState<string[]>([]);
  const endEdit = () => setPageEdit(false);
  const toggleSelected = (id: string) =>
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  /**
   * The DOUBLE TAP into edit mode (the owner, 2026-08-21).
   *
   * RN has no onDoubleTap, and the naive version does not work at all: the
   * FIRST tap opens the recipe, so the second one lands inside the editor and
   * the gesture can never complete. The open has to WAIT to find out whether a
   * second tap is coming.
   *
   * 250ms of waiting, which is the cost of having the gesture at all and is
   * under the ~300ms people report as "instant". A long press (350ms) is the
   * faster route into edit mode and always was; this is for the hand that
   * reaches for a double tap first.
   *
   * The timer is cancelled on unmount — opening a recipe 250ms after the
   * screen has gone is a setState on something that is no longer there.
   */
  const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTap = useRef<{ id: string; at: number } | null>(null);
  /** A hold just happened, so the click ending it is not a tap — see the same
   *  ref on the two lists for what react-native-web does here. */
  const justHeld = useRef(false);
  useEffect(() => () => { if (tapTimer.current) clearTimeout(tapTimer.current); }, []);
  /** The editor's Copy says so in a popup — see components/Toast. */
  const toast = useToast();
  /** Which note the mini date editor is open for, or null. */
  const [dateFor, setDateFor] = useState<string | null>(null);
  /** What is being TYPED in that sheet, before it parses into a real date. */
  const [listPickOpen, setListPickOpen] = useState(false);
  /**
   * Was this editor reached from another TAB (upstream: the calendar's day
   * panel; here: a search hit) rather than from the notes list?
   *
   * The owner: the editor's back should return to where you came from. "← All
   * notes" always went to the list, so opening a note from the calendar and
   * pressing back left you in Notes — one tab away from what you were doing.
   */
  const cameFromTab = useRef(false);
  // Two levels, one hook each — see folds.ts for what the hand-rolled copies
  // of this had drifted into. The old local names are kept so every read
  // below still says what it means.
  const sectionFolds = useFolds('calmind.folded.notes');
  const folderFolds = useFolds('calmind.foldedFolders.notes');
  const nfolded = sectionFolds.shut;
  const foldedFolders = folderFolds.shut;
  const toggleNFold = sectionFolds.toggle;
  const toggleFolderFold = folderFolds.toggle;
  useEffect(() => {
    if (!pageEdit || typeof document === 'undefined') return;
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') setPageEdit(false); };
    // Capture phase: a focused field can swallow Escape before it bubbles.
    document.addEventListener('keydown', onKey, true);
    // The suite's rule, the same one Reminders uses: a tap leaves edit mode
    // unless it lands on the thing you are editing or an edit control. Notes
    // had the identical gap and I fixed only Reminders first — same two ways
    // out, Escape and an invisible strip at the bottom of the scroll content,
    // neither of which exists on a phone.
    // What may swallow a click and still MEAN "stay in edit mode".
    //
    // This was once just role/input/textarea, on the belief that every row and
    // button is a react-native-web Pressable and those do not propagate their
    // click to document. That belief was WRONG: RNW only sets role="button"
    // when accessibilityRole is given, and a plain <Pressable> — which is what
    // a row is — renders a bare <div> whose click bubbles all the way up. So
    // the rule was closing edit mode on the very long-press that opened it,
    // and the Notes spec caught it the moment the collapse-all stopped being
    // the first thing in the row.
    //
    // Named prefixes, not a whole screen's: '[data-testid^="cal-"]' was tried
    // and it kept the day's own TITLE, which is a label and must exit.
    const KEEP = [
      '[role="button"]', 'input', 'textarea', 'select',
      '[data-testid^="note-"]', '[data-testid^="nsec-"]', '[data-testid^="sec"]',
      '[data-testid^="fold"]', '[data-testid^="pick-"]', '[data-testid^="tab-"]',
    ].join(',');
    // The click that BELONGS to the gesture that opened edit mode must not
    // also close it. A long-press flips pageEdit at ~480ms, the grips appear,
    // the row shifts under the cursor, and the mouseup that follows lands on
    // whatever is now beneath it — a bare container with no testid, which no
    // allow-list can recognise. So edit mode opened and shut in one press.
    //
    // The suite guards the same thing the same way (`suppressClick`). The
    // rule here is exact rather than a timeout: this listener is attached
    // MID-PRESS, so the opening gesture's pointerdown already happened and
    // its trailing click is the one click that arrives without a pointerdown
    // of its own. Anything a person taps afterwards begins with a pointerdown,
    // which clears the flag. A time window was tried first and swallowed
    // deliberate taps that came too soon after — it made the tests red, which
    // is the tests doing their job.
    let ownClick = true;
    const onDown = () => { ownClick = false; };
    document.addEventListener('pointerdown', onDown, true);
    const onClick = (ev: Event) => {
      if (ownClick) { ownClick = false; return; }
      const t = ev.target as Element | null;
      if (t && typeof t.closest === 'function' && t.closest(KEEP)) return;
      setPageEdit(false);
    };
    // BUBBLE, deliberately, though habits needs capture for the same job.
    //
    // Capture was tried here and reverted the same hour: it makes MORE clicks
    // reach this listener — every one react-native-web was stopping at a
    // Pressable — and on this screen that closes the inline editor mid-edit.
    // Two repeat-editor specs went red immediately. Habits has no inline
    // editing and a grid of Pressables that swallowed the taps meant to
    // leave, which is why the same change is right there and wrong here.
    document.addEventListener('click', onClick);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('click', onClick);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [pageEdit]);
  // The date is PICKED from a calendar now, never typed into an m/d box
  // (the owner, 2026-08-20) — one open/closed flag is all the state left here.
  const [edPickOpen, setEdPickOpen] = useState(false);

  // A note we JUST made should open ready to type, not just open. The scoped
  // states reset on the render where openId changes, so setting bodyEditing
  // in the create handler would be wiped — this effect runs after that reset
  // and wins. The ref names the one note this applies to: opening an existing
  // note stays read-first.
  const freshEdit = React.useRef<string | null>(null);
  // autoFocus on a TextInput that mounts mid-transition is unreliable on iOS
  // — the field appears, the caret does not, and the keyboard never rises.
  // Focusing through a ref on the next tick is the version that actually
  // fires on a device; on web it is a harmless no-op over autoFocus.
  const bodyRef = React.useRef<TextInput | null>(null);
  const titleRef = React.useRef<TextInput | null>(null);
  // Whether THIS editing session opened on a recipe note — decided when the
  // editor opens, never re-decided mid-keystroke, or typing markers into a
  // plain note would swap the field out from under the typing hand.
  const editAsRecipe = React.useRef(false);
  // The pending body focus, so leaving the note — or a TITLE TAP — can call
  // it off. The cancel-on-title-focus was tried once and rejected ("no hand
  // is that fast"); the owner settled it the other way on 2026-08-18: "tapping
  // the title should switch to editing the title." So a title focus now
  // cancels the pending steal AND collapses the body back to its view —
  // which is also what ends the note-focus flake (TODO §2): the two orders
  // of the old 50ms race now CONVERGE on the same state, title focused and
  // body viewed, instead of diverging on who won.
  const freshFocus = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelFreshFocus = () => {
    if (freshFocus.current) {
      clearTimeout(freshFocus.current);
      freshFocus.current = null;
    }
  };
  React.useEffect(() => {
    if (openId && freshEdit.current === openId) {
      freshEdit.current = null;
      // The caret goes to the BODY. The owner said '+ should go directly to
      // editing the new note' twice, and the default title exists so the note
      // is not blank in the list — his words about selection were
      // conditional ('IF you focus the input field'), describing what a TAP
      // on the title does, not asking for the caret to start there. Putting
      // it in the title made you dismiss a keyboard to write anything.
      // The field does not exist until this has rendered, so the focus call
      // waits a tick rather than racing the mount.
      editAsRecipe.current = false; // a note just made has no marker yet
      setBodyEditing(true);
      freshFocus.current = setTimeout(() => {
        freshFocus.current = null;
        bodyRef.current?.focus();
      }, 50);
    }
    // Leaving the note before the tick is up must not hand the caret to
    // whatever body is on screen by then.
    return cancelFreshFocus;
  }, [openId, setBodyEditing]);
  // Another screen (Search) opened a note — land in its editor, as prod does.
  React.useEffect(() => {
    if (openNoteId) {
      freshEdit.current = openNoteId;
      cameFromTab.current = true;
      setOpenId(openNoteId);
      onOpenConsumed?.();
    }
  }, [openNoteId, onOpenConsumed]);
  const [addingSection, setAddingSection] = useState<string | null>(null); // folderId
  const [newSecName, setNewSecName] = useState('');

  const { folders, sectionsOf, notesOf, selectableIds } = useMemo(() => {
    const folders = visibleFolders;
    const sections = recs.filter((r): r is Rec<'section'> => r.type === 'section').sort(byRecOrd);
    const notes = recs.filter((r): r is Rec<'note'> => r.type === 'note').sort(byRecOrd);
    // Grouped once (sorted order kept), so a lookup is a Map hit rather than a
    // filter over every record — it is called per section and per row, per render.
    const secByFolder = new Map<string, Rec<'section'>[]>();
    for (const x of sections) { const a = secByFolder.get(x.payload.folderId); if (a) a.push(x); else secByFolder.set(x.payload.folderId, [x]); }
    const noteBySec = new Map<string, Rec<'note'>[]>();
    for (const x of notes) { const a = noteBySec.get(x.payload.sectionId); if (a) a.push(x); else noteBySec.set(x.payload.sectionId, [x]); }
    const sectionsOf = (fid: string) => secByFolder.get(fid) ?? NO_SECTIONS;
    const notesOf = (sid: string) => noteBySec.get(sid) ?? NO_NOTES;
    // Everything Select-all can reach: the recipes that are ON SCREEN, in the
    // folders currently shown. Not every note in the store — selecting rows
    // that are folded away, filtered out or a partner's would hand the
    // shopping list ingredients from recipes nobody can see they picked.
    const selectableIds = folders.flatMap((f) => sectionsOf(f.id).flatMap((sec) => notesOf(sec.id).map((n) => n.id)));
    return { folders, sectionsOf, notesOf, selectableIds };
  }, [recs, visibleFolders]);

  /** Every section, so the button can both act and show which way it points. */
  const mySectionIds = folders.flatMap((f) => sectionsOf(f.id).map((x) => x.id));
  // …and the partner's, when their blocks are actually on screen. The owner asked
  // for this after the shared folds landed: a collapse-all that skipped them
  // left the button claiming "all collapsed" over sections that were still
  // open. Only under the All view with a partner, because that is the only
  // place those blocks render — counting sections that are not drawn would
  // make the arrow point the wrong way for a reason nobody could see.
  const sharedSectionIds =
    view === 'all' && sharedPartner
      ? visibleShared.flatMap((f) =>
          sharedRecs
            .filter((r): r is Rec<'section'> => r.type === 'section' && r.payload.folderId === f.id)
            .map((x) => `sh:${x.id}`),
        )
      : [];
  const allSectionIds = [...mySectionIds, ...sharedSectionIds];
  /** The folder level, keyed exactly as its carets key their folds. */
  const allFolderIds = [
    ...folders.map((f) => f.id),
    ...(view === 'all' && sharedPartner ? visibleShared.map((f) => `sh:${f.id}`) : []),
  ];
  /**
   * Hold a caret, fold its whole level — the collapse-all button's job, moved
   * onto the control it was describing (the owner, 2026-09-16).
   *
   * `wasOpen` is the state of the caret that was HELD, not a toggle of some
   * remembered all-or-nothing: hold an open one and the level closes, hold a
   * closed one and it opens. That makes "put this all away" one gesture on
   * whatever is still open, which the old button could not do — it could only
   * ever mean one of this screen's two levels, and it had picked sections.
   */
  const foldAllSections = (wasOpen: boolean) => sectionFolds.foldAll(allSectionIds, wasOpen);
  const foldAllFolders = (wasOpen: boolean) => folderFolds.foldAll(allFolderIds, wasOpen);

  /**
   * EXACTLY what is drawn, in drawing order — section headers included, and
   * nothing at all from inside a folded section or a folded folder (the owner,
   * 2026-09-19: "dragging was buggy … when sections were closed and between
   * sections generally").
   *
   * rowdrag measures the entries that register a ref, so a list carrying rows
   * that render nothing put every index past a collapsed section out by the
   * number of rows hidden inside it — the drag then dropped the recipe
   * somewhere nobody pointed at. And the headers are in here because they are
   * what makes "the end of this section" a place you can drop: without them
   * the gap between two sections is one boundary spanning the header, so a row
   * dragged to the bottom of its own section always joined the next one. See
   * rowslots.ts, which turns a boundary into a landing.
   *
   * The empty-section placeholder stays for the section that is open and has
   * no rows — it is a real, visible drop target of row height.
   */
  type FlatEntry = { kind: 'row'; rec: Rec<'note'>; sectionId: string } | { kind: 'empty' | 'head'; sectionId: string };
  const flatRows = useMemo(() => {
    const out: FlatEntry[] = [];
    for (const f of folders) {
      /*
       * A CLOSED FOLDER IS STILL A PLACE TO DROP — the owner, 2026-09-21: "make
       * it possible to drag items between sections and folders".
       *
       * It was `continue`, and a folder with its chevron shut contributed
       * NOTHING: no entry, no measured midpoint, no boundary. So the one
       * folder you most want to file something into — the one you are not
       * currently reading — was the one folder you could not reach, and the
       * gesture just skipped over it to whatever came next.
       *
       * One head entry, keyed to the folder's FIRST section, is the whole
       * fix. It is exactly what a shut SECTION already does (rowslots.ts:
       * "drop a row just under a folded header and it lands at the end of
       * that folded section"), one level up, so the same rule answers both
       * without learning what a folder is. A folder with no sections in it
       * has nowhere to put anything and stays skipped.
       */
      if (foldedFolders.has(f.id)) {
        const first = sectionsOf(f.id)[0];
        if (first) out.push({ kind: 'head', sectionId: first.id });
        continue;
      }
      for (const sec of sectionsOf(f.id)) {
        out.push({ kind: 'head', sectionId: sec.id });
        if (nfolded.has(sec.id)) continue;
        const rows = notesOf(sec.id);
        if (rows.length === 0) out.push({ kind: 'empty', sectionId: sec.id });
        for (const n of rows) out.push({ kind: 'row', rec: n, sectionId: sec.id });
      }
    }
    return out;
  }, [folders, sectionsOf, notesOf, foldedFolders, nfolded]);
  const drag = useRowDrag(flatRows.length, (from, to) => {
    const src = flatRows[from];
    if (src?.kind !== 'row') return;
    const target = dropTarget(slotEntries(flatRows), from, to);
    if (!target) return;
    const res = moveNote(recs, src.rec.id, target.sectionId, target.beforeId);
    if ('error' in res) return;
    mutate((e) => res.put.forEach((r) => e.put(r)));
  }, { keyOf: (i) => flatKey(flatRows[i]) });
  const flatIdx = useMemo(() => {
    const m = new Map<string, number>();
    flatRows.forEach((x, i) => { if (x.kind === 'row') m.set(x.rec.id, i); });
    return m;
  }, [flatRows]);
  const flatIdxOf = (id: string) => flatIdx.get(id) ?? -1;
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  // PERFORMANCE: a drag move or a tick re-renders this whole screen. Rows are
  // memoised (`NoteRow`) and reach their handlers through ONE stable `h` that
  // reads the latest closures from a ref, so only rows whose own props moved render.
  const live = useRef<NoteLive>(null as unknown as NoteLive);
  live.current = {
    drag, swipe, justHeld, lastTap, tapTimer, toggleSelected, setPageEdit, setOpenId, setDateFor,
    dup: (id) => {
      const res = duplicateItem(recs, id, newId);
      if (!('error' in res)) mutate((e) => res.put.forEach((p) => e.put(p)));
    },
    del: (id) => mutate((e) => e.del(id)),
    swipeDel: (id) => { swipe.clear(); mutate((e) => e.del(id)); },
  };
  const h = useMemo<NoteHandlers>(() => {
    const regs = new Map<number, (ref: import('react-native').View | null) => void>();
    return {
      reg: (i) => {
        let f = regs.get(i);
        if (!f) { f = (ref) => live.current.drag.registerRow(i)(ref); regs.set(i, f); }
        return f;
      },
      grip: (i) => live.current.drag.handleFor(i),
      swipeHandlers: (id) => live.current.swipe.handlersFor(id),
      toggle: (id) => live.current.toggleSelected(id),
      onHold: () => { const l = live.current; l.justHeld.current = true; l.setPageEdit(true); },
      onRowPress: (id) => {
        const l = live.current;
        if (l.justHeld.current) { l.justHeld.current = false; return; }
        if (l.swipe.justSwiped()) return;
        if (l.swipe.swiped) { l.swipe.clear(); return; }
        // A tap OPENS, in edit mode as much as out of it, and a DOUBLE TAP goes into edit mode.
        const now = Date.now();
        const prev = l.lastTap.current;
        if (prev && prev.id === id && now - prev.at < 250) {
          if (l.tapTimer.current) clearTimeout(l.tapTimer.current);
          l.tapTimer.current = null;
          l.lastTap.current = null;
          l.setPageEdit(true);
          return;
        }
        l.lastTap.current = { id, at: now };
        if (l.tapTimer.current) clearTimeout(l.tapTimer.current);
        l.tapTimer.current = setTimeout(() => {
          l.tapTimer.current = null;
          l.setOpenId(id);
        }, 250);
      },
      dateChip: (id) => live.current.setDateFor(id),
      dup: (id) => live.current.dup(id),
      del: (id) => live.current.del(id),
      swipeDel: (id) => live.current.swipeDel(id),
    };
  }, []);
  const emptyIdxOf = (sectionId: string) => flatRows.findIndex((x) => x.kind === 'empty' && x.sectionId === sectionId);
  const headIdxOf = (sectionId: string) => flatRows.findIndex((x) => x.kind === 'head' && x.sectionId === sectionId);
  /**
   * A CLOSED folder's own entry, or -1 when the folder is open.
   *
   * -1 matters: the folder head must be registered with the drag ONLY while
   * it stands in for the whole folder. Register it always and rowdrag
   * measures a midpoint for an index that is not in the flat list, and
   * `destFor` — which counts measured midpoints — puts every boundary below
   * it out by one.
   */
  const folderHeadIdx = (folderId: string) => (
    foldedFolders.has(folderId) ? headIdxOf(sectionsOf(folderId)[0]?.id ?? '\u0000') : -1
  );

  const [emptyAsk, setEmptyAsk] = useState<{ sectionId: string; slot: SectionSlot } | null>(null);
  const [renamingSec, setRenamingSec] = useState<string | null>(null);
  const [renameSecText, setRenameSecText] = useState('');
  const lastSecTap = React.useRef<{ id: string; at: number }>({ id: '', at: 0 });
  const secDrag = useSectionDrag((sectionId, slot) => {
    const res = moveSection(recs, sectionId, slot.folderId, slot.beforeSectionId);
    if (!('error' in res)) {
      mutate((e) => res.put.forEach((r) => e.put(r)));
      return;
    }
    if (res.error === 'a folder keeps its last section') setEmptyAsk({ sectionId, slot });
  });

  const open = openId ? (recs.find((r) => r.id === openId) as Rec<'note'> | undefined) : undefined;
  /** Nobody has named this note yet — it still wears the date it was born with. */
  const generatedTitle = !!open && looksLikeDefaultNoteTitle(open.payload.title);
  // Only OUR bodies scale — the markers are what say the ingredients have
  // been read and separated from the prose around them.
  const isRecipe = open ? isRecipeNote(open.payload) : false;
  /** The card's own subheaders, which are what a variant is built out of. */
  const cardSections = open ? recipeSections(open.payload.body) : [];
  const variants = open?.payload.variants ?? [];
  const activeVariant = findVariant(variants, variantId);
  /**
   * Variant first, then scale. The order matters: scaling rewrites the
   * quantities inside the lines, so filtering afterwards would have to match
   * subheaders in text the scaler had already been through. Filtering first
   * hands the scaler a smaller, otherwise identical card.
   */
  const baseBody = open
    ? (activeVariant ? variantBody(open.payload.body, liveSections(open.payload.body, activeVariant)) : open.payload.body)
    : '';
  const shownBody = open ? (scale === 1 ? baseBody : scaleRecipeBody(baseBody, scale)) : '';

  const goesChoices = useMemo(() => {
    const allFolders = recs
      .filter((r): r is Rec<'folder'> => r.type === 'folder' && (r.payload.app ?? 'reminders') === 'notes')
      .sort(byRecOrd);
    const allSections = recs.filter((r): r is Rec<'section'> => r.type === 'section').sort(byRecOrd);
    return allFolders.flatMap((f) =>
      allSections.filter((x) => x.payload.folderId === f.id).map((x) => ({ sec: x, label: `${f.payload.name} · ${x.payload.name}` })),
    );
  }, [recs]);
  const noteFolderOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const c of goesChoices) {
      const fid = c.sec.payload.folderId;
      if (!seen.has(fid)) seen.set(fid, c.label.split(' · ')[0]!);
    }
    return [...seen].map(([id, label]) => ({ id, label }));
  }, [goesChoices]);

  // The suite carries the folder-head + in Notes as well as Reminders, always
  // shown rather than hidden in edit mode. Without it there was NO way to make
  // a note section at all: normalize seeds one per folder and that was that.
  /**
   * The selected recipes, turned into shopping rows.
   *
   * The work is `addToShopping`, which the Recipe page's Shop button shares —
   * the pantry filter, where the rows land and what to say when nothing was
   * added are one behaviour, and a second copy of it would drift the first
   * time one of the three changed. What is left here is the selection.
   */
  const addSelectedToShopping = () => {
    const picked = selected
      .map((id) => recs.find((r): r is Rec<'note'> => r.type === 'note' && r.id === id && !r.deleted))
      .filter((n): n is Rec<'note'> => n !== undefined);
    const result = addToShopping(
      recs,
      mutate,
      picked.map((n) => ({ title: n.payload.title, ingredients: ingredientsOf(n) })),
    );
    toast(shopMessage(result, picked.length === 1));
    if (result.ok) endEdit();
  };

  /**
   * Delete every picked recipe. The two-press bargain that guards it — press
   * once to arm, press again to confirm, red in between — belongs to PickBar,
   * which the shopping and pantry lists wear too.
   */
  const deleteSelected = () => {
    const ids = selected.slice();
    if (ids.length === 0) return;
    mutate((e) => { for (const id of ids) e.del(id); });
    toast(ids.length === 1 ? 'Recipe deleted.' : `${ids.length} recipes deleted.`);
    endEdit();
  };

  const addSection = (folder: Rec<'folder'>) => {
    const name = newSecName.trim();
    setAddingSection(null);
    setNewSecName('');
    if (!name) return;
    const secs = sectionsOf(folder.id);
    if (sectionNameTaken(recs, folder.id, name)) return;
    mutate((e) => {
      // Prepend, as on the web: a new section lands at the top of its folder.
      e.put({
        id: newId(),
        type: 'section',
        updated: 0,
        payload: { name, folderId: folder.id, ord: ordBetween(null, secs[0]?.payload.ord ?? null) },
      });
    });
  };

  /**
   * + makes the note and opens it, with nothing in between.
   *
   * This used to drop an inline 'New note' field into the list and make you
   * name the note before anything opened — which is what the owner kept reporting
   * as '+ does not go straight to the new note'. The step itself was the bug,
   * not what happened after it, and my repro passed for weeks because it
   * tested the step instead of questioning it.
   *
   * The name is typed in the editor's own title field now, so the date-in-the-
   * name feature moved to that field's blur (see note-title) rather than being
   * lost with the inline one.
   */
  const addNote = (section: Rec<'section'>) => {
    const id = newId();
    mutate((e) => {
      const first = notesOf(section.id)[0];
      e.put({
        id, type: 'note', updated: 0,
        payload: { title: defaultNoteTitle(), body: '', date: null, folderId: section.payload.folderId, sectionId: section.id, ord: ordBetween(null, first?.payload.ord ?? null) },
      });
    });
    freshEdit.current = id;
    setOpenId(id);
  };

  const wrapSel = (before: string, after = before) => {
    if (!open) return;
    const b = open.payload.body;
    const { start, end } = sel;
    const next = b.slice(0, start) + before + b.slice(start, end) + after + b.slice(end);
    mutate((e) => e.put({ ...open, payload: { ...open.payload, body: next } }));
  };
  const linePrefix = (marker: string) => {
    if (!open) return;
    const b = open.payload.body;
    const at = b.lastIndexOf('\n', Math.max(0, sel.start - 1)) + 1;
    const next = b.slice(0, at) + marker + b.slice(at);
    mutate((e) => e.put({ ...open, payload: { ...open.payload, body: next } }));
  };

  if (sharedView && sharedPartner) {
    return <SharedNotes viewKey={sharedView} partner={sharedPartner} />;
  }

  if (open) {
    return (
      <View style={s.page}>
        <View style={s.edHead}>
          {/* A real BACK, not a link to one destination. Arriving from the
              calendar's day panel and pressing this returns to the calendar;
              arriving from the list returns to the list. It said "← All
              notes" and always meant it, which is why coming from the
              calendar left you a tab away from what you were doing. */}
          {/* The same circle-chevron every other screen's back wears
              (chrome.tsx's nav-back) — this was a text pill reading
              "‹  Back", the one back in the app formatted unlike the rest,
              and its text-glyph chevron sat visibly off-centre on iOS.
              The owner's word, 2026-08-18. */}
          <CircleBtn
            testID="note-back"
            glyph="‹"
            size={TOPBAR_CTRL}
            label="Back"
            onPress={() => {
              const external = cameFromTab.current;
              cameFromTab.current = false;
              setOpenId(null);
              if (external) nav.goBack();
            }}
          />
          {/* And a direct way to the list, beside it. Back returns to wherever
              you came from — which, arriving from the calendar, is the
              calendar — so the one destination it no longer guarantees is the
              one this button is for. The owner asked for both. */}
          <Pressable
            testID="note-all"
            accessibilityRole="button"
            accessibilityLabel="All notes"
            style={s.ddPill}
            onPress={() => { cameFromTab.current = false; setOpenId(null); }}
          >
            <Text style={s.backText}>All notes</Text>
          </Pressable>
          <Dropdown
            value={open.payload.folderId}
            options={noteFolderOptions}
            onPick={(fid) => {
              const firstSec = goesChoices.find((c) => c.sec.payload.folderId === fid)?.sec;
              if (firstSec) mutate((e) => e.put({ ...open, payload: { ...open.payload, folderId: fid, sectionId: firstSec.id } }));
            }}
          />
          <Dropdown
            value={open.payload.sectionId}
            options={goesChoices.filter((c) => c.sec.payload.folderId === open.payload.folderId).map((c) => ({ id: c.sec.id, label: c.sec.payload.name }))}
            onPick={(sid) => {
              const sec = goesChoices.find((c) => c.sec.id === sid)?.sec;
              if (sec) mutate((e) => e.put({ ...open, payload: { ...open.payload, folderId: sec.payload.folderId, sectionId: sec.id } }));
            }}
            gold
          />
        </View>
        {/* The owner, 2026-08-11: a status indicator in the editor's top right.
            This is the one screen where it earns its place — a note is the
            only record that can be REFUSED for being too long, and until now
            the editor said nothing about whether what you were typing was
            reaching the server. Same dot as Settings, from the same rule.

            PINNED rather than placed in the header row: that row wraps on a
            phone, and a right-aligned child in a wrapping row drops to the
            second line, which is not the top right of anything. Measured at
            390pt, where it sat 44pt below the back button. */}
        <View style={s.edStatus} pointerEvents="none">
          <SyncDot testID="editor-sync" withText showPartner={false} />
        </View>
        <Scroll contentContainerStyle={s.editor}>
          <View style={s.titleRow}>
            <TextInput
              ref={titleRef}
              testID="note-title"
              style={s.title}
              // A note is born titled "Aug 12, 2026 at 10:17am" so it is not
              // blank in the list, and tapping the title to type over it is
              // deliberate. That was done with select-all, and select-all is a
              // RACE: the click places its own caret AFTER onFocus runs, so the
              // selection was overwritten and then re-applied one keystroke
              // late. Traced key by key, which is the only reason this was ever
              // explicable:
              //
              //   after click  "Aug 12, 2026 at 10:17am"  sel 14-14
              //   after 'P'    "Aug 12, 2026 aPt 10:17am" sel 0-24
              //   after 'a'    "a"
              //
              // The P landed mid-title, the belated select-all covered
              // everything, and the next key replaced the lot — one letter
              // gone, blamed on the typist. A frame-delayed select fixed the
              // 50ms case and still lost the zero-gap one, and RNW's own
              // selectTextOnFocus fires late with no handle to cancel.
              //
              // So: do not select what is not there. A title nobody has
              // written yet is a PLACEHOLDER — the record keeps the generated
              // one for the list, the field is empty, and typing over it is
              // just typing. No selection, no ordering, nothing to lose a
              // letter to.
              value={titleDraft ?? (generatedTitle ? '' : open.payload.title)}
              placeholder={generatedTitle ? open.payload.title : 'Title'}
              placeholderTextColor={T.muted}
              onFocus={() => {
                setTitleDraft(generatedTitle ? '' : open.payload.title);
                // The owner's rule (2026-08-18): the title tap wins. Whichever
                // side of the 50ms the tap landed on, the state converges —
                // pending body focus cancelled, body back to its view.
                cancelFreshFocus();
                if (bodyEditing) {
                  setBodyEditing(false);
                  setDraft(null);
                  setBeforeDraft(null);
                  setAfterDraft(null);
                }
              }}
              onBlur={() => {
                // The inline add field used to do this on the way in. It is
                // the title's job now, so 'Dentist 8/3' still puts the note on
                // the calendar — and now it works when renaming too.
                setTitleDraft(null);
                const raw = open.payload.title.trim();
                // The default title is itself a date; parsing it would put
                // every note nobody renamed onto the calendar.
                if (!raw || open.payload.date || looksLikeDefaultNoteTitle(raw)) return;
                const [title, date] = parseWhenFromText(raw, todayStr(), nowStr());
                if (date) mutate((e) => e.put({ ...open, payload: { ...open.payload, title: title || raw, date } }));
              }}
              onChangeText={(t) => {
                setTitleDraft(t);
                mutate((e) => e.put({ ...open, payload: { ...open.payload, title: t } }));
              }}
            />
            {open.payload.date ? (
              <Pressable style={s.addDate} onPress={() => mutate((e) => e.put({ ...open, payload: { ...open.payload, date: null } }))}>
                <Text style={s.addDateText}>{open.payload.date} ×</Text>
              </Pressable>
            ) : (
              <Pressable style={s.addDate} onPress={() => setDateOpen(!dateOpen)}>
                <Text style={s.addDateText}>+ Add date</Text>
              </Pressable>
            )}
          </View>
          {/* The format pills live under the name, as prod places them. */}
          <View style={s.toolRow}>
            <Pill label={'”'} onPress={() => linePrefix('> ')} />
            <Pill label="B" onPress={() => wrapSel('**')} />
            <Pill label="I" onPress={() => wrapSel('*')} />
            <Pill label="U" onPress={() => wrapSel('__')} />
            <Pill label="· List" onPress={() => linePrefix('- ')} />
            <Pill
              testID="recipe-import"
              label="Recipe"
              onPress={() => {
                // The editor works on what the note SAYS, not on what the
                // scale is showing. Dropping back to 1x first means the two
                // agree on screen, rather than the editor looking like it
                // threw the doubling away.
                setScale(1);
                setRecipeOpen(true);
              }}
            />
          </View>
          {dateOpen && (
            <View style={s.metaRow}>
              <Pill
                label="Today"
                onPress={() => { mutate((e) => e.put({ ...open, payload: { ...open.payload, date: todayStr() } })); setDateOpen(false); }}
              />
              {/* The circle-with-a-calendar — "the m/d text box should be a
                  calendar picker in add date on notes app" (the owner, 2026-08-20). */}
              <DayPickBtn testID="note-ed-date" value={open.payload.date} onPress={() => setEdPickOpen(true)} />
            </View>
          )}
          {edPickOpen && (
            <DayPick
              value={open.payload.date}
              onPick={(d) => { mutate((e) => e.put({ ...open, payload: { ...open.payload, date: d } })); setDateOpen(false); }}
              onClose={() => setEdPickOpen(false)}
            />
          )}

          {isRecipe && (
            <View testID="scale-row" style={s.scaleRow}>
              {SCALES.map(([f, label, id]) => (
                <Pressable
                  key={id}
                  testID={`scale-${id}`}
                  style={[s.scalePill, scale === f && s.scalePillOn]}
                  onPress={() => setScale(f)}
                  hitSlop={6}
                >
                  <Text style={[s.scaleText, scale === f && s.scaleTextOn]}>{label}</Text>
                </Pressable>
              ))}
              {/* The variant picker, beside the scale pills (the owner,
                  2026-08-22). It appears only once the card HAS subheaders to
                  build a variant out of — a dropdown offering nothing, next to
                  a Manage window that could only ever produce empty variants,
                  is two controls explaining each other's uselessness. */}
              {cardSections.length > 0 && (
                <>
                  <Pressable
                    testID="variant-pick"
                    accessibilityRole="button"
                    accessibilityLabel={activeVariant ? `Variant: ${activeVariant.name}` : 'Whole recipe — choose a variant'}
                    onPress={() => setVariantMenu((v) => !v)}
                    style={[s.scalePill, activeVariant && s.scalePillOn]}
                    hitSlop={6}
                  >
                    <Text style={[s.scaleText, activeVariant && s.scaleTextOn]} numberOfLines={1}>
                      {activeVariant ? activeVariant.name : 'Whole recipe'} ▾
                    </Text>
                  </Pressable>
                  <CircleBtn
                    testID="variant-manage"
                    glyph="⚙"
                    label="Manage variants"
                    size={26}
                    color={T.dim}
                    onPress={() => { setVariantMenu(false); setVariantsOpen(true); }}
                  />
                </>
              )}
              {scale !== 1 && <Text style={s.scaleNote}>Scaled — 1× to edit</Text>}
            </View>
          )}
          {/* The dropdown itself, under the row rather than floating over it:
              a menu inside a Scroll that is absolutely positioned ends up
              clipped by the row's own bounds on the web. */}
          {isRecipe && variantMenu && cardSections.length > 0 && (
            <View testID="variant-menu" style={s.variantMenu}>
              <Pressable
                testID="variant-opt-all"
                style={[s.variantOpt, variantId === null && s.variantOptOn]}
                onPress={() => { setVariantId(null); setVariantMenu(false); }}
              >
                <Text style={[s.variantOptText, variantId === null && s.variantOptTextOn]}>Whole recipe</Text>
              </Pressable>
              {variants.map((v) => (
                <Pressable
                  key={v.id}
                  testID={`variant-opt-${v.name}`}
                  style={[s.variantOpt, variantId === v.id && s.variantOptOn]}
                  onPress={() => { setVariantId(v.id); setVariantMenu(false); }}
                >
                  <Text style={[s.variantOptText, variantId === v.id && s.variantOptTextOn]}>{v.name}</Text>
                </Pressable>
              ))}
              {variants.length === 0 && (
                <Text style={s.variantEmpty}>No variants yet — the gear beside this makes one.</Text>
              )}
            </View>
          )}
          {bodyEditing && editAsRecipe.current ? (
            (() => {
              const es = splitRecipeBody(open.payload.body)!;
              const put = (before: string, after: string) =>
                mutate((e) => e.put({ ...open, payload: { ...open.payload, body: joinRecipeBody(before, es.recipe, after) } }));
              return (
                <View style={s.body}>
                  <TextInput
                    ref={bodyRef}
                    testID="note-body-before"
                    style={s.bodyBank}
                    value={beforeDraft ?? es.before}
                    placeholder="Write above the recipe…"
                    placeholderTextColor={T.muted}
                    multiline
                    onFocus={partFocus}
                    onBlur={partBlur}
                    onChangeText={(t) => {
                      setBeforeDraft(t);
                      put(t, afterDraft ?? es.after);
                    }}
                  />
                  {/* The recipe, as ONE quiet blob — quoted, italic, small,
                      and not deletable from here: its content is the Recipe
                      page's business, which tapping it opens. */}
                  <Pressable testID="recipe-blob" style={s.recipeBlob} onPress={() => setRecipeOpen(true)}>
                    <Text style={s.recipeTag}>Recipe</Text>
                    <Text style={s.recipeBlobHint} numberOfLines={2}>
                      {es.recipe.split('\n').filter((l) => l.startsWith('- ')).slice(0, 3).map((l) => l.slice(2)).join(' · ') || 'Open the recipe'}
                    </Text>
                  </Pressable>
                  <TextInput
                    testID="note-body-after"
                    style={s.bodyBank}
                    value={afterDraft ?? es.after}
                    placeholder="Write below the recipe…"
                    placeholderTextColor={T.muted}
                    multiline
                    onFocus={partFocus}
                    onBlur={partBlur}
                    onChangeText={(t) => {
                      setAfterDraft(t);
                      put(beforeDraft ?? es.before, t);
                    }}
                  />
                </View>
              );
            })()
          ) : bodyEditing ? (
            <TextInput
              ref={bodyRef}
              testID="note-body-edit"
              style={s.body}
              value={draft ?? open.payload.body}
              placeholder="Write…"
              placeholderTextColor={T.muted}
              multiline
              // NO autoFocus. It used to grab focus the instant the editor
              // opened, which fought the title focus on a brand-new note:
              // title wins the race, body blurs, and onBlur below collapses
              // the editor straight back to a read view. The body is focused
              // deliberately by whoever opened it (tap-to-edit, just below)
              // rather than by racing.
              onBlur={() => {
                setBodyEditing(false);
                setDraft(null);
              }}
              onSelectionChange={(ev) => setSel(ev.nativeEvent.selection)}
              onChangeText={(t) => {
                setDraft(t);
                mutate((e) => e.put({ ...open, payload: { ...open.payload, body: t } }));
              }}
            />
          ) : (
            <Pressable
              testID="note-body-view"
              style={s.body}
              onPress={() => {
                // At 2× the text on screen is not the text in the note, so
                // tapping must not drop you into an editor showing something
                // else. 1× is right there.
                if (scale !== 1) return;
                editAsRecipe.current = isRecipeNote(open.payload);
                setDraft(open.payload.body);
                setBodyEditing(true);
                // The field does not exist until this has rendered — and the
                // deferred focus rides the SAME ref as the fresh-note one, so
                // a title tap inside the window calls this off too. A recipe
                // note opens on its ABOVE bank, which is where prose goes.
                cancelFreshFocus();
                freshFocus.current = setTimeout(() => {
                  freshFocus.current = null;
                  bodyRef.current?.focus();
                }, 50);
              }}
            >
              {shownBody === '' ? (
                <Text style={s.bodyPlaceholder}>Write…</Text>
              ) : (
                <NoteBody body={shownBody} recipe={isRecipe} onLine={(t) => setRemindText(t)} />
              )}
            </Pressable>
          )}

          {recipeOpen && <RecipeEditor note={open} onClose={() => setRecipeOpen(false)} />}
          {/* A tapped ingredient or step, on its way to being a reminder —
              today by default, and the manual-beats-parsed rules apply to
              whatever is typed over it (the owner, 2026-08-18). */}
          {remindText !== null && (
            <ItemModal mode="create" kind="reminder" text0={remindText} date={todayStr()} onClose={() => setRemindText(null)} />
          )}
          {/* Saved sits bottom-left; the two-press delete bottom-right.
              It READS THE STATE now. It used to be the literal string 'Saved',
              which is a claim this screen was in no position to make: it said
              so while the device could not write its snapshot, while a note was
              refused for being too long, and while the app was offline — and
              once the editor grew an honest dot in its top right, the two sat
              three inches apart disagreeing. Same word, same rule, one source. */}
          <View style={s.footRow}>
            <Text
              testID="editor-saved"
              style={[s.saved, (persistFailed || syncState === 'refused') && s.savedBad]}
            >
              {syncWord(syncState, persistFailed)}
            </Text>
            {/* Notes has no account dropdown to hang "Copy as Markdown" off —
                the editor is its own screen — so it gets the control directly.
                The owner, 2026-08-12: NEXT TO DELETE, which is where the row of
                things you do to the whole note already lives. It spent a few
                hours pinned in the top-right corner beside the sync dot
                instead, which put a button nobody was looking for in the one
                place on this screen that is not a button. */}
            <View style={s.footActs}>
              <Pressable
                testID="note-copymd"
                accessibilityRole="button"
                accessibilityLabel="Copy as Markdown"
                onPress={() => {
                  const md = `# ${open.payload.title}\n\n${open.payload.body}`;
                  Clipboard.setStringAsync(md)
                    .then(() => toast('Copied as Markdown'))
                    .catch(() => toast('Could not copy'));
                }}
              >
                <Text style={s.copyBtnText}>Copy</Text>
              </Pressable>
              {/* ui's DeletePill — the same control the item sheet wears now
                  (the owner, 2026-08-20). Keyed by note so arming one can never
                  prime the next (armeddelete.spec), which useNoteScoped did
                  for the old inline version. */}
              <DeletePill key={open.id} onDelete={() => { setOpenId(null); mutate((e) => e.del(open.id)); }} />
            </View>
          </View>
        </Scroll>
        {/* Manage variants, in the EDITOR branch — the gear that opens it sits
            beside the scale pills a few lines up, and a modal rendered in the
            list branch instead would have been unreachable from the only
            control that sets its flag. */}
        {variantsOpen && (() => {
          const rec = open;
          const varsOf = () => rec.payload.variants ?? [];
          return (
        <Modal transparent animationType="fade" onRequestClose={() => setVariantsOpen(false)}>
          <Pressable style={s.dateBackdrop} onPress={() => setVariantsOpen(false)}>
            <Pressable style={s.varCard} onPress={(e) => e.stopPropagation()}>
              <View style={s.varHead}>
                <Text style={s.dateTitle}>Variants</Text>
                <CircleBtn
                  testID="variant-add"
                  glyph="+"
                  label="Add a variant"
                  size={26}
                  color={T.accent}
                  onPress={() => {
                    const id = newId();
                    const next: RecipeVariant[] = [...varsOf(), { id, name: `Variant ${varsOf().length + 1}`, sections: [] }];
                    mutate((e) => e.put({ ...rec, payload: { ...rec.payload, variants: next } }));
                    // Straight into it: a new variant named "Variant 1" with
                    // nothing ticked is a row you have to tap anyway.
                    setOpenVariantId(id);
                  }}
                />
              </View>
              <Scroll contentContainerStyle={s.varScroll}>
                {varsOf().length === 0 && (
                  <Text style={s.variantEmpty}>None yet. The + above adds one; each picks which of this recipe’s sections it shows.</Text>
                )}
                {varsOf().map((v) => {
                  const editThis = (fn: (cur: RecipeVariant) => RecipeVariant) => {
                    const next = varsOf().map((x) => (x.id === v.id ? fn(x) : x));
                    mutate((e) => e.put({ ...rec, payload: { ...rec.payload, variants: next } }));
                  };
                  const isOpen = openVariantId === v.id;
                  return (
                    <View key={v.id} style={s.varRow}>
                      <View style={s.varRowHead}>
                        <Pressable
                          testID={`variant-row-${v.name}`}
                          style={s.varRowBody}
                          onPress={() => setOpenVariantId(isOpen ? null : v.id)}
                        >
                          <Text style={s.varName} numberOfLines={1}>{v.name}</Text>
                          <Text style={s.varCount}>
                            {v.sections.length === 0 ? 'whole recipe' : `${v.sections.length} of ${cardSections.length}`}
                          </Text>
                        </Pressable>
                        <ConfirmDelete
                          testID={`variant-del-${v.name}`}
                          onDelete={() => {
                            const next = varsOf().filter((x) => x.id !== v.id);
                            mutate((e) => e.put({ ...rec, payload: { ...rec.payload, variants: next } }));
                            // Showing a card filtered by a variant that no
                            // longer exists would be a card nobody can get out of.
                            if (variantId === v.id) setVariantId(null);
                            if (openVariantId === v.id) setOpenVariantId(null);
                          }}
                        />
                      </View>
                      {isOpen && (
                        <View style={s.varOpen}>
                          <Field
                            testID={`variant-name-${v.name}`}
                            value={v.name}
                            onChangeText={(name) => editThis((cur) => ({ ...cur, name }))}
                            placeholder="Name this variant"
                          />
                          {cardSections.length === 0 && (
                            <Text style={s.variantEmpty}>This recipe has no sections yet — a line ending in a colon makes one.</Text>
                          )}
                          {cardSections.map((secName) => {
                            const on = v.sections.includes(secName);
                            return (
                              <Pressable
                                key={secName}
                                testID={`variant-sec-${secName}`}
                                accessibilityRole="checkbox"
                                accessibilityState={{ checked: on }}
                                accessibilityLabel={secName}
                                style={s.varSec}
                                onPress={() =>
                                  editThis((cur) => ({
                                    ...cur,
                                    sections: on ? cur.sections.filter((x) => x !== secName) : [...cur.sections, secName],
                                  }))
                                }
                              >
                                <View style={[s.varBox, on && s.varBoxOn]}>
                                  {on && <Text style={s.varBoxTick}>✓</Text>}
                                </View>
                                {/* The colon is part of the stored key, and
                                    showing it would put a stray one at the end
                                    of every label. */}
                                <Text style={s.varSecText}>{secName.replace(/:$/, '')}</Text>
                              </Pressable>
                            );
                          })}
                        </View>
                      )}
                    </View>
                  );
                })}
              </Scroll>
              <Pressable testID="variant-done" style={s.pickGo} onPress={() => setVariantsOpen(false)}>
                <Text style={s.pickGoText}>Done</Text>
              </Pressable>
            </Pressable>
          </Pressable>
        </Modal>
          );
        })()}

      </View>
    );
  }

  return (
    <View style={s.page}>
      {/* Right of the name, as in Reminders and as the owner asked.

          NO CONTROLS. The pencil went 2026-09-16 (the owner: "get rid of the edit
          button on the top bar") — holding a row is the way in, and it is the
          way in on all three lists now. It had been the top bar's since
          2026-08-21, when hold-tap was the only route and that is a gesture
          you have to already know about; what makes it discoverable now is
          that the three screens agree. */}
      {/* No picker ring in the bar: it is a row in the username menu now
          (the owner, 2026-09-16), so the card is raised from there and rendered
          here, buttonless. */}
      <TopBar
        title="Recipes"
        folders={{ dot: <FolderDot app="notes" />, onOpen: () => setPickOpen(true) }}
      />
      <FolderPick app="notes" button={false} open={pickOpen} onClose={() => setPickOpen(false)} />
      {/* A live drag holds the scroll still — see Habits for the why. */}
      <Scroll contentContainerStyle={s.scrollWrap} scrollEnabled={drag.dragIdx === null && secDrag.dragging === null}>
        {/* The phone's tap-to-exit; the web keeps its document listener.
            EditExit carries the content layout (s.scroll) so arming edit
            mode cannot move anything — see EditExit for the story. */}
        {/* Armed while a swipe-delete is parked too — the native half of the
            unpark rule; the web's lives in useSwipeLeft (the owner, 2026-08-20). */}
        <EditExit
          active={pageEdit || swipe.swiped !== null}
          onExit={() => { if (swipe.swiped !== null) swipe.clear(); else endEdit(); }}
          style={s.scroll}
        >
        {folders.map((f) => (
          <View key={f.id} style={s.folderBlock}>
            {/* The header ROW is the reliable way out: always on screen, full
                width, and taller than the 1pt rule. With Done gone, tapping
                out is the ONLY exit, so it must not depend on blank space
                below a list that fills the screen. The controls inside keep
                their own presses — this fires on the row's bare surface. */}
            {/* The boundary above a CLOSED folder, and the folder head's own
                measurement — it is a drop target only while it is shut, and
                registering it when it is open would give rowdrag a midpoint
                for an index the flat list does not have. */}
            {folderHeadIdx(f.id) >= 0 && drag.slot === folderHeadIdx(f.id) && <View style={s.dropLine} />}
            <View
              testID={`head-fold-${f.payload.name}`}
              style={s.folderHead}
              collapsable={false}
              ref={folderHeadIdx(f.id) >= 0 ? drag.registerRow(folderHeadIdx(f.id)) : undefined}
            >
              <FoldCaret
                testID={`foldfold-${f.payload.name}`}
                open={!foldedFolders.has(f.id)}
                color={T.text}
                onPress={() => toggleFolderFold(f.id)}
                onLongPress={() => foldAllFolders(!foldedFolders.has(f.id))}
              />
              <Text style={[s.folderName, { backgroundColor: f.payload.color + '33' }]}>{f.payload.name}</Text>
              <CircleBtn testID={`foldadd-${f.payload.name}`} glyph="+" label="Add" color={T.accent} size={22} onPress={() => { setAddingSection(f.id); setNewSecName(''); }} />
              <View style={s.folderRule} />
            </View>
            {addingSection === f.id && (
              <Field
                value={newSecName}
                onChangeText={setNewSecName}
                placeholder="New section"
                autoFocus
                onBlur={() => addSection(f)}
                onSubmitEditing={() => addSection(f)}
              />
            )}
            {!foldedFolders.has(f.id) && sectionsOf(f.id).map((sec) => (
              <View key={sec.id} style={s.section}>
                {secDrag.lineKey === `before:${sec.id}` && <View style={s.dropLine} />}
                {/* The row drag's own line, above the header: this boundary is
                    the END of the section before, which is the drop the list
                    could not express until the header became an entry. */}
                {drag.slot !== null && headIdxOf(sec.id) === drag.slot && <View style={s.dropLine} />}
                <View
                  testID={`head-sec-${sec.payload.name}`}
                  ref={(r) => { secDrag.registerHeader(sec.id, f.id)(r); drag.registerRow(headIdxOf(sec.id))(r); }}
                  style={[s.secHead, secDrag.dragging === sec.id && { opacity: 0.55 }]}
                >
                  <View testID={`nsec-grip-${sec.payload.name}`} {...(pageEdit ? secDrag.gripFor(sec.id) : {})} style={[s.rowGrip, !pageEdit && s.gripHidden]} pointerEvents={pageEdit ? 'auto' : 'none'} hitSlop={6}>
                    <WebHitSlop slop={6} />
                    <Text style={s.rowGripText}>≡</Text>
                  </View>
                  <FoldCaret
                    testID={`secfold-${sec.payload.name}`}
                    open={!nfolded.has(sec.id)}
                    onPress={() => toggleNFold(sec.id)}
                    onLongPress={() => foldAllSections(!nfolded.has(sec.id))}
                  />
                  {renamingSec === sec.id ? (
                    <Field
                      testID="nsec-rename"
                      value={renameSecText}
                      onChangeText={setRenameSecText}
                      autoFocus
                      style={s.secRename}
                      onBlur={() => {
                        setRenamingSec(null);
                        const res = renameSection(recs, sec.id, renameSecText);
                        if (!('error' in res)) mutate((e) => res.put.forEach((r) => e.put(r)));
                      }}
                      onSubmitEditing={() => {
                        setRenamingSec(null);
                        const res = renameSection(recs, sec.id, renameSecText);
                        if (!('error' in res)) mutate((e) => res.put.forEach((r) => e.put(r)));
                      }}
                    />
                  ) : (
                    <Pressable
                      testID={`nsec-name-${sec.payload.name}`}
                      onPress={() => {
                        const now = Date.now();
                        if (lastSecTap.current.id === sec.id && now - lastSecTap.current.at < 300) {
                          setPageEdit(true);
                          setRenamingSec(sec.id);
                          setRenameSecText(sec.payload.name);
                        }
                        lastSecTap.current = { id: sec.id, at: now };
                      }}
                      onLongPress={() => { setPageEdit(true); setRenamingSec(sec.id); setRenameSecText(sec.payload.name); }}
                      delayLongPress={350}
                    >
                      <Text style={s.secName}>{sec.payload.name}</Text>
                    </Pressable>
                  )}
                  <CircleBtn testID={`secadd-${sec.payload.name}`} glyph="+" label="Add" color={T.accent} size={22} onPress={() => addNote(sec)} />
                  {/* No × on a folder's ONLY section, exactly as the suite
                      does it: "No × on a folder's only section — its last
                      section can't be deleted." core's deleteSection refuses
                      it, and both screens swallowed that refusal, so the
                      button was offered and did nothing — in the state every
                      folder STARTS in, since normalize seeds each with one
                      section. The two-press × then answered a confirmed
                      delete with silence. */}
                  {pageEdit && sectionsOf(f.id).length > 1 && (
                    <ConfirmDelete testID={`nsecdel-${sec.payload.name}`} size={22} onDelete={() => {
                      const res = deleteSection(recs, sec.id);
                      if (!('error' in res)) mutate((e) => res.put.forEach((r) => e.put(r)));
                    }} />
                  )}
                </View>
                {!nfolded.has(sec.id) && notesOf(sec.id).length === 0 && (
                  <View>
                    {drag.slot !== null && emptyIdxOf(sec.id) === drag.slot && <View style={s.dropLine} />}
                    <View testID={`nsecempty-${sec.payload.name}`} ref={drag.registerRow(emptyIdxOf(sec.id))} style={s.emptySlot}>
                    </View>
                  </View>
                )}
                {!nfolded.has(sec.id) && notesOf(sec.id).map((n) => {
                  const fi = flatIdxOf(n.id);
                  return (
                    <NoteRow
                      key={n.id}
                      n={n}
                      idx={fi}
                      pageEdit={pageEdit}
                      picked={selectedSet.has(n.id)}
                      slotHere={drag.slot !== null && fi === drag.slot}
                      dragDy={drag.dragIdx !== null && fi === drag.dragIdx ? drag.dragDy : null}
                      swiped={swipe.swiped === n.id}
                      h={h}
                    />
                  );
                })}
              </View>
            ))}
            {secDrag.lineKey === `end:${f.id}` && <View style={s.dropLine} />}
          </View>
        ))}
        {view === 'all' && sharedPartner &&
          visibleShared
            .slice()
            .sort(byRecOrd)
            .map((f) => (
              <View key={`sh${f.id}`} style={s.folderBlock}>
                {/* Collapsible like my own, and the fold is MINE — device-local
                    AsyncStorage, never written to their store, never synced.
                    Folding their list away changes nothing on their screen. */}
                <Pressable
                  style={s.folderHead}
                  onPress={() => toggleFolderFold(`sh:${f.id}`)}
                  onLongPress={() => foldAllFolders(!foldedFolders.has(`sh:${f.id}`))}
                  delayLongPress={LONG_PRESS_MS}
                  hitSlop={8}
                >
                  <View style={s.chevWrap}><WebHitSlop /><Chevron open={!foldedFolders.has(`sh:${f.id}`)} color={T.text} /></View>
                  <Text style={[s.folderName, { backgroundColor: f.payload.color + '33' }]}>{f.payload.name}</Text>
                  {/* Beside the name, LEFT of the divider. It used to sit
                      between two rule segments, which read as a label on the
                      line rather than on the folder. */}
                  <Text testID="shared-owner-badge" style={s.ownerBadge}>{sharedPartnerLabel}</Text>
                  <View testID="shared-folder-rule" style={s.folderRule} />
                </Pressable>
                {!foldedFolders.has(`sh:${f.id}`) && sharedRecs
                  .filter((r): r is Rec<'section'> => r.type === 'section' && r.payload.folderId === f.id)
                  .sort(byRecOrd)
                  .map((sec) => (
                    <View key={sec.id} style={s.section}>
                      {/* A partner's section collapses like my own. The
                          folder above it already did; the sections inside it
                          did not, so the only way to put one away was to put
                          the whole partner away. Keyed 'sh:' so a shared
                          section id can never collide with one of mine, and
                          the fold is MINE — device-local, never written to
                          their store, never synced. */}
                      <Pressable
                        testID={`shared-secfold-${sec.payload.name}`}
                        style={[s.secHead, s.sharedSecHead]}
                        onPress={() => toggleNFold(`sh:${sec.id}`)}
                        onLongPress={() => foldAllSections(!nfolded.has(`sh:${sec.id}`))}
                        delayLongPress={LONG_PRESS_MS}
                        hitSlop={8}
                      >
                        <View style={s.chevWrap}><WebHitSlop /><Chevron open={!nfolded.has(`sh:${sec.id}`)} /></View>
                        <Text style={s.secName}>{sec.payload.name}</Text>
                      </Pressable>
                      {!nfolded.has(`sh:${sec.id}`) && sharedRecs
                        .filter((r): r is Rec<'note'> => r.type === 'note' && r.payload.sectionId === sec.id)
                        .sort(byRecOrd)
                        .map((n) => (
                          <View key={n.id} style={[s.row, s.sharedRow]}>
                            <Pressable
                              testID="all-shared-note"
                              onPress={() => setNotePrefs(`@${sharedPartner}:${f.id}`)}
                              style={s.rowBody}
                            >
                              <Text style={s.rowTitle} numberOfLines={1}>{n.payload.title}</Text>
                              <Text style={s.chev}>›</Text>
                            </Pressable>
                          </View>
                        ))}
                    </View>
                  ))}
              </View>
            ))}
        {pageEdit && <Pressable style={s.editBackdropFill} onPress={endEdit} />}
        </EditExit>
      </Scroll>
      {/* What the selection is FOR. A bar rather than a top-bar button: it
          appears only when something is chosen, it says how many, and it sits
          where the thumb already is. */}
      {/* ALWAYS SHOWING (the owner, 2026-09-16), on all three lists. It was the
          only thing that said how many were picked and it appeared only once
          something was — so the count you wanted before choosing was the one
          thing you could not see, and All was behind a mode. */}
      {(
        <PickBar
          prefix="recipes"
          count={selected.length}
          onAll={() => setSelected(selectableIds)}
          onClear={() => setSelected([])}
          onDelete={deleteSelected}
          action={{ label: 'Add', testID: 'recipes-to-shopping', onPress: addSelectedToShopping }}
        />
      )}
      {/* Manage variants. A small window, an initially empty list, a + that
          adds one, and a tapped row that opens into its name field and the
          card's own sections as checkboxes. The owner, 2026-08-22. */}
      {/* The mini date/time editor: exactly the three controls the owner named —
          remove the date, set it to today, done. Nothing else, because a
          fourth control here is a second date picker nobody asked for and
          the note editor already has the full one. */}
      {dateFor && (() => {
        const note = recs.find((x): x is Rec<'note'> => x.type === 'note' && x.id === dateFor && !x.deleted);
        if (!note) return null;
        const setDate = (date: string | null) =>
          mutate((e) => e.put({ ...note, payload: { ...note.payload, date } }));
        return (
          <Modal transparent animationType="fade" onRequestClose={() => setDateFor(null)}>
            <Pressable style={s.dateBackdrop} onPress={() => setDateFor(null)}>
              <Pressable style={s.dateCard} onPress={() => {}}>
                <Text style={s.dateTitle} numberOfLines={1}>{note.payload.title}</Text>
                {/* The circle-with-a-calendar, replacing the typed m/d box
                    everywhere (the owner, 2026-08-20). Picking through the grid
                    stores YYYY-MM-DD by construction — the class of bug the
                    old parse-on-submit comment guarded is unreachable now. */}
                <View style={s.dateRow}>
                  <DayPickBtn testID="note-date-pick" value={note.payload.date} onPress={() => setListPickOpen(true)} />
                </View>
                {listPickOpen && (
                  <DayPick
                    value={note.payload.date}
                    onPick={(d) => setDate(d)}
                    onClose={() => setListPickOpen(false)}
                  />
                )}
                <View style={s.dateRow}>
                  <CircleBtn
                    testID="note-date-clear"
                    glyph="×"
                    label="Remove the date"
                    size={36}
                    onPress={() => { setDate(null); setDateFor(null); }}
                  />
                  <CircleBtn
                    testID="note-date-today"
                    glyph="◉"
                    label="Today"
                    size={36}
                    color={T.gold}
                    onPress={() => setDate(todayStr())}
                  />
                  <CircleBtn
                    testID="note-date-done"
                    glyph="✓"
                    label="Done"
                    size={36}
                    color={T.accent}
                    active
                    onPress={() => setDateFor(null)}
                  />
                </View>
              </Pressable>
            </Pressable>
          </Modal>
        );
      })()}
      {emptyAsk && (
        <Modal transparent animationType="fade" onRequestClose={() => setEmptyAsk(null)}>
          <Pressable style={s.askBackdrop} onPress={() => setEmptyAsk(null)}>
            <Pressable style={s.askCard} onPress={() => {}}>
              <Text style={s.askText}>That's the folder's last section — move it and delete the emptied folder?</Text>
              <View style={s.askRow}>
                <Pill label="Cancel" onPress={() => setEmptyAsk(null)} />
                <Pill
                  label="Move & delete"
                  primary
                  onPress={() => {
                    const res = moveSectionEmptyingFolder(recs, emptyAsk.sectionId, emptyAsk.slot.folderId, emptyAsk.slot.beforeSectionId);
                    if (!('error' in res)) mutate((e) => res.put.forEach((r) => e.put(r)));
                    setEmptyAsk(null);
                  }}
                />
              </View>
            </Pressable>
          </Pressable>
        </Modal>
      )}
    </View>
  );
}

/**
 * A partner's shared note folder: their sections and rows, read-only — a tap
 * opens the note RENDERED (richLines), never the editor. Structure and body
 * both stay theirs; live shared note editing is a later milestone.
 */
function SharedNotes({ viewKey, partner }: { viewKey: string; partner: string }) {
  const { sharedRecs, sharedPut, sharedPartnerLabel } = useStore();
  const shown = sharedPartnerLabel ?? partner;
  const folderId = viewKey.slice(viewKey.indexOf(':') + 1);
  const folder = sharedRecs.find((r): r is Rec<'folder'> => r.type === 'folder' && r.id === folderId);
  const sections = sharedRecs
    .filter((r): r is Rec<'section'> => r.type === 'section' && r.payload.folderId === folderId)
    .sort(byRecOrd);
  const notesOf = (sid: string) =>
    sharedRecs
      .filter((r): r is Rec<'note'> => r.type === 'note' && r.payload.sectionId === sid)
      .sort(byRecOrd);
  /** The folder picker's card, raised from the username menu's Folders row. */
  const [pickOpen, setPickOpen] = useState(false);
  const [openShared, setOpenShared] = useState<Rec<'note'> | null>(null);
  const [sharedBodyEdit, setSharedBodyEdit] = useNoteScoped(openShared?.id ?? null, false);
  const [draft, setDraft] = useNoteScoped(openShared?.id ?? null, '');
  // A recipe someone shares with you is still a recipe to cook from.
  const [sharedScale, setSharedScale] = useNoteScoped(openShared?.id ?? null, 1);

  if (openShared) {
    const commitBody = () => {
      setSharedBodyEdit(false);
      if (draft !== openShared.payload.body) {
        const next = { ...openShared, payload: { ...openShared.payload, body: draft } };
        setOpenShared(next);
        void sharedPut(next);
      }
    };
    return (
      <View style={s.page}>
        <View style={s.edHead}>
          <Pressable style={s.ddPill} onPress={() => setOpenShared(null)}>
            <Text style={s.backText}>← @{shown}: {folder?.payload.name ?? ''}</Text>
          </Pressable>
        </View>
        <Scroll contentContainerStyle={s.editor}>
          <Text style={s.sharedTitle}>{openShared.payload.title}</Text>
          {openShared.payload.date && <Text style={s.sharedDate}>{openShared.payload.date}</Text>}
          {isRecipeNote(openShared.payload) && (
            <View testID="shared-scale-row" style={s.scaleRow}>
              {SCALES.map(([f, label, id]) => (
                <Pressable
                  key={id}
                  testID={`shared-scale-${id}`}
                  style={[s.scalePill, sharedScale === f && s.scalePillOn]}
                  onPress={() => setSharedScale(f)}
                  hitSlop={6}
                >
                  <Text style={[s.scaleText, sharedScale === f && s.scaleTextOn]}>{label}</Text>
                </Pressable>
              ))}
              {sharedScale !== 1 && <Text style={s.scaleNote}>Scaled — 1× to edit</Text>}
            </View>
          )}
          {sharedBodyEdit ? (
            <TextInput
              testID="shared-note-edit"
              style={s.body}
              value={draft}
              multiline
              autoFocus
              onChangeText={setDraft}
              onBlur={commitBody}
            />
          ) : (
            <Pressable
              testID="shared-note-body"
              style={s.body}
              onPress={() => {
                // Same rule as your own notes: never open an editor on text
                // that is not what the note says.
                if (sharedScale !== 1) return;
                setDraft(openShared.payload.body);
                setSharedBodyEdit(true);
              }}
            >
              {/* No tap-to-remind here: a reminder made of a partner's line
                  would write to THEIR store, which a tap must never do. */}
              <NoteBody body={sharedScale === 1 ? openShared.payload.body : scaleRecipeBody(openShared.payload.body, sharedScale)} recipe={isRecipeNote(openShared.payload)} />
            </Pressable>
          )}
        </Scroll>
      </View>
    );
  }

  return (
    <View style={s.page}>
      <TopBar title="Recipes" folders={{ dot: <FolderDot app="notes" />, onOpen: () => setPickOpen(true) }} />
      <FolderPick app="notes" button={false} open={pickOpen} onClose={() => setPickOpen(false)} />
      <Scroll contentContainerStyle={s.scroll}>
        <View style={s.folderHead}>
          <Text style={s.sharedFolderChip}>@{shown}: {folder?.payload.name ?? '…'}</Text>
        </View>
        {sections.map((sec) => (
          <View key={sec.id} style={s.section}>
            <View style={s.secHead}>
              <Text style={s.secName}>{sec.payload.name}</Text>
            </View>
            {notesOf(sec.id).map((n) => (
              <View key={n.id} style={s.row}>
                <Pressable testID="shared-note-row" onPress={() => setOpenShared(n)} style={s.rowBody}>
                  <Text style={s.rowTitle} numberOfLines={1}>{n.payload.title}</Text>
                  <Text style={s.chev}>›</Text>
                </Pressable>
              </View>
            ))}
          </View>
        ))}
      </Scroll>
    </View>
  );
}

type NoteLive = {
  drag: ReturnType<typeof useRowDrag>;
  swipe: ReturnType<typeof useSwipeLeft>;
  justHeld: { current: boolean };
  lastTap: { current: { id: string; at: number } | null };
  tapTimer: { current: ReturnType<typeof setTimeout> | null };
  toggleSelected: (id: string) => void;
  setPageEdit: (v: boolean) => void;
  setOpenId: (id: string) => void;
  setDateFor: (id: string) => void;
  dup: (id: string) => void;
  del: (id: string) => void;
  swipeDel: (id: string) => void;
};

/** Stable handlers a recipe row reaches the screen through (see `live` in Notes). */
type NoteHandlers = {
  reg: (i: number) => (ref: import('react-native').View | null) => void;
  grip: (i: number) => PanResponderInstance['panHandlers'];
  swipeHandlers: (id: string) => PanResponderInstance['panHandlers'];
  toggle: (id: string) => void;
  onHold: () => void;
  onRowPress: (id: string) => void;
  dateChip: (id: string) => void;
  dup: (id: string) => void;
  del: (id: string) => void;
  swipeDel: (id: string) => void;
};

type NoteRowProps = {
  n: Rec<'note'>;
  idx: number;
  pageEdit: boolean;
  picked: boolean;
  slotHere: boolean;
  /** Non-null only on the row being dragged: its travel. */
  dragDy: number | null;
  swiped: boolean;
  h: NoteHandlers;
};

/** One recipe row. Memoised: a pointermove or a tick re-renders only the rows whose props moved. */
const NoteRow = memo(function NoteRow({ n, idx, pageEdit, picked, slotHere, dragDy, swiped, h }: NoteRowProps) {
  return (
    <View>
      {slotHere && <View style={s.dropLine} />}
      <View ref={h.reg(idx)} {...(pageEdit ? {} : h.swipeHandlers(n.id))} style={[s.row, s.rowNoSelect, dragDy !== null && { opacity: 0.55, transform: [{ translateY: dragDy }] }]}>
        <View testID="note-grip" {...(pageEdit ? h.grip(idx) : {})} style={[s.rowGrip, !pageEdit && s.gripHidden]} pointerEvents={pageEdit ? 'auto' : 'none'} hitSlop={6}>
          <WebHitSlop slop={6} />
          <Text style={s.rowGripText}>≡</Text>
        </View>
        {/* The tick, ALWAYS — it leads the row rather than hiding behind the
            other controls, and it is the one control here that no longer
            waits on a mode. */}
        <Pressable
          testID={`recipe-pick-${n.payload.title}`}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: picked }}
          accessibilityLabel={`Select ${n.payload.title}`}
          onPress={() => h.toggle(n.id)}
          hitSlop={8}
          style={s.pickWrap}
        >
          <WebHitSlop slop={8} />
          <View style={[s.pick, picked && s.pickOn]}>
            {picked && <Text style={s.pickTick}>✓</Text>}
          </View>
        </Pressable>
        <Pressable
          testID="note-row"
          onPress={() => h.onRowPress(n.id)}
          // Edit mode, and NOTHING selected by arriving in it: the gesture
          // asks for the grips, and a PickBar that opened by itself would be
          // answering a question nobody asked.
          onLongPress={h.onHold}
          delayLongPress={350}
          style={s.rowBody}
        >
          <Text style={s.rowTitle} numberOfLines={1}>{n.payload.title}</Text>
          {/* The chevron means "tap to open", which is true in edit mode too —
              it only goes away for a SWIPED row, where a tap puts the delete
              back rather than opening anything. */}
          {!swiped && <Text style={s.chev}>›</Text>}
        </Pressable>
        {/* The date itself is the other way in: tapping a date in edit mode opens the same editor. */}
        {pageEdit && n.payload.date && (
          <Pressable testID={`note-datechip-${n.payload.title}`} onPress={() => h.dateChip(n.id)} hitSlop={6}>
            <WebHitSlop slop={6} />
            <Text style={s.dateChip}>{n.payload.date}</Text>
          </Pressable>
        )}
        {pageEdit && (
          <>
            {/* NO calendar button (the owner, 2026-08-22: "remove the calendar icon in edit mode in chefmind"); the date CHIP above stays. */}
            <CircleBtn testID="note-dup" glyph="⧉" label="Duplicate" size={22} onPress={() => h.dup(n.id)} />
            <ConfirmDelete onDelete={() => h.del(n.id)} />
          </>
        )}
        {swiped && !pageEdit && (
          <View style={s.swipePark}>
            <ConfirmDelete forceArmed onDelete={() => h.swipeDel(n.id)} />
          </View>
        )}
      </View>
    </View>
  );
});

const s = themed(() => StyleSheet.create({
  page: { flex: 1, backgroundColor: T.bg },
  toolRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  // flexGrow so the edit backdrop below the list has leftover height to take.
  // 8pt below the divider on every tab. Measured before touching it: 6 on
  // Reminders, 9 on Habits, 11 on Calendar, 16 on Notes. The owner named Habits as
  // closest and a hair tall, so 8 is the target and every screen is tuned to
  // land there rather than to carry the same number in its own style.
  // paddingTop 0 — the gap below the divider is TopBar's now (chrome.tsx).
  // This screen's 8 was the value that MATCHED the suite; it moved rather
  // than changed, and the other four came to it.
  // scroll lives on EditExit, not the scroll container — the wrapper must
  // render identically in and out of edit mode, and owning the padding is
  // what lets a gutter tap exit on the phone. scrollWrap is the container's.
  scrollWrap: { flexGrow: 1 },
  scroll: { padding: 16, paddingTop: 0, paddingBottom: 48, gap: 18, flexGrow: 1 },
  folderBlock: { gap: 8 },
  folderHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  folderName: {
    color: T.text,
    fontSize: 17,
    lineHeight: 22,
    fontWeight: '600',
    paddingHorizontal: 11,
    paddingVertical: 3,
    borderRadius: 999,
    overflow: 'hidden',
  },
  // The width a section head is pushed in by the drag grip it carries
  // (16) plus the head's own gap (8). A partner's sections have no grip
  // to push them, so they get the same distance as padding instead.
  sharedSecHead: { paddingLeft: 24 },
  // …and the same for a partner's ROWS, which lack the drag grip mine
  // carry (16) plus the row's gap — 8 here, not the 10 Reminders uses, so
  // this is 24 and not 26. Copying the number across would have been off by
  // two in the one place the whole change is about.
  sharedRow: { paddingLeft: 24 },
  ownerBadge: { color: T.accent, fontSize: 12, fontWeight: '700', backgroundColor: T.accentSoft, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 3, overflow: 'hidden' },
  folderRule: { flex: 1, height: 1, backgroundColor: T.lineSoft },
  section: { gap: 6 },
  secHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  secRename: { flex: 1, paddingVertical: 4 },
  secName: { color: T.gold, fontSize: 16, lineHeight: 20, fontWeight: '600' },
  // An explicit HEIGHT, not the glyph's. This box had width 20 and no
  // height, so its height WAS the chevron — and on the web, where
  // hitSlop does nothing, taking the chevron from 11 to 7 would have
  // taken the tap target with it. 20x20 regardless of what is drawn.
  chevWrap: { width: 20, height: 20, alignItems: 'center', justifyContent: 'center' },
  // ONE collapse-all across the app: Notes drew it at 24 and Reminders at
  // 26, and Habits drew a text '⌃' in a 30pt CircleBtn instead. Same
  // control, three sizes and two symbols. 26 is the largest of them, and
  // the circle IS the tap target here — the chevron inside is decoration.
  // toolbarRow is GONE. It had been emptied of its controls and left behind as
  // a bare <View> holding nothing, which is not free: it was the scroll's
  // first child, so it contributed its own paddingBottom of 2 AND a full
  // `gap: 18` between itself and the first folder. That is the 28px the owner saw
  // as "the notes gap is huge" — the divider spacing was 8 here, the smallest
  // of the five screens, and this row was hiding above everything.
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 44 },
  // The parked swipe-delete floats over the row's right edge, out of the
  // flex flow — as a flex child it squeezed the title and chevron sideways
  // the moment the × parked ("things shift with slide to delete" — the owner,
  // 2026-08-20). Same arrangement as Reminders' and the Calendar's.
  swipePark: {
    position: 'absolute', right: 0, top: 0, bottom: 0,
    flexDirection: 'row', alignItems: 'center',
    paddingLeft: 10, backgroundColor: T.bg,
  },
  // alignSelf STRETCH, not the parent's default 'center'. The row is 44pt and
  // this Pressable is what answers a tap in it; as a centred flex child it
  // collapsed to its one line of text — about 18pt — and the 26pt around it
  // looked exactly like the row while doing nothing, because it IS the row.
  // Its own alignItems:'center' still centres the title inside the taller box.
  rowBody: { flex: 1, alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowNoSelect: { userSelect: 'none', /* a swipe row permits only VERTICAL panning, so a horizontal swipe never scrolls the list under it on web — the owner, 2026-09-06 */ touchAction: 'pan-y' } as import('react-native').ViewStyle,
  sharedTitle: { color: T.text, fontSize: 22, fontWeight: '800' },
  sharedDate: { color: T.dim, fontSize: 13, marginTop: 2 },
  sharedFolderChip: { color: T.text, fontSize: 15, fontWeight: '800', paddingHorizontal: 10, paddingVertical: 2, borderRadius: 999, overflow: 'hidden' },
  gripHidden: { opacity: 0 },
  editBackdropFill: { flexGrow: 1, minHeight: 160 },
  // The selection tick. Sized like the reminder checkbox so a row in edit
  // mode has the same left edge it has on the Reminders tab.
  pickWrap: { paddingRight: 8 },
  pick: {
    width: 20, height: 20, borderRadius: 10,
    borderWidth: 2, borderColor: T.muted,
    alignItems: 'center', justifyContent: 'center',
  },
  pickOn: { backgroundColor: T.accent, borderColor: T.accent },
  pickTick: { color: T.accentInk, fontSize: 12, fontWeight: '700', lineHeight: 14 },
  // Above the tab bar, full width of the page column. Not absolutely
  // positioned: inside a Modal-free screen it can simply be the last child,
  // and a bar that is part of the layout cannot end up under the home
  // indicator the way an absolute one does.
  pickGo: { backgroundColor: T.accent, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 9 },
  pickGoText: { color: T.accentInk, fontSize: 14, fontWeight: '700' },
  // The variant picker and its menu. The menu is an ordinary block under the
  // scale row, not an absolute overlay: inside a Scroll an absolutely
  // positioned menu is clipped by its own row on the web.
  variantMenu: {
    marginTop: 6, borderWidth: 1, borderColor: T.line, borderRadius: 10,
    backgroundColor: T.surface, overflow: 'hidden',
  },
  variantOpt: { paddingHorizontal: 12, paddingVertical: 10 },
  variantOptOn: { backgroundColor: T.accentSoft },
  variantOptText: { color: T.text, fontSize: 14 },
  variantOptTextOn: { color: T.accent, fontWeight: '700' },
  variantEmpty: { color: T.muted, fontSize: 13, lineHeight: 19, padding: 12 },
  varCard: {
    width: '100%', maxWidth: 380, maxHeight: '80%', backgroundColor: T.surface,
    borderRadius: 14, borderWidth: 1, borderColor: T.line, padding: 16, gap: 10,
  },
  varHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  varScroll: { paddingBottom: 4 },
  varRow: { borderTopWidth: 1, borderTopColor: T.lineSoft },
  varRowHead: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4 },
  varRowBody: { flex: 1, paddingVertical: 6 },
  varName: { color: T.text, fontSize: 15 },
  varCount: { color: T.muted, fontSize: 12, marginTop: 2 },
  varOpen: { paddingBottom: 10, gap: 8 },
  varSec: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 },
  varBox: {
    width: 20, height: 20, borderRadius: 5, borderWidth: 2, borderColor: T.muted,
    alignItems: 'center', justifyContent: 'center',
  },
  varBoxOn: { backgroundColor: T.accent, borderColor: T.accent },
  varBoxTick: { color: T.accentInk, fontSize: 12, fontWeight: '700', lineHeight: 14 },
  varSecText: { color: T.text, fontSize: 15, flex: 1 },
  dateChip: { color: T.gold, fontSize: 12, paddingHorizontal: 6 },
  dateBackdrop: { flex: 1, backgroundColor: '#0009', alignItems: 'center', justifyContent: 'center', padding: 24 },
  dateCard: { width: '100%', maxWidth: 340, backgroundColor: T.surface, borderRadius: 14, borderWidth: 1, borderColor: T.line, padding: 16, gap: 12 },
  dateTitle: { color: T.text, fontSize: 15, fontWeight: '600' },
  dateRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around', marginTop: 4 },
  rowGrip: { width: 16, alignItems: 'center', justifyContent: 'center' },
  rowGripText: { color: T.lineSoft, fontSize: 13, userSelect: 'none' },
  dropLine: { height: 2, backgroundColor: T.accent, borderRadius: 1, marginVertical: 1 },
  emptySlot: { height: 0, overflow: 'hidden' },
  askBackdrop: { flex: 1, backgroundColor: '#000a', alignItems: 'center', justifyContent: 'center', padding: 24 },
  askCard: { width: '100%', maxWidth: 360, backgroundColor: T.surface, borderWidth: 1, borderColor: T.line, borderRadius: 16, padding: 20, gap: 14 },
  askText: { color: T.text, fontSize: 15, lineHeight: 22 },
  askRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  rowTitle: { color: T.text, fontSize: 16, flex: 1 },
  chev: { color: T.muted, fontSize: 16, marginLeft: 'auto' },
  editor: { padding: 16, gap: 10 },
  edHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16, marginHorizontal: 16, marginBottom: 8, paddingRight: 80, flexWrap: 'wrap' },
  // marginLeft auto pushes it to the right edge of the row, and it keeps its
  // corner when the row wraps on a narrow screen rather than following the
  // dropdowns down.
  // Same height as the top bar's dot, from the same constant, so opening a
  // note does not nudge it upwards.
  edStatus: { position: 'absolute', right: 16, top: TOPBAR_DOT_TOP },
  // Left of the status dot, on the same line as it.
  // Copy and Delete are a PAIR at the foot of the note, so Copy wears the same
  // pill as Delete rather than the smaller one it had in the corner.
  footActs: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  copyBtnText: { color: T.dim, fontSize: 15, borderWidth: 1, borderColor: T.line, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 5, overflow: 'hidden' },
  ddPill: { borderWidth: 1, borderColor: T.line, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: T.surface },
  backText: { color: T.accent, fontSize: 15, fontWeight: '600' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  addDate: { borderWidth: 1, borderColor: T.accent, borderStyle: 'dashed', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10 },
  addDateText: { color: T.accent, fontSize: 14, fontWeight: '600' },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  footRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 },
  saved: { color: T.muted, fontSize: 12 },
  // The word turns with the state; a grey 'Not saved' would read as furniture.
  savedBad: { color: T.danger, fontWeight: '700' },
  title: {
    flex: 1,
    color: T.text,
    fontSize: 18,
    fontWeight: '700',
    backgroundColor: T.surface,
    borderWidth: 1,
    borderColor: T.line,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  bodyPlaceholder: { color: T.muted, fontSize: 16, lineHeight: 24 },
  rtLine: { flexDirection: 'row', alignItems: 'flex-start' },
  rtPress: { flex: 1, flexDirection: 'row', alignItems: 'flex-start' },
  // The inset the rendered recipe sits in — quoted at the left edge, tagged
  // in the accent's italic, its rows the tap-to-remind surface.
  recipeCard: {
    borderLeftWidth: 3,
    borderLeftColor: T.accent,
    backgroundColor: T.surface2,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginVertical: 6,
    gap: 2,
  },
  recipeTag: { color: T.accent, fontSize: 11, fontWeight: '800', fontStyle: 'italic', textTransform: 'uppercase', letterSpacing: 0.6 },
  // The editor's version of the same thing, kept SMALL on purpose: one quiet
  // quoted chip standing where the recipe is, never as tall as the recipe.
  recipeBlob: {
    borderLeftWidth: 3,
    borderLeftColor: T.accent,
    backgroundColor: T.surface2,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginVertical: 8,
    gap: 2,
  },
  recipeBlobHint: { color: T.dim, fontSize: 13, fontStyle: 'italic' },
  bodyBank: { color: T.text, fontSize: 16, lineHeight: 24, minHeight: 56, textAlignVertical: 'top' },
  rtQuote: { borderLeftWidth: 3, borderLeftColor: '#a78bfa', paddingLeft: 10, marginVertical: 2 },
  rtQuoteText: { color: T.dim, fontStyle: 'italic' },
  rtDot: { color: T.dim, fontSize: 16, lineHeight: 24, marginRight: 8 },
  // The number sits in a gutter so a wrapped step lines up as a block, and
  // the steps get a little air between them — a recipe is read a line at a
  // time, looking up from a pan and back.
  rtNum: { color: T.dim, fontSize: 16, lineHeight: 24, marginRight: 8, minWidth: 20 },
  rtStep: { marginTop: 6 },
  scaleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  scalePill: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 999, borderWidth: 1, borderColor: T.line },
  scalePillOn: { borderColor: T.accent, backgroundColor: T.accent + '22' },
  scaleText: { color: T.dim, fontSize: 14 },
  scaleTextOn: { color: T.accent, fontWeight: '700' },
  scaleNote: { color: T.muted, fontSize: 12, flexShrink: 1 },
  rtText: { color: T.text, fontSize: 16, lineHeight: 24, flexShrink: 1 },
  rtBold: { fontWeight: '700' },
  rtItalic: { fontStyle: 'italic' },
  rtUnder: { textDecorationLine: 'underline' },
  body: {
    color: T.text,
    fontSize: 16,
    lineHeight: 24,
    minHeight: 280,
    textAlignVertical: 'top',
    backgroundColor: T.surface,
    borderWidth: 1,
    borderColor: T.line,
    borderRadius: 12,
    padding: 12,
  },
}));
