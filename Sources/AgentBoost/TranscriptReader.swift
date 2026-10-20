import Foundation

/// Reads a session transcript incrementally: keeps a byte offset per file and
/// only parses lines appended since the last read.
final class TranscriptReader {
    struct Snapshot {
        var model: String?, effort: String?, last: Date?
        var customTitle: String?, aiTitle: String?
        var firstPrompt: String?     // the first thing the user asked: the CLI's /resume picker names untitled conversations by it
        var lastTurnEnded = false
        var tokens = TokenUsage()
        var lastContext = 0          // input + cache tokens of the newest assistant request: how full the context is
        var entries: [ChatEntry] = []
        var seenMessageIds = Set<String>()
        var offset: UInt64 = 0
        var entriesLoaded = false
        var truncated = false        // some entry text was cut (unfocused): a focused read re-parses
        var version = 0              // bumped whenever new lines were ingested: cheap change detection for the chat
    }
    private var files: [String: Snapshot] = [:]
    private let lock = NSLock()
    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f
    }()

    /// How much of a file the caller needs. `skip`: tokens/model only (ended, unfocused); `light`: entries with long
    /// text cut (unfocused, live); `full`: complete entries (the focused session).
    enum Mode: Int { case skip = 1, light = 2, full = 3 }
    static let lightLimit = 4096

    // Parsing happens outside the lock (the lock only guards the dictionaries). A file's first read never runs on the
    // main thread: the focused session gets its own immediate thread, the rest a small background queue; callers use
    // peek() (cached / tail-scanned metadata) until `done`.
    private var warming = Set<String>()
    private var levels: [String: Int] = [:]        // path -> Mode.rawValue reached (0 = never read)
    private var triedAt: [String: Date] = [:]
    private var tried: [String: String] = [:]      // path -> "size|mtime" of the last read attempt: unchanged = do not retry
    private var holdPaths = Set<String>()         // files whose reader scrolled up: keep older rows past the cap
    func setHoldCap(_ h: Bool, path: String) { lock.lock(); if h { holdPaths.insert(path) } else { holdPaths.remove(path) }; lock.unlock() }
    private var recentFull: [String] = []          // most recently focused files stay .full (re-focus must not re-parse)
    private let warmQueue: OperationQueue = {
        let q = OperationQueue(); q.maxConcurrentOperationCount = 2; q.qualityOfService = .utility; return q
    }()
    private static func stamp(_ path: String) -> String {
        let a = try? FileManager.default.attributesOfItem(atPath: path)
        return "\((a?[.size] as? NSNumber)?.intValue ?? -1)|\((a?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0)"
    }
    /// Keeps the last few focused files at .full.
    func effective(_ path: String, _ mode: Mode) -> Mode {
        lock.lock(); defer { lock.unlock() }
        if mode == .full { recentFull.removeAll { $0 == path }; recentFull.append(path); if recentFull.count > 5 { recentFull.removeFirst() }; return .full }
        return recentFull.contains(path) ? .full : mode
    }
    /// True when the file must be (re)parsed in the background first; callers use peek() meanwhile and `done` runs on main.
    func needsWarm(_ path: String, mode: Mode, done: @escaping () -> Void) -> Bool {
        let st = Self.stamp(path)
        lock.lock()
        if warming.contains(path) { lock.unlock(); return true }
        if (levels[path] ?? 0) >= mode.rawValue { lock.unlock(); return false }                       // loaded at this level
        // a failed try with the file unchanged: still not parsed here (the caller would parse on the main thread), but do
        // not retry a broken file more than every 30 s
        if tried[path] == st, let t = triedAt[path], Date().timeIntervalSince(t) < 30 { lock.unlock(); return true }
        warming.insert(path); lock.unlock()
        let work = { [self] in
            _ = snapshot(path, mode: mode)
            lock.lock(); warming.remove(path); tried[path] = st; triedAt[path] = Date(); lock.unlock()
            DispatchQueue.main.async { done() }
        }
        if mode == .full { DispatchQueue.global(qos: .userInitiated).async(execute: work) } else { warmQueue.addOperation(work) }
        return true
    }

    // MARK: metadata shown before a file is parsed (model, tokens of the previous run; model from the file tail)
    private struct Meta: Codable, Equatable { var model: String?, effort: String?, input = 0, cw = 0, cr = 0, out = 0, last: Double?, ctx: Int? }
    private var meta: [String: Meta] = [:]
    private var metaLoaded = false
    private static let metaURL = URL(fileURLWithPath: Shell.home + "/.agent-boost/transcript-meta.json")
    private var metaDirty = false
    private func loadMetaLocked() {
        if metaLoaded { return }
        metaLoaded = true
        if let d = try? Data(contentsOf: Self.metaURL), let m = try? JSONDecoder().decode([String: Meta].self, from: d) { meta = m }
    }
    private let saveQueue = DispatchQueue(label: "agentboost.meta-save", qos: .utility)
    private var saveScheduled = false
    /// Debounced (2 s) write on a serial queue; the newest meta is copied under the lock, vanished transcripts are dropped.
    private func saveMeta() {
        lock.lock()
        if saveScheduled { lock.unlock(); return }
        saveScheduled = true; lock.unlock()
        saveQueue.asyncAfter(deadline: .now() + 2) { [self] in
            lock.lock(); saveScheduled = false; let all = meta; let dirty = metaDirty; metaDirty = false; lock.unlock()
            guard dirty else { return }
            let live = all.filter { FileManager.default.fileExists(atPath: $0.key) }
            if live.count != all.count { lock.lock(); for k in all.keys where live[k] == nil { meta[k] = nil }; lock.unlock() }
            if let d = try? JSONEncoder().encode(live) { try? d.write(to: Self.metaURL, options: .atomic) }
        }
    }
    /// What can be shown while the file is not parsed yet: a finished snapshot, else the last run's numbers, else the file tail's model.
    func peek(_ path: String) -> Snapshot {
        lock.lock(); loadMetaLocked()
        if let f = files[path] { lock.unlock(); return f }
        var s = Snapshot()
        if let m = meta[path] {
            s.model = m.model; s.effort = m.effort; s.tokens = TokenUsage(input: m.input, cacheWrite: m.cw, cacheRead: m.cr, output: m.out)
            s.last = m.last.map { Date(timeIntervalSince1970: $0) }
            s.lastContext = m.ctx ?? 0
        }
        lock.unlock()
        if s.model == nil, let fh = FileHandle(forReadingAtPath: path) {          // last 64KB: the newest assistant record names the model
            defer { try? fh.close() }
            let size = (try? fh.seekToEnd()) ?? 0
            try? fh.seek(toOffset: size > 65536 ? size - 65536 : 0)
            let tail = String(decoding: fh.readDataToEndOfFile(), as: UTF8.self)
            for line in tail.split(separator: "\n").reversed() where line.contains("\"model\"") {
                if let d = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
                   let m = (d["message"] as? [String: Any])?["model"] as? String, m != "<synthetic>" { s.model = m; break }
            }
        }
        return s
    }

    func snapshot(_ path: String, mode: Mode) -> Snapshot {
        let wantEntries = mode != .skip
        lock.lock(); var st = files[path] ?? Snapshot(); lock.unlock()
        guard let fh = FileHandle(forReadingAtPath: path) else { return st }
        defer { try? fh.close() }
        let size = (try? fh.seekToEnd()) ?? 0
        if size < st.offset { st = Snapshot() }
        let needFull = (wantEntries && !st.entriesLoaded) || (mode == .full && st.truncated)
        if size == 0 && wantEntries { st.entriesLoaded = true }                                   // empty file = empty conversation
        if size > st.offset || (needFull && size > 0) {
            if needFull { st.offset = 0; st.seenMessageIds = []; st.tokens = TokenUsage(); st.entries = []; st.truncated = false }
            try? fh.seek(toOffset: st.offset)
            let data = fh.readDataToEndOfFile()
            var consumed = 0
            data.withUnsafeBytes { (buf: UnsafeRawBufferPointer) in
                var start = 0
                for i in 0..<buf.count where buf[i] == 0x0A {
                    let line = Data(buf[start..<i])
                    consumed = i + 1; start = i + 1
                    let before = st.entries.count
                    Self.ingest(line, into: &st, wantEntries: wantEntries)
                    if mode == .light {
                        for k in before..<st.entries.count where st.entries[k].text.utf8.count > Self.lightLimit {
                            st.entries[k].text = String(st.entries[k].text.prefix(Self.lightLimit)) + "…"; st.truncated = true
                        }
                    }
                }
            }
            st.offset += UInt64(consumed)
            if consumed > 0 { st.version &+= 1 }
            if wantEntries { st.entriesLoaded = true }
            else if consumed > 0 { st.entriesLoaded = false; st.entries = [] }               // lines went by unrecorded: rebuild on focus, no gap
        }
        lock.lock(); let hold = holdPaths.contains(path); lock.unlock()
        if st.entries.count > (hold ? 3000 : 600) { st.entries.removeFirst(st.entries.count - (hold ? 3000 : 600)) }     // one cap for every kind of entry
        let level = !st.entriesLoaded ? Mode.skip.rawValue : (st.truncated ? Mode.light.rawValue : Mode.full.rawValue)
        lock.lock(); files[path] = st; levels[path] = size == 0 ? Mode.full.rawValue : level
        let m = Meta(model: st.model, effort: st.effort, input: st.tokens.input, cw: st.tokens.cacheWrite, cr: st.tokens.cacheRead, out: st.tokens.output, last: st.last?.timeIntervalSince1970, ctx: st.lastContext)
        let changed = meta[path] != m
        if changed { meta[path] = m; metaDirty = true }
        lock.unlock()
        if changed { saveMeta() }
        return st
    }

    /// Splits Claude's relayed `<teammate-message teammate_id="…">…</teammate-message>` blocks;
    /// idle notifications become a short status line.
    static func teammateMessages(_ s: String) -> [(from: String, text: String)] {
        let re = try! NSRegularExpression(pattern: #"<teammate-message[^>]*teammate_id="([^"]+)"[^>]*>(.*?)</teammate-message>"#, options: [.dotMatchesLineSeparators])
        var out: [(String, String)] = []
        for m in re.matches(in: s, range: NSRange(s.startIndex..., in: s)) {
            guard let fr = Range(m.range(at: 1), in: s), let br = Range(m.range(at: 2), in: s) else { continue }
            var body = String(s[br]).trimmingCharacters(in: .whitespacesAndNewlines)
            if body.hasPrefix("{"), let d = body.data(using: .utf8), let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
                let kind = j["type"] as? String ?? ""
                let result = j["result"] as? String ?? j["message"] as? String ?? ""
                body = kind == "idle_notification" ? "⏸ 대기 중" + (result.isEmpty ? "" : " — " + result) : (result.isEmpty ? kind : result)
            }
            out.append((String(s[fr]), body))
        }
        return out
    }

    private static func tag(_ name: String, in s: String) -> String? {
        guard let a = s.range(of: "<\(name)>"), let b = s.range(of: "</\(name)>", range: a.upperBound..<s.endIndex) else { return nil }
        return String(s[a.upperBound..<b.lowerBound])
    }
    private static func stripANSI(_ s: String) -> String {
        s.replacingOccurrences(of: "\u{1B}\\[[0-9;?]*[A-Za-z]", with: "", options: .regularExpression)
    }
    /// A slash command the user ran (shown as their bubble) or its output (a small ⎿ line; stderr is a warning).
    private static func appendLocal(_ s: String, id: String, time: Date?, into st: inout Snapshot) {
        func add(_ e: ChatEntry) {
            if let l = st.entries.last, l.role == e.role, l.text == e.text, l.toolName == e.toolName { return }   // same record seen twice
            st.entries.append(e)
        }
        if let name = tag("command-name", in: s)?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
            let args = (tag("command-args", in: s) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            add(ChatEntry(id: id, role: .user, text: args.isEmpty ? name : name + " " + args, time: time))
        }
        for (t, kind) in [("local-command-stdout", "stdout"), ("local-command-stderr", "stderr")] {
            if let o = tag(t, in: s) {
                let text = stripANSI(o).trimmingCharacters(in: .whitespacesAndNewlines)
                if !text.isEmpty { add(ChatEntry(id: id + "-" + kind, role: .system, text: text, toolName: kind, time: time)) }
            }
        }
    }

    private static func noteSetting(_ c: String, into st: inout Snapshot) {
        let plain = stripANSI(c)
        if let m = plain.range(of: #"Set effort level to ([a-z]+)"#, options: .regularExpression) {
            st.effort = String(plain[m].split(separator: " ").last ?? "")
        }
        guard let r = plain.range(of: "Set model to") ?? plain.range(of: "Kept model as") else { return }
        let rest = plain[r.upperBound...].prefix(80)
        if let m = rest.range(of: #"claude-[a-z]+-[0-9][0-9a-z\-\[\]]*"#, options: .regularExpression) { st.model = String(rest[m]); return }
        // display name ("`Sonnet 5.5 (default)`"): the model it names
        let low = rest.lowercased()
        if let c = ModelChoice.allCases.first(where: { low.contains($0.label.lowercased()) }) { st.model = c.rawValue }
    }
    /// The newest answer: the assistant's text since my last message, read from the file's tail (on demand, ~1 ms).
    static func lastAnswer(_ path: String) -> String { recentAnswers(path, count: 1).first?.answer ?? "" }
    /// The last `count` answers, newest first, each with the message it answers. Read only when asked (a button press):
    /// the file's last 600 KB, or 4 MB when long tool outputs left fewer turns than asked for in that.
    static func recentAnswers(_ path: String, count: Int) -> [(asked: String, answer: String)] {
        guard let fh = FileHandle(forReadingAtPath: path) else { return [] }
        defer { try? fh.close() }
        let size = (try? fh.seekToEnd()) ?? 0
        var out: [(asked: String, answer: String)] = []
        for window in [UInt64(600_000), 4_000_000] {
            try? fh.seek(toOffset: size > window ? size - window : 0)
            let lines = String(decoding: fh.readDataToEndOfFile(), as: UTF8.self).split(separator: "\n")
            out = []
            var parts: [String] = []
            for l in lines.reversed() {
                guard let d = try? JSONSerialization.jsonObject(with: Data(l.utf8)) as? [String: Any], let type = d["type"] as? String,
                      let msg = d["message"] as? [String: Any] else { continue }
                // my message: the answer starts after it. A slash command's records (<command-name>, <local-command-stdout>, …)
                // are user records too; a /model run after the answer made the answer look empty, so they are passed over.
                // So is the summary a compaction leaves: it read as my message with no answer after it.
                // A message with images is a list of blocks (text + image), not a string: it counts too.
                if type == "user", (d["isMeta"] as? Bool) != true, (d["isCompactSummary"] as? Bool) != true {
                    let c = (msg["content"] as? String)
                        ?? (msg["content"] as? [[String: Any]])?.first { $0["type"] as? String == "text" }.flatMap { $0["text"] as? String }
                    guard let c, !c.hasPrefix("<") else { continue }
                    if !parts.isEmpty { out.append((unwrapPaste(c), parts.reversed().joined(separator: "\n\n"))) }
                    parts = []
                    if out.count >= count { return out }
                    continue
                }
                guard type == "assistant", let blocks = msg["content"] as? [[String: Any]] else { continue }
                for b in blocks.reversed() where (b["type"] as? String) == "text" { if let t = b["text"] as? String, !t.isEmpty { parts.append(t) } }
            }
            if !parts.isEmpty, out.count < count { out.append(("", parts.reversed().joined(separator: "\n\n"))) }   // the window began mid-answer
            if size <= window { break }
        }
        return out
    }
    /// Pasted text is recorded inside <pasted_content id="…"> … </pasted_content id="…"> marks: show only the text.
    static func unwrapPaste(_ s: String) -> String {
        var s = s
        if s.contains("pasted_content") {
            s = s.replacingOccurrences(of: #"<[/\\]?pasted_content[^>]*>\n?"#, with: "", options: .regularExpression)
        }
        // "[첨부 파일]" lists (the board's, or one pasted inside a message): images became "[Image #n]" elsewhere, leaving bare
        // "-" lines; files keep a path. Each list becomes "📎 name" lines, or nothing.
        while let r = s.range(of: "[첨부 파일]\n") {
            var end = r.upperBound
            var names: [String] = []
            while end < s.endIndex, s[end] == "-" {
                let lineEnd = s[end...].firstIndex(of: "\n") ?? s.endIndex
                let item = s[s.index(after: end)..<lineEnd].trimmingCharacters(in: .whitespaces)
                if !item.isEmpty { names.append("📎 " + (item.split(separator: "/").last.map(String.init) ?? item)) }
                end = lineEnd < s.endIndex ? s.index(after: lineEnd) : lineEnd
            }
            var start = r.lowerBound
            while start > s.startIndex, s[s.index(before: start)] == "\n" { start = s.index(before: start) }
            s.replaceSubrange(start..<end, with: names.isEmpty ? "\n" : "\n" + names.joined(separator: "\n") + "\n")
        }
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    /// A message typed while a tool ran is recorded once as queued; if the user then interrupts, the CLI submits it again
    /// on a new branch. Keep only the later copy. The CLI's own "[Request interrupted …]" record is a notice, not my words.
    private static func addUser(_ text: String, id: String, time: Date?, into st: inout Snapshot) {
        if text.hasPrefix("[Request interrupted") {
            st.entries.append(ChatEntry(id: id, role: .system, text: text.contains("tool use") ? "중단됨 — 도구 실행을 멈췄습니다" : "중단됨", toolName: "auto", time: time))
            return
        }
        if let t = time, let k = st.entries.indices.suffix(30).last(where: {
            st.entries[$0].role == .user && st.entries[$0].text == text && t.timeIntervalSince(st.entries[$0].time ?? .distantPast) < 120
        }) { st.entries.remove(at: k) }
        st.entries.append(ChatEntry(id: id, role: .user, text: text, time: time))
    }
    private static func ingest(_ line: Data, into st: inout Snapshot, wantEntries: Bool) {
        guard let d = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
              let type = d["type"] as? String else { return }
        if type == "custom-title", let t = d["customTitle"] as? String { st.customTitle = t; return }
        if type == "ai-title", let t = d["aiTitle"] as? String { st.aiTitle = t; return }
        // a message typed while a turn runs and taken in mid-turn ("absorbed_mid_turn") gets no user record, only this
        // attachment: without it the message vanished from the chat once its "전송 중" row expired
        if type == "attachment", let a = d["attachment"] as? [String: Any], a["type"] as? String == "queued_command" {
            guard wantEntries, (a["commandMode"] as? String ?? "prompt") == "prompt" else { return }
            let p = (a["prompt"] as? String)
                ?? (a["prompt"] as? [[String: Any]])?.compactMap { $0["type"] as? String == "text" ? $0["text"] as? String : nil }.joined(separator: "\n")
            if let p, !p.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !p.hasPrefix("<") {
                Self.addUser(Self.unwrapPaste(p), id: (d["uuid"] as? String) ?? UUID().uuidString,
                             time: (d["timestamp"] as? String).flatMap(iso.date(from:)), into: &st)
            }
            return
        }
        // "/effort low" → "Set effort level to low …", "/model …" → "Set model to … (claude-…)": the session changed now,
        // long before the next assistant record carries the new value
        if type == "system", (d["subtype"] as? String) == "local_command", let c = d["content"] as? String { noteSetting(c, into: &st) }
        if type == "user", let c = (d["message"] as? [String: Any])?["content"] as? String, c.contains("<local-command-stdout>") { noteSetting(c, into: &st) }
        if type == "system", wantEntries, (d["subtype"] as? String) == "local_command", let c = d["content"] as? String {
            Self.appendLocal(c, id: (d["uuid"] as? String) ?? UUID().uuidString, time: (d["timestamp"] as? String).flatMap(iso.date(from:)), into: &st)
            return
        }
        guard type == "user" || type == "assistant",
              let msg = d["message"] as? [String: Any] else { return }
        let ts = (d["timestamp"] as? String).flatMap(iso.date(from:))
        let uuid = (d["uuid"] as? String) ?? UUID().uuidString
        st.lastTurnEnded = type == "assistant" && (msg["stop_reason"] as? String) == "end_turn"
        if type == "user", st.firstPrompt == nil, (d["isMeta"] as? Bool) != true {
            let raw = (msg["content"] as? String) ?? (msg["content"] as? [[String: Any]])?.first { $0["type"] as? String == "text" }.flatMap { $0["text"] as? String }
            if let r = raw.map(Self.unwrapPaste), !r.hasPrefix("<"), !r.hasPrefix("/"),
               let first = r.split(separator: "\n").map({ $0.trimmingCharacters(in: .whitespaces) }).first(where: { !$0.isEmpty }) { st.firstPrompt = first }
        }
        if type == "assistant" {
            if let m = msg["model"] as? String, m != "<synthetic>" { st.model = m }
            if let e = d["effort"] as? String { st.effort = e }
            st.last = ts ?? st.last
            let mid = (msg["id"] as? String) ?? (d["requestId"] as? String) ?? uuid
            if !st.seenMessageIds.contains(mid), let u = msg["usage"] as? [String: Any] {
                st.seenMessageIds.insert(mid)
                st.tokens.input += u["input_tokens"] as? Int ?? 0
                st.tokens.cacheWrite += u["cache_creation_input_tokens"] as? Int ?? 0
                st.tokens.cacheRead += u["cache_read_input_tokens"] as? Int ?? 0
                st.tokens.output += u["output_tokens"] as? Int ?? 0
                st.lastContext = (u["input_tokens"] as? Int ?? 0) + (u["cache_creation_input_tokens"] as? Int ?? 0) + (u["cache_read_input_tokens"] as? Int ?? 0)
            }
        }
        guard wantEntries else { return }
        if (d["isMeta"] as? Bool) == true { return }
        if let s = msg["content"] as? String {
            // slash commands and their output become a user line / small ⎿ lines (appendLocal)
            if s.hasPrefix("<command-name>") || s.hasPrefix("<local-command") || s.hasPrefix("<command-message>") {
                if !s.hasPrefix("<local-command-caveat>") {
                    Self.appendLocal(s, id: uuid, time: ts, into: &st)
                }
                return
            }
            if type == "user", s.contains("<teammate-message") {
                for (i, m) in Self.teammateMessages(s).enumerated() {
                    st.entries.append(ChatEntry(id: "\(uuid)-tm\(i)", role: .peer, text: m.text, toolName: m.from, time: ts))
                }
                return
            }
            if type == "user", !s.isEmpty {
                Self.addUser(Self.unwrapPaste(s), id: uuid, time: ts, into: &st)
            }
            return
        }
        guard let blocks = msg["content"] as? [[String: Any]] else { return }
        for (i, b) in blocks.enumerated() {
            let bid = "\(uuid)-\(i)"
            switch b["type"] as? String {
            case "text" where type == "user" && ((b["text"] as? String)?.contains("<teammate-message") ?? false):
                for (k, m) in Self.teammateMessages(b["text"] as! String).enumerated() {
                    st.entries.append(ChatEntry(id: "\(bid)-tm\(k)", role: .peer, text: m.text, toolName: m.from, time: ts))
                }
            case "text":
                if let t = b["text"] as? String, !t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    if type == "user" { Self.addUser(Self.unwrapPaste(t), id: bid, time: ts, into: &st) }
                    else { st.entries.append(ChatEntry(id: bid, role: .assistant, text: t, time: ts)) }
                }
            case "thinking":
                if let t = b["thinking"] as? String, !t.isEmpty {
                    st.entries.append(ChatEntry(id: bid, role: .assistant, text: t, time: ts, isThinking: true))
                }
            case "tool_use":
                let name = b["name"] as? String ?? "tool"
                var summary = ""
                if let input = b["input"] as? [String: Any] {
                    summary = (input["command"] as? String) ?? (input["file_path"] as? String)
                        ?? (input["description"] as? String) ?? (input["prompt"] as? String) ?? ""
                }
                st.entries.append(ChatEntry(id: bid, role: .tool, text: summary, toolName: name, time: ts))
            case "tool_result":
                var text = ""
                if let s = b["content"] as? String { text = s }
                else if let arr = b["content"] as? [[String: Any]] {
                    text = arr.compactMap { $0["text"] as? String }.joined(separator: "\n")
                }
                text = text.trimmingCharacters(in: .whitespacesAndNewlines)
                if !text.isEmpty {
                    let head = text.prefix(80).lowercased()
                    let failed = (b["is_error"] as? Bool) == true || head.hasPrefix("error") || head.hasPrefix("fatal") || head.contains("denied") && head.count < 80 && !head.contains("\n") && head.hasPrefix("permission")
                    st.entries.append(ChatEntry(id: bid, role: .tool, text: String(text.prefix(1200)), toolName: "결과", time: ts, isError: failed))
                }
            default: break
            }
        }
    }
}
