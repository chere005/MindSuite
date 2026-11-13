/**
 * THIS APP'S CONFIG SEAM for canon core. Canon files that need a per-app
 * value import it from here, so the canon file itself stays byte-identical in
 * every app and only this small file differs (tools/shared-files.json does not
 * list it; CalMind's copy holds the suite default).
 *
 * APP_SEEDS — the seed profile normalize() runs with (SeedProfile in
 * normalize.ts). ChefMind's is a 'lists' profile:
 *
 *  · the SHOPPING LIST (the owner, 2026-08-21) in the palette's gold, which is also
 *    the tile this app wears, so the tab and the folder read as one thing;
 *  · the PANTRY (the owner, 2026-08-22) in the notes sky leaned green, so the three
 *    tabs read as three places;
 *  · NO general Reminders folder (the owner, 2026-08-22: "i still see reminders on
 *    chefmind, that should have been removed completely") — every reminder
 *    here IS a shopping or pantry row, and an account that already grew one
 *    has it folded into the shopping list;
 *  · no ride-along Calendar folder, no calendar, no habit section — this app
 *    has none of those tabs, so they would be records that sync forever and
 *    are never drawn.
 *
 * What a new account gets from this is pinned by test/seedsnapshot.test.ts.
 *
 * Type-only import: normalize.ts imports this file's values, so a value
 * import back the other way would be a cycle.
 */
import type { SeedProfile } from './normalize';

export const FOLDER_SHOPPING = 'Shopping list';
export const FOLDER_PANTRY = 'Pantry';

export const APP_SEEDS: SeedProfile | null = {
  reminders: {
    kind: 'lists',
    shopping: { name: FOLDER_SHOPPING, color: '#f0b429' },
    pantry: { name: FOLDER_PANTRY, color: '#5fb6ac' },
  },
  calendar: false,
  habits: false,
};
