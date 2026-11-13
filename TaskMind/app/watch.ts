import type { Reply } from '../packages/core/src/taskmind';
import { screenFor } from '../packages/core/src/taskmind';
import type { ReleaseWatch } from './release';

/** How often an open, visible page asks the server again. */
export const WATCH_INTERVAL_MS = 60000;

export type WatchDeps = {
  /** One GET of the session (api.session). */
  load: () => Promise<Reply>;
  release: ReleaseWatch;
  hidden: () => boolean;
  /** The session ended or the team no longer includes this person: the view closes. */
  closed: (screen: 'signedOut' | 'denied') => void;
  /** The host serves another release than this page started under: load the new app. */
  reload: () => void;
};

/**
 * Keeps an open page honest. One tick asks for the session again: signed out or removed from the team closes the view at once
 * (private data is gone from the DOM, never greyed out), a failed read changes nothing (it is not "empty"), and a new release is
 * picked up. A hidden tab does not ask, and a closed view asks no more. Nothing here touches the DOM, the clock or browser storage.
 */
export function createWatch({ load, release, hidden, closed, reload }: WatchDeps) {
  let busy = false, ended = false;
  return {
    async tick(): Promise<void> {
      if (busy || ended || hidden()) return;
      busy = true;
      try {
        const screen = screenFor(await load());
        if (screen === 'signedOut' || screen === 'denied') { ended = true; closed(screen); return; }
        if (release.changed) reload();
      } finally { busy = false; }
    },
  };
}
