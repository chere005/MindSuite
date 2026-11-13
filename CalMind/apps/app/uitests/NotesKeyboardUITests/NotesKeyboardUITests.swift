// The native notes-keyboard regression (#126), runnable from the repo:
//   sh tools/notes-keyboard-regression.sh
//
// What a browser cannot see and a person used to have to try by hand on the
// phone: the native text view's own corrections racing the app's list logic
// (Return, Return and a letter typed faster than the field reports back), the
// iOS Done bar, drag-to-dismiss, and that what was typed is what is saved.
// It drives the REAL CalMind build by bundle id, signed in to a throwaway
// account on a local fixture server the runner starts.
import XCTest

final class NotesKeyboardUITests: XCTestCase {
    private let app = XCUIApplication(bundleIdentifier: "com.seancheren.calmind")
    private var user = ""
    private var pass = ""

    override func setUpWithError() throws {
        continueAfterFailure = false
        let env = ProcessInfo.processInfo.environment
        user = try XCTUnwrap(env["CALMIND_USER"], "the runner passes CALMIND_USER")
        pass = try XCTUnwrap(env["CALMIND_PASS"], "the runner passes CALMIND_PASS")
        app.launch()
        signInIfNeeded()
    }

    // MARK: - helpers

    private func el(_ id: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).firstMatch
    }

    private func field(placeholder: String) -> XCUIElement {
        let p = NSPredicate(format: "placeholderValue == %@", placeholder)
        let plain = app.textFields.matching(p).firstMatch
        return plain.exists ? plain : app.secureTextFields.matching(p).firstMatch
    }

    private func signInIfNeeded() {
        if el("tab-notes").waitForExistence(timeout: 8) { return }
        let name = field(placeholder: "Username")
        XCTAssertTrue(name.waitForExistence(timeout: 20), "the sign-in screen")
        // A fresh simulator's first keyboard can open on a typing tip that
        // swallows the keystrokes; clear it and type again until it took.
        for _ in 1...3 {
            name.tap()
            for label in ["Continue", "Not Now", "OK"] where app.buttons[label].exists { app.buttons[label].tap() }
            name.typeText(user)
            if (name.value as? String) == user { break }
            name.press(forDuration: 1.0)
            if app.menuItems["Select All"].waitForExistence(timeout: 1) { app.menuItems["Select All"].tap(); name.typeText(XCUIKeyboardKey.delete.rawValue) }
        }
        XCTAssertEqual(name.value as? String, user, "the username went in")
        let pw = field(placeholder: "Password")
        pw.tap(); pw.typeText(pass)
        app.buttons["Sign in"].firstMatch.tap()
        XCTAssertTrue(el("tab-notes").waitForExistence(timeout: 30), "signed in to the fixture account")
    }

    private var keyboardUp: Bool { app.keyboards.firstMatch.exists }

    private func waitKeyboard(_ up: Bool, _ why: String) {
        let gone = NSPredicate { _, _ in self.keyboardUp == up }
        let e = XCTNSPredicateExpectation(predicate: gone, object: nil)
        XCTAssertEqual(XCTWaiter().wait(for: [e], timeout: 8), .completed, why)
    }

    private func body() -> XCUIElement { el("note-body-edit") }

    private func bodyText() -> String { (body().value as? String) ?? "" }

    /// Opens a new note, types `title` and starts the body. Returns the title
    /// the field actually holds — see testNewNoteTitleKeepsEveryKeystroke.
    @discardableResult
    private func newNote(_ title: String) -> String {
        el("tab-notes").tap()
        let add = el("secadd-General")
        XCTAssertTrue(add.waitForExistence(timeout: 10), "the General section's +")
        add.tap()
        let t = el("note-title")
        XCTAssertTrue(t.waitForExistence(timeout: 10), "a new note opens")
        t.tap(); t.typeText(title)
        let held = (t.value as? String) ?? title
        let view = el("note-body-view")
        if view.waitForExistence(timeout: 3) { view.tap() }
        XCTAssertTrue(body().waitForExistence(timeout: 10), "the body editor")
        body().tap()
        return held
    }

    /// A note's row in the list: identifier note-row, labelled with its title.
    private func row(_ title: String) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier == 'note-row' AND label BEGINSWITH %@", title)).firstMatch
    }

    private func reopen(_ title: String) {
        el("note-back").tap()
        let row = row(title)
        XCTAssertTrue(row.waitForExistence(timeout: 10), "the note is in the list")
        row.tap()
        let view = el("note-body-view")
        XCTAssertTrue(view.waitForExistence(timeout: 10) || body().exists, "the note reopens")
    }

    /// The body as stored, read from the editor (the read view draws bullets
    /// as glyphs, so its text is not the note's).
    private func editedText() -> String {
        let view = el("note-body-view")
        if view.waitForExistence(timeout: 5) { view.tap() }
        XCTAssertTrue(body().waitForExistence(timeout: 10), "the body editor reopens")
        return bodyText()
    }

    // MARK: - the regressions

    /// Return, Return and a letter, typed faster than the native field
    /// acknowledges: the list continues, the empty bullet exits, and the
    /// letter lands on the plain line — none of it eaten or doubled.
    func testRapidReturnsInAListKeepEveryKeystroke() {
        newNote("Keyboard probe A")
        body().typeText("* Soup\n\nPlain")
        let want = "* Soup\nPlain"
        let settled = NSPredicate { _, _ in self.bodyText() == want }
        let e = XCTNSPredicateExpectation(predicate: settled, object: nil)
        XCTAssertEqual(XCTWaiter().wait(for: [e], timeout: 5), .completed,
                       "body is \(String(reflecting: bodyText())), want \(String(reflecting: want))")
        // After Return in a list the app writes the next "* " itself; typing
        // the marker again would be the user's mistake, not the editor's.
        body().typeText("\n* Bread\nMilk\n\nDone typing")
        XCTAssertEqual(bodyText(), "* Soup\nPlain\n* Bread\n* Milk\nDone typing")
    }

    /// The iOS Done bar dismisses the keyboard, every time — repeatedly.
    func testDoneBarDismissesRepeatedly() {
        newNote("Keyboard probe B")
        body().typeText("first line")
        for round in 1...3 {
            waitKeyboard(true, "keyboard up, round \(round)")
            let done = el("kb-done")
            XCTAssertTrue(done.waitForExistence(timeout: 5), "the Done bar shows, round \(round)")
            done.tap()
            waitKeyboard(false, "Done dismissed the keyboard, round \(round)")
            let view = el("note-body-view")
            if view.waitForExistence(timeout: 3) { view.tap() } else { body().tap() }
        }
    }

    /// Dragging the page down dismisses the keyboard (keyboardDismissMode on-drag).
    func testDragDismissesTheKeyboard() {
        newNote("Keyboard probe C")
        body().typeText(Array(repeating: "a line long enough to scroll", count: 30).joined(separator: "\n"))
        waitKeyboard(true, "keyboard up before the drag")
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35))
        start.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.9)))
        waitKeyboard(false, "a downward drag dismissed the keyboard")
    }

    /// What was typed is what is saved: leave, come back, and relaunch.
    func testTypedTextPersistsAcrossNavigationAndRelaunch() {
        let title = newNote("Keyboard probe D")
        body().typeText("* one\n* two\n\nafter the list")
        let want = "* one\n* two\nafter the list"
        el("kb-done").tap()
        reopen(title)
        XCTAssertEqual(editedText(), want, "the body after leaving and reopening")
        app.terminate()
        app.launch()
        signInIfNeeded()
        el("tab-notes").tap()
        let row = row(title)
        XCTAssertTrue(row.waitForExistence(timeout: 10), "still listed after a relaunch")
        row.tap()
        XCTAssertEqual(editedText(), want, "the saved body after a relaunch")
    }

    /// #167 as a COUNT, not a single try: the bug needs keystrokes queued
    /// behind the first letter, which a freshly launched app's first keyboard
    /// gives and a warm one mostly does not, so one passing run proves
    /// nothing. Opens TITLE_RUNS (default 10) new notes, each straight after a
    /// relaunch (TITLE_RELAUNCH=0 keeps one launch, which hides the bug),
    /// types a title at test speed right after the tap, reads back what the
    /// field holds and counts the runs that differ. The report goes to
    /// TITLE_OUT (a host path) as one `run ok want got settled` line per run,
    /// and the test fails when ANY run lost, duplicated or reordered a letter.
    func testNewNoteTitleTypingCount() throws {
        let env = ProcessInfo.processInfo.environment
        let runs = Int(env["TITLE_RUNS"] ?? "") ?? 10
        let relaunch = env["TITLE_RELAUNCH"] != "0"
        let out = env["TITLE_OUT"]
        var bad = 0
        var report = ""
        for i in 1...runs {
            if relaunch && i > 1 {
                app.terminate()
                app.launch()
                signInIfNeeded()
            }
            el("tab-notes").tap()
            let add = el("secadd-General")
            XCTAssertTrue(add.waitForExistence(timeout: 10), "the General section's +")
            add.tap()
            let t = el("note-title")
            XCTAssertTrue(t.waitForExistence(timeout: 10), "a new note opens")
            let want = "Keyboard probe title \(i)"
            t.tap(); t.typeText(want)
            let got = (t.value as? String) ?? "<nil>"
            // Let any late echo land, then read again: a letter can also go
            // missing AFTER typing, when a stale value is written back.
            Thread.sleep(forTimeInterval: 0.6)
            let settled = (t.value as? String) ?? "<nil>"
            let ok = got == want && settled == want
            if !ok { bad += 1 }
            report += "run=\(i) ok=\(ok) want=\(String(reflecting: want)) got=\(String(reflecting: got)) settled=\(String(reflecting: settled))\n"
            // Written as it goes: a harness failure later (a relaunch that
            // times out on a loaded machine) must not lose the runs so far.
            if let out, !out.isEmpty { try? report.write(toFile: out, atomically: true, encoding: .utf8) }
            let back = el("note-back")
            if back.waitForExistence(timeout: 5) { back.tap() }
            _ = el("secadd-General").waitForExistence(timeout: 10)
        }
        report += "TITLECOUNT runs=\(runs) bad=\(bad) relaunch=\(relaunch)\n"
        print(report)
        if let out, !out.isEmpty { try? report.write(toFile: out, atomically: true, encoding: .utf8) }
        XCTAssertEqual(bad, 0, "\(bad) of \(runs) titles lost, duplicated or reordered a letter:\n\(report)")
    }

    /// #167, once: a title typed at test speed into a NEW note straight after
    /// a launch keeps every letter ("Keyboard probe title" used to come back
    /// "Kboard probe title"). testNewNoteTitleTypingCount is the count.
    func testNewNoteTitleKeepsEveryKeystroke() {
        let want = "Keyboard probe title"
        XCTAssertEqual(newNote(want), want)
    }
}
