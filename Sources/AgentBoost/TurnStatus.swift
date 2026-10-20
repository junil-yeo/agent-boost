import SwiftUI

/// The CLI's spinner glyphs, in its order (· ✢ ✳ ✶ ✻ ✽ and back).
enum Spinner {
    static let frames: [String] = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"]
    static func frame(at date: Date) -> String { frames[Int(date.timeIntervalSinceReferenceDate * 8) % frames.count] }
    static let tint = Theme.dyn(0xED9480, 0xC2410C)    // xterm 174, the CLI's spinner colour
    static let verbTint = Theme.dyn(0xF2B88C, 0xA14A0B) // xterm 180
}

/// The line the CLI draws above its input box, for the chat: a turning glyph with the verb, elapsed time and token count
/// while a turn runs; the raised hand while a question waits; the dim "done" line afterwards. Reads the real CLI screen
/// (`agent.screen`) and falls back to its own clock and token delta when the pane cannot be read.
struct TurnStatusBar: View {
    var agent: Agent
    var lastTool: String?           // newest tool call of this turn ("Bash · ls -la"), from the transcript
    var queued: Int                 // messages typed while the turn runs (the CLI keeps them until it is free)
    var onInterrupt: () -> Void
    var onPushQueue: () -> Void = {}
    var onPullQueue: () -> Void = {}
    @State private var turnStart: Date?
    @State private var tokensAtStart = 0

    var body: some View {
        Group {
            if agent.state == .busy { working }
            else if agent.state == .needsInput { waiting }
            else if let d = agent.screen?.done, agent.state == .idle { doneLine(d) }
        }
        .padding(.horizontal, 20).padding(.top, 0).padding(.bottom, 2)       // sits right on the input box
        .frame(maxWidth: 820).frame(maxWidth: .infinity)
        .onAppear { if agent.state == .busy { turnStart = Date(); tokensAtStart = agent.tokens.output } }
        .onChange(of: agent.state) { old, new in
            if new == .busy && old != .busy { turnStart = Date(); tokensAtStart = agent.tokens.output }
            if new != .busy && new != .needsInput { turnStart = nil }
        }
    }

    private var working: some View {
        TimelineView(.periodic(from: .now, by: 0.125)) { ctx in
            HStack(spacing: 8) {
                Text(Spinner.frame(at: ctx.date)).font(.system(size: 15, weight: .bold)).foregroundStyle(Spinner.tint)
                    .frame(width: 16).contentTransition(.identity)
                Text((agent.screen?.verb ?? L("작업 중")) + "…").font(.system(size: 13, weight: .semibold)).foregroundStyle(Spinner.verbTint)
                Text(details(at: ctx.date)).font(.system(size: 12, design: .monospaced)).foregroundStyle(.secondary).lineLimit(1)
                Spacer(minLength: 8)
                if queued > 0 {
                    Label(L("대기열 %@", String(queued)), systemImage: "tray.full").font(.caption).foregroundStyle(.secondary)
                        .help(L("작업이 끝나면 Claude가 차례로 처리하는 메시지 수"))
                    Button { onPullQueue() } label: { Label(L("꺼내기"), systemImage: "arrow.uturn.down").font(.caption) }
                        .buttonStyle(.raisedCompact).help(L("대기 중인 메시지를 보내기 전에 입력창으로 되돌립니다 (CLI의 ↑와 같음). 고치거나 지울 수 있습니다."))
                    Button { onPushQueue() } label: { Label(L("지금 보내기"), systemImage: "paperplane.fill").font(.caption) }
                        .buttonStyle(.raisedCompact).help(L("하던 작업을 멈추고(Esc) 대기 중인 메시지를 바로 처리하게 합니다"))
                }
            }
        }
    }
    /// "(2m 30s · ↓ 9.8k tokens · 생각 중 · Running 1 shell command…)" — screen values first, own counters otherwise.
    private func details(at now: Date) -> String {
        var segs: [String] = []
        if let e = agent.screen?.elapsed { segs.append(e) }
        else if let s = turnStart { segs.append(Self.clock(now.timeIntervalSince(s))) }
        if let t = agent.screen?.tokens { segs.append("↓ \(t) tokens") }
        else if agent.tokens.output > tokensAtStart { segs.append("↓ \(Fmt.tokens(agent.tokens.output - tokensAtStart)) tokens") }
        if agent.screen?.thinking == true { segs.append(L("생각 중")) }
        if let a = agent.screen?.activity { segs.append(a) }
        return segs.isEmpty ? "" : "(" + segs.joined(separator: " · ") + ")"
    }
    static func clock(_ s: TimeInterval) -> String {
        let n = Int(s)
        if n >= 3600 { return "\(n / 3600)h \(n % 3600 / 60)m" }
        if n >= 60 { return "\(n / 60)m \(n % 60)s" }
        return "\(n)s"
    }
    private var waiting: some View {
        HStack(spacing: 8) {
            Image(systemName: "hand.raised.fill").foregroundStyle(Theme.attention)
                .phaseAnimator([0.45, 1.0]) { v, o in v.opacity(o) } animation: { _ in .easeInOut(duration: 1.0) }
            Text(L("답을 기다리는 중")).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.attention)
            Text(L("아래 선택지를 고르거나 숫자 키 · Esc로 취소")).font(.caption).foregroundStyle(.secondary)
            Spacer()
        }
    }
    /// "Cogitated for 2m 47s · done 2:16 AM" → "✻ 지난 작업 2m 47s · 2:16 AM 완료"
    private func doneLine(_ d: String) -> some View {
        let parts = d.split(separator: "·").map { $0.trimmingCharacters(in: .whitespaces) }
        var took = parts.first ?? d
        if let r = took.range(of: " for ") { took = String(took[r.upperBound...]) }
        let done = parts.dropFirst().first.map { $0.replacingOccurrences(of: "done ", with: "") }
        return HStack(spacing: 6) {
            Text("✻").foregroundStyle(.tertiary)
            Text(done.map { L("지난 작업 %@ · %@ 완료", took, $0) } ?? L("지난 작업 %@", took)).font(.caption).foregroundStyle(.tertiary)
            Spacer()
        }
    }
}

/// The CLI's footer under the box: permission mode (Shift+Tab cycles), context use, teammate count, what Tab would fill,
/// and the shortcut list behind "?".
struct ComposerFooter: View {
    @EnvironmentObject var store: BoardStore
    var agent: Agent
    var ghost: String?
    var pendingCommands: Int
    @State private var showKeys = false
    @State private var narrow = false      // a split pane: buttons as icons, so the footer stays one line in every pane

    var body: some View {
        HStack(spacing: 10) {
            if agent.tmuxPane != nil && agent.state != .ended {
                Button { store.cycleMode(agent) } label: {
                    HStack(spacing: 4) {
                        Text("⏵⏵").font(.system(size: 10, weight: .bold))
                        Text(agent.modeLabel).font(.caption).lineLimit(1)
                    }.fixedSize().foregroundStyle(agent.screen?.mode == nil ? Color.secondary : Theme.dyn(0xFFD700, 0x8A5A00).opacity(0.95))   // the CLI's yellow; dark gold on white
                }.buttonStyle(.plain).help(L("권한 모드: %@ — 누르거나 Shift+Tab으로 다음 모드로 바꿉니다 (CLI의 shift+tab과 같음)", agent.modeLabel))
            }
            if let ctx = agent.contextTokens {
                let pct = min(100, Int(Double(ctx) / Double(agent.contextWindow) * 100))
                let tint: Color = pct >= 85 ? Theme.errorTone : pct >= 65 ? Theme.attention : Color.secondary
                HStack(spacing: 5) {
                    ZStack(alignment: .leading) {
                        Capsule().fill(Theme.ink.opacity(0.10)).frame(width: 48, height: 5)
                        Capsule().fill(tint).frame(width: max(2, 48 * CGFloat(pct) / 100), height: 5)
                    }
                    Text(L("컨텍스트 %@%", String(pct))).font(.caption).foregroundStyle(tint == .secondary ? Color.secondary : tint).lineLimit(1).fixedSize()
                }
                .help(pct >= 65 ? L("마지막 요청이 실은 컨텍스트: %@ / %@ 토큰 — /compact 로 줄일 수 있습니다", Fmt.tokens(ctx), Fmt.tokens(agent.contextWindow))
                                 : L("마지막 요청이 실은 컨텍스트: %@ / %@ 토큰", Fmt.tokens(ctx), Fmt.tokens(agent.contextWindow)))
            }
            if let n = agent.screen?.agents, n > 0 {
                Label(L("백그라운드 작업 %@", String(n)), systemImage: "tray.2").font(.caption).foregroundStyle(.secondary)
                    .help(BackgroundJobs.summary(cliCount: n))
            }
            if pendingCommands > 0 {
                Label(L("대기 명령 %@", String(pendingCommands)), systemImage: "clock").font(.caption).foregroundStyle(.orange).help(L("작업이 끝나면 보내는 명령"))
            }
            if let path = agent.transcriptPath {
                AnswerActions(text: { TranscriptReader.lastAnswer(path) }, compact: true, from: agent.name, fromId: agent.sessionId,
                              recent: { TranscriptReader.recentAnswers(path, count: 5) })
                    .labelStyle(narrow ? AnyLabelStyle(.iconOnly) : AnyLabelStyle(.titleAndIcon))
                    .fixedSize().layoutPriority(1)   // one line always; the Tab suggestion shrinks instead
            }
            Spacer(minLength: 4)
            do {   // always laid out (hidden when empty): the footer keeps its shape while the suggestion comes and goes
                let g = ghost ?? ""
                HStack(spacing: 4) {
                    Text("Tab").font(.system(size: 10, weight: .semibold)).padding(.horizontal, 5).padding(.vertical, 1)
                        .background(RoundedRectangle(cornerRadius: 4).fill(Theme.ink.opacity(0.12)))
                    Text("“\(g.count > 40 ? String(g.prefix(40)) + "…" : g)”").font(.caption).lineLimit(1).truncationMode(.tail)
                }.layoutPriority(-1).foregroundStyle(.secondary).help(L("Tab을 누르면 입력창에 채웁니다")).opacity(g.isEmpty ? 0 : 1)
            }
            Button { showKeys.toggle() } label: {
                Label(L("단축키"), systemImage: "keyboard").labelStyle(narrow ? AnyLabelStyle(.iconOnly) : AnyLabelStyle(.titleAndIcon))
                    .font(.caption).lineLimit(1).fixedSize().padding(.horizontal, 6).padding(.vertical, 2)
                    .overlay(RoundedRectangle(cornerRadius: 5).stroke(Theme.lineHi))
            }.buttonStyle(.plain).foregroundStyle(.secondary).help(L("입력창 단축키 보기"))
                .popover(isPresented: $showKeys, arrowEdge: .bottom) { ShortcutSheet() }
        }
        .frame(height: 20)
        .onGeometryChange(for: Bool.self) { $0.size.width < 620 } action: { narrow = $0 }
        .padding(.horizontal, 24).padding(.bottom, 10).padding(.top, -2)
        .frame(maxWidth: 820).frame(maxWidth: .infinity)
    }
}

struct ShortcutSheet: View {
    private let rows: [(String, String)] = [
        ("Enter", L("보내기 (작업 중이면 CLI가 대기열에 넣음)")), ("⇧ Enter", L("줄바꿈 (목록은 번호·글머리 자동 이어짐)")), ("⌘ Enter", L("보내기")),
        ("Tab", L("회색 제안 채우기 / 팔레트 선택")), ("⇧ Tab", L("권한 모드 순환 (기본 → 편집 허용 → 계획 …)")),
        ("↑ ↓", L("입력 이력 (비어 있을 때) / 팔레트 이동")), ("Esc", L("작업 중단 · 질문 취소 · 팔레트 닫기 · 이력 취소")),
        ("/", L("슬래시 명령 팔레트")), ("@", L("파일 멘션 (작업 폴더 검색)")), (L("!명령"), L("셸 명령 실행 (에이전트 폴더에서)")),
        ("1–9", L("질문 선택지 고르기")), ("⌘V", L("스크린샷·이미지 첨부")), ("⌘ + / −", L("글자 크기")),
    ]
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(L("입력창 단축키")).font(.headline).padding(.bottom, 2)
            ForEach(Array(rows.enumerated()), id: \.offset) { _, r in
                HStack(alignment: .top, spacing: 10) {
                    Text(r.0).font(.system(.caption, design: .monospaced).weight(.semibold)).frame(width: 64, alignment: .trailing)
                    Text(r.1).font(.caption).foregroundStyle(.secondary)
                }
            }
        }.padding(14).frame(width: 360)
    }
}

/// Claude Code's background agent jobs (~/.claude/jobs/<id>/state.json): what the CLI footer's "← N agents" counts
/// (the jobs not finished; ← in the CLI lists them). Read on hover only.
enum BackgroundJobs {
    static func summary(cliCount: Int) -> String {
        let dir = Shell.home + "/.claude/jobs"
        let ids = (try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? []
        var rows: [String] = []
        for id in ids.sorted() {
            guard let d = FileManager.default.contents(atPath: dir + "/" + id + "/state.json"),
                  let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any], let st = j["state"] as? String, st != "done" else { continue }
            let when = (try? FileManager.default.attributesOfItem(atPath: dir + "/" + id + "/state.json"))?[.modificationDate] as? Date
            let label = st == "blocked" ? L("멈춤") : st == "running" ? L("실행 중") : st
            rows.append("· \(id) — \(label)\(when.map { " (" + Fmt.ago($0) + ")" } ?? "")\n   \((j["detail"] as? String ?? "").prefix(80))")
        }
        return L("CLI 하단의 \"← %@ agents\": 끝나지 않은 Claude Code 백그라운드 작업 (~/.claude/jobs). 서브에이전트나 다른 세션이 아닙니다. CLI에서 ←로 목록을 열어 정리할 수 있습니다.", String(cliCount)) + "\n\n"
            + (rows.isEmpty ? L("(작업 폴더에서 끝나지 않은 작업을 찾지 못함)") : rows.joined(separator: "\n"))
    }
}

/// A label style chosen at run time (titles, or icons only in a narrow pane).
struct AnyLabelStyle: LabelStyle {
    private let make: (Configuration) -> AnyView
    init<S: LabelStyle>(_ s: S) { make = { AnyView(s.makeBody(configuration: $0)) } }
    func makeBody(configuration: Configuration) -> some View { make(configuration) }
}
