import { expect, type Page, type Route } from '@playwright/test';

// What the release specs share. The preview has no releases, so each test stands in for the host with a route that adds the
// X-PlanMind-Release header to every answer of api.php and changes it on cue (install it before login, so the first read is the page's own release).
export const A = '20261102090000-1', B = '20261102093000-2';
const isApi = (url: URL) => url.pathname.endsWith('/api.php');

export type Served = { stamp: string | null; holds: Map<string, Promise<void>> };
export async function host(page: Page, first: string = A): Promise<Served> {
  const state: Served = { stamp: first, holds: new Map() };
  await page.route(isApi, async (route: Route) => {
    try {
      // The answer of a write whose body holds a held needle waits for it; every other answer (a read, the silent save of a picker choice) goes through.
      const body = route.request().postData() ?? '';
      for (const [needle, until] of state.holds) { if (body.includes(needle)) { await until; } }
      const response = await route.fetch();
      await route.fulfill({ response, headers: state.stamp === null ? response.headers() : { ...response.headers(), 'x-planmind-release': state.stamp } });
    } catch { /* the page went away (a reload) while the answer was on its way */ }
  });
  return state;
}
/** Holds the answer of every write whose body contains `needle` (`"complete"`, `"savePrefs"`, `"setTheme"`) until the returned function is called. */
export function hold(served: Served, needle: string): () => void {
  let letGo!: () => void;
  served.holds.set(needle, new Promise<void>(resolve => { letGo = resolve; }));
  return letGo;
}

/** What the browser coming back online does: ask for a fresh read now, instead of waiting for the 12 s poll. */
export const poll = (page: Page) => page.evaluate(() => { window.dispatchEvent(new Event('online')); });
export const mark = (page: Page) => page.evaluate(() => { (window as unknown as { marked: boolean }).marked = true; });
/** True while this document is the one that was marked, so false once the page has been loaded again. */
export const standing = (page: Page) => page.evaluate(() => (window as unknown as { marked?: boolean }).marked === true).catch(() => false);
export const reloaded = (page: Page) => expect.poll(() => standing(page), { message: 'the page was loaded again' }).toBe(false);
/** Time enough for a reload to have started if it was going to (a poll answers in a few milliseconds here). */
export const still = async (page: Page, what: string) => { await page.waitForTimeout(700); expect(await standing(page), what).toBe(true); };
