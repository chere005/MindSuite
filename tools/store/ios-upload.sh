#!/bin/sh
# Usage: tools/store/ios-upload.sh <CalMind|MealMind> [--really]
# App Store upload lane (STUB). Default is a dry run that only prints the plan.
# --really refuses unless the App Store Connect API key env is present; the real
# branch is not built yet and exits 2. Keys come from the environment only:
#   ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH (path to the .p8 file, kept outside the repo)
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
  for v in ASC_KEY_ID ASC_ISSUER_ID ASC_KEY_PATH; do
    eval "val=\${$v:-}"
    [ -n "$val" ] || { echo "refusing --really: $v is not set" >&2; exit 1; }
  done
  [ -f "$ASC_KEY_PATH" ] || { echo "refusing --really: ASC_KEY_PATH is not a file" >&2; exit 1; }
  echo "ios-upload: the real upload is not built yet" >&2
  exit 2
fi

cat <<PLAN
ios-upload $APP (dry run: nothing is run)
App directory: $DIR

1. Build number: ios.buildNumber in $DIR/app.json must be higher than the last
   uploaded build for this version (App Store Connect rejects a repeat). The
   lane would auto-increment it; this stub does not touch the file.
2. Regenerate the iOS project when app.json Info.plist inputs changed
   (the lanes otherwise reuse the existing $DIR/ios):
     cd $DIR && npx expo prebuild --platform ios
3. Archive the generated workspace (Release, generic iOS device):
     xcodebuild archive -workspace $DIR/ios/<name>.xcworkspace \\
       -scheme <scheme> -configuration Release \\
       -destination 'generic/platform=iOS' \\
       -archivePath build/store/$APP.xcarchive \\
       -allowProvisioningUpdates
4. Write build/store/ExportOptions.plist with method=app-store-connect,
   teamID=TEAMID0000 (from APPLE_TEAM_ID, never tracked), signingStyle=automatic,
   uploadSymbols=true.
5. Export the ipa:
     xcodebuild -exportArchive -archivePath build/store/$APP.xcarchive \\
       -exportOptionsPlist build/store/ExportOptions.plist \\
       -exportPath build/store/$APP-export -allowProvisioningUpdates
6. Upload with the App Store Connect API key from the environment:
     xcrun altool --upload-app -f build/store/$APP-export/*.ipa -t ios \\
       --apiKey "\$ASC_KEY_ID" --apiIssuer "\$ASC_ISSUER_ID"
   (the .p8 at \$ASC_KEY_PATH is placed where altool looks, outside the repo).
7. Process in App Store Connect, attach to the version, submit for review.

Run with --really (and ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH set) to attempt it;
the real branch is a stub and exits 2.
PLAN
