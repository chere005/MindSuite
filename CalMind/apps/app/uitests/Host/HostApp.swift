// The UI-test bundle needs a host app to be built against; the tests drive
// CalMind itself, by bundle id. This app is never looked at.
import SwiftUI

@main
struct ProbeHostApp: App {
    var body: some Scene { WindowGroup { Text("CalMind keyboard probe host") } }
}
