#!/bin/bash
# Test the update-feed tools (publish-update, updater-keygen, updater-keychain): builds the Rust signature verifier in the
# updater harness (heavy: it holds the suite's heavy-build lock), then runs the node tests against it.
#   bash tools/ci/test-publish-update.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=$PWD
cd CalMind
# shellcheck source=../../CalMind/tools/heavy-lock.sh
. tools/heavy-lock.sh
heavy_lock 'updater harness verifier build'
cd "$ROOT/tools/updater-harness"
cargo build --locked --example verify_sig
target=$(cargo metadata --locked --format-version 1 --no-deps | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).target_directory)')
heavy_unlock
cd "$ROOT"
MIND_VERIFY_SIG_BIN="$target/debug/examples/verify_sig" node --test tools/test-publish-update.mjs
