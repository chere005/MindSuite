// Expo's default Metro config, plus ONE change: Metro watches the suite root.
//
// WHY. packages/core depends on @mind/core by a file: link
// (node_modules/@mind/core -> ../packages/mind-core), and its stubs re-export
// the bodies in ../packages/mind-core/src. That package lives OUTSIDE this
// app's workspace, which is all Expo watches by default, and Metro refuses to
// bundle a file outside its watch folders. Same line as CalMind's and
// ChefMind's metro.config.js.
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);
config.watchFolders = [...new Set([...(config.watchFolders || []), path.resolve(__dirname, '../../..')])];

module.exports = config;
