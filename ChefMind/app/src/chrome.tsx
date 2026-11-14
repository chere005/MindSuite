/**
 * The shared chrome — the suite's rule made a component: the top bar is one
 * row, in the same place in every app: the app's name on the left; on the
 * right the screen's own controls, then the folder picker slot, then the
 * username — whose tap opens the menu. Every screen gets it for free.
 *
 * WHAT IS IN THE MENU RATHER THAN THE ROW (the owner, 2026-09-16): Search and Show
 * completed were both circles in the bar. Search is a door, not a state, and
 * Completed is a setting you change a few times a week — neither earns a
 * permanent 32pt hole beside the app's name, and with the collapse-all gone
 * too the row is back to what the screen IS plus where it is pointed.
 */
import React, { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { logout } from './api';
import { useStore } from './store';
import { themed, T } from './theme';
import { CircleBtn, Rule, TOPBAR_CTRL, TOPBAR_MARGIN_TOP } from './ui';
import { Settings } from './screens/Settings';
import { syncLook } from './components/SyncDot';
import { useToast } from './components/Toast';
import { useNav } from './nav';
// A Modal is its own window, so an absolute `top` inside one is measured from
// the top of the SCREEN, not from where the app's content begins. Without the
// inset this menu hung level with the status bar instead of under the pill
// that opens it.
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export function TopBar({
  title,
  controls,
  folders,
  showCompleted,
  onToggleCompleted,
  copyMarkdown,
  picker,
}: {
  title: string;
  controls?: React.ReactNode;
  /**
   * What this screen would put on the clipboard as Markdown, or nothing if it
   * has none. The owner, 2026-08-12: every tab, every user — it used to be one
   * button on Reminders, visible only to him.
   *
   * A FUNCTION rather than a string: building the markdown means walking the
   * whole screen's rows, and doing that on every render of every top bar to
   * fill a menu row nobody has opened is work for nothing.
   */
  copyMarkdown?: () => string;
  /**
   * Whether this screen is SHOWING finished items, or undefined on a screen
   * that has no such idea. The pair is what the menu row is made of: a state
   * to draw a box from and a handler to flip it. It was a ☑ circle in the bar
   * until 2026-09-16; the bar is for the screen, and this is a preference
   * about what the screen shows.
   */
  /**
   * The folder picker, as a MENU ROW rather than a ring in the bar (the owner,
   * 2026-09-16, ChefMind only). `dot` is the picker's own face — the pie
   * that says which folder you are looking at before the row is read, which
   * was the whole point of the ring it replaces — and `onOpen` raises the
   * picker's card, which the screen renders for itself.
   */
  folders?: { dot: React.ReactNode; onOpen: () => void } | undefined;
  showCompleted?: boolean | undefined;
  onToggleCompleted?: (() => void) | undefined;
  /**
   * The bar's picker slot. NOTHING in ChefMind passes it any more — the
   * folder picker is a menu row (see `folders`) — but the slot stays,
   * because this chrome is a fork of CalMind's, upstream still fills it, and
   * a prop deleted on one side is a diff that has to be re-read every time
   * the two are compared.
   */
  picker?: React.ReactNode;
}) {
  const nav = useNav();
  const insets = useSafeAreaInsets();
  const { session, signOut, undoLastDelete, syncState, persistFailed, refusedLabels, refusedWhy, sharedTrouble } = useStore();
  // No requests badge here. Upstream the account button carries a count of
  // new meeting requests from the public /request link; that page is a server
  // endpoint CalMind owns and ChefMind has no equivalent of, so the button is
  // the letter and the sync ring alone.
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /**
   * What just happened, said in a popup in the middle of the screen.
   *
   * It used to be a `<Text>` under the bar, which the owner named exactly right —
   * "text that randomly inserts itself", 2026-08-12. It was a laid-out child,
   * so it pushed the whole list down when it appeared and pulled it back up
   * two seconds later: copying something moved the thing you were reading.
   * See components/Toast for why the host is at the root rather than here.
   */
  const toast = useToast();
  /**
   * Where the username pill actually is on screen.
   *
   * The menu used to be `right: 16` inside its Modal — 16px from the right
   * edge of the WINDOW. The app is a 640px centred column, so on any window
   * wider than that the menu flew off to the side, nowhere near the pill that
   * opened it (the owner, on web and macOS, with a screenshot). A menu belongs
   * under its button, so the button is measured and the menu hung off it.
   */
  const pillRef = React.useRef<View>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const openMenu = () => {
    // measureInWindow gives SCREEN coordinates, which is the space a Modal
    // lays out in — the same reason the inset is needed for `top`.
    //
    // Opened INSIDE the callback, not beside it: measuring is asynchronous,
    // and opening first meant the menu sometimes drew one frame before its
    // anchor existed and fell back to the window's corner. That is what made
    // the old bug look "random" — it reproduced at 1160px and not at 1440.
    const node = pillRef.current as unknown as
      { measureInWindow?: (cb: (x: number, y: number, w: number, h: number) => void) => void } | null;
    if (node?.measureInWindow) {
      node.measureInWindow((x, y, w, h) => { setAnchor({ x, y, w, h }); setMenuOpen(true); });
    } else {
      // No measurement available: the corner fallback is better than no menu.
      setAnchor(null);
      setMenuOpen(true);
    }
  };
  // One rule, one place: the dot, Settings, the note editor and this border
  // all read the same function.
  const look = syncLook(syncState, persistFailed, refusedLabels, refusedWhy, sharedTrouble);
  return (
    <>
      <View style={s.topbar}>
        {/* Back sits top-LEFT, before the title, and is ALWAYS drawn — the
            suite's back_button() emits it unconditionally, wired straight to
            history.back(), with no test for whether there is anywhere to go.
            Ours was on the right and conditional, so every control in the row
            slid sideways depending on history; then it was left but invisible
            on a cold open, which left a gap where a button belongs. Pressing
            it with an empty stack pops nothing and does nothing, exactly as
            history.back() does on a fresh page. */}
        <View style={s.hleft}>
          <CircleBtn testID="nav-back" glyph="‹" size={TOPBAR_CTRL} label="Back" onPress={nav.goBack} />
          <Text style={s.appname} numberOfLines={1}>{title}</Text>
        </View>
        <View style={s.right}>
          {controls}
          {picker && <View style={s.pickerRing}>{picker}</View>}
          {/* The account button, and the STATUS INDICATOR in one control.
              The owner, 2026-08-12: same size as every other button, the
              username's first letter as its icon, and "the color of the
              button border is the status indicator, so the status indicator
              can be removed".

              That is a real simplification rather than a saving of pixels:
              the dot had to live somewhere, and it had been moved twice in a
              day — between the picker and the pill, then past it, then held
              still against the note editor's copy. A border has no position
              of its own to get wrong.

              It still carries the whole sentence as its accessibility label,
              because a coloured ring tells a screen reader nothing — the same
              rule SyncDot has always followed, and the reason `syncLook` is
              shared rather than copied. */}
          <Pressable
            ref={pillRef}
            testID="topbar-sync"
            onPress={openMenu}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`${session?.username ?? ''} — account menu. ${look.text}`}
            style={[s.whoBtn, { borderColor: look.color }]}
          >
            <Text style={s.whoLetter}>{(session?.username ?? '?').slice(0, 1).toUpperCase()}</Text>
          </Pressable>
        </View>
      </View>
      {/* The gap AFTER the divider belongs here, not to each screen.
          Every tab had invented its own: 1px on Calendar (pagerRow), 8 on
          Notes, 12 on Habits, 16 on Reminders and Add — four values across
          five tabs, which is what the owner saw switching between them. Each
          screen's own paddingTop is 0 now, so this is the only thing that
          sets it.

          10, because the owner chose it looking at the built app: "habits looks
          almost correct, i'd go with 10px" (Habits was the 12). The suite's
          own number is 8 — `header { …; margin-bottom: 0.5rem }` in
          lib/chrome.php, at its 16px root — so this is a deliberate
          departure from the spec, not an oversight in reading it. */}
      <View testID="top-rule" style={s.ruleWrap}><Rule /></View>
      {/* The username's own dropdown — the same two rows in every app. */}
      {menuOpen && (
        <Modal transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
          <Pressable style={s.menuBackdrop} onPress={() => setMenuOpen(false)}>
            <View
              style={[
                s.menu,
                anchor
                  // Right edges aligned, hanging 6 under the pill. max(8) keeps
                  // it on screen if the window is narrower than the menu.
                  ? { top: anchor.y + anchor.h + 6, left: Math.max(8, anchor.x + anchor.w - MENU_W), width: MENU_W }
                  : { top: insets.top + 52, right: 16 },
              ]}
            >
              {/* THE ORDER (the owner, 2026-09-16): Settings at the top, always,
                  always followed by Search — the two rows that are on every
                  screen of every app, so the hand learns one place for them.
                  The rows that come and go (Copy as Markdown, Show
                  completed) sit at the FOOT, above Log out, where their
                  appearing and disappearing cannot shuffle anything above
                  them. */}
              <Pressable style={s.menuRow} onPress={() => { setMenuOpen(false); setSettingsOpen(true); }}>
                <Text style={s.menuText}>Settings</Text>
              </Pressable>
              {/* Search: the only row that LEAVES this screen for another,
                  which is why it sits with Settings at the fixed head rather
                  than among the rows that come and go. It was the bar's own
                  circle until 2026-09-16. */}
              <Pressable
                testID="menu-search"
                style={s.menuRow}
                onPress={() => { setMenuOpen(false); nav.openSearch(); }}
              >
                <Text style={s.menuText}>Search</Text>
              </Pressable>
              {/* The owner, 2026-08-11. It says what came BACK rather than just
                  closing: the deleted thing is by definition not on screen,
                  so a silent restore looks like nothing happened — and if it
                  restored something older than he expected, being told which
                  is how he finds that out. */}
              <Pressable
                testID="undo-delete"
                style={s.menuRow}
                onPress={() => {
                  const back = undoLastDelete();
                  setMenuOpen(false);
                  // Only a RESTORE gets the quotes — the other messages are
                  // whole sentences of their own.
                  toast(back === null ? 'Nothing to undo' : `Restored “${back}”`, 2600);
                }}
              >
                <Text style={s.menuText}>Undo last delete</Text>
              </Pressable>
              {folders && (
                <Pressable
                  testID="menu-folders"
                  style={s.menuRow}
                  onPress={() => { setMenuOpen(false); folders.onOpen(); }}
                >
                  <View style={s.menuRowInner}>
                    {folders.dot}
                    <Text style={s.menuText}>Folders</Text>
                  </View>
                </Pressable>
              )}
              {copyMarkdown && (
                <Pressable
                  testID="menu-copymd"
                  style={s.menuRow}
                  onPress={() => {
                    setMenuOpen(false);
                    // Say something either way. A refusal — a browser that
                    // will not hand the clipboard to a page it thinks is
                    // unfocused — used to be swallowed whole, and a button
                    // with no answer is a button you press twice.
                    Clipboard.setStringAsync(copyMarkdown())
                      .then(() => toast('Copied as Markdown'))
                      .catch(() => toast('Could not copy'));
                  }}
                >
                  <Text style={s.menuText}>Copy as Markdown</Text>
                </Pressable>
              )}
              {/* The show-completed toggle, drawn as the box it used to be so
                  the state is still readable at a glance. The menu SHUTS on
                  the press: leaving it open over a list that just changed
                  length hides the thing you asked to see. */}
              {onToggleCompleted && (
                <Pressable
                  testID="menu-completed"
                  style={s.menuRow}
                  onPress={() => { setMenuOpen(false); onToggleCompleted(); }}
                >
                  <View style={s.menuRowInner}>
                    <Text style={[s.menuBox, showCompleted && s.menuBoxOn]}>{showCompleted ? '☑' : '☐'}</Text>
                    <Text style={s.menuText}>Show completed</Text>
                  </View>
                </Pressable>
              )}
              <Pressable
                style={s.menuRow}
                onPress={async () => {
                  setMenuOpen(false);
                  if (session) void logout(session);
                  await signOut();
                }}
              >
                <Text style={s.menuText}>Log out</Text>
              </Pressable>
            </View>
          </Pressable>
        </Modal>
      )}
      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
    </>
  );
}

/** The menu's width, needed up front to right-align it against the pill. */
const MENU_W = 180;

const s = themed(() => StyleSheet.create({
  ruleWrap: { marginBottom: 10 },
  topbar: {
    height: TOPBAR_CTRL,
    marginTop: TOPBAR_MARGIN_TOP,
    marginHorizontal: 16,
    marginBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  // The title is what gives at a narrow width — it can ellipsize; the back
  // control, the picker and the username cannot shrink without becoming
  // unhittable.
  appname: { color: T.text, fontSize: 24, fontWeight: '800', flexShrink: 1 },
  hleft: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1, minWidth: 0 },
  // 8 between every button, the owner's number. It was 10 here with a further 4
  // either side of the picker, so the row had three different gaps in it.
  right: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 0 },
  // Prod's header controls: the picker sits in a dark ringed circle, the
  // username in a thin outlined pill — header nav .who, carried over.
  // One row, one scale — every control is TOPBAR_CTRL high, the suite's
  // `.backbtn, .titlebtn, .usermenu .who { height: 32px }`.
  // Icon-sized, ringed, with air between the pie and its border (the owner).
  pickerRing: { width: TOPBAR_CTRL, height: TOPBAR_CTRL, borderRadius: TOPBAR_CTRL / 2, borderWidth: 1, borderColor: T.line, backgroundColor: T.surface, alignItems: 'center', justifyContent: 'center' },
  // The same circle as every other control in the row. borderWidth 2, not 1:
  // the border IS the status now, and one pixel of colour is not a signal.
  whoBtn: {
    width: TOPBAR_CTRL, height: TOPBAR_CTRL, borderRadius: TOPBAR_CTRL / 2,
    borderWidth: 2, backgroundColor: T.surface,
    alignItems: 'center', justifyContent: 'center',
  },
  whoLetter: { color: T.accent, fontSize: 15, fontWeight: '700' },
  menuBackdrop: { flex: 1, backgroundColor: '#0007' },
  menu: {
    position: 'absolute',
    // top/left are set inline, measured off the username pill.
    minWidth: MENU_W,
    backgroundColor: T.surface,
    borderWidth: 1,
    borderColor: T.line,
    borderRadius: 12,
    paddingVertical: 4,
  },
  menuRow: { paddingHorizontal: 16, paddingVertical: 11 },
  /** A row's label and its box side by side — an INNER view rather than
   *  flexDirection on menuRow itself, which would re-lay-out every row. */
  menuRowInner: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  menuText: { color: T.text, fontSize: 15 },
  // The same box the bar's circle wore, at the menu's own scale.
  menuBox: { color: T.muted, fontSize: 15, width: 16 },
  menuBoxOn: { color: T.accent },
}));
