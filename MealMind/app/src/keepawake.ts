/**
 * Keep the screen on while Cook is open — native half. `expo-keep-awake` is
 * already in node_modules (expo depends on it) and already linked in the iOS
 * project, so this adds no native dependency. The web half is keepawake.web.ts.
 * Returns whether the screen is being held on, so the screen can say so only
 * when it is true.
 */
import { useEffect, useState } from 'react';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';

const TAG = 'mealmind-cook';

export function useScreenAwake(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let dead = false;
    activateKeepAwakeAsync(TAG).then(() => { if (!dead) setOn(true); }).catch(() => {});
    return () => { dead = true; deactivateKeepAwake(TAG).catch(() => {}); };
  }, []);
  return on;
}
