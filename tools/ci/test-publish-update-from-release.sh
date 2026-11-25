#!/bin/bash
# Proves tools/publish-update-from-release.sh with a stub gh and a stub publisher and a real (tiny) dmg: nothing leaves the machine.
#   bash tools/ci/test-publish-update-from-release.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
SCRIPT="$PWD/tools/publish-update-from-release.sh"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/pufr-test.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

# the fixture release: dmg (holding Example.app), installers, checksums
V=2.5.0
mkdir -p "$tmp/rel" "$tmp/dmgsrc/Example.app/Contents/MacOS" "$tmp/bin"
printf 'x' > "$tmp/dmgsrc/Example.app/Contents/MacOS/example"
hdiutil create -quiet -srcfolder "$tmp/dmgsrc" -format UDZO -volname Example "$tmp/rel/Example_${V}_aarch64.dmg"
printf 'nsis' > "$tmp/rel/Example_${V}_x64-setup.exe"
printf 'msi' > "$tmp/rel/Example_${V}_x64_en-US.msi"
printf 'deb' > "$tmp/rel/Example_${V}_amd64.deb"
(cd "$tmp/rel" && sha256() { shasum -a 256 "$1" | awk '{print $1}'; }
 for f in *; do printf '%s  %s\n' "$(sha256 "$f")" "$f"; done > "$tmp/SHA256SUMS.txt")
cp "$tmp/SHA256SUMS.txt" "$tmp/rel/SHA256SUMS.txt"

# stub gh: release view (state from $STATE_FILE), release download (copies matching patterns), repo view
cat > "$tmp/bin/gh" <<'SH'
#!/bin/bash
echo "gh $*" >> "$CALLS"
case "$1 $2" in
  "release view") s=$(cat "$STATE_FILE"); [ "$s" != missing ] || exit 1; echo "$s" ;;
  "release download")
    shift 2; dir=; pats=()
    while [ $# -gt 0 ]; do case "$1" in --dir) dir=$2; shift 2 ;; --pattern) pats+=("$2"); shift 2 ;; *) shift ;; esac; done
    for p in "${pats[@]}"; do for f in "$REL"/$p; do [ -f "$f" ] && cp "$f" "$dir/"; done; done ;;
  "repo view") echo owner/Suite ;;
esac
SH
cat > "$tmp/bin/publish" <<'SH'
#!/bin/bash
echo "publish $*" >> "$CALLS"
[ -z "${PUBLISH_FAIL:-}" ] || exit 1
# the app handed over must be the one from the dmg
app=; prev=; for a in "$@"; do [ "$prev" = --mac-app ] && app=$a; prev=$a; done
[ -f "$app/Contents/MacOS/example" ] || { echo "no app" >&2; exit 1; }
SH
chmod +x "$tmp/bin/"*
export CALLS="$tmp/calls" STATE_FILE="$tmp/state" REL="$tmp/rel" MIND_GH="$tmp/bin/gh" MIND_PUBLISH_UPDATE="$tmp/bin/publish" MIND_POLL=1
run() { bash "$SCRIPT" Example "Example/$V" "$V" --repo owner/Suite "$@"; }

# 1. a published release: downloads, checks, publishes with the mac app, both Windows installers and the repo
: > "$CALLS"; echo false > "$STATE_FILE"
run --wait 3 > "$tmp/out" 2>&1 || { cat "$tmp/out" >&2; fail 'a published release was refused'; }
line=$(grep '^publish ' "$CALLS")
for want in "--app Example" "--version $V" "--repo owner/Suite" "--mac-app " "--win-nsis " "-setup.exe" "--win-msi " ".msi"; do
  case "$line" in *"$want"*) ;; *) fail "the publisher call lacks '$want': $line" ;; esac
done
[ "$(grep -c '^publish ' "$CALLS")" = 1 ] || fail 'the publisher ran more than once'
case "$line" in *--sign-with-prev-key*) fail 'the previous key is used without being asked' ;; esac
# the transitional release of a key rotation: the flag, or MIND_SIGN_WITH_PREV_KEY=1, reaches the publisher
: > "$CALLS"; run --wait 3 --sign-with-prev-key > "$tmp/out" 2>&1 || fail '--sign-with-prev-key was refused'
grep '^publish ' "$CALLS" | grep -q -- '--sign-with-prev-key' || fail '--sign-with-prev-key was not passed on'
: > "$CALLS"; MIND_SIGN_WITH_PREV_KEY=1 run --wait 3 > "$tmp/out" 2>&1 || fail 'MIND_SIGN_WITH_PREV_KEY was refused'
grep '^publish ' "$CALLS" | grep -q -- '--sign-with-prev-key' || fail 'MIND_SIGN_WITH_PREV_KEY was not passed on'

# 2. a draft is waited for, then given up on, and nothing is published
: > "$CALLS"; echo true > "$STATE_FILE"
if run --wait 2 > "$tmp/out" 2>&1; then fail 'a draft release was published from'; fi
grep -q 'not published after' "$tmp/out" || fail 'the wait was not explained'
grep -q '^publish ' "$CALLS" && fail 'a draft reached the publisher'
# ... and one that is published while it waits
: > "$CALLS"; echo true > "$STATE_FILE"; ( sleep 2; echo false > "$STATE_FILE" ) &
run --wait 20 > "$tmp/out" 2>&1 || { cat "$tmp/out" >&2; fail 'a release published during the wait was missed'; }
wait

# 3. a missing release
: > "$CALLS"; echo missing > "$STATE_FILE"
if run --wait 1 > "$tmp/out" 2>&1; then fail 'a missing release was published from'; fi

# 4. refusals before anything is signed: a changed file, a missing installer, a missing checksum list, a wrong tag
echo false > "$STATE_FILE"
refuse() { # name, mutate-command...
  local name=$1; shift
  rm -rf "$tmp/rel2"; cp -R "$tmp/rel" "$tmp/rel2"
  ( cd "$tmp/rel2" && "$@" )
  : > "$CALLS"
  if REL="$tmp/rel2" run --wait 1 > "$tmp/out" 2>&1; then fail "$name was accepted"; fi
  grep -q '^publish ' "$CALLS" && fail "$name reached the publisher"
  return 0
}
refuse 'a tampered msi' sh -c "printf 'evil' > Example_${V}_x64_en-US.msi"
refuse 'a missing nsis' rm "Example_${V}_x64-setup.exe"
refuse 'no checksum list' rm SHA256SUMS.txt
refuse 'a file the checksums do not list' sh -c "grep -v 'x64-setup' SHA256SUMS.txt > s && mv s SHA256SUMS.txt"
if bash "$SCRIPT" Example "Example/9.9.9" "$V" --repo owner/Suite > "$tmp/out" 2>&1; then fail 'a tag that is not the app/version was accepted'; fi
if bash "$SCRIPT" 'Ex ample' "Ex ample/$V" "$V" > "$tmp/out" 2>&1; then fail 'a bad app name was accepted'; fi

# 5. the publisher failing fails the script; --dry-run passes the directory and installs nothing
: > "$CALLS"
if PUBLISH_FAIL=1 run > "$tmp/out" 2>&1; then fail 'a failed publisher was reported as success'; fi
: > "$CALLS"
run --dry-run "$tmp/dry" > "$tmp/out" 2>&1 || fail '--dry-run failed'
grep '^publish ' "$CALLS" | grep -q -- "--dry-run $tmp/dry" || fail '--dry-run was not passed on'

echo 'publish-update-from-release guards passed'
