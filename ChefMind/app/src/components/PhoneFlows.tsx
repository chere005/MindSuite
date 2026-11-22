/**
 * The phone's wrapper for the session's Review and Cook: the same pane-ready
 * components the wide frame mounts in its panes, in sheets. Mounted at the root
 * (not inside the Recipes screen) so a Review or Cook opened in the wide layout
 * reopens here on whatever tab the phone is showing when the window narrows.
 * Cook starts on one recipe; "+ Add a recipe" inside it adds another.
 */
import type { Rec } from '@calmind/core';
import { useStore } from '../store';
import { addToCook, dropFromCook, useChefSession } from '../session';
import { ShoppingReview } from './ShoppingReview';
import { CookView, phoneFinish } from './CookView';
import { PhoneSheet } from './chefui';

export function PhoneFlows({ onShopping }: { onShopping: () => void }) {
  const { recs } = useStore();
  const { review, setReview, cook, setCook, setCookState, setPicked } = useChefSession();
  const notes = cook
    ? cook.ids.map((id) => recs.find((r): r is Rec<'note'> => r.type === 'note' && r.id === id && !r.deleted)).filter((n): n is Rec<'note'> => !!n)
    : [];
  return (
    <>
      {review && (
        <PhoneSheet onClose={() => setReview(null)}>
          <ShoppingReview
            review={review}
            onChange={setReview}
            onCancel={() => setReview(null)}
            onAdded={() => { setReview(null); setPicked([]); onShopping(); }}
          />
        </PhoneSheet>
      )}
      {cook && (
        <PhoneSheet full onClose={() => setCook(null)}>
          <CookView
            notes={notes}
            {...(cook.first !== undefined ? { initialId: cook.first } : {})}
            initialVariantId={cook.variantId}
            state={cook.state}
            onState={setCookState}
            onClose={() => setCook(null)}
            onAdd={(id) => setCook((c) => (c ? addToCook(c, id) : c))}
            onDrop={(id) => setCook((c) => (c ? dropFromCook(c, id) : c))}
            wrapFinish={phoneFinish}
          />
        </PhoneSheet>
      )}
    </>
  );
}
