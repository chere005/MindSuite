# Working in PlanMind

@../../AgentSuite/AGENTS.md

Private shared daily planner for the owner and the partner. Read `README.md` for architecture and commands.

- Behavior lives in `packages/core` and `server/lib`, with disposable regression fixtures. Views contain plumbing.
- The parser uses `@mind/core`; other CoreMind files are copied byte for byte; `tools/shared-files.json` is the contract.
- Reuse seancheren-site's configured accounts and session. Every data request must independently authorize `alex` or `sam`. Never add signup, public sharing, or a client-side-only access gate.
- Both people share one encrypted store. The person filter changes the view only. Writes hold a lock and compare record revisions.
- Never cache private responses, credentials, or task data in browser storage or a service worker. Failed reads must never become empty data.
- Deploy touches only `$PUBLIC_BASE/PlanMind` (a symlink), `$PUBLIC_BASE/.planmind/` (public release dirs, denied to direct URLs) and `/home/protected/planmind[-test]/` (lib releases): Apache refuses symlinks into `/home/protected`, so public code lives in the docroot. Credentials, data and the parent site's source never ride a deploy.
- Default deploy is test. Production needs `--prod --yes-prod`. Follow AgentSuite's existing authorization rules for commits/releases.
- Native Tauri shells for iOS, macOS, and Windows open the same private HTTPS app. No native IPC capabilities or public app-store listing.
