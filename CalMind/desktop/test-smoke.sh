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
for APPNAME in CalMind ChefMind; do
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
# Run ChefMind's real install block with a stopped app and a disposable Applications folder.
python3 - "$HERE/../../ChefMind/tools/build-platforms.sh" "$OUT/install.sh" "$OUT/Applications" <<'PYTEST'
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
test "$(cat "$SMOKE_CALLS")" = $'verify\nverify' || { echo 'ChefMind skipped installed-copy signing' >&2; exit 1; }
echo 'ChefMind installed-copy signing passed'
