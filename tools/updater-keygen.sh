#!/bin/sh
# Create, inspect or back up one app's Tauri update-signing key (see tools/updater-keygen.mjs).
exec node "$(dirname "$0")/updater-keygen.mjs" "$@"
