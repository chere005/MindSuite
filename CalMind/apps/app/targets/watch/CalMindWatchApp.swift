import SwiftUI

/// The watch stays read-only, as in the suite: the phone builds the list and
/// ships it over WatchConnectivity; the watch decodes and draws it.
@main
struct CalMindWatchApp: App {
    @StateObject private var store = WatchStore()
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            WatchTabs()
                .environmentObject(store)
        }
        // Raising the wrist brings the app forward without relaunching it;
        // ask for the newest list each time rather than trusting the context.
        .onChange(of: phase) { _, now in
            if now == .active { store.requestFresh() }
        }
    }
}
