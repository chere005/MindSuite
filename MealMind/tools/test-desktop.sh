#!/bin/sh
# The desktop shell's own tests: cargo test of desktop/src-tauri (the shared updater against a local fixture feed and a mock
# app, plus the shell's sign-in listener). Nothing leaves the machine. A cold build of tauri is heavy, so it runs under the
# suite's heavy-build lock.
#
#   sh tools/test-desktop.sh            (npm run test:desktop; npm test and tdtp run it)
#
# tauri-build refuses a config whose frontendDist does not exist, so a throwaway one-file stand-in for desktop/dist-desktop
# is made when there is none (the real one is staged by `tauri build`) and removed afterwards; a real staged one is never
# touched. The tests never load the page.
set -eu
cd "$(dirname "$0")/.."
command -v cargo >/dev/null || { echo 'test-desktop: Rust (cargo) is required.' >&2; exit 1; }
. tools/heavy-lock.sh
heavy_lock 'MealMind desktop cargo test'
STAND_IN=0
if [ ! -d desktop/dist-desktop ]; then
  mkdir -p desktop/dist-desktop
  printf '<!doctype html><title>stand-in</title>\n' > desktop/dist-desktop/index.html
  STAND_IN=1
fi
_rc=0
(cd desktop/src-tauri && cargo test --locked) || _rc=$?
[ "$STAND_IN" = 0 ] || rm -rf desktop/dist-desktop
heavy_unlock
exit "$_rc"
