import SwiftUI
import AppKit

/// One entry of the "/" palette.
struct SlashCommand: Identifiable, Equatable {
    enum Source: String { case builtin, user, project, skill }
    var name: String                 // without the leading "/"
    var desc: String
    var argHint: String? = nil       // e.g. "<모델>"
    var needsArg = false             // Tab/Enter fills "/name " instead of sending
    var terminalOnly = false         // opens a TUI menu: the terminal panel is shown after sending
    var source: Source = .builtin
    var id: String { source.rawValue + ":" + name }
    var text: String { "/" + name }
}

enum SlashCatalog {
    static var builtin: [SlashCommand] { [   // computed: the descriptions follow the chosen language
        .init(name: "help", desc: L("도움말과 사용 가능한 명령 보기"), terminalOnly: true),
        .init(name: "clear", desc: L("대화 기록을 비우고 새로 시작")),
        .init(name: "compact", desc: L("대화를 요약해 컨텍스트 확보"), argHint: L("[요약 지침]")),
        .init(name: "model", desc: L("모델 변경"), argHint: L("<모델>"), needsArg: true),
        .init(name: "effort", desc: L("추론 effort 변경"), argHint: "<low|medium|high|xhigh|max>", needsArg: true),
        .init(name: "rename", desc: L("세션 이름 변경"), argHint: L("<이름>"), needsArg: true),
        .init(name: "resume", desc: L("이전 대화 이어서 하기"), terminalOnly: true),
        .init(name: "cost", desc: L("토큰 사용량과 비용 확인")),
        .init(name: "context", desc: L("컨텍스트 사용 현황 보기")),
        .init(name: "usage", desc: L("플랜 사용량 한도 보기")),
        .init(name: "status", desc: L("버전·모델·계정 상태 보기"), terminalOnly: true),
        .init(name: "config", desc: L("설정 열기"), terminalOnly: true),
        .init(name: "memory", desc: L("CLAUDE.md 메모리 편집"), terminalOnly: true),
        .init(name: "init", desc: L("프로젝트용 CLAUDE.md 생성")),
        .init(name: "review", desc: L("풀 리퀘스트 리뷰"), argHint: "[PR]"),
        .init(name: "agents", desc: L("서브에이전트 관리"), terminalOnly: true),
        .init(name: "mcp", desc: L("MCP 서버 연결 관리"), terminalOnly: true),
        .init(name: "permissions", desc: L("도구 권한 규칙 관리"), terminalOnly: true),
        .init(name: "hooks", desc: L("훅 설정 보기"), terminalOnly: true),
        .init(name: "export", desc: L("대화를 파일이나 클립보드로 내보내기"), argHint: L("[파일명]"), terminalOnly: true),
        .init(name: "add-dir", desc: L("작업 폴더 추가"), argHint: L("<경로>"), needsArg: true),
        .init(name: "doctor", desc: L("설치 상태 진단"), terminalOnly: true),
        .init(name: "release-notes", desc: L("릴리스 노트 보기"), terminalOnly: true),
        .init(name: "todos", desc: L("현재 할 일 목록 보기")),
        .init(name: "rewind", desc: L("이전 시점으로 대화·코드 되돌리기"), terminalOnly: true),
        .init(name: "exit", desc: L("세션 종료")),
    ] }

    static func isTerminalOnly(_ text: String) -> Bool {
        guard text.hasPrefix("/") else { return false }
        let n = String(text.dropFirst().prefix { !$0.isWhitespace })
        return builtin.first { $0.name == n }?.terminalOnly ?? false
    }

    // MARK: custom commands and skills (read off the main thread, cached per folder)
    private static var cache: [String: (at: Date, items: [SlashCommand])] = [:]
    private static let lock = NSLock()

    static func cached(cwd: String?) -> [SlashCommand]? {
        lock.lock(); defer { lock.unlock() }
        return cache[cwd ?? ""]?.items
    }
    /// Fresh enough → nil work; otherwise reload in the background and call back on main.
    static func load(cwd: String?, completion: @escaping ([SlashCommand]) -> Void) {
        let key = cwd ?? ""
        lock.lock(); let hit = cache[key]; lock.unlock()
        if let hit, Date().timeIntervalSince(hit.at) < 30 { completion(hit.items); return }
        DispatchQueue.global(qos: .utility).async {
            let items = scan(cwd: cwd)
            lock.lock(); cache[key] = (Date(), items); lock.unlock()
            DispatchQueue.main.async { completion(items) }
        }
    }

    private static func scan(cwd: String?) -> [SlashCommand] {
        let home = Shell.home + "/.claude"
        var out: [SlashCommand] = []
        out += commands(in: home + "/commands", source: .user)
        out += skills(in: home + "/skills", source: .skill)
        if let cwd, !cwd.isEmpty, cwd != Shell.home {
            out += commands(in: cwd + "/.claude/commands", source: .project)
            out += skills(in: cwd + "/.claude/skills", source: .skill)
        }
        var seen = Set<String>(builtin.map(\.name)); var uniq: [SlashCommand] = []
        for c in out where seen.insert(c.name).inserted { uniq.append(c) }
        return uniq.sorted { $0.name < $1.name }
    }
    private static func commands(in dir: String, source: SlashCommand.Source) -> [SlashCommand] {
        guard let en = FileManager.default.enumerator(atPath: dir) else { return [] }
        var out: [SlashCommand] = []
        for case let rel as String in en where rel.hasSuffix(".md") {
            let name = String(rel.dropLast(3)).replacingOccurrences(of: "/", with: ":")
            let fm = frontmatter(dir + "/" + rel)
            out.append(.init(name: name, desc: fm.desc ?? L("사용자 정의 명령"), argHint: fm.hint, source: source))
        }
        return out
    }
    private static func skills(in dir: String, source: SlashCommand.Source) -> [SlashCommand] {
        guard let subs = try? FileManager.default.contentsOfDirectory(atPath: dir) else { return [] }
        var out: [SlashCommand] = []
        for d in subs where !d.hasPrefix(".") {
            let path = dir + "/" + d + "/SKILL.md"
            guard FileManager.default.fileExists(atPath: path) else { continue }
            let fm = frontmatter(path)
            out.append(.init(name: fm.name ?? d, desc: fm.desc ?? L("스킬"), argHint: fm.hint, source: source))
        }
        return out
    }
    private static func frontmatter(_ path: String) -> (name: String?, desc: String?, hint: String?) {
        guard let h = FileHandle(forReadingAtPath: path) else { return (nil, nil, nil) }
        defer { try? h.close() }
        guard let data = try? h.read(upToCount: 4096), let s = String(data: data, encoding: .utf8), s.hasPrefix("---") else { return (nil, nil, nil) }
        var name: String?, desc: String?, hint: String?
        var lines = s.components(separatedBy: "\n").dropFirst()
        while let l = lines.popFirst() {
            if l.hasPrefix("---") { break }
            func val(_ k: String) -> String? {
                guard l.hasPrefix(k + ":") else { return nil }
                var v = l.dropFirst(k.count + 1).trimmingCharacters(in: .whitespaces)
                if v.count >= 2, let f = v.first, f == "\"" || f == "'", v.last == f { v = String(v.dropFirst().dropLast()) }
                return v.isEmpty || v == ">" || v == "|" ? nil : v
            }
            if let v = val("name") { name = v }
            if let v = val("description") { desc = v }
            if let v = val("argument-hint") { hint = v }
        }
        return (name, desc.map { $0.count > 140 ? String($0.prefix(140)) + "…" : $0 }, hint)
    }

    // MARK: filtering
    /// Prefix matches first, then substring, then loose subsequence ("cmp" → compact).
    static func filter(_ all: [SlashCommand], query: String) -> [SlashCommand] {
        let q = query.lowercased()
        if q.isEmpty { return all }
        func score(_ c: SlashCommand) -> Int? {
            let n = c.name.lowercased()
            if n == q { return 0 }
            if n.hasPrefix(q) { return 1 }
            if n.contains(q) { return 2 }
            guard q.count >= 3 else { return c.desc.lowercased().contains(q) ? 4 : nil }   // short queries: no loose matches
            var it = n.makeIterator()
            if q.allSatisfy({ ch in while let x = it.next() { if x == ch { return true } }; return false }) { return 3 }
            if c.desc.lowercased().contains(q) { return 4 }
            return nil
        }
        return all.compactMap { c in score(c).map { (c, $0) } }
            .sorted { $0.1 != $1.1 ? $0.1 < $1.1 : $0.0.name < $1.0.name }.map(\.0)
    }
}

/// Typed slash commands the app already implements itself: go through the same path as its buttons.
enum SlashRouter {
    @MainActor static func route(_ text: String, agent: Agent, store: BoardStore) -> Bool {
        store.userInitiated = true; defer { store.userInitiated = false }   // commands the user typed show as their bubble
        let parts = text.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true)
        guard let head = parts.first, head.hasPrefix("/") else { return false }
        let arg = parts.count > 1 ? parts[1].trimmingCharacters(in: .whitespacesAndNewlines) : ""
        switch head {
        case "/model":
            guard let m = ModelChoice.allCases.first(where: { c in
                let a = arg.lowercased()
                return !a.isEmpty && (c.rawValue == a || c.label.lowercased() == a || c.rawValue.contains(a.replacingOccurrences(of: " ", with: "-")))
            }) else { return false }
            store.setModel(m, for: agent); return true
        case "/effort":
            guard let e = EffortChoice.allCases.first(where: { $0.rawValue == arg.lowercased() }) else { return false }
            store.setEffort(e, for: agent); return true
        case "/rename":
            guard !arg.isEmpty else { return false }
            store.rename(agent, to: arg); return true
        default: return false
        }
    }
}

/// State and key handling of the palette; one per composer.
@MainActor final class SlashController: ObservableObject {
    @Published var index = 0
    var navigated = false          // the user picked a row with ↑↓
    @Published private(set) var dismissedFor: String?
    @Published private(set) var custom: [SlashCommand] = []
    private var loadedCwd: String??

    func reload(cwd: String?) {
        if let l = loadedCwd, l == cwd { return }
        loadedCwd = .some(cwd)
        if let c = SlashCatalog.cached(cwd: cwd) { custom = c }
        SlashCatalog.load(cwd: cwd) { [weak self] items in self?.custom = items }
    }
    func query(_ draft: String) -> String? {
        guard draft.hasPrefix("/"), !draft.dropFirst().contains(where: { $0 == " " || $0 == "\n" || $0 == "/" }) else { return nil }   // a second "/" means a path
        return String(draft.dropFirst())
    }
    func items(for draft: String) -> [SlashCommand] {
        guard let q = query(draft), dismissedFor != draft else { return [] }
        return SlashCatalog.filter(SlashCatalog.builtin + custom, query: q)
    }
    func dismiss(_ draft: String) { dismissedFor = draft }
    func clamp(_ n: Int) { if index >= n { index = max(0, n - 1) } }

    /// Returns true when the key was consumed.
    func handle(_ ev: NSEvent, draft: Binding<String>, send: @escaping () -> Void) -> Bool {
        let list = items(for: draft.wrappedValue)
        guard !list.isEmpty else { return false }
        let i = min(index, list.count - 1)
        switch ev.keyCode {
        case 125: navigated = true; index = (i + 1) % list.count; return true               // ↓
        case 126: navigated = true; index = (i - 1 + list.count) % list.count; return true  // ↑
        case 53: dismiss(draft.wrappedValue); return true                 // Esc
        case 48: pick(list[i], draft: draft, send: nil); return true      // Tab
        case 36, 76:
            if ev.modifierFlags.contains(.shift) { return false }
            // only replace what was typed when the user chose a row or typed a real prefix; "/usr/local" stays as typed
            let q = (query(draft.wrappedValue) ?? "").lowercased()
            if navigated || list[i].name.lowercased().hasPrefix(q) { pick(list[i], draft: draft, send: send); return true }
            dismiss(draft.wrappedValue); return false
        default: return false
        }
    }
    func pick(_ c: SlashCommand, draft: Binding<String>, send: (() -> Void)?) {
        index = 0; navigated = false
        if c.needsArg {
            draft.wrappedValue = c.text + " "
        } else if let send {
            draft.wrappedValue = c.text; send()
        } else {
            draft.wrappedValue = c.text + (c.argHint != nil ? " " : "")
        }
    }
}

struct SlashPaletteView: View {
    @ObservedObject var ctl: SlashController
    @Binding var draft: String
    var onSend: () -> Void
    var body: some View {
        let list = ctl.items(for: draft)
        if !list.isEmpty {
            let sel = min(ctl.index, list.count - 1)
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(spacing: 1) {
                        ForEach(Array(list.enumerated()), id: \.element.id) { i, c in
                            row(c, selected: i == sel).id(c.id)
                                .onTapGesture { ctl.pick(c, draft: $draft, send: onSend) }
                        }
                    }.padding(5)
                }
                .onChange(of: sel) { _, _ in if sel < list.count { proxy.scrollTo(list[sel].id) } }
            }
            .frame(maxWidth: 560).frame(height: min(CGFloat(list.count) * 34 + 10, 276))
            .background(RoundedRectangle(cornerRadius: 6).fill(Theme.panel))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(Theme.lineHi))
            .onChange(of: list.count) { _, n in ctl.clamp(n) }
            .onChange(of: draft) { _, _ in ctl.index = 0; ctl.navigated = false }
        }
    }
    private func row(_ c: SlashCommand, selected: Bool) -> some View {
        HStack(spacing: 8) {
            Text(c.text).font(.system(.callout, design: .monospaced).weight(.semibold))
                .foregroundStyle(selected ? Color.white : Theme.accent)
            if let h = c.argHint { Text(h).font(.system(.caption, design: .monospaced)).foregroundStyle(selected ? Color.white.opacity(0.8) : Color.secondary) }
            Text(c.desc).font(.callout).foregroundStyle(selected ? Color.white : Color.primary.opacity(0.8)).lineLimit(1)
            Spacer(minLength: 4)
            if c.terminalOnly { tag(L("터미널에서 열림"), selected) }
            switch c.source {
            case .user: tag(L("사용자"), selected)
            case .project: tag(L("프로젝트"), selected)
            case .skill: tag(L("스킬"), selected)
            case .builtin: EmptyView()
            }
        }
        .padding(.horizontal, 8).frame(height: 33)
        .background(RoundedRectangle(cornerRadius: 6).fill(selected ? AnyShapeStyle(Theme.accentGrad) : AnyShapeStyle(Color.clear)))
        .contentShape(Rectangle())
    }
    private func tag(_ s: String, _ selected: Bool) -> some View {
        Text(s).font(.caption2.weight(.semibold)).padding(.horizontal, 6).padding(.vertical, 1)
            .background(Capsule().fill(selected ? Color.white.opacity(0.25) : Theme.ink.opacity(0.10)))
            .foregroundStyle(selected ? Color.white : Color.secondary)
    }
}
