/**
 * Make a shopping list — the review before anything is written.
 *
 * Ingredients minus the pantry used to happen silently. This shows it: what
 * you will buy and which recipe wants it, what the pantry already covers (each
 * with "Buy anyway"), and what folds into a row the list already has. Only the
 * chosen lines are written (`reviewLines` -> `addLinesToShopping`), through the
 * same merge path every other add uses.
 *
 * PANE-READY: renders inline, no Modal. `PhoneSheet` wraps it on the phone.
 */
import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useStore } from '../store';
import { themed, T } from '../theme';
import { Pill, Scroll } from '../ui';
import { useToast } from './Toast';
import { addLinesToShopping, shopMessage, type ShopResult } from '../addToShopping';
import { groupByAisle, mergeNotes, openRows, reviewSummary } from '../chefflows';
import { flipIn, reviewWriteLines, type ReviewSession } from '../session';
import { TickBox } from './chefui';

export type ShoppingReviewProps = {
  /** The open Review: its frozen plan and the choices made so far. The host
   *  owns it (the session), so it survives a layout change. */
  review: ReviewSession;
  onChange: (next: ReviewSession) => void;
  onCancel: () => void;
  /** Called after the lines were written (and the toast shown). The host
   *  decides where to go next — the phone switches to the Shopping tab. */
  onAdded: (result: Extract<ShopResult, { ok: true }>) => void;
  /** Desktop pane: fill the height, with the bar pinned to the foot. */
  fill?: boolean;
};

export function ShoppingReview({ review, onChange, onCancel, onAdded, fill = false }: ShoppingReviewProps) {
  const { recs, mutate } = useStore();
  const toast = useToast();
  const { plan, sources } = review;
  const off = new Set(review.off);
  const anyway = new Set(review.anyway);
  // "Adds to" names only rows still to buy: a row ticked into the cart since
  // this opened is no longer a place a line folds into.
  const open = useMemo(() => new Set(openRows(recs).map((r) => r.payload.text)), [recs]);
  const merges = useMemo(() => mergeNotes(plan), [plan]);
  const groups = useMemo(() => groupByAisle(plan.toBuy), [plan]);
  const sum = reviewSummary(sources);
  const lines = reviewWriteLines(review);
  const flipOff = (i: number) => onChange({ ...review, off: flipIn(review.off, i) });
  const flipAnyway = (i: number) => onChange({ ...review, anyway: flipIn(review.anyway, i) });

  const add = () => {
    if (lines.length === 0) return;
    let result: ShopResult;
    try {
      result = addLinesToShopping(recs, mutate, lines);
    } catch {
      // The write threw: nothing is known to have landed, so say so and stay
      // open — the choices are still here to try again.
      toast('Could not save to the shopping list. Try again.');
      return;
    }
    toast(shopMessage(result, sources.length === 1));
    if (result.ok) onAdded(result);
  };

  return (
    <View style={[s.root, fill && s.rootFill]} testID="review">
      <View style={s.head}>
        <Text style={s.h1}>Make a shopping list</Text>
        <Text testID="review-summary" style={s.sub}>
          {sum.ingredients} {sum.ingredients === 1 ? 'ingredient' : 'ingredients'} from {sum.recipes} {sum.recipes === 1 ? 'recipe' : 'recipes'}
        </Text>
      </View>
      <Scroll style={[s.body, fill && s.bodyFill]} contentContainerStyle={s.bodyIn}>
        <Text style={s.sec}>To buy · {plan.toBuy.length}</Text>
        {plan.toBuy.length === 0 ? (
          <Text style={s.note}>Nothing to buy: the pantry covers all of it.</Text>
        ) : (
          <Text style={s.note}>Untick anything you don't want this time.</Text>
        )}
        {groups.map((g) => (
          <View key={g.aisle}>
            <Text style={s.aisle}>{g.aisle}</Text>
            {g.rows.map(({ row, index }) => {
              const target = merges.get(row.text);
              const into = target !== undefined && open.has(target) ? target : undefined;
              return (
                <View key={index} style={s.row}>
                  <TickBox testID={`review-buy-${index}`} on={!off.has(index)} label={`Buy ${row.text}`} onPress={() => flipOff(index)} />
                  <View style={s.rowText}>
                    <Text style={[s.text, off.has(index) && s.textOff]}>{row.text}</Text>
                    {row.from.length > 0 && <Text style={s.from}>{row.from.join(' · ')}</Text>}
                    {into !== undefined && <Text style={s.merge}>Adds to “{into}”</Text>}
                  </View>
                </View>
              );
            })}
          </View>
        ))}

        <Text style={[s.sec, s.secGap]}>In your pantry · {plan.inPantry.length}</Text>
        {plan.inPantry.length > 0 && <Text style={s.note}>Not added. Buy anyway if you're out.</Text>}
        {plan.inPantry.map((r, i) => (
          <View key={i} style={s.row}>
            <View style={s.rowText}>
              <Text style={s.text}>{r.text}</Text>
              {r.from.length > 0 && <Text style={s.from}>{r.from.join(' · ')}</Text>}
              <Text style={s.match}>Matches “{r.match}”</Text>
            </View>
            <Pill testID={`review-anyway-${i}`} compact primary={anyway.has(i)} label={anyway.has(i) ? 'Buying ✓' : 'Buy anyway'} onPress={() => flipAnyway(i)} />
          </View>
        ))}
      </Scroll>
      <View style={s.bar}>
        <Pill testID="review-cancel" label="Cancel" onPress={onCancel} />
        <Pill testID="review-add" primary disabled={lines.length === 0} label={`Add ${lines.length} to shopping list`} onPress={add} />
      </View>
    </View>
  );
}

const s = themed(() => StyleSheet.create({
  root: { flexShrink: 1, minHeight: 0 },
  rootFill: { flexGrow: 1, flexBasis: 0 },
  bodyFill: { flexGrow: 1, flexShrink: 1, flexBasis: 0 },
  head: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 },
  h1: { color: T.text, fontSize: 20, fontWeight: '800' },
  sub: { color: T.dim, fontSize: 14, marginTop: 2 },
  body: { flexGrow: 0, flexShrink: 1 },
  bodyIn: { paddingHorizontal: 16, paddingBottom: 12 },
  sec: { color: T.gold, fontSize: 13, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 8 },
  secGap: { marginTop: 20 },
  note: { color: T.dim, fontSize: 13, marginTop: 2, marginBottom: 2 },
  aisle: { color: T.dim, fontSize: 11, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase', marginTop: 12, marginBottom: 2 },
  row: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 7, gap: 4 },
  rowText: { flex: 1 },
  text: { color: T.text, fontSize: 16 },
  textOff: { color: T.muted, textDecorationLine: 'line-through' },
  from: { color: T.dim, fontSize: 13, marginTop: 1 },
  merge: { color: T.accent, fontSize: 13, marginTop: 1 },
  match: { color: T.muted, fontSize: 13, marginTop: 1 },
  bar: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, padding: 12, borderTopWidth: 1, borderTopColor: T.line },
}));
