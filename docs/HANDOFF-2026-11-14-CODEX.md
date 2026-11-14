# Codex handoff — November 14, 2026

The owner requested a pause. All implemented code is pushed to main. CalMind is published; ChefMind is paused immediately before tagging. No local release controller or watcher remains, and the recorded GitHub jobs have completed. Do not resume work until asked.

## Release checkpoint

- **CalMind 1.69.0 is published:** [release](https://github.com/chere005/MindSuite/releases/tag/CalMind/1.69.0), [release run 43631340078](https://github.com/chere005/MindSuite/actions/runs/43631340078). All platforms passed. Developer ID signing and notarization passed. All five installers and SHA256SUMS.txt are present; installer checksums match GitHub's asset digests. The tag points to code commit `b8f9591`.
- **ChefMind 1.44.0 remains untagged and unpublished.** Its web deployment and native builds are complete. [Signed preflight 43631406931](https://github.com/chere005/MindSuite/actions/runs/43631406931) passed Windows, macOS, and signature/notarization verification, with no failed steps. The local controller was stopped at the owner's request before it could create the tag. This is an intentional pause, not a build failure.
- **Apple is unblocked.** The owner accepted the Developer Program agreement. Earlier authenticated checks still returned 403, but the fresh CalMind preflight and both apps' notarization checks subsequently passed. Do not ask for agreement acceptance again.
- Site **0.72.0** is live on production, TEST, and dev: implementation `8a834fd`, rollout record/main `90d4b02`. The three changed TaskMind scripts match local SHA-256 hashes in every instance.
- CalMind production/TEST and ChefMind production serve the current bundles. The CalMind API security fix is also deployed to DEV; app.php matches locally on all three instances. Shared sign-in settings and DEV's legacy mode were preserved.
- Installed Mac app signatures were strictly verified. Both external drives were mounted afterward at the user's explicit request; leave them mounted unless asked otherwise.

## Resume scope

Only ChefMind publication remains for ticket **#251**. On explicit resume, use ChefMind's own `tools/dtp.sh --web` from the clean main checkout. It reuses the already-bumped, untagged **1.44.0**. Run the root preflight before pushing; require the lane's signed preflight and follow the bot through actual publication, rather than stopping at a successful tag push.

Follow ChefMind with `GH_BOT_WORKFLOW=chefmind-release.yml GH_BOT_TAG_PREFIX=ChefMind sh tools/gh-bot.sh release ChefMind/1.44.0` from ChefMind. Confirm the published release contains its MSI, setup EXE, Apple Silicon DMG, and SHA256SUMS.txt, and verify checksums. Then propose #251 done and update the release status/handoff.

Do not rerun `/tmp/codex-resume-app-releases.sh` or `/tmp/codex-finish-signed-releases.sh`: those batch scripts would run CalMind again and unnecessarily bump its now-tagged version. Never bypass signing/preflight, and never use `gh run rerun`. Existing production authorization persists; no new approval is needed to finish ChefMind.

## Completed backlog

Code commit `b8f9591` fixes CalMind #242 (folder-manager grip after reopening/outside release), #243 (drag stays under the stationary pointer through synced insertions/removals), #244 (last habit section can move above the first), and #249 (own-mode assertion flags/handles and account-deletion/token race). Shared drag components and fixtures are mirrored to ChefMind. It also completes TaskMind #250: shared-account lookup coverage documented and two no-op fixture writes removed.

Site `8a834fd` / 0.72.0 completes #246 (immediate bulk and workload edits with rollback), #247 (explicit notice when a move's provisional neighbour was refused), and #248 (stop queued/later writes to an affected task after an unknown response; other tasks continue). New server-assigned identities still await confirmation. The repository-privacy change for #221 was independently verified through GitHub's API.

**Nine completion proposals are queued:** #221, #242, #243, #244, #246, #247, #248, #249, #250. Do not duplicate them. #251 is not done until ChefMind is published. The latest scoped board audit found no additional actionable code tickets. Deferred tickets, date-held #224 (not before December 12), and existing #228 tracking remain untouched.

The larger board count came from separate approved review findings and completed work awaiting closure approval. Earlier shipped-ticket closure proposals have cleared from the open lists. The owner's current rule is **proposals only** for additions/completions; do not use direct `todo status`, even though older CLI/baseline text permits it. Use per-repository queries, never a global catalog or ticket listing.

## Verification and workspace

Site: all 490 cases pass. CalMind: core 1039, app 242, own API 87 and remaining server suites pass; deployment guards 15 and suite counts agree. Chromium covered 337 cases with three documented skips: 335 passed in the full run, then both focused rechecks passed (a corrected physical-coordinate drag fixture and a transient signup timeout). All 26 WebKit cases pass. ChefMind core/app checks pass, including app 204. TaskMind's shared-login case passes. Root preflight passes. Commit messages retain the detailed changes and validation.

Source work is merged and pushed to main in MindSuite and seancheren-site. All worktrees/branches created for implementation have been removed. Unrelated AgentSuite work was left untouched. No implementation WIP remains; this handoff is the pause record.

Useful local logs, if still present: `/tmp/codex-suite-backlog-preflight.log`, `/tmp/codex-taskmind-backlog-site-full.log`, `/tmp/codex-cal-backlog-browser-full.log`, `/tmp/codex-cal-backlog-browser-rerun.log`, `/tmp/codex-cal-backlog-webkit-full.log`, `/tmp/codex-backlog-calmind-release.log`, `/tmp/codex-backlog-chefmind-release.log`. GitHub run links above are the durable evidence. Release status run `20261114190525` was closed as an intentional owner-requested pause.
