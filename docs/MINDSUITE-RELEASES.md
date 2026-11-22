# MindSuite releases

MindSuite has a version of its own, kept in `mindsuite.json` with the tag of every app at that
version. MindSuite 1.0.0 is the set of every app's first major release; from then on each app
release bumps the MindSuite minor and adds an entry here naming the app tag it matches. Each
version is tagged `MindSuite/<x.y.z>` in this repo. `tools/mindsuite-release.mjs` writes both
files; the app release lanes call it after their own tag is pushed.

<!-- releases: newest first; written by tools/mindsuite-release.mjs -->

## MindSuite 1.1.0 (2026-11-22)

Matches NoteMind 1.1.0: `v1.1.0` (NoteMind repo).

Suite: CalMind 2.0.0 · MealMind 2.0.0 · PlanMind 1.0.0 · TaskMind 1.0.0 · AcctMind 1.0.0 · NoteMind 1.1.0 · ScrollMind 2.0.0 · ReadMind 1.0.0 · DisplayMind 1.0.0 · CoreMind 2.0.0.

## MindSuite 1.0.0 (2026-11-22)

The first numbered MindSuite release: every app at its first release after a major-version bump. The MindSuite web shell (/MindSuite/) was the seancheren-site repository at tag 0.88.0.

| App | Version | Tag |
|---|---|---|
| CalMind | 2.0.0 | `CalMind/2.0.0` |
| MealMind | 2.0.0 | `MealMind/2.0.0` |
| PlanMind | 1.0.0 | `PlanMind/1.0.0` |
| TaskMind | 1.0.0 | `TaskMind/1.0.0` |
| AcctMind | 1.0.0 | `AcctMind/1.0.0` |
| NoteMind | 1.0.0 | `v1.0.0` (NoteMind repo) |
| ScrollMind | 2.0.0 | `v2.0.0` (ScrollMind repo) |
| ReadMind | 1.0.0 | `ReadMind/1.0.0` |
| DisplayMind | 1.0.0 | `v1.0.0` (DisplayMind repo) |
| CoreMind | 2.0.0 | `CoreMind/2.0.0` |
