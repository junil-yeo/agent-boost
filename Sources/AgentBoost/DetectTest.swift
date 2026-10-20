import Foundation

/// `AgentBoost --selftest-detect`: runs Screen.busy / Screen.needsInput over real capture-pane dumps (DetectFixtures.swift)
/// and prints one line per fixture. Exit code 0 = all pass.
enum DetectTest {
    static func run() -> Int32 {
        var failed = 0
        for f in DetectFixtures.all {
            let b = Screen.busy(f.text), n = Screen.needsInput(f.text)
            let sw = Screen.isSwitchModelPrompt(f.text)
            let pr = Screen.prompt(f.text)
            let promptOK = f.prompt.map { e in pr?.title == e.title && pr?.options.count == e.options && pr?.cursor == e.cursor && pr?.numbered == e.numbered } ?? (pr == nil)
            let ov = Screen.overlay(f.text)
            let ok = b == f.busy && n == f.needsInput && sw == f.switchModel && promptOK && ov == f.overlay
            if let p = Screen.prompt(f.text) { print("   prompt: title=\(p.title.debugDescription) detail=\((p.detail ?? "").debugDescription) preview=\(p.preview?.split(separator: "\n").count ?? 0) lines options=\(p.options) cursor=\(p.cursor) numbered=\(p.numbered)") }
            if !ok { failed += 1 }
            print("\(ok ? "PASS" : "FAIL") \(f.name): busy=\(b) (want \(f.busy)) needsInput=\(n) (want \(f.needsInput)) switchModel=\(sw) (want \(f.switchModel)) prompt=\(promptOK ? "ok" : "MISMATCH") overlay=\(ov ?? "nil") (want \(f.overlay ?? "nil"))")
        }
        print(failed == 0 ? "ALL \(DetectFixtures.all.count) PASSED" : "\(failed) FAILED")
        return failed == 0 ? 0 : 1
    }

    /// `--selftest-answer %PANE INDEX`: reads the prompt on that pane, picks the option and reports.
    static func answer(pane: String, index: Int) -> Int32 {
        let r = Shell.tmux(["capture-pane", "-p", "-t", pane, "-S", "-4"])
        guard let p = Screen.prompt(r.out) else { print("NO PROMPT on \(pane)"); return 2 }
        print("prompt: \(p.title) options=\(p.options.map { String($0.prefix(30)) }) cursor=\(p.cursor) -> choose \(index)")
        let msg = PromptDriver.answer(pane: pane, expected: p, optionIndex: index)
        print(msg.map { "RESULT: \($0)" } ?? "RESULT: ok (prompt gone)")
        return msg == nil ? 0 : 1
    }
}
