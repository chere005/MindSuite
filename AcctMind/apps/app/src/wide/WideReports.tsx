/**
 * The wide Reports pane uses the same `ReportsBody` the phone draws,
 * capped at a reading width and centred in the pane like the Budget table so
 * a 2000 px window does not stretch a bar chart edge to edge. Read-only by
 * construction: it is handed the store and nothing that writes.
 */
import { ScrollView, StyleSheet, View } from 'react-native';
import type { Store } from '@acctmind/core';
import { CHART_MAX, ReportsBody } from '../ReportsScreen';

/**
 * The column is exactly as wide as what it holds: everything in ReportsBody
 * stops at CHART_MAX, so a wider column would centre an invisible box and
 * leave the visible reports off-centre. Wide enough for the ring beside the
 * list (ReportsBody's `beside` needs 720); past it, empty space beats long bars.
 */
const PANE_MAX = CHART_MAX;

export function WideReports({ store }: { store: Store }) {
  return (
    <View style={styles.fill} testID="wide-reports">
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
  scroll: { paddingHorizontal: 16, paddingBottom: 32 },
  cap: { width: '100%', maxWidth: PANE_MAX, alignSelf: 'center' },
});
