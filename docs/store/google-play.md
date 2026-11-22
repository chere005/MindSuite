# Google Play checklist: CalMind and MealMind

Preparation only; nothing is created or submitted. Package names are `com.seancheren.calmind` and `com.seancheren.mealmind`.

## Developer account

- One-time $25 registration fee plus identity verification.
- Personal accounts created after 13 Nov 2023 must run a **closed test with at least 12 testers opted in for 14 consecutive days** before applying for production access. Plan this lead time; start the closed test as soon as a bundle is uploadable.
- An organization account is exempt from that testing rule but needs organization verification.

## Build and signing

- Upload an **AAB** (`./gradlew bundleRelease`), not an APK.
- Enrol in **Play App Signing**: Google holds the app signing key; we keep an **upload key** (keystore outside the repo, path and passwords from the environment).
- `android.versionCode` rises with every upload (currently set by hand in `app.json`).
- **Target API level:** Play requires new apps and updates to target a recent API level, raised each year around 31 Aug (expect API 36 for the 2026 cycle). Confirm the current requirement in Play Console and check what the installed Expo SDK's prebuild targets before the first upload.
- No `android/` directory is committed. `npx expo prebuild --platform android` generates it. `tools/store/android-bundle.sh <App>` prints the plan; its real branch is not built yet.

## Listing and policy

- Privacy policy URL (from `privacy-policy.md` once final), category (Productivity / Food & Drink), content rating questionnaire, target audience (not for children).
- **Data safety** form, matching the policy:
  - Without an account: no data leaves the device.
  - With an account: collected and linked to the user: email address, user ID (username), app content (records), app activity (action-name log), IP address for security; all encrypted in transit and records encrypted at rest; not shared with third parties; no advertising or analytics; users can request deletion.
- **Account deletion:** Play requires deletion inside the app and also a **web URL** where a user can request deletion without installing the app. Use the web account page and enter that URL in the Data safety form.
- Permissions: the image picker config blocks `CAMERA` and `RECORD_AUDIO` (`cameraPermission` and `microphonePermission` are `false`). Check the generated manifest after prebuild.

## Gaps in this codebase

- **Photo OCR has no Android path.** `src/components/ocr.ts` in both apps uses iOS Vision through the native-ocr module and reports unsupported elsewhere. Android would need an ML Kit text-recognition module, or the feature stays hidden on Android (`ocrSupported()` already reports honestly).
- No committed `android/` project, no signing config, and no tested release build for either app on a recent target API.
- Android adaptive/monochrome icons exist in `app.json`; store graphics (512x512 icon, 1024x500 feature graphic, phone screenshots) still need to be made.

## Android developer verification

Google is requiring apps on certified Android devices to come from verified developers: enforced in some countries from 30 Sep 2026 and globally in 2027. Apps from Play are covered through the Play account. For sideloaded or limited distribution, a free limited-distribution account covers up to 20 devices. Re-check the current dates before relying on them.
