# MindSuite for macOS

MindSuite opens CalMind and ScrollMind inside one workspace window. Select the split button and choose apps from the icon row above each pane. Drag the divider to resize the panes, or double-click it to return to an even split. Arrow keys resize the focused divider and Enter resets it. On narrower windows the panes stack. Option+1 through Option+7 select the app tabs.

CalMind runs its bundled local Expo export. It keeps a local snapshot in MindSuite and can sign in to sync through the same CalMind backend. Its Chromium storage and the standalone CalMind app’s Tauri storage are separate. ScrollMind uses the installed ScrollMind build’s renderer, document store, and Mac pen helper. Its editing pane opens the existing `~/Documents/ScrollMind` workspace. The two apps share ScrollMind’s single-instance lock, so open that workspace in either MindSuite or standalone ScrollMind. Other tabs load the suite’s live web apps.

## Build on Apple Silicon

Use Node 22.12 or newer, a fresh CalMind web export, and a macOS ScrollMind installation.

```sh
npm --prefix CalMind run export:web
npm --prefix Desktop ci
npm --prefix Desktop run check
npm --prefix Desktop run build:mac
```

The ad hoc-signed app is at `Desktop/dist/mac-arm64/MindSuite.app`. The staging script takes the CalMind export from `CalMind/apps/app/dist` and ScrollMind from `/Applications/ScrollMind.app`. Set `MINDSUITE_CALMIND_DIST` or `MINDSUITE_SCROLLMIND_APP` to use another checked build. The app icon is generated from the site's `mindsuite_logo_svg()`.

`npm run check` exercises the layout state and local asset routing. The hidden macOS integration smoke uses disposable app and ScrollMind data. Run `npm run test:mac` after staging both apps.
