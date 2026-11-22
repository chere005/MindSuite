/** Shared app chrome, with the ledger's local/iCloud settings kept app-owned. */
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { addDays, monthLabel } from '@acctmind/core';
import { CogIcon } from './Icons';
import * as shared from './icloudfile';
import { SPACE, T, TAP } from './theme';
import { ACCOUNT_RING, topBarColors } from './TopBar';
import { AccountMenu, type AccountMenuItem } from './components/SuiteTopBar';
import { suiteAccount, openSuiteAccount, signOutSuiteAccount } from './suiteaccount';

const shortDay = (day: string): string =>
  `${monthLabel(day).slice(0, 3)} ${Number(day.slice(8, 10))}, ${day.slice(0, 4)}`;

export function AppMenu({ readOnly = false, openSignal = 0, onImport, onExport, wide = false, whole, onWhole, start, onStart, offer }: {
  /** A read-only ledger: no import, no rules, no budget start. */
  readOnly?: boolean;
  /** Bumped when Sign in from the read-only badge opens the account menu. */
  openSignal?: number;
  onImport?: (() => void) | undefined;
  onExport: () => void;
  /** The wide sidebar already lists Import and Export, so the menu drawn over it does not repeat them. */
  wide?: boolean;
  whole: boolean;
  onWhole: (next: boolean) => void;
  start: string | null;
  onStart: (next: string | null) => void;
  offer: string;
}) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState(false);
  const [account] = useState(suiteAccount);
  // Opens only when the signal CHANGES, never on mount: the menu is rebuilt
  // with each tab, and a remount must not reopen it.
  const handled = useRef(openSignal);
  useEffect(() => {
    if (openSignal === handled.current) return;
    handled.current = openSignal;
    setOptions(true);
    setOpen(true);
  }, [openSignal]);
  const [syncNote, setSyncNote] = useState('iCloud: checking…');
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const ask = () => { void shared.status().then((s) => { if (alive) setSyncNote(`iCloud: ${s}`); }); };
    ask();
    const off = shared.onRemoteChange(ask);
    return () => { alive = false; off(); };
  }, [open]);
  const ledgerOptions = !account || options;
  const items: AccountMenuItem[] = ledgerOptions ? [
    ...(wide ? [] : [
    ...(onImport ? [{ key: 'import', label: 'Import from CSV', testID: 'menu-import', onPress: onImport }] : []),
    { key: 'export', label: 'Export budget', testID: 'menu-export', onPress: onExport },
    ]),
  ] : [
    { key: 'account', label: 'Account', testID: 'menu-account', onPress: () => openSuiteAccount(account) },
    { key: 'settings', label: 'Settings', testID: 'menu-settings', keepOpen: true, onPress: () => setOptions(true) },
    { key: 'signout', label: 'Sign out', testID: 'menu-signout', onPress: () => signOutSuiteAccount(account) },
  ];
  // Apple ID, in a browser only: an app-styled row that forwards the press to
  // CloudKit JS's own (hidden) control, so the popup opens from this click.
  const apple = shared.appleIdState();
  const ck: AccountMenuItem[] = apple === null ? [] : apple === 'signed-in'
    ? [{ key: 'ck-out', label: 'Sign out of Apple ID', testID: 'menu-ck-sign-out', onPress: () => { shared.startSignOut(); } }]
    : [{ key: 'ck-in', label: 'Sign in with Apple ID', testID: 'menu-ck-sign-in', onPress: () => { shared.startSignIn(); } }];
  const allItems = [...items, ...ck];
  return <AccountMenu colors={topBarColors} username={account?.username}
    label={account ? `${account.username} — account menu` : 'Settings'}
    statusColor={account ? ACCOUNT_RING : undefined} trigger={account ? undefined : <CogIcon />}
    testID="app-menu-button" backdropTestID="app-menu-backdrop" open={open}
    onOpenChange={(next) => { if (next) setOptions(false); setOpen(next); }} items={allItems}
    content={ledgerOptions ? <>
              {/*
                A SETTING, not an action, so it keeps the menu OPEN and shows
                its state in a box. The two above leave for somewhere else
                and closing behind them is right; flipping a toggle and
                having the menu vanish makes you reopen it to see whether it
                took.
              */}
              {/*
                BUDGET START — the owner, 2026-09-25: "an option under the options
                drop down for Starting Month", then "i basically started on
                i think 9/21 after doing a reconcile". A DAY, for that second
                sentence; nothing dated before it counts against a line.

                A setting like the box below, so it keeps the menu open. Unset,
                it offers the latest reconcile — where his budget began — and
                set, it steps a day at a time and × clears.
              */}
              {!readOnly && <View style={styles.startWrap} testID="menu-start">
                <View style={styles.startHead}>
                  <Text style={styles.rowText}>Budget starts</Text>
                  {start !== null && (
                    <Pressable
                      onPress={() => onStart(null)}
                      style={styles.startBtn}
                      accessibilityRole="button"
                      accessibilityLabel="Clear the starting month"
                      testID="menu-start-clear"
                    >
                      <Text style={styles.startArrow}>×</Text>
                    </Pressable>
                  )}
                </View>
                {start === null ? (
                  <Pressable
                    onPress={() => onStart(offer)}
                    style={styles.startSet}
                    accessibilityRole="button"
                    accessibilityLabel={`Start the budget on ${shortDay(offer)}`}
                    testID="menu-start-set"
                  >
                    <Text style={styles.startNone}>Not set — use {shortDay(offer)}</Text>
                  </Pressable>
                ) : (
                  <View style={styles.startSteps}>
                    <Pressable
                      onPress={() => onStart(addDays(start, -1))}
                      style={styles.startBtn}
                      accessibilityRole="button"
                      accessibilityLabel="Start a day earlier"
                      testID="menu-start-prev"
                    >
                      <Text style={styles.startArrow}>‹</Text>
                    </Pressable>
                    <Text style={styles.startMonth} testID="menu-start-day">{shortDay(start)}</Text>
                    <Pressable
                      onPress={() => onStart(addDays(start, 1))}
                      style={styles.startBtn}
                      accessibilityRole="button"
                      accessibilityLabel="Start a day later"
                      testID="menu-start-next"
                    >
                      <Text style={styles.startArrow}>›</Text>
                    </Pressable>
                  </View>
                )}
              </View>}
              <Pressable
                style={[styles.row, styles.last]}
                onPress={() => onWhole(!whole)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: whole }}
                accessibilityLabel="Enter whole dollars"
                testID="menu-whole"
              >
                <Text style={styles.rowText}>Whole dollars</Text>
                <View style={[styles.box, whole && styles.boxOn]} testID="menu-whole-box">
                  {whole && <Text style={styles.boxTick}>✓</Text>}
                </View>
              </Pressable>

              {/*
                WHETHER SYNC IS WORKING, in a sentence, at the foot.
                
                Not a control — the only row here that does nothing when
                pressed — and it earns the exception. The peer link reports
                itself on the Devices screen and iCloud's megabyte gets a
                banner; the shared file had nothing at all, so "it is not
                syncing" and "it is syncing and there was nothing to send"
                looked exactly alike. On 2026-09-22 that cost an hour with
                1,948 transactions sitting on one Mac.
                
                THE COG, not Devices, because Devices is not there on every
                surface: it is drawn only when the peer module exists, so
                the Tauri Mac app — the surface this transport was built
                for — has no such screen at all.
              */}
              <View style={styles.note} testID="menu-sync">
                <Text style={styles.noteText}>{syncNote}</Text>
              </View>

    </> : null} />;
}

const styles = StyleSheet.create({
  // The one row that is not a control: no tap target, no 44, and dimmer
  // than the rows above it so the eye reads it as a statement.
  note: {
    paddingHorizontal: SPACE.md, paddingTop: SPACE.sm, paddingBottom: SPACE.md,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: T.cardEdge,
  },
  noteText: { color: T.faint, fontSize: 11, lineHeight: 15 },
  row: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    minHeight: TAP, paddingHorizontal: SPACE.md, gap: SPACE.sm,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: T.cardEdge,
  },
  last: { borderBottomWidth: 0 },
  startWrap: {
    paddingLeft: SPACE.md,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: T.cardEdge,
  },
  startHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: TAP },
  startSteps: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  startSet: { minHeight: TAP, justifyContent: 'center', paddingRight: SPACE.md },
  startNone: { color: T.dim, fontSize: 14 },
  startBtn: { width: TAP, height: TAP, alignItems: 'center', justifyContent: 'center' },
  startArrow: { color: T.text, fontSize: 20 },
  startMonth: { color: T.text, fontSize: 16, fontVariant: ['tabular-nums'] },
  rowText: { color: T.text, fontSize: 14, fontWeight: '600', flexShrink: 1 },
  // The ledger's own checkbox, at the same 15 points — see the cleared box
  // on a transaction row. One shape for "this is on" across the app.
  box: {
    width: 15, height: 15, borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth, borderColor: T.dim,
    alignItems: 'center', justifyContent: 'center',
  },
  boxOn: { backgroundColor: T.accent, borderColor: T.accent },
  boxTick: { color: '#ffffff', fontSize: 10, lineHeight: 12 },
});
