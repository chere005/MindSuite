#!/bin/bash
# Exercise the real smoke script with a disposable bundle and mocked OS commands; no app or window is opened.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$(mktemp -d "${TMPDIR:-/tmp}/desktop-smoke-test.XXXXXX")
trap 'rm -rf "$OUT"' EXIT
mkdir -p "$OUT/desktop/src-tauri/target/release/bundle/macos/CalMind.app/Contents/MacOS" "$OUT/apps/app/dist" "$OUT/bin"
cp "${1:-$HERE/smoke.sh}" "$OUT/desktop/smoke.sh"
printf '%s\n' '#!/bin/sh' '# index-a1b2c3.js' > "$OUT/desktop/src-tauri/target/release/bundle/macos/CalMind.app/Contents/MacOS/calmind-desktop"
chmod +x "$OUT/desktop/src-tauri/target/release/bundle/macos/CalMind.app/Contents/MacOS/calmind-desktop"
printf '%s\n' '<script src="index-a1b2c3.js"></script>' > "$OUT/apps/app/dist/index.html"
printf '%s\n' '#!/bin/sh' 'exit 0' > "$OUT/desktop/check-assets.sh"
cat > "$OUT/bin/codesign" <<'SH'
#!/bin/sh
printf 'verify\n' >> "$SMOKE_CALLS"
test "$SMOKE_SIGNATURE" = valid
SH
cat > "$OUT/bin/open" <<'SH'
#!/bin/sh
printf 'open %s\n' "$1" >> "$SMOKE_CALLS"
SH
printf '%s\n' '#!/bin/sh' 'exit 1' > "$OUT/bin/pgrep"
printf '%s\n' '#!/bin/sh' 'exit 0' > "$OUT/bin/sleep"
chmod +x "$OUT/bin/"*
export PATH="$OUT/bin:$PATH" SMOKE_CALLS="$OUT/calls"
export SMOKE_SIGNATURE=invalid
if bash "$OUT/desktop/smoke.sh" --no-build > "$OUT/log" 2>&1; then echo 'invalid signature was accepted' >&2; exit 1; fi
test "$(cat "$SMOKE_CALLS")" = verify || { echo 'an invalid bundle reached launch' >&2; exit 1; }
: > "$SMOKE_CALLS"
export SMOKE_SIGNATURE=valid
# The stand-in process never launches, so the rest of the smoke intentionally fails. Its OS call order is what matters here.
bash "$OUT/desktop/smoke.sh" --no-build > "$OUT/log" 2>&1 || :
test "$(cat "$SMOKE_CALLS")" = $'verify\nopen -g' || { echo 'a verified bundle did not launch in the background' >&2; exit 1; }
echo 'desktop smoke signature and background-launch guards passed'

# The build lane must repair its fresh local bundle before the smoke sees it; a signing error stops the lane.
for APPNAME in MealMind; do
  python3 - "$HERE/../../$APPNAME/tools/build-platforms.sh" "$OUT/sign-built.sh" <<'PYTEST'
import sys
from pathlib import Path
text=Path(sys.argv[1]).read_text()
start=text.index('  codesign --force --deep --sign - "$APPBUNDLE"')
end=text.index("\n", text.index("the built app signature could not be verified",start))
Path(sys.argv[2]).write_text(text[start:end]+"\nprintf 'smoke\\n' >> \"$SMOKE_CALLS\"\n")
PYTEST
  : > "$SMOKE_CALLS"
  export APPBUNDLE="$OUT/fixture.app" SMOKE_SIGNATURE=valid
  bash "$OUT/sign-built.sh" > "$OUT/log" 2>&1
  test "$(cat "$SMOKE_CALLS")" = $'verify\nverify\nsmoke'
  : > "$SMOKE_CALLS"
  export SMOKE_SIGNATURE=invalid
  if bash "$OUT/sign-built.sh" > "$OUT/log" 2>&1; then echo 'failed bundle signing was accepted' >&2; exit 1; fi
  test "$(cat "$SMOKE_CALLS")" = verify
done
echo 'fresh local bundle signing guards passed'
# CalMind's real Mac block (after the build): signed and notarized FIRST, the signed copy smoked, then that same copy installed
# with --already-signed; never ad hoc, and a failed step stops the ones after it. mac-sign-install.sh and the smoke are stubs.
python3 - "$HERE/../tools/build-platforms.sh" "$OUT/cal-block.sh" "$OUT/Applications" <<'PYTEST'
import sys
from pathlib import Path
text=Path(sys.argv[1]).read_text()
start=text.index('  APPNAME=$(basename "$APPBUNDLE" .app)')
end=text.index('  heavy_unlock',start)
block=text[start:end]
assert 'sign -"' not in block and "--sign -" not in block, 'an ad hoc signing call is back in the Mac block'
Path(sys.argv[2]).write_text(block.replace('/Applications',sys.argv[3]))
PYTEST
FAKE="$OUT/fake"
mkdir -p "$FAKE/tools" "$FAKE/desktop" "$OUT/Applications"
cat > "$FAKE/tools/mac-sign-install.sh" <<'SH'
#!/bin/sh
echo "sign-install $*" >> "$SMOKE_CALLS"
case " $* " in
  *" --already-signed "*)
    [ -z "${FAIL_INSTALL:-}" ] || exit 1
    for a; do app=$a; done
    [ -f "$app/SIGNED" ] || exit 1
    mkdir -p "$INSTALL_DIR"; rm -rf "$INSTALL_DIR/$(basename "$app")"; cp -R "$app" "$INSTALL_DIR/"; exit 0 ;;
esac
out=; app=
while [ $# -gt 0 ]; do case "$1" in --out) out=$2; shift 2 ;; --no-install) shift ;; *) app=$1; shift ;; esac; done
[ -z "${FAIL_SIGN:-}" ] || exit 1
mkdir -p "$out"; cp -R "$app" "$out/"; touch "$out/$(basename "$app")/SIGNED"
SH
cat > "$FAKE/desktop/smoke.sh" <<'SH'
#!/bin/sh
echo "smoke signed=$([ -f "$ROOT/desktop/src-tauri/target/release/bundle/macos/CalMind.app/SIGNED" ] && echo yes || echo no)" >> "$SMOKE_CALLS"
[ -z "${FAIL_SMOKE:-}" ]
SH
chmod +x "$FAKE/tools/mac-sign-install.sh"
cal_block() { # env assignments...
  rm -rf "$FAKE/desktop/src-tauri" "$OUT/Applications"/*; : > "$SMOKE_CALLS"
  mkdir -p "$FAKE/desktop/src-tauri/target/release/bundle/macos/CalMind.app/Contents/MacOS"
  printf 'x' > "$FAKE/desktop/src-tauri/target/release/bundle/macos/CalMind.app/Contents/MacOS/calmind-desktop"
  env ROOT="$FAKE" INSTALL_DIR="$OUT/Applications" APPBUNDLE="$FAKE/desktop/src-tauri/target/release/bundle/macos/CalMind.app" "$@" bash "$OUT/cal-block.sh" > "$OUT/log" 2>&1
}
cal_block X=1 || { cat "$OUT/log" >&2; echo 'the CalMind Mac block failed on the good path' >&2; exit 1; }
test "$(cat "$SMOKE_CALLS")" = "$(printf '%s\n' "sign-install --no-install --out $(sed -n 's/^sign-install --no-install --out \([^ ]*\) .*/\1/p' "$SMOKE_CALLS") $FAKE/desktop/src-tauri/target/release/bundle/macos/CalMind.app" 'smoke signed=yes' "sign-install --already-signed --no-relaunch $FAKE/desktop/src-tauri/target/release/bundle/macos/CalMind.app")" \
  || { cat "$SMOKE_CALLS" >&2; echo 'the CalMind Mac block did not sign, smoke the signed copy, then install it' >&2; exit 1; }
test -f "$OUT/Applications/CalMind.app/SIGNED" || { echo 'the installed CalMind copy is not the signed one' >&2; exit 1; }
if cal_block FAIL_SIGN=1; then echo 'a failed signing was accepted' >&2; exit 1; fi
grep -q '^smoke' "$SMOKE_CALLS" && { echo 'an unsigned app was smoked' >&2; exit 1; }
test -z "$(ls -A "$OUT/Applications")" || { echo 'a failed signing still installed something' >&2; exit 1; }
if cal_block FAIL_SMOKE=1; then echo 'a failed smoke was accepted' >&2; exit 1; fi
grep -q -- '--already-signed' "$SMOKE_CALLS" && { echo 'an app that failed its smoke was installed' >&2; exit 1; }
if cal_block FAIL_INSTALL=1; then echo 'a failed install was accepted' >&2; exit 1; fi
echo 'CalMind signed install guards passed'

# Run MealMind's real install block with a stopped app and a disposable Applications folder.
python3 - "$HERE/../../MealMind/tools/build-platforms.sh" "$OUT/install.sh" "$OUT/Applications" <<'PYTEST'
import sys
from pathlib import Path
text=Path(sys.argv[1]).read_text()
start=text.index('  APPNAME=$(basename "$APPBUNDLE" .app)')
end=text.index('  heavy_unlock',start)
Path(sys.argv[2]).write_text(text[start:end].replace('/Applications',sys.argv[3]))
PYTEST
mkdir -p "$OUT/Applications"
: > "$SMOKE_CALLS"
export APPBUNDLE="$OUT/desktop/src-tauri/target/release/bundle/macos/CalMind.app" SMOKE_SIGNATURE=valid
bash "$OUT/install.sh" > "$OUT/log" 2>&1
test "$(cat "$SMOKE_CALLS")" = $'verify\nverify' || { echo 'MealMind skipped installed-copy signing' >&2; exit 1; }
echo 'MealMind installed-copy signing passed'
