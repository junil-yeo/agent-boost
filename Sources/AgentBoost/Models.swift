import Foundation

struct TokenUsage: Equatable {
    var input = 0, cacheWrite = 0, cacheRead = 0, output = 0
    var total: Int { input + cacheWrite + cacheRead + output }
    static func + (a: TokenUsage, b: TokenUsage) -> TokenUsage {
        TokenUsage(input: a.input + b.input, cacheWrite: a.cacheWrite + b.cacheWrite,
                   cacheRead: a.cacheRead + b.cacheRead, output: a.output + b.output)
    }
}

enum AgentState: String { case busy, idle, ended, unknown, needsInput }   // needsInput: a permission / choice prompt waits for the user

/// A choice window of Claude Code shown on the pane (permission request, folder trust, "Switch model?" ...).
struct PromptInfo: Equatable {
    var title: String
    var detail: String?          // explanation lines between the title and the options
    var preview: String?         // what is being asked about: the command / diff above the question (last 30 lines)
    var options: [String]
    var cursor: Int              // index of the highlighted option
    var numbered = true          // options carry numbers on screen (folder trust does not)
}

/// One Claude session, living or ended, as the board understands it.
struct Agent: Identifiable, Equatable {
    var id: String { sessionId }
    var sessionId: String
    var pid: Int?
    var name: String              // conversation name (what /rename changes)
    var nameSource: String?
    var teamAddress: String?      // e.g. verifier@session-039ac1c1
    var teamName: String?
    var agentType: String?        // team-lead / general-purpose / ...
    var isLead = false
    var state: AgentState = .unknown
    var tmuxPane: String?         // "%4"
    var tmuxSession: String?      // tmux session that holds the pane
    var cwd: String?
    var model: String?
    var effort: String?
    var prompt: PromptInfo?          // the choice window the agent waits on (state == .needsInput)
    var screen: ScreenStatus?        // what the CLI shows around its input box (spinner verb / elapsed / mode …)
    var contextTokens: Int?          // size of the context the last request carried (input + cache), for the usage bar
    var stateUnconfirmed = false    // status file and screen disagree for 10 s+ (display hint: "확인 중")
    var modelIsGuess = false       // taken from the launch flag, not seen in the transcript
    var tokens = TokenUsage()
    var tokensEstimated = false    // last run's numbers shown while the transcript is still being parsed
    var lastActivity: Date?
    var transcriptPath: String?
    var pendingName: String?
    var entrypoint: String?       // cli / claude-desktop / ...
    var jobId: String?            // the CLI's background-job id (`claude agents` / ~/.claude/jobs)
    var isBackgroundJob = false   // session file kind "bg": a background job (often a fork of another session's conversation)
    var remoteControl: Bool?      // nil = unknown (teammates have no session file)
    var origin: String?           // "board" when this app started it
    var isSubagent = false        // an in-process helper the session spawned with its Agent tool (no pane: view only)
    var parentSid: String?
    var solo = false              // lead of an implicit one-person team: shown as an individual session
    var pendingCommands: [String] = []
    var queued = 0                // messages waiting in the CLI's own queue (transcript queue-operation records)
    var parkedJobId: String?      // an interactive CLI whose conversation moved to a background job (its "← agents" screen): the job is the session
    var overlay: String?          // the pane shows a CLI screen instead of the conversation ("agents" list, "resume" picker): typing there never reaches the agent
    var viewerPid: Int?           // for a background job: the interactive / `claude attach` process that shows it in tmuxPane
    var requestedModel: String?     // chosen in the app, shown at once
    var requestedEffort: String?

    var displayModel: String {
        guard let m = model else { return "모델 미확인" }
        if modelIsGuess { return Agent.pretty(m) + " ?" }
        return Agent.pretty(m)
    }
    private static func pretty(_ m: String) -> String {
        let parts = m.split(separator: "-").map(String.init)
        guard parts.count >= 3, parts[0] == "claude" else { return m }
        let fam = parts[1].prefix(1).uppercased() + parts[1].dropFirst()
        var ver = parts[2]
        if parts.count > 3, parts[3].count <= 2 { ver += "." + parts[3] }
        return "\(fam) \(ver)"
    }
    /// Running a turn or stuck on a prompt: nothing may be typed into it.
    /// Any shown value that is a guess / stale (launch-flag model, cached tokens): render it dimmed.
    var isEstimated: Bool { modelIsGuess || tokensEstimated }
    var working: Bool { state == .busy || state == .needsInput }
    var canReceiveInput: Bool { tmuxPane != nil && state != .ended && overlay == nil }
    /// Context window of the model: 1M for "[1m]" variants, 200k otherwise.
    var contextWindow: Int { (model ?? "").contains("[1m]") || (model ?? "").hasSuffix("-1m") ? 1_000_000 : 200_000 }
    /// Permission mode the CLI footer shows, in Korean ("기본" when the footer says nothing).
    var modeLabel: String {
        switch screen?.mode {
        case "auto mode": "자동 모드"; case "accept edits": "편집 자동 허용"; case "plan mode": "계획 모드"; case "bypass permissions": "권한 확인 없음"
        case let m?: m; case nil: "기본 모드"
        }
    }
}

struct Team: Identifiable, Equatable {
    var id: String { name }
    var name: String
    var createdAt: Date?
    var leadSessionId: String?
    var members: [Agent]
    var lead: Agent? { members.first { $0.isLead } }
    var workers: [Agent] { members.filter { !$0.isLead } }
    var liveCount: Int { members.filter { $0.state == .busy || $0.state == .idle || $0.state == .needsInput }.count }
    var tokens: TokenUsage { members.map(\.tokens).reduce(TokenUsage(), +) }
    /// A team that is only its own lead (every session is one, implicitly).
    var isSolo: Bool { let m = members.filter { !$0.isSubagent }; return m.count == 1 && m[0].isLead }
    /// Lead's conversation name when it has one; the raw team id otherwise.
    var displayName: String {
        if let l = lead, !l.name.isEmpty, l.name != "team-lead", !l.name.hasPrefix(name) { return l.name }
        return name
    }
}

enum ModelChoice: String, CaseIterable, Identifiable {
    // The plain aliases (haiku/sonnet/opus) resolve to the newest of each family in this CLI build.
    case fable = "claude-fable-5-1", opus = "claude-opus-5-5", sonnet = "claude-sonnet-5-5", haiku = "claude-haiku-5-5", haiku45 = "claude-haiku-4-5"
    var id: String { rawValue }
    var label: String { switch self { case .fable: "Fable 5.1"; case .opus: "Opus 5.5"; case .sonnet: "Sonnet 5.5"; case .haiku: "Haiku 5.5"; case .haiku45: "Haiku 4.5" } }
}
enum EffortChoice: String, CaseIterable, Identifiable {
    case low, medium, high, xhigh, max
    var id: String { rawValue }
}

/// A teammate requested in the new-session sheet or the add-teammate sheet.
struct TeammateSpec: Identifiable, Equatable {
    var id = UUID()
    var name = ""
    var role = ""
    var model: ModelChoice = .sonnet
    var effort: EffortChoice = .low
    /// Claude's Agent tool only accepts ASCII letters, digits, '_' and '-' as a teammate name (Korean names are rejected).
    var nameIsValid: Bool { !name.isEmpty && name.range(of: #"^[A-Za-z0-9_-]+$"#, options: .regularExpression) != nil }
}

/// A session the board started that has not registered with Claude yet.
struct Launch: Identifiable, Equatable {
    enum Phase: Equatable { case starting, needsTrust, needsSetup, exited, stuck }
    var id: String { tmuxName }
    var tmuxName: String
    var name: String
    var cwd: String
    var created = Date()
    var phase: Phase = .starting
    var screenTail = ""
    var attachJob: String?                                     // `claude attach <job>`: has no session file of its own
    var resume: ResumeArgs?                                    // `claude --resume`: what to retry with when the CLI refuses
    struct ResumeArgs: Equatable { var sid: String; var model: ModelChoice; var effort: EffortChoice; var bypass: Bool }
}

/// Verifies that teammates the board asked for were actually created.
struct SpawnCheck: Identifiable, Equatable {
    enum Result: Equatable { case waiting, ok, mismatch(String), failed }
    var id = UUID()
    var leadPane: String          // tmux pane of the lead that received the instruction
    var specs: [TeammateSpec]
    var started = Date()
    var results: [String: Result] = [:]   // teammate name -> result
    var leadScreen = ""
    var reason = ""           // the lead's own words when it reports a failure
    var done: Bool { specs.allSatisfy { results[$0.name].map { $0 != .waiting } ?? false } }
}

enum QuitMode { case now, whenIdle }

struct NoticeItem: Identifiable, Equatable { var id = UUID(); var at: Date; var text: String }

/// A session moved to the archive: hidden from the board, files untouched, restorable.
struct ArchivedItem: Codable, Identifiable, Equatable {
    var id: String { sessionId }
    var sessionId: String
    var name: String
    var teamName: String?
    var isLead: Bool
    var model: String?
    var effort: String?
    var cwd: String?
    var transcriptPath: String?
    var tokensOut: Int
    var tokensTotal: Int
    var archivedAt: Date
}

struct NavRequest: Equatable { var tab: String; var token = UUID() }

enum ChatRole { case user, assistant, tool, system, peer }   // peer = a teammate's message relayed to this session

struct ChatEntry: Identifiable, Equatable {
    var id: String
    var role: ChatRole
    var text: String
    var toolName: String?
    var time: Date?
    var isThinking = false
    var isError = false          // a failed tool result
    /// Text from JSONSerialization is a bridged NSString: every compare / hash / layout on it went through slow
    /// foreign-string paths on the main thread (the chat compares its entries on each redraw). Store native copies.
    init(id: String, role: ChatRole, text: String, toolName: String? = nil, time: Date? = nil, isThinking: Bool = false, isError: Bool = false) {
        var i = id, t = text, n = toolName
        i.makeContiguousUTF8(); t.makeContiguousUTF8(); n?.makeContiguousUTF8()
        self.id = i; self.role = role; self.text = t; self.toolName = n; self.time = time; self.isThinking = isThinking; self.isError = isError
    }
}

struct UsageMeter: Equatable, Identifiable {
    var id: String { label }
    var label: String
    var percent: Int
    var resets: String

    /// Length of the limit window: 5 h for the session limit, 7 days for weekly ones.
    var window: TimeInterval { label.lowercased().contains("session") ? 5 * 3600 : 7 * 86400 }

    /// "Oct 14 at 3:59pm (America/New_York)" -> Date
    var resetDate: Date? {
        var s = resets, tz = TimeZone.current
        if let o = s.firstIndex(of: "("), let c = s.firstIndex(of: ")"), o < c {
            if let z = TimeZone(identifier: String(s[s.index(after: o)..<c])) { tz = z }
            s = String(s[..<o])
        }
        s = s.trimmingCharacters(in: .whitespaces)
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = tz
        f.amSymbol = "am"; f.pmSymbol = "pm"
        let year = Calendar.current.component(.year, from: Date())
        for fmt in ["MMM d 'at' h:mma yyyy", "MMM d 'at' ha yyyy", "MMM d, h:mma yyyy", "MMM d, ha yyyy"] {
            f.dateFormat = fmt
            if var d = f.date(from: "\(s) \(year)") {
                if d < Date().addingTimeInterval(-86400) { d = Calendar.current.date(byAdding: .year, value: 1, to: d) ?? d }
                return d
            }
        }
        return nil
    }
    /// Fraction of the current window already elapsed (0…1).
    var elapsed: Double? {
        guard let r = resetDate else { return nil }
        return min(1, max(0, 1 - r.timeIntervalSinceNow / window))
    }
    /// Where usage ends at the current pace (percent of the limit; can pass 100).
    var projected: Int? {
        guard let e = elapsed, e > 0.02 else { return nil }
        return Int((Double(percent) / e).rounded())
    }
    var remainingText: String {
        guard let r = resetDate else { return "" }
        let s = max(0, Int(r.timeIntervalSinceNow))
        if s >= 86400 { return "\(s / 86400)일 \(s % 86400 / 3600)시간 남음" }
        return "\(s / 3600)시간 \(s % 3600 / 60)분 남음"
    }
}
