import SwiftUI
import AppKit

/// Every recorded conversation (~/.claude/projects/*/*.jsonl), reduced to my messages and the agents' answers, for search.
/// The first search reads all files; later ones read only what was appended since.
final class ConvoIndex: @unchecked Sendable {
    static let shared = ConvoIndex()
    struct Msg { let user: Bool; let time: Date?; let text: String; let low: String }
    struct File { var sid: String; var project: String; var offset: UInt64 = 0; var title: String?; var msgs: [Msg] = [] }
    private var files: [String: File] = [:]
    private let lock = NSLock()

    func snapshot() -> [File] { lock.lock(); defer { lock.unlock() }; return Array(files.values) }

    func refresh() {
        let root = NSHomeDirectory() + "/.claude/projects"
        let fm = FileManager.default
        var seen = Set<String>()
        for d in (try? fm.contentsOfDirectory(atPath: root)) ?? [] {
            for f in (try? fm.contentsOfDirectory(atPath: root + "/" + d)) ?? [] where f.hasSuffix(".jsonl") {
                let p = root + "/" + d + "/" + f
                seen.insert(p)
                lock.lock()
                var file = files[p] ?? File(sid: String(f.dropLast(6)), project: d)
                lock.unlock()
                read(p, into: &file)
                lock.lock(); files[p] = file; lock.unlock()
            }
        }
        lock.lock(); files = files.filter { seen.contains($0.key) }; lock.unlock()
    }

    /// Appends the records written after `offset` (up to the last full line).
    private func read(_ path: String, into f: inout File) {
        guard let fh = FileHandle(forReadingAtPath: path) else { return }
        defer { try? fh.close() }
        let end = (try? fh.seekToEnd()) ?? 0
        if end < f.offset { f = File(sid: f.sid, project: f.project) }       // rewritten: start over
        guard end > f.offset else { return }
        try? fh.seek(toOffset: f.offset)
        let data = fh.readDataToEndOfFile()
        guard let last = data.lastIndex(of: 0x0A) else { return }
        f.offset += UInt64(last - data.startIndex + 1)
        let iso = ISO8601DateFormatter(); iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        for line in data[data.startIndex...last].split(separator: 0x0A) {
            // cheap byte checks first: tool output and thinking are most of the file and never searched
            let s = String(decoding: line, as: UTF8.self)
            if s.contains("\"custom-title\"") || s.contains("\"ai-title\"") {
                if let d = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any] {
                    if let t = d["customTitle"] as? String { f.title = t } else if f.title == nil, let t = d["aiTitle"] as? String { f.title = t }
                }
                continue
            }
            let user = s.contains("\"type\":\"user\"")
            guard (user && !s.contains("\"tool_use_id\"")) || (s.contains("\"type\":\"assistant\"") && s.contains("\"type\":\"text\"")) else { continue }
            guard let d = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any], let type = d["type"] as? String,
                  let msg = d["message"] as? [String: Any], (d["isMeta"] as? Bool) != true, (d["isCompactSummary"] as? Bool) != true else { continue }
            let time = (d["timestamp"] as? String).flatMap { iso.date(from: $0) }
            var text = ""
            if type == "user" {
                let c = (msg["content"] as? String)
                    ?? (msg["content"] as? [[String: Any]])?.first { $0["type"] as? String == "text" }.flatMap { $0["text"] as? String }
                guard let c, !c.hasPrefix("<") else { continue }
                text = TranscriptReader.unwrapPaste(c)
            } else if type == "assistant", let blocks = msg["content"] as? [[String: Any]] {
                text = blocks.compactMap { $0["type"] as? String == "text" ? $0["text"] as? String : nil }.joined(separator: "\n\n")
            }
            text = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { continue }
            f.msgs.append(Msg(user: type == "user", time: time, text: text, low: text.lowercased()))
        }
    }

    struct Hit: Identifiable { let id: String; let file: File; let index: Int }
    /// Messages holding every word of the query, newest first.
    func search(_ q: String, limit: Int = 300) -> [Hit] {
        let words = q.lowercased().split(separator: " ").map(String.init)
        guard !words.isEmpty else { return [] }
        var out: [Hit] = []
        for f in snapshot() {
            for (i, m) in f.msgs.enumerated() where words.allSatisfy({ m.low.contains($0) }) {
                out.append(Hit(id: f.sid + "#\(i)", file: f, index: i))
            }
        }
        out.sort { ($0.file.msgs[$0.index].time ?? .distantPast) > ($1.file.msgs[$1.index].time ?? .distantPast) }
        return Array(out.prefix(limit))
    }
}

/// ⌘⇧F: search all conversations. Results on the left; the picked message with the messages around it on the right.
struct ConvoSearchSheet: View {
    @EnvironmentObject var store: BoardStore
    @Environment(\.dismiss) private var dismiss
    @AppStorage("search.query") private var query = ""
    @State private var hits: [ConvoIndex.Hit] = []
    @State private var picked: String?
    @State private var loading = true
    @State private var sessions = 0
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("", text: $query, prompt: Text("모든 세션의 대화에서 찾기 (여러 단어는 모두 포함)")).textFieldStyle(.plain).font(.title3)
                    .focused($focused)
                if loading { ProgressView().controlSize(.small) }
                Button("닫기") { dismiss() }.keyboardShortcut(.cancelAction).buttonStyle(.raisedCompact)
            }
            .padding(10).background(RoundedRectangle(cornerRadius: 8).fill(Theme.panel))
            Text(loading ? "대화 기록을 읽는 중…" : (query.trimmingCharacters(in: .whitespaces).isEmpty ? "세션 \(sessions)개의 대화를 검색합니다" : "\(hits.count == 300 ? "300개 이상" : "\(hits.count)개") 찾음 · 세션 \(sessions)개 검색"))
                .font(.caption).foregroundStyle(.secondary)
            HSplitView {
                List(hits, selection: $picked) { h in row(h).tag(h.id) }
                    .listStyle(.plain).frame(minWidth: 320, idealWidth: 380)
                detail.frame(minWidth: 380, maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .padding(16).frame(width: 1000, height: 640).background(Theme.background)
        .onAppear { focused = true }
        .task {
            await Task.detached { ConvoIndex.shared.refresh() }.value
            sessions = ConvoIndex.shared.snapshot().count
            loading = false
            await run()
        }
        .task(id: query) { try? await Task.sleep(for: .milliseconds(200)); if !loading { await run() } }
    }

    private func run() async {
        let q = query
        let r = await Task.detached { ConvoIndex.shared.search(q) }.value
        hits = r
        if picked == nil || !r.contains(where: { $0.id == picked }) { picked = r.first?.id }
    }
    private func title(_ f: ConvoIndex.File) -> String {
        store.agent(f.sid)?.name ?? f.title ?? String(f.project.split(separator: "-").last ?? "")
    }
    private static let day: DateFormatter = { let f = DateFormatter(); f.dateFormat = "M/d HH:mm"; return f }()

    private func row(_ h: ConvoIndex.Hit) -> some View {
        let m = h.file.msgs[h.index]
        return VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(title(h.file)).font(.callout.weight(.semibold)).lineLimit(1)
                Text(m.user ? "나" : "에이전트").font(.caption2).padding(.horizontal, 5).padding(.vertical, 1)
                    .background(Capsule().fill((m.user ? Theme.accent : Theme.ink).opacity(0.12)))
                Spacer()
                if let t = m.time { Text(Self.day.string(from: t)).font(.caption).foregroundStyle(.secondary) }
            }
            Text(snippet(m.text)).font(.caption).foregroundStyle(.secondary).lineLimit(2)
        }.padding(.vertical, 4)
    }
    /// The text around the first word found, that word marked.
    private func snippet(_ text: String) -> AttributedString {
        let flat = text.replacingOccurrences(of: "\n", with: " ")
        let words = query.lowercased().split(separator: " ").map(String.init)
        guard let w = words.first, let r = flat.lowercased().range(of: w) else { return AttributedString(String(flat.prefix(120))) }
        let start = flat.index(r.lowerBound, offsetBy: -40, limitedBy: flat.startIndex) ?? flat.startIndex
        let piece = (start > flat.startIndex ? "…" : "") + String(flat[start...].prefix(160))
        return mark(piece, words)
    }
    private func mark(_ s: String, _ words: [String]) -> AttributedString {
        var a = AttributedString(s)
        let low = s.lowercased()
        for w in words where !w.isEmpty {
            var from = low.startIndex
            while let r = low.range(of: w, range: from..<low.endIndex) {
                let lo = a.characters.index(a.startIndex, offsetBy: low.distance(from: low.startIndex, to: r.lowerBound))
                let hi = a.characters.index(lo, offsetBy: low.distance(from: r.lowerBound, to: r.upperBound))
                a[lo..<hi].backgroundColor = Theme.accent.opacity(0.28)
                a[lo..<hi].foregroundColor = Color.primary
                from = r.upperBound
            }
        }
        return a
    }

    @ViewBuilder private var detail: some View {
        if let id = picked, let h = hits.first(where: { $0.id == id }) {
            let f = h.file, words = query.lowercased().split(separator: " ").map(String.init)
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(title(f)).font(.headline).lineLimit(1)
                    Spacer()
                    Button { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(f.msgs[h.index].text, forType: .string) } label: {
                        Label("메시지 복사", systemImage: "doc.on.doc")
                    }.buttonStyle(.raisedCompact)
                    if let a = store.agent(f.sid) {
                        Button { store.open(a); dismiss() } label: { Label("세션으로 이동", systemImage: "arrow.right.circle") }
                            .buttonStyle(.raisedCompact).help("이 세션의 대화창을 엽니다")
                    }
                }
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 12) {
                            ForEach(max(0, h.index - 3)...min(f.msgs.count - 1, h.index + 3), id: \.self) { i in
                                let m = f.msgs[i]
                                VStack(alignment: .leading, spacing: 4) {
                                    HStack {
                                        Text(m.user ? "나" : "에이전트").font(.caption.weight(.semibold)).foregroundStyle(m.user ? Theme.accent : .secondary)
                                        if let t = m.time { Text(Self.day.string(from: t)).font(.caption).foregroundStyle(.secondary) }
                                    }
                                    Text(i == h.index ? mark(m.text, words) : AttributedString(m.text))
                                        .font(.callout).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                                }
                                .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                                .background(RoundedRectangle(cornerRadius: 8).fill(i == h.index ? Theme.accent.opacity(0.08) : Theme.panel))
                                .overlay(RoundedRectangle(cornerRadius: 8).stroke(i == h.index ? Theme.accent.opacity(0.5) : .clear))
                                .id(i)
                            }
                        }.padding(4)
                    }
                    .onAppear { proxy.scrollTo(h.index, anchor: .center) }
                    .onChange(of: id) { _, _ in DispatchQueue.main.async { proxy.scrollTo(h.index, anchor: .center) } }
                }
            }
        } else {
            Text(loading ? "" : "왼쪽에서 결과를 고르세요").foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}
