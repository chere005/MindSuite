import { renameSync, writeFileSync } from 'node:fs';
import { CONFIG_FILE } from './port';

/**
 * The scratch site config the API reads on its next request. SUITE_MINDSUITE_AUTH_TEST (the harness's fixture switch)
 * makes the shared sign-in switch itself on, so the one thing a case can change is the per-app hold:
 *   'on'    no hold: CalMind follows the shared sign-in
 *   'held'  `mindsuite_auth_hold` names calmind on this (prod) instance: CalMind answers the legacy way
 * (Off, and the site lib missing, answer the legacy way too and are what the whole gesture suite already runs against.)
 */
export function writeSite(mode: 'on' | 'held'): void {
  const hold = mode === 'held' ? "['prod' => ['calmind']]" : '[]';
  writeFileSync(`${CONFIG_FILE}.tmp`, `<?php return ['mindsuite_auth_hold' => ${hold}];`);
  renameSync(`${CONFIG_FILE}.tmp`, CONFIG_FILE);
}
