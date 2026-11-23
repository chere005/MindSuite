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
heavy_unlock
exit "$_rc"
