#!/bin/sh
# The desktop shell's own tests: the shared updater (desktop/src-tauri/src/updater.rs) against a local fixture feed and a mock
# app. cargo test runs under the suite's heavy-build lock, because a cold build of tauri is heavy. Nothing leaves the machine.
set -eu
cd "$(dirname "$0")/.."
command -v cargo >/dev/null || { echo 'test-native: Rust (cargo) is required.' >&2; exit 1; }
. tools/heavy-lock.sh
heavy_lock 'AcctMind desktop cargo test'
_rc=0
(cd desktop/src-tauri && cargo test --locked) || _rc=$?
heavy_unlock
exit "$_rc"
