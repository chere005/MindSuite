// Metro cache key for Expo's build-time env inlining.
//
// Expo inlines EXPO_PUBLIC_* into the bundle at TRANSFORM time, and Metro's
// transform cache is keyed on file content + config, not on the environment.
// So after EXPO_PUBLIC_API_URL changed, a warm cache kept serving modules that
// still carried the OLD url (config.ts), silently pointing the build at the
// wrong server. Metro's `cacheVersion` is part of every transform cache key,
// so folding the public env into it makes a changed value a cache miss
// instead of a stale hit. An unchanged env hashes the same, so warm caches
// keep working. (Clearing the cache in the build scripts would miss `expo
// start` and hand-run exports; this holds for every entry point.)
const crypto = require('crypto');

function publicEnvCacheVersion(env, base = '1.0') {
  const pairs = Object.keys(env)
    .filter((k) => k.startsWith('EXPO_PUBLIC_') && env[k] != null)
    .sort()
    .map((k) => `${k}=${env[k]}`);
  if (pairs.length === 0) return base;
  return `${base}+${crypto.createHash('sha1').update(pairs.join('\n')).digest('hex').slice(0, 12)}`;
}

module.exports = { publicEnvCacheVersion };
