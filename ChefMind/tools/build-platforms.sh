#!/bin/sh
# The platforms this repo ships that deploy.sh does not: the macOS desktop
# bundle, an iOS build installed on every phone this app belongs on (built
# once, installed to each of them), and an Android build on an emulator.
# Windows is CI's (root .github/workflows/chefmind-release.yml builds it on a tag, and
# tools/preflight.sh checks it before one) — Tauri does not cross-compile.
#
#   sh tools/build-platforms.sh              all three
#   sh tools/build-platforms.sh --mac        just the desktop bundle
#   sh tools/build-platforms.sh --ios        just the phones
#   sh tools/build-platforms.sh --android    just the emulator
#   sh tools/build-platforms.sh --dry-run    print the plan
#
# Flags compose, and naming none means all three — the same positive selection
# CoreMind's script uses, because zeroing the OTHERS per flag does not compose
# past two.
#
# WHY THIS LIVES HERE. It was CoreMind's `bin/build-platforms.sh` alone, a
# table-driven script covering four apps, and this repo's own dtp shipped the
# web and nothing else. That arrangement had a hole you could not see from
# inside either repo: a ChefMind release could complete, tag and push while
# the Mac bundle stayed at whatever it was last built from. It did exactly
# that — the .app on this machine was staged 2026-08-22 16:10, before the
# Pantry tab existed, so the tab was live on the web for a day while the
# desktop app had never heard of it (the owner, 2026-08-23: "i don't see the pantry
# in my macos version").
#
# The owner, same day: "This repo should be able to ship itself (and needed
# dependencies) on its own... coremind is to ship all apps simultaneously."
# So the machinery is HERE, the lane runs it, and CoreMind orchestrates ACROSS
# apps by calling each app's own lane rather than reaching into it.
#
# This is a copy-down, like packages/core — CoreMind's script is the origin and
# its comments are the record of what each line cost to learn. Keep them.
set -e
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
APPDIR="app"
DESKTOP_WS="@chefmind/desktop"

# ------------------------------------------------------------------- argv
DRY=0; PICKED=0; WANT_MAC=0; WANT_IOS=0; WANT_ANDROID=0
while [ $# -gt 0 ]; do
  case "$1" in
    --mac)        WANT_MAC=1;     PICKED=1 ;;
    --ios)        WANT_IOS=1;     PICKED=1 ;;
    --android)    WANT_ANDROID=1; PICKED=1 ;;
    --dry-run)    DRY=1 ;;
    *) echo "unknown flag: $1" >&2; exit 1 ;;
  esac
  shift
done
[ "$PICKED" = 1 ] || { WANT_MAC=1; WANT_IOS=1; WANT_ANDROID=1; }
if [ "$WANT_MAC" = 1 ] && [ "$DRY" = 0 ]; then
  if [ "$(uname -m)" != arm64 ] || [ "${CARGO_BUILD_TARGET:-aarch64-apple-darwin}" != aarch64-apple-darwin ]; then
    echo 'macOS builds require Apple Silicon.' >&2; exit 1
  fi
fi

# Xcode derivedData and gradle's home stay on the INTERNAL disk, deliberately.
# A scratch volume mounted exFAT was tried on 2026-08-22 and reverted: exFAT
# cannot store the extended attributes codesign needs, so any signed product
# gets a "._<name>" AppleDouble sidecar that codesign then tries to sign as a
# subcomponent and fails on. The same root cause broke gradle's cache there in
# the same session. Large and untracked is a real cost; it has to be paid.
BUILD_SCRATCH="$ROOT/$APPDIR/ios"

if [ "$DRY" = 1 ]; then
  [ "$WANT_MAC" = 1 ]     && echo "would: npm -w $DESKTOP_WS run build, then install to /Applications"
  [ "$WANT_IOS" = 1 ]     && echo "would: prebuild $APPDIR (ios) if it has no workspace, sync app.json's version into it, xcodebuild Release against one of this app's phones, check the built version, devicectl install to each of them that answers"
  [ "$WANT_ANDROID" = 1 ] && echo "would: prebuild $APPDIR (android), gradlew assembleRelease, adb install"
  exit 0
fi

# ------------------------------------------------- this machine's own values
# The signing team and the phones this app belongs on are read from the
# untracked .local/machine.env (tools/machine-env.sh; tools/machine.env.sample
# shows the keys). An iOS run without it stops HERE, before any build, naming
# the missing key: there is no built-in default to fall back on.
. tools/machine-env.sh
if [ "$WANT_IOS" = 1 ]; then
  machine_load "$ROOT" && machine_require APPLE_TEAM_ID CHEFMIND_PHONES || exit 1
  export APPLE_TEAM_ID
  [ -n "${IOS_PHONES:-}" ] || IOS_PHONES=$(machine_phones chefmind) || exit 1
fi

# ------------------------------------------------------------ one at a time
# Every platform block below runs under the machine-wide heavy-build lock,
# tools/heavy-lock.sh — CalMind/tools/heavy-lock.sh's bytes (the
# `tools-heavy-lock-sh` group in tools/shared-files.json), so fix it THERE,
# never here. "One heavy build at a time" was a
# rule this file's own comments and every AGENTS.md stated and nothing kept:
# the lane runs its blocks one after another, but another session's lane, or
# CoreMind's fallback, could not see them. On 2026-09-30 one session's gradle
# ran beside another's xcodebuild and an AcctMind lane took 1574 s instead of
# 246. Now a block that finds the lock HELD by another build — this repo's or
# another's, this session's or not — waits for it, saying whose it is,
# instead of running beside it.
#
# It sees ONLY builds that take the lock — the scripts that source canon's
# helper: as of 2026-10-01 the platform blocks of AcctMind, CalMind, ChefMind
# and MyCalMind, MyCalMind's deploy-device.sh, AcctMind's desktop smoke and
# CoreMind's fallback bin/build-platforms.sh. It looks for no xcodebuild,
# gradle or cargo process, so a block here still starts beside, unseen:
# another app's builds and tests, a TestMindSuite fork's
# lane (qdtp, after every feature), and any build run by hand — this repo's
# `npm run desktop` or app/'s `npm run ios`/`android`, an xcodebuild in a
# terminal, or a build started from Xcode's own window. For those, "one at a
# time" is still a rule to remember, not something this lock keeps.
#
# Taken around each BLOCK, because a block is the unit the lane runs on its
# own (--mac before the tag, --ios and --android after the push), and the
# installs inside each one are part of it: two lanes installing onto the same
# phone at once is the same contention one level down. Let go explicitly at
# each block's end; every `exit 1` inside a block lets go through the
# helper's EXIT trap, and a kill -9 through the next waiter's takeover.
. "$ROOT/tools/heavy-lock.sh"

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

# The export the desktop shell stages: a CLEAN one, plus the head patch.
#
# THE PATCH IS NOT OPTIONAL, and this is the bug that was here. CoreMind's mac
# path ran `export:web` alone, so the Mac bundle carried the bare export —
# while the site and the Windows CI bundle both carry the PATCHED index.html.
# `root .github/workflows/chefmind-release.yml` says why in as many words: the
# desktop bundle should carry the same index.html the site serves. The Mac was
# the one build that did not, and nothing compared them.
#
# What the patch adds is the PWA furniture — tools/patch-web-html.mjs writes
# sw.js and manifest.webmanifest and injects the registration — which is why a
# patched dist stages 9 files where the bare export stages 6. The service
# worker cannot register from tauri://localhost, and does not have to: the
# injected call is `navigator.serviceWorker.register('sw.js').catch(...)`, so
# it fails silently there by construction rather than by luck.
#
# CLEAN because `expo export` does not empty the directory, so a dist left by
# deploy.sh (or by a previous run of this) would be copied along with whatever
# else is in it. The export is deterministic — the same source produces the
# same content-hashed bundle name — which is what makes it possible to check a
# .app against the live site at all, and it costs about thirty seconds.
ensure_dist() {
  rm -rf "$ROOT/app/dist"
  npm run -s export:web >/dev/null || { echo "the web export failed" >&2; return 1; }
  # The head patch, exactly as deploy.sh runs it — the desktop should carry
  # the same index.html the site serves, not one missing it.
  node tools/patch-web-html.mjs app/dist/index.html >/dev/null \
    || { echo "the head patch failed" >&2; return 1; }
}

# --------------------------------------------------------------- the iOS project
# The generated project is REUSED once it exists — a prebuild --clean on every
# build would also wipe ios/derived-platforms and turn each release into a cold
# build. The price of reuse: the project froze the version at whatever app.json
# said the day the workspace was first generated. app/ios/ChefMind/Info.plist
# carries a LITERAL CFBundleShortVersionString, and it said 1.4.0 — the
# workspace dates from 2026-08-22 — so every phone install since then reported
# 1.4.0; at 1.25.0 the web, the Mac bundle and the APK all said 1.25.0 (found
# 2026-10-01). CalMind found the same hole on 2026-08-30 (1.11.0 against
# 1.17.0); this is its sync_ios_version, copied across.
#
# So the version is SYNCED into the generated project on every build:
# MARKETING_VERSION in the pbxproj, and the app's Info.plist literal, set
# directly. Both rewrites are verified by reading the value back — a perl that
# matches nothing exits 0 and reports success (AcctMind's
# plist-a-version-behind scar). ios/ is gitignored, so this edits generated
# files only, never the tree the lane is about to tag. And the BUILT bundle is
# checked again before any phone gets it, below: the sync is the fix, the
# check is what says the fix reached the artifact.
IOS_WS=""
app_version() {
  _v=$( cd "$ROOT/$APPDIR" && node -p "require('./app.json').expo.version" 2>/dev/null ) || _v=""
  # digits-and-dots or refuse: node -p prints the STRING "undefined" for a
  # missing key, which is non-empty and would sync verbatim into the project.
  case "$_v" in
    ''|*[!0-9.]*) echo "no usable expo.version in $APPDIR/app.json (got '$_v')" >&2; return 1 ;;
  esac
  printf '%s\n' "$_v"
}
sync_ios_version() {
  V=$(app_version) || return 1
  PBX=$(ls "$ROOT/$APPDIR"/ios/*.xcodeproj/project.pbxproj 2>/dev/null | head -1)
  [ -n "$PBX" ] || { echo "no project.pbxproj beside the workspace" >&2; return 1; }
  perl -i -pe "s/MARKETING_VERSION = [^;]*;/MARKETING_VERSION = $V;/g" "$PBX"
  if grep 'MARKETING_VERSION' "$PBX" | grep -qv " = $V;"; then
    echo "MARKETING_VERSION did not sync to $V in $PBX" >&2; return 1
  fi
  PLIST="$ROOT/$APPDIR/ios/$(basename "$IOS_WS" .xcworkspace)/Info.plist"
  CUR=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$PLIST" 2>/dev/null) || CUR=""
  case "$CUR" in
    ''|*MARKETING_VERSION*) : ;;  # absent, or a build-setting reference the pbxproj now feeds
    "$V") : ;;
    *) /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $V" "$PLIST" \
         || { echo "could not set CFBundleShortVersionString in $PLIST" >&2; return 1; }
       CUR=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$PLIST" 2>/dev/null) || CUR=""
       [ "$CUR" = "$V" ] || { echo "CFBundleShortVersionString did not sync to $V in $PLIST" >&2; return 1; } ;;
  esac
  echo "    version: $V (synced into the generated project)"
}
prebuild_ios() {
  [ -n "$IOS_WS" ] && return 0
  IOS_WS=$(ls -d "$ROOT/$APPDIR"/ios/*.xcworkspace 2>/dev/null | head -1)
  if [ -z "$IOS_WS" ]; then
    # LANG is not optional: CocoaPods dies in unicode_normalize without a UTF-8
    # locale, naming nothing useful. And note app/ios/build/ is NOT disposable —
    # ReactCodegen's generated sources live under it and are written by
    # pod install, not xcodebuild (AGENTS.md).
    ( cd "$ROOT/$APPDIR" && LANG=en_US.UTF-8 npx expo prebuild --platform ios --clean ) \
      || { echo "prebuild failed" >&2; return 1; }
    IOS_WS=$(ls -d "$ROOT/$APPDIR"/ios/*.xcworkspace 2>/dev/null | head -1)
    [ -n "$IOS_WS" ] || { echo "prebuild produced no xcworkspace" >&2; return 1; }
  fi
  # NOT an early return on an existing workspace, which is what this function
  # did until 2026-10-01 — and that is the path every release takes, so a sync
  # placed after it would never have run. Even a fresh prebuild goes through
  # the sync: the verify is the point.
  sync_ios_version || return 1
}

# ------------------------------------------------------------------- macOS
if [ "$WANT_MAC" = 1 ]; then
  echo "==> macOS desktop bundle"
  heavy_lock "macOS" || exit 1
  ensure_dist || exit 1
  ( cd "$ROOT" && npm -w "$DESKTOP_WS" run build ) \
    || { echo "the macOS bundle failed to build" >&2; exit 1; }
  APPBUNDLE=$(ls -d "$ROOT"/desktop/src-tauri/target/release/bundle/macos/*.app 2>/dev/null | head -1)
  [ -n "$APPBUNDLE" ] || { echo "the build reported success and produced no .app" >&2; exit 1; }
  echo "    $APPBUNDLE"
  # --no-build: the smoke checks the bundle built just above, the one that is
  # then installed. It must not compile the shell a second time. AcctMind's
  # did, inside every lane: 16 s quiet and 74 s under load, and the app it
  # installed was the smoke's rebuild, not the build the step had checked.
  # CalMind's smoke.sh takes the flag, and so must any smoke this repo gains.
  if [ -f "$ROOT/desktop/smoke.sh" ]; then
    ( cd "$ROOT" && sh desktop/smoke.sh --no-build ) || { echo "the macOS smoke failed" >&2; exit 1; }
  fi
  # INSTALL IT. A build sitting in target/release/bundle/macos/ is not a
  # deploy — it is the thing nobody looks at while the app in /Applications
  # goes stale.
  #
  # WHOSE WINDOW IS THIS. The owner, 2026-09-21: "make sure to reopen already
  # opened apps in a dtp.. i was looking at an old acctmind". The install
  # below is `rm -rf` then `cp -R`, and macOS keeps a RUNNING app's code
  # mapped from the bundle it launched from — so replacing those files under a
  # live app changes nothing he can see, and the window keeps the JS it
  # started with. That is exactly how he spent an afternoon reading an old
  # AcctMind while the same build was live on the web, on his phone and in
  # /Applications. So the app gets quit first if it is open, and put back
  # afterwards if — and only if — it was.
  #
  # MATCHED ON THE BUNDLE PATH, NEVER THE APP NAME, because the two are not
  # the same string: the executable inside AcctMind.app is
  # Contents/MacOS/acctmind-desktop, so `pgrep -x AcctMind` finds nothing and
  # the whole feature silently does not happen. The name is taken off
  # $APPBUNDLE, the same variable the copy below uses, so the check and the
  # install can never disagree about which app this is. The path also scopes
  # it to the INSTALLED copy: a bundle someone is running out of
  # target/release/bundle is not the one being replaced here.
  APPNAME=$(basename "$APPBUNDLE" .app)
  WAS_RUNNING=0
  if pgrep -f "/Applications/$APPNAME.app/Contents/MacOS/" >/dev/null 2>&1; then
    WAS_RUNNING=1
    # ASKED, NEVER KILLED. `quit app` is the gesture the suite's desktop smoke
    # uses (CalMind's desktop/smoke.sh; this repo has no smoke.sh of its own
    # yet, which is why the call to one above is guarded by `[ -f ]`): a
    # release has no business sending a signal to an app that holds the only
    # copy of something unsaved. And the wait is not optional either —
    # copying over a live bundle is half of what this is avoiding. If it has
    # not gone within eight seconds we say so and install anyway: a stale
    # window is a smaller problem than a skipped deploy.
    #
    # WHEN THIS REPO GAINS THAT SMOKE it must aim at the bundle it just built,
    # never at the app by name: CalMind's quits `app "CalMind"` and falls back
    # to `pkill -f` on the executable, either of which would close HIS
    # installed copy minutes before the check above ever runs — and then the
    # reopen below never learns there was a window to give back, which is the
    # same afternoon over again.
    echo "    quitting $APPNAME — it is open, and a copy over a live bundle would change nothing on screen"
    osascript -e "quit app \"$APPNAME\"" >/dev/null 2>&1 || true
    WAITED=0
    while pgrep -f "/Applications/$APPNAME.app/Contents/MacOS/" >/dev/null 2>&1; do
      [ "$WAITED" -lt 8 ] || { echo "warning: $APPNAME would not quit — installing over it anyway" >&2; break; }
      sleep 1
      WAITED=$((WAITED + 1))
    done
  fi
  rm -rf "/Applications/$(basename "$APPBUNDLE")"
  cp -R "$APPBUNDLE" /Applications/ \
    || { echo "copying the .app into /Applications failed" >&2; exit 1; }
  echo "    installed: /Applications/$(basename "$APPBUNDLE")"
  # AND GIVE HIM HIS WINDOW BACK — only if it was there to begin with. An app
  # he had closed stays closed: a release that conjures windows onto his
  # desktop is its own kind of rude. Best-effort from here down, like every
  # step of this since the quit: failing to reopen a window must never turn a
  # release that shipped into a lane that failed, so nothing below touches the
  # exit status.
  if [ "$WAS_RUNNING" = 1 ]; then
    if open "/Applications/$APPNAME.app" >/dev/null 2>&1; then
      echo "    reopened $APPNAME — it was running before this release"
    else
      echo "warning: $APPNAME was running before this release and would not reopen" >&2
    fi
  fi
  heavy_unlock
fi

# --------------------------------------------------------------------- iOS
if [ "$WANT_IOS" = 1 ]; then
  echo "==> iOS"
  owed_installs   # first: builds owed to phones that were away land before this run's own
  heavy_lock "iOS" || exit 1

  # THE PHONES THIS APP BELONGS ON. A release is not "install it to the phone",
  # and it is not "install it to whatever is plugged in" either: every app in
  # the suite belongs on a SPECIFIC set of handsets, and that set is a fact
  # about the app, not about what happens to be on the desk when the lane runs.
  # The owner, 2026-09-21, after a release reached one phone — "you should have dtp
  # to all platforms and all 3 phones and my watch" — and then the routing
  # itself: "the only apps installed on person B's phone are ChefMind and
  # CalMind", "person C's phone only gets CalMind", "my phone gets all 6
  # (including the test ones)". ChefMind is therefore the owner's phone and
  # Person B's; Person C's is CalMind's alone and is deliberately absent below.
  #
  # BY UDID, NEVER BY NAME. The names are comments, for the human who has to
  # read a warning and go and find the handset. Two of the suite's three phones
  # carry an apostrophe in the name devicectl reports and one of those is a
  # CURLY one (U+2018) — exactly the sort of thing that compares equal in a
  # test typed on this machine and then does not on the day.
  #
  # IOS_PHONES replaces the list wholesale for a one-off, and IOS_DEVICE,
  # below, still overrides by name and narrows the run to one handset. The
  # list is read by plain word splitting, so `IOS_PHONES='<udid> <udid>'` on
  # one command line works as well as the several lines below — a reader that
  # took only the FIRST udid on each line would accept that override and then
  # quietly ship to one phone, which is the exact failure this list exists to
  # prevent. Everything from a '#' to the end of its line is a name for the
  # person reading, never something matched on.

  DEVJSON=$(mktemp "${TMPDIR:-/tmp}/chefmind-devices.XXXXXX")
  xcrun devicectl list devices --json-output "$DEVJSON" >/dev/null 2>&1 \
    || { echo "devicectl cannot list devices — is Xcode installed?" >&2; exit 1; }
  # One line per eligible device, "<udid> <name>". The UDID, not the CoreDevice
  # identifier: xcodebuild's -destination matches a physical device by UDID,
  # and handing it the other one finds nothing.
  SEEN=$(python3 - "$DEVJSON" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
# tunnelState: a paired phone that is merely idle lists as 'disconnected'
# until something warms the tunnel, so excluding it skipped the iOS step of
# CalMind 1.17.0 with the phone sitting right there (2026-08-30). Only
# 'unavailable' is a genuinely absent device — the second paired handset
# proves it.
for x in d.get('result', {}).get('devices', []):
    hw = x.get('hardwareProperties', {})
    if hw.get('platform') != 'iOS' or not hw.get('udid'):
        continue
    if x.get('connectionProperties', {}).get('tunnelState') not in ('connected', 'available', 'disconnected'):
        continue
    print(hw['udid'] + ' ' + (x.get('deviceProperties', {}).get('name') or '?'))
PY
)
  rm -f "$DEVJSON"

  # The human name for a udid: what devicectl calls it, or failing that the
  # comment beside it in the list above — a line that says only
  # "00000000-0000000000000002 is not answering" sends nobody to the right
  # drawer.
  phone_name() {
    _n=$(printf '%s\n' "$SEEN" | awk -v u="$1" '$1 == u { print substr($0, index($0, " ") + 1); exit }')
    [ -n "$_n" ] || _n=$(printf '%s\n' "$IOS_PHONES" \
      | awk -v u="$1" '$1 == u { i = index($0, "#"); if (i) print substr($0, i + 1); exit }' \
      | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
    printf '%s' "${_n:-$1}"
  }

  # IOS_DEVICE is the hand override, and it still matches by NAME: it is how a
  # person at the keyboard says "this handset on the bench, never mind the
  # routing", and it narrows the run to that one phone for the build and the
  # install both. It was also the fix for a real outage — requiring EXACTLY one
  # reachable phone made a second paired handset refuse every install on this
  # machine, three releases in a row reporting "no single reachable iPhone"
  # with the right phone sitting there (2026-08-23). The list above is the
  # general answer to that now; this stays for the exceptions, and an ambiguous
  # name still fails, saying what it saw.
  if [ -n "${IOS_DEVICE:-}" ]; then
    NAMED=$(printf '%s\n' "$SEEN" | awk -v want="$IOS_DEVICE" 'substr($0, index($0, " ") + 1) == want { print $1 }')
    if [ "$(printf '%s\n' "$NAMED" | awk 'NF' | wc -l | tr -d ' ')" = 1 ]; then
      IOS_PHONES="$NAMED"
    else
      echo "no single reachable iPhone named '$IOS_DEVICE'" >&2
      printf '%s\n' "$SEEN" | awk 'NF { print "    seen: " substr($0, index($0, " ") + 1) }' >&2
      exit 1
    fi
  fi

  # Which of them are actually here. A phone on the list that devicectl does
  # not report at all is switched off or off the network — a normal Tuesday,
  # not a broken release — so it is named and skipped rather than failing the
  # step for the phones that ARE here.
  TARGETS=""; AWAY=""
  for U in $(printf '%s\n' "$IOS_PHONES" | sed 's/#.*//'); do
    if printf '%s\n' "$SEEN" | awk -v u="$U" '$1 == u { hit = 1 } END { exit !hit }'; then
      TARGETS="${TARGETS}${TARGETS:+ }$U"
    else
      echo "    skipping $(phone_name "$U") — devicectl does not see it"
      AWAY="$AWAY $U"
    fi
  done
  [ -n "$TARGETS" ] || {
    echo "no usable iPhone: not one of this app's phones is reachable" >&2
    echo "  Plug one in, or name one:  IOS_DEVICE='Some iPhone' sh tools/build-platforms.sh --ios" >&2
    echo "  or aim the run elsewhere:  IOS_PHONES='<udid> <udid>' sh tools/build-platforms.sh --ios" >&2
    exit 1
  }

  # ONE BUILD, MANY INSTALLS. The .app is the same bytes on every handset, so
  # the first phone that answered is the build destination and the others take
  # the bundle it produced. Building once per phone would be a full Release
  # build per handset for products that are byte-for-byte the same.
  BUILD_UDID=$(printf '%s\n' $TARGETS | head -1)
  echo "    device: $BUILD_UDID ($(phone_name "$BUILD_UDID"))"

  prebuild_ios || exit 1
  SCHEME=$(basename "$IOS_WS" .xcworkspace)
  DERIVED="$BUILD_SCRATCH/derived-platforms"
  echo "    workspace: $(basename "$IOS_WS")  scheme: $SCHEME"

  LOG=$(mktemp "${TMPDIR:-/tmp}/chefmind-ios.XXXXXX")
  # -destination with a SPECIFIC device, never -sdk: -sdk overrides SDKROOT for
  # every target in the scheme.
  if ! xcodebuild -workspace "$IOS_WS" -scheme "$SCHEME" -configuration Release \
      -destination "platform=iOS,id=$BUILD_UDID" -derivedDataPath "$DERIVED" \
      -allowProvisioningUpdates -allowProvisioningDeviceRegistration build >"$LOG" 2>&1; then
    echo "the iOS build failed — last lines:" >&2
    tail -25 "$LOG" >&2; echo "full log: $LOG" >&2; exit 1
  fi
  rm -f "$LOG"

  BUNDLE="$DERIVED/Build/Products/Release-iphoneos/$SCHEME.app"
  [ -d "$BUNDLE" ] || { echo "the build succeeded and produced no $SCHEME.app" >&2; exit 1; }

  # THE VERSION THE PHONES WILL REPORT, read off the BUILT bundle — not the
  # project the sync above wrote, because what reaches the phone is this
  # Info.plist. A bundle that does not say app.json's version is not
  # installed anywhere: the phones said 1.4.0 for a month while every other
  # platform moved on, and nothing noticed. The failure is the step's, so the
  # lane owes --ios and ends non-zero rather than putting a wrong number on a
  # phone.
  WANT_V=$(app_version) || exit 1
  GOT_V=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$BUNDLE/Info.plist" 2>/dev/null) || GOT_V=""
  if [ "$GOT_V" != "$WANT_V" ]; then
    echo "the built $SCHEME.app says version '${GOT_V:-<none>}', and app.json says $WANT_V — not installing it on any phone" >&2
    echo "  the sync into app/ios did not reach the build; look at $BUNDLE/Info.plist" >&2
    exit 1
  fi
  echo "    built: $SCHEME.app $GOT_V"

  # INSTALL IT TO EVERY PHONE THAT ANSWERED. Nothing here has to make room for
  # anything: Apple's free-tier cap of 3 apps per device does not apply, because
  # the team (TEAMID0000) is PAID — its Xcode-managed profile
  # carries TimeToLive 365 where a personal team's carries 7. The owner, 2026-09-21:
  # "no more caps per phone." Any note anywhere in this repo that rations
  # installs against that cap is describing a constraint that is gone.
  #
  # A phone the team has never been asked to sign for is a different matter:
  # devicectl refuses it with a provisioning error instead of installing.
  # Building ONCE with that phone as the -destination registers it with the
  # team, and from then on its udid is in every regenerated profile and the
  # plain install below works — which is what the one-line recipe printed on
  # the failure path is for. That recipe names the phone by UDID even though
  # the warning beside it names it in English: it is meant to be pasted back
  # into a shell, and two of the suite's three phone names carry an
  # apostrophe — one of them curly — so a name in that line is a line that
  # does not run.
  #
  # devicectl installs onto a LOCKED phone; only launching needs it awake.
  OK=0
  for U in $TARGETS; do
    PHONE=$(phone_name "$U")
    # Retried once: the first call routinely times out enabling developer disk
    # image services and succeeds immediately afterwards.
    if devicectl_install "$U" "$BUNDLE" "$PHONE"; then
      OK=$((OK + 1))
      echo "    installed $SCHEME.app on $PHONE"
      owed_installs clear ChefMind "$U" "$BUNDLE"
    else
      owed_installs record ChefMind "$U" "$BUNDLE"
      echo "warning: $PHONE ($U) would not take $SCHEME.app — going on to the next" >&2
      echo "  If the team has never signed for it, one build aimed at it registers it:" >&2
      echo "    IOS_PHONES=$U sh tools/build-platforms.sh --ios" >&2
    fi
  done
  # IT FAILS ONLY WHEN NOT ONE PHONE TOOK IT. A release that landed on one of
  # the phones and not the other still shipped to the one, and ending the step
  # non-zero over the absentee would make the lane's exit status — the one
  # place "it all worked" is read off — mean nothing. Reaching NONE of them is
  # the failure the single `exit 1` here used to catch, and it still is.
  for U in $AWAY; do owed_installs record ChefMind "$U" "$BUNDLE"; done
  [ "$OK" -gt 0 ] || { echo "not one phone took $SCHEME.app" >&2; exit 1; }
  # No watch branch: watchOS is not a target here — watch.ts and the
  # watch/widget targets went with Calendar and Habits (ARCHITECTURE.md).
  heavy_unlock
fi

# ----------------------------------------------------------------- Android
if [ "$WANT_ANDROID" = 1 ]; then
  echo "==> Android"
  heavy_lock "Android" || exit 1
  export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
  export ANDROID_SDK_ROOT="$ANDROID_HOME"
  export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
  [ -d "$ANDROID_HOME" ] || { echo "no Android SDK at \$ANDROID_HOME ($ANDROID_HOME)" >&2; exit 1; }
  command -v adb >/dev/null || { echo "adb not on PATH under \$ANDROID_HOME" >&2; exit 1; }

  # A device already reachable — real hardware or an emulator someone left
  # running — wins outright; nothing here boots a second one on top of it.
  SERIAL=$(adb devices | awk 'NR>1 && $2=="device" {print $1; exit}')
  if [ -z "$SERIAL" ]; then
    AVD="${ANDROID_AVD:-}"
    if [ -z "$AVD" ]; then
      # `avdmanager` reports a system image as installed from its OWN
      # metadata, which can be stale — one on this machine names a directory
      # that does not exist. Each candidate is checked on DISK.
      for CAND in $(emulator -list-avds 2>/dev/null); do
        IMG=$(sed -n 's/^image\.sysdir\.1=//p' "$HOME/.android/avd/$CAND.avd/config.ini" 2>/dev/null)
        if [ -n "$IMG" ] && [ -d "$ANDROID_HOME/$IMG" ]; then AVD="$CAND"; break; fi
      done
    fi
    [ -n "$AVD" ] || { echo "no Android emulator running and no bootable AVD found" >&2; exit 1; }
    echo "    booting $AVD"
    nohup emulator -avd "$AVD" -no-snapshot-load -no-boot-anim -netdelay none -netspeed full \
      >"/tmp/chefmind-emulator-$AVD.log" 2>&1 &
    disown 2>/dev/null || true
    i=0
    while [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" != "1" ]; do
      sleep 5; i=$((i + 1))
      [ "$i" -le 72 ] || { echo "$AVD did not finish booting within 6 minutes" >&2; exit 1; }
    done
    SERIAL=$(adb devices | awk 'NR>1 && $2=="device" {print $1; exit}')
    [ -n "$SERIAL" ] || { echo "$AVD booted but adb sees no device" >&2; exit 1; }
  fi
  echo "    device: $SERIAL"

  ( cd "$ROOT/$APPDIR" && LANG=en_US.UTF-8 npx expo prebuild --platform android --clean ) \
    || { echo "android prebuild failed" >&2; exit 1; }

  # assembleRelease, not debug: gradle here signs BOTH build types with the
  # auto-generated debug keystore (there is no release keystore in the suite),
  # so release installs exactly as easily and is what a real release uses.
  # A build killed by a full disk leaves a Gradle LOCK behind and the next run
  # fails in under a second — `./gradlew --stop` and remove app/android/.gradle
  # (AGENTS.md).
  ( cd "$ROOT/$APPDIR/android" && ANDROID_HOME="$ANDROID_HOME" ./gradlew assembleRelease ) \
    || { echo "the Android build failed" >&2; exit 1; }

  APK=$(find "$ROOT/$APPDIR/android/app/build/outputs/apk" -name "*.apk" 2>/dev/null | head -1)
  [ -n "$APK" ] || { echo "the Android build produced no APK" >&2; exit 1; }

  # Package and launch activity read OFF THE BUILT APK via aapt, not guessed
  # from app.json — the source of truth for what just got built.
  AAPT=$(ls "$ANDROID_HOME"/build-tools/*/aapt 2>/dev/null | sort -V | tail -1)
  [ -n "$AAPT" ] || { echo "no aapt under \$ANDROID_HOME/build-tools" >&2; exit 1; }
  BADGING=$("$AAPT" dump badging "$APK")
  PKG=$(printf '%s\n' "$BADGING" | sed -n "s/^package: name='\([^']*\)'.*/\1/p")
  ACTIVITY=$(printf '%s\n' "$BADGING" | sed -n "s/^launchable-activity: name='\([^']*\)'.*/\1/p")
  [ -n "$PKG" ] && [ -n "$ACTIVITY" ] \
    || { echo "could not read package/activity from the built APK" >&2; exit 1; }

  adb -s "$SERIAL" install -r "$APK" || { echo "adb install failed" >&2; exit 1; }
  adb -s "$SERIAL" shell am start -n "$PKG/$ACTIVITY" >/dev/null \
    || { echo "the app installed but would not launch" >&2; exit 1; }
  # Polled, not one sleep-then-check: a cold RN launch loads a dozen native
  # libraries before the process is fully up, and 5 seconds flat once reported
  # "not running" for a process ps showed alive a moment later.
  RUNNING=0
  for _ in 1 2 3 4 5 6; do
    if adb -s "$SERIAL" shell "ps -A" 2>/dev/null | grep -q "$PKG"; then RUNNING=1; break; fi
    sleep 3
  done
  [ "$RUNNING" = 1 ] || { echo "installed and launched but never showed up running" >&2; exit 1; }
  echo "    installed and running: $PKG on $SERIAL"
  heavy_unlock
fi
