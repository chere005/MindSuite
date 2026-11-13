# CoreMind continuation

- Shared login #163 and the strict account-wide lockout #213 are live on production and test for every web app; the shared-auth suite and the site's production import, dry restore, gates and session-revocation checks passed. The site records activation in 661f03c; canonical PHP remains in packages/mind-server.
- The canonical WebAuthn verifier matches CalMind `98c5630` (`71345a9af90900e37298d3293734a1bcd2efe307`). The CalMind drift gate, auth suite and bounded CBOR fixtures passed. The auth suite also verifies that generic copy-down leaves the check-only site untouched.
- Finalize the CoreMind branch after the CalMind security release reaches main and the site carries the same verifier bytes. Run `npm run check -- CalMind seancheren-site` before merging.
- The named locked-device audit (#172) is in `993c87a`. PlanMind's copy reached main in `abf78dc`, and TaskMind's `35b5a1d` is in review. Keep the umbrella ticket open through the remaining active app copies.
- Scroll and Notes now copy CalMind `5d30d59` exactly; 173 CalMind files match. ChefMind’s Scroll copy is explicitly owed for the monorepo handoff; no paused consumer was touched. Canon tests (782), auth/storage checks, typecheck and five active consumer checks passed.
