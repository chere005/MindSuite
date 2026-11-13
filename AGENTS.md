# Working on MindSuite

@../AgentSuite/AGENTS.md

- Follow the project directory's AGENTS.md. Install and run each app's commands there; the apps have separate dependencies and lockfiles.
- macOS targets Apple Silicon only; Windows and Linux architecture support is unchanged.
- Use one MindSuite worktree and scope commits to reviewed paths; releases use `AppName/x.y.0` tags and the root workflows.
- Run `npm run preflight` at the root and the affected app's checks before pushing; initial migration does not deploy any app.
- Keep deploy configs, local data, device credentials and parked Git work outside tracked paths.
