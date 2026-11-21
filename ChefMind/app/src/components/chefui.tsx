/**
 * Small pieces the ChefMind flows share: the tick box, the calm "you have it"
 * green, and the phone sheet that wraps a pane-ready component.
 *
 * PANE-READY means a component renders INLINE and owns no Modal: ShoppingReview,
 * DoneShopping, PantryItem and CookView are all plain views that take their
 * data and callbacks as props. `PhoneSheet` is the phone's wrapper — the same
 * card-over-backdrop pattern ShareModal and the scan sheet use — and a desktop
 * pane mounts the component without it.
 */
import { type ReactNode } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { themed, T, THEMES_LIGHT, currentTheme } from '../theme';
import { WebHitSlop } from '../ui';

/** A calm success green that reads on both the dark and the light page. Not
 *  the theme accent: on Sage & Cream that is brown, which says "warning". */
export const okColor = (): string => (THEMES_LIGHT.includes(currentTheme()) ? '#2f7d4f' : '#5fcf9c');

export function TickBox({ on, onPress, label, testID, round = false }: {
  on: boolean; onPress: () => void; label: string; testID?: string; round?: boolean;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: on }}
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={8}
      style={s.boxWrap}
    >
      <WebHitSlop slop={8} />
      <View style={[s.box, round && s.boxRound, on && s.boxOn]}>
        {on && <Text style={s.tick}>✓</Text>}
      </View>
    </Pressable>
  );
}

/** The phone's wrapper: a centred card over a dimmed page, or (`full`) the
 *  whole screen. Tapping the backdrop closes a card; a full screen has its
 *  own Close. */
export function PhoneSheet({ onClose, full = false, children }: { onClose: () => void; full?: boolean; children: ReactNode }) {
  const insets = useSafeAreaInsets();
  if (full) {
    return (
      <Modal animationType="slide" onRequestClose={onClose}>
        <View style={[s.fullPage, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>{children}</View>
      </Modal>
    );
  }
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={s.backdrop} onPress={onClose}>
        <Pressable style={s.card} onPress={() => {}}>{children}</Pressable>
      </Pressable>
    </Modal>
  );
}

export const s = themed(() => StyleSheet.create({
  boxWrap: { paddingRight: 10, paddingLeft: 2 },
  box: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: T.muted, alignItems: 'center', justifyContent: 'center' },
  boxRound: { borderRadius: 11 },
  boxOn: { backgroundColor: T.accent, borderColor: T.accent },
  tick: { color: T.accentInk, fontSize: 13, fontWeight: '700', lineHeight: 15 },
  backdrop: { flex: 1, backgroundColor: '#000a', alignItems: 'center', justifyContent: 'center', padding: 14 },
  card: { width: '100%', maxWidth: 480, maxHeight: '92%', backgroundColor: T.surface, borderWidth: 1, borderColor: T.line, borderRadius: 16, overflow: 'hidden' },
  fullPage: { flex: 1, backgroundColor: T.bg },
}));
