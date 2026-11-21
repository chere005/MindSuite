import React, { useEffect, useState } from 'react';
import { StatusBar, StyleSheet, View } from 'react-native';
// RN's own SafeAreaView is iOS-only — on Android the top bar sat under the
// status bar and the tab bar under the gesture bar. This one insets on both.
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StoreProvider, useStore } from './src/store';
import { ToastProvider } from './src/components/Toast';
import { TabBar, NavCtx, type Tab } from './src/nav';
import { Login } from './src/screens/Login';
import { Reminders } from './src/screens/Reminders';
import { Calendar, calSelectedDay } from './src/screens/Calendar';
import { Notes } from './src/screens/Notes';
import { Habits } from './src/screens/Habits';
import { Add } from './src/screens/Add';
import { QuickTick } from './src/screens/QuickTick';
import { Search } from './src/screens/Search';
import { DetailProvider, PhoneItemHost, layoutCrossing, useDetail } from './src/components/DetailPane';
import { WideShell, focusSidebarSearch } from './src/components/WideShell';
import { useWide } from './src/components/WideFrame';
import { inlineCarry } from './src/carry';
import { Request } from './src/screens/Request';
import { themed, currentTheme, onThemeChange, T, THEMES_LIGHT, PAGE_MAX_WIDTH } from './src/theme';

function Root() {
  const { ready, session } = useStore();
  const { wide } = useWide();
  const detail = useDetail();
  // The commit in which the window crosses 900 px swaps the whole frame and
  // remounts the screens; the open item (drawn from DetailProvider) outlives
  // that. See layoutCrossing.
  const prevWide = React.useRef(wide);
  layoutCrossing.now = prevWide.current !== wide;
  useEffect(() => { prevWide.current = wide; layoutCrossing.now = false; });
  // Signing in lands on the Calendar, as the suite does — "what's on today"
  // shouldn't depend on which icon you opened.
  // The tab survives a refresh, and every switch feeds the back stack.
  const [tab, setTabState] = useState<Tab>(() => {
    if (typeof localStorage !== 'undefined') {
      const t = localStorage.getItem('calmind.tab');
      if (t === 'reminders' || t === 'calendar' || t === 'add' || t === 'notes' || t === 'habits') return t;
    }
    return 'calendar';
  });
  const backStack = React.useRef<Tab[]>([]);
  const [canBack, setCanBack] = useState(false);
  // The day the Add tab was launched FROM: set at the moment of the switch,
  // and only when the calendar is what you were looking at — an Add opened
  // from Reminders or Notes still means today (the owner, 2026-08-20).
  const [addFrom, setAddFrom] = useState<string | null>(null);
  const setTab = (t: Tab) => {
    if (t === 'add') setAddFrom(tab === 'calendar' ? calSelectedDay() : null);
    if (t !== tab) {
      backStack.current.push(tab);
      setCanBack(true);
    }
    setTabState(t);
    if (typeof localStorage !== 'undefined') localStorage.setItem('calmind.tab', t);
  };
  // Switching section closes whatever item is open (the editor belongs to the
  // screen it was opened from), and so does signing out.
  const lastTab = React.useRef(tab);
  useEffect(() => {
    if (lastTab.current !== tab) { detail.item?.onClose(); inlineCarry.id = null; }
    lastTab.current = tab;
  }, [tab]);
  useEffect(() => { if (!session) detail.item?.onClose(); }, [session]);
  // The phone's full-screen Search is never drawn on a wide window, so a
  // flag left set would pop it when the window shrinks.
  useEffect(() => { if (wide) setSearchOpen(false); }, [wide]);
  const goBack = () => {
    const prev = backStack.current.pop();
    setCanBack(backStack.current.length > 0);
    if (prev) {
      setTabState(prev);
      if (typeof localStorage !== 'undefined') localStorage.setItem('calmind.tab', prev);
    }
  };
  // The widget's row link: ?tick=<id> opens the one-reminder Done page
  // (the suite's quick.php mode), on the signed-in session only.
  const [tickId, setTickId] = useState<string | null>(() => {
    if (typeof location === 'undefined') return null;
    return new URLSearchParams(location.search).get('tick');
  });
  const tickDone = () => {
    setTickId(null);
    if (typeof history !== 'undefined') history.replaceState(null, '', location.pathname);
  };
  // A note made anywhere opens in its editor — the Add tab hands the id over.
  const [noteToOpen, setNoteToOpen] = useState<string | null>(null);
  // The 🔍 in every top bar opens the one search screen; a tapped result
  // closes it and goes where the thing lives (the owner, 2026-08-19).
  const [searchOpen, setSearchOpen] = useState(false);
  // The PUBLIC request page: the same bundle served at <base>/request (a
  // rewrite on the deployed instance, e2e/router.php locally). It renders
  // for ANYONE — before the session gate on purpose, and never reachable
  // from the app's own navigation (the owner, 2026-08-19: "it's a separate URL
  // to give to people").
  if (typeof location !== 'undefined' && /\/request\/?$/.test(location.pathname)) return <Request />;
  if (!ready) return <View style={s.page} />;
  if (!session) return <Login />;
  if (tickId) return <QuickTick id={tickId} onDone={tickDone} />;
  const goNote = (id: string) => {
    setNoteToOpen(id);
    setTab('notes');
  };
  // The Add tab has no place in the wide layout (quick-add is its header field).
  const shownTab = wide && tab === 'add' ? 'calendar' : tab;
  const screens = (
    <>
      {shownTab === 'reminders' && <Reminders />}
      {shownTab === 'calendar' && <Calendar onNoteCreated={goNote} />}
      {shownTab === 'add' && <Add date0={addFrom} done={() => setTab('calendar')} onNoteCreated={goNote} />}
      {shownTab === 'notes' && <Notes openNoteId={noteToOpen} onOpenConsumed={() => setNoteToOpen(null)} />}
      {shownTab === 'habits' && <Habits />}
    </>
  );
  const openHit = (hit: Parameters<React.ComponentProps<typeof Search>['onOpen']>[0]) => {
    setSearchOpen(false);
    if (hit.kind === 'note') goNote(hit.id);
    else setTab(hit.kind === 'reminder' ? 'reminders' : 'calendar');
  };
  return (
    <NavCtx.Provider value={{
      canBack,
      goBack,
      // On a wide window Search IS the sidebar's field: focus it.
      openSearch: () => (wide ? focusSidebarSearch() : setSearchOpen(true)),
      openNote: goNote,
    }}>
    {wide ? (
      // Desktop-size window: sidebar, the section's own screen, detail pane.
      <View style={s.page}>
        <WideShell tab={tab} onTab={setTab} main={screens} onNoteCreated={goNote} onOpenHit={openHit} />
      </View>
    ) : (
    <View style={s.page}>
      {/* Phone-first column, centred on a wide window — the suite's page shape. */}
      <View style={s.centre}>
        <View style={s.body}>
          {screens}
        </View>
      </View>
      <TabBar tab={tab} onTab={setTab} />
      <PhoneItemHost />
      {searchOpen && <Search onClose={() => setSearchOpen(false)} onOpen={openHit} />}
    </View>
    )}
    </NavCtx.Provider>
  );
}

export default function App() {
  // A theme switch remounts the whole tree: every themed() sheet re-creates
  // itself under the new palette, and no component has to know.
  const [themeGen, setThemeGen] = useState(0);
  useEffect(() => onThemeChange(() => setThemeGen((g) => g + 1)), []);
  const light = THEMES_LIGHT.includes(currentTheme());
  return (
    <StoreProvider>
      <SafeAreaProvider>
        <SafeAreaView key={themeGen} testID="page-root" style={s.page} edges={['top', 'bottom', 'left', 'right']}>
          <StatusBar barStyle={light ? 'dark-content' : 'light-content'} backgroundColor={T.bg} />
          {/* The toast host wraps the tree so its popup is the LAST thing laid
              out in here, and therefore the thing drawn on top. Inside the
              safe area, so a centred notice is centred in the PAGE rather than
              in the screen the status bar is part of. */}
          <ToastProvider>
            <DetailProvider>
              <Root />
            </DetailProvider>
          </ToastProvider>
        </SafeAreaView>
      </SafeAreaProvider>
    </StoreProvider>
  );
}

const s = themed(() => StyleSheet.create({
  page: { flex: 1, backgroundColor: T.bg },
  centre: { flex: 1, alignItems: 'center' },
  body: { flex: 1, width: '100%', maxWidth: PAGE_MAX_WIDTH },
}));
