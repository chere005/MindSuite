import AsyncStorage from '@react-native-async-storage/async-storage';

/** The rename changed the first word of the app's storage prefix. */
export const formerMealStorageKey = (key: string): string => key.replace(/^meal(?=mind\.)/, 'chef');

/** Carry forward this installation's session and pending edits on first read. */
export async function readMealStorage(key: string): Promise<string | null> {
  try {
    const current = await AsyncStorage.getItem(key);
    if (current !== null) return current;
    const oldKey = formerMealStorageKey(key);
    const previous = await AsyncStorage.getItem(oldKey);
    if (previous !== null) {
      await AsyncStorage.setItem(key, previous)
        .then(() => AsyncStorage.removeItem(oldKey))
        .catch(() => {});
    }
    return previous;
  } catch {
    return null;
  }
}

export async function forgetMealStorage(key: string): Promise<void> {
  // Clear both keys so a failed migration cannot restore a signed-out session
  // or a deleted account's snapshot on the next launch.
  for (const storedKey of [formerMealStorageKey(key), key]) {
    await AsyncStorage.removeItem(storedKey)
      .catch(() => AsyncStorage.setItem(storedKey, 'null').catch(() => {}));
  }
}
