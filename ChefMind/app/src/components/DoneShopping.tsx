/**
 * Done shopping — what is in the cart goes into the pantry.
 *
 * One row per DONE shopping row, named the way it will appear in the pantry
 * (`doneShoppingPlan`: quantity dropped, a can stays "canned"). Rows the
 * pantry already has say so and start unticked; so do things the aisles cannot
 * place (paper towels). "Put N in the pantry" writes the pantry rows and
 * deletes EVERY done shopping row — ticked for the pantry or not — in one
 * mutate (`doneShoppingOps`), so a refusal cannot leave an item on neither list.
 *
 * PANE-READY: renders inline, no Modal.
 */
import { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { doneShoppingPlan } from '@calmind/core';
import { useStore } from '../store';
import { themed, T } from '../theme';
import { Pill, Scroll } from '../ui';
import { useToast } from './Toast';
import { pantryTexts } from '../addToShopping';
import { doneRows, doneShoppingOps } from '../chefflows';
import { TickBox, okColor } from './chefui';

export type DoneShoppingProps = {
  onCancel: () => void;
  /** After the write: how many went to the pantry and how many rows left the list. */
  onDone: (r: { put: number; removed: number }) => void;
};

export function DoneShopping({ onCancel, onDone }: DoneShoppingProps) {
  const { recs, mutate } = useStore();
  const toast = useToast();
  const plan = useMemo(() => doneShoppingPlan(doneRows(recs), pantryTexts(recs)), [recs]);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const on = (id: string, dflt: boolean) => touched[id] ?? dflt;
  const picked = plan.filter((p) => on(p.id, p.defaultOn));

  const go = () => {
    const names = picked.map((p) => p.name);
    const doneIds = doneRows(recs).map((r) => r.id);
    const w = doneShoppingOps(recs, names, doneIds);
    if (!w.ok) { toast('The pantry is not ready yet. Try again in a moment.'); return; }
    try {
      // ONE mutate: the pantry rows and every deletion land together.
      mutate((e) => { for (const op of w.ops) { if (op.kind === 'put') e.put(op.rec); else e.del(op.id); } });
    } catch {
      toast('Could not save. Nothing was changed.');
      return;
    }
    toast(w.put === 0 ? `${w.removed} cleared from the list.` : w.put === 1 ? '1 put in the pantry.' : `${w.put} put in the pantry.`);
    onDone({ put: w.put, removed: w.removed });
  };

  return (
    <View style={s.root} testID="done-shopping">
      <View style={s.head}>
        <Text style={s.h1}>Done shopping</Text>
        <Text style={s.sub}>What's in your cart goes into the pantry and leaves this list.</Text>
      </View>
      <Scroll style={s.body} contentContainerStyle={s.bodyIn}>
        {plan.length === 0 && <Text style={s.note}>Nothing is ticked yet. Tick items as they go in the cart.</Text>}
        {plan.map((p) => {
          const v = on(p.id, p.defaultOn);
          return (
            <View key={p.id} style={s.row}>
              <TickBox testID="done-row" on={v} label={`Put ${p.name} in the pantry`} onPress={() => setTouched((t) => ({ ...t, [p.id]: !v }))} />
              <View style={s.rowText}>
                <Text style={[s.text, !v && s.textOff]}>{p.name}</Text>
                <Text style={s.from}>
                  {p.text !== p.name ? `${p.text} · ` : ''}{p.aisle}
                </Text>
                {p.already && <Text style={s.already}>Already in your pantry</Text>}
              </View>
            </View>
          );
        })}
        {plan.length > 0 && (
          <Text style={s.note}>Quantities are dropped; the pantry keeps names. Items in Other, like paper towels, stay off the pantry unless you tick them.</Text>
        )}
      </Scroll>
      <View style={s.bar}>
        <Pill testID="done-cancel" label="Cancel" onPress={onCancel} />
        <Pill
          testID="done-go"
          primary
          disabled={plan.length === 0}
          label={picked.length > 0 ? `Put ${picked.length} in the pantry` : `Clear ${plan.length} from the list`}
          onPress={go}
        />
      </View>
    </View>
  );
}

const s = themed(() => StyleSheet.create({
  root: { flexShrink: 1, minHeight: 0 },
  head: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 },
  h1: { color: T.text, fontSize: 20, fontWeight: '800' },
  sub: { color: T.dim, fontSize: 14, marginTop: 2 },
  body: { flexGrow: 0, flexShrink: 1 },
  bodyIn: { paddingHorizontal: 16, paddingBottom: 12 },
  note: { color: T.dim, fontSize: 13, marginTop: 10, lineHeight: 18 },
  row: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 7, gap: 4 },
  rowText: { flex: 1 },
  text: { color: T.text, fontSize: 16 },
  textOff: { color: T.muted },
  from: { color: T.dim, fontSize: 13, marginTop: 1 },
  already: { color: okColor(), fontSize: 13, marginTop: 1 },
  bar: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, padding: 12, borderTopWidth: 1, borderTopColor: T.line },
}));
