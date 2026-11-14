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
