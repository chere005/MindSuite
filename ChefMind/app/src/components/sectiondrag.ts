/**
 * The section drag — level 0 of the suite's outline: a section travels as a
 * block and lands only between other sections. Sections have variable
 * heights, so this drag MEASURES: every section header registers a ref, the
 * grant measures them all in window space, and the pointer's absolute Y picks
 * the slot. The drop line is the only feedback, as ever.
 */
import { useRef, useState } from 'react';
import { PanResponder, type PanResponderInstance, type View } from 'react-native';

export type SectionSlot = { key: string; folderId: string; beforeSectionId: string | null };

type Boundary = { y: number; slot: SectionSlot };

/** One drag's own state, so nothing measured or hovered in an earlier drag leaks into this one. */
type Run = { slots: Boundary[]; measured: boolean; ready: Promise<void>; live: SectionSlot | null; moved: boolean };

/** The last boundary at or above `y`; landing on your own boundary is a no-op, not a hint. */
function hitAt(slots: Boundary[], y: number, sectionId: string): Boundary | null {
  let hit: Boundary | null = null;
  for (const s of slots) {
    if (s.y <= y) hit = s;
  }
  return hit && hit.slot.beforeSectionId === sectionId ? null : hit;
}

export function useSectionDrag(
  onDrop: (sectionId: string, slot: SectionSlot) => void,
): {
  registerHeader: (sectionId: string, folderId: string) => (ref: View | null) => void;
  gripFor: (sectionId: string) => PanResponderInstance['panHandlers'];
  dragging: string | null;
  lineKey: string | null;
} {
  const headers = useRef(new Map<string, { ref: View; folderId: string }>());
  const [dragging, setDragging] = useState<string | null>(null);
  const [lineKey, setLineKey] = useState<string | null>(null);
  const run = useRef<Run | null>(null);
  // Read live: a responder is created once per section, so the callback it
  // closed over would be the first render's — with that render's records.
  const drop = useRef(onDrop);
  drop.current = onDrop;
  const responders = useRef(new Map<string, PanResponderInstance>());

  const registerHeader = (sectionId: string, folderId: string) => (ref: View | null) => {
    if (ref) headers.current.set(sectionId, { ref, folderId });
    else headers.current.delete(sectionId);
  };

  const measure = async (): Promise<Boundary[]> => {
    const entries = [...headers.current.entries()];
    const measured = await Promise.all(
      entries.map(
        ([id, { ref, folderId }]) =>
          new Promise<{ id: string; folderId: string; y: number }>((res) =>
            ref.measureInWindow((_x, y) => res({ id, folderId, y })),
          ),
      ),
    );
    measured.sort((a, b) => a.y - b.y);
    const list: Boundary[] = [];
    for (let i = 0; i < measured.length; i++) {
      const m = measured[i]!;
      // A slot ABOVE each header: land before this section, in its folder.
      list.push({ y: m.y, slot: { key: `before:${m.id}`, folderId: m.folderId, beforeSectionId: m.id } });
      // A trailing end-of-folder slot when the next header starts a new folder.
      const next = measured[i + 1];
      if (!next || next.folderId !== m.folderId) {
        const endY = next ? next.y - 1 : m.y + 400;
        list.push({ y: endY, slot: { key: `end:${m.folderId}`, folderId: m.folderId, beforeSectionId: null } });
      }
    }
    return list;
  };

  const gripFor = (sectionId: string) => {
    const key = sectionId;
    if (!responders.current.has(key)) {
      responders.current.set(
        key,
        PanResponder.create({
          onStartShouldSetPanResponder: () => true,
          onMoveShouldSetPanResponder: () => true,
          // As in the row drag: the enclosing ScrollView asks to take the
          // gesture over as soon as it travels, and yielding meant the drag
          // died on any list long enough to scroll.
          onPanResponderTerminationRequest: () => false,
          onPanResponderGrant: () => {
            setDragging(sectionId);
            setLineKey(null);
            const r: Run = { slots: [], measured: false, ready: Promise.resolve(), live: null, moved: false };
            r.ready = measure().then((list) => { r.slots = list; r.measured = true; });
            run.current = r;
          },
          onPanResponderMove: (_e, g) => {
            const r = run.current;
            if (!r) return;
            r.moved = true;
            const hit = hitAt(r.slots, g.moveY, sectionId);
            r.live = hit?.slot ?? null;
            setLineKey(hit?.slot.key ?? null);
          },
          onPanResponderRelease: (_e, g) => {
            const r = run.current;
            run.current = null;
            setDragging(null);
            setLineKey(null);
            if (!r) return;
            if (r.measured) {
              // The last move may have been before the measure answered (r.live
              // still null): place the release point itself on the boundaries.
              const slot = r.live ?? (r.moved ? hitAt(r.slots, g.moveY, sectionId)?.slot ?? null : null);
              if (slot) drop.current(sectionId, slot);
            } else if (r.moved) {
              // Released before THIS drag's measure answered: wait for it and
              // place the release point on it, never on an earlier drag's.
              const y = g.moveY;
              void r.ready.then(() => {
                const hit = hitAt(r.slots, y, sectionId);
                if (hit) drop.current(sectionId, hit.slot);
              });
            }
          },
          onPanResponderTerminate: () => {
            run.current = null;
            setDragging(null);
            setLineKey(null);
          },
        }),
      );
    }
    return responders.current.get(key)!.panHandlers;
  };

  return { registerHeader, gripFor, dragging, lineKey };
}
