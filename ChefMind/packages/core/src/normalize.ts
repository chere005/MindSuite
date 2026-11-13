/**
 * This app's normalize: the shared body in @mind/core/normalize, run with this
 * app's seed profile (APP_SEEDS in ./appconfig, app-owned) unless the caller
 * passes one. Everything else that module exports is re-exported unchanged;
 * the local `normalize` below shadows the one `export *` would bring (a
 * module's own export always wins over a star re-export). Same bytes in
 * CalMind and ChefMind; only appconfig.ts differs.
 */
import type { AnyRec } from './types';
import { normalize as sharedNormalize, SUITE_SEEDS, type SeedProfile } from '@mind/core/normalize';
import { APP_SEEDS } from './appconfig';

export * from '@mind/core/normalize';

export function normalize(recs: AnyRec[], profile: SeedProfile = APP_SEEDS ?? SUITE_SEEDS): { added: AnyRec[]; edited: AnyRec[] } {
  return sharedNormalize(recs, profile);
}
