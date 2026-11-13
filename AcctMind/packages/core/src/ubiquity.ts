/**
 * The one file every surface shares, and where it is.
 *
 * The owner, 2026-09-21, choosing this over CloudKit: "store file in an iCloud
 * Drive container both read - especially now that i have the paid developer
 * account." And the scope it is the pilot for: "the other apps that
 * currently sync through seancheren.com ... will all need to migrate to
 * this new sync mechanism."
 *
 * WHY A FILE. The Tauri Mac app is the WEB BUNDLE in a window and carries
 * none of this app's native modules, so `NSUbiquitousKeyValueStore` and the
 * Bonjour link are both out of its reach for ever. A ubiquity container is
 * an ordinary directory: the desktop reads it with `fs`, no Apple framework,
 * no entitlement, no signature.
 *
 * AND IT HAD TO BE. The key-value store caps at one megabyte. The owner's ledger
 * measured 1,260,619 bytes on 2026-09-21 — 1,948 live transactions back to
 * August 2024 — so the path shipped that morning could not have carried his
 * data on the day it shipped, and pruning does not help: every one of the
 * 1,958 tombstones is younger than the 90-day TTL. A file has no such cap.
 *
 * NOTHING HERE TOUCHES A DISK. Core is platform-neutral (`"types": []`, so
 * it cannot even see `fs`), and the whole of this file is the arithmetic of
 * a PATH plus the name of a file. The reading and the writing belong to
 * whichever surface is asking, and what to do with what comes back is
 * `planSync`'s — which already takes the remote as a string and therefore
 * needed no changes at all to gain a third transport.
 */

/**
 * The container id, as it appears in the entitlements.
 *
 * `iCloud.` + the bundle identifier is Apple's convention; it is written out
 * here rather than derived so that one grep finds every place the container
 * is named — this file, `app.config.js`, and the Swift module.
 */
export const UBIQUITY_CONTAINER = 'iCloud.com.seancheren.acctmind';

/**
 * The ledger's file name inside the container's Documents folder.
 *
 * `.json`, and visible: `NSUbiquitousContainerIsDocumentScopePublic` puts
 * the folder in iCloud Drive where the owner can open it, so the file he finds
 * there should be one anything can read. A dotfile or an opaque extension
 * would be a copy of his money he needs this app to get at.
 */
export const STORE_FILE = 'store.json';

/**
 * The container id as the FILESYSTEM spells it: every `.` becomes a `~`.
 *
 * Apple's own rule, and the reason this is a function rather than a second
 * constant: the entitlement and the path are the same fact, and writing
 * `iCloud~com~seancheren~acctmind` out by hand somewhere is how they come
 * apart the day the bundle id changes.
 */
export function ubiquityFolder(container: string = UBIQUITY_CONTAINER): string {
  return container.replace(/\./g, '~');
}

/**
 * Where the shared file is on a Mac, given the home directory.
 *
 * `~/Library/Mobile Documents/<folder>/Documents/store.json`. The home is an
 * argument because core may not ask the platform anything — the caller knows
 * its own home and this file knows the shape.
 *
 * The trailing slash on `home` is tolerated because a caller that has one is
 * far likelier than a caller that noticed.
 */
export function ubiquityPath(home: string, container: string = UBIQUITY_CONTAINER): string {
  const base = home.endsWith('/') ? home.slice(0, -1) : home;
  return `${base}/Library/Mobile Documents/${ubiquityFolder(container)}/Documents/${STORE_FILE}`;
}

/**
 * THE CLOUDKIT COPY, for the browser.
 *
 * The owner, 2026-11-09: "lets go with CloudKit" — the web app should read his
 * iCloud ledger. A browser cannot reach iCloud Drive; it CAN reach CloudKit
 * through Apple's CloudKit JS. So the phone, which already holds the file,
 * also mirrors it into one record in the container's PRIVATE database, and
 * the browser reads that record. The file stays the one the devices sync
 * through; the record is a read-only copy of it and nothing ever merges
 * from it on a phone or a Mac.
 *
 * The names are written out here, and again in the Swift module, so a grep
 * for either finds both — the same arrangement as `UBIQUITY_CONTAINER`.
 */
export const CK_RECORD_TYPE = 'Ledger';
/** One record, always this name: the browser fetches it by id, no query. */
export const CK_RECORD_NAME = 'store';
/**
 * The ledger, raw-DEFLATE compressed, as a Bytes field.
 *
 * Compressed because a record caps at ONE MEGABYTE of non-asset fields and
 * the ledger was 1.26 MB in September; JSON this repetitive shrinks about
 * tenfold. Bytes rather than an asset because an asset arrives as a signed
 * URL on Apple's content host, which is one more origin, one more expiry and
 * one more CORS answer between the browser and the data.
 */
export const CK_FIELD = 'ledger';

/**
 * The CloudKit environment the phone writes to.
 *
 * Every phone build is development-signed (`tools/build-platforms.sh`
 * installs with Xcode's development profile), and a development-signed app
 * talks to the DEVELOPMENT environment. A browser pointed at production
 * would find an empty database and say so, correctly and uselessly.
 */
export const CK_ENVIRONMENT = 'development';
