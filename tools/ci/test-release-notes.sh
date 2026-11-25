#!/bin/bash
# Execute the release-note run blocks themselves against disposable product notes, never Git history or the network.
set -euo pipefail
cd "$(dirname "$0")/../.."
root=$(pwd -P)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/mindsuite-release-notes.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"
for cmd in git gh curl wget ssh scp rsync; do
  cat > "$tmp/bin/$cmd" <<'FORBIDDEN'
#!/bin/sh
printf '%s\n' "forbidden command: $0" >> "$FORBIDDEN_COMMANDS"
exit 97
FORBIDDEN
  chmod +x "$tmp/bin/$cmd"
done
fail() { echo "release notes guard: $*" >&2; exit 1; }
extract_notes() {
  awk '
    /^      - name: Release notes/ { step = 1; next }
    step && /^        run: \|$/ { run = 1; next }
    run && /^          / { print substr($0, 11); next }
    run && /^$/ { print; next }
    run { exit }
  ' "$1" > "$2"
  [ -s "$2" ] || fail "no release-note shell block in $1"
}
expected_installing() {
  case "$1" in
    CalMind) cat <<'INSTALLING'
### Installing

- **Windows** (`CalMind_7.12.0_x64_en-US.msi`, or `CalMind_7.12.0_x64-setup.exe`): the installers are not code-signed, so SmartScreen may say "Windows protected your PC". Choose More info, then Run anyway.
- **macOS** (Apple silicon, `CalMind_7.12.0_aarch64.dmg`): signed with Developer ID and notarized.
- **Updates:** the macOS and Windows apps check for updates themselves (menu: Check for Updates). Linux has no updater.
- **Linux** (x64): `sudo apt install ./CalMind_7.12.0_amd64.deb`, or for the AppImage `chmod +x CalMind_7.12.0_amd64.AppImage` and run it.

`SHA256SUMS.txt` has the checksum of every file.
INSTALLING
      ;;
    MealMind) cat <<'INSTALLING'
## Installing

- **Windows (x64)**: run `MealMind_7.12.0_x64-setup.exe` (or the `.msi`). The installers are not code-signed, so
  SmartScreen may say "Windows protected your PC": choose **More info**, then **Run anyway**.
- **macOS (Apple silicon)**: open `MealMind_7.12.0_aarch64.dmg` and drag MealMind to Applications. The app is signed and notarized.
- `SHA256SUMS.txt` lists the checksum of every installer.
INSTALLING
      ;;
    AcctMind) cat <<'INSTALLING'
## Installing

- **macOS, Apple silicon** (`.dmg`): open the dmg and drag AcctMind to Applications. The app is signed with Developer ID, notarized and stapled, so it opens without a warning.
- **Windows** (`.msi` or `-setup.exe`): the installers are not Authenticode-signed, so SmartScreen says "Windows protected your PC" the first time. Choose **More info**, then **Run anyway**.

Once installed, AcctMind updates itself from **Check for Updates** in its menu (it never checks in the background). The update archives are signed with the app's own update key.

`SHA256SUMS.txt` lists the checksum of every file.
INSTALLING
      ;;
  esac
}
checks=0
for app in CalMind MealMind AcctMind; do
  name=$(printf '%s' "$app" | tr '[:upper:]' '[:lower:]')
  extract_notes "$root/.github/workflows/$name-release.yml" "$tmp/$app.sh"
  expected_installing "$app" > "$tmp/$app-installing.md"
  for state in explicit missing empty whitespace; do
    case_dir="$tmp/$app-$state"
    mkdir -p "$case_dir/$app/docs/releases" "$case_dir/$app/.git" "$case_dir/runner"
    printf '%s\n' INTERNAL_HANDOFF_MUST_STAY_PRIVATE > "$case_dir/$app/HANDOFF.md"
    cp "$case_dir/$app/HANDOFF.md" "$case_dir/$app/docs/CONTINUATION.md"
    cp "$case_dir/$app/HANDOFF.md" "$case_dir/$app/.git/COMMIT_EDITMSG"
    notes="$case_dir/$app/docs/releases/7.12.0.md"
    if [ "$state" = explicit ]; then
      cat > "$notes" <<'PRODUCT'
Product improvements.

Literal @V@, $(git log -1), and `curl example.invalid` remain text.
PRODUCT
      cp "$notes" "$case_dir/intro.md"
    else
      printf '%s 7.12.0\n' "$app" > "$case_dir/intro.md"
      if [ "$state" = empty ]; then : > "$notes"; fi
      if [ "$state" = whitespace ]; then printf ' \t\n\n' > "$notes"; fi
    fi
    cat "$case_dir/intro.md" > "$case_dir/expected.md"
    printf '\n' >> "$case_dir/expected.md"
    cat "$tmp/$app-installing.md" >> "$case_dir/expected.md"
    calls="$case_dir/forbidden-calls"
    if ! (cd "$case_dir/$app" && PATH="$tmp/bin:$PATH" VERSION=7.12.0 TAG="$app/7.12.0" RUNNER_TEMP="$case_dir/runner" FORBIDDEN_COMMANDS="$calls" bash -e -o pipefail "$tmp/$app.sh") > "$case_dir/stdout" 2>&1; then
      fail "$app $state did not generate release notes"
    fi
    [ ! -s "$calls" ] || fail "$app $state invoked Git or a network command"
    file="$case_dir/runner/release-notes.md"
    [ -f "$file" ] || fail "$app $state produced no release-note file"
    cmp -s "$case_dir/expected.md" "$file" || { diff -u "$case_dir/expected.md" "$file" >&2 || true; fail "$app $state altered product notes, fallback, or Installing text"; }
    ! grep -q INTERNAL_HANDOFF_MUST_STAY_PRIVATE "$file" || fail "$app $state copied internal notes"
    checks=$((checks + 1))
  done
done
printf 'release notes guards: %s cases passed\n' "$checks"
