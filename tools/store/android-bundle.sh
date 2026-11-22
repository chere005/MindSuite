#!/bin/sh
# Usage: tools/store/android-bundle.sh <CalMind|MealMind> [--really]
# Play Store bundle lane (STUB). Default is a dry run that only prints the plan.
# --really refuses unless the Play service-account key env is present; the real
# branch is not built yet and exits 2. Keys come from the environment only:
#   PLAY_SERVICE_ACCOUNT_JSON (path to the service-account JSON, kept outside the repo)
set -eu
. "$(dirname "$0")/common.sh"

APP=${1:-}
[ -n "$APP" ] || { echo "usage: $0 <CalMind|MealMind> [--really]" >&2; exit 64; }
shift
REALLY=0
for a in "$@"; do
  case "$a" in
    --really) REALLY=1 ;;
    *) echo "unknown option: $a" >&2; exit 64 ;;
  esac
done
DIR=$(store_app_dir "$APP") || exit 64

if [ "$REALLY" = 1 ]; then
  [ -n "${PLAY_SERVICE_ACCOUNT_JSON:-}" ] || { echo "refusing --really: PLAY_SERVICE_ACCOUNT_JSON is not set" >&2; exit 1; }
  [ -f "$PLAY_SERVICE_ACCOUNT_JSON" ] || { echo "refusing --really: PLAY_SERVICE_ACCOUNT_JSON is not a file" >&2; exit 1; }
  echo "android-bundle: the real upload is not built yet" >&2
  exit 2
fi

cat <<PLAN
android-bundle $APP (dry run: nothing is run)
App directory: $DIR

1. Version code: android.versionCode in $DIR/app.json must be higher than any
   code already uploaded to Play. The lane would bump it; this stub does not.
2. Generate the Android project (no android/ directory is committed):
     cd $DIR && npx expo prebuild --platform android
3. Build the release bundle (Play App Signing: sign with the UPLOAD key, whose
   keystore path and passwords come from the environment, never tracked files):
     cd $DIR/android && ./gradlew bundleRelease
   Output: $DIR/android/app/build/outputs/bundle/release/app-release.aab
4. Upload to a Play track (internal or closed testing first) with the service
   account at \$PLAY_SERVICE_ACCOUNT_JSON through the Google Play Developer API
   (edits.bundles.upload, then edits.tracks.update, then edits.commit).
5. Complete the Data safety form and store listing in Play Console; a new
   personal account needs a closed test (12 testers, 14 days) before production.

Run with --really (and PLAY_SERVICE_ACCOUNT_JSON set) to attempt it; the real
branch is a stub and exits 2.
PLAN
