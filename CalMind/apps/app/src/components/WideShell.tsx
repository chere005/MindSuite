/**
 * CalMind's wide (desktop-size) layout: WideFrame filled with this app's own
 * sidebar, a quick-add header over the section's existing screen, and the
 * detail pane DetailPane draws. Every action lives here — the MindSuite bar
 * above the app only switches apps (the owner, 2026-11-21).
 *
 * Layout and wiring only. The sections are the phone's own screens at full
 * width; visibility and list choice write the same synced prefs the calendar
 * picker and folder picker write; quick-add files through addline.ts, the
 * function the Add tab uses.
 */
import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { prefsPut, type Rec, type SearchHit } from '@calmind/core';
import { useStore } from '../store';
import { themed, T } from '../theme';
import { useAddLine, type AddKind } from '../addline';
import { calSelectedDay } from '../screens/Calendar';
import { SearchBody } from '../screens/Search';
import { Field, Pill } from '../ui';
import type { Tab } from '../nav';
import { useCalendarView } from './CalendarPick';
import { useFolderView } from './FolderPick';
import { DetailBody, useDetail } from './DetailPane';
import { useToast } from './Toast';
import { SidebarItem, SidebarLabel, SidebarTitle, WideFrame, type WideColors } from './WideFrame';

type Section = Exclude<Tab, 'add'>;
const SECTIONS: { key: Section; label: string }[] = [
  { key: 'reminders', label: 'Reminders' },
  { key: 'calendar', label: 'Calendar' },
  { key: 'notes', label: 'Notes' },
  { key: 'habits', label: 'Habits' },
];

/** WideFrame's palette, read off the live theme on every render. */
function wideColors(): WideColors {
  return {
    background: T.bg, sidebar: T.surface, surface: T.surface, line: T.line,
    text: T.text, dim: T.dim, accent: T.accent, selected: T.accentSoft, selectedText: T.text,
  };
}

export function WideShell({ tab, onTab, main, onNoteCreated, onOpenHit }: {
  tab: Tab;
  onTab: (t: Tab) => void;
  main: React.ReactNode;
  onNoteCreated: (id: string) => void;
  onOpenHit: (hit: SearchHit) => void;
}) {
  const colors = wideColors();
  const detail = useDetail();
  const [query, setQuery] = useState('');
  const searching = query.trim() !== '';
  const section: Section = tab === 'add' ? 'calendar' : tab;

  // Esc closes the pane (web), unless a picker or menu window is open over it.
  const closeDetail = detail.item?.onClose;
  useEffect(() => {
    if (!closeDetail || typeof document === 'undefined') return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      if (document.querySelector('[aria-modal="true"]')) return;
      closeDetail();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [closeDetail]);

  return (
    <WideFrame
      colors={colors}
      sidebar={<Sidebar tab={section} onTab={(t) => { setQuery(''); onTab(t); }} query={query} setQuery={setQuery} colors={colors} />}
      main={
        <View style={s.main}>
          <QuickAdd tab={section} onNoteCreated={onNoteCreated} />
          {searching && (
            <View testID="wide-search-results" style={s.results}>
              <Text style={s.resultsHead}>Search results for “{query.trim()}”</Text>
              <SearchBody query={query} onOpen={(hit) => { setQuery(''); onOpenHit(hit); }} />
            </View>
          )}
          {/* Kept mounted under the results, so a section does not lose its
              place (an open day, a half-typed edit) to a search. */}
          <View style={[s.screen, searching && s.hidden]}>{main}</View>
        </View>
      }
      detail={detail.item ? <DetailBody item={detail.item} /> : null}
      onCloseDetail={detail.item?.onClose}
    />
  );
}

function Swatch({ color, on }: { color: string; on: boolean }) {
  return <View style={[s.swatch, { borderColor: color }, on && { backgroundColor: color }]} />;
}

function Sidebar({ tab, onTab, query, setQuery, colors }: {
  tab: Section; onTab: (t: Tab) => void; query: string; setQuery: (q: string) => void; colors: WideColors;
}) {
  const { recs, mutate, sharedPartnerLabel } = useStore();
  const cal = useCalendarView();
  const rem = useFolderView('reminders');
  const openReminders = recs.filter((r): r is Rec<'reminder'> => r.type === 'reminder' && !r.payload.done);
  const notes = recs.filter((r) => r.type === 'note').length;
  const count = (k: Section) => (k === 'reminders' ? openReminders.length : k === 'notes' ? notes : null);
  const setCal = (next: Parameters<typeof prefsPut>[2]) => mutate((e) => e.put(prefsPut(recs, 'calendar', next)));
  const setRem = (next: Parameters<typeof prefsPut>[2]) => mutate((e) => e.put(prefsPut(recs, 'reminders', next)));
  const shown = new Set(cal.visible.map((c) => c.id));
  const shownShared = new Set(cal.visibleShared.map((c) => c.id));
  const shownSubs = new Set(cal.visibleSubs.map((c) => c.id));
  const ro = <View style={[s.tag, { borderColor: T.gold }]}><Text style={s.tagText}>Read-only</Text></View>;
  return (
    <>
      <SidebarTitle title="CalMind" colors={colors} />
      <Field
        testID="wide-search"
        accessibilityLabel="Search"
        value={query}
        onChangeText={setQuery}
        onKeyPress={(e) => { if ((e.nativeEvent as { key?: string }).key === 'Escape') setQuery(''); }}
        placeholder="Search reminders, events, notes"
        style={s.search}
      />
      {SECTIONS.map(({ key, label }) => (
        <SidebarItem key={key} testID={`tab-${key}`} label={label} count={count(key)} active={tab === key && query.trim() === ''}
          onPress={() => onTab(key)} colors={colors} />
      ))}

      <SidebarLabel label="Calendars" colors={colors} />
      {cal.calendars.map((c) => {
        const on = shown.has(c.id);
        return (
          <SidebarItem key={c.id} testID={`side-cal-${c.payload.name}`} label={c.payload.name} colors={colors}
            leading={<Swatch color={c.payload.color} on={on} />}
            onPress={() => setCal({ hidden: on ? [...cal.hidden, c.id] : cal.hidden.filter((id) => id !== c.id), lastView: 'all' })} />
        );
      })}
      {cal.sharedCals.map((c) => {
        const on = shownShared.has(c.id);
        return (
          <SidebarItem key={c.id} testID={`side-cal-${c.payload.name}`} label={`${sharedPartnerLabel ?? ''} · ${c.payload.name}`} colors={colors}
            leading={<Swatch color={c.payload.color} on={on} />}
            onPress={() => setCal({ hiddenShared: on ? [...cal.hiddenShared, c.id] : cal.hiddenShared.filter((id) => id !== c.id) })} />
        );
      })}
      {cal.subs.map((c) => {
        const on = shownSubs.has(c.id);
        return (
          <SidebarItem key={c.id} testID={`side-cal-${c.payload.name}`} label={c.payload.name} colors={colors} trailing={ro}
            leading={<Swatch color={c.payload.color} on={on} />}
            onPress={() => setCal({ hiddenSubs: on ? [...cal.hiddenSubs, c.id] : cal.hiddenSubs.filter((id) => id !== c.id) })} />
        );
      })}

      <SidebarLabel label="Reminder lists" colors={colors} />
      <SidebarItem testID="side-list-all" label="All lists" colors={colors} active={tab === 'reminders' && rem.view === 'all' && query.trim() === ''}
        onPress={() => { setRem({ lastView: 'all', hidden: [], hiddenShared: [] }); onTab('reminders'); }} />
      {rem.folders.map((f) => (
        <SidebarItem key={f.id} testID={`side-list-${f.payload.name}`} label={f.payload.name} colors={colors}
          count={openReminders.filter((r) => r.payload.folderId === f.id).length}
          active={tab === 'reminders' && rem.view === f.id && query.trim() === ''}
          leading={<Swatch color={f.payload.color} on />}
          onPress={() => {
            // The folder picker's own write: this folder alone, on Reminders.
            setRem({ lastView: f.id, hidden: rem.folders.filter((x) => x.id !== f.id).map((x) => x.id), hiddenShared: rem.sharedFolders.map((x) => x.id) });
            onTab('reminders');
          }} />
      ))}
    </>
  );
}

/**
 * The Add tab, as a field: the same line, parsed and filed by the same
 * function (addline.ts), with the kind a click away.
 */
function QuickAdd({ tab, onNoteCreated }: { tab: Section; onNoteCreated: (id: string) => void }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const [picked, setPicked] = useState<AddKind | null>(null);
  const kind: AddKind = picked ?? (tab === 'reminders' ? 'reminder' : tab === 'notes' ? 'note' : 'event');
  const { file } = useAddLine(kind);
  const submit = () => {
    const res = file({ kind, text, date0: tab === 'calendar' ? calSelectedDay() : null });
    if (!res.ok) { if (res.err) setErr(res.err); return; }
    setText('');
    setErr('');
    toast(`Added ${kind}`);
    if (res.noteId) onNoteCreated(res.noteId);
  };
  return (
    <View style={s.addBar}>
      <View style={s.addRow}>
        <Field
          testID="quick-add"
          accessibilityLabel="Quick add"
          value={text}
          onChangeText={(v) => { setText(v); setErr(''); }}
          onSubmitEditing={submit}
          placeholder="Add a reminder or event, like “dentist thu 2pm”"
          style={s.addField}
        />
        {(['event', 'reminder', 'note'] as AddKind[]).map((k) => (
          <Pill key={k} testID={`quick-kind-${k}`} compact label={k[0]!.toUpperCase() + k.slice(1)} primary={kind === k} onPress={() => setPicked(k)} />
        ))}
        <Pill testID="quick-add-go" compact label="Add" onPress={submit} />
      </View>
      {err !== '' && <Text style={s.err}>{err}</Text>}
    </View>
  );
}

const s = themed(() => StyleSheet.create({
  main: { flex: 1, minHeight: 0 },
  screen: { flex: 1, minHeight: 0 },
  hidden: { display: 'none' },
  results: { flex: 1, minHeight: 0, paddingHorizontal: 16 },
  resultsHead: { color: T.text, fontSize: 18, fontWeight: '700', paddingVertical: 12 },
  addBar: { paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: T.line, gap: 4 },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  addField: { flexGrow: 1, flexShrink: 1, flexBasis: 280, minWidth: 200, maxWidth: 560, paddingVertical: 8, fontSize: 14, backgroundColor: T.bg },
  err: { color: T.danger, fontSize: 12 },
  search: { fontSize: 14, paddingVertical: 7, marginBottom: 8, backgroundColor: T.bg },
  swatch: { width: 12, height: 12, borderRadius: 3, borderWidth: 2 },
  tag: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 6, paddingVertical: 1 },
  tagText: { color: T.dim, fontSize: 11 },
}));
