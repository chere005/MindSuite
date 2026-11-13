/**
 * The bar at the foot of a screen in edit mode: how many are picked, the two
 * ways to change that wholesale, a two-press Delete, and the one thing the
 * selection is FOR.
 *
 * ALL AND CLEAR LIVE HERE, not in the top bar. Each screen used to carry a
 * ☑/☒ circle up beside the pencil that toggled between select-all and
 * select-none — one control with two meanings, at the far end of the screen
 * from the bar that says what is selected. The owner, 2026-09-16: they are two
 * buttons, in the bar, next to the count they act on. They are drawn a shade
 * smaller than Delete and the action: they change a SELECTION, while the two
 * on the right act on the things selected, and the size says which is which
 * before the words are read.
 *
 * ONE COMPONENT, THREE SCREENS. Recipes ends it with "Add"; the two lists end
 * at Delete and say so with a SPACE — the owner, 2026-09-16: "the buttons will be
 * `N Selected, All, Clear, space, Delete`". The gap is the point. All and
 * Clear change what is picked and sit by the count they act on; Delete acts
 * on the things themselves and is pushed to the far end, where no thumb
 * heading for Clear can reach it.
 *
 * It was Recipes' own inline JSX until 2026-08-22, and copying it across
 * would have been three bars drifting apart from the first change onwards.
 *
 * NOT ChefMind only any more: it was canon from 2026-09-21 until CoreMind/canon
 * was retired, and is this app's own file now (tools/shared-files.json does not
 * list it). Upstream's Notes screen still has no selection to act on, so
 * CalMind carries no twin — but
 * AcctMind does, as a noted `fork`, because its ledger has one palette and
 * no `themed()` and draws its controls at TAP rather than buying the area
 * back with `WebHitSlop`. Same four controls, same order, same two-press
 * Delete; it adds the selection's sum, which is the thing a ledger picks
 * rows FOR and this list has no use for. A change to the BEHAVIOUR here is
 * owed to that copy.
 */
import { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { themed, T } from '../theme';
import { WebHitSlop } from '../ui';

export function PickBar({
  prefix, count, onAll, onClear, onDelete, action,
}: {
  /** Names the testIDs, so each screen's controls stay findable by name. */
  prefix: string;
  count: number;
  /** Pick everything the screen can pick. */
  onAll: () => void;
  onClear: () => void;
  onDelete: () => void;
  /** What the selection is FOR, when the screen has such a thing. Omitted on
   *  the lists, where selecting is for deleting and Delete is already here. */
  action?: { label: string; testID: string; onPress: () => void };
}) {
  /**
   * Two presses, and the first one turns it red — the suite's delete gesture,
   * in a bar wide enough for the word rather than the round × the rows wear.
   * The owner, 2026-08-22: "a delete button that when tapped turns red to confirm".
   *
   * It disarms itself after 2.5s, so a bar left armed on a screen you walked
   * away from cannot delete on the next stray tap. Leaving edit mode unmounts
   * the whole bar, which disarms it by construction — Recipes needed an
   * effect for that when this state lived up in the screen.
   */
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const armOrDelete = () => {
    if (!armed) {
      setArmed(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setArmed(false), 2500);
      return;
    }
    clearTimeout(timer.current);
    setArmed(false);
    onDelete();
  };

  return (
    <View style={s.bar}>
      <Text style={s.count} numberOfLines={1}>{count} selected</Text>
      {/* Two buttons, not one toggle: "select none" and "select all" are
          opposite intentions and a control that silently swaps between them
          is one you have to read before you can press. */}
      {/* accessibilityRole, on both: react-native-web only emits role="button"
          when it is asked to, and a bare <div> is invisible both to a screen
          reader and to every "did the tap land on a control" rule in this
          app — which is how Save inside CalMind's habit editor once switched
          edit mode off behind the sheet. Clear has been a bare div since it
          was written; it is one now because All joining it made two. */}
      <Pressable
        testID={`${prefix}-all`}
        accessibilityRole="button"
        accessibilityLabel="Select all"
        onPress={onAll}
        hitSlop={8}
        style={s.pick}
      >
        <WebHitSlop slop={8} />
        <Text style={s.pickText}>All</Text>
      </Pressable>
      <Pressable
        testID={`${prefix}-clear`}
        accessibilityRole="button"
        accessibilityLabel="Select none"
        onPress={onClear}
        hitSlop={8}
        style={s.pick}
      >
        <WebHitSlop slop={8} />
        <Text style={s.pickText}>Clear</Text>
      </Pressable>
      {/* With no action to sit before, Delete goes to the far end instead —
          the space is what keeps it away from Clear. */}
      {!action && <View style={s.spacer} />}
      {/* Delete sits BEFORE the primary action and in its own colour, so the
          thumb heading for the accent pill never lands on it. */}
      <Pressable
        testID={`${prefix}-delete`}
        accessibilityRole="button"
        accessibilityLabel={armed ? `Confirm deleting ${count}` : `Delete ${count}`}
        onPress={armOrDelete}
        style={[s.del, armed && s.delArmed]}
      >
        {/* 'Delete?' armed, not 'Delete 12?' — the count is already in this
            bar two buttons away, and the longer word wrapped the row at
            phone width once All joined it. The accessibility label still
            carries the number, where there is room for it. */}
        <Text style={[s.delText, armed && s.delTextArmed]} numberOfLines={1}>{armed ? 'Delete?' : 'Delete'}</Text>
      </Pressable>
      {action && (
        <Pressable testID={action.testID} onPress={action.onPress} style={s.go}>
          <Text style={s.goText} numberOfLines={1}>{action.label}</Text>
        </Pressable>
      )}
    </View>
  );
}

const s = themed(() => StyleSheet.create({
  // The space in "All, Clear, space, Delete". It takes whatever is left, so
  // Delete ends the bar at every width instead of following Clear about.
  spacer: { flex: 1 },
  bar: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 12, paddingVertical: 10,
    borderTopWidth: 1, borderTopColor: T.line, backgroundColor: T.surface,
  },
  // The count is what GIVES at a narrow width: the buttons cannot shrink
  // without becoming unhittable, and "12 selected" wrapping to two lines
  // made the whole bar two rows tall.
  count: { color: T.dim, fontSize: 14, flexShrink: 1 },
  // A shade smaller than Delete and the action — 10/6 against their 12/9,
  // 13pt against 14 — and the same rounded rectangle, so the pair reads as
  // one kind of control and the pair on the right as another. The 8pt slop
  // above and below puts the TARGET back level with them, which matters on
  // the web where hitSlop is a no-op and WebHitSlop is doing the work.
  pick: {
    flexShrink: 0,
    borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6,
    borderWidth: 1, borderColor: T.line,
  },
  pickText: { color: T.dim, fontSize: 13, fontWeight: '600' },
  // Delete carries the marginLeft:auto, so it and the primary action sit
  // together at the right rather than one of them floating in the middle.
  del: {
    flexShrink: 0,
    marginLeft: 'auto', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 9,
    borderWidth: 1, borderColor: T.line,
  },
  delArmed: { backgroundColor: T.danger, borderColor: T.danger },
  delText: { color: T.muted, fontSize: 14, fontWeight: '600' },
  delTextArmed: { color: '#fff' },
  go: { flexShrink: 0, backgroundColor: T.accent, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 9 },
  goText: { color: T.accentInk, fontSize: 14, fontWeight: '700' },
}));
