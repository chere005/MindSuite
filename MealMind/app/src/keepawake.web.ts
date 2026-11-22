/**
 * Keep the screen on while Cook is open — web half: the Screen Wake Lock API,
 * guarded (not every browser has it, and a request can be refused, e.g. on low
 * battery), released on unmount, and asked for again when the tab comes back
 * to the front (the browser drops the lock whenever the page is hidden).
 */
import { useEffect, useState } from 'react';

type Lock = { released?: boolean; release: () => Promise<void> };

export function useScreenAwake(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let dead = false;
    let lock: Lock | null = null;
    const ask = async () => {
      try {
        const wl = (navigator as unknown as { wakeLock?: { request: (t: 'screen') => Promise<Lock> } }).wakeLock;
        if (!wl) return;
        const l = await wl.request('screen');
        if (dead) { l.release().catch(() => {}); return; }
        lock = l;
        setOn(true);
      } catch {
        if (!dead) setOn(false);
      }
    };
    void ask();
    const back = () => { if (document.visibilityState === 'visible' && (!lock || lock.released)) void ask(); };
    document.addEventListener('visibilitychange', back);
    return () => {
      dead = true;
      document.removeEventListener('visibilitychange', back);
      try { lock?.release().catch(() => {}); } catch { /* already released */ }
    };
  }, []);
  return on;
}
