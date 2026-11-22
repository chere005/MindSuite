import { Pressable, StyleSheet, Text, View } from 'react-native';
import { T, TAP } from './theme';
import { TipBubble, useTip } from './Tip';

export function AcceptCategory({ name, category, onPress }: {
  name: string; category: string; onPress: () => void;
}) {
  const tip = useTip();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Accept ${category} for ${name}`}
      onPress={(event) => { event.stopPropagation(); onPress(); }}
      {...tip.hover}
      style={styles.target}
      testID="accept-category"
    >
      <View style={styles.icon}><Text style={styles.tick}>✓</Text></View>
      <TipBubble text="Accept category" shown={tip.shown} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  target: { width: TAP, height: TAP, alignItems: 'center', justifyContent: 'center' },
  icon: {
    width: 22, height: 22, borderRadius: 11, borderWidth: 1, borderColor: T.accent,
    alignItems: 'center', justifyContent: 'center',
  },
  tick: { color: T.accent, fontSize: 14, fontWeight: '700' },
});
