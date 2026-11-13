//  ONE FILE IN iCLOUD DRIVE, which every surface can reach.
//
//  The owner, 2026-09-21, picking this over CloudKit: "store file in an iCloud
//  Drive container both read - especially now that i have the paid developer
//  account." It is the pilot for moving the whole suite's sync off
//  seancheren.com.
//
//  WHY A FILE AND NOT THE KEY-VALUE STORE NEXT DOOR. Two reasons, and the
//  second one is fatal on its own:
//
//   · The Tauri Mac app is the WEB BUNDLE in a window. It has none of this
//     app's native modules and never will, so NSUbiquitousKeyValueStore and
//     the Bonjour link are both permanently out of its reach. A ubiquity
//     container is an ordinary directory — the desktop reads it with `fs`.
//   · The key-value store caps at ONE MEGABYTE. The owner's ledger measured
//     1,260,619 bytes on the day this was written. The key-value path could
//     not have carried his data on the morning it shipped.
//
//  WHAT THIS FILE DOES NOT DO is merge. It moves an opaque string and says
//  when it changed; `planSync` in packages/core decides everything else, and
//  it already took the remote as a string, so gaining a third transport
//  changed nothing about it.
//
//  THREE THINGS iCLOUD DOES THAT A LOCAL FILE DOES NOT, all handled here:
//
//   · `url(forUbiquityContainerIdentifier:)` BLOCKS — Apple says explicitly
//     not to call it on the main thread. It is resolved once, off-main, and
//     cached.
//   · A file in the container may be a PLACEHOLDER that has not been
//     downloaded. Reading it raw returns nothing useful; the coordinated
//     read below is what triggers the download and waits for it.
//   · Two devices may write at once. Every read and write goes through
//     NSFileCoordinator, which is the only thing that makes that safe.
//
//  AND A COPY FOR THE BROWSER. The owner, 2026-11-09: "lets go with CloudKit".
//  A web page cannot reach iCloud Drive, but CloudKit JS can read the
//  container's private database. So every time this module reads or writes
//  the file, it mirrors what it saw into ONE CloudKit record, which the web
//  app reads after an Apple ID sign-in. Read-only: nothing here ever pulls
//  the record back, so the file stays the only thing devices sync through.
//  The names are core's `CK_*` constants (packages/core/src/ubiquity.ts),
//  and core's ubiquity test greps this file for them.

import CloudKit
import CryptoKit
import ExpoModulesCore

public class ICloudFileModule: Module {
  /// The container, spelled as the entitlements spell it. Core's
  /// `UBIQUITY_CONTAINER` is the same string; a grep for either finds both.
  private static let container = "iCloud.com.seancheren.acctmind"
  /// The file, inside Documents so iCloud Drive shows it to a person.
  private static let fileName = "store.json"

  private var query: NSMetadataQuery?
  private var observers: [NSObjectProtocol] = []

  /// The last mirror's outcome, in words, for the cog's sync note.
  private static var mirrorNote = "CloudKit copy: not written this launch"
  /// The hash of what the record holds, so an unchanged ledger is not
  /// re-sent on every read. Kept across launches; a stale value only means
  /// one save is skipped until the ledger next changes.
  private static let mirroredKey = "acctmind.cloudkit.mirrored"
  /// One mirror in flight at a time; a newer ledger waits here and goes
  /// when the current save answers, so the record ends on the latest.
  private static let mirrorQueue = DispatchQueue(label: "acctmind.cloudkit.mirror")
  private static var mirrorBusy = false
  private static var mirrorNext: String?

  /// Copy the ledger into the CloudKit record, unless it is already there.
  ///
  /// Fire and forget: the file is what the devices sync through and has
  /// already been read or written by the time this is called. A failed copy
  /// costs only the browser's freshness, and the next read retries it.
  private static func mirror(_ text: String) {
    mirrorQueue.async {
      if mirrorBusy { mirrorNext = text; return }
      mirrorBusy = true
      send(text)
    }
  }

  /// Runs on `mirrorQueue` with `mirrorBusy` set.
  private static func send(_ text: String) {
    let raw = Data(text.utf8)
    let hash = SHA256.hash(data: raw).map { String(format: "%02x", $0) }.joined()
    if UserDefaults.standard.string(forKey: mirroredKey) == hash {
      mirrorNote = "CloudKit copy: up to date"
      return finish()
    }
    // Raw DEFLATE (Apple's `.zlib` is RFC 1951 without a header), which is
    // what the browser's DecompressionStream("deflate-raw") reads.
    guard let packed = try? (raw as NSData).compressed(using: .zlib) as Data else {
      mirrorNote = "CloudKit copy: could not compress the ledger"
      return finish()
    }
    // A record holds at most a megabyte outside assets. Ten times the
    // September ledger fits; saying so beats a save CloudKit refuses.
    guard packed.count < 900_000 else {
      mirrorNote = "CloudKit copy: ledger too big to copy (\(packed.count) bytes packed)"
      return finish()
    }
    let record = CKRecord(recordType: "Ledger", recordID: CKRecord.ID(recordName: "store"))
    record["ledger"] = packed as CKRecordValue
    record["bytes"] = raw.count as CKRecordValue
    record["written"] = Date() as CKRecordValue
    let op = CKModifyRecordsOperation(recordsToSave: [record], recordIDsToDelete: nil)
    // Overwrite without fetching first: this record has one writer per
    // ledger and its whole content is replaced every time.
    op.savePolicy = .allKeys
    op.qualityOfService = .utility
    op.modifyRecordsResultBlock = { result in
      mirrorQueue.async {
        switch result {
        case .success:
          UserDefaults.standard.set(hash, forKey: mirroredKey)
          mirrorNote = "CloudKit copy: saved \(raw.count / 1024) KB for the web app"
        case .failure(let error):
          mirrorNote = "CloudKit copy failed: \(error.localizedDescription)"
        }
        finish()
      }
    }
    CKContainer(identifier: "iCloud.com.seancheren.acctmind").privateCloudDatabase.add(op)
  }

  /// Runs on `mirrorQueue`. Sends whatever arrived while the last one was out.
  private static func finish() {
    if let next = mirrorNext {
      mirrorNext = nil
      send(next)
    } else {
      mirrorBusy = false
    }
  }

  /// The container's Documents URL, resolved once off the main thread.
  ///
  /// nil means iCloud is unavailable — signed out, or iCloud Drive off for
  /// this app. That is a normal state and not an error: the app is
  /// local-first and simply has one fewer transport.
  private static func documents() -> URL? {
    guard let root = FileManager.default.url(forUbiquityContainerIdentifier: container)
    else { return nil }
    let docs = root.appendingPathComponent("Documents", isDirectory: true)
    // The container exists before Documents does. Making it is idempotent
    // and is what lets the very first write succeed.
    try? FileManager.default.createDirectory(at: docs, withIntermediateDirectories: true)
    return docs
  }

  private static func fileURL() -> URL? {
    documents()?.appendingPathComponent(fileName, isDirectory: false)
  }

  public func definition() -> ModuleDefinition {
    Name("ICloudFile")

    Events("onRemoteChange")

    /// Is the container reachable right now?
    ///
    /// ASYNC, unlike the key-value module's `isAvailable`, and that is the
    /// blocking call above rather than a style choice: asking this question
    /// synchronously on the main thread is what Apple's documentation tells
    /// you not to do, and it can hang a launch.
    AsyncFunction("isAvailable") { () -> Bool in
      Self.documents() != nil
    }

    /// The shared file's contents, or nil when there is not one yet.
    ///
    /// nil is "nothing up there", NOT an empty ledger — `planSync`'s first
    /// rule depends on being able to tell those apart, and merging an
    /// absent remote into a present local one is the mistake it exists to
    /// prevent.
    AsyncFunction("get") { () -> String? in
      guard let url = Self.fileURL() else { return nil }
      // A placeholder has no bytes until this is asked for. Harmless when
      // the file is already local, and the difference between a working
      // first sync and an empty one when it is not.
      try? FileManager.default.startDownloadingUbiquitousItem(at: url)

      var text: String?
      var failure: NSError?
      NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &failure) { ready in
        text = try? String(contentsOf: ready, encoding: .utf8)
      }
      // What another device wrote reaches the browser too, the moment this
      // phone sees it — not only what this phone wrote itself.
      if let text { Self.mirror(text) }
      return text
    }

    /// Write the ledger out, coordinated.
    ///
    /// `.forReplacing` because this is a whole-document write every time:
    /// the store is one JSON object and there is no partial update to make.
    /// Returns false rather than throwing — a failed publish is not a
    /// failed save, and the app says so in a quieter banner.
    AsyncFunction("set") { (value: String) -> Bool in
      guard let url = Self.fileURL() else { return false }
      var wrote = false
      var failure: NSError?
      NSFileCoordinator().coordinate(writingItemAt: url, options: .forReplacing,
                                     error: &failure) { target in
        wrote = (try? value.write(to: target, atomically: true, encoding: .utf8)) != nil
      }
      if wrote && failure == nil { Self.mirror(value) }
      return wrote && failure == nil
    }

    /// How the CloudKit copy last went, for the cog's sync note.
    AsyncFunction("mirrorStatus") { () -> String in
      Self.mirrorQueue.sync { Self.mirrorNote }
    }

    /// Start telling JS when the file changes underneath us.
    ///
    /// An NSMetadataQuery, which is how iCloud reports a document another
    /// device wrote — there is no notification like the key-value store's.
    /// It must run on the main queue and must be started there.
    ///
    /// The event carries NOTHING. A change notification that shipped the
    /// new contents would be a second way to read the file, and two ways to
    /// read one thing is two answers the day they disagree; JS asks `get`.
    AsyncFunction("watch") { () in
      DispatchQueue.main.async { [weak self] in
        guard let self, self.query == nil else { return }
        let q = NSMetadataQuery()
        q.searchScopes = [NSMetadataQueryUbiquitousDocumentsScope]
        q.predicate = NSPredicate(format: "%K == %@", NSMetadataItemFSNameKey, Self.fileName)
        for name in [NSNotification.Name.NSMetadataQueryDidFinishGathering,
                     NSNotification.Name.NSMetadataQueryDidUpdate] {
          let token = NotificationCenter.default.addObserver(
            forName: name, object: q, queue: .main
          ) { [weak self] _ in
            self?.sendEvent("onRemoteChange", [:])
          }
          self.observers.append(token)
        }
        self.query = q
        q.start()
      }
    }

    OnDestroy {
      // A query that outlives the module keeps a callback pointed at a
      // module that is gone, and iCloud keeps feeding it.
      DispatchQueue.main.async { [weak self] in
        self?.query?.stop()
        self?.query = nil
        self?.observers.forEach { NotificationCenter.default.removeObserver($0) }
        self?.observers.removeAll()
      }
    }
  }
}
