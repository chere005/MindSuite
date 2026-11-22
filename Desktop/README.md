# MindSuite for macOS

MindSuite opens CalMind, ScrollMind and NoteMind inside one workspace window. In split view, the labelled tabs select the left pane and the top-bar icons select the right. App picker options let you choose apps, add spacers, and reorder both pickers. Drag the divider to resize the panes and move the right app picker with it. Double-click the divider to return to an even split. Arrow keys resize the focused divider and Enter resets it. On narrower windows the panes stack. Option+1 through Option+7 select the app tabs.

CalMind runs its bundled local Expo export. It keeps a local snapshot in MindSuite and can sign in to sync through the same CalMind backend. Its Chromium storage and the standalone CalMind app’s Tauri storage are separate. ScrollMind uses the installed ScrollMind build’s renderer, document store, and Mac pen helper. Its editing pane opens the existing `~/Documents/ScrollMind` workspace. The two apps share ScrollMind’s single-instance lock, so open that workspace in either MindSuite or standalone ScrollMind. NoteMind runs the native 1.2.0 editor, drawing tools, and file services with its existing library and preferences. Its standalone editor and MindSuite share the same workspace lock. The other tabs load the suite’s live web apps.

## Build on Apple Silicon

Use Node 22.12 or newer, a fresh CalMind web export, and macOS installations of ScrollMind and signed NoteMind 1.2.0.

```sh
npm --prefix CalMind run export:web
npm --prefix Desktop ci
npm --prefix Desktop run check
npm --prefix Desktop run build:mac
```

The ad hoc-signed app is at `Desktop/dist/mac-arm64/MindSuite.app`. The staging script takes the CalMind export from `CalMind/apps/app/dist`, ScrollMind from `/Applications/ScrollMind.app`, and NoteMind from `/Applications/NoteMind.app`. Set `MINDSUITE_CALMIND_DIST`, `MINDSUITE_SCROLLMIND_APP` or `MINDSUITE_NOTEMIND_APP` to use another checked build. The app icon is generated from the site's `mindsuite_logo_svg()`.

`npm run check` exercises the layout state and local asset routing. The hidden macOS integration smoke uses disposable app, ScrollMind and NoteMind data. Run `npm run test:mac` after staging the local runtimes.
