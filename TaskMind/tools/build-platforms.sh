#!/bin/sh
# One shared HTTPS app, persistent login cookies, and no native command bridge.
#
#   sh tools/build-platforms.sh                 the Mac app and the iOS app (on a Mac); --windows alone elsewhere
#   sh tools/build-platforms.sh --mac --ios --android --windows   name the builds to run; --dry-run prints the plan only
#   sh tools/build-platforms.sh --mac --debug   a debug-profile build of the Mac app (and of the Android APK) that is NOT installed anywhere:
#                                               for checking that the toolchain builds. iOS has no such mode.
#
# Android without --debug builds a RELEASE APK, signs it with the local release key ($HOME/.config/taskmind/android-release.keystore,
# alias taskmind, its password in android-release.keystore.password beside it, both 0600 in a 0700 directory, never in the repo), and
# installs and launches that. The key is made once, when neither file exists; one without the other stops the run (a new key cannot
# update an app signed with the old one). Back both files up: losing them means uninstalling the app on every device to install again.
#
# What a run still owes is listed on the way out (stderr, and TASKMIND_OWED_FILE when dtp.sh sets it): a build that failed
# or never started, and every phone that was offline or locked and so was skipped with a warning (not a failure of the run).
# Every build block runs under the suite's heavy-build lock (tools/heavy-lock.sh, CoreMind canon): one heavy build at a time.
set -eu
cd "$(dirname "$0")/.."
ROOT=$(pwd)
. tools/heavy-lock.sh
DRY=0; MAC=0; IOS=0; ANDROID=0; WINDOWS=0; PICKED=0; DEBUG=0
for arg in "$@"; do
  case "$arg" in
    --mac) MAC=1; PICKED=1 ;;
    --ios) IOS=1; PICKED=1 ;;
    --android) ANDROID=1; PICKED=1 ;;
    --windows) WINDOWS=1; PICKED=1 ;;
    --debug) DEBUG=1 ;;
    --dry-run) DRY=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 1 ;;
  esac
done
if [ "$PICKED" = 0 ]; then
  case "$(uname -s)" in Darwin) MAC=1; IOS=1 ;; MINGW*|MSYS*) WINDOWS=1 ;; *) echo 'Choose --mac, --ios, --android or --windows on its build host.' >&2; exit 1 ;; esac
fi
if [ "$MAC" = 1 ] && [ "$DRY" = 0 ]; then
  if [ "$(uname -m)" != arm64 ] || [ "${CARGO_BUILD_TARGET:-aarch64-apple-darwin}" != aarch64-apple-darwin ]; then
    echo 'macOS builds require Apple Silicon.' >&2; exit 1
  fi
fi
[ "$DEBUG" = 0 ] || [ "$IOS" = 0 ] || { echo 'iOS has no debug mode: it is always the signed device build. Drop --ios or --debug.' >&2; exit 1; }
# UDIDS, NEVER NAMES (the suite's rule): the names after # are for the warnings only. IOS_PHONES replaces the list for one run.
# Never enumerate and install onto every paired phone. The default list and the signing team come from the untracked
# .local/machine.env (tools/machine-env.sh); an iOS run without it stops before building anything, naming the missing key.
. tools/machine-env.sh
if [ "$IOS" = 1 ] && [ "$DRY" = 0 ]; then
  machine_load "$(pwd)" && machine_require APPLE_TEAM_ID TASKMIND_PHONES || exit 1
  [ -n "${IOS_PHONES:-}" ] || IOS_PHONES=$(machine_phones taskmind) || exit 1
fi
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
# What devicectl says when a phone is simply not there to install onto (anything else is a real failure and fails the run).
PHONE_AWAY='locked|not connected|isn.t connected|is not connected|unavailable|not available|offline|unreachable|disconnected|unable to connect|not paired|could not be found|no devices|timed out|timeout|passcode'
# The Rust target of the Android build; the device's own ABI decides it for an install (a --debug build uses this).
ANDROID_DEFAULT_ARCH=aarch64
# The local release key of the Android app (see the header). Under $HOME, so a test's fake home holds its own.
ANDROID_KEY_DIR=$HOME/.config/taskmind
ANDROID_KEYSTORE=$ANDROID_KEY_DIR/android-release.keystore
ANDROID_KEYPASS=$ANDROID_KEYSTORE.password
ANDROID_KEY_ALIAS=taskmind
ANDROID_KEY_DN='CN=TaskMind, O=seancheren.com'
if [ "$DRY" = 1 ]; then
  if [ "$MAC" = 1 ]; then
    if [ "$DEBUG" = 1 ]; then echo 'would: build a debug TaskMind app on macOS (no dmg: that needs Finder) and leave it in native/src-tauri/target/debug; nothing is installed'
    else echo 'would: build the TaskMind app on macOS (no dmg: that needs Finder), then install only TaskMind.app'; fi
  fi
  [ "$WINDOWS" = 0 ] || echo 'would: build TaskMind msi + exe on Windows'
  [ "$IOS" = 0 ] || echo 'would: build the signed iOS app on macOS (SPACE mounted); install onto the udids in IOS_PHONES (default: the phones listed for it in .local/machine.env), skipping with a warning any phone that is offline or locked'
  if [ "$ANDROID" = 1 ]; then
    if [ "$DEBUG" = 1 ]; then echo 'would: regenerate the Android project (tauri android init), build a debug APK for aarch64 with the Android SDK and NDK, and install nothing'
    else
      if [ -f "$ANDROID_KEYSTORE" ] && [ -f "$ANDROID_KEYPASS" ]; then _key="the release key $ANDROID_KEYSTORE (exists)"
      elif [ -f "$ANDROID_KEYSTORE" ] || [ -f "$ANDROID_KEYPASS" ]; then _key="the release key $ANDROID_KEYSTORE (REFUSED: the keystore or its password is missing, the other is there)"
      else _key="the release key $ANDROID_KEYSTORE (created now, its password beside it, both 0600)"; fi
      echo "would: regenerate the Android project (tauri android init), build a RELEASE APK for the ABI of the device or emulator (an AVD is booted when none is running), zipalign it, sign it with $_key, verify the signature, adb install it and launch it"
    fi
  fi
  exit 0
fi
MAC_DONE=0; WIN_DONE=0; IOS_BUILT=0; ANDROID_DONE=0; PHONES_OWED=''
owed() {   # what this run still owes, one line each
  [ "$MAC" = 0 ] || [ "$MAC_DONE" = 1 ] || echo 'the macOS app (build and install)'
  [ "$WINDOWS" = 0 ] || [ "$WIN_DONE" = 1 ] || echo 'the Windows installers'
  [ "$IOS" = 0 ] || [ "$IOS_BUILT" = 1 ] || echo 'the iOS build and its install on every phone'
  [ "$ANDROID" = 0 ] || [ "$ANDROID_DONE" = 1 ] || echo 'the Android build, install and launch'
  [ -z "$PHONES_OWED" ] || printf '%s' "$PHONES_OWED"
}
finish() {
  _owed=$(owed)
  [ -n "$_owed" ] || return 0
  printf 'build-platforms: still owed:\n' >&2
  printf '%s\n' "$_owed" | sed 's/^/  - /' >&2
  if [ -n "${TASKMIND_OWED_FILE:-}" ]; then printf '%s\n' "$_owed" > "$TASKMIND_OWED_FILE"; fi
}
trap finish EXIT
fail() { echo "build-platforms: $*" >&2; exit 1; }
if [ "$MAC" = 1 ] || [ "$IOS" = 1 ]; then
  [ "$(uname -s)" = Darwin ] || fail 'macOS and Xcode are required for Apple packages.'
fi
command -v cargo >/dev/null || fail 'Rust and the platform build tools are required.'
if [ "$MAC" = 1 ]; then
  heavy_lock 'TaskMind macOS'
  npm --prefix native ci
  if [ "$DEBUG" = 1 ]; then
    # A debug-profile bundle, built to prove the toolchain and left where cargo puts it: nothing is quit, replaced or installed.
    (cd native && npm run build -- --debug --bundles app)
    test -x native/src-tauri/target/debug/bundle/macos/TaskMind.app/Contents/MacOS/taskmind
    echo 'built native/src-tauri/target/debug/bundle/macos/TaskMind.app (debug; not installed)'
  else
    # The dmg needs Finder/AppleScript and fails after a good .app; the Release workflow builds installers.
    (cd native && npm run build -- --bundles app)
    WAS_OPEN=0; if pgrep -x taskmind >/dev/null; then WAS_OPEN=1; pkill -x taskmind; sleep 1; fi
    rm -rf /Applications/TaskMind.app
    ditto native/src-tauri/target/release/bundle/macos/TaskMind.app /Applications/TaskMind.app
    test -x /Applications/TaskMind.app/Contents/MacOS/taskmind
    [ "$WAS_OPEN" = 0 ] || open /Applications/TaskMind.app
  fi
  MAC_DONE=1
  heavy_unlock
fi
if [ "$WINDOWS" = 1 ]; then
  heavy_lock 'TaskMind Windows'
  npm --prefix native ci
  (cd native && npm run build -- --bundles msi,nsis)
  WIN_DONE=1
  heavy_unlock
fi
if [ "$IOS" = 1 ]; then
  # iOS DeviceSupport lives on the SPACE drive: mount it first (~/.claude/skills/external-drives/drive.sh mount SPACE).
  [ -d "$HOME/Library/Developer/Xcode/iOS DeviceSupport/." ] || fail 'iOS DeviceSupport is not reachable: mount SPACE first.'
  owed_installs   # first: builds owed to phones that were away land before this run's own
  heavy_lock 'TaskMind iOS'
  npm --prefix native ci
  # gen/apple is generated and ignored; regenerating keeps the icons and the team in step with the sources.
  rm -rf native/src-tauri/gen/apple
  (cd native && APPLE_DEVELOPMENT_TEAM="$APPLE_TEAM_ID" npm run tauri -- ios init)
  # ios init writes Tauri's stock icons into the asset catalog; the TaskMind set in icons/ios never reaches the app without this.
  cp native/src-tauri/icons/ios/AppIcon-*.png native/src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset/
  cmp -s native/src-tauri/icons/ios/AppIcon-512@2x.png native/src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png
  (cd native && APPLE_DEVELOPMENT_TEAM="$APPLE_TEAM_ID" npm run tauri -- ios build --export-method debugging --ci)
  IPA=native/src-tauri/gen/apple/build/arm64/TaskMind.ipa
  [ -f "$IPA" ] || fail 'The signed TaskMind.ipa was not found.'
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
      if [ "$_rc" = 0 ]; then owed_installs clear TaskMind "$device" "$ROOT/$IPA"; continue; fi
      owed_installs record TaskMind "$device" "$ROOT/$IPA"
      if printf '%s\n' "$_log" | grep -Eiq "$PHONE_AWAY"; then
        echo "warning: skipped the phone $_who: it is offline, locked or out of reach; its install is owed" >&2
      else
        echo "error: the install on the phone $_who failed, and not because the phone was away" >&2
        HARD=1
      fi
      PHONES_OWED=$PHONES_OWED"the iOS install on the phone $_who
"
    done
  done <<EOT
$IOS_PHONES
EOT
  set +f
  heavy_unlock
  [ "$HARD" = 0 ] || exit 1
fi
if [ "$ANDROID" = 1 ]; then
  heavy_lock 'TaskMind Android'
  export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
  export ANDROID_SDK_ROOT="$ANDROID_HOME"
  export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
  [ -d "$ANDROID_HOME" ] || fail "no Android SDK at \$ANDROID_HOME ($ANDROID_HOME)"
  # The newest NDK the SDK holds; tauri android init refuses to guess.
  if [ -z "${NDK_HOME:-}" ]; then NDK_HOME=$(ls -d "$ANDROID_HOME"/ndk/*/ 2>/dev/null | sort -V | tail -n 1); NDK_HOME=${NDK_HOME%/}; fi
  [ -n "$NDK_HOME" ] && [ -d "$NDK_HOME" ] || fail "no Android NDK under $ANDROID_HOME/ndk (install one with sdkmanager)"
  export NDK_HOME
  if [ -z "${JAVA_HOME:-}" ]; then JAVA_HOME=$(/usr/libexec/java_home 2>/dev/null || true); fi
  [ -n "$JAVA_HOME" ] && [ -x "$JAVA_HOME/bin/java" ] || fail 'no JDK (set JAVA_HOME)'
  export JAVA_HOME
  export PATH="$JAVA_HOME/bin:$PATH"   # apksigner runs java
  command -v adb >/dev/null || fail 'adb is not on PATH under $ANDROID_HOME/platform-tools'
  if [ "$DEBUG" = 0 ]; then
    # The signing tools of the newest build-tools that has them, and the state of the release key, before anything is built or booted.
    ZIPALIGN=$(ls "$ANDROID_HOME"/build-tools/*/zipalign 2>/dev/null | sort -V | tail -n 1)
    APKSIGNER=$(ls "$ANDROID_HOME"/build-tools/*/apksigner 2>/dev/null | sort -V | tail -n 1)
    [ -n "$ZIPALIGN" ] && [ -n "$APKSIGNER" ] || fail 'no zipalign and apksigner under $ANDROID_HOME/build-tools'
    # One file of the release key without the other is refused before anything is built or booted: a new key cannot update the
    # installed app, so nothing here ever replaces half a key.
    if [ -e "$ANDROID_KEYSTORE" ] || [ -e "$ANDROID_KEYPASS" ]; then
      [ -f "$ANDROID_KEYSTORE" ] && [ -s "$ANDROID_KEYPASS" ] || fail "the release key needs both $ANDROID_KEYSTORE and $ANDROID_KEYPASS; one is missing. Restore it from a backup (a new key cannot update the installed app)"
    else
      [ -x "$JAVA_HOME/bin/keytool" ] || fail 'no keytool in $JAVA_HOME/bin to make the release key'
    fi
  fi
  ARCH=$ANDROID_DEFAULT_ARCH; SERIAL=''
  if [ "$DEBUG" = 0 ]; then
    # A device already reachable (hardware, or an emulator someone left running) wins outright; nothing boots a second one on top of it.
    SERIAL=$(adb devices | awk 'NR>1 && $2=="device" {print $1; exit}')
    if [ -z "$SERIAL" ]; then
      AVD="${ANDROID_AVD:-}"
      if [ -z "$AVD" ]; then
        # avdmanager can call a system image installed that is not on disk, so each candidate is checked on DISK and the first real one wins.
        for CAND in $(emulator -list-avds 2>/dev/null); do
          IMG=$(sed -n 's/^image\.sysdir\.1=//p' "$HOME/.android/avd/$CAND.avd/config.ini" 2>/dev/null)
          if [ -n "$IMG" ] && [ -d "$ANDROID_HOME/$IMG" ]; then AVD="$CAND"; break; fi
        done
      fi
      [ -n "$AVD" ] || fail 'no Android emulator running and no bootable AVD found: is one configured?'
      echo "booting $AVD"
      nohup emulator -avd "$AVD" -no-snapshot-load -no-boot-anim -netdelay none -netspeed full >"${TMPDIR:-/tmp}/taskmind-emulator-$AVD.log" 2>&1 &
      i=0
      while [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" != 1 ]; do
        sleep 5; i=$((i + 1))
        [ "$i" -le 72 ] || fail "$AVD did not finish booting within 6 minutes"
      done
      SERIAL=$(adb devices | awk 'NR>1 && $2=="device" {print $1; exit}')
      [ -n "$SERIAL" ] || fail "$AVD booted but adb sees no device"
    fi
    echo "device: $SERIAL"
    case $(adb -s "$SERIAL" shell getprop ro.product.cpu.abi 2>/dev/null | tr -d '\r') in
      arm64-v8a) ARCH=aarch64 ;; armeabi-v7a) ARCH=armv7 ;; x86_64) ARCH=x86_64 ;; x86) ARCH=i686 ;;
      *) fail "the ABI of $SERIAL is not one of arm64-v8a, armeabi-v7a, x86_64, x86" ;;
    esac
    # The release key is made here, once, when neither file exists (checked above), with a device to install onto.
    if [ ! -e "$ANDROID_KEYSTORE" ] && [ ! -e "$ANDROID_KEYPASS" ]; then
      mkdir -p "$ANDROID_KEY_DIR"; chmod 700 "$ANDROID_KEY_DIR"
      # The password is generated, written 0600 and handed to keytool as a file: it never appears in an argument, the log or the output.
      ( umask 077; LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 40 > "$ANDROID_KEYPASS" )
      [ "$(wc -c < "$ANDROID_KEYPASS" | tr -d ' ')" = 40 ] || { rm -f "$ANDROID_KEYPASS"; fail 'could not generate the release key password'; }
      if ! ( umask 077; "$JAVA_HOME/bin/keytool" -genkeypair -noprompt -keystore "$ANDROID_KEYSTORE" -storetype PKCS12 \
          -storepass:file "$ANDROID_KEYPASS" -keypass:file "$ANDROID_KEYPASS" -alias "$ANDROID_KEY_ALIAS" \
          -keyalg RSA -keysize 4096 -validity 36500 -dname "$ANDROID_KEY_DN" ); then
        rm -f "$ANDROID_KEYSTORE" "$ANDROID_KEYPASS"; fail 'keytool could not make the release key'
      fi
      chmod 600 "$ANDROID_KEYSTORE" "$ANDROID_KEYPASS"
      echo "made the Android release key $ANDROID_KEYSTORE (password in $ANDROID_KEYPASS); back both up"
    fi
    [ -f "$ANDROID_KEYSTORE" ] && [ -s "$ANDROID_KEYPASS" ] || fail "the release key needs both $ANDROID_KEYSTORE and $ANDROID_KEYPASS; one is missing. Restore it from a backup (a new key cannot update the installed app)"
  fi
  npm --prefix native ci
  # gen/android is generated and ignored; regenerating keeps the icons and the identifier in step with the sources. init also adds the
  # Rust Android targets with rustup. A --debug APK is signed with the debug keystore; the release APK is built unsigned and signed below.
  rm -rf native/src-tauri/gen/android
  (cd native && npm run tauri -- android init --ci)
  # android init writes Tauri's stock launcher icons; the TaskMind set in icons/android never reaches the app without this.
  cp -R native/src-tauri/icons/android/. native/src-tauri/gen/android/app/src/main/res/
  cmp -s native/src-tauri/icons/android/mipmap-xxxhdpi/ic_launcher.png native/src-tauri/gen/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png
  if [ "$DEBUG" = 1 ]; then
    (cd native && npm run tauri -- android build --debug --apk --target "$ARCH" --ci)
    APK=$(find native/src-tauri/gen/android/app/build/outputs/apk -name '*.apk' 2>/dev/null | head -n 1)
    [ -n "$APK" ] || fail 'the Android build produced no APK'
    echo "built $APK (debug; not installed)"
  else
    (cd native && npm run tauri -- android build --apk --target "$ARCH" --ci)
    UNSIGNED=$(find native/src-tauri/gen/android/app/build/outputs/apk -path '*release*' -name '*.apk' 2>/dev/null | head -n 1)
    [ -n "$UNSIGNED" ] || fail 'the Android release build produced no APK'
    APK=native/src-tauri/gen/android/app/build/outputs/taskmind-release.apk
    rm -f "$APK" "$APK.aligned"
    "$ZIPALIGN" -p -f 4 "$UNSIGNED" "$APK.aligned" || fail 'zipalign failed'
    "$APKSIGNER" sign --ks "$ANDROID_KEYSTORE" --ks-pass "file:$ANDROID_KEYPASS" --ks-key-alias "$ANDROID_KEY_ALIAS" --out "$APK" "$APK.aligned" || fail 'apksigner could not sign the APK'
    rm -f "$APK.aligned"
    # The signature must verify AND be the release key's: an APK still carrying the debug certificate is never installed.
    CERTS=$("$APKSIGNER" verify --print-certs "$APK") || fail 'the signed APK does not verify'
    printf '%s\n' "$CERTS" | grep -q "certificate DN: $ANDROID_KEY_DN\$" || fail 'the APK is not signed with the TaskMind release key'
    # Package and launch activity are read OFF THE BUILT APK (aapt), not guessed from a manifest path.
    AAPT=$(ls "$ANDROID_HOME"/build-tools/*/aapt 2>/dev/null | sort -V | tail -n 1)
    [ -n "$AAPT" ] || fail 'no aapt under $ANDROID_HOME/build-tools'
    BADGING=$("$AAPT" dump badging "$APK")
    PKG=$(printf '%s\n' "$BADGING" | sed -n "s/^package: name='\([^']*\)'.*/\1/p")
    ACTIVITY=$(printf '%s\n' "$BADGING" | sed -n "s/^launchable-activity: name='\([^']*\)'.*/\1/p")
    [ -n "$PKG" ] && [ -n "$ACTIVITY" ] || fail 'could not read the package and launch activity from the built APK'
    _rc=0; _log=$(adb -s "$SERIAL" install -r "$APK" 2>&1) || _rc=$?
    printf '%s\n' "$_log"
    if [ "$_rc" != 0 ] && printf '%s\n' "$_log" | grep -q 'INSTALL_FAILED_UPDATE_INCOMPATIBLE'; then
      # The device holds TaskMind signed with another key (the debug key of the builds before the release key). Only this exact refusal
      # replaces it: the shell keeps no data but its web login, which is asked for again.
      echo "warning: $PKG on $SERIAL was signed with another key; uninstalling it to install the release build (sign in again)" >&2
      adb -s "$SERIAL" uninstall "$PKG" || fail 'adb uninstall of the differently signed app failed'
      _rc=0; adb -s "$SERIAL" install -r "$APK" || _rc=$?
    fi
    [ "$_rc" = 0 ] || fail 'adb install failed'
    adb -s "$SERIAL" shell am start -n "$PKG/$ACTIVITY" >/dev/null || fail 'the app installed but would not launch'
    # Polled, not one sleep-then-check: a cold launch on an emulator takes a moment to show up in the process list.
    RUNNING=0
    for _ in 1 2 3 4 5 6; do
      if adb -s "$SERIAL" shell 'ps -A' 2>/dev/null | grep -q "$PKG"; then RUNNING=1; break; fi
      sleep 3
    done
    [ "$RUNNING" = 1 ] || fail 'installed and launched but never showed up running'
    echo "installed and running: $PKG on $SERIAL (release, signed with $ANDROID_KEYSTORE)"
  fi
  ANDROID_DONE=1
  heavy_unlock
fi
