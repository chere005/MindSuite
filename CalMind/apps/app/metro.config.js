// Expo's default Metro config, plus ONE change: the cache key carries the
// EXPO_PUBLIC_* values (#80).
//
// WHY. babel-preset-expo inlines `process.env.EXPO_PUBLIC_*` into the code at
// TRANSFORM time in a production export, and Metro caches transforms by the
// source file and config — not by the environment. So `EXPO_PUBLIC_API_URL`
// silently did nothing on a warm cache: the export reused the transform of
// config.ts from a run without it, where the build-time branch had been
// compiled away. Worse, the reverse held too — after one export pointed at
// test, the next plain export could reuse THAT transform and ship a prod
// bundle calling the test server. Found 2026-11-09 by building a test-pointed
// desktop app and reading the bundle: no build-time branch in it at all.
//
// Folding the values into `cacheVersion` makes each environment its own set
// of cache entries, for the web export, the desktop shell and the native
// bundles alike. Hashed, so the cache key holds no URL. ALWAYS appended, even
// with none set: entries written before this file existed live under the bare
// default key and may carry a test URL inlined, so the unset case must not
// read them either (one cold export per machine, once).
const { createHash } = require('node:crypto');
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);
config.watchFolders = [...new Set([...(config.watchFolders || []), path.resolve(__dirname, '../../..')])];

const publicEnv = Object.keys(process.env)
  .filter((k) => k.startsWith('EXPO_PUBLIC_') && process.env[k] != null)
  .sort()
  .map((k) => `${k}=${process.env[k]}`)
  .join('\n');

const digest = createHash('sha256').update(publicEnv).digest('hex').slice(0, 16);
config.cacheVersion = `${config.cacheVersion ?? ''}+env.${digest}`;

module.exports = config;
