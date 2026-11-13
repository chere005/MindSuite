---
name: make-deployment
description: Set up or finish a project's GitHub Releases pipeline with tag-built installers, preflight checks, and release-lane integration. Use for publishing downloadable application builds, rather than website hosting or infrastructure deployment.
---

# Make a project a deployment

A version tag builds the supported platforms' installers on GitHub runners, attaches them to one release, and publishes it only when every expected file is there. Keep the project's existing release conventions. Use authorization already given for the current task; `dtp`/`tdtp` authorizes that project's own lane. Setting up a pipeline alone does not authorize publication, production website deployment, credential changes, or Git history rewrites.

## Inspect before writing

- App kind: Tauri, Electron or other. Other kinds: define the build command and output file names yourself before writing anything.
- Version: list EVERY file that carries it (package.json, lockfile, Cargo.toml, tauri.conf.json, ...). The tag must equal all of them.
- Tag style: bare (`1.4.0`) or `v1.4.0`. Match existing tags (`git tag`) and the workflow's `tags:` pattern.
- Platforms and exact output names: Tauri `src-tauri/target/release/bundle/{msi,nsis,dmg,deb,appimage,rpm}`; Electron the `artifactName`/config. Never guess names; the publish job checks each one with the version in it.
- Existing lane (`tools/dtp.*`, `tools/tdtp.*`, `npm run dtp`) and CI. Read the lane first and keep its version bump, drift gate, locks, status reporting and exit codes. Move the old CI gates into the build jobs, then retire the old workflow and fix every mention of it.
- Signing: are certificates, notarization or updater keys present as secrets? Assume not. Unsigned is fine; see Installing notes.
- Repo public or private, supported architectures, and runner cost. Keep private project names and paths out of public files, commit messages, tag annotations, release notes, and assets. Scan the exact source tree to be tagged; source archives expose that tree too. Do not republish an old tree containing private references merely because its binaries match. Do not rewrite published history without explicit authorization.
- Existing workflow failures and notification preferences. Preflight reduces preventable failed-run notifications; it cannot guarantee notification behavior or prevent failures after validation.

## Pipeline shape

`.github/workflows/release.yml`, `name: Release`. Choose the [Electron](templates/electron-release.yml) or [Tauri](templates/tauri-release.yml) starting point and read the [adaptation notes](templates/README.md). These examples contain project-specific commands and paths that must be adapted.

- Triggers: tag push (the repo's pattern) and `workflow_dispatch` with `tag` (an EXISTING tag; this is also how a past version gets its first release) and `preflight` (boolean, default false). `permissions: contents: write`; `concurrency` per tag, no cancel; `timeout-minutes` on every job.
- `prepare` (ubuntu): the tag equals the version in every file (error names the files); refuse a tag that is already a PUBLISHED release; notes = tag annotation without `Co-Authored-By`/`Signed-off-by`, else the tagged commit message, else "<App> <version>"; append the Installing block; create or reuse the DRAFT (`gh release create --draft --verify-tag`); two drafts for a tag is an error. In preflight it validates and creates no release; with a blank tag it derives the tag from the version files and checks only that they agree.
- One build job per platform, `needs: prepare`. Run the real gates (typecheck, tests), build, list the files, then `gh release upload <tag> <files> --clobber` straight into the draft (or the tool's own attach-to-release feature).
- `publish` (ubuntu, needs all builds): list assets, check every expected file, write and upload `SHA256SUMS.txt`, then `gh release edit <tag> --draft=false --latest` (`--prerelease` instead when the version contains `-`). A missing file errors and leaves the DRAFT. Skipped in preflight.
- NEVER `actions/upload-artifact` or `download-artifact`: Actions artifact storage is a small account-wide quota, and once full every run fails with "Failed to CreateArtifact" (and mails). Release assets do not count against it. For failure evidence use the job log or run summary.
- Preflight mode: every job gets job-level `continue-on-error: ${{ inputs.preflight == true }}`, nothing is uploaded or published, and the run summary lists each job's result. Inspect individual jobs AND steps: a green run can contain failures. Require every expected build to finish successfully; cancelled, missing, or unexpectedly skipped builds do not count. Preserve documented informational test steps only when the project already allows them, and report their actual results separately.
- Preflight always checks out the dispatched commit, even when a tag input is supplied. Real runs check out the requested tag. Keep action and runtime versions compatible with the target project; do not change Node versions just to match an example.

## Validate before publishing

Inspect recent runs of the affected workflows (`gh run list --workflow <name> --limit 3`), diagnose relevant failures, and preflight the final release commit before tagging. Wait for every promised installer; do not cancel slower builds once macOS passes. Avoid unrelated workflow changes. Once checks pass, proceed with already-authorized publication rather than asking again.

## Lane integration

`dtp` = deploy, tag, push; `tdtp` = tests first (see AgentSuite README "Suite releases").

- `tools/preflight.sh` (from [the template](templates/preflight.sh); invoke with `bash`) goes before the tag. Configure the expected-job manifest described in the [adaptation notes](templates/README.md), including every matrix-expanded installer job. It creates a uniquely named temporary ref using a lease that requires absence, dispatches `Release` with `preflight=true`, finds the run by branch, commit, event, and creation time, reads every expected job and step, and removes its ref only if it still points at that commit. Exit 1 on failure. Do not add a skip flag unless the existing lane already defines its use.
- Never tag around a failed preflight, test or deploy step. A bumped but untagged version is reused, not bumped again.
- After the tag push, find the run for that exact tag and commit and inspect every job. If it fails, keep the release a draft, inspect the cause, fix and preflight the correction, then use a bounded rerun where safe. Check current release state before retrying a mutation after an ambiguous response; never rebuild an already published tag. Preserve the lane's exit-code convention and stop for user input if completion requires new credentials, a production change outside the request, or rewriting existing tags.
- Backfill an existing tag: `gh workflow run Release -f tag=<tag>`.

## Installing notes (in release bodies)

Unsigned builds need these; omit a line only when that platform is signed.

- Windows: SmartScreen, "More info", "Run anyway".
- macOS: not notarized, so right-click, Open; or System Settings, Privacy & Security, Open Anyway.
- Linux: `chmod +x` the AppImage.

In-app updating and signing are a separate optional step that needs keys (Tauri updater key, Developer ID, Windows certificate); do not add them unasked.

## Verify before calling it done

1. YAML parses (`actionlint` if installed, else a YAML parser); `sh -n` on every script.
2. Tag-vs-version failure demonstrated: dispatch or reason through a tag that disagrees with one file and see `prepare` name that file.
3. Every required job and step passes preflight from the final commit. Exercise helper scripts with stubbed Git/GitHub commands: failures and skipped builds must be rejected, and temporary-ref cleanup must preserve pre-existing refs. Windows npm scripts run under npm's chosen shell, independently of the workflow shell; POSIX `TZ=...` scripts require Git Bash or a portable runner. Tauri's build hooks likewise need an explicit Bash invocation when they use Bash syntax.
4. For authorized publication, use a new annotated tag on the sanitized commit, or an existing tag only when its source tree is suitable. Verify the real run, then `gh release view <tag> --json assets,isDraft`: every expected asset plus `SHA256SUMS.txt`, `isDraft` false. Compare checksum entries against GitHub's asset digests, or download and hash assets when digests are absent. Distinguish installer build/smoke checks from a manual user install.
5. No artifact actions in the repo: `git grep -n "artifact@"` under `.github/`.
6. Last run of every remaining workflow is green or the workflow is gone.
