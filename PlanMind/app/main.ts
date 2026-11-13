import './style.css';
import { createApi } from './api';
import { parsePlace } from './place';
import { createReleaseWatch } from './release';
import { createState, type AppState } from './state';
import { mountShell, renderClosed, renderUnavailable } from './shell/Shell';
import { setPeople, type Session } from '../packages/core/src/planner';

const root = document.querySelector<HTMLDivElement>('#app')!;
// A page that reloaded itself for a new release left where the person was in the hash; it is read once and cleared, so the URL is the plain one again.
const place = parsePlace(location.hash);
if (location.hash) { try { history.replaceState(null, '', location.pathname + location.search); } catch { /* the hash stays; it is read once per load anyway */ } }
let csrf = '', state: AppState | undefined, closed = false;
// A 401 or 403 closes the view at once, before or after the shell exists.
const release = createReleaseWatch();
const api = createApi({ csrf: () => csrf, signedOut: () => { closed = true; if (state) { state.close(); } else { renderClosed(root); } }, release: release.see });
try {
  const first = await api.load() as Session;
  csrf = first.csrf;
  // Which account holds each role comes only from the server (its private config); a session without the two people is not opened.
  setPeople(first.people);
  state = createState(first, { load: api.load, send: api.send, setTheme: api.setTheme, calmind: api.calmind, setCalmind: api.setCalmind, setBothColor: api.setBothColor, hidden: () => document.hidden, release }, place ?? undefined);
  mountShell(root, state, place?.tab);
} catch {
  if (!closed) { renderUnavailable(root); }
}
