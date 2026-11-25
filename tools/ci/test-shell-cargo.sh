#!/bin/bash
# `cargo test --locked` of one app's Tauri shell (its updater against a local fixture feed, sign-in, ...), under the heavy-build lock.
#   bash tools/ci/test-shell-cargo.sh CalMind desktop/src-tauri
set -euo pipefail
cd "$(dirname "$0")/../.."
[ $# -eq 2 ] || { echo "usage: test-shell-cargo.sh <App> <shell dir inside the app>" >&2; exit 2; }
[ -f "$1/$2/Cargo.toml" ] || { echo "no $1/$2/Cargo.toml" >&2; exit 2; }
# shellcheck source=../../CalMind/tools/heavy-lock.sh
. CalMind/tools/heavy-lock.sh
heavy_lock "$1 shell cargo test"
(cd "$1/$2" && cargo test --locked)
heavy_unlock
