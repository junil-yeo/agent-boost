import Foundation

/// The app reads the Claude Code CLI's screen and records, so a CLI update can quietly break sending, status or the
/// queue. When the installed CLI version changes, this checks once (no tokens, nothing typed into any session):
///  1. the screen texts the app looks for are still in the new CLI program (compared with the previous version's);
///  2. on every idle session the app can still find the input box.
/// A problem shows as a notice; a clean result is only logged.
enum CLICheck {
    /// Texts the screen readers depend on (ScreenDetect, TmuxControl, the queue reader). All present in 2.1.304.
    static let markers = [
        "esc to interrupt", "esc to cancel", "Esc to cancel", "accept edits", "auto mode", "bypass permissions", "plan mode",
        "Kept model as", "Set model to", "Set effort level to", "Do you want to proceed?", "Press up to edit queued messages",
        "queue-operation", "popAll", "Resume session", "isPasting", "for shortcuts", "Disconnect this session",
        "Choose the text style", "Let's get started", "Paste code here if prompted", "Pasted text #", "[Image #",
    ]
    private static let key = "cli.checkedVersion"
    private static let versions = Shell.home + "/.local/share/claude/versions"   // where the installer keeps earlier versions

    /// At launch and every 30 minutes (the CLI updates itself while sessions run).
    @MainActor static func start(_ store: BoardStore) {
        func tick() {
            DispatchQueue.global(qos: .utility).async {
                guard let msg = check(live: liveScreens(store)) else { return }
                DispatchQueue.main.async { store.notice = msg }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) { tick() }
        Timer.scheduledTimer(withTimeInterval: 1800, repeats: true) { _ in DispatchQueue.main.async { tick() } }
    }
    /// Screens of idle sessions (their input box must be found), captured on the caller's thread later.
    @MainActor private static func liveScreens(_ store: BoardStore) -> [(name: String, pane: String)] {
        (store.teams.flatMap(\.members) + store.loose).compactMap { a in
            guard a.state == .idle, a.overlay == nil, let p = a.tmuxPane else { return nil }
            return (a.name, p)
        }
    }
    /// nil when nothing changed or all is well; otherwise the warning to show.
    static func check(live: [(name: String, pane: String)]) -> String? {
        // the CLI's own answer ("2.1.304 (Claude Code)")
        let v = Shell.run([Shell.claude, "--version"], timeout: 10)
        guard v.code == 0, let now = v.out.split(separator: " ").first.map(String.init), now.first?.isNumber == true else { return nil }
        let before = UserDefaults.standard.string(forKey: key)
        guard before != now else { return nil }
        let bin = (Shell.claude as NSString).resolvingSymlinksInPath       // the program the texts are looked up in
        guard let new = try? Data(contentsOf: URL(fileURLWithPath: bin), options: .alwaysMapped) else { return nil }
        // the previous version's program, when the installer kept it: a text missing from both was never a CLI text
        let old = before.flatMap { try? Data(contentsOf: URL(fileURLWithPath: versions + "/" + $0), options: .alwaysMapped) }
        let gone = markers.filter { m in
            let d = Data(m.utf8)
            return new.range(of: d) == nil && (old.map { $0.range(of: d) != nil } ?? true)
        }
        var noBox: [String] = []
        for s in live {
            let raw = Shell.tmux(["capture-pane", "-p", "-e", "-t", s.pane]).out
            if !raw.isEmpty, !Screen.hasInputBox(raw) { noBox.append(s.name) }
        }
        UserDefaults.standard.set(now, forKey: key)
        let from = before.map { "\($0) → " } ?? ""
        SendLog.note("CLI 점검 \(from)\(now): 사라진 문구 \(gone.count)개 \(gone), 입력창 못 찾음 \(noBox)")
        guard before != nil, !gone.isEmpty || !noBox.isEmpty else { return nil }   // first run: just remember the version
        var parts: [String] = []
        if !gone.isEmpty { parts.append(L("앱이 읽는 CLI 화면 문구 %@개가 사라졌습니다 (%@)", String(gone.count), gone.prefix(4).joined(separator: ", ") + (gone.count > 4 ? " …" : ""))) }
        if !noBox.isEmpty { parts.append(L("입력창을 찾지 못한 세션: %@", noBox.joined(separator: ", "))) }
        return L("Claude Code CLI가 %@%@로 업데이트됐습니다. %@. 전송·상태 표시·대기열이 틀어질 수 있으니 App Developer 세션에 알려 주세요.", from, now, parts.joined(separator: ". "))
    }
}
