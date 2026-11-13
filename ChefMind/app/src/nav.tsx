/**
 * The icon-only bottom tab bar: Recipes · Pantry · Shopping. The active tab
 * wears a fixed circle behind its icon — a highlight that can never move the
 * tabs' spacing. The bar's contents cap at the same width as the page column,
 * so on a wide window the tabs stay under the content instead of flying to
 * the edges.
 *
 * Upstream this has five: the calendar and habits sit either side of a raised
 * accent + . ChefMind keeps the shopping list and nothing else — the owner,
 * 2026-08-21: "remove reminders from ChefMind". A cooking app that also held
 * a general reminders list was holding CalMind's job.
 *
 * The PANTRY joined it 2026-08-22 (the owner: "add a third tab to chefmind which is
 * a list of groceries on hand"). Pantry sits beside Recipes rather than beside
 * Shopping, even though the two lists are the same component: they are
 * opposites — what you have and what you need — and putting them adjacent is
 * how you tap the wrong one.
 *
 * The + went 2026-09-15 (the owner: "remove the + page from ChefMind"), and with it
 * the only raised control the bar had, so every tab is now the same shape. It
 * filed ONE kind — a recipe — into a section chosen from a dropdown, which is
 * the thing the Recipes screen's own + beside each section does in place,
 * already looking at the section it files into. Adding from the bar meant
 * naming that destination blind. Shopping and pantry rows were never its job;
 * each of those lists has its own + .
 *
 * The `reminder` RECORD type stays, and is not a leftover: the shopping rows
 * are reminder records in a folder of their own. What went is the screen.
 */
import { Pressable, StyleSheet, View , Platform } from 'react-native';
import { themed, T, PAGE_MAX_WIDTH } from './theme';
import { BasketIcon, PantryIcon } from './components/ChefIcons';
import { PageIcon } from './components/KindIcons';

export type Tab = 'notes' | 'pantry' | 'shopping';

// Emoji presentation (VS16) so every glyph draws in colour — the plain-text
// checkbox was near-invisible on the dark bar.
// Each tab says its own name to a screen reader — the suite labels every
// icon-only control, and a bare glyph read aloud is no use to anybody.
// 'notes' keeps its key and gains a NAME: the owner, 2026-08-21 — "rename notes to
// recipes". The record type, the folder's `app` and every stored preference
// still say 'notes', because renaming those would be a migration of his data
// to change a label.
const TAB_LABEL: Record<Tab, string> = {
  notes: 'Recipes', pantry: 'Pantry', shopping: 'Shopping',
};

// No icon field: the bar draws its own SVG glyphs by key (see below), and
// these carried emoji that nothing has rendered since. Removed 2026-08-12 —
// a list of icons beside a bar that draws none is a thing to be misread.
const TABS: { key: Tab }[] = [
  { key: 'notes' },
  { key: 'pantry' },
  { key: 'shopping' },
];

export function TabBar({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
  return (
    <View style={s.barOuter}>
      <View style={s.bar}>
        {TABS.map(({ key }) => (
          <Pressable key={key} testID={`tab-${key}`} accessibilityRole="button" accessibilityLabel={TAB_LABEL[key]} onPress={() => onTab(key)} style={s.tab} hitSlop={6}>
            <View style={[s.halo, tab === key && s.haloOn]}>
              {/* One SVG language for the whole bar — no emoji. */}
              {key === 'notes' && <PageIcon color={tab === key ? T.text : T.dim} />}
              {key === 'pantry' && <PantryIcon color={tab === key ? T.text : T.dim} />}
              {key === 'shopping' && <BasketIcon color={tab === key ? T.text : T.dim} />}
            </View>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const s = themed(() => StyleSheet.create({
  barOuter: {
    borderTopWidth: 1,
    borderTopColor: T.line,
    backgroundColor: T.bg,
    alignItems: 'center',
  },
  bar: {
    width: '100%',
    maxWidth: PAGE_MAX_WIDTH,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    // Web spreads 640px wide; the suite's bar keeps its icons closer, and the
    // number shrinks with the tab COUNT — space-around over a width meant for
    // more icons than there are parks them at the edges of a gap nothing
    // fills. 420 held five, 340 held four, 255 holds three at about the same
    // gap between them.
    ...(Platform.OS === 'web' ? { alignSelf: 'center' as const, width: 255, maxWidth: '100%' as const } : null),
    paddingVertical: 6,
  },
  tab: { alignItems: 'center', justifyContent: 'center' },
  halo: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  haloOn: { backgroundColor: T.surface2 },
}));

/**
 * The tiny tab-history context: App owns the stack, the TopBar's back
 * control pops it — the owner's always-goes-back button, and the remembered tab
 * a refresh restores.
 */
import { createContext, useContext } from 'react';
export const NavCtx = createContext<{ canBack: boolean; goBack: () => void; openSearch: () => void; openNote?: (id: string) => void }>({
  canBack: false,
  goBack: () => {},
  openSearch: () => {},
});
export const useNav = () => useContext(NavCtx);
