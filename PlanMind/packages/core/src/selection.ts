import { CAPS, DEFAULT_SELECTION, type CoreFunctions, type Lane, type ListId, type ListRecord, type Person, type PickerRow, type Selection, type Settings } from './model';
import { bothOwners, otherPerson, personLists } from './people';

const byOrder = (a: ListRecord, b: ListRecord) => a.order - b.order;
const customLists = (lists: readonly ListRecord[]) => lists.filter(l => l.kind === 'custom').sort(byOrder);
const laneOf = (list: ListRecord, me: Person): Lane => ({ listId: list.id, name: list.name, color: list.color, you: list.id === me });

export const canonicalOwners: CoreFunctions['canonicalOwners'] = (owners) => {
  if (!Array.isArray(owners) || owners.length < 1 || owners.length > 2) return null;
  if (owners.some(id => typeof id !== 'string' || id === '')) return null;
  const sorted = [...owners].sort();
  if (sorted.length === 1) return sorted;
  const both = bothOwners();
  return sorted[0] === both[0] && sorted[1] === both[1] ? sorted : null;
};

export const resolveSelection: CoreFunctions['resolveSelection'] = (sel, lists) => {
  const custom = new Set(lists.filter(l => l.kind === 'custom').map(l => l.id));
  const base = typeof sel?.base === 'string' && (sel.base === 'both' || lists.some(l => l.id === sel.base)) ? sel.base : DEFAULT_SELECTION.base;
  const overlays: ListId[] = [];
  for (const id of Array.isArray(sel?.overlays) ? sel.overlays : []) {
    if (overlays.length < CAPS.maxOverlays && typeof id === 'string' && custom.has(id) && id !== base && !overlays.includes(id)) overlays.push(id);
  }
  return { base, overlays };
};

export const selectOnly: CoreFunctions['selectOnly'] = id => ({ base: id, overlays: [] });

export const toggleOverlay: CoreFunctions['toggleOverlay'] = (sel, id, lists) => {
  const cur = resolveSelection(sel, lists);
  if (!customLists(lists).some(l => l.id === id)) return { selection: cur };
  if (cur.base === id) return { selection: { base: 'both', overlays: cur.overlays } };
  if (cur.overlays.includes(id)) return { selection: { base: cur.base, overlays: cur.overlays.filter(o => o !== id) } };
  if (cur.overlays.length >= CAPS.maxOverlays) return { selection: cur, rejected: 'overlay_limit' };
  return { selection: { base: cur.base, overlays: [...cur.overlays, id] } };
};

/**
 * Both, the partner's list, the owner's, then custom lists by order. `selected` marks the base row. `checked` means the
 * row's list is a lane on screen: the base, an overlay, or (for the two people's lists) either of them under
 * Both; the Both row is checked while Both is the base. Only custom rows have a live box.
 */
export const pickerRows: CoreFunctions['pickerRows'] = (lists, sel) => {
  const cur = resolveSelection(sel, lists);
  const full = cur.overlays.length >= CAPS.maxOverlays;
  const rows: PickerRow[] = [{ id: 'both', label: 'Both', color: null, kind: 'both', selected: cur.base === 'both', checked: cur.base === 'both', canCheck: false, checkDisabled: false }];
  for (const list of personLists().flatMap(id => lists.find(l => l.id === id) ?? [])) {
    const shown = cur.base === list.id || cur.base === 'both';
    rows.push({ id: list.id, label: list.name, color: list.color, kind: 'person', selected: cur.base === list.id, checked: shown, canCheck: false, checkDisabled: false });
  }
  for (const list of customLists(lists)) {
    const checked = cur.base === list.id || cur.overlays.includes(list.id);
    rows.push({ id: list.id, label: list.name, color: list.color, kind: 'custom', selected: cur.base === list.id, checked, canCheck: true, checkDisabled: !checked && full });
  }
  return rows;
};

/** Both is one color of its own (settings.bothColor), then the colors of the overlays by list order. */
export const pickerColors: CoreFunctions['pickerColors'] = (sel, lists, settings) => {
  const cur = resolveSelection(sel, lists);
  const base = cur.base === 'both' ? settings.bothColor : lists.find(l => l.id === cur.base)!.color;
  const overlays = customLists(lists).filter(l => cur.overlays.includes(l.id)).map(l => l.color);
  return [base, ...overlays];
};

export const resolveLanes: CoreFunctions['resolveLanes'] = (sel, lists, me) => {
  const cur = resolveSelection(sel, lists);
  const named = (id: ListId) => lists.find(l => l.id === id);
  const first = cur.base === 'both' ? [me, otherPerson(me)] : [cur.base];
  const lanes = first.flatMap(id => named(id) ?? []).map(l => laneOf(l, me));
  const overlays = customLists(lists).filter(l => cur.overlays.includes(l.id)).map(l => laneOf(l, me));
  return [...lanes, ...overlays];
};

export const newOwners: CoreFunctions['newOwners'] = (sel, lists, settings, lane) => {
  const target = lane !== undefined ? lists.find(l => l.id === lane) : undefined;
  const base = target ? target.id : resolveSelection(sel, lists).base;
  const list = lists.find(l => l.id === base);
  return list ? { owners: [list.id], color: list.color } : { owners: bothOwners(), color: settings.bothColor };
};

export const blankThirds: CoreFunctions['blankThirds'] = (sel, lists, settings, lanes) =>
  lanes.length === 2 && newOwners(sel, lists, settings).owners.length === 2;

export const blankAim: CoreFunctions['blankAim'] = (sel, lists, settings, lanes, across, both = false) => {
  const whole = newOwners(sel, lists, settings);
  if (!blankThirds(sel, lists, settings, lanes)) return { side: 'only', ...whole };
  // A position that is not a number (a keyboard activation has none) is the middle: it never picks a person by accident.
  const at = Number.isFinite(across) ? across : 0.5;
  if (both || (at >= 1 / 3 && at < 2 / 3)) return { side: 'both', ...whole };
  const side = at < 0.5 ? 'left' : 'right';
  return { side, ...newOwners(sel, lists, settings, lanes[side === 'left' ? 0 : 1].listId) };
};

export const listDeleteImpact: CoreFunctions['listDeleteImpact'] = (data, listId) => {
  const alone = (item: { owners: readonly ListId[] }) => item.owners.length === 1 && item.owners[0] === listId;
  return {
    items: data.tasks.filter(alone).length + data.priorities.filter(alone).length + data.events.filter(alone).length,
    notes: data.notes.filter(n => n.listId === listId && n.text.trim() !== '').length,
  };
};
