/**
 * The add form's phone modal: a bar with Cancel and Save over the shared
 * fields. The state and every rule live in `useTxnForm` (TransactionForm.tsx),
 * which the wide layout's detail pane renders too.
 */
import {
  KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView,
  StyleSheet, Text, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Category, CategoryChoice, CategoryRule, Draft, AmountMode, Txn } from '@acctmind/core';
import { useTxnForm } from './TransactionForm';
import { SPACE, T, TAP } from './theme';

type Props = {
  visible: boolean;
  onSave: (draft: Draft) => void;
  onCancel: () => void;
  /** The transaction being edited, if this is an edit rather than an add. */
  editing?: Txn | undefined;
  startInSplit?: boolean;
  /** The account a new transaction goes into — the section whose + was pressed. */
  account: string;
  /** The category it starts filed under, when the + that opened this knew one. */
  category?: string | null | undefined;
  categories: readonly Category[];
  lines: readonly CategoryChoice[];
  rules: readonly CategoryRule[];
  mode: AmountMode;
};

export function AddTransaction({
  visible, onSave, onCancel, editing, startInSplit = false, mode, account, category = null, categories, lines, rules,
}: Props) {
  const insets = useSafeAreaInsets();
  const form = useTxnForm({
    active: visible, onSave: (draft) => onSave(draft), editing, startInSplit, mode, account, category, categories, lines, rules,
  });

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onCancel} transparent={false}>
      {/* Its own window: the app's safe area does not reach in here. */}
      <KeyboardAvoidingView
        style={styles.fill}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={[styles.fill, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
          <View style={styles.bar}>
            <Pressable onPress={onCancel} style={styles.barBtn} testID="cancel-button">
              <Text style={styles.barText}>Cancel</Text>
            </Pressable>
            <Text style={styles.barTitle}>
              {editing === undefined ? 'New Transaction' : 'Edit Transaction'}
            </Text>
            <Pressable onPress={form.submit} style={styles.barBtn} testID="save-button">
              <Text style={[styles.barText, styles.barSave]}>Save</Text>
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
            {form.phoneFields}
          </ScrollView>

          {form.dayPicker}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: T.bg },
  bar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACE.sm, borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: T.cardEdge,
  },
  barBtn: { minHeight: TAP, minWidth: 72, justifyContent: 'center', paddingHorizontal: SPACE.sm },
  barText: { color: T.accent, fontSize: 16 },
  barSave: { fontWeight: '700', textAlign: 'right' },
  barTitle: { color: T.text, fontSize: 17, fontWeight: '600' },
  body: { padding: SPACE.lg, gap: SPACE.lg },
});
