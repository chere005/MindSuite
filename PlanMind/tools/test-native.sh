#!/bin/sh
# The native shell's own tests (the navigation allowlist and the shared updater against a local fixture feed): cargo test
# under the suite's heavy-build lock, because a cold build of tauri is heavy. Nothing leaves the machine.
set -eu
cd "$(dirname "$0")/.."
command -v cargo >/dev/null || { echo 'test-native: Rust (cargo) is required.' >&2; exit 1; }
. tools/heavy-lock.sh
heavy_lock 'PlanMind native cargo test'
_rc=0
(cd native/src-tauri && cargo test --locked) || _rc=$?
# The phone build compiles the same tauri.conf.json (its plugins block expands into code that needs serde_json) but not the
# updater: a type-check of the library for iOS catches a dependency that is only declared for the desktop targets.
if [ "$_rc" = 0 ] && command -v rustup >/dev/null 2>&1 && rustup target list --installed 2>/dev/null | grep -qx aarch64-apple-ios; then
  (cd native/src-tauri && cargo check --locked --lib --target aarch64-apple-ios) || _rc=$?
fi
heavy_unlock
exit "$_rc"
