# MindSuite

Private source for CalMind, ChefMind, PlanMind, TaskMind, ReadMind, AcctMind and CoreMind. Each project keeps its own package manager and toolchain. All seven use one Git checkout.

Run package commands inside the project, for example `npm --prefix CalMind run test:core` or `npm --prefix PlanMind run typecheck`. ReadMind uses `php ReadMind/tools/test.php`. The individual project AGENTS.md and README describe their gates.

From the suite root:

- `npm run preflight` checks the checkout, scripts, release planning and quiet CI. It does not deploy or use production data.
- `npm run check:shared` compares every byte-identical file listed in `tools/shared-files.json` with its origin (`check:drift` is an alias); `npm run check:mind-core` runs the shared TypeScript package's typecheck and tests.
- `npm run dtp -- all --plan` previews the release order. With release authorization, `npm run dtp -- --only CalMind` ships only CalMind; `tdtp` runs its full lane. Use `--platforms` to include device and desktop builds.
- CalMind, ChefMind and AcctMind have their own desktop release workflow (`calmind-release.yml`, `chefmind-release.yml`, `acctmind-release.yml`, started by an `AppName/x.y.0` tag). To release or retry an existing tag, dispatch it from the suite root with the full namespaced tag, for example `gh workflow run calmind-release.yml --ref CalMind/1.58.0 -f tag=CalMind/1.58.0`; never `gh run rerun`. From the project's directory, `sh tools/preflight.sh <version>` builds that commit in CI without publishing. PlanMind and TaskMind have separate manually dispatched native package workflows.

New tags are `AppName/x.y.0`; the next release of an app is the next minor above its latest tag. This repository is a fresh start: history before the monorepo consolidation lives in the apps' original repositories, and the first tags here (`AppName/x.y.0`) mark the versions the apps had when it began. See [docs/CONTINUATION.md](docs/CONTINUATION.md) for the state of work in progress.

AgentSuite supplies the pre-push hook. With a sibling AgentSuite checkout, install it with `git config core.hooksPath "$(cd ../AgentSuite && pwd)/githooks"`. For a different layout, set `AGENTSUITE_DIR` before preflight.
