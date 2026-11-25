# MindSuite for macOS

MindSuite opens CalMind, ScrollMind and NoteMind inside one workspace window. In split view, the labelled tabs select the left pane and the top-bar icons select the right. App picker options let you choose apps, add spacers, and reorder both pickers. Drag the divider to resize the panes and move the right app picker with it. Double-click the divider to return to an even split. Arrow keys resize the focused divider and Enter resets it. On narrower windows the panes stack. Option+1 through Option+7 select the app tabs.

CalMind runs its bundled local Expo export. It keeps a local snapshot in MindSuite and can sign in to sync through the same CalMind backend. Its Chromium storage and the standalone CalMind app’s Tauri storage are separate. ScrollMind uses the installed ScrollMind build’s renderer, document store, and Mac pen helper. Its editing pane opens the existing `~/Documents/ScrollMind` workspace. The two apps share ScrollMind’s single-instance lock, so open that workspace in either MindSuite or standalone ScrollMind. NoteMind runs the native 1.2.0 editor, drawing tools, and file services with its existing library and preferences. Its standalone editor and MindSuite share the same workspace lock. The other tabs load the suite’s live web apps.

## Build on Apple Silicon

Use Node 22.12 or newer, a fresh CalMind web export, and macOS installations of the pinned ScrollMind and NoteMind builds (`runtime-pins.json`; both must be signed by a Developer ID).

```sh
npm --prefix CalMind run export:web
npm --prefix Desktop ci
npm --prefix Desktop run check
npm --prefix Desktop run build:mac
```

`build:mac` makes the local, ad hoc-signed app at `Desktop/dist/mac-arm64/MindSuite.app` for development. The staging script takes the CalMind export from `CalMind/apps/app/dist`, ScrollMind from `/Applications/ScrollMind.app`, and NoteMind from `/Applications/NoteMind.app`. Set `MINDSUITE_CALMIND_DIST`, `MINDSUITE_SCROLLMIND_APP` or `MINDSUITE_NOTEMIND_APP` to use another checked build. The app icon is generated from the site's `mindsuite_logo_svg()`.

`npm run check` exercises the layout state, local asset routing, the updater and its guard, the feed and the publisher. The hidden macOS integration smoke uses disposable app, ScrollMind and NoteMind data. Run `npm run test:mac` after staging the local runtimes (or `node test/smoke.cjs <path to MindSuite.app>/Contents/MacOS/MindSuite` against a built app).

## Signed release (local only)

`npm run release:mac` signs with the Developer ID, the hardened runtime and `entitlements.mac.plist`, notarizes and staples the app, then builds the zip, `latest-mac.yml`, the notarized dmg, `SHA256SUMS` and `release.json` in `dist/release`; `--scratch` builds the same into `dist/scratch` and cannot be published. `npm run publish:mac` publishes a release build. The app updates itself on macOS from one fixed feed. This lane runs only on a Mac that has the hosted apps installed; see `docs/PUBLISH.md`, "MindSuite Desktop", for the pins, the feed and the exceptions (no Windows or Linux build).
