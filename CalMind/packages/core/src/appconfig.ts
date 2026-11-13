/**
 * THIS APP'S CONFIG SEAM for canon core. Canon files that need a per-app
 * value import it from here, so the canon file itself stays byte-identical in
 * every app and only this small file differs.
 *
 * APP_SEEDS — the seed profile normalize() runs with (see SeedProfile in
 * normalize.ts). null means the suite default, SUITE_SEEDS: CalMind's general
 * Reminders folder and ride-along Calendar folder, Notes' General, a starter
 * calendar and a habit section.
 *
 * Type-only import: normalize.ts imports this file's values, so a value
 * import back the other way would be a cycle.
 */
import type { SeedProfile } from './normalize';

export const APP_SEEDS: SeedProfile | null = null;
