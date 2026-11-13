const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');
const { publicEnvCacheVersion } = require('./metro-cache');

const config = getDefaultConfig(__dirname);
config.watchFolders = [...new Set([...(config.watchFolders || []), path.resolve(__dirname, '../..')])];
// See metro-cache.js: a changed EXPO_PUBLIC_* (EXPO_PUBLIC_API_URL) must not
// be answered from a warm transform cache.
config.cacheVersion = publicEnvCacheVersion(process.env, config.cacheVersion);

module.exports = config;
