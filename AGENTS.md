<!-- AgentSuite:reference:begin -->
Read and follow the shared baseline at `~/GIT/AgentSuite/AGENTS.md` before working here.
If the checkout is elsewhere, locate `AgentSuite/AGENTS.md` beside this repository's main checkout.
The shared `dtp` and `tdtp` definitions, authorization, and installed result apply in every project and worktree; local lane details do not redefine them.
@~/GIT/AgentSuite/AGENTS.md
<!-- AgentSuite:reference:end -->

# Working on MindSuite


- Follow the project directory's AGENTS.md. Install and run each app's commands there; the apps have separate dependencies and lockfiles.
- macOS targets Apple Silicon only; Windows and Linux architecture support is unchanged.
- Use one MindSuite worktree and scope commits to reviewed paths; releases use `AppName/x.y.0` tags and the root workflows.
- Run `npm run preflight` at the root and the affected app's checks before pushing; initial migration does not deploy any app.
- Keep deploy configs, local data, device credentials and parked Git work outside tracked paths.
- Public release notes use `App/docs/releases/<version>.md` or a plain app/version fallback; never copy commit/tag bodies or handoffs.
