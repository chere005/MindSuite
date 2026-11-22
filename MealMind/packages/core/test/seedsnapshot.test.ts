import { describe, it, expect } from 'vitest';
import { normalize } from '../src/normalize';
import type { AnyRec, Rec } from '../src/types';

/**
 * WHAT THIS APP SEEDS, pinned byte for byte. normalize() runs on every load,
 * so its output IS the first-run data of a new account and the repair a
 * returning one gets. The seed profile moved behind a per-app config seam
 * (src/appconfig.ts) in 2026-11; these snapshots were taken from the code
 * before that move and must not change because of it.
 *
 * Ids are random (newId), so each is replaced by the order it first appears
 * in: '#0', '#1', … Everything else — names, colours, ords, flags, key order,
 * which records are added versus edited — is compared as written.
 */
function seeded(recs: AnyRec[]): string {
  const ids = new Map<string, string>();
  const fresh = new Set<string>();
  const { added, edited } = normalize(recs);
  for (const r of added) fresh.add(r.id);
  const id = (s: string) => {
    if (!fresh.has(s)) return s;
    if (!ids.has(s)) ids.set(s, `#${ids.size}`);
    return ids.get(s)!;
  };
  const swap = (v: unknown): unknown => {
    if (typeof v === 'string') return id(v);
    if (Array.isArray(v)) return v.map(swap);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x)]));
    return v;
  };
  return JSON.stringify({ added: swap(added), edited: swap(edited) }, null, 1);
}

const folder = (id: string, name: string, app: 'reminders' | 'notes' | undefined, ord: string, extra: Record<string, unknown> = {}): Rec<'folder'> => ({
  id, type: 'folder', updated: 1, payload: { name, color: '#60a5fa', ord, ...(app ? { app } : {}), ...extra } as Rec<'folder'>['payload'],
});
const section = (id: string, folderId: string): Rec<'section'> => ({
  id, type: 'section', updated: 1, payload: { name: 'S', folderId, ord: 'V' },
});
const reminder = (id: string, folderId: string, sectionId: string): Rec<'reminder'> => ({
  id, type: 'reminder', updated: 1,
  payload: { text: 't', due: null, time: null, done: false, repeat: null, folderId, sectionId, indent: 0, ord: 'V' },
});
const note = (id: string, folderId: string, sectionId: string): Rec<'note'> => ({
  id, type: 'note', updated: 1, payload: { title: 'n', body: '', date: null, folderId, sectionId, ord: 'V' },
});
const event = (id: string, calendarId: string): AnyRec => ({
  id, type: 'event', updated: 1, payload: { title: 'e', date: '2026-01-01', calendarId } as never,
});
const habit = (id: string, sectionId: string): AnyRec => ({
  id, type: 'habit', updated: 1, payload: { name: 'h', sectionId } as never,
});

describe('seed snapshot — first-run and repair data, unchanged by the seed-profile seam', () => {
  it('a brand-new account', () => {
    expect(seeded([])).toMatchInlineSnapshot(`
      "{
       "added": [
        {
         "id": "#0",
         "type": "folder",
         "updated": 0,
         "payload": {
          "name": "General",
          "color": "#7dc2ed",
          "ord": "V",
          "app": "notes"
         }
        },
        {
         "id": "#1",
         "type": "folder",
         "updated": 0,
         "payload": {
          "name": "Shopping list",
          "color": "#f0b429",
          "ord": "V",
          "app": "reminders",
          "shopping": true
         }
        },
        {
         "id": "#2",
         "type": "folder",
         "updated": 0,
         "payload": {
          "name": "Pantry",
          "color": "#5fb6ac",
          "ord": "k",
          "app": "reminders",
          "pantry": true
         }
        },
        {
         "id": "#3",
         "type": "section",
         "updated": 0,
         "payload": {
          "name": "General",
          "folderId": "#0",
          "ord": "V"
         }
        },
        {
         "id": "#4",
         "type": "section",
         "updated": 0,
         "payload": {
          "name": "General",
          "folderId": "#1",
          "ord": "V"
         }
        },
        {
         "id": "#5",
         "type": "section",
         "updated": 0,
         "payload": {
          "name": "General",
          "folderId": "#2",
          "ord": "V"
         }
        }
       ],
       "edited": []
      }"
    `);
  });

  it('a milestone-1 account (a folder without app) with strays of every kind', () => {
    expect(seeded([
      folder('f1', 'Old', undefined, 'V'), section('s1', 'f1'),
      reminder('r1', 'f1', 's1'), reminder('r2', 'gone', 'gone'),
      note('n1', 'f1', 's1'), event('e1', 'gone'), habit('h1', 'gone'),
    ])).toMatchInlineSnapshot(`
      "{
       "added": [
        {
         "id": "#0",
         "type": "folder",
         "updated": 0,
         "payload": {
          "name": "General",
          "color": "#7dc2ed",
          "ord": "V",
          "app": "notes"
         }
        },
        {
         "id": "#1",
         "type": "folder",
         "updated": 0,
         "payload": {
          "name": "Shopping list",
          "color": "#f0b429",
          "ord": "k",
          "app": "reminders",
          "shopping": true
         }
        },
        {
         "id": "#2",
         "type": "folder",
         "updated": 0,
         "payload": {
          "name": "Pantry",
          "color": "#5fb6ac",
          "ord": "s",
          "app": "reminders",
          "pantry": true
         }
        },
        {
         "id": "#3",
         "type": "section",
         "updated": 0,
         "payload": {
          "name": "General",
          "folderId": "#0",
          "ord": "V"
         }
        },
        {
         "id": "#4",
         "type": "section",
         "updated": 0,
         "payload": {
          "name": "General",
          "folderId": "#1",
          "ord": "V"
         }
        },
        {
         "id": "#5",
         "type": "section",
         "updated": 0,
         "payload": {
          "name": "General",
          "folderId": "#2",
          "ord": "V"
         }
        }
       ],
       "edited": [
        {
         "id": "f1",
         "type": "folder",
         "updated": 1,
         "payload": {
          "name": "Old",
          "color": "#60a5fa",
          "ord": "V"
         },
         "deleted": true
        },
        {
         "id": "s1",
         "type": "section",
         "updated": 1,
         "payload": {
          "name": "S",
          "folderId": "f1",
          "ord": "V"
         },
         "deleted": true
        },
        {
         "id": "r1",
         "type": "reminder",
         "updated": 1,
         "payload": {
          "text": "t",
          "due": null,
          "time": null,
          "done": false,
          "repeat": null,
          "folderId": "#1",
          "sectionId": "#4",
          "indent": 0,
          "ord": "V"
         }
        },
        {
         "id": "r2",
         "type": "reminder",
         "updated": 1,
         "payload": {
          "text": "t",
          "due": null,
          "time": null,
          "done": false,
          "repeat": null,
          "folderId": "#1",
          "sectionId": "#4",
          "indent": 0,
          "ord": "V"
         }
        },
        {
         "id": "n1",
         "type": "note",
         "updated": 1,
         "payload": {
          "title": "n",
          "body": "",
          "date": null,
          "folderId": "#0",
          "sectionId": "#3",
          "ord": "V"
         }
        }
       ]
      }"
    `);
  });

  it('an account that already grew a general Reminders folder, a ride-along folder and flagged lists', () => {
    expect(seeded([
      folder('rf', 'Reminders', 'reminders', 'A'), section('rs', 'rf'),
      folder('cf', 'Calendar', 'reminders', 'B', { rideAlong: true }), section('cs', 'cf'),
      folder('sf', 'Shopping list', 'reminders', 'C', { shopping: true }), section('ss', 'sf'),
      folder('pf', 'Pantry', 'reminders', 'D', { pantry: true }),
      folder('nf', 'General', 'notes', 'E'), section('ns', 'nf'),
      reminder('r1', 'rf', 'rs'), reminder('r2', 'cf', 'cs'), reminder('r3', 'sf', 'ss'),
      note('n1', 'rf', 'rs'),
    ])).toMatchInlineSnapshot(`
      "{
       "added": [
        {
         "id": "#0",
         "type": "section",
         "updated": 0,
         "payload": {
          "name": "General",
          "folderId": "pf",
          "ord": "V"
         }
        }
       ],
       "edited": [
        {
         "id": "rf",
         "type": "folder",
         "updated": 1,
         "payload": {
          "name": "Reminders",
          "color": "#60a5fa",
          "ord": "A",
          "app": "reminders"
         },
         "deleted": true
        },
        {
         "id": "rs",
         "type": "section",
         "updated": 1,
         "payload": {
          "name": "S",
          "folderId": "rf",
          "ord": "V"
         },
         "deleted": true
        },
        {
         "id": "cf",
         "type": "folder",
         "updated": 1,
         "payload": {
          "name": "Calendar",
          "color": "#60a5fa",
          "ord": "B",
          "app": "reminders",
          "rideAlong": true
         },
         "deleted": true
        },
        {
         "id": "cs",
         "type": "section",
         "updated": 1,
         "payload": {
          "name": "S",
          "folderId": "cf",
          "ord": "V"
         },
         "deleted": true
        },
        {
         "id": "r1",
         "type": "reminder",
         "updated": 1,
         "payload": {
          "text": "t",
          "due": null,
          "time": null,
          "done": false,
          "repeat": null,
          "folderId": "sf",
          "sectionId": "ss",
          "indent": 0,
          "ord": "V"
         }
        },
        {
         "id": "r2",
         "type": "reminder",
         "updated": 1,
         "payload": {
          "text": "t",
          "due": null,
          "time": null,
          "done": false,
          "repeat": null,
          "folderId": "sf",
          "sectionId": "ss",
          "indent": 0,
          "ord": "V"
         }
        },
        {
         "id": "n1",
         "type": "note",
         "updated": 1,
         "payload": {
          "title": "n",
          "body": "",
          "date": null,
          "folderId": "nf",
          "sectionId": "ns",
          "ord": "V"
         }
        }
       ]
      }"
    `);
  });
});
