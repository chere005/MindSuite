import './style.css';
import { createApi } from './api';
import { createReleaseWatch } from './release';
import { createWatch, WATCH_INTERVAL_MS } from './watch';
import { renderScreen, renderSession } from './shell/Shell';
import { screenFor, type Session } from '../packages/core/src/taskmind';

const root = document.querySelector<HTMLDivElement>('#app')!;
const release = createReleaseWatch();
const api = createApi({ release: release.see });
const first = await api.session();
const screen = screenFor(first);
if (screen === 'signedIn') {
  // screenFor answers signedIn only for a reply whose body is a well-formed session.
  renderSession(root, first!.body as Session);
  // A signed-out or removed member's view closes at once; a new release is loaded at the next tick. Nothing is stored in the browser.
  const watch = createWatch({
    load: api.session, release, hidden: () => document.hidden,
    closed: closedScreen => { renderScreen(root, closedScreen); clearInterval(timer); },
    reload: () => location.reload(),
  });
  const timer = setInterval(() => void watch.tick(), WATCH_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => void watch.tick());
} else {
  renderScreen(root, screen);
}
