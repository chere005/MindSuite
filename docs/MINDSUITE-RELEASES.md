# MindSuite releases

MindSuite has a version of its own, kept in `mindsuite.json` with the tag of every app at that
version. MindSuite 1.0.0 is the set of every app's first major release; from then on each app
release bumps the MindSuite minor and adds an entry here naming the app tag it matches. Each
version is tagged `MindSuite/<x.y.z>` in this repo. `tools/mindsuite-release.mjs` writes both
files; the app release lanes call it after their own tag is pushed.

MindSuiteDesktop (the Electron shell in `Desktop/`) is part of the suite from its first signed release. `mindsuite.json` carries it
at `MindSuiteDesktop/0.3.0`, the unsigned local build that was never tagged, so that the first signed release is recorded as an
advance: `node tools/mindsuite-release.mjs record MindSuiteDesktop MindSuiteDesktop/<x.y.0>` after its tag is on origin
(see docs/PUBLISH.md, MindSuite Desktop).

<!-- releases: newest first; written by tools/mindsuite-release.mjs -->

## MindSuite 1.9.0 (2026-11-25)

Matches NoteMind 1.2.0: `v1.2.0` (NoteMind repo).

Suite: CalMind 2.3.0 · MealMind 2.2.0 · PlanMind 1.1.0 · TaskMind 1.0.0 · AcctMind 1.1.0 · NoteMind 1.2.0 · ScrollMind 2.0.0 · ReadMind 1.0.0 · DisplayMind 1.0.0 · CoreMind 2.0.0.

## MindSuite 1.8.0 (2026-11-23)

Matches AcctMind 1.1.0: `AcctMind/1.1.0`.

Suite: CalMind 2.3.0 · MealMind 2.2.0 · PlanMind 1.1.0 · TaskMind 1.0.0 · AcctMind 1.1.0 · NoteMind 1.1.0 · ScrollMind 2.0.0 · ReadMind 1.0.0 · DisplayMind 1.0.0 · CoreMind 2.0.0.

## MindSuite 1.7.0 (2026-11-23)

Matches PlanMind 1.1.0: `PlanMind/1.1.0`.

Suite: CalMind 2.3.0 · MealMind 2.2.0 · PlanMind 1.1.0 · TaskMind 1.0.0 · AcctMind 1.0.0 · NoteMind 1.1.0 · ScrollMind 2.0.0 · ReadMind 1.0.0 · DisplayMind 1.0.0 · CoreMind 2.0.0.

## MindSuite 1.6.0 (2026-11-23)

Matches CalMind 2.3.0: `CalMind/2.3.0`.

Suite: CalMind 2.3.0 · MealMind 2.2.0 · PlanMind 1.0.0 · TaskMind 1.0.0 · AcctMind 1.0.0 · NoteMind 1.1.0 · ScrollMind 2.0.0 · ReadMind 1.0.0 · DisplayMind 1.0.0 · CoreMind 2.0.0.

## MindSuite 1.5.0 (2026-11-23)

Matches MealMind 2.2.0: `MealMind/2.2.0`.

Suite: CalMind 2.2.0 · MealMind 2.2.0 · PlanMind 1.0.0 · TaskMind 1.0.0 · AcctMind 1.0.0 · NoteMind 1.1.0 · ScrollMind 2.0.0 · ReadMind 1.0.0 · DisplayMind 1.0.0 · CoreMind 2.0.0.

## MindSuite 1.4.0 (2026-11-22)

Matches CalMind 2.2.0: `CalMind/2.2.0`.

Suite: CalMind 2.2.0 · MealMind 2.1.0 · PlanMind 1.0.0 · TaskMind 1.0.0 · AcctMind 1.0.0 · NoteMind 1.1.0 · ScrollMind 2.0.0 · ReadMind 1.0.0 · DisplayMind 1.0.0 · CoreMind 2.0.0.

## MindSuite 1.3.0 (2026-11-22)

Matches MealMind 2.1.0: `MealMind/2.1.0`.

Suite: CalMind 2.1.0 · MealMind 2.1.0 · PlanMind 1.0.0 · TaskMind 1.0.0 · AcctMind 1.0.0 · NoteMind 1.1.0 · ScrollMind 2.0.0 · ReadMind 1.0.0 · DisplayMind 1.0.0 · CoreMind 2.0.0.

## MindSuite 1.2.0 (2026-11-22)

Matches CalMind 2.1.0: `CalMind/2.1.0`.

Suite: CalMind 2.1.0 · MealMind 2.0.0 · PlanMind 1.0.0 · TaskMind 1.0.0 · AcctMind 1.0.0 · NoteMind 1.1.0 · ScrollMind 2.0.0 · ReadMind 1.0.0 · DisplayMind 1.0.0 · CoreMind 2.0.0.

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
