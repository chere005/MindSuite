#!/bin/sh
# tools/ios-generated.sh, case by case, on a fake app in a scratch dir (#121,
# #159). No Xcode, no CocoaPods: it checks the DECISION — when the lane must
# regenerate ios/ and when it may build what is there.
#
#   sh tools/check-ios-generated.sh
set -u
cd "$(dirname "$0")/.."
. tools/ios-generated.sh

T=$(mktemp -d "${TMPDIR:-/tmp}/calmind-iosgen.XXXXXX")
trap 'rm -rf "$T"' EXIT
A="$T/app"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s\n' "$1"; }

fresh_app() {
  rm -rf "$A"; mkdir -p "$A/ios/App.xcworkspace" "$A/ios/Pods" "$A/ios/build/generated/ios/ReactCodegen" "$A/targets/watch"
  printf '{"expo":{"name":"App","version":"1.0.0","ios":{"buildNumber":"1"},"plugins":["x"]}}' > "$A/app.json"
  printf '{"name":"app","version":"1.0.0","dependencies":{"expo":"57.0.0"}}' > "$A/package.json"
  printf '{"lockfileVersion":3}' > "$T/package-lock.json"
  printf 'PODS: [a]\n' > "$A/ios/Podfile.lock"; cp "$A/ios/Podfile.lock" "$A/ios/Pods/Manifest.lock"
  printf 'x' > "$A/ios/build/generated/ios/ReactCodegen/RCTAppDependencyProvider.mm"
  printf 'struct W {}' > "$A/targets/watch/W.swift"
  ios_inputs_key "$A" > "$A/ios/.prebuild-inputs"
}
# expect <stale|fresh> <label> — runs the check on $A as it stands
expect() {
  if WHY=$(ios_stale_reason "$A"); then got=stale; else got=fresh; fi
  if [ "$got" = "$1" ]; then ok "$2${WHY:+ — $WHY}"; else bad "$2: expected $1, got $got${WHY:+ ($WHY)}"; fi
  WHY=''
}

fresh_app; expect fresh "a just-generated ios/ is built as it stands"
fresh_app; rm -rf "$A/ios/App.xcworkspace"; expect stale "no workspace"
fresh_app; rm -rf "$A/ios/Pods"; expect stale "workspace kept, Pods deleted"
fresh_app; printf 'PODS: [b]\n' > "$A/ios/Podfile.lock"; expect stale "Pods out of sync with Podfile.lock"
fresh_app; rm -rf "$A/ios/build"; expect stale "codegen sources gone"
fresh_app; rm -f "$A/ios/.prebuild-inputs"; expect stale "an ios/ the lane never recorded"
fresh_app; sed -i '' 's/57.0.0/57.0.1/' "$A/package.json"; expect stale "a dependency changed since it was generated"
fresh_app; printf '{"lockfileVersion":3,"x":1}' > "$T/package-lock.json"; expect stale "the lockfile changed"
fresh_app; sed -i '' 's/"x"/"y"/' "$A/app.json"; expect stale "an app.json plugin changed"
fresh_app; printf 'struct N {}' > "$A/targets/watch/N.swift"; expect stale "a native target gained a file"
fresh_app; sed -i '' 's/1.0.0/1.1.0/; s/"buildNumber":"1"/"buildNumber":"2"/' "$A/app.json"
          sed -i '' 's/"version":"1.0.0"/"version":"1.1.0"/' "$A/package.json"
          expect fresh "a version bump alone does not regenerate (the lane syncs it)"
fresh_app; printf 'struct W { let x = 1 }' > "$A/targets/watch/W.swift"; expect fresh "a Swift edit alone does not regenerate (compiled in place)"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
