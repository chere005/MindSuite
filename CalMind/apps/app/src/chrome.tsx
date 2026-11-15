/** App actions in the suite's shared top-bar presentation. */
import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { logout, sharedAccount } from './api';
import { signInFacts } from './appsignin';
import { openAccountPage } from './appsignin-browser';
import { meetreqBadgeCount } from '@calmind/core';
import { AccountMenu, TopBarFrame, TopBarIconButton, type AccountMenuItem } from './components/SuiteTopBar';
import { useStore } from './store';
import { themed, T } from './theme';
import { DrawnGlyph } from './ui';
import { Settings } from './screens/Settings';
import { Requests } from './screens/Requests';
import { syncLook } from './components/SyncDot';
import { useToast } from './components/Toast';
import { useNav } from './nav';

export function TopBar({ title, controls, picker, copyMarkdown, showCompleted, onToggleCompleted }: {
  title: string;
  controls?: React.ReactNode;
  picker?: React.ReactNode;
  copyMarkdown?: () => string;
  showCompleted?: boolean;
  onToggleCompleted?: () => void;
}) {
  const nav = useNav();
  const { recs, session, signOut, undoLastDelete, syncState, persistFailed, refusedLabels, refusedWhy, sharedTrouble } = useStore();
  const requests = useMemo(() => meetreqBadgeCount(recs), [recs]);
  const [sharedSeen, setSharedSeen] = useState(false);
  const shared = sharedSeen || sharedAccount(session?.token) || session?.suite === true;
  useEffect(() => {
    if (shared || !session) return;
    let live = true;
    void signInFacts(session.serverUrl).then((f) => { if (live && f.kind === 'answer' && f.shared) setSharedSeen(true); });
    return () => { live = false; };
  }, [session?.serverUrl, shared]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [requestsOpen, setRequestsOpen] = useState(false);
  const toast = useToast();
  const look = syncLook(syncState, persistFailed, refusedLabels, refusedWhy, sharedTrouble);
  const colors = { background: T.bg, surface: T.surface, line: T.line, text: T.text, dim: T.dim, accent: T.accent };
  const items: AccountMenuItem[] = [
    ...(shared ? [{ key: 'account', label: 'Account', testID: 'menu-account', onPress: () => {
      if (session) void openAccountPage(session.serverUrl).catch((e: unknown) => toast(e instanceof Error ? e.message : 'Could not open the account page.'));
    } }] : []),
    { key: 'settings', label: 'Settings', onPress: () => setSettingsOpen(true) },
    { key: 'search', label: 'Search', testID: 'menu-search', onPress: nav.openSearch },
    { key: 'requests', label: 'Requests', testID: 'menu-requests', onPress: () => setRequestsOpen(true), trailing: requests > 0 ? <View testID="menu-requests-badge" style={s.menuBadge}><Text style={s.badgeText}>{requests > 99 ? '99+' : requests}</Text></View> : undefined },
    { key: 'undo', label: 'Undo last delete', testID: 'undo-delete', onPress: () => {
      const back = undoLastDelete();
      toast(back === null ? 'Nothing to undo' : `Restored “${back}”`, 2600);
    } },
    ...(copyMarkdown ? [{ key: 'markdown', label: 'Copy as Markdown', testID: 'menu-copymd', onPress: () => {
      void Clipboard.setStringAsync(copyMarkdown()).then(() => toast('Copied as Markdown')).catch(() => toast('Could not copy'));
    } }] : []),
    ...(onToggleCompleted ? [{ key: 'completed', label: 'Show completed', testID: 'menu-completed', checked: !!showCompleted, onPress: onToggleCompleted }] : []),
    { key: 'signout', label: 'Sign out', onPress: async () => { if (session) void logout(session); await signOut(); } },
  ];
  return <>
    <TopBarFrame title={title} colors={colors}
      left={<TopBarIconButton colors={colors} label="Back" testID="nav-back" onPress={nav.goBack}><DrawnGlyph glyph="‹" size={17.6} color={T.dim} /></TopBarIconButton>}
      controls={controls} picker={picker}
      account={<AccountMenu colors={colors} username={session?.username} statusColor={look.color} statusLabel={look.text}
        label={`${session?.username ?? ''} — account menu. ${look.text}` + (requests > 0 ? ` ${requests} new meeting request${requests === 1 ? '' : 's'}.` : '')}
        badge={requests > 0 ? <View testID="who-badge" style={s.badge} pointerEvents="none"><Text style={s.badgeText}>{requests > 99 ? '99+' : requests}</Text></View> : undefined} items={items} />}
    />
    {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
    {requestsOpen && <Requests onClose={() => setRequestsOpen(false)} />}
  </>;
}

const s = themed(() => StyleSheet.create({
  badge: { position: 'absolute', top: -5, right: -6, minWidth: 16, height: 16, borderRadius: 8, paddingHorizontal: 4,
    backgroundColor: T.overdue, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: T.bg },
  badgeText: { color: '#fff', fontSize: 10, fontWeight: '700' },
  menuBadge: { minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5, backgroundColor: T.overdue, alignItems: 'center', justifyContent: 'center' },
}));
