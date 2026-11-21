import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { canSaveCategoryRule, DESC_MAX, type Category, type CategoryChoice, type CategoryRule } from '@acctmind/core';
import { CategoryPick } from './CategoryPick';
import { SPACE, T, TAP } from './theme';

export function AutoCategorize({ categories, lines, rules, onSave, onRemove, onClose }: {
  categories: readonly Category[];
  lines: readonly CategoryChoice[];
  rules: readonly CategoryRule[];
  onSave: (match: string, category: string) => void;
  onRemove: (match: string) => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [match, setMatch] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const target = lines.find((line) => line.id === category)?.id ?? null;
  const ready = canSaveCategoryRule(match, target);

  return (
    <Modal animationType="slide" onRequestClose={onClose}>
      <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <View style={styles.header}>
          <Text accessibilityRole="header" style={styles.title}>Auto-categorize</Text>
          <Pressable accessibilityRole="button" onPress={onClose} style={styles.button} testID="auto-category-done">
            <Text style={styles.action}>Done</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <View style={styles.fields}>
            <View style={styles.field}>
              <Text style={styles.label}>Transaction contains</Text>
              <TextInput
                accessibilityLabel="Transaction contains"
                value={match}
                onChangeText={setMatch}
                placeholder="Name or description"
                placeholderTextColor={T.faint}
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={DESC_MAX}
                style={styles.input}
                testID="auto-category-match"
              />
            </View>
            <View style={styles.field}>
              <Text style={styles.label}>Assign to</Text>
              <CategoryPick categories={categories} lines={lines} value={target} onPick={setCategory} allowNone={false} />
            </View>
          </View>
          <Pressable
            accessibilityRole="button"
            disabled={!ready}
            style={[styles.button, styles.save]}
            onPress={() => {
              if (target === null) return;
              onSave(match, target);
              setMatch('');
              setCategory(null);
            }}
            testID="auto-category-save"
          >
            <Text style={ready ? styles.action : styles.inactive}>Save rule</Text>
          </Pressable>
          {rules.map((rule) => {
            const line = lines.find((entry) => entry.id === rule.category);
            const group = categories.find((entry) => entry.id === line?.category);
            return (
              <View key={rule.match} style={styles.rule}>
                <View style={styles.field}>
                  <Text style={styles.ruleName}>{rule.match}</Text>
                  <Text style={styles.label}>{group ? `${group.name} / ${line?.name}` : line?.name}</Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Remove rule for ${rule.match}`}
                  onPress={() => onRemove(rule.match)}
                  style={styles.button}
                >
                  <Text style={styles.remove}>Remove</Text>
                </Pressable>
              </View>
            );
          })}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: T.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: T.cardEdge,
    paddingHorizontal: SPACE.md,
  },
  title: { color: T.text, fontSize: 20, fontWeight: '700' },
  body: { padding: SPACE.md },
  fields: { flexDirection: 'row', alignItems: 'flex-end', gap: SPACE.sm },
  field: { flex: 1, minWidth: 0 },
  label: { color: T.dim, fontSize: 13, marginBottom: SPACE.xs },
  input: {
    minHeight: TAP, backgroundColor: T.card, borderRadius: 10, paddingHorizontal: SPACE.sm,
    color: T.text, fontSize: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: T.cardEdge,
  },
  button: { minHeight: TAP, paddingHorizontal: SPACE.sm, justifyContent: 'center' },
  save: { alignSelf: 'flex-end' },
  action: { color: T.accent, fontSize: 16, fontWeight: '600' },
  inactive: { color: T.faint, fontSize: 16, fontWeight: '600' },
  rule: {
    flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, paddingVertical: SPACE.sm,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: T.cardEdge,
  },
  ruleName: { color: T.text, fontSize: 16 },
  remove: { color: T.danger, fontSize: 14 },
});
