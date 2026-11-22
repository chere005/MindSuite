# App Store Connect checklist: CalMind and MealMind

Nothing here is submitted; this is the preparation list. Bundle ids, slugs and schemes stay as they are.

## Listing

| Field | CalMind | MealMind |
| --- | --- | --- |
| Name | CalMind (check availability) | MealMind: **conflict**, an unrelated app already lists as "MealMind - AI Recipe Generator". Check and reserve the exact name in App Store Connect before anything else. |
| Alternatives | | `MealMind Pantry`, `Mind Meals`, `MealMind Recipes & Shopping` (each must be checked; names are unique across the store) |
| Subtitle (30 chars) | Calendar, tasks, notes, habits | Recipes, shopping and pantry |
| Primary category | Productivity | Food & Drink |
| Privacy policy URL | required, from `privacy-policy.md` once final | same |
| Support URL | required (`<support contact>` page) | same |

Changing the display name does not require changing the bundle id.

## Age rating

No objectionable content, no user-generated content shown to strangers, no web browsing, no gambling. Expected 4+. Answer the questionnaire honestly; sharing between invited accounts is not public UGC.

## Privacy nutrition label

(a) **No account** (data only on device): "Data Not Collected".

(b) **With account** (the apps offer both, so the label must describe the account case):

- Contact Info, Email Address: collected, linked to the user, not used for tracking; purpose App Functionality.
- User Content (records: events, notes, recipes and so on): collected, linked to the user, not tracking; App Functionality.
- Identifiers, User ID (username): collected, linked, not tracking; App Functionality.
- Other Data / Usage Data (action-name log): collected, linked, not tracking; App Functionality.
- IP address used only for rate limiting and abuse prevention: if kept beyond transient processing, declare under Identifiers/Other Data, purpose App Functionality (security).
- Tracking: none. Third-party SDKs: none. Confirm against the final dependency list before submitting.

## Screenshots

- iPhone 6.9" (required).
- iPad 13" is required because `ios.supportsTablet` is `true` in both `app.json` files. Either supply iPad screenshots (and test the iPad layout) or set `supportsTablet` to `false` and regenerate prebuild.

## Review notes

- Say the apps work fully without an account.
- Demo account for the account features: `<demo username>` / `<demo password>` (create a dedicated account on the production server; never a real user).
- Explain the photo picker is used only to read recipe-card text on device.
- Sign-in: the app signs in through the system browser on the developer's own server; no third-party login is offered.

## Guidelines touched

- **2.1 App completeness:** working demo account, no placeholder content, server reachable during review.
- **4.8 Login services:** only needed when a third-party/social login is offered. Our own account system is exempt; adding Google or similar login would require an equivalent privacy-preserving option such as Sign in with Apple.
- **5.1.1 Privacy:** privacy policy link in the app and in App Store Connect; purpose strings specific (done in `app.json`); **account deletion** must be possible inside the app when accounts can be created in it (5.1.1(v)); do not force login for features that do not need an account (5.1.1(iv)).
- **Export compliance:** `ITSAppUsesNonExemptEncryption=false` is set (HTTPS only).

## Generated `ios/` projects

The lanes reuse the existing generated `ios/` directories rather than running prebuild every time. Changes to `app.json` that feed Info.plist (permission strings, `usesNonExemptEncryption`, plugins) take effect only after a regenerated prebuild (`npx expo prebuild --platform ios`, then check the built Info.plist). Verify the built archive's Info.plist has the specific photo string and no camera or microphone keys.

## Per upload

Raise `ios.buildNumber` by hand (it must exceed the last upload for the version). `tools/store/ios-upload.sh <App>` prints the plan; its real branch is not built yet.
