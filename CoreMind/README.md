# CoreMind

The suite's release orchestration and docs. The code the Mind apps share lives beside it: `packages/mind-core`, `packages/mind-server`, and the byte-identical files listed in `tools/shared-files.json`, kept identical by `tools/check-shared.mjs`.

## Disclaimer

Feel free to clone the suite and copy the shared code into your own apps, etc. CoreMind ships nothing itself.

**This is a personal project to have some fun with claude code, which generated essentially all of the code, and the rest of this readme:**

## Quick start / Install

```sh
git clone git@github.com:chere005/MindSuite.git   # CoreMind/ sits beside the app directories
cd CoreMind && npm install
```

## Platforms

- None. A reference repo; the apps are what ship.

## Usage

```sh
npm run check     # every group in ../tools/shared-files.json, byte for byte against its origin
npm test          # the PHP storage, auth and mail suites, then the shared core's own tests
```

Change a shared file at its origin, then run the check; it tells you which copies drifted.

## Notes

- Consumers: [CalMind](https://github.com/chere005/CalMind), [ChefMind](https://github.com/chere005/ChefMind), [MyCalMind](https://github.com/chere005/MyCalMind), [AcctMind](https://github.com/chere005/AcctMind), and the private web apps PlanMind and TaskMind. Private targets go one per line in a gitignored `.private-targets` file.
- Apps import `@mind/core` from `packages/mind-core` and carry the listed copies; nothing imports CoreMind itself.
- Expects the apps beside it in the same checkout (`MIND_DIR` overrides where the release scripts look).

## Building

Nothing to build. `npm run dtp -- all` releases the whole suite in order, core first; `tdtp` runs every test first.

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md): where the shared code lives, the deploy graph, platforms.
- [AGENTS.md](AGENTS.md): rules for anyone, human or agent, changing the code.

## Contributing

Issues and pull requests are welcome. Read AGENTS.md first; `npm test` and `npm run check` must pass. BSD 3-Clause, see [LICENSE](LICENSE).
