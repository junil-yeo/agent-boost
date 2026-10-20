import AppKit
import UserNotifications

/// macOS notification when an agent starts waiting for an answer while the app is in the background.
/// Clicking it brings the app forward and opens that agent's conversation (where the PromptCard is).
@MainActor final class PromptNotifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = PromptNotifier()
    private var store: BoardStore?
    private var asked = false
    private var notified = Set<String>()      // sessionIds already announced for the current wait

    func install(store: BoardStore) {
        self.store = store
        guard Bundle.main.bundleIdentifier != nil else { return }      // not running as an .app (swift run, tests)
        UNUserNotificationCenter.current().delegate = self
    }

    /// Call whenever the set of agents waiting for an answer changes.
    func update(waiting: [Agent], enabled: Bool) {
        let ids = Set(waiting.map(\.sessionId))
        notified.formIntersection(ids)                                   // a finished wait can notify again next time
        guard enabled, !NSApp.isActive, Bundle.main.bundleIdentifier != nil else { return }
        let center = UNUserNotificationCenter.current()
        if !asked { asked = true; center.requestAuthorization(options: [.alert, .sound]) { _, _ in } }
        for a in waiting where !notified.contains(a.sessionId) {
            notified.insert(a.sessionId)
            let c = UNMutableNotificationContent()
            c.title = L("%@: 응답 필요", a.name)
            c.body = a.prompt?.title ?? L("에이전트가 답을 기다리고 있습니다")
            c.sound = .default
            c.userInfo = ["sessionId": a.sessionId]
            center.add(UNNotificationRequest(identifier: "prompt-" + a.sessionId, content: c, trigger: nil))
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard let sid = response.notification.request.content.userInfo["sessionId"] as? String else { return }
        await MainActor.run {
            NSApp.activate(ignoringOtherApps: true)
            if let w = NSApp.windows.first(where: { $0.canBecomeMain }) { w.makeKeyAndOrderFront(nil) }
            if let s = self.store, let a = s.agent(sid) { s.open(a) }
        }
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions { [] }
}
