<!-- AgentSuite:reference:begin -->
Read and follow the shared baseline at `~/GIT/AgentSuite/AGENTS.md` before working here.
If the checkout is elsewhere, locate `AgentSuite/AGENTS.md` beside this repository's main checkout.
The shared `dtp` and `tdtp` definitions, authorization, and installed result apply in every project and worktree; local lane details do not redefine them.
@~/GIT/AgentSuite/AGENTS.md
<!-- AgentSuite:reference:end -->

# Working in PlanMind


Private shared daily planner for the owner and the partner. Read `README.md` for architecture and commands.

- Behavior lives in `packages/core` and `server/lib`, with disposable regression fixtures. Views contain plumbing.
- The parser uses `@mind/core`; other CoreMind files are copied byte for byte; `tools/shared-files.json` is the contract.
- Reuse seancheren-site's configured accounts and session. Every data request must independently authorize `alex` or `sam`. Never add signup, public sharing, or a client-side-only access gate.
- Both people share one encrypted store. The person filter changes the view only. Writes hold a lock and compare record revisions.
- Never cache private responses, credentials, or task data in browser storage or a service worker. Failed reads must never become empty data.
- Deploy touches only `$PUBLIC_BASE/PlanMind` (a symlink), `$PUBLIC_BASE/.planmind/` (public release dirs, denied to direct URLs) and `/home/protected/planmind[-test]/` (lib releases): Apache refuses symlinks into `/home/protected`, so public code lives in the docroot. Credentials, data and the parent site's source never ride a deploy.
- Default deploy is test. Production needs `--prod --yes-prod`. Follow AgentSuite's existing authorization rules for commits/releases.
- Native Tauri shells for iOS, macOS, and Windows open the same private HTTPS app. No native IPC capabilities or public app-store listing.
- The installed Mac app is always Developer ID signed, notarized and stapled (`tools/mac-sign-install.sh`, never ad hoc). Releases publish a notarized dmg and unsigned Windows installers from `planmind-release.yml`; installed copies auto-update from the `PlanMind-updates` feed, signed locally with the update key in the updater keychain (never in a repo or GitHub secrets).
