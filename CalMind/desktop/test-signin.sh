#!/bin/sh
# The desktop shell's sign-in listener (src-tauri/src/signin.rs) is std only, so rustc builds and tests it alone: no
# cargo, no tauri, no window, no browser. It binds 127.0.0.1 on a system-picked port and talks to itself.
#
#   sh desktop/test-signin.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$(mktemp -d "${TMPDIR:-/tmp}/signin-test.XXXXXX")" || exit 1
trap 'rm -rf "$OUT"' EXIT INT TERM
rustc --edition 2021 --test "$HERE/src-tauri/src/signin.rs" -o "$OUT/signin-test" 2>"$OUT/build.log" || { cat "$OUT/build.log"; exit 1; }
"$OUT/signin-test"
