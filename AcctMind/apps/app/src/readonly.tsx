/**
 * Read-only mode, for every width.
 *
 * ONE flag (core's `ledgerAccess`, read through `useLedgerAccess`) reaches the
 * screens by context so a control that edits can simply not be drawn. The
 * banner is built once by App and handed down the same way, so each screen can
 * put it where its own layout wants it (under the phone's top bar, at the top
 * of the wide main pane).
 */
import { createContext, useContext, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { readOnlyMessage, type SyncInfo } from '@acctmind/core';
import { SPACE, T } from './theme';

export type ReadOnlyValue = { readOnly: boolean; banner: ReactNode };
export const ReadOnlyContext = createContext<ReadOnlyValue>({ readOnly: false, banner: null });
export const useReadOnly = (): ReadOnlyValue => useContext(ReadOnlyContext);

export function ReadOnlyBanner({ info, onReload, onSignIn }: {
  info: SyncInfo; onReload: () => void; onSignIn: () => void;
}) {
  const signedOut = info.source === 'copy' && !info.signedIn;
  return (
    <View style={styles.bar} testID="readonly-banner" accessibilityRole="alert">
      <Text style={styles.text}>
        <Text style={styles.lead}>Read-only</Text>
        {' · '}
        {readOnlyMessage(info, Date.now())}
      </Text>
      <Pressable
        onPress={signedOut ? onSignIn : onReload}
        style={styles.btn}
        accessibilityRole="button"
        testID={signedOut ? 'readonly-signin' : 'readonly-reload'}
      >
        <Text style={styles.btnText}>{signedOut ? 'Sign in' : 'Reload'}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row', alignItems: 'center', gap: SPACE.md, flexWrap: 'wrap',
    paddingHorizontal: SPACE.lg, paddingVertical: SPACE.sm,
    backgroundColor: 'rgba(240,180,41,0.16)',
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(240,180,41,0.5)',
  },
  text: { flex: 1, flexBasis: 240, color: '#f6dc9a', fontSize: 13, lineHeight: 18 },
  lead: { fontWeight: '700', color: T.gold },
  btn: {
    paddingHorizontal: SPACE.md, paddingVertical: 6, borderRadius: 6,
    borderWidth: 1, borderColor: T.gold, minHeight: 30, justifyContent: 'center',
  },
  btnText: { color: T.gold, fontSize: 13, fontWeight: '600' },
});
