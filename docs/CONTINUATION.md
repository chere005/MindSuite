# MindSuite continuation

PlanMind 0.27.0 is released with the phone Day menu, per-person Both colors and the CalMind all-day strip. Keep shared login disabled while the token revocation and proxy trust work remains unfinished.

This repository began as a fresh start from the monorepo consolidation. The CalMind title-input fix (`wip/calmind-167-title-field`) and the shared-login library (`feat/shared-login-library-finish`) continue as branches on top of the first commit; shared login stays disabled.

The SMTP transport and CalMind mail callers are deployed with sending enabled on the site and CalMind production and test instances; mail remains off by default in sample configuration.

macOS release lanes target Apple Silicon. Use the relevant app's release lane and the root preflight, and check for running apps before any installation step.

CalMind, ChefMind and AcctMind release workflows require signing, notarization and stapled-ticket verification. Signed preflights passed; no new app release was made for these workflow changes.

Shared code is consolidated: TypeScript module bodies and spec vectors live in `packages/mind-core` (`@mind/core`) and each app reaches them through one-line stubs in its `packages/core/src`; PHP origins live in `packages/mind-server`; every other byte-identical app file is a group in `tools/shared-files.json`, compared by `npm run check:shared`. CoreMind's canon tree and per-app manifests are deleted; `CoreMind/bin/check-drift.sh` stays as a shim over `check:shared` for the site's board sync. ChefMind's `app/src/api.ts` SYNC_SPACE seam stays an app-owned fork until the owner decides whether a config-file constant satisfies ChefMind's "constant, never configurable" rule.

- MyCalMind (paused, not in this clone, unchecked by `check:shared`) resumes by hand from commit `cad2aaa0ab0a`, the last one that contains `CoreMind/canon` and `CoreMind/consumers/MyCalMind.tsv`: `git show cad2aaa0ab0a:CoreMind/consumers/MyCalMind.tsv` lists what it carries, and that commit's `docs/CONTINUATION.md` has the fuller list of what it owes.
- Copy down from the current homes: module bodies and spec vectors from `packages/mind-core` (the old canon `packages/core/src/<m>.ts` facades are one-line re-exports of them), PHP from `packages/mind-server`, and the app, tools and desktop files from their CalMind origins (`tools/shared-files.json`); a canon file no active app copies is read at that commit with `git show cad2aaa0ab0a:CoreMind/canon/<path>`.
- It owes, at that commit: the exact `tools/heavy-lock.sh`; `packages/mind-core/test/gridfuzz.test.ts` and `test/timezone.test.ts`; the `TZ` pin of `packages/mind-core/vitest.config.ts` (its forked `packages/core/package.json` still runs `TZ=America/Chicago vitest`); `types`, `normalize` and the `appconfig.ts` seam as CalMind carries them; and `app/src/brand.ts`, imported by `components/ocr.ts`, which reads `expo.name` from `app/app.json`, so its OCR_UNSUPPORTED message will name that app instead of CalMind (a choice to confirm on resume).
