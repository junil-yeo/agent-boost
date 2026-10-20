import Foundation

/// Every step of sending a message, one line each, in ~/.agent-boost/send.log (kept under 512 KB): a message that never
/// reached the CLI can be traced afterwards (refused, composer rebuilt, typed into the wrong pane, Enter swallowed).
enum SendLog {
    private static let q = DispatchQueue(label: "sendlog", qos: .utility)
    private static let path = NSHomeDirectory() + "/.agent-boost/send.log"
    private static let fmt: ISO8601DateFormatter = { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f }()
    static func note(_ s: String) {
        let line = fmt.string(from: Date()) + " " + s.replacingOccurrences(of: "\n", with: "⏎") + "\n"
        q.async {
            let fm = FileManager.default
            if let a = try? fm.attributesOfItem(atPath: path), (a[.size] as? Int ?? 0) > 512_000 {
                try? fm.removeItem(atPath: path + ".1"); try? fm.moveItem(atPath: path, toPath: path + ".1")
            }
            if !fm.fileExists(atPath: path) { fm.createFile(atPath: path, contents: nil) }
            if let h = FileHandle(forWritingAtPath: path) { h.seekToEndOfFile(); h.write(Data(line.utf8)); try? h.close() }
        }
    }
    static func head(_ t: String) -> String { "\"" + String(t.prefix(40)) + (t.count > 40 ? "…" : "") + "\" (\(t.count)자)" }
}

/// Sends input to agents through tmux. Every entry point validates the pane id.
enum TmuxControl {
    private static func valid(_ pane: String) -> Bool {
        pane.hasPrefix("%") && pane.dropFirst().allSatisfy(\.isNumber)
    }

    // Every send-keys for a pane goes through one serial queue: text and Enter of one message
    // can no longer interleave with the next message or a slash command, and the main thread
    // never waits on tmux.
    private static let qLock = NSLock()
    private static var queues: [String: DispatchQueue] = [:]
    private static func enqueue(_ pane: String, _ work: @escaping () -> Void) {
        guard valid(pane) else { return }
        queue(pane, work)
    }
    /// The serial queue for a pane (or a tmux session name): anything that types into it goes through here.
    static func queue(_ key: String, _ work: @escaping () -> Void) {
        qLock.lock()
        let q = queues[key] ?? DispatchQueue(label: "tmux.send.\(key)", qos: .userInitiated)
        queues[key] = q
        qLock.unlock()
        q.async(execute: work)
    }
    /// Runs one tmux command on the key's queue and returns its result without blocking the caller's thread.
    static func exec(_ key: String, _ args: [String]) async -> Shell.Result {
        await withCheckedContinuation { c in queue(key) { c.resume(returning: Shell.tmux(args)) } }
    }
    /// Called (on any thread) when a send had to use a fallback.
    nonisolated(unsafe) static var onWarning: ((String) -> Void)?

    /// send-keys that tells the user when tmux refused it (pane gone, server down) instead of losing the input silently.
    @discardableResult
    static func keys(_ args: [String], what: String = "키 입력") -> Bool {
        let r = Shell.tmux(["send-keys"] + args)
        if r.code != 0 { onWarning?("\(what)을(를) tmux에 보내지 못했습니다: \(r.err.trimmingCharacters(in: .whitespacesAndNewlines).prefix(80))") }
        return r.code == 0
    }

    /// Text + Enter, as if typed into the agent's prompt. Multi-line text is pasted (bracketed
    /// paste) so its newlines are not taken for Enter.
    static func send(_ text: String, to pane: String, sid: String = "") {
        guard valid(pane) else { SendLog.note("tmux \(pane): 잘못된 pane id — 보내지 않음"); return }
        enqueue(pane) {
            sendNow(text, to: pane, sid: sid)
            DispatchQueue.main.async { onDone?(sid) }
        }
    }
    /// Messages waiting in the CLI's queue come back into its box with ↑ (the CLI records "popAll"); the box is then
    /// emptied, so the queue is gone and the app holds the text. With no popAll the ↑ only walked the prompt history
    /// (the queue had already run): ↓ steps back to the empty box. `done(true)` when the queue was taken out.
    static func pullQueue(_ pane: String, sid: String, done: @escaping (Bool) -> Void) {
        enqueue(pane) {
            guard let path = transcript(sid) else { DispatchQueue.main.async { done(false) }; return }
            let mark = size(path)
            keys(["-t", pane, "Up"], what: "대기열 꺼내기(↑)")
            var ok = false
            let end = Date().addingTimeInterval(2)
            repeat {
                if appended(path, after: mark).contains("\"popAll\"") { ok = true; break }
                usleep(100_000)
            } while Date() < end
            if ok {
                usleep(150_000)
                for _ in 0..<30 { keys(["-t", pane, "C-u"], what: "입력창 비우기"); usleep(30_000) }
            } else {
                keys(["-t", pane, "Down"], what: "↓ (기록 탐색 되돌리기)")
            }
            SendLog.note("tmux \(pane): 대기열 꺼내기 " + (ok ? "성공 — CLI 입력창 비움" : "실패 (대기열이 이미 처리됨)"))
            DispatchQueue.main.async { done(ok) }
        }
    }
    /// Called on the main thread with the session id when a send has finished (Enter taken, or given up).
    nonisolated(unsafe) static var onDone: ((String) -> Void)?
    /// The CLI turns pasted image paths into "[Image #n]" chips. While it reads them ("Pasting…" under the box, half a
    /// second or more for large screenshots) the box is empty and an Enter does nothing: the message then stayed unsent.
    /// Waits until "Pasting…" is gone and, with `needText`, the pasted text shows in the box (at most 20 s; 1.5 s when
    /// no "Pasting…" ever shows). Only the lines under the box count: the conversation above may quote the word.
    private static func waitPasted(_ pane: String, needText: Bool) {
        let start = Date()
        func pasting(_ raw: String) -> Bool {
            raw.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.suffix(3)
                .contains { Screen.stripANSI($0).contains("Pasting…") }
        }
        while Date().timeIntervalSince(start) < 20 {
            let raw = Shell.tmux(["capture-pane", "-p", "-e", "-t", pane]).out
            if !pasting(raw) && (!needText || Screen.typedInput(raw) || Date().timeIntervalSince(start) > 1.5) {
                if Date().timeIntervalSince(start) > 0.3 { SendLog.note("tmux \(pane): 붙여넣기 처리 기다림 \(String(format: "%.1f", Date().timeIntervalSince(start)))초") }
                return
            }
            usleep(100_000)
        }
        SendLog.note("tmux \(pane): 20초가 지나도 붙여넣기 처리가 끝나지 않음")
    }
    /// Called (on any thread) with the session id when a message left the box but the CLI never took it.
    nonisolated(unsafe) static var onLost: ((String) -> Void)?
    private static let historyPath = NSHomeDirectory() + "/.claude/history.jsonl"
    private static func size(_ path: String) -> UInt64 { ((try? FileManager.default.attributesOfItem(atPath: path))?[.size] as? NSNumber)?.uint64Value ?? 0 }
    /// The session's transcript (~/.claude/projects/<project>/<sid>.jsonl), if there is one.
    private static func transcript(_ sid: String) -> String? {
        guard !sid.isEmpty else { return nil }
        let root = NSHomeDirectory() + "/.claude/projects"
        for d in (try? FileManager.default.contentsOfDirectory(atPath: root)) ?? [] {
            let p = root + "/" + d + "/" + sid + ".jsonl"
            if FileManager.default.fileExists(atPath: p) { return p }
        }
        return nil
    }
    private static func appended(_ path: String, after offset: UInt64) -> String {
        guard let fh = FileHandle(forReadingAtPath: path) else { return "" }
        defer { try? fh.close() }
        guard ((try? fh.seekToEnd()) ?? 0) > offset else { return "" }
        try? fh.seek(toOffset: offset)
        return String(decoding: fh.readDataToEndOfFile(), as: UTF8.self)
    }
    /// Did the CLI take the message? A message it runs at once goes to ~/.claude/history.jsonl; one typed while a turn
    /// runs is queued first ("queue-operation" enqueue in the transcript) and reaches history only when it runs, which can
    /// be many seconds later. Either counts. An empty box alone does not prove it: a pasted message with image paths once
    /// vanished from the box while the CLI was still turning the paths into images, and was never submitted.
    private static func accepted(_ sid: String, history hOff: UInt64, transcript: (path: String, off: UInt64)?, seconds: Double) -> Bool {
        let needle = "\"sessionId\":\"\(sid)\""
        let end = Date().addingTimeInterval(seconds)
        repeat {
            if appended(historyPath, after: hOff).contains(needle) { return true }
            if let t = transcript {
                let new = appended(t.path, after: t.off)
                if new.contains("\"operation\":\"enqueue\"") || new.contains("\"type\":\"user\"") { return true }
            }
            usleep(250_000)
        } while Date() < end
        return false
    }
    private static func sendNow(_ text: String, to pane: String, sid: String = "") {
        guard !text.isEmpty else { return }
        let mark = size(historyPath)
        let tpath = transcript(sid), tmark = tpath.map { (path: $0, off: size($0)) }
        SendLog.note("tmux \(pane): 입력 시작 " + SendLog.head(text))
        if text.contains("\n") {
            let file = NSTemporaryDirectory() + "ab-paste-\(UUID().uuidString)"
            let buf = "ab-" + String(pane.dropFirst())
            var pasted = false
            if (try? text.write(toFile: file, atomically: false, encoding: .utf8)) != nil {
                let l = Shell.tmux(["load-buffer", "-b", buf, file])
                try? FileManager.default.removeItem(atPath: file)
                // -r keeps LF as LF (tmux would turn it into CR, which the prompt takes for Enter)
                if l.code == 0 { pasted = Shell.tmux(["paste-buffer", "-p", "-r", "-d", "-b", buf, "-t", pane]).code == 0 }
            }
            if !pasted {
                onWarning?("여러 줄 붙여넣기에 실패해 줄바꿈이 Enter로 처리될 수 있습니다.")
                keys(["-t", pane, "-l", "--", text], what: "메시지 입력")
            }
        } else {
            guard keys(["-t", pane, "-l", "--", text], what: "메시지 입력") else { SendLog.note("tmux \(pane): 글자 입력 실패"); return }
        }
        usleep(multilineSettle(text))
        waitPasted(pane, needText: true)
        keys(["-t", pane, "Enter"], what: "Enter")
        // the CLI can swallow that Enter while it turns pasted image paths into "[Image #n]" chips: the text then stayed
        // in its box, and every later send was refused as "someone is typing there". Check the box emptied; if not, again.
        for wait in [350_000, 700_000, 1_400_000] as [useconds_t] {
            usleep(wait)
            waitPasted(pane, needText: false)
            let raw = Shell.tmux(["capture-pane", "-p", "-e", "-t", pane, "-S", "-4"])
            guard raw.code == 0, Screen.typedInput(raw.out) else {
                // a slash command the CLI runs itself is not always written to history: only messages are checked
                guard !sid.isEmpty, !sid.hasPrefix("session-"), !text.hasPrefix("/") else { SendLog.note("tmux \(pane): Enter 후 입력창 비었음 (전송됨)"); return }
                if accepted(sid, history: mark, transcript: tmark, seconds: 6) { SendLog.note("tmux \(pane): CLI 기록에서 받은 것 확인 (전송됨)"); return }
                SendLog.note("tmux \(pane): 입력창은 비었지만 CLI가 받지 않음 — 입력창에 되돌림")
                onLost?(sid)
                return
            }
            SendLog.note("tmux \(pane): Enter 후에도 입력창에 글이 남음 — Enter 다시")
            keys(["-t", pane, "Enter"], what: "Enter (다시)")
        }
        SendLog.note("tmux \(pane): Enter를 3번 더 눌러도 입력창에 글이 남음")
    }
    /// Empties the CLI's input box (Ctrl+U removes one line of it at a time). Never Esc: that would stop a running turn.
    static func clearInput(_ pane: String) {
        enqueue(pane) { for _ in 0..<16 { keys(["-t", pane, "C-u"], what: "입력창 비우기"); usleep(40_000) } }
    }
    private static func multilineSettle(_ t: String) -> useconds_t { t.contains("\n") ? 150_000 : 60_000 }

    /// Slash command: clears any half-typed input first.
    static func command(_ cmd: String, to pane: String) { enqueue(pane) { commandNow(cmd, to: pane) } }
    private static func commandNow(_ cmd: String, to pane: String) {
        guard keys(["-t", pane, "C-u"], what: "\(cmd) 명령") else { return }
        usleep(40_000)
        sendNow(cmd, to: pane)
    }

    /// Esc; `settle` keeps the pane's queue busy afterwards so a following command waits for it.
    static func interrupt(_ pane: String, settle: TimeInterval = 0) {
        enqueue(pane) {
            keys(["-t", pane, "Escape"], what: "중단(Esc)")
            if settle > 0 { usleep(useconds_t(settle * 1e6)) }
        }
    }

    static func rename(_ name: String, pane: String) {
        let clean = name.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
        guard !clean.isEmpty else { return }
        command("/rename \(clean)", to: pane)
    }

    /// Returns [paneId: tmux session name].
    static func paneSessions() -> [String: String] { paneSessionsChecked() ?? [:] }
    /// nil when tmux timed out / could not be run (a missing server is a normal empty answer).
    static func paneSessionsChecked() -> [String: String]? {
        let r = Shell.tmux(["list-panes", "-a", "-F", "#{pane_id}\u{1f}#{session_name}"])
        if r.code == -1 { return nil }
        var out: [String: String] = [:]
        for line in r.out.split(separator: "\n") {
            let f = line.split(separator: "\u{1f}")
            if f.count == 2 { out[String(f[0])] = String(f[1]) }
        }
        return out
    }

    /// Returns [paneId: pid] for every pane in every tmux session.
    static func panes() -> [String: Int] { panesChecked() ?? [:] }
    static func panesChecked() -> [String: Int]? {
        let r = Shell.tmux(["list-panes", "-a", "-F", "#{pane_id}\u{1f}#{pane_pid}"])
        if r.code == -1 { return nil }
        var out: [String: Int] = [:]
        for line in r.out.split(separator: "\n") {
            let f = line.split(separator: "\u{1f}")
            if f.count == 2, let pid = Int(f[1]) { out[String(f[0])] = pid }
        }
        return out
    }
}

/// Background-collected tmux state. refresh() runs on the main thread; spawning tmux there
/// (list-panes, plus one capture-pane per session) made the UI stutter every tick.
enum TmuxCache {
    private static let lock = NSLock()
    private static var _panes: [String: Int] = [:]
    private static var _sessions: [String: String] = [:]
    private static var _busy: [String: Bool] = [:]
    private static var _input: [String: Bool] = [:]
    private static var _prompt: [String: PromptInfo] = [:]
    private static var _status: [String: ScreenStatus] = [:]     // spinner / done line / footer of the last capture
    private static var _overlay: [String: String] = [:]          // pane -> CLI screen covering the conversation ("agents" / "resume")
    private static var _typed: [String: Bool] = [:]              // pane -> text sits in the CLI's input box (someone is typing there)
    private static var _modelSentAt: [String: Date] = [:]     // pane -> when the app sent /model (a "Switch model?" prompt may follow)
    private static var _sentAt: [String: Date] = [:]
    private static var _wanted = Set<String>()
    private static var _extra = Set<String>()          // panes probed by hand (known only from a session file)
    private static var _startedAt = Date.distantPast
    private static var _at = Date.distantPast
    private static var running = false

    static var panes: [String: Int] { lock.lock(); defer { lock.unlock() }; return _panes }
    static var paneSessions: [String: String] { lock.lock(); defer { lock.unlock() }; return _sessions }
    /// State the screen shows: a prompt waiting for the user, a running turn, or idle; nil = never captured.
    static func state(_ pane: String) -> AgentState? {
        lock.lock(); defer { lock.unlock() }
        if _overlay[pane] != nil { return nil }                   // the screen is not the conversation: the session file decides
        guard let b = _busy[pane] else { return nil }
        return _input[pane] == true && !b ? .needsInput : (b ? .busy : .idle)
    }
    static func prompt(_ pane: String) -> PromptInfo? { lock.lock(); defer { lock.unlock() }; return _prompt[pane] }
    static func overlay(_ pane: String) -> String? { lock.lock(); defer { lock.unlock() }; return _overlay[pane] }
    /// Text in the CLI's input box that the board did not just type (someone else uses the same terminal).
    static func foreignTyped(_ pane: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard _typed[pane] == true else { return false }
        if let t = _sentAt[pane], Date().timeIntervalSince(t) < 3 { return false }
        return true
    }
    static func status(_ pane: String) -> ScreenStatus? { lock.lock(); defer { lock.unlock() }; return _status[pane] }
    static func busy(_ pane: String) -> Bool? { lock.lock(); defer { lock.unlock() }; return _busy[pane] }
    /// Only these panes (Claude sessions) get a capture-pane; empty = all (first run).
    static func setWanted(_ p: Set<String>) { lock.lock(); _wanted = p; lock.unlock() }
    /// The app just sent /model: a "Switch model?" confirmation in the next 20 s was caused by the user's own choice.
    /// Called (any thread) after the app answered the Switch-model window with Yes by itself.
    nonisolated(unsafe) static var onAutoConfirm: ((String) -> Void)?
    static func expectModelConfirm(_ pane: String) { lock.lock(); _modelSentAt[pane] = Date(); lock.unlock() }
    /// Text was just typed into the pane: it is busy now, whatever an older capture says.
    static func markSent(_ pane: String, busy: Bool) {
        lock.lock(); _sentAt[pane] = Date(); if busy { _busy[pane] = true }; lock.unlock()
    }
    /// True when the cached busy flag was captured after the last send settled: safe to type slash commands.
    static func isSettled(_ pane: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard _busy[pane] != nil else { return false }            // never captured: busy is unknown
        if _overlay[pane] != nil { return false }                 // a CLI list / picker covers the conversation
        if _typed[pane] == true, _sentAt[pane].map({ Date().timeIntervalSince($0) >= 3 }) ?? true { return false }   // someone is typing there
        guard let t = _sentAt[pane] else { return true }
        return Date().timeIntervalSince(t) > 2.0 && _startedAt > t
    }

    /// One-shot capture of a pane the periodic update never covers; keeps covering it afterwards. Blocking.
    @discardableResult static func probe(_ pane: String) -> Bool {
        let b = Shell.tmux(["capture-pane", "-p", "-t", pane, "-S", "-4"])
        guard b.code == 0 else { return false }
        lock.lock(); _extra.insert(pane); if _busy[pane] == nil { _busy[pane] = Screen.busy(b.out); _input[pane] = Screen.needsInput(b.out) }; lock.unlock()
        return true
    }

    /// Blocking (call off the main thread).
    @discardableResult
    static func update() -> Bool {
        lock.lock(); if running { lock.unlock(); return false }; running = true
        let started = Date(); _startedAt = started; let wanted = _wanted.union(_extra); lock.unlock()
        let wantAll = _wanted.isEmpty
        lock.lock(); let oldPanes = _panes, oldSessions = _sessions; lock.unlock()
        let p = TmuxControl.panesChecked() ?? oldPanes, s = TmuxControl.paneSessionsChecked() ?? oldSessions     // a timed-out list keeps the old map
        var b: [String: Bool] = [:], inp: [String: Bool] = [:], prm: [String: PromptInfo] = [:], sts: [String: ScreenStatus] = [:], failed = Set<String>()
        var ov: [String: String] = [:], ty: [String: Bool] = [:]
        for pane in p.keys where wantAll || wanted.contains(pane) {
            // with colours (-e): the CLI's suggestion differs from typed text only by being dim; everything else reads plain text
            let raw = Shell.tmux(["capture-pane", "-p", "-e", "-t", pane, "-S", "-4"])
            if raw.code == -1 { failed.insert(pane); continue }                  // timed out: keep what we knew
            let r = Shell.Result(code: raw.code, out: Screen.stripANSI(raw.out), err: raw.err)
            var stat = Screen.status(r.out); stat.suggestion = Screen.suggestion(raw.out)
            b[pane] = Screen.busy(r.out); inp[pane] = Screen.needsInput(r.out); prm[pane] = Screen.prompt(r.out); sts[pane] = stat
            ov[pane] = Screen.overlay(r.out); ty[pane] = Screen.typedInput(raw.out)
            // auto-yes ONLY to the exact "Switch model?" window, within 20 s of a /model the app sent itself
            lock.lock(); let sent = _modelSentAt[pane]; lock.unlock()
            if let sent, Date().timeIntervalSince(sent) < 20, Screen.isSwitchModelPrompt(r.out) {
                lock.lock(); _modelSentAt[pane] = nil; lock.unlock()
                TmuxControl.queue(pane) { TmuxControl.keys(["-t", pane, "Enter"], what: "모델 전환 확인(Enter)") }
                onAutoConfirm?(pane)
            } else if let sent, Date().timeIntervalSince(sent) >= 20 { lock.lock(); _modelSentAt[pane] = nil; lock.unlock() }
        }
        lock.lock()
        for pane in failed { b[pane] = _busy[pane]; inp[pane] = _input[pane]; prm[pane] = _prompt[pane]; sts[pane] = _status[pane]; ov[pane] = _overlay[pane]; ty[pane] = _typed[pane] }
        for (pane, t) in _sentAt {
            if t > started { b[pane] = _busy[pane] }                       // sent during this update: its capture predates the send
            else if Date().timeIntervalSince(t) < 1.5 { b[pane] = true }
        }   // claude has not drawn its footer yet
        _panes = p; _sessions = s; _busy = b; _input = inp; _prompt = prm; _status = sts; _overlay = ov; _typed = ty; _at = Date(); running = false
        lock.unlock()
        return true
    }
}
