/**
 * The settings window: change password (revokes every other device, keeps this
 * one signed in on the fresh token), then Log out / Done — the suite's layout,
 * one modal. Under the suite's shared sign-in the password and the account are
 * the suite's: one "Manage your account" action opens its account page instead
 * of the password form and Delete account.
 */
import { useEffect, useState } from 'react';
import { Linking, Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { exportFilename, exportStore, exportText, prefsOf, prefsPut, splitNote, type AnyRec, type Rec } from '@calmind/core';
import { changePassword, deleteAccount, logout, manageAccountUrl, sharedAccount } from '../api';
import { saveTextFile } from '../savefile';
import { addPasskey, listPasskeys, passkeyAvailable, removePasskey, type PasskeyRow } from '../passkey';
import { useStore } from '../store';
import { useNav } from '../nav';
import { syncLook } from '../components/SyncDot';
import { CircleBtn, Field, Pill, ErrorLine } from '../ui';
import { applyTheme, currentTheme, themed, T, THEMES, type ThemeName } from '../theme';
import { ShareModal } from '../components/ShareModal';

export function Settings({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const { session, setSession, signOut, clearDeletedAccount, recs, mutate, syncState, persistFailed, refusedLabels, refusedWhy } = store;
  const refusedNotes = (store as typeof store & { refusedNotes?: { id: string; label: string }[] }).refusedNotes ?? [];
  // ChefMind's space, where this app holds it (CalMind syncs it under the same
  // login; ChefMind's own records ARE that space, so it passes none).
  const chefRecs = (store as typeof store & { chefRecs?: AnyRec[] }).chefRecs;
  const nav = useNav();
  const pickTheme = (name: ThemeName) => {
    applyTheme(name);
    // The choice syncs like any pref, so every device follows.
    mutate((e) => e.put(prefsPut(recs, 'suite', { theme: name })));
  };
  // 12- vs 24-hour, on 'suite' beside the theme: it is one person's habit, and
  // it syncs, so the phone, the web, the WATCH and the WIDGET all follow one
  // setting rather than four. The native two cannot read a pref record, so the
  // flag rides along in the watch feed.
  const clock24 = prefsOf(recs, 'suite').clock24 === true;
  const setClock24 = (on: boolean) => mutate((e) => e.put(prefsPut(recs, 'suite', { clock24: on })));
  const look = syncLook(syncState, persistFailed, refusedLabels, refusedWhy);
  // The first refused note, as several that fit (#75) — null when it cannot
  // be split (a recipe, a daily log) or no longer needs it.
  const refusedRec = refusedNotes[0]
    ? (recs.find((r) => r.id === refusedNotes[0].id && r.type === 'note' && !r.deleted) as Rec<'note'> | undefined)
    : undefined;
  const refusedSplit = refusedRec ? splitNote(refusedRec, recs) : null;
  const [oldPass, setOldPass] = useState('');
  const [newPass, setNewPass] = useState('');
  const [canPasskey, setCanPasskey] = useState(false);
  const [keys, setKeys] = useState<PasskeyRow[]>([]);
  // Whether we actually know. A failed fetch used to leave an empty list,
  // which reads as "you have no passkeys" — so you add another one you did
  // not need, and end up with two on a device that only ever wanted one.
  const [keysKnown, setKeysKnown] = useState(false);
  useEffect(() => {
    void passkeyAvailable().then(setCanPasskey);
    void listPasskeys(session!)
      .then((k) => { setKeys(k); setKeysKnown(true); })
      .catch(() => setKeysKnown(false));
  }, [session]);
  const [confirmPass, setConfirmPass] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [shareOpen, setShareOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleteName, setDeleteName] = useState('');
  const [deleting, setDeleting] = useState(false);
  // A cookie session is the suite's; a bearer one learns it from the server's 403 `shared: true` below.
  const [sharedSeen, setSharedSeen] = useState(false);
  const shared = sharedSeen || sharedAccount(session?.token);

  // The suite's account page: same tab on the web (it comes back here by `next`), the system browser elsewhere.
  const openAccount = () => {
    const to = session ? manageAccountUrl(session.serverUrl) : null;
    if (!to) { setErr('could not find the account page'); return; }
    if (to.web && typeof location !== 'undefined') { location.assign(to.url); return; }
    void Linking.openURL(to.url).catch((e: unknown) => setErr(e instanceof Error ? e.message : 'could not open the account page'));
  };

  const change = async () => {
    setErr('');
    setMsg('');
    if (newPass !== confirmPass) {
      setErr("those passwords don't match");
      return;
    }
    try {
      const r = await changePassword(session!, oldPass, newPass);
      await setSession({ ...session!, token: r.token });
      setOldPass('');
      setNewPass('');
      setConfirmPass('');
      setMsg('Password changed — other devices sign in again.');
    } catch (e) {
      if (sharedAccount(undefined, e)) {
        setOldPass('');
        setNewPass('');
        setConfirmPass('');
        setSharedSeen(true);
        return;
      }
      setErr(e instanceof Error ? e.message : 'something went wrong');
    }
  };

  // One export, from two places: the row below, and inside the delete
  // confirmation — the moment someone is about to lose everything is the
  // moment to offer them a copy (App Store 5.1.1(v) asks for deletion; the
  // copy is the courtesy that goes with it, #81). What the file holds is
  // core's; this is only the hand-off to the platform.
  const exportData = () => {
    setErr('');
    const file = exportStore(recs, session?.username ?? 'me', Date.now(),
      chefRecs && chefRecs.length > 0 ? { chef: chefRecs } : {});
    void saveTextFile(exportFilename(file.account, file.exported), exportText(file))
      .then(() => setMsg('Exported.'))
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : 'could not export'));
  };

  const removeAccount = async () => {
    if (!session || deleteName !== session.username || deleting) return;
    setErr('');
    setMsg('');
    setDeleting(true);
    try {
      await deleteAccount(session);
      await clearDeletedAccount();
      onClose();
    } catch (e) {
      setDeleting(false);
      if (sharedAccount(undefined, e)) {
        setDeleteConfirm(false);
        setDeleteName('');
        setSharedSeen(true);
        return;
      }
      setErr(e instanceof Error ? e.message : 'could not delete account');
    }
  };

  // The suite closes settings before the share window opens — one layer.
  if (shareOpen) return <ShareModal onClose={onClose} />;

  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={s.backdrop} onPress={onClose}>
        <Pressable style={s.card} onPress={() => {}}>
          <Text style={s.h2}>Settings</Text>
          {/* Colour AND words from the one rule now. This screen used to
              carry its own copy of the sentence beside a dot that read the
              shared one, so the two could disagree — and did the moment the
              message learned to name the record it is about. The ordering
              (a device that cannot write its own copy comes first) lives in
              syncLook with the rest of it. */}
          <View style={s.statusRow}>
            <View style={[s.statusDot, { backgroundColor: look.color }]} />
            <Text style={s.statusText}>{look.text}</Text>
          </View>
          {refusedNotes[0] && (
            <Pressable
              testID="open-refused-note"
              accessibilityRole="button"
              accessibilityLabel={`Open refused note ${refusedNotes[0].label}`}
              style={s.refusedAction}
              onPress={() => {
                const { id } = refusedNotes[0];
                onClose();
                nav.openNote?.(id);
              }}
            >
              <Text style={s.refusedActionText} numberOfLines={1}>
                Open “{refusedNotes[0].label}” to shorten it
              </Text>
            </Pressable>
          )}
          {refusedRec && refusedSplit && (
            <Pressable
              testID="split-refused-note"
              accessibilityRole="button"
              accessibilityLabel={`Split ${refusedNotes[0].label} into ${refusedSplit.added.length + 1} notes`}
              style={s.refusedAction}
              onPress={() => {
                // Recomputed at the press, from the record as it is NOW.
                const plan = splitNote(refusedRec, recs);
                if (!plan) return;
                mutate((e) => {
                  e.put(plan.keep);
                  for (const r of plan.added) e.put(r);
                });
                setMsg(`Split into ${plan.added.length + 1} notes.`);
              }}
            >
              <Text style={s.refusedActionText} numberOfLines={1}>
                …or split it into {refusedSplit.added.length + 1} notes that fit
              </Text>
            </Pressable>
          )}
          <Text style={s.who}>{session?.username}</Text>
          {shared ? (
            <Pill testID="manage-account" label="Manage your account" onPress={openAccount} />
          ) : (
            <>
              <Field value={oldPass} onChangeText={setOldPass} placeholder="Current password" secureTextEntry />
              <Field value={newPass} onChangeText={setNewPass} placeholder="New password" secureTextEntry />
              <Field value={confirmPass} onChangeText={setConfirmPass} placeholder="Confirm new password" secureTextEntry />
              <Pill label="Change password" onPress={change} />
            </>
          )}
          {canPasskey && (
            <View testID="passkey-section" style={s.pkSection}>
              <Text style={s.pkHead}>Passkeys</Text>
              {!keysKnown && (
                <Text testID="passkey-unknown" style={s.pkNote}>
                  Could not check this account&apos;s passkeys — offline? Adding one now may
                  leave you with a duplicate.
                </Text>
              )}
              {keys.map((k) => (
                <View key={k.id} style={s.pkRow}>
                  <Text style={s.pkLabel} numberOfLines={1}>{k.label}</Text>
                  <Pressable
                    testID="passkey-remove"
                    hitSlop={8}
                    onPress={() => {
                      void removePasskey(session!, k.id)
                        .then(() => setKeys((ks) => ks.filter((x) => x.id !== k.id)))
                        .catch((e: unknown) => setErr(e instanceof Error ? e.message : 'could not remove it'));
                    }}
                  >
                    <Text style={s.pkX}>×</Text>
                  </Pressable>
                </View>
              ))}
              <Pill
                testID="passkey-add"
                label="Add a passkey"
                onPress={() => {
                  setErr('');
                  void addPasskey(session!, `${Platform.OS} passkey`)
                    .then(() => listPasskeys(session!).then(setKeys))
                    .then(() => setMsg('Passkey added'))
                    .catch((e: unknown) => setErr(e instanceof Error ? e.message : 'could not add it'));
                }}
              />
              {/* A passkey is an addition. Saying so where someone might
                  otherwise assume their password just stopped working. */}
              <Text style={s.pkNote}>Your password still works.</Text>
            </View>
          )}
          {msg ? <Text style={s.ok}>{msg}</Text> : null}
          <ErrorLine text={err} />
          <View style={s.themeRow}>
            {(Object.keys(THEMES) as ThemeName[]).map((name) => (
              <Pressable
                key={name}
                testID={`theme-${name}`}
                onPress={() => pickTheme(name)}
                style={[s.swatch, { backgroundColor: THEMES[name].bg }, currentTheme() === name && s.swatchOn]}
              >
                <View style={[s.swatchDot, { backgroundColor: THEMES[name].accent }]} />
              </Pressable>
            ))}
          </View>
          <View style={s.clockRow}>
            <Text style={s.clockLabel}>Time format</Text>
            <View style={s.clockSeg}>
              <Pressable
                testID="clock-12"
                onPress={() => setClock24(false)}
                style={[s.clockOpt, !clock24 && s.clockOptOn]}
              >
                <Text style={[s.clockOptText, !clock24 && s.clockOptTextOn]}>12h</Text>
              </Pressable>
              <Pressable
                testID="clock-24"
                onPress={() => setClock24(true)}
                style={[s.clockOpt, clock24 && s.clockOptOn]}
              >
                <Text style={[s.clockOptText, clock24 && s.clockOptTextOn]}>24h</Text>
              </Pressable>
            </View>
          </View>
          {/* The suite's settings footer, now one round icon button and the
              accent checkmark: Share and Done. The Widget button opened the
              Scriptable setup page, and the Scriptable widget was removed
              entirely on the owner's word (2026-08-12). */}
          <View style={s.footer}>
            <CircleBtn testID="open-share" glyph="⇗" label="Sharing" size={40} onPress={() => setShareOpen(true)} />
            <CircleBtn glyph="✓" label="Done" size={40} color={T.accent} active onPress={onClose} />
          </View>
          <View style={s.row}>
            <Pill testID="export-data" label="Export my data" onPress={exportData} />
          </View>
          <View style={s.row}>
            <Pill
              label="Log out"
              onPress={async () => {
                if (session) void logout(session);
                await signOut();
              }}
            />
          </View>
          {shared ? null : !deleteConfirm ? (
            <View style={s.row}>
              <Pill
                testID="delete-account-start"
                label="Delete account"
                onPress={() => { setErr(''); setDeleteConfirm(true); }}
              />
            </View>
          ) : (
            <View testID="delete-account-confirm" style={s.deleteBox}>
              <Text style={s.deleteTitle}>Delete this account?</Text>
              <Text style={s.deleteCopy}>
                This permanently deletes your account from the server and this device — every synced CalMind and
                ChefMind item and your passkeys — and signs out every device. It cannot be undone.
              </Text>
              <Text style={s.deleteCopy}>Want a copy first? Export it now, then type your username to confirm.</Text>
              <View style={s.row}>
                <Pill testID="delete-account-export" label="Export my data" disabled={deleting} onPress={exportData} />
              </View>
              <Field
                testID="delete-account-username"
                value={deleteName}
                onChangeText={setDeleteName}
                placeholder={session?.username ?? 'Username'}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!deleting}
              />
              <View style={s.deleteActions}>
                <Pill
                  label="Cancel"
                  disabled={deleting}
                  onPress={() => { setDeleteConfirm(false); setDeleteName(''); setErr(''); }}
                />
                <Pill
                  testID="delete-account-confirm-button"
                  label={deleting ? 'Deleting…' : 'Permanently delete'}
                  disabled={deleting || !session || deleteName !== session.username}
                  onPress={() => { void removeAccount(); }}
                />
              </View>
            </View>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}


const s = themed(() => StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: '#000a', alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: T.surface,
    borderWidth: 1,
    borderColor: T.line,
    borderRadius: 16,
    padding: 20,
    gap: 10,
  },
  h2: { color: T.text, fontSize: 18, fontWeight: '700' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 2 },
  statusDot: { width: 9, height: 9, borderRadius: 5 },
  statusText: { color: T.dim, fontSize: 13 },
  refusedAction: { alignSelf: 'flex-start', maxWidth: '100%', paddingVertical: 4 },
  refusedActionText: { color: T.accent, fontSize: 13, fontWeight: '600' },
  who: { color: T.dim, fontSize: 13 },
  themeRow: { flexDirection: 'row', gap: 12, justifyContent: 'center', marginTop: 4 },
  clockRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 14 },
  clockLabel: { color: T.text, fontSize: 14 },
  clockSeg: { flexDirection: 'row', borderWidth: 1, borderColor: T.line, borderRadius: 999, overflow: 'hidden' },
  // paddingVertical 9, not 6: at 6 both segments measured 28pt tall, under the
  // 30 the tap-target sweep calls awkward. Real padding rather than a
  // WebHitSlop, for two reasons that both matter here — clockSeg sets
  // `overflow: 'hidden'`, which would clip an overlay, and these two sit edge
  // to edge, so overlapping slop would make the boundary between 12h and 24h
  // ambiguous in a control whose whole job is to be unambiguous. 9 matches the
  // habit name box; the pill grows 6pt and nothing else moves.
  clockOpt: { paddingHorizontal: 14, paddingVertical: 9, minWidth: 52, alignItems: 'center' },
  clockOptOn: { backgroundColor: T.accentSoft },
  clockOptText: { color: T.dim, fontSize: 13, fontWeight: '600' },
  clockOptTextOn: { color: T.accent },
  pkSection: { gap: 8, marginTop: 6, borderTopWidth: 1, borderTopColor: T.line, paddingTop: 10 },
  deleteBox: { gap: 8, marginTop: 6, borderTopWidth: 1, borderTopColor: T.line, paddingTop: 10 },
  deleteTitle: { color: T.text, fontSize: 14, fontWeight: '700' },
  deleteCopy: { color: T.dim, fontSize: 12, lineHeight: 17 },
  deleteActions: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  pkHead: { color: T.dim, fontSize: 12, textTransform: 'uppercase', letterSpacing: 1 },
  pkRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  pkLabel: { color: T.text, fontSize: 14, flexShrink: 1 },
  pkX: { color: T.dim, fontSize: 20, lineHeight: 22 },
  pkNote: { color: T.muted, fontSize: 12 },
  swatch: { width: 40, height: 40, borderRadius: 20, borderWidth: 1, borderColor: T.line, alignItems: 'center', justifyContent: 'center' },
  swatchOn: { borderWidth: 2, borderColor: T.accent },
  swatchDot: { width: 14, height: 14, borderRadius: 7 },
  ok: { color: T.accent, fontSize: 13 },
  footer: { flexDirection: 'row', justifyContent: 'space-around', marginTop: 10 },
  row: { flexDirection: 'row', justifyContent: 'center', marginTop: 8 },
}));
