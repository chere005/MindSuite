/**
 * The wide Reports pane: the read-only banner when there is one, a title, and
 * the same `ReportsBody` the phone draws, capped at a reading width and
 * left-aligned like the Budget table so a 2000 px window does not stretch a
 * bar chart edge to edge. Read-only by construction: it is handed the store
 * and nothing that writes.
 */
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Store } from '@acctmind/core';
import { ReportsBody } from '../ReportsScreen';
import { T } from '../theme';

/** Wide enough for the ring beside the list; past it, empty space is better than long bars. */
const PANE_MAX = 1040;

export function WideReports({ store, banner }: { store: Store; banner: React.ReactNode }) {
  return (
    <View style={styles.fill} testID="wide-reports">
      {banner}
      <View style={styles.head}>
        <Text style={styles.h1} testID="wide-title">Reports</Text>
      </View>
      <ScrollView style={styles.fill} contentContainerStyle={styles.scroll}>
        <View style={styles.cap}>
          <ReportsBody store={store} wide />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, minHeight: 0 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 10 },
  h1: { color: T.text, fontSize: 20, fontWeight: '600' },
  scroll: { paddingHorizontal: 16, paddingBottom: 32 },
  cap: { width: '100%', maxWidth: PANE_MAX },
});
