#!/bin/sh
# One shared HTTPS app, persistent login cookies, and no native command bridge.
#
# What a run still owes is listed on the way out (stderr, and PLANMIND_OWED_FILE when dtp.sh sets it): a build that failed
# or never started, and every phone that was offline or locked and so was skipped with a warning (not a failure of the run).
set -eu
cd "$(dirname "$0")/.."
ROOT=$(pwd)
. tools/heavy-lock.sh

# >>> locked-device install (bin/check-locked-install.sh extracts this block)
# devicectl_run is the one seam to devicectl; MIND_DEVICECTL replaces it in
# tests. devicectl_install runs an install, twice at most (the first call
# routinely times out enabling developer disk image services), prints
# devicectl's own words, and when BOTH tries fail with text saying the phone is
# locked or busy, adds ONE line naming that cause rather than leaving the
# caller's generic "paired/registered?" guess to mislead. Status = the install's.
devicectl_run() { ${MIND_DEVICECTL:-xcrun devicectl} "$@"; }
devicectl_install() { # udid bundle [label]
  _DL=$(mktemp "${TMPDIR:-/tmp}/coremind-install.XXXXXX")
  if devicectl_run device install app --device "$1" "$2" </dev/null >"$_DL" 2>&1 \
     || devicectl_run device install app --device "$1" "$2" </dev/null >"$_DL" 2>&1; then
    cat "$_DL"; rm -f "$_DL"; return 0
  fi
  cat "$_DL" >&2
  if grep -Eiq 'is locked|passcode|DeviceLocked|device is busy|unlock (the|your)' "$_DL"; then
    echo "${3:-the phone} is locked — unlock it and re-run the install step" >&2
  fi
  rm -f "$_DL"
  return 1
}
# <<< locked-device install

# Owed installs (tools/retry-installs.sh, shared byte for byte from CoreMind/bin): an install that failed, or a phone that
# was away, is recorded with a saved copy of the build and retried when the phone is back; bookkeeping never fails the lane.
owed_installs() { IOS_PHONES="${IOS_PHONES:-}" sh "$ROOT/tools/retry-installs.sh" "$@" || true; }

DRY=0; MAC=0; IOS=0; WINDOWS=0; PICKED=0
for arg in "$@"; do
  case "$arg" in
    --mac) MAC=1; PICKED=1 ;;
    --ios) IOS=1; PICKED=1 ;;
    --windows) WINDOWS=1; PICKED=1 ;;
    --dry-run) DRY=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 1 ;;
  esac
done
if [ "$PICKED" = 0 ]; then
  case "$(uname -s)" in Darwin) MAC=1; IOS=1 ;; MINGW*|MSYS*) WINDOWS=1 ;; *) echo 'Choose --mac, --ios or --windows on its build host.' >&2; exit 1 ;; esac
fi
if [ "$MAC" = 1 ] && [ "$DRY" = 0 ]; then
  if [ "$(uname -m)" != arm64 ] || [ "${CARGO_BUILD_TARGET:-aarch64-apple-darwin}" != aarch64-apple-darwin ]; then
    echo 'macOS builds require Apple Silicon.' >&2; exit 1
  fi
fi
# UDIDS, NEVER NAMES (the suite's rule): the names after # are for the warnings only. IOS_PHONES replaces the list for one run.
# Never enumerate and install onto every paired phone. The default list and the signing team come from the untracked
# .local/machine.env (tools/machine-env.sh); an iOS run without it stops before building anything, naming the missing key.
. tools/machine-env.sh
if [ "$IOS" = 1 ] && [ "$DRY" = 0 ]; then
  machine_load "$(pwd)" && machine_require APPLE_TEAM_ID PLANMIND_PHONES || exit 1
  [ -n "${IOS_PHONES:-}" ] || IOS_PHONES=$(machine_phones planmind) || exit 1
fi
# What devicectl says when a phone is simply not there to install onto (anything else is a real failure and fails the run).
PHONE_AWAY='locked|not connected|isn.t connected|is not connected|unavailable|not available|offline|unreachable|disconnected|unable to connect|not paired|could not be found|no devices|timed out|timeout|passcode'
if [ "$DRY" = 1 ]; then
  [ "$MAC" = 0 ] || echo 'would: build the PlanMind app on macOS (no dmg: that needs Finder), then install only PlanMind.app'
  [ "$WINDOWS" = 0 ] || echo 'would: build PlanMind msi + exe on Windows'
  [ "$IOS" = 0 ] || echo 'would: build the signed iOS app on macOS (SPACE mounted); install onto the udids in IOS_PHONES (default: the phones listed for it in .local/machine.env), skipping with a warning any phone that is offline or locked'
  exit 0
fi
MAC_DONE=0; WIN_DONE=0; IOS_BUILT=0; PHONES_OWED=''
owed() {   # what this run still owes, one line each
  [ "$MAC" = 0 ] || [ "$MAC_DONE" = 1 ] || echo 'the macOS app (build and install)'
  [ "$WINDOWS" = 0 ] || [ "$WIN_DONE" = 1 ] || echo 'the Windows installers'
  [ "$IOS" = 0 ] || [ "$IOS_BUILT" = 1 ] || echo 'the iOS build and its install on every phone'
  [ -z "$PHONES_OWED" ] || printf '%s' "$PHONES_OWED"
}
finish() {
  _owed=$(owed)
  [ -n "$_owed" ] || return 0
  printf 'build-platforms: still owed:\n' >&2
  printf '%s\n' "$_owed" | sed 's/^/  - /' >&2
  if [ -n "${PLANMIND_OWED_FILE:-}" ]; then printf '%s\n' "$_owed" > "$PLANMIND_OWED_FILE"; fi
}
trap finish EXIT
if [ "$MAC" = 1 ] || [ "$IOS" = 1 ]; then
  [ "$(uname -s)" = Darwin ] || { echo 'macOS and Xcode are required for Apple packages.' >&2; exit 1; }
fi
command -v cargo >/dev/null || { echo 'Rust and the platform build tools are required.' >&2; exit 1; }
if [ "$MAC" = 1 ]; then
  heavy_lock 'PlanMind macOS'
  npm --prefix native ci
  # The dmg needs Finder/AppleScript and fails after a good .app; the Release workflow builds installers.
  (cd native && npm run build -- --bundles app)
  WAS_OPEN=0; if pgrep -x planmind >/dev/null; then WAS_OPEN=1; pkill -x planmind; sleep 1; fi
  rm -rf /Applications/PlanMind.app
  ditto native/src-tauri/target/release/bundle/macos/PlanMind.app /Applications/PlanMind.app
  test -x /Applications/PlanMind.app/Contents/MacOS/planmind
  [ "$WAS_OPEN" = 0 ] || open /Applications/PlanMind.app
  MAC_DONE=1
  heavy_unlock
fi
if [ "$WINDOWS" = 1 ]; then
  case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) ;; *) echo 'Windows (Git Bash) is required for the Windows packages.' >&2; exit 1 ;; esac
  # Tauri links with MSVC: a gnu Rust host or missing Build Tools fails late, inside cargo.
  rustc -vV | grep -q '^host: .*-pc-windows-msvc$' || { echo 'Rust must use the MSVC host (rustup default stable-x86_64-pc-windows-msvc).' >&2; exit 1; }
  # vswhere's location is fixed by the Visual Studio installer.
  VSWHERE='C:/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe'
  [ -n "$("$VSWHERE" -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>/dev/null)" ] \
    || { echo 'Visual Studio Build Tools with the C++ (VC.Tools.x86.x64) workload are required.' >&2; exit 1; }
  VERSION=$(node -p 'JSON.parse(require("fs").readFileSync("native/src-tauri/tauri.conf.json")).version')
  BUNDLE=native/src-tauri/target/release/bundle
  heavy_lock 'PlanMind Windows'
  npm --prefix native ci
  # An old installer left in place would pass the check below after a failed build.
  rm -rf "$BUNDLE/msi" "$BUNDLE/nsis"
  (cd native && npm run build -- --bundles msi,nsis)
  for f in "$BUNDLE/msi/PlanMind_${VERSION}_x64_en-US.msi" "$BUNDLE/nsis/PlanMind_${VERSION}_x64-setup.exe"; do
    [ -s "$f" ] || { echo "The Windows package $f was not built." >&2; exit 1; }
    echo "built: $ROOT/$f"
  done
  WIN_DONE=1
  heavy_unlock
fi
if [ "$IOS" = 1 ]; then
  # iOS DeviceSupport lives on the SPACE drive: mount it first (~/.claude/skills/external-drives/drive.sh mount SPACE).
  [ -d "$HOME/Library/Developer/Xcode/iOS DeviceSupport/." ] || { echo 'iOS DeviceSupport is not reachable: mount SPACE first.' >&2; exit 1; }
  owed_installs   # first: builds owed to phones that were away land before this run's own
  heavy_lock 'PlanMind iOS'
  npm --prefix native ci
  # gen/apple is generated and ignored; regenerating keeps the icons and the team in step with the sources.
  rm -rf native/src-tauri/gen/apple
  (cd native && APPLE_DEVELOPMENT_TEAM="$APPLE_TEAM_ID" npm run tauri -- ios init)
  # ios init writes Tauri's stock icons into the asset catalog; the PlanMind set in icons/ios never reaches the app without this.
  cp native/src-tauri/icons/ios/AppIcon-*.png native/src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset/
  cmp -s native/src-tauri/icons/ios/AppIcon-512@2x.png native/src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png
  (cd native && APPLE_DEVELOPMENT_TEAM="$APPLE_TEAM_ID" npm run tauri -- ios build --export-method debugging --ci)
  IPA=native/src-tauri/gen/apple/build/arm64/PlanMind.ipa
  [ -f "$IPA" ] || { echo 'The signed PlanMind.ipa was not found.' >&2; exit 1; }
  IOS_BUILT=1
  # A phone that is offline or locked is skipped with a warning naming it and is owed; any other install failure goes on to
  # the next phone and then fails the run. The web release is already live by now (dtp deploys, tags and pushes first).
  HARD=0
  set -f
  while IFS= read -r _line; do
    _label=''
    case $_line in *'#'*) _label=$(printf '%s\n' "${_line#*#}" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//') ;; esac
    for device in ${_line%%#*}; do
      _who=$device${_label:+ ($_label)}
      _rc=0; _log=$(devicectl_install "$device" "$ROOT/$IPA" "${_label:-$device}" 2>&1) || _rc=$?
      printf '%s\n' "$_log"
      if [ "$_rc" = 0 ]; then owed_installs clear PlanMind "$device" "$ROOT/$IPA"; continue; fi
      owed_installs record PlanMind "$device" "$ROOT/$IPA"
      if printf '%s\n' "$_log" | grep -Eiq "$PHONE_AWAY"; then
        echo "warning: skipped the phone $_who: it is offline, locked or out of reach; its install is owed" >&2
      else
        echo "error: the install on the phone $_who failed, and not because the phone was away" >&2
        HARD=1
      fi
      PHONES_OWED=$PHONES_OWED"the iOS install on the phone $_who
"
    done
  done <<EOF
$IOS_PHONES
EOF
  set +f
  heavy_unlock
  [ "$HARD" = 0 ] || exit 1
fi
