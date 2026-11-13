import { readFileSync } from 'node:fs';
import { setPeople } from '../src/people';

/**
 * Runs before every unit test file (vitest.config.ts): sets the two accounts the fixtures are written for, as the session sets them in
 * the app. They are read from the person lists of the v2 store fixture (order 0 is the partner's list, order 1 the owner's), the same
 * source as the server harness (server/tools/fixture-people.php), so no account is spelled in test code.
 */
type FixtureList = { id: string; kind: string; order: number };
const store = JSON.parse(readFileSync(new URL('../../../server/tools/fixtures/v2-store.json', import.meta.url), 'utf8')) as { lists: Record<string, FixtureList> };
const [partner, owner] = Object.values(store.lists).filter(list => list.kind === 'person').sort((a, b) => a.order - b.order);
setPeople({ owner: owner?.id, partner: partner?.id });
