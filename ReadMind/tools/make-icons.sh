#!/bin/sh
# Rasterize ReadMind's mark into the three icons public/index.php links.
# assets/logo.svg (rounded cut) is the source of truth; assets/logo-square.svg
# is the same mark full-bleed for the iOS touch icon, which iOS masks itself.
# Headless Chrome renders the SVG, as in AcctMind/tools/make-icons.sh: no
# image toolchain is added for an icon. Dev-time only; the app stays build-free.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[ -x "$CHROME" ] || { echo "Chrome not found at $CHROME — needed to rasterize the SVG" >&2; exit 1; }
TMP="${TMPDIR:-/tmp}/readmind-icons-$$"
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT

# $1 = pixel size, $2 = destination, $3 = source svg
render() {
  size="$1"; dest="$2"; src="$3"
  printf '<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent}svg{display:block;width:%spx;height:%spx}</style>' "$size" "$size" > "$TMP/page.html"
  cat "$src" >> "$TMP/page.html"
  "$CHROME" --headless --disable-gpu --no-sandbox --hide-scrollbars --user-data-dir="$TMP/chrome" \
    --force-device-scale-factor=1 --default-background-color=00000000 \
    --screenshot="$TMP/out.png" --window-size="$size,$size" "file://$TMP/page.html" > "$TMP/chrome.log" 2>&1 \
    || { cat "$TMP/chrome.log" >&2; exit 1; }
  [ -f "$TMP/out.png" ] || { echo "Chrome produced nothing at ${size}px" >&2; exit 1; }
  mv "$TMP/out.png" "$dest"
  printf '  %-32s %s\n' "${dest#"$ROOT"/}" "${size}x${size}"
}

render 180 "$ROOT/public/icon-180.png" "$ROOT/assets/logo-square.svg"
render 192 "$ROOT/public/icon-192.png" "$ROOT/assets/logo.svg"
render 512 "$ROOT/public/icon-512.png" "$ROOT/assets/logo.svg"
