#!/bin/bash
# Compile and test the shared Tauri updater (CalMind/desktop/src-tauri/src/updater.rs) in its harness crate, against a
# local fixture feed. Heavy (a cargo build of tauri): it holds the suite's heavy-build lock.
#   bash tools/ci/test-updater.sh [cargo test args]
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=$PWD
cd CalMind
# shellcheck source=../../CalMind/tools/heavy-lock.sh
. tools/heavy-lock.sh
heavy_lock 'updater harness cargo test'
cd "$ROOT/tools/updater-harness"
# Keep build output out of the repo checkout when asked (a scratch target dir), else beside the crate (ignored).
cargo test --locked "$@"
heavy_unlock
