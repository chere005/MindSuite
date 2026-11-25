#!/bin/sh
# tools/publish-update.sh against a stub gh and a stub publish tool: no network, no key, nothing signed or uploaded.
#
#   sh tools/test-publish-update.sh        (npm run test:lane)
#
# It proves the lane's own gates: a draft release is refused; a Windows installer whose SHA-256 the workflow's windows job did
# not print into its run log (swapped on the release after the build) is never handed to the signing tool; a missing installer
# is refused; and the good case passes the right files and the right app to the tool. The signing tool itself is tested at the
# suite root (tools/ci/test-publish-update.sh).
set -eu
cd "$(dirname "$0")/.."
ROOT=$(pwd)
T=$(mktemp -d "${TMPDIR:-/tmp}/mealmind-pu-test.XXXXXX")
trap 'rm -rf "$T"' EXIT
VERSION=$(node -p 'JSON.parse(require("fs").readFileSync("package.json")).version')
MSI="MealMind_${VERSION}_x64_en-US.msi"; EXE="MealMind_${VERSION}_x64-setup.exe"
PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1" >&2; }

mkdir -p "$T/assets" "$T/bin"
printf 'msi bytes\n' > "$T/assets/$MSI"; printf 'exe bytes\n' > "$T/assets/$EXE"
SUM_MSI=$(shasum -a 256 "$T/assets/$MSI" | cut -d' ' -f1); SUM_EXE=$(shasum -a 256 "$T/assets/$EXE" | cut -d' ' -f1)

# The stub gh: STATE is read from files in $T, so each case sets them up.
cat > "$T/bin/gh" <<'STUB'
#!/bin/sh
T=$STUB_DIR
case "$1 $2" in
  "release view") cat "$T/draft" ;;
  "release download")
    while [ $# -gt 0 ]; do [ "$1" = --dir ] && dir=$2; shift; done
    for f in "$T"/serve/*; do [ -f "$f" ] && cp "$f" "$dir/"; done ;;
  "run list") echo 4242 ;;
  "run view")
    case "$*" in
      *--log*) cat "$T/runlog" ;;
      *) echo 777 ;;
    esac ;;
  *) echo "stub gh: unexpected: $*" >&2; exit 9 ;;
esac
STUB
chmod +x "$T/bin/gh"
# The stub tool records its arguments.
cat > "$T/tool.mjs" <<'STUB'
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.STUB_DIR + '/tool-args', process.argv.slice(2).join('\n') + '\n');
STUB

run_case() { # name expect(0|1) ; uses $T/draft $T/serve $T/runlog
  rm -f "$T/tool-args"
  set +e
  STUB_DIR=$T GH="$T/bin/gh" MEALMIND_UPDATE_REPO=owner/MindSuite MEALMIND_INSTALLED_APP=/stub/MealMind.app \
    MINDSUITE_PUBLISH_UPDATE_TOOL="$T/tool.mjs" sh "$ROOT/tools/publish-update.sh" "$@" >"$T/out" 2>&1
  rc=$?
  set -e
}
digest_log() { # lines the windows job prints, wrapped in runner noise
  printf '2026-11-23T01:02:03Z MINDSUITE-DIGEST sha256 %s %s\r\n2026-11-23T01:02:03Z MINDSUITE-DIGEST sha256 %s %s\r\n' "$SUM_MSI" "$MSI" "$SUM_EXE" "$EXE" > "$T/runlog"
}
serve_all() { rm -rf "$T/serve"; mkdir -p "$T/serve"; cp "$T/assets/$MSI" "$T/assets/$EXE" "$T/serve/"; }

echo "publish-update.sh"
# 1. the good case
printf 'false\n' > "$T/draft"; serve_all; digest_log
run_case
if [ "$rc" = 0 ] && [ -f "$T/tool-args" ]; then ok 'a published release with built installers reaches the signing tool'; else bad "good case (rc=$rc): $(cat "$T/out")"; fi
if grep -qx -- "--app" "$T/tool-args" && grep -qx "MealMind" "$T/tool-args" && grep -qx -- "--version" "$T/tool-args" && grep -qx "$VERSION" "$T/tool-args" \
   && grep -qx "/stub/MealMind.app" "$T/tool-args" && grep -q "/$EXE\$" "$T/tool-args" && grep -q "/$MSI\$" "$T/tool-args" && grep -qx "owner/MindSuite" "$T/tool-args"; then
  ok 'it names the app, the version, the installed app, both installers and the repo'
else bad "tool arguments: $(cat "$T/tool-args" 2>/dev/null)"; fi
# 2. extra options pass through
run_case --dry-run /nowhere
if grep -qx -- "--dry-run" "$T/tool-args" && grep -qx "/nowhere" "$T/tool-args"; then ok 'extra options (--dry-run DIR) pass through'; else bad 'option passthrough'; fi
# 3. a draft
printf 'true\n' > "$T/draft"
run_case
if [ "$rc" != 0 ] && [ ! -f "$T/tool-args" ] && grep -q 'not published' "$T/out"; then ok 'a draft release is refused before anything is signed'; else bad "draft (rc=$rc)"; fi
printf 'false\n' > "$T/draft"
# 4. an installer swapped after the build
printf 'tampered\n' > "$T/serve/$EXE"
run_case
if [ "$rc" != 0 ] && [ ! -f "$T/tool-args" ] && grep -q 'is not a file the' "$T/out"; then ok 'an installer whose digest the workflow never printed is refused'; else bad "swapped (rc=$rc): $(cat "$T/out")"; fi
# 5. no digest in any run log at all
serve_all; : > "$T/runlog"
run_case
if [ "$rc" != 0 ] && [ ! -f "$T/tool-args" ]; then ok 'no printed digests means no signature'; else bad "no log (rc=$rc)"; fi
# 6. a digest for the right name but another hash
digest_log; sed -i '' "s/$SUM_MSI/$(printf '%064d' 0)/" "$T/runlog"
run_case
if [ "$rc" != 0 ] && [ ! -f "$T/tool-args" ]; then ok 'a printed digest of another file is not enough'; else bad "wrong hash (rc=$rc)"; fi
# 7. a missing installer
digest_log; serve_all; rm "$T/serve/$MSI"
run_case
if [ "$rc" != 0 ] && [ ! -f "$T/tool-args" ] && grep -q 'expected one' "$T/out"; then ok 'a missing installer is refused'; else bad "missing (rc=$rc)"; fi

echo "$PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
