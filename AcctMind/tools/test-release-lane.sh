#!/bin/sh
# The release lane's signing and update-feed pieces, tested without leaving the machine:
#
#   * tools/publish-update.sh (the feed step) with `gh` and the suite's publish tool replaced by stubs: it signs a Windows
#     installer only when the SHA-256 of that very file was printed by a run of the tag's release workflow, refuses a draft
#     release, a wrong set of installers and a version that is not x.y.z, and never leaves its download folder behind;
#   * the lane's static rules: build-platforms.sh installs ONLY through tools/mac-sign-install.sh (no ad hoc signing, no bare
#     copy over /Applications), dtp.sh publishes the feed AFTER the push and the followed release and never before, and the
#     workflow prints the installers' digests the feed step looks for.
#
#   sh tools/test-release-lane.sh
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PUBLISH_UPDATE_SRC=${PUBLISH_UPDATE_SRC:-$ROOT/tools/publish-update.sh}
PLATFORMS_SRC=${PLATFORMS_SRC:-$ROOT/tools/build-platforms.sh}
DTP_SRC=${DTP_SRC:-$ROOT/tools/dtp.sh}
WORKFLOW_SRC=${WORKFLOW_SRC:-$ROOT/../.github/workflows/acctmind-release.yml}
TMP=$(mktemp -d "${TMPDIR:-/tmp}/acctmind-lane-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT
trap 'exit 130' INT TERM
echo 0 > "$TMP/n"
PASS=0; FAIL=0
check() {   # check "description" command...   (passes when the command succeeds)
  _d=$1; shift
  if "$@" >/dev/null 2>&1; then PASS=$((PASS + 1)); echo "  ok   $_d"; else FAIL=$((FAIL + 1)); echo "  FAIL $_d"; fi
}
not() { ! "$@"; }

# ---- publish-update.sh -----------------------------------------------------------------------------------------------
pu_case() {
  _n=$(( $(cat "$TMP/n") + 1 )); echo "$_n" > "$TMP/n"
  U=$TMP/pu-$_n; mkdir -p "$U/tools" "$U/bin" "$U/docs/releases"; ULOG=$U/log; : > "$ULOG"
  cp "$PUBLISH_UPDATE_SRC" "$U/tools/publish-update.sh"
  git -C "$U" init -q 2>/dev/null; git -C "$U" remote add origin git@github.com:chere005/MindSuite.git
  printf '{"name":"acctmind","version":"5.1.0"}\n' > "$U/package.json"
  cat > "$U/bin/gh" <<'GHEOF'
#!/bin/sh
echo "gh $*" >> "$ULOG"
case "$1 $2" in
  "release view") echo "${STUB_DRAFT:-false}" ;;
  "run list") case "${STUB_RUNS:-one}" in one) echo 111; echo 112 ;; none) ;; esac ;;
  "run view")
    case " $* " in
      *" --json "*) echo 9001 ;;
      *" --job "*)
        # the log lines carry the job, step and timestamp in front; the script text echoed by the run: block must not count
        printf 'Windows installers\tPrint\t2026-11-23T01:02:03Z printf MINDSUITE-DIGEST sha256 %%s %%s\n'
        e=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
        case "${STUB_DIGEST:-match}" in
          match) printf 'Windows installers\tPrint\t2026-11-23T01:02:04Z MINDSUITE-DIGEST sha256 %s AcctMind_5.1.0_x64_en-US.msi\nWindows installers\tPrint\t2026-11-23T01:02:04Z MINDSUITE-DIGEST sha256 %s AcctMind_5.1.0_x64-setup.exe\n' "$e" "$e" ;;
          swapped) printf 'Windows installers\tPrint\t2026-11-23T01:02:04Z MINDSUITE-DIGEST sha256 %s AcctMind_5.1.0_x64_en-US.msi\nWindows installers\tPrint\t2026-11-23T01:02:04Z MINDSUITE-DIGEST sha256 %064d AcctMind_5.1.0_x64-setup.exe\n' "$e" 7 ;;
          onlymsi) printf 'Windows installers\tPrint\t2026-11-23T01:02:04Z MINDSUITE-DIGEST sha256 %s AcctMind_5.1.0_x64_en-US.msi\n' "$e" ;;
          othername) printf 'Windows installers\tPrint\t2026-11-23T01:02:04Z MINDSUITE-DIGEST sha256 %s AcctMind_4.0.0_x64_en-US.msi\nWindows installers\tPrint\t2026-11-23T01:02:04Z MINDSUITE-DIGEST sha256 %s AcctMind_4.0.0_x64-setup.exe\n' "$e" "$e" ;;
          none) ;;
        esac ;;
    esac ;;
  "release download")
    while [ $# -gt 0 ]; do [ "$1" != --dir ] || d=$2; shift; done
    case "${STUB_ASSETS:-both}" in
      both) : > "$d/AcctMind_5.1.0_x64_en-US.msi"; : > "$d/AcctMind_5.1.0_x64-setup.exe" ;;
      twomsi) : > "$d/AcctMind_5.1.0_x64_en-US.msi"; : > "$d/AcctMind_5.1.0_x64_fr-FR.msi"; : > "$d/AcctMind_5.1.0_x64-setup.exe" ;;
      nonsis) : > "$d/AcctMind_5.1.0_x64_en-US.msi" ;;
    esac ;;
esac
GHEOF
  chmod +x "$U/bin/gh"
  printf 'require("node:fs").appendFileSync(process.env.ULOG, "tool " + process.argv.slice(2).map((a) => a.replace(/^[/].*[/]/, "")).join(" ") + "\\n");\nif (process.env.STUB_TOOL_FAIL) process.exit(1);\n' > "$U/tool.cjs"
}
pu() { RC=0; ( cd "$U" && PATH="$U/bin:$PATH" ULOG=$ULOG MINDSUITE_PUBLISH_UPDATE_TOOL="$U/tool.cjs" ACCTMIND_INSTALLED_APP=/scratch/AcctMind.app sh tools/publish-update.sh "$@" ) > "$U/out" 2>&1 || RC=$?; }

t_publish_update() {
  pu_case; pu
  check 'a published release signs and publishes the update feed' test "$RC" -eq 0 -a "$(grep -c '^tool ' "$ULOG")" -eq 1
  check 'for AcctMind 5.1.0, from the installed app, with both Windows installers and plain notes' grep -q '^tool --app AcctMind --version 5.1.0 --repo chere005/MindSuite --mac-app AcctMind.app --win-nsis AcctMind_5.1.0_x64-setup.exe --win-msi AcctMind_5.1.0_x64_en-US.msi --notes AcctMind 5.1.0$' "$ULOG"
  check 'it asked about the tag AcctMind/5.1.0 in the origin repo' grep -q '^gh release view AcctMind/5.1.0 --repo chere005/MindSuite' "$ULOG"
  pu_case; echo 'Fixed things.' > "$U/docs/releases/5.1.0.md"; pu --dry-run /x/feed
  check 'a notes file for the version is passed as the notes, and extra options reach the tool' grep -q -- '--notes-file docs/releases/5.1.0.md --dry-run feed$' "$ULOG"
  pu_case; STUB_DRAFT=true; export STUB_DRAFT; pu
  check 'a draft release is refused before anything is downloaded or signed' test "$RC" -ne 0 -a "$(grep -c '^tool \|release download' "$ULOG")" -eq 0
  check 'and the message says it is not published' grep -q 'is not published' "$U/out"
  unset STUB_DRAFT
  pu_case; STUB_ASSETS=twomsi; export STUB_ASSETS; pu
  check 'two msi files are refused' test "$RC" -ne 0 -a "$(grep -c '^tool ' "$ULOG")" -eq 0
  pu_case; STUB_ASSETS=nonsis; export STUB_ASSETS; pu
  check 'a missing setup exe is refused' test "$RC" -ne 0 -a "$(grep -c '^tool ' "$ULOG")" -eq 0
  unset STUB_ASSETS
  pu_case; STUB_TOOL_FAIL=1; export STUB_TOOL_FAIL; pu
  check 'a failing publish tool fails the step' test "$RC" -ne 0
  unset STUB_TOOL_FAIL
  for mode in swapped onlymsi othername none; do
    pu_case; STUB_DIGEST=$mode; export STUB_DIGEST; pu
    check "an installer whose digest the workflow did not print ($mode) is never signed" test "$RC" -ne 0 -a "$(grep -c '^tool ' "$ULOG")" -eq 0
    check "and the message says nothing was signed ($mode)" grep -q 'is not a file the AcctMind/5.1.0 workflow built' "$U/out"
  done
  unset STUB_DIGEST
  pu_case; STUB_RUNS=none; export STUB_RUNS; pu
  check 'no workflow run at all means no signature' test "$RC" -ne 0 -a "$(grep -c '^tool ' "$ULOG")" -eq 0
  unset STUB_RUNS
  pu_case; pu
  check 'the digests come from the runs of the tag, by the windows job log' sh -c "grep -q '^gh run list --repo chere005/MindSuite --workflow acctmind-release.yml --branch AcctMind/5.1.0' '$ULOG' && grep -q '^gh run view --job 9001 ' '$ULOG'"
  pu_case; printf '{"name":"acctmind","version":"5.1"}\n' > "$U/package.json"; pu
  check 'a version that is not x.y.z is refused' test "$RC" -ne 0 -a "$(grep -c 'gh ' "$ULOG")" -eq 0
  check 'the temporary download folder is removed' test -z "$(ls -d "${TMPDIR:-/tmp}"/acctmind-update.* 2>/dev/null)"
  # the installed app is where the install step put it: ACCTMIND_INSTALL_DIR moves both
  pu_case; RC=0; ( cd "$U" && PATH="$U/bin:$PATH" ULOG=$ULOG MINDSUITE_PUBLISH_UPDATE_TOOL="$U/tool.cjs" ACCTMIND_INSTALL_DIR=/scratch/apps sh tools/publish-update.sh ) > "$U/out" 2>&1 || RC=$?
  check 'ACCTMIND_INSTALL_DIR names the app the feed is signed from' grep -q -- '--mac-app AcctMind.app ' "$ULOG"
}

# ---- the lane's static rules -----------------------------------------------------------------------------------------
t_static() {
  check 'the macOS step installs through tools/mac-sign-install.sh' grep -q 'tools/mac-sign-install.sh' "$PLATFORMS_SRC"
  check 'build-platforms.sh has no ad hoc signing, bare ditto/cp over /Applications, or app deletion left (comments aside)' sh -c "! grep -v '^ *#' '$PLATFORMS_SRC' | grep -qE 'codesign|ditto|rm -rf \"/Applications|cp -R \"\\\$APPBUNDLE\"|pkill'"
  check 'it never passes an ad hoc identity to the script' not grep -qE -- '--identity +-|MIND_SIGN_IDENTITY=-' "$PLATFORMS_SRC"
  check 'the heavy-build lock is released before waiting for Apple' awk '/heavy_unlock/ && !u {u=NR} /mac-sign-install.sh/ && !s {s=NR} END {exit !(u && s && u < s)}' "$PLATFORMS_SRC"
  check 'dtp.sh publishes the update feed' grep -q 'sh tools/publish-update.sh' "$DTP_SRC"
  check 'and only after the push and the followed release' awk '/git push --atomic origin main/ && !p {p=NR} /gh-bot.sh release/ && !r {r=NR} /sh tools\/publish-update.sh \\/ && !f {f=NR} END {exit !(p && r && f && p < r && r < f)}' "$DTP_SRC"
  check 'a failed feed makes the lane end non-zero' grep -q 'UPDATE_FAILED' "$DTP_SRC"
  check 'the workflow prints the installers digests the feed step looks for' grep -q 'MINDSUITE-DIGEST sha256' "$WORKFLOW_SRC"
  check 'the workflow publishes without the Latest flag' grep -q -- '--draft=false --latest=false' "$WORKFLOW_SRC"
  check 'the workflow notarizes and verifies the dmg' sh -c "grep -q 'tools/ci/notarize-dmg.sh' '$WORKFLOW_SRC' && grep -q 'tools/ci/verify-macos-dmg.sh' '$WORKFLOW_SRC'"
  check 'no step asks for updater artifacts or a Windows certificate' not grep -qE 'createUpdaterArtifacts|TAURI_SIGNING_PRIVATE_KEY|signCommand|certificateThumbprint|WINDOWS_CERTIFICATE' "$WORKFLOW_SRC" "$ROOT/desktop/src-tauri/tauri.conf.json"
}

case "${1:-}" in
  '') t_publish_update; t_static ;;
  --only) "${2:?test name}" ;;
  *) echo "usage: $0 [--only t_publish_update|t_static]" >&2; exit 2 ;;
esac
echo ""
echo "$PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
