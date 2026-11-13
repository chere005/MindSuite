#!/usr/bin/env node
// Repairs ReactNativeDependencies.xcframework's maccatalyst slice so it
// survives Mac Catalyst codesigning, by patching the fix INTO the CocoaPods
// "[CP-User] [RNDeps] Replace React Native Dependencies..." build phase
// itself — not just running it once before a build.
//
// Why it has to live there: that phase is `alwaysOutOfDate = 1` and calls
// react-native's own replace_dependencies_version.js on EVERY build, which
// re-extracts the PRISTINE (broken) bundle from its packaged source every
// single time. A fix applied to ios/Pods/ before `xcodebuild` runs gets
// silently wiped by this exact phase moments later — proven the hard way,
// twice, while diagnosing MyCalMind's Catalyst build on 2026-08-22.
//
// What's actually broken in the vendored bundle, for the maccatalyst slice
// specifically: the top-level `ReactNativeDependencies` binary and
// `Resources/` are real duplicate copies of what's also (correctly) inside
// `Versions/A/`, instead of the symlinks a proper macOS-style versioned
// framework needs (`Versions/Current -> A`, top-level entries pointing
// through it) — Xcode's embed step explicitly requires that layout for a
// macOS destination ("does not use shallow bundles"). The three
// `ReactNativeDependencies_{boost,folly,glog}.bundle` resource bundles
// (privacy manifests only, no code) sit at the bundle root instead of
// under `Versions/A/`, which trips "unsealed contents present in the root
// directory of an embedded framework" — and even moved into Versions/A,
// codesign wants them independently signed as subcomponents, which they
// aren't and don't need to be, so this script drops them instead.
//
// Usage: node patch-rndeps-catalyst.js <path/to/Pods.xcodeproj/project.pbxproj>
// Idempotent — safe to run on every prebuild; does nothing if already patched.

const fs = require('fs');

const pbxprojPath = process.argv[2];
if (!pbxprojPath) {
  console.error('usage: patch-rndeps-catalyst.js <Pods.xcodeproj/project.pbxproj>');
  process.exit(1);
}
if (!fs.existsSync(pbxprojPath)) {
  console.error(`patch-rndeps-catalyst.js: no such file: ${pbxprojPath}`);
  process.exit(1);
}

let content = fs.readFileSync(pbxprojPath, 'utf8');

const REPAIR_MARKER = 'MACCAT_RNDEPS_REPAIR';
if (content.includes(REPAIR_MARKER)) {
  console.log('patch-rndeps-catalyst.js: already patched, nothing to do');
  process.exit(0);
}

// Match the replace_dependencies_version.js invocation regardless of the
// react-native version string baked into -r "X.Y.Z" — that changes across
// MyCalMind releases, the surrounding call shape does not.
const invocationPattern = /(\\"\$NODE_BINARY\\" \\"\$REACT_NATIVE_PATH\/third-party-podspecs\/replace_dependencies_version\.js\\" -c \\"\$CONFIG\\" -r \\"[^\\]*\\" -p \\"\$PODS_ROOT\\"\\n)/;

const match = content.match(invocationPattern);
if (!match) {
  console.error(
    'patch-rndeps-catalyst.js: could not find the replace_dependencies_version.js invocation — ' +
      'react-native changed this script phase, update the pattern in this file.'
  );
  process.exit(1);
}

// Every literal `"` here must be written as `\"`: this whole block is
// inserted INSIDE the pbxproj's own quoted shellScript string value, so a
// bare `"` prematurely closes that outer string and corrupts the file —
// exactly what happened the first time this script was written (it parsed
// fine as JS, and still corrupted the .pbxproj).
const repair =
  `\\n      # ${REPAIR_MARKER}: see bin/patch-rndeps-catalyst.js for why this lives here.\\n` +
  '      MACCAT=\\"$PODS_ROOT/ReactNativeDependencies/framework/packages/react-native/ReactNativeDependencies.xcframework/ios-arm64_x86_64-maccatalyst/ReactNativeDependencies.framework\\"\\n' +
  '      if [ -d \\"$MACCAT\\" ] && [ ! -L \\"$MACCAT/ReactNativeDependencies\\" ]; then\\n' +
  '        rm -rf \\"$MACCAT/ReactNativeDependencies\\" \\"$MACCAT/Resources\\" \\"$MACCAT/Versions/Current\\" \\"$MACCAT\\"/ReactNativeDependencies_*.bundle \\"$MACCAT/Versions/A\\"/ReactNativeDependencies_*.bundle\\n' +
  '        ln -s A \\"$MACCAT/Versions/Current\\"\\n' +
  '        ln -s Versions/Current/ReactNativeDependencies \\"$MACCAT/ReactNativeDependencies\\"\\n' +
  '        ln -s Versions/Current/Resources \\"$MACCAT/Resources\\"\\n' +
  '      fi\\n';

content = content.replace(invocationPattern, match[1] + repair);
fs.writeFileSync(pbxprojPath, content);
console.log('patch-rndeps-catalyst.js: patched ' + pbxprojPath);
