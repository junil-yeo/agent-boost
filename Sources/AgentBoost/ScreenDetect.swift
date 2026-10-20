import Foundation

/// Reads Claude Code's TUI from a capture-pane dump. Everything is judged by POSITION, never by a string appearing
/// anywhere: the conversation may quote "esc to interrupt" or "Compiling… (12s)" and the session is still idle.
///
/// Layout (bottom of the screen):
///     … conversation …
///     ✻ Crafting… (2s · thinking)      <- spinner line, only while a turn runs (a to-do list may sit between it and the box)
///     hint line(s)
///     ─────────────────────            <- input box top rule
///     ❯                                <- input
///     ─────────────────────            <- input box bottom rule
///       ⏸ manual mode on · esc to interrupt     <- status line ("esc to in…" when narrow)
enum Screen {
    private static func clean(_ text: String) -> [String] {
        text.split(separator: "\n", omittingEmptySubsequences: true).map { l -> String in
            var t = l.trimmingCharacters(in: .whitespaces)
            if t.hasPrefix("│") { t = String(t.dropFirst()).trimmingCharacters(in: .whitespaces) }
            return t
        }.filter { !$0.isEmpty }
    }
    /// The input box's rules (and the legacy ╭/╰ box edges).
    private static func isInputRule(_ t: String) -> Bool { t.hasPrefix("────────") || t.hasPrefix("╭") || t.hasPrefix("╰") }
    /// Any rule, including the dashed ╌ lines that frame permission previews.
    private static func isAnyRule(_ t: String) -> Bool { isInputRule(t) || t.hasPrefix("╌╌╌╌╌╌╌╌") || t.hasPrefix("▔▔▔▔▔▔▔▔") }
    private static let spinnerStart = Set("✽✳✶✢✻✷✸✹·*⎿")

    /// A status-line segment that is a (possibly cut) "esc to interrupt": "esc to interrupt", "esc to in…", "esc t…", "esc …".
    private static func statusSaysInterrupt(_ line: String) -> Bool {
        line.split(separator: "·").contains { seg in
            var t = seg.trimmingCharacters(in: .whitespaces)
            while t.hasSuffix("…") || t.hasSuffix(".") { t.removeLast() }
            t = t.trimmingCharacters(in: .whitespaces)
            return t.count >= 3 && "esc to interrupt".hasPrefix(t)
        }
    }

    static func busy(_ text: String) -> Bool {
        let ls = clean(text)
        let rules = ls.indices.filter { isInputRule(ls[$0]) }
        guard let bottom = rules.last else { return false }
        if ls[(bottom + 1)...].prefix(3).contains(where: statusSaysInterrupt) { return true }
        let top = rules.dropLast().last.flatMap { bottom - $0 <= 6 ? $0 : nil } ?? bottom
        // the spinner sits above the input box, possibly with a to-do list ("⎿ ☐ …") and hints between: look up to 12 lines, never past another rule
        var from = top
        while from > 0, top - from < 12, !isInputRule(ls[from - 1]) { from -= 1 }
        return ls[from..<top].contains { l in
            guard let f = l.first, spinnerStart.contains(f) else { return false }
            return l.range(of: #"…\s*\(\d+\s*[smh]"#, options: .regularExpression) != nil
        }
    }

    /// A permission / choice prompt waits for the user. Only the block below the last rule counts, so a long diff preview
    /// cannot push the options out of range and old answers in the scrollback cannot trigger it.
    static func needsInput(_ text: String) -> Bool {
        if busy(text) { return false }
        let ls = clean(text)
        if isAgentList(ls) { return false }
        let block: [String] = ls.lastIndex(where: isAnyRule).map { Array(ls[($0 + 1)...]) } ?? Array(ls.suffix(12))
        let b = Array(block.suffix(30))
        func numbered(_ t: String) -> Bool { t.range(of: #"^(❯|>)?\s*\d+\.\s"#, options: .regularExpression) != nil }
        let idle: (String) -> Bool = { isInputRule($0) || $0.contains("? for shortcuts") || $0 == "❯" || $0 == ">" }
        guard let last = b.lastIndex(where: numbered) else {
            // un-numbered list ("❯ No, exit" / "Yes, I trust …"): a ❯ line with options under it
            guard let c = b.lastIndex(where: { $0.hasPrefix("❯ ") }), c + 1 < b.count else { return false }
            return !b[(c + 1)...].contains(where: idle)
        }
        if b[(last + 1)...].contains(where: idle) { return false }
        if b.contains(where: { $0.range(of: #"^❯\s*\d+\.\s"#, options: .regularExpression) != nil }) { return true }
        let joined = b.joined(separator: "\n").lowercased()
        return b.filter(numbered).count >= 2 && (joined.contains("do you want") || joined.contains("esc to cancel") || joined.contains("would you like"))
    }

    /// The teammate list the CLI draws under its footer ("⏺ main" / "◯ teammate1  … ready and idle" / "↓ 3 more"):
    /// rows to pick an agent to view, not a question to answer.
    private static func isAgentList(_ ls: [String]) -> Bool {
        let tail = ls.suffix(14)
        let rows = tail.filter { $0.hasPrefix("◯ ") || $0.hasPrefix("⏺ main") || $0.hasPrefix("● main") || $0.hasPrefix("❯ ⏺") || $0.hasPrefix("❯ ◯") }
        return rows.count >= 2
    }
    /// Claude's "Switch model?" confirmation (shown by /model when the conversation is cached for the current model) with the
    /// cursor on "1. Yes, switch to …". Matched exactly so no other prompt is ever mistaken for it.
    static func isSwitchModelPrompt(_ text: String) -> Bool {
        let b = Array(clean(text).suffix(14))
        return b.contains { $0 == "Switch model?" }
            && b.contains { $0.hasPrefix("❯ 1. Yes, switch to ") }
            && b.contains { $0.hasPrefix("2. No, go back") }
    }

    /// Title, explanation, preview and options of the choice window on screen (nil when no prompt waits).
    static func prompt(_ text: String) -> PromptInfo? {
        guard needsInput(text) else { return nil }
        let ls = clean(text)
        let r = ls.lastIndex(where: isAnyRule)
        let start = r.map { $0 + 1 } ?? max(0, ls.count - 12)
        let b = Array(ls[start...].suffix(30))
        func optionBody(_ t: String) -> (cursor: Bool, label: String)? {
            if let m = t.range(of: #"^(❯|>)?\s*(\d+)\.\s+"#, options: .regularExpression) {
                let head = String(t[m])
                return (head.hasPrefix("❯") || head.hasPrefix(">"), String(t[m.upperBound...]))
            }
            return nil
        }
        func isFooter(_ t: String) -> Bool { t.hasPrefix("Esc to") || t.hasPrefix("esc to") || t.hasPrefix("Enter to") || isAnyRule(t) }
        var options: [String] = [], cursor = 0, numbered = true, first = 0
        if let f = b.firstIndex(where: { optionBody($0) != nil }) {
            first = f
            for t in b[f...] {
                if isFooter(t) { break }
                if let o = optionBody(t) { if o.cursor { cursor = options.count }; options.append(o.label) }
                else if !options.isEmpty { options[options.count - 1] += " " + t }     // wrapped label (long path ...)
            }
        } else if let c = b.lastIndex(where: { $0.hasPrefix("❯ ") }) {
            numbered = false; first = c
            for t in b[c...] {
                if isFooter(t) { break }
                if t.hasPrefix("❯ ") { cursor = options.count; options.append(String(t.dropFirst(2))) } else { options.append(t) }
            }
        }
        guard options.count >= 2 else { return nil }
        // title: the closest question above the options, else the first line of the block
        let q = b[..<first].lastIndex(where: { $0.hasSuffix("?") }) ?? 0
        let title = b.isEmpty ? "" : b[q]
        let detail = q + 1 < first ? b[(q + 1)..<first].joined(separator: "\n") : ""
        var preview: String?
        if let r, ls[r].hasPrefix("╌") {                 // a command / diff preview exists only for permission requests
            let r0 = ls[..<r].lastIndex(where: isAnyRule)
            let lines = Array(ls[(r0.map { $0 + 1 } ?? 0)..<r].suffix(30))
            if !lines.isEmpty { preview = lines.joined(separator: "\n") }
        }
        return PromptInfo(title: title, detail: detail.isEmpty ? nil : detail, preview: preview, options: options, cursor: cursor, numbered: numbered)
    }
}

/// What Claude Code prints around its input box besides the conversation: the spinner line while a turn runs
/// ("· Mustering… (2m 30s · ↓ 9.8k tokens)"), the "done" line after it ("✻ Cogitated for 2m 47s · done 2:16 AM")
/// and the footer ("⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt · ← 3 agents").
struct ScreenStatus: Equatable {
    var verb: String?        // the spinner's word, without the ellipsis: "Mustering"
    var elapsed: String?     // "2m 30s"
    var tokens: String?      // "9.8k"
    var thinking = false     // "(… · thinking)" while the model reasons
    var activity: String?    // the short progress line above the spinner: "Running 1 shell command…"
    var done: String?        // "Cogitated for 2m 47s · done 2:16 AM" (idle, until the next turn)
    var mode: String?        // "auto mode" / "accept edits" / "plan mode" / "bypass permissions"; nil = default
    var agents: Int?         // teammates the footer counts ("← 3 agents")
    var suggestion: String?  // the CLI's predicted next prompt, drawn dim in the empty box ("❯ 이제 실행해줘"); Tab accepts it there
    var isEmpty: Bool { self == ScreenStatus() }
}

extension Screen {
    private static let glyphs = "✽✳✶✢✻✷✸✹·*"
    /// Lines of a capture, same cleaning as the state detectors (box edge stripped, blanks dropped).
    private static func lines(_ text: String) -> [String] {
        text.split(separator: "\n", omittingEmptySubsequences: true).map { l -> String in
            var t = l.trimmingCharacters(in: .whitespaces)
            if t.hasPrefix("│") { t = String(t.dropFirst()).trimmingCharacters(in: .whitespaces) }
            return t.replacingOccurrences(of: "\u{a0}", with: " ")
        }.filter { !$0.isEmpty }
    }
    private static func rule(_ t: String) -> Bool { t.hasPrefix("────────") || t.hasPrefix("╭") || t.hasPrefix("╰") }

    /// Plain text of a `capture-pane -e` dump (SGR / other CSI and OSC sequences removed).
    static func stripANSI(_ s: String) -> String {
        guard s.contains("\u{1B}") else { return s }
        return s.replacingOccurrences(of: "\u{1B}\\][^\u{07}\u{1B}]*(\u{07}|\u{1B}\\\\)", with: "", options: .regularExpression)
            .replacingOccurrences(of: "\u{1B}\\[[0-9;:?<=>]*[ -/]*[@-~]", with: "", options: .regularExpression)
            .replacingOccurrences(of: "\u{1B}[()][0-9A-Za-z]", with: "", options: .regularExpression)
    }
    /// A CLI screen that replaces the conversation in the pane. "agents": the session list behind "← for agents" (the CLI moves
    /// the conversation to a background job and the box there dispatches a NEW session); "resume": the /resume picker.
    /// Anything typed into the pane then never reaches the agent.
    static func overlay(_ text: String) -> String? {
        let tail = Array(clean(text).suffix(40))
        if tail.contains(where: { $0.hasPrefix("Your conversation moved to the background") || $0.hasPrefix("❯ describe a task for a new session")
                                  || ($0.contains("enter to return") && ($0.contains("space to reply") || $0.contains("ctrl+x to delete"))) }) { return "agents" }
        if tail.contains(where: { $0 == "Resume session" }), tail.contains(where: { $0.contains("Esc to cancel") && $0.contains("Type to search") }) { return "resume" }
        return nil
    }

    /// The raw input row after "❯" (nbsp / spaces skipped), nil when there is no input box on screen.
    private static func inputRow(_ raw: String) -> Substring? {
        let rows = raw.components(separatedBy: "\n")
        let plain = rows.map { stripANSI($0).trimmingCharacters(in: .whitespaces) }
        guard let bottom = plain.lastIndex(where: rule), bottom > 0 else { return nil }
        // the input line: the first "❯" row under the box's top rule (a multi-line box keeps it on its first row)
        guard let top = plain[..<bottom].lastIndex(where: rule), bottom - top <= 6,
              let i = (top + 1..<bottom).first(where: { plain[$0].hasPrefix("❯") }) else { return nil }
        let line = rows[i]
        guard let mark = line.range(of: "❯") else { return nil }
        return Substring(line[mark.upperBound...])
    }
    /// Walks the input row past separators and colour resets. Returns (what is left, whether it starts with dim text).
    private static func inputText(_ raw: String) -> (rest: Substring, dim: Bool, typed: Bool)? {
        guard var rest = inputRow(raw) else { return nil }
        while let f = rest.first {
            if f == "\u{a0}" || f == " " { rest = rest.dropFirst(); continue }
            if f == "\u{1B}", let m = rest.range(of: "^\u{1B}\\[[0-9;]*m", options: .regularExpression) {
                let code = String(rest[m])
                if code == "\u{1B}[2m" || code.hasPrefix("\u{1B}[2;") || code.contains(";2m") || code.contains(";2;") { return (rest, true, false) }
                rest = rest[m.upperBound...]; continue
            }
            if f == "\u{1B}" { return (rest, false, false) }      // some other escape (cursor shape …): not text
            return (rest, false, true)
        }
        return (rest, false, false)
    }
    /// Someone typed into the CLI's input box: text that is neither the dim suggestion nor the dim placeholder.
    static func typedInput(_ raw: String) -> Bool { inputText(raw)?.typed ?? false }
    static func hasInputBox(_ raw: String) -> Bool { inputText(raw) != nil }

    /// The dim text right after "❯" on the input line between the box rules: the CLI's suggestion. Typed text is not dim,
    /// so a box with something typed in it yields nil.
    static func suggestion(_ raw: String) -> String? {
        guard let t = inputText(raw), t.dim else { return nil }
        let rest = t.rest
        guard rest.hasPrefix("\u{1B}[") else { return nil }
        let text = stripANSI(String(rest)).replacingOccurrences(of: "\u{a0}", with: " ").trimmingCharacters(in: .whitespaces)
        // the box's own placeholder ("Try \"…\"") is dim too: only take a real prediction
        if text.isEmpty || text.hasPrefix("Try \"") || text.hasPrefix("Message @") || text.hasPrefix("Press ") { return nil }
        return text
    }

    /// Everything the footer, spinner and done line say. Cheap: one pass over the last screen.
    static func status(_ text: String) -> ScreenStatus {
        var st = ScreenStatus()
        let ls = lines(text)
        let rules = ls.indices.filter { rule(ls[$0]) }
        guard let bottom = rules.last else { return st }
        let top = rules.dropLast().last.flatMap { bottom - $0 <= 6 ? $0 : nil } ?? bottom
        // footer: up to 3 lines under the box
        for l in ls[(bottom + 1)...].prefix(3) {
            if let m = l.range(of: #"⏵⏵\s*([a-z ]+?) on\b"#, options: .regularExpression) {
                let inner = String(l[m]).replacingOccurrences(of: "⏵⏵", with: "").replacingOccurrences(of: " on", with: "").trimmingCharacters(in: .whitespaces)
                st.mode = inner
            }
            if let m = l.range(of: #"←\s*(\d+)\s*agent"#, options: .regularExpression) {
                st.agents = Int(l[m].filter(\.isNumber))
            }
        }
        // above the box: the spinner (running) or the done line (idle), never past another rule
        var from = top
        while from > 0, top - from < 12, !rule(ls[from - 1]) { from -= 1 }
        let block = Array(ls[from..<top])
        for (i, l) in block.enumerated().reversed() {
            guard let f = l.first, glyphs.contains(f) else { continue }
            let body = l.dropFirst().trimmingCharacters(in: .whitespaces)
            // spinner: "Mustering… (2m 30s · ↓ 9.8k tokens · thinking)"
            if let m = body.range(of: #"^(.+?)…\s*\((.*)\)"#, options: .regularExpression) {
                let inner = String(body[m])
                let verb = inner.split(separator: "…", maxSplits: 1).first.map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
                guard let o = inner.firstIndex(of: "("), let c = inner.lastIndex(of: ")"), o < c else { continue }
                let segs = inner[inner.index(after: o)..<c].split(separator: "·").map { $0.trimmingCharacters(in: .whitespaces) }
                guard let first = segs.first, first.range(of: #"^\d+\s*[smh]"#, options: .regularExpression) != nil else { continue }
                st.verb = verb.isEmpty ? nil : verb
                st.elapsed = first
                for seg in segs.dropFirst() {
                    if seg.hasSuffix("tokens") { st.tokens = seg.replacingOccurrences(of: "tokens", with: "").replacingOccurrences(of: "↓", with: "").replacingOccurrences(of: "↑", with: "").trimmingCharacters(in: .whitespaces) }
                    else if seg == "thinking" { st.thinking = true }
                }
                // the progress line right above it ("Running 1 shell command…"): short, ends with an ellipsis, not a to-do row
                for k in stride(from: i - 1, through: max(0, i - 3), by: -1) {
                    let a = block[k]
                    if a.hasPrefix("⎿") || a.hasPrefix("☐") || a.hasPrefix("☒") || a.hasPrefix("⏺") || a.hasPrefix("›") { continue }
                    if a.hasSuffix("…"), a.count < 90, !(a.first.map { glyphs.contains($0) } ?? false) { st.activity = a }
                    break
                }
                return st
            }
            // done: "Cogitated for 2m 47s · done 2:16 AM" (only the first glyph line from the bottom counts)
            if body.range(of: #"^\S+ for \d+"#, options: .regularExpression) != nil { st.done = body; return st }
        }
        return st
    }
}

/// Answers a Claude Code choice window by walking the cursor (Up/Down) and pressing Enter. Blocking: call on the pane's queue.
enum PromptDriver {
    /// nil = the window is gone afterwards; otherwise a message that says why not.
    static func answer(pane p: String, expected: PromptInfo, optionIndex: Int) -> String? {
        func screen() -> String? { let r = Shell.tmux(["capture-pane", "-p", "-t", p, "-S", "-4"]); return r.code == 0 ? r.out : nil }
        func same(_ x: PromptInfo?) -> Bool { x?.title == expected.title && x?.options == expected.options }
        guard expected.options.indices.contains(optionIndex) else { return "없는 선택지입니다." }
        guard let now = screen(), let cur = Screen.prompt(now), same(cur) else { return "화면의 선택창이 바뀌었거나 읽을 수 없어 보내지 않았습니다." }
        let delta = optionIndex - cur.cursor
        for _ in 0..<abs(delta) {
            guard TmuxControl.keys(["-t", p, delta > 0 ? "Down" : "Up"], what: "선택 이동") else { return nil }
            usleep(90_000)
        }
        usleep(200_000)
        guard let moved = screen(), let pr = Screen.prompt(moved), same(pr), pr.cursor == optionIndex else {
            return "커서를 원하는 선택지로 옮기지 못해 취소했습니다. 터미널에서 직접 선택해 주세요."
        }
        guard TmuxControl.keys(["-t", p, "Enter"], what: "선택 확정") else { return nil }
        usleep(800_000)
        if let after = screen(), same(Screen.prompt(after)) { return "선택을 보냈지만 선택창이 아직 떠 있습니다. 터미널에서 확인해 주세요." }
        return nil
    }
}
