# Is the generated ios/ fit to build as it stands? Sourced by
# tools/build-platforms.sh; tested by tools/check-ios-generated.sh.
#
# WHY. ios/ is generated (expo prebuild + pod install) and gitignored, and the
# lane used to regenerate it only when there was no .xcworkspace at all. Two
# ways that went wrong, both paid for:
#   #121  the workspace survived but ios/Pods did not (a disk clean-up, a
#         `rm -rf Pods`): xcodebuild then fails on a workspace whose Pods
#         project is gone.
#   #159  an OLD ios/ — generated before a dependency or app.json change —
#         was reused, and the build died on missing ReactCodegen sources.
# So "a workspace exists" is not the test. The test is: Pods installed and in
# sync with Podfile.lock (CocoaPods' own check), the codegen sources present,
# and the inputs the folder was generated from unchanged since it was made —
# recorded in ios/.prebuild-inputs by the lane after each prebuild. Anything
# else regenerates with `expo prebuild --clean`, which costs minutes, against
# a failed release.
#
# The inputs key leaves out the VERSION (expo.version, ios.buildNumber,
# android.versionCode, package.json version): it changes every release, and
# sync_ios_version writes it into the generated project without a prebuild.
# It includes the checkout's path, because the Pods configs hold absolute
# paths and an ios/ copied from elsewhere points at the other checkout.

# ios_inputs_key <app-dir> — prints one hash of what ios/ is generated from.
ios_inputs_key() {
  node - "$1" <<'JS'
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const app = path.resolve(process.argv[2]);
const h = crypto.createHash('sha256');
const add = (label, s) => h.update(`${label}\0${s}\0`);
add('dir', app);
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
try {
  const j = JSON.parse(read(path.join(app, 'app.json')) || '{}');
  if (j.expo) {
    delete j.expo.version;
    if (j.expo.ios) delete j.expo.ios.buildNumber;
    if (j.expo.android) delete j.expo.android.versionCode;
  }
  add('app.json', JSON.stringify(j));
} catch { add('app.json', read(path.join(app, 'app.json'))); }
try {
  const p = JSON.parse(read(path.join(app, 'package.json')) || '{}');
  delete p.version;
  add('package.json', JSON.stringify(p));
} catch { add('package.json', read(path.join(app, 'package.json'))); }
// The lockfile, wherever npm keeps it: the app's own, or the workspace root's.
for (let d = app, i = 0; i < 4; i++, d = path.dirname(d)) {
  const lock = path.join(d, 'package-lock.json');
  if (fs.existsSync(lock)) { add('lock', read(lock)); break; }
}
// Native targets and local modules: their file LIST and their manifests
// (podspecs, module configs). Swift edits are compiled from where they sit and
// need no prebuild; an added or removed file does.
const walk = (d, out) => {
  if (!fs.existsSync(d)) return out;
  for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
};
for (const dir of ['targets', 'modules', 'plugins']) {
  for (const f of walk(path.join(app, dir), [])) {
    const rel = path.relative(app, f);
    add('file', rel);
    if (/\.(podspec|json|plist|entitlements|js|ts)$/.test(f) && !/\.swift$/.test(f)) add('content', read(f));
  }
}
process.stdout.write(h.digest('hex') + '\n');
JS
}

# ios_stale_reason <app-dir> — prints why ios/ must be regenerated, or nothing
# (and returns 1) when it can be built as it stands.
ios_stale_reason() {
  _app="$1"; _ios="$_app/ios"
  _ws=$(ls -d "$_ios"/*.xcworkspace 2>/dev/null | head -1)
  if [ -z "$_ws" ]; then echo "no workspace"; return 0; fi
  if [ ! -f "$_ios/Pods/Manifest.lock" ]; then echo "the workspace is there but ios/Pods is not (#121)"; return 0; fi
  if ! cmp -s "$_ios/Podfile.lock" "$_ios/Pods/Manifest.lock"; then echo "ios/Pods is out of sync with Podfile.lock"; return 0; fi
  if [ -z "$(ls -A "$_ios/build/generated/ios/ReactCodegen" 2>/dev/null)" ]; then
    echo "the ReactCodegen sources are missing (#159)"; return 0
  fi
  _want=$(ios_inputs_key "$_app") || { echo "could not read the app's inputs"; return 0; }
  if [ "$(cat "$_ios/.prebuild-inputs" 2>/dev/null)" != "$_want" ]; then
    echo "it was generated from different inputs, or before the lane recorded them (#159)"; return 0
  fi
  return 1
}
