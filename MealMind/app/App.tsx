import React, { useEffect, useState } from 'react';
import { StatusBar, StyleSheet, View } from 'react-native';
// RN's own SafeAreaView is iOS-only — on Android the top bar sat under the
// status bar and the tab bar under the gesture bar. This one insets on both.
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StoreProvider, useStore } from './src/store';
import { ToastProvider } from './src/components/Toast';
import { TabBar, NavCtx, type Tab } from './src/nav';
import { Login } from './src/screens/Login';
import { Notes } from './src/screens/Notes';
import { Pantry, Shopping } from './src/screens/Shopping';
import { Search } from './src/screens/Search';
import { useWide } from './src/components/WideFrame';
import { PhoneFlows } from './src/components/PhoneFlows';
import { ChefSessionProvider, pruneIds, useChefSession } from './src/session';
import { ChefWide } from './src/wide/ChefWide';
import { themed, currentTheme, onThemeChange, T, THEMES_LIGHT, PAGE_MAX_WIDTH } from './src/theme';
import { showsLogin } from './src/accountmode';
import { formerMealStorageKey } from './src/storage';

const TAB_KEY = 'mealmind.tab';

function Root() {
  const { ready, session, recs, localMode, signInOpen } = useStore();
  const sess = useChefSession();
  const { wide } = useWide();
  // Signing in lands on NOTES. Upstream it is the calendar — "what's on today"
  // shouldn't depend on which icon you opened — and there is no calendar here.
  // Notes is where the recipes are, which is what this app is for.
  // The tab survives a refresh, and every switch feeds the back stack.
  const [tab, setTabState] = useState<Tab>(() => {
    if (typeof localStorage !== 'undefined') {
      const t = localStorage.getItem(TAB_KEY) ?? localStorage.getItem(formerMealStorageKey(TAB_KEY));
      // 'reminders' and 'add' are deliberately absent, and the absence does
      // work: a browser that used an older build has one of those strings in
      // localStorage, and accepting it would land on a tab that no longer
      // renders anything.
      if (t === 'notes' || t === 'shopping') return t;
    }
    return 'notes';
  });
  const backStack = React.useRef<Tab[]>([]);
  const [canBack, setCanBack] = useState(false);
  const setTab = (t: Tab) => {
    if (t !== tab) {
      backStack.current.push(tab);
      setCanBack(true);
    }
    setTabState(t);
    if (typeof localStorage !== 'undefined') localStorage.setItem(TAB_KEY, t);
  };
  const goBack = () => {
    const prev = backStack.current.pop();
    setCanBack(backStack.current.length > 0);
    if (prev) {
      setTabState(prev);
      if (typeof localStorage !== 'undefined') localStorage.setItem(TAB_KEY, prev);
    }
  };
  // A note made anywhere opens in its editor — Search hands the id over.
  const [noteToOpen, setNoteToOpen] = useState<string | null>(null);
  // The 🔍 in every top bar opens the one search screen; a tapped result
  // closes it and goes where the thing lives (the owner, 2026-08-19).
  const [searchOpen, setSearchOpen] = useState(false);
  // Recipes deleted elsewhere (another device, a sync) leave the picks.
  useEffect(() => {
    if (!ready) return;
    const live = new Set(recs.filter((r) => r.type === 'note' && !r.deleted).map((r) => r.id));
    sess.setPicked((cur) => pruneIds(cur, live));
  }, [recs, ready]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!ready) return <View style={s.page} />;
  // No session is the Login card — unless the build is account-optional and
  // this is local mode, where Login is only what Settings → Sign in opens.
  if (showsLogin({ session: !!session, localMode, signInOpen })) return <Login />;
  return (
    <NavCtx.Provider value={{ canBack, goBack, openSearch: () => setSearchOpen(true), openTab: setTab, openNote: (id) => { setNoteToOpen(id); setTab('notes'); } }}>
    <View style={s.page}>
      {wide ? <ChefWide tab={tab} onTab={setTab} /> : (<>
      {/* Phone-first column, centred on a wide window — the suite's page shape. */}
      <View style={s.centre}>
        <View style={s.body}>
          {tab === 'notes' && <Notes openNoteId={noteToOpen} onOpenConsumed={() => setNoteToOpen(null)} />}
          {tab === 'pantry' && <Pantry />}
          {tab === 'shopping' && <Shopping />}
        </View>
      </View>
      <TabBar tab={tab} onTab={setTab} />
      <PhoneFlows onShopping={() => setTab('shopping')} />
      </>)}
      {!wide && searchOpen && (
        <Search
          onClose={() => setSearchOpen(false)}
          onOpen={(hit) => {
            setSearchOpen(false);
            if (hit.kind === 'note') {
              setNoteToOpen(hit.id);
              setTab('notes');
            } else {
              // The only reminder records left are shopping rows.
              setTab('shopping');
            }
          }}
        />
      )}
    </View>
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
      <ChefSessionProvider>
      <SafeAreaProvider>
        <SafeAreaView key={themeGen} testID="page-root" style={s.page} edges={['top', 'bottom', 'left', 'right']}>
          <StatusBar barStyle={light ? 'dark-content' : 'light-content'} backgroundColor={T.bg} />
          {/* The toast host wraps the tree so its popup is the LAST thing laid
              out in here, and therefore the thing drawn on top. Inside the
              safe area, so a centred notice is centred in the PAGE rather than
              in the screen the status bar is part of. */}
          <ToastProvider>
            <Root />
          </ToastProvider>
        </SafeAreaView>
      </SafeAreaProvider>
      </ChefSessionProvider>
    </StoreProvider>
  );
}

const s = themed(() => StyleSheet.create({
  page: { flex: 1, backgroundColor: T.bg },
  centre: { flex: 1, alignItems: 'center' },
  body: { flex: 1, width: '100%', maxWidth: PAGE_MAX_WIDTH },
}));
