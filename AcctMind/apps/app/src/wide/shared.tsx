/** Small pieces the wide screens share. Presentation only. */
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { WideColors } from '../components/WideFrame';
import { T } from '../theme';

/** AcctMind's one (dark) look, mapped onto the shared frame's colors. */
export const WIDE_COLORS: WideColors = {
  background: T.bg, sidebar: T.card, surface: T.card, line: T.cardEdge,
  text: T.text, dim: T.dim, accent: T.accent,
  selected: 'rgba(10,132,255,0.24)', selectedText: T.text,
};

export const SELECTED_ROW = 'rgba(10,132,255,0.2)';

/** A small outlined button. */
export function Btn({ label, onPress, primary, danger, testID, disabled }: {
  label: string; onPress: () => void; primary?: boolean; danger?: boolean; testID?: string; disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress} disabled={disabled} accessibilityRole="button" testID={testID}
      style={[s.btn, primary && s.btnPrimary, danger && s.btnDanger, disabled && { opacity: 0.4 }]}
    >
      <Text style={[s.btnText, primary && s.btnTextPrimary, danger && { color: T.danger }]}>{label}</Text>
    </Pressable>
  );
}

/** The pane's title row with a close button. */
export function PaneHead({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <View style={s.paneHead}>
      <Text style={s.paneTitle} numberOfLines={1}>{title}</Text>
      <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" testID="detail-close" style={s.close}>
        <Text style={s.closeText}>✕</Text>
      </Pressable>
    </View>
  );
}

/** Label over value, for the read-only panes. */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={s.fact}>
      <Text style={s.factLabel}>{label}</Text>
      <Text style={s.factValue}>{children}</Text>
    </View>
  );
}

export const s = StyleSheet.create({
  btn: {
    minHeight: 32, paddingHorizontal: 12, borderRadius: 8, justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth, borderColor: T.faint, backgroundColor: T.bg,
  },
  btnPrimary: { backgroundColor: T.accent, borderColor: T.accent },
  btnDanger: { borderColor: T.danger },
  btnText: { color: T.text, fontSize: 14 },
  btnTextPrimary: { color: '#fff', fontWeight: '600' },
  paneHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 12 },
  paneTitle: { flex: 1, color: T.text, fontSize: 16, fontWeight: '600' },
  close: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  closeText: { color: T.dim, fontSize: 16 },
  fact: { gap: 2 },
  factLabel: { color: T.dim, fontSize: 12 },
  factValue: { color: T.text, fontSize: 15 },
});
