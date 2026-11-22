/** App actions in the suite's shared top-bar presentation. */
import React, { useEffect, useState } from 'react';
import * as Clipboard from 'expo-clipboard';
import { logout, sharedAccount } from './api';
import { signInFacts } from './appsignin';
import { openAccountPage } from './appsignin-browser';
import { AccountMenu, TopBarFrame, TopBarIconButton, type AccountMenuItem } from './components/SuiteTopBar';
import { useStore } from './store';
import { T } from './theme';
import { DrawnGlyph } from './ui';
import { Settings } from './screens/Settings';
import { syncLook } from './components/SyncDot';
import { useToast } from './components/Toast';
import { useNav } from './nav';
import { useWide } from './components/WideFrame';

export function TopBar({ title, controls, picker, copyMarkdown, showCompleted, onToggleCompleted }: {
  title: string;
  controls?: React.ReactNode;
  /** The folder pie: the 32px ring left of the username, as CalMind's. */
  picker?: React.ReactNode;
  copyMarkdown?: () => string;
  showCompleted?: boolean;
  onToggleCompleted?: () => void;
}) {
  const nav = useNav();
  const { wide } = useWide();
  const { session, signOut, undoLastDelete, syncState, persistFailed, refusedLabels, refusedWhy, sharedTrouble } = useStore();
  const [sharedSeen, setSharedSeen] = useState(false);
  const shared = sharedSeen || sharedAccount(session?.token) || session?.suite === true;
  useEffect(() => {
    if (shared || !session) return;
    let live = true;
    void signInFacts(session.serverUrl).then((f) => { if (live && f.kind === 'answer' && f.shared) setSharedSeen(true); });
    return () => { live = false; };
  }, [session?.serverUrl, shared]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const toast = useToast();
  const look = syncLook(syncState, persistFailed, refusedLabels, refusedWhy, sharedTrouble);
  const colors = { background: T.bg, surface: T.surface, line: T.line, text: T.text, dim: T.dim, accent: T.accent };
  const items: AccountMenuItem[] = [
    ...(shared ? [{ key: 'account', label: 'Account', testID: 'menu-account', onPress: () => {
      if (session) void openAccountPage(session.serverUrl).catch((e: unknown) => toast(e instanceof Error ? e.message : 'Could not open the account page.'));
    } }] : []),
    { key: 'settings', label: 'Settings', onPress: () => setSettingsOpen(true) },
    { key: 'search', label: 'Search', testID: 'menu-search', onPress: nav.openSearch },
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
      left={wide ? undefined : <TopBarIconButton colors={colors} label="Back" testID="nav-back" onPress={nav.goBack}><DrawnGlyph glyph="‹" size={17.6} color={T.dim} /></TopBarIconButton>}
      controls={controls} picker={picker}
      account={<AccountMenu colors={colors} username={session?.username} statusColor={look.color} statusLabel={look.text}
        label={`${session?.username ?? ''} — account menu. ${look.text}`}
        items={items} />}
    />
    {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
  </>;
}
