/**
 * Read-only mode, for every width.
 *
 * ONE flag (core's `ledgerAccess`, read through `useLedgerAccess`) reaches the
 * screens by context. The badge is rendered beside the app name in each layout.
 */
import { createContext, useContext, useState, type ReactNode } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { readOnlyBanner, type SyncInfo } from '@acctmind/core';
import { SPACE, T, TAP } from './theme';

export type ReadOnlyValue = { readOnly: boolean; badge: ReactNode };
export const ReadOnlyContext = createContext<ReadOnlyValue>({ readOnly: false, badge: null });
export const useReadOnly = (): ReadOnlyValue => useContext(ReadOnlyContext);

export function ReadOnlyBadge({ info, onReload, onSignIn }: {
  info: SyncInfo; onReload: () => void; onSignIn: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const status = readOnlyBanner(info, Date.now());
  const error = status.tone === 'error';
  const signIn = status.action === 'signin';
  return (
    <>
      <Pressable onPress={() => setOpen(true)} style={styles.target} accessibilityRole="button"
        accessibilityLabel="Read-only status" accessibilityState={{ expanded: open }} testID="readonly-badge">
        <Text style={[styles.badge, error && styles.badgeError]}>Read-only</Text>
      </Pressable>
      {open && (
        <Modal transparent animationType="fade" onRequestClose={close}>
          <View style={[styles.overlay, {
            paddingTop: insets.top + SPACE.lg, paddingBottom: insets.bottom + SPACE.lg,
            paddingLeft: insets.left + SPACE.lg, paddingRight: insets.right + SPACE.lg,
          }]}>
            <Pressable style={StyleSheet.absoluteFill} accessibilityLabel="Dismiss read-only status" onPress={close} />
            <View style={styles.panel} testID="readonly-status" accessibilityViewIsModal>
              <Text style={styles.heading} accessibilityRole="header">Read-only</Text>
              <Text style={styles.text} testID="readonly-status-text">{status.text}</Text>
              <View style={styles.actions}>
                <Pressable onPress={close} style={styles.button} accessibilityRole="button" testID="readonly-close">
                  <Text style={styles.text}>Close</Text>
                </Pressable>
                <Pressable onPress={signIn ? () => { close(); onSignIn(); } : onReload} style={styles.button}
                  accessibilityRole="button" testID={signIn ? 'readonly-signin' : 'readonly-reload'}>
                  <Text style={styles.action}>{signIn ? 'Sign in' : 'Reload'}</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  target: { minHeight: TAP, justifyContent: 'center', flexShrink: 0 },
  badge: {
    fontSize: 11, fontWeight: '700', color: T.gold, backgroundColor: 'rgba(240,180,41,0.16)',
    paddingHorizontal: SPACE.sm, paddingVertical: SPACE.xs, borderRadius: 12, overflow: 'hidden',
  },
  badgeError: { color: '#ffb4ae', backgroundColor: 'rgba(255,69,58,0.16)' },
  overlay: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0008' },
  panel: {
    width: '100%', maxWidth: 380, gap: SPACE.md, padding: SPACE.lg, borderRadius: 12,
    backgroundColor: T.card, borderWidth: StyleSheet.hairlineWidth, borderColor: T.cardEdge,
  },
  heading: { color: T.text, fontSize: 18, fontWeight: '700' },
  text: { color: T.text, fontSize: 14, lineHeight: 20 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: SPACE.sm },
  button: { minHeight: TAP, justifyContent: 'center', paddingHorizontal: SPACE.md },
  action: { color: T.accent, fontSize: 14, fontWeight: '600' },
});
