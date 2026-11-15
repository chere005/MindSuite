/** Suite presentation only: apps supply their identity, colors and actions. */
import React, { useEffect, useRef, useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export type TopBarColors = {
  background: string; surface: string; line: string; text: string; dim: string; accent: string; backdrop?: string;
};
export type AccountMenuItem = {
  key: string; label: string; onPress: () => void | Promise<void>; testID?: string;
  content?: React.ReactNode; leading?: React.ReactNode; trailing?: React.ReactNode; checked?: boolean; disabled?: boolean; keepOpen?: boolean;
};
export const TOP_BAR_HEIGHT = 64;
export const TOP_BAR_TARGET = 44;
export const TOP_BAR_FACE = 32;

export function TopBarFrame({ title, titleTestID, left, controls, picker, account, colors }: {
  title: string; titleTestID?: string; left?: React.ReactNode; controls?: React.ReactNode;
  picker?: React.ReactNode; account?: React.ReactNode; colors: TopBarColors;
}) {
  return <>
    <View testID="suite-topbar" style={[s.bar, { backgroundColor: colors.background }]}>
      {left}
      <Text testID={titleTestID} style={[s.title, { color: colors.text }]} numberOfLines={1}>{title}</Text>
      <View style={s.controls}>
        {controls}
        {picker && <View style={s.target}><View pointerEvents="none" style={[s.ring, s.pickerRing, { backgroundColor: colors.surface, borderColor: colors.line }]} />{picker}</View>}
        {account}
      </View>
    </View>
    <View testID="top-rule" style={[s.rule, { backgroundColor: colors.line }]} />
  </>;
}

/** A real 44px target on web and native around the common 32px face. */
export function TopBarIconButton({ colors, label, onPress, testID, children, active = false }: {
  colors: TopBarColors; label: string; onPress: () => void; testID?: string; children: React.ReactNode; active?: boolean;
}) {
  return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
    style={({ pressed }) => [s.target, pressed && s.pressed]}>
    <View style={[s.ring, { backgroundColor: colors.surface, borderColor: active ? colors.accent : colors.line }]}>{children}</View>
  </Pressable>;
}

type Anchor = { x: number; y: number; w: number; h: number };
type Measurable = { measureInWindow?: (cb: (x: number, y: number, w: number, h: number) => void) => void; focus?: () => void };

export function AccountMenu({ colors, username, label, statusColor, statusLabel, badge, trigger, items,
  testID = 'topbar-sync', backdropTestID, open: controlledOpen, onOpenChange, content }: {
  colors: TopBarColors; username?: string; label?: string; statusColor?: string; statusLabel?: string;
  badge?: React.ReactNode; trigger?: React.ReactNode; items: AccountMenuItem[]; testID?: string; backdropTestID?: string;
  open?: boolean; onOpenChange?: (open: boolean) => void;
  content?: React.ReactNode | ((close: () => void) => React.ReactNode);
}) {
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const triggerRef = useRef<View>(null);
  const menuRef = useRef<View>(null);
  const [ownOpen, setOwnOpen] = useState(false);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [menuHeight, setMenuHeight] = useState(0);
  const initialFocus = useRef<'first' | 'last'>('first');
  const open = controlledOpen ?? ownOpen;
  const setOpen = (value: boolean) => { setOwnOpen(value); onOpenChange?.(value); };
  const close = (restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus && Platform.OS === 'web') setTimeout(() => (triggerRef.current as unknown as Measurable | null)?.focus?.(), 0);
  };
  const measure = (done?: () => void) => {
    const node = triggerRef.current as unknown as Measurable | null;
    if (node?.measureInWindow) node.measureInWindow((x, y, w, h) => { setAnchor({ x, y, w, h }); done?.(); });
    else { setAnchor(null); done?.(); }
  };
  const openMenu = (focus: 'first' | 'last' = 'first') => { initialFocus.current = focus; measure(() => setOpen(true)); };
  const webTriggerProps = Platform.OS === 'web' ? {
    'aria-haspopup': 'menu' as const,
    'aria-expanded': open,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); openMenu(e.key === 'ArrowUp' ? 'last' : 'first'); }
    },
  } : {};
  // Re-anchor if the viewport changes while the menu is open.
  useEffect(() => { if (open) measure(); }, [open, window.width, window.height]);
  const itemKeys = items.map((item) => item.key).join('|');
  useEffect(() => {
    if (!open || Platform.OS !== 'web' || typeof document === 'undefined') return;
    const root = () => menuRef.current as unknown as HTMLElement | null;
    const visible = (node: HTMLElement) => node.getClientRects().length > 0;
    const rows = () => Array.from(root()?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? []).filter(visible);
    const focusable = () => Array.from(root()?.querySelectorAll<HTMLElement>('[tabindex="0"], button:not(:disabled), input:not(:disabled), select:not(:disabled)') ?? []).filter(visible);
    const timer = setTimeout(() => {
      if (root()?.contains(document.activeElement)) return;
      const choices = rows();
      (choices[initialFocus.current === 'last' ? choices.length - 1 : 0] ?? focusable()[0])?.focus();
    }, 0);
    const keydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        const active = document.activeElement as HTMLElement | null;
        // Embedded settings controls keep their own text, date and selection keys.
        if (active && (active.matches('input, textarea, select') || active.isContentEditable
          || (root()?.contains(active) && !active.closest('[role="menuitem"]')))) return;
        const choices = rows();
        if (!choices.length) return;
        e.preventDefault();
        const index = choices.indexOf(document.activeElement as HTMLElement);
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? choices.length - 1
          : e.key === 'ArrowDown' ? (index + 1) % choices.length : index < 0 ? choices.length - 1 : (index - 1 + choices.length) % choices.length;
        choices[next]?.focus();
      } else if (e.key === 'Tab') {
        const choices = focusable();
        if (!choices.length) { e.preventDefault(); return; }
        const index = choices.indexOf(document.activeElement as HTMLElement);
        if ((e.shiftKey && index <= 0) || (!e.shiftKey && (index < 0 || index === choices.length - 1))) {
          e.preventDefault(); choices[e.shiftKey ? choices.length - 1 : 0]?.focus();
        }
      }
    };
    document.addEventListener('keydown', keydown);
    return () => { clearTimeout(timer); document.removeEventListener('keydown', keydown); };
  }, [open, itemKeys]);
  const edgeLeft = insets.left + 8;
  const edgeRight = window.width - insets.right - 8;
  const width = Math.min(216, Math.max(0, edgeRight - edgeLeft));
  const usernameWidth = window.width <= 420 ? 64 : window.width <= 600 ? 96 : 160;
  const maxHeight = Math.max(0, window.height - insets.top - insets.bottom - 16);
  const contentHeight = Math.max(0, maxHeight - 2);
  const height = Math.min(menuHeight || items.length * 44 + 10, maxHeight);
  const left = Math.max(edgeLeft, Math.min((anchor ? anchor.x + anchor.w : edgeRight) - width, edgeRight - width));
  const top = Math.max(insets.top + 8, Math.min(anchor ? anchor.y + anchor.h + 6 : insets.top + 60, window.height - insets.bottom - 8 - height));
  return <>
    <Pressable ref={triggerRef} testID={testID} accessibilityRole="button" {...webTriggerProps}
      accessibilityLabel={label ?? `${username ?? 'Settings'} — account menu.${statusLabel ? ` ${statusLabel}` : ''}`}
      accessibilityState={{ expanded: open }} onPress={() => openMenu()} style={({ pressed }) => [s.accountTarget, pressed && s.pressed]}>
      <View style={[trigger ? s.ring : s.accountFace, { backgroundColor: colors.surface, borderColor: statusColor ?? colors.line }]}>
        {trigger ?? <><Text numberOfLines={1} style={[s.username, { color: colors.text, maxWidth: usernameWidth }]}>{username}</Text>
          <View style={[s.chevron, { borderColor: colors.dim }]} /></>}
        {badge}
      </View>
    </Pressable>
    {open && <Modal transparent animationType="fade" onRequestClose={() => close()}>
      <View style={[s.backdrop, { backgroundColor: colors.backdrop ?? (Platform.OS === 'web' ? 'transparent' : '#0007') }]}>
        <Pressable testID={backdropTestID} accessibilityRole="button" accessibilityLabel="Close account menu" style={StyleSheet.absoluteFill} onPress={() => close()} />
        <View ref={menuRef} testID="suite-account-menu" accessibilityRole="menu" style={[s.menu, { top, left, width, maxHeight, backgroundColor: colors.surface, borderColor: colors.line }]}
          onLayout={(e) => setMenuHeight(e.nativeEvent.layout.height)}>
          <ScrollView style={{ maxHeight: contentHeight }} contentContainerStyle={s.menuContent} keyboardShouldPersistTaps="handled">
            {items.map((item) => <React.Fragment key={item.key}><Pressable testID={item.testID} disabled={item.disabled}
              accessibilityRole="menuitem"
              accessibilityLabel={item.checked === undefined ? item.label : `${item.label}, ${item.checked ? 'checked' : 'not checked'}`}
              accessibilityState={{ disabled: item.disabled }}
              onPress={() => { if (!item.keepOpen) close(false); void item.onPress(); }}
              style={({ pressed }) => [s.menuRow, item.disabled && s.disabled, pressed && { backgroundColor: colors.background }]}>
              {item.checked !== undefined && <Text style={[s.check, { color: item.checked ? colors.accent : colors.dim }]}>{item.checked ? '☑' : '☐'}</Text>}
              {item.leading}
              <Text style={[s.menuText, { color: colors.text }]}>{item.label}</Text>
              {item.trailing}
            </Pressable>{item.content}</React.Fragment>)}
            {typeof content === 'function' ? content(close) : content}
          </ScrollView>
        </View>
      </View>
    </Modal>}
  </>;
}

const s = StyleSheet.create({
  bar: { height: TOP_BAR_HEIGHT, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { flex: 1, minWidth: 0, fontSize: 24, fontWeight: '800' },
  controls: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 0 },
  target: { width: TOP_BAR_TARGET, height: TOP_BAR_TARGET, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  ring: { width: TOP_BAR_FACE, height: TOP_BAR_FACE, borderRadius: 16, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  pickerRing: { position: 'absolute' },
  rule: { height: StyleSheet.hairlineWidth, marginBottom: 10 },
  accountTarget: { minWidth: 44, height: 44, justifyContent: 'center', alignItems: 'center', flexShrink: 0 },
  accountFace: { minWidth: 32, height: 32, borderRadius: 16, borderWidth: 2, paddingHorizontal: 10, gap: 7, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  username: { fontSize: 14, fontWeight: '600', flexShrink: 1 },
  chevron: { width: 7, height: 7, borderBottomWidth: 1.5, borderRightWidth: 1.5, transform: [{ translateY: -2 }, { rotate: '45deg' }] },
  backdrop: { flex: 1 },
  menu: { position: 'absolute', borderWidth: 1, borderRadius: 12, overflow: 'hidden' },
  menuContent: { padding: 4 },
  menuRow: { minHeight: 44, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, flexDirection: 'row', alignItems: 'center', gap: 8 },
  menuText: { fontSize: 14, fontWeight: '600', flex: 1 },
  check: { fontSize: 17 },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.45 },
});
