import SwiftUI
import AppKit

// MARK: - prompt history (~/.claude/history.jsonl)

/// Every prompt the user ever typed into a Claude Code session, as the CLI records it (newest last).
/// Feeds the ↑/↓ history of the composer and the inline completion ("fish"-style ghost text).
final class PromptHistory {
    static let shared = PromptHistory()
    struct Item: Equatable { var text: String; var at: Date; var sessionId: String?; var project: String? }
    private var items: [Item] = []
    private var stamp = ""
    private var loading = false
    private let lock = NSLock()
    private static let path = Shell.home + "/.claude/history.jsonl"
    private static func stamp() -> String {
        let a = try? FileManager.default.attributesOfItem(atPath: path)
        return "\((a?[.size] as? NSNumber)?.intValue ?? -1)|\((a?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0)"
    }
    /// Everything the composer needs from the history, prepared off the main thread: a completer (shared by every
    /// composer, rebuilt only when the file changes) and the ↑/↓ list for one session. Calls back on main.
    private var shared: (stamp: String, completer: HistoryCompleter)?
    func prepare(sessionId: String, cwd: String?, _ done: @escaping (HistoryCompleter, [String]) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            let now = Self.stamp()
            lock.lock(); let fresh = stamp == now ? items : nil; lock.unlock()
            let all = fresh ?? Self.parse()
            lock.lock(); if fresh == nil { items = all; stamp = now }
            var c = shared?.stamp == now ? shared?.completer : nil
            lock.unlock()
            if c == nil { let n = HistoryCompleter(); n.set(all); c = n; lock.lock(); shared = (now, n); lock.unlock() }
            let nav = Self.navigation(all, sessionId: sessionId, cwd: cwd)
            DispatchQueue.main.async { done(c!, nav) }
        }
    }
    /// Cached items at once; a changed file is re-read in the background and handed back on main.
    func load(_ completion: @escaping ([Item]) -> Void) {
        lock.lock(); let cur = items, st = stamp, busy = loading; lock.unlock()
        completion(cur)
        let now = Self.stamp()
        guard now != st, !busy else { return }
        lock.lock(); loading = true; lock.unlock()
        DispatchQueue.global(qos: .utility).async { [self] in
            let parsed = Self.parse()
            lock.lock(); items = parsed; stamp = now; loading = false; lock.unlock()
            DispatchQueue.main.async { completion(parsed) }
        }
    }
    /// Only the file's tail is parsed (the last ~600 KB: a few thousand prompts), newest last.
    private static func parse() -> [Item] {
        guard let fh = FileHandle(forReadingAtPath: path) else { return [] }
        defer { try? fh.close() }
        let size = (try? fh.seekToEnd()) ?? 0
        let limit: UInt64 = 600_000
        try? fh.seek(toOffset: size > limit ? size - limit : 0)
        let data = fh.readDataToEndOfFile()
        var out: [Item] = []
        for line in data.split(separator: 0x0A) {
            guard let d = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any],
                  let t = d["display"] as? String, !t.isEmpty else { continue }
            let ts = (d["timestamp"] as? Double).map { Date(timeIntervalSince1970: $0 / 1000) } ?? .distantPast
            out.append(Item(text: t, at: ts, sessionId: d["sessionId"] as? String, project: d["project"] as? String))
        }
        if out.count > 3000 { out.removeFirst(out.count - 3000) }
        return out
    }

    /// Prompts for ↑/↓: this session first, then the same folder, then everything — newest first, no repeats.
    static func navigation(_ all: [Item], sessionId: String, cwd: String?) -> [String] {
        var seen = Set<String>(), out: [String] = []
        func take(_ pred: (Item) -> Bool) {
            for it in all.reversed() where pred(it) {
                let t = it.text
                if t.count > 4000 { continue }
                if seen.insert(t).inserted { out.append(t) }
            }
        }
        take { $0.sessionId == sessionId }
        if let cwd { take { $0.project == cwd } }
        take { _ in true }
        return Array(out.prefix(500))
    }
}

/// Prefix completion over the prompt history, cheap enough to run on every keystroke: the candidates are lowercased
/// once when the history loads, and while the user keeps typing the same word only the previous matches are searched.
final class HistoryCompleter {
    private struct Cand { var lower: String; var text: String; var project: String? }
    private var cands: [Cand] = []                 // newest first, one line, no repeats
    private var lastPrefix = ""
    private var lastMatches: [Int] = []
    private var lastAnswer: (key: String, value: String?)?
    func set(_ items: [PromptHistory.Item]) {
        var seen = Set<String>(), out: [Cand] = []
        for it in items.reversed() {
            let t = it.text
            guard t.count <= 300, !t.contains("\n"), seen.insert(t).inserted else { continue }
            out.append(Cand(lower: t.lowercased(), text: t, project: it.project))
        }
        cands = out; lastPrefix = ""; lastMatches = []; lastAnswer = nil
    }
    /// Newest earlier prompt that begins with what was typed (≥ 2 characters, one line, longer than the typed text);
    /// the same folder wins over others.
    func complete(_ prefix: String, cwd: String?) -> String? {
        guard prefix.count >= 2, !prefix.contains("\n"), !cands.isEmpty else { return nil }
        let key = prefix + "\u{1f}" + (cwd ?? "")
        if let a = lastAnswer, a.key == key { return a.value }           // the view asks several times per keystroke
        let p = prefix.lowercased()
        let base = !lastPrefix.isEmpty && p.hasPrefix(lastPrefix) ? lastMatches : Array(cands.indices)
        let pu = Array(p.utf8)
        let matches = base.filter { i in let l = cands[i].lower.utf8; return l.count > pu.count && l.starts(with: pu) }   // bytes: no Unicode work per item
        lastPrefix = p; lastMatches = matches
        let pick = matches.first { cwd != nil && cands[$0].project == cwd } ?? matches.first
        let value = pick.map { cands[$0].text }
        lastAnswer = (key, value)
        return value
    }
}

// MARK: - next-step suggestion from the conversation

/// What the user most likely wants to type next, read off the end of the conversation (the CLI shows its
/// own suggestion the same way: dimmed in the box, Tab fills it). Only offered when the turn is over.
enum Suggest {
    /// Same conversation tail and state as the last call: same answer (the composer asks on every keystroke).
    nonisolated(unsafe) private static var memo: (key: String, value: String?)?
    static func next(entries: [ChatEntry], agent: Agent) -> String? {
        guard agent.state == .idle, agent.canReceiveInput else { return nil }
        let key = "\(agent.sessionId)|\(entries.count)|\(entries.last?.id ?? "")|\(entries.last?.toolName ?? "")"
        if let m = memo, m.key == key { return m.value }
        let v = compute(entries: entries)
        memo = (key, v)
        return v
    }
    private static func compute(entries: [ChatEntry]) -> String? {
        // the turn must have ended with the agent speaking (nothing of mine after it, nothing still being sent)
        guard let lastIdx = entries.lastIndex(where: { $0.role == .user || ($0.role == .assistant && !$0.isThinking) || $0.role == .tool }),
              entries[lastIdx].role != .user, !entries.contains(where: { $0.toolName == "전송 중" }) else { return nil }
        let tail = entries.suffix(12)
        if let last = tail.last(where: { $0.role == .assistant && !$0.isThinking }) {
            let text = last.text.trimmingCharacters(in: .whitespacesAndNewlines)
            let lines = text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            let end = lines.suffix(4).joined(separator: " ")
            let asks = end.hasSuffix("?") || end.hasSuffix("？") || ["할까요", "드릴까요", "할까", "원하시면", "원하면", "괜찮을까요", "진행할까요", "Should I", "Would you like", "Do you want", "Shall I", "Want me to", "Let me know"].contains { end.contains($0) }
            let numbered = lines.filter { $0.range(of: #"^\d+[.)]\s"#, options: .regularExpression) != nil }.count >= 2
            if asks {
                if numbered { return "1번으로 진행해 주세요" }
                let low = end.lowercased()
                if low.contains("커밋") || low.contains("commit") { return "네, 커밋해 주세요" }
                if low.contains("테스트") || low.contains("test") { return "네, 테스트까지 돌려 주세요" }
                if low.contains("삭제") || low.contains("지울까") || low.contains("delete") || low.contains("remove") { return "네, 지워 주세요" }
                return "네, 그렇게 진행해 주세요"
            }
            if lines.count >= 8, tail.contains(where: { $0.role == .tool && $0.toolName != "결과" }) { return "변경한 내용을 한 번 더 점검하고 문제 없으면 마무리해 주세요" }
        }
        if let t = tail.last(where: { $0.role == .tool }), t.isError, tail.last?.role == .tool { return "오류 원인을 찾아 고쳐 주세요" }
        return nil
    }
}

// MARK: - "@" file mention

/// Files under the agent's folder for the "@" palette (relative paths, cached per folder).
enum FileIndex {
    private static var cache: [String: (at: Date, items: [String])] = [:]
    private static let lock = NSLock()
    private static let skip: Set<String> = ["node_modules", ".git", ".build", "build", "dist", "target", "Pods", "DerivedData", ".next", "__pycache__", ".venv", "venv", ".DS_Store"]
    static func cached(_ cwd: String) -> [String]? { lock.lock(); defer { lock.unlock() }; return cache[cwd]?.items }
    static func load(_ cwd: String, completion: @escaping ([String]) -> Void) {
        lock.lock(); let hit = cache[cwd]; lock.unlock()
        if let hit, Date().timeIntervalSince(hit.at) < 30 { completion(hit.items); return }
        DispatchQueue.global(qos: .utility).async {
            let items = scan(cwd)
            lock.lock(); cache[cwd] = (Date(), items); lock.unlock()
            DispatchQueue.main.async { completion(items) }
        }
    }
    private static func scan(_ cwd: String) -> [String] {
        let root = URL(fileURLWithPath: cwd)
        guard let en = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.isDirectoryKey, .isPackageKey], options: [.skipsHiddenFiles, .skipsPackageDescendants]) else { return [] }
        var out: [String] = []
        let base = root.standardizedFileURL.path + "/"
        for case let u as URL in en {
            let name = u.lastPathComponent
            let isDir = (try? u.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory ?? false
            if isDir && (skip.contains(name) || en.level >= 7) { en.skipDescendants(); if skip.contains(name) { continue } }
            if skip.contains(name) { continue }
            let p = u.standardizedFileURL.path
            guard p.hasPrefix(base) else { continue }
            out.append(String(p.dropFirst(base.count)) + (isDir ? "/" : ""))
            if out.count >= 6000 { break }
        }
        return out.sorted { ($0.count, $0) < ($1.count, $1) }
    }
    /// Basename prefix first, then path substring, then a loose subsequence; shorter paths win ties.
    static func filter(_ all: [String], query: String, limit: Int = 14) -> [String] {
        let q = query.lowercased()
        if q.isEmpty { return Array(all.prefix(limit)) }
        func score(_ p: String) -> Int? {
            let l = p.lowercased()
            let base = (l.hasSuffix("/") ? String(l.dropLast()) : l).split(separator: "/").last.map(String.init) ?? l
            if base.hasPrefix(q) { return 0 }
            if base.contains(q) { return 1 }
            if l.contains(q) { return 2 }
            guard q.count >= 3 else { return nil }
            var it = l.makeIterator()
            return q.allSatisfy({ ch in while let x = it.next() { if x == ch { return true } }; return false }) ? 3 : nil
        }
        var scored: [(path: String, rank: Int)] = []
        for p in all { if let r = score(p) { scored.append((p, r)) } }
        scored.sort { a, b in a.rank != b.rank ? a.rank < b.rank : a.path.count < b.path.count }
        return scored.prefix(limit).map(\.path)
    }
}

/// State of the "@" palette: the trailing "@word" of the draft is the query; Tab/Enter replace it with "@path ".
@MainActor final class MentionController: ObservableObject {
    @Published var index = 0
    @Published private(set) var files: [String] = []
    @Published private(set) var dismissedFor: String?
    private var loadedCwd: String?
    private var wantCwd: String?
    /// Only remembers the folder: the scan runs when "@" is first typed. Scanning on every open cost the main thread a
    /// 6000-item publish, and a session working in "/" or ~ walked into Desktop / Documents (macOS permission popups).
    func reload(cwd: String?) {
        if wantCwd != cwd { files = []; loadedCwd = nil }
        wantCwd = cwd
    }
    private func loadIfNeeded() {
        guard let cwd = wantCwd, !cwd.isEmpty, loadedCwd != cwd else { return }
        loadedCwd = cwd
        let home = Shell.home
        let p = URL(fileURLWithPath: cwd).standardizedFileURL.path
        if p == "/" || p == home || p == "/Users" { return }          // too broad to list (and holds protected folders)
        if let c = FileIndex.cached(cwd) { files = c }
        FileIndex.load(cwd) { [weak self] items in if self?.loadedCwd == cwd { self?.files = items } }
    }
    /// The "@…" token being typed at the end of the draft (preceded by start / whitespace).
    func token(_ draft: String) -> Range<String.Index>? {
        guard let at = draft.lastIndex(of: "@") else { return nil }
        if at > draft.startIndex, !draft[draft.index(before: at)].isWhitespace { return nil }
        let rest = draft[draft.index(after: at)...]
        guard !rest.contains(where: \.isWhitespace) else { return nil }
        return at..<draft.endIndex
    }
    func items(for draft: String) -> [String] {
        guard dismissedFor != draft, let r = token(draft) else { return [] }
        if loadedCwd != wantCwd { DispatchQueue.main.async { self.loadIfNeeded() } }
        return FileIndex.filter(files, query: String(draft[draft.index(after: r.lowerBound)..<r.upperBound]))
    }
    func dismiss(_ draft: String) { dismissedFor = draft }
    func pick(_ path: String, draft: Binding<String>) {
        guard let r = token(draft.wrappedValue) else { return }
        draft.wrappedValue.replaceSubrange(r, with: "@" + path + (path.hasSuffix("/") ? "" : " "))
        index = 0
    }
    /// Returns true when the key was consumed.
    func handle(_ ev: NSEvent, draft: Binding<String>) -> Bool {
        let list = items(for: draft.wrappedValue)
        guard !list.isEmpty else { return false }
        let i = min(index, list.count - 1)
        switch ev.keyCode {
        case 125: index = (i + 1) % list.count; return true
        case 126: index = (i - 1 + list.count) % list.count; return true
        case 53: dismiss(draft.wrappedValue); return true
        case 48 where !ev.modifierFlags.contains(.shift): pick(list[i], draft: draft); return true
        case 36, 76:
            if ev.modifierFlags.contains(.shift) { return false }
            pick(list[i], draft: draft); return true
        default: return false
        }
    }
}

struct MentionPaletteView: View {
    @ObservedObject var ctl: MentionController
    @Binding var draft: String
    var body: some View {
        let list = ctl.items(for: draft)
        if !list.isEmpty {
            let sel = min(ctl.index, list.count - 1)
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(spacing: 1) {
                        ForEach(Array(list.enumerated()), id: \.element) { i, p in
                            row(p, selected: i == sel).id(p).onTapGesture { ctl.pick(p, draft: $draft) }
                        }
                    }.padding(5)
                }
                .onChange(of: sel) { _, _ in if sel < list.count { proxy.scrollTo(list[sel]) } }
            }
            .frame(maxWidth: 560).frame(height: min(CGFloat(list.count) * 28 + 10, 250))
            .background(RoundedRectangle(cornerRadius: 6).fill(Theme.panel))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(Theme.lineHi))
            .onChange(of: list.count) { _, n in if ctl.index >= n { ctl.index = max(0, n - 1) } }
            .onChange(of: draft) { _, _ in ctl.index = 0 }
        }
    }
    private func row(_ p: String, selected: Bool) -> some View {
        HStack(spacing: 8) {
            Image(systemName: p.hasSuffix("/") ? "folder" : "doc.text").font(.caption).foregroundStyle(selected ? Color.white : Color.secondary)
            Text(p).font(.system(.callout, design: .monospaced)).foregroundStyle(selected ? Color.white : Color.primary.opacity(0.85)).lineLimit(1).truncationMode(.middle)
            Spacer(minLength: 4)
        }
        .padding(.horizontal, 8).frame(height: 27)
        .background(RoundedRectangle(cornerRadius: 6).fill(selected ? AnyShapeStyle(Theme.accentGrad) : AnyShapeStyle(Color.clear)))
        .contentShape(Rectangle())
    }
}

// MARK: - ↑/↓ history of the composer

/// Walks earlier prompts into the draft (↑ older, ↓ newer; past the newest the typed text comes back).
struct HistoryNav {
    var items: [String] = []        // newest first
    var pos = -1                    // -1: not browsing
    var saved = ""
    var active: Bool { pos >= 0 }
    mutating func up(_ draft: inout String) -> Bool {
        guard pos + 1 < items.count else { return !items.isEmpty }
        if pos < 0 { saved = draft }
        pos += 1; draft = items[pos]; return true
    }
    mutating func down(_ draft: inout String) -> Bool {
        guard pos >= 0 else { return false }
        pos -= 1
        draft = pos >= 0 ? items[pos] : saved
        return true
    }
    /// The user edited the text: stop browsing.
    mutating func noteEdit(_ draft: String) { if pos >= 0, draft != items[pos] { pos = -1 } }
    mutating func cancel(_ draft: inout String) { guard pos >= 0 else { return }; pos = -1; draft = saved }
}
