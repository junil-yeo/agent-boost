import Foundation
import SwiftUI
import AppKit

/// Single source of truth. Rebuilt from Claude's own files on every tick; the
/// only thing the board persists is a memory of members it has seen, so an
/// ended teammate keeps its card until the team itself is gone.
@MainActor
final class BoardStore: ObservableObject {
    @Published var teams: [Team] = []
    @Published var loose: [Agent] = []          // live sessions not in any team
    @Published var chat: [String: [ChatEntry]] = [:]
    @Published var meters: [UsageMeter] = []
    @Published var usageUpdated: Date?
    @Published var usageError: String?
    @Published var usageBusy = false
    @Published private(set) var rebooting = false          // the refresh button: gauges run their power-on sweep, the rocket flies
    @Published private(set) var rebootGen = 0
    /// The refresh button: usage and sessions again, shown with the start-up look (gauge sweep + rocket) for at least one pass.
    func manualRefresh() {
        guard !rebooting else { return }
        rebooting = true; rebootGen += 1
        refresh()
        Task {
            let start = Date()
            // an automatic read already under way: wait for it instead of skipping, so the sweep ends with fresh numbers
            while usageBusy { try? await Task.sleep(for: .milliseconds(200)) }
            await fetchUsage()
            let left = 2.6 - Date().timeIntervalSince(start)   // one full needle sweep
            if left > 0 { try? await Task.sleep(for: .seconds(left)) }
            refresh()
            rebooting = false
        }
    }
    @Published private(set) var loggedOut = false           // the CLI is installed but has no account signed in
    @Published private(set) var firstScanDone = false   // UI only: the board shows its loading look until the first scan lands
    @Published var selectedTeam: String?
    @Published var selectedAgent: String? {
        didSet { if let v = selectedAgent { recentFocus.removeAll { $0 == v }; recentFocus.append(v); if recentFocus.count > 5 { recentFocus.removeFirst() } } }
    }
    /// Chats kept current: the last few chosen sessions (other tabs keep theirs on screen) and every open split pane.
    /// Only the selected one used to be read, so a chat shown elsewhere froze (its sent message stuck as "전송 중").
    private var recentFocus: [String] = []
    var paneChats: [String: Int] = [:]
    private var liveChats: Set<String> {
        // terminal-screen mode: chats with a pane are not rebuilt from the transcript at all
        let ids = Set(recentFocus).union(paneChats.filter { $0.value > 0 }.keys)
        let all = teams.flatMap(\.members) + loose
        return ids.filter { id in !(all.first { $0.sessionId == id }.map { $0.tmuxPane != nil && $0.state != .ended } ?? false) }
    }
    /// Every notice is also kept in a log the alert strip can scroll back through.
    @Published var notice: String? {
        didSet { if let n = notice, n != oldValue { noticeLog.insert(NoticeItem(at: Date(), text: n), at: 0); if noticeLog.count > 300 { noticeLog.removeLast(noticeLog.count - 300) } } }
    }
    @Published var noticeLog: [NoticeItem] = []
    @Published var launches: [Launch] = []
    @Published var spawnChecks: [SpawnCheck] = []
    @Published var navRequest: NavRequest?
    @Published var selection = Set<String>()   // name cards checked on the board
    @Published var archive: [String: ArchivedItem] = [:]
    @Published var archiveSelection = Set<String>()
    private let archiveURL = URL(fileURLWithPath: Shell.home + "/.agent-boost/archived.json")
    private var pendingRenames: [String: String] = [:]   // sessionId -> name (sent when idle)
    private var pendingCommands: [String: [String]] = [:] // sessionId -> slash commands (sent when idle)
    private let deletedURL = URL(fileURLWithPath: Shell.home + "/.agent-boost/deleted-sessions.json")
    private var deleted = Set<String>()

    private let reader = TranscriptReader()
    var launchTab: String?
    private var timer: Timer?
    private var tick = 0
    private var transcriptIndex: [String: String] = [:]   // sessionId -> path
    private var paneSessionMap: [String: String] = [:]     // pane -> tmux session name
    private let memoryURL = URL(fileURLWithPath: Shell.home + "/.agent-boost/seen-members.json")
    private var seen: [String: [String: SeenMember]] = [:] // team -> sessionId -> member
    /// Human names for CLI background jobs (the CLI names a job by its id): the name of the interactive session whose
    /// conversation was moved into the job, kept so the card reads the same once that viewer is gone.
    private let jobNamesURL = URL(fileURLWithPath: Shell.home + "/.agent-boost/job-names.json")
    private var jobNames: [String: String] = [:]
    private var lastJobs: [String: JobInfo] = [:]            // ~/.claude/jobs as of the last refresh

    struct SeenMember: Codable { var sessionId: String; var name: String; var agentType: String?; var teamAddress: String?; var isLead: Bool; var firstSeen: Date; var lastSeen: Date; var origin: String? }

    static weak var shared: BoardStore?
    init() {
        BoardStore.shared = nil
        if let d = try? Data(contentsOf: memoryURL), let m = try? JSONDecoder().decode([String: [String: SeenMember]].self, from: d) { seen = m }
        if let d = try? Data(contentsOf: deletedURL), let s = try? JSONDecoder().decode(Set<String>.self, from: d) { deleted = s }
        if let d = try? Data(contentsOf: jobNamesURL), let s = try? JSONDecoder().decode([String: String].self, from: d) { jobNames = s }
        try? FileManager.default.removeItem(atPath: Shell.home + "/.agent-boost/seen-sessions.json")   // older boards kept a session list of their own; the CLI's files are the list now
        if let d = try? Data(contentsOf: archiveURL), let a = try? JSONDecoder().decode([String: ArchivedItem].self, from: d) { archive = a }
        // after init: a property observer does not run inside init, so a notice set here never reached the log
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if !FileManager.default.isExecutableFile(atPath: Shell.tmux) {
                notice = L("tmux를 찾을 수 없습니다 (%@). 세션 시작·입력·종료가 동작하지 않습니다. 설치: brew install tmux", "\(Shell.tmux)")
            } else if !FileManager.default.isExecutableFile(atPath: Shell.claude) {
                notice = L("Claude Code CLI를 찾을 수 없습니다 (%@). 설치: https://claude.ai/code 안내를 따르거나 터미널에서 npm install -g @anthropic-ai/claude-code", "\(Shell.claude)")
            }
        }
        let args = ProcessInfo.processInfo.arguments
        if let i = args.firstIndex(of: "--tab"), i + 1 < args.count { selectedTeam = args[i + 1]; launchTab = args[i + 1] }
        if let i = args.firstIndex(of: "--agent"), i + 1 < args.count { selectedAgent = args[i + 1] }
        TmuxCache.onAutoConfirm = { [weak self] pane in DispatchQueue.main.async {
            guard let self, let a = (self.teams.flatMap(\.members) + self.loose).first(where: { $0.tmuxPane == pane }) else { return }
            self.addEcho(L("모델 전환 확인창에 자동으로 Yes를 선택했습니다 (직접 고른 모델 변경)"), sid: a.sessionId, ttl: 60, auto: true)
        } }
        TmuxControl.onWarning = { [weak self] m in DispatchQueue.main.async { self?.notice = m } }
        TmuxControl.onLost = { [weak self] sid in DispatchQueue.main.async {
            guard let self else { return }
            self.bounce = Bounce(sid: sid, gen: self.bounce.gen + 1)
            self.notice = L("'%@'이(가) 메시지를 받지 않았습니다. 입력창에 되돌려 놓았으니 다시 보내 주세요.", self.agent(sid)?.name ?? L("세션"))
        } }
        TmuxControl.onDone = { [weak self] sid in self?.sending.remove(sid) }
        DispatchQueue.global().async { Shell.tmux(["set-environment", "-g", "PATH", Shell.path]) }
        BoardStore.shared = self
        CLICheck.start(self)
        // conversation search reads every transcript once (~0.5 s); done ahead so the search window opens at once
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 15) { ConvoIndex.shared.refresh() }
        // the tmux cache must exist before the first refresh: otherwise every pane is unknown ("view only" flicker) and
        // resumeSavedSessions would judge liveness from an empty cache
        afterFirstRefresh = { [unowned self] in
            if !emptyTeams.isEmpty { pruneEmptyTeams(silent: true) }
            if !ProcessInfo.processInfo.arguments.contains("--snapshot") { resumeSavedSessions() }
        }
        refreshSoon()
        timer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in Task { @MainActor in self?.refreshSoon() } }
        Task.detached { [weak self] in await self?.fetchUsage() }
    }

    // MARK: refresh
    /// Collects tmux state on a background thread, then refreshes on main (cheap: no process spawns).
    private var refreshing = false, refreshDirty = false
    private var afterFirstRefresh: (() -> Void)?
    func refreshSoon() {
        if refreshing { refreshDirty = true; return }       // coalesce: run once more when the current one ends
        refreshing = true
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            TmuxCache.update()
            DispatchQueue.main.async {
                guard let self else { return }
                self.refresh()
                if !self.firstScanDone { self.firstScanDone = true }   // set once; never published again
                if let f = self.afterFirstRefresh { self.afterFirstRefresh = nil; f() }
                self.refreshing = false
                if self.refreshDirty { self.refreshDirty = false; self.refreshSoon() }
            }
        }
    }
    func refresh() {
        tick += 1
        let panes = TmuxCache.panes
        let paneSess = TmuxCache.paneSessions
        paneSessionMap = paneSess
        let paneByPid = Dictionary(panes.map { ($1, $0) }, uniquingKeysWith: { a, _ in a })
        let jobs = loadJobs(); lastJobs = jobs
        var sessions = loadSessions(paneByPid: paneByPid, jobs: jobs)
        let parkedOriginals = mergeViewers(&sessions, panes: panes)
        for (k, var a) in sessions {
            if let p = a.tmuxPane, paneSess[p]?.hasPrefix("ab-") == true { a.origin = "board" }
            sessions[k] = a
        }
        let (teamsRaw, memberSessionIds) = loadTeams(sessions: sessions, panes: panes, hidden: parkedOriginals)
        let focus = liveChats
        var all = teamsRaw
        var looseAgents: [Agent] = []
        for var a in sessions.values where !memberSessionIds.contains(a.sessionId) && archive[a.sessionId] == nil {
            enrich(&a, wantEntries: focus.contains(a.sessionId))
            looseAgents.append(a)
        }
        // a conversation the CLI still lists as a background job is drawn from the job record below, never twice
        let jobSids = Set(jobs.values.flatMap { [$0.sessionId, $0.resumeSessionId].compactMap { $0 } })
        // ended conversations = every transcript the CLI could resume (what its /resume picker lists) that is not running
        // anywhere. The board keeps no list of its own, so it cannot drift from the CLI's: a transcript removed elsewhere drops
        // its card, one made elsewhere (a terminal, the desktop app) gets one.
        // (a parked viewer's own transcript is the frozen pre-move copy of a conversation that now lives in the job: not a card
        // while the viewer is alive, just as `claude agents` does not list the viewer)
        let claimed = Set(sessions.keys).union(memberSessionIds).union(jobSids).union(parkedOriginals)
        let memberPaths = Set(memberSessionIds.compactMap { transcriptIndex[$0] })     // teammates' transcripts belong to their team cards
        for (sid, path) in transcriptList() where !claimed.contains(sid) && !memberPaths.contains(path) && archive[sid] == nil {
            if transcriptIndex[sid] != path { transcriptIndex[sid] = path }
            var a = Agent(sessionId: sid, pid: nil, name: "", state: .ended)
            a.cwd = transcriptCwd(path)
            enrich(&a, wantEntries: focus.contains(sid))
            if a.name.isEmpty { a.name = String(sid.prefix(8)) }
            looseAgents.append(a)
        }
        // CLI background jobs with no live process: the CLI's own list (`claude agents`, its ← screen) still shows them, so
        // the board does too. One card per job, matched by job id: a job's session id changes when the CLI resumes it.
        let liveJobs = Set(sessions.values.compactMap(\.jobId))
        for job in jobs.values.sorted(by: { $0.id < $1.id }) where !liveJobs.contains(job.id) && !jobRemoving.contains(job.id) {
            let sid = job.sessionId
            // the conversation already has a card (an ended team lead from memory, under the id it ran with last): mark that
            // card as the job rather than drawing a second one, so deleting it removes the CLI's record too
            let ids = [sid, job.resumeSessionId].compactMap { $0 }
            if let ti = all.indices.first(where: { all[$0].members.contains { ids.contains($0.sessionId) } }),
               let mi = all[ti].members.firstIndex(where: { ids.contains($0.sessionId) }) {
                if all[ti].members[mi].jobId == nil { all[ti].members[mi].jobId = job.id; all[ti].members[mi].isBackgroundJob = true }
                continue
            }
            if let li = looseAgents.firstIndex(where: { ids.contains($0.sessionId) }) {
                if looseAgents[li].jobId == nil { looseAgents[li].jobId = job.id; looseAgents[li].isBackgroundJob = true }
                continue
            }
            guard !deleted.contains(sid), archive[sid] == nil else { continue }
            var a = Agent(sessionId: sid, pid: nil, name: jobNames[job.id] ?? job.name, state: .ended)
            a.jobId = job.id; a.isBackgroundJob = true; a.cwd = job.cwd
            // the transcript the CLI links to the job; until it writes one, the conversation the job was resumed from
            if let t = job.transcript, FileManager.default.fileExists(atPath: t) { if transcriptIndex[sid] != t { transcriptIndex[sid] = t } }
            else if transcript(for: sid) == nil, let r = job.resumeSessionId, r != sid, let t = transcript(for: r) { transcriptIndex[sid] = t }
            enrich(&a, wantEntries: focus.contains(sid))
            if a.lastActivity == nil { a.lastActivity = job.updatedAt }
            looseAgents.removeAll { $0.sessionId == sid }
            looseAgents.append(a)
        }
        for ti in all.indices {
            for mi in all[ti].members.indices { enrich(&all[ti].members[mi], wantEntries: focus.contains(all[ti].members[mi].sessionId)) }
            all[ti].members.sort { ($0.isLead ? 0 : 1, $0.name) < ($1.isLead ? 0 : 1, $1.name) }
        }
        // every session is the lead of an implicit team; until it has a teammate it is an individual session
        for t in all where t.isSolo {
            var a = t.members.first { !$0.isSubagent }!; a.solo = true
            if a.state == .ended && a.transcriptPath == nil {
                if let last = seen[t.name]?[a.sessionId]?.lastSeen, Date().timeIntervalSince(last) > 600 { seen[t.name] = nil }
                continue
            }
            looseAgents.removeAll { $0.sessionId == a.sessionId }
            looseAgents.append(a)
        }
        all.removeAll(where: \.isSolo)
        all.sort { ($0.liveCount > 0 ? 0 : 1, $0.createdAt ?? .distantPast) < ($1.liveCount > 0 ? 0 : 1, $1.createdAt ?? .distantPast) }
        looseAgents.sort { ($0.state == .ended ? 1 : 0, $0.name) < ($1.state == .ended ? 1 : 0, $1.name) }
        TmuxCache.setWanted(Set((all.flatMap(\.members) + looseAgents).compactMap(\.tmuxPane)))
        trackLaunches(knownPids: Set(sessions.values.compactMap(\.pid)), usedPanes: Set((all.flatMap(\.members) + looseAgents).compactMap(\.tmuxPane)))
        if !spawnChecks.isEmpty { verifySpawns(all.flatMap(\.members) + looseAgents) }
        for (tmux, specs) in pendingRespawn {
            let panePid = paneSess.first { $0.value == tmux }.flatMap { panes[$0.key] }
            if let lead = (all.flatMap(\.members) + looseAgents).first(where: { $0.pid == panePid && $0.state == .idle }) {
                pendingRespawn[tmux] = nil
                addTeammates(specs, to: lead)
                notice = L("'%@' 다시 시작 — 팀원 %@명을 같은 이름·모델로 다시 만드는 중입니다 (Claude는 재개 시 팀원을 복원하지 않음).", lead.name, String(specs.count))
            }
        }
        if teams != all { teams = all }
        let known = Set(all.flatMap(\.members).map(\.sessionId) + looseAgents.map(\.sessionId))
        if !selection.isSubset(of: known) { selection = selection.intersection(known) }
        if loose != looseAgents { loose = looseAgents }
        if selectedTeam == nil { selectedTeam = all.first?.name }
        if tick % 150 == 0 { Task.detached { [weak self] in await self?.fetchUsage() } }
        if tick % 10 == 0 { saveSeen() }
        let live = all.flatMap(\.members) + looseAgents
        let busy = live.filter { $0.state == .busy }.count, waiting = live.filter { $0.state == .needsInput }.count
        NSApp?.dockTile.badgeLabel = waiting > 0 ? L("응답 %@", String(waiting)) : (busy > 0 ? "\(busy)" : nil)
        for (sid, cmds) in pendingCommands {
            guard let a = agent(sid), a.state != .ended, let p = a.tmuxPane else { pendingCommands[sid] = nil; continue }
            if pendingSince[sid] == nil { pendingSince[sid] = Date() }
            if a.state == .needsInput { if heldNotified.insert(sid).inserted { notice = L("'%@' 에이전트가 질문에 답을 기다리는 중이라 %@ 을(를) 대기시킵니다. 화면이 잘못 인식된 경우 '그래도 보내기'를 누르세요.", a.name, cmds.first ?? "") } }
            else { heldNotified.remove(sid) }
            // the pane shows a CLI list / picker, or someone types there from a terminal: anything sent now would go astray
            if let o = a.overlay {
                if heldNotified.insert(sid + "|overlay").inserted { notice = L("'%@'의 CLI가 %@ 화면이라 %@ 을(를) 보류합니다. CLI에서 Esc로 대화로 돌아오면 보냅니다.", a.name, Self.overlayName(o), cmds.first ?? "") }
                continue
            } else { heldNotified.remove(sid + "|overlay") }
            if TmuxCache.foreignTyped(p) {
                if heldNotified.insert(sid + "|typed").inserted { notice = L("'%@'의 CLI 입력창에 입력 중인 글이 있어 %@ 을(를) 보류합니다 (터미널에서 같이 쓰는 중). 그 글을 보내거나 지우면 이어서 보냅니다.", a.name, cmds.first ?? "") }
                continue
            } else { heldNotified.remove(sid + "|typed") }
            let settled = TmuxCache.isSettled(p)
            if !settled, !a.working, TmuxCache.busy(p) == nil, let t = pendingSince[sid], Date().timeIntervalSince(t) > 10 {
                // never captured (pane known only from the session file): one background check
                if probing.insert(p).inserted {
                    DispatchQueue.global(qos: .utility).async {
                        let ok = TmuxCache.probe(p)
                        DispatchQueue.main.async { [weak self] in self?.probing.remove(p); if !ok { self?.unreachable.insert(p) }; self?.refreshSoon() }
                    }
                }
            }
            if unreachable.contains(p) {
                notice = L("'%@' 은(는) 이 tmux 서버에 없는 pane이라 제어할 수 없습니다 — 대기 중이던 %@ 명령을 취소했습니다.", a.name, cmds.first ?? "")
                pendingCommands[sid] = nil; pendingSince[sid] = nil; continue
            }
            if !a.working, settled, let first = cmds.first {
                pendingSince[sid] = nil
                pendingCommands[sid] = cmds.count > 1 ? Array(cmds.dropFirst()) : nil
                if first == "/exit" { quit(a, mode: .now); continue }        // the right way out differs per kind of session
                sendSlash(first, to: p, sid: sid)
            }
        }
        for (sid, name) in pendingRenames {
            guard let a = agent(sid) else { pendingRenames[sid] = nil; continue }
            if !a.working, let p = a.tmuxPane, TmuxCache.isSettled(p) { TmuxCache.markSent(p, busy: false); TmuxControl.rename(name, pane: p); pendingRenames[sid] = nil }
            else if a.state == .ended { pendingRenames[sid] = nil; writeTitle(name, for: a) }
        }
    }

    // MARK: in-process subagents (Agent tool) — they never get a pane or a team config entry
    private var subScan: [String: (at: Date, items: [Agent])] = [:]
    /// For every live session: its subagents started since the process began (newest 8), read off
    /// <transcript dir>/<sessionId>/subagents/agent-*.jsonl + .meta.json. Re-scanned every 4 s per session.
    private func subagents(of p: Agent) -> [Agent] {
        guard p.state != .ended, let path = p.transcriptPath, let pid = p.pid else { return [] }
        if let c = subScan[p.sessionId], Date().timeIntervalSince(c.at) < 4 { return c.items }
        let sid = ((path as NSString).lastPathComponent as NSString).deletingPathExtension
        let dir = ((path as NSString).deletingLastPathComponent as NSString).appendingPathComponent(sid + "/subagents")
        let since = Self.processStart(pid) ?? Date().addingTimeInterval(-6 * 3600)
        var out: [(Date, Agent)] = []
        for f in (try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? [] where f.hasSuffix(".jsonl") {
            let full = dir + "/" + f
            guard let m = (try? FileManager.default.attributesOfItem(atPath: full))?[.modificationDate] as? Date, m >= since else { continue }
            let id = String(f.dropLast(6))
            let meta = (try? Data(contentsOf: URL(fileURLWithPath: dir + "/" + id + ".meta.json"))).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
            let key = "sub:" + p.sessionId + ":" + id
            var a = Agent(sessionId: key, pid: nil, name: (meta["description"] as? String) ?? id)
            a.isSubagent = true; a.parentSid = p.sessionId
            a.agentType = meta["agentType"] as? String
            a.state = Date().timeIntervalSince(m) < 20 ? .busy : .ended
            a.cwd = p.cwd
            transcriptIndex[key] = full
            out.append((m, a))
        }
        let items = out.sorted { $0.0 > $1.0 }.prefix(8).map(\.1)
        subScan[p.sessionId] = (Date(), items)
        return items
    }
    private func attachSubagents(teams: inout [Team], loose: inout [Agent]) {
        let focus = liveChats
        func enriched(_ list: [Agent]) -> [Agent] { list.map { var a = $0; enrich(&a, wantEntries: focus.contains(a.sessionId)); return a } }
        for ti in teams.indices {
            let subs = enriched(teams[ti].members.filter { !$0.isSubagent }.flatMap { subagents(of: $0) })
            if !subs.isEmpty { teams[ti].members.append(contentsOf: subs) }
        }
        var extra: [Agent] = []
        for a in loose where !a.isSubagent { extra += enriched(subagents(of: a)) }
        loose.append(contentsOf: extra)
    }

    // MARK: answering Claude Code's choice windows from inside the app
    @Published var promptSending: Set<String> = []        // sessionIds with an answer on its way

    /// Picks option `optionIndex` (0-based) of the prompt the agent waits on: re-reads the pane first, walks the cursor with
    /// Up/Down (number keys behave differently between versions) and presses Enter; then checks the prompt is gone.
    func answerPrompt(_ a: Agent, optionIndex: Int) {
        guard let p = a.tmuxPane, let expected = a.prompt, expected.options.indices.contains(optionIndex), !promptSending.contains(a.sessionId) else { return }
        promptSending.insert(a.sessionId)
        let sid = a.sessionId
        TmuxControl.queue(p) { [weak self] in
            let msg = PromptDriver.answer(pane: p, expected: expected, optionIndex: optionIndex)
            DispatchQueue.main.async { self?.promptSending.remove(sid); if let msg { self?.notice = msg }; self?.refreshSoon() }
        }
    }
    /// Esc: cancels / declines whatever the window asks.
    func cancelPrompt(_ a: Agent) {
        guard let p = a.tmuxPane, !promptSending.contains(a.sessionId) else { return }
        TmuxControl.interrupt(p)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in self?.refreshSoon() }
    }

    func holdOlderRows(_ hold: Bool, sid: String) { if let p = transcriptIndex[sid] { reader.setHoldCap(hold, path: p) }; if !hold { refreshSoon() } }

    /// Sends the first queued command although the screen looks like it waits for an answer.
    func forceSendPending(_ a: Agent) {
        guard let p = a.tmuxPane, let cmds = pendingCommands[a.sessionId], let first = cmds.first else { return }
        let alert = NSAlert()
        alert.messageText = L("'%@' 에 %@ 을(를) 지금 보낼까요?", a.name, first)
        alert.informativeText = L("질문이나 권한 요청이 떠 있으면 Enter가 첫 번째 선택(허용)을 확정할 수 있습니다. 'Esc 후 보내기'는 먼저 Esc로 프롬프트를 닫습니다(거절로 처리될 수 있음).")
        alert.addButton(withTitle: L("취소"))
        alert.addButton(withTitle: L("Esc 후 보내기"))
        alert.addButton(withTitle: L("그대로 보내기"))
        let r = alert.runModal()
        guard r != .alertFirstButtonReturn else { return }
        if r == .alertSecondButtonReturn { TmuxControl.interrupt(p, settle: 0.6) }
        sendSlash(first, to: p, sid: a.sessionId)
        pendingCommands[a.sessionId] = cmds.count > 1 ? Array(cmds.dropFirst()) : nil
        refresh()
    }

    private func enrich(_ a: inout Agent, wantEntries: Bool) {
        if let p = a.tmuxPane { a.tmuxSession = paneSessionMap[p] }
        if let pending = pendingRenames[a.sessionId] { a.pendingName = pending }
        a.pendingCommands = pendingCommands[a.sessionId] ?? []
        guard let path = transcript(for: a.sessionId) else { return }
        a.transcriptPath = path
        if a.tmuxPane != nil, a.working { a.queued = Self.queuedCount(path) }
        let mode = reader.effective(path, wantEntries ? .full : (a.state == .ended ? .skip : .light))
        let loading = reader.needsWarm(path, mode: mode, done: { [weak self] in self?.refreshSoon() })   // first / upgrade parse runs in the background
        let s = loading ? reader.peek(path) : reader.snapshot(path, mode: mode)
        // model: transcript > what the user asked for / last known (cache) > launch flag (a guess)
        if let m = s.model { a.model = m; a.modelIsGuess = false }
        else if a.model == nil, a.state != .ended, let pid = a.pid, let m = Self.flag("--model", in: Self.cmdline(pid)) { a.model = Self.expandModelAlias(m); a.modelIsGuess = true }
        a.effort = s.effort ?? a.effort; a.tokens = s.tokens; a.tokensEstimated = loading; a.lastActivity = s.last
        a.contextTokens = s.lastContext > 0 ? s.lastContext : nil
        if a.state == .ended {
            // named like the CLI's /resume picker: a stored title, else what the user first asked
            if let t = Self.storedTitle(forTranscript: path) ?? s.customTitle ?? s.aiTitle { a.name = t }
            else if a.name.isEmpty, let f = s.firstPrompt { a.name = String(f.prefix(48)) }
        }
        if let r = requested[a.sessionId] {
            // show the user's choice right away; drop it once the transcript agrees, or after 10 min
            if let m = r.model { if (s.model ?? "").hasPrefix(m) { requested[a.sessionId]?.model = nil } else { a.model = m; a.modelIsGuess = false; if !confirmed.contains(a.sessionId + "|/model") { a.requestedModel = m } } }
            if let e = r.effort { if s.effort == e && a.pendingCommands.isEmpty { requested[a.sessionId]?.effort = nil } else { a.effort = e; if !confirmed.contains(a.sessionId + "|/effort") { a.requestedEffort = e } } }
            if Date().timeIntervalSince(r.at) > 600 { requested[a.sessionId] = nil }
        }
        // sessions the board cannot type into (Claude desktop app etc.): their status file can lag;
        // if the transcript's last word is a finished assistant turn, they are idle
        if a.tmuxPane == nil, a.working, s.lastTurnEnded { a.state = .idle }
        if wantEntries && !loading {
            var entries = s.entries
            if var pend = echoes[a.sessionId] {
                // drop echoes the transcript now holds (same text, written after the echo was made) or that expired
                let tail = entries.suffix(40).filter { $0.role == .user }
                var queue: [String]?                                       // read only when an echo is overdue
                pend.removeAll { e in
                    // the CLI rewrites what it records (attachments → "[Image #n]", long pastes → <pasted_content>): the
                    // echo's opening words inside a newer user record count as "arrived"
                    let head = String(Self.squash(e.text).prefix(30))
                    if tail.contains(where: { ($0.time ?? .distantPast) >= e.at.addingTimeInterval(-2) && (Self.squash($0.text) == Self.squash(e.text) || (!head.isEmpty && Self.squash($0.text).contains(head))) }) { return true }
                    guard Date().timeIntervalSince(e.at) > e.ttl else { return false }
                    if e.auto { return true }
                    // still waiting in the CLI's own queue behind a long turn: keep showing it as being sent (up to 30 min)
                    if queue == nil { queue = Self.queuedTexts(path) }
                    if Date().timeIntervalSince(e.at) < 1800, !(queue ?? []).isEmpty { return false }
                    // never showed up: say so in the chat instead of letting it vanish
                    lostEchoes[a.sessionId, default: []].append(e)
                    notice = L("'%@'에 보낸 메시지가 CLI 기록에서 확인되지 않습니다. 세션 터미널(CLI 화면)에서 입력창에 남아 있는지 확인하세요.", a.name)
                    return true
                }
                echoes[a.sessionId] = pend.isEmpty ? nil : pend
            }
            if var lost = lostEchoes[a.sessionId] {
                // a late arrival (or 30 minutes) clears the warning
                lost.removeAll { e in
                    let head = String(Self.squash(e.text).prefix(30))
                    return Date().timeIntervalSince(e.at) > 1800
                        || entries.suffix(40).contains { $0.role == .user && ($0.time ?? .distantPast) >= e.at.addingTimeInterval(-2) && !head.isEmpty && Self.squash($0.text).contains(head) }
                }
                lostEchoes[a.sessionId] = lost.isEmpty ? nil : lost
            }
            boardSlashes[a.sessionId]?.removeAll { Date().timeIntervalSince($0.at) > 600 }
            // everything the chat is built from, as one signature: unchanged -> nothing to rebuild or compare
            let lastSlash = boardSlashes[a.sessionId]?.last?.at.timeIntervalSince1970 ?? 0
            let sig = "\(path)|\(s.offset)|\(s.version)|" + (echoes[a.sessionId] ?? []).map(\.id).joined(separator: ",") + "|" + (lostEchoes[a.sessionId] ?? []).map(\.id).joined(separator: ",") + "|\(boardSlashes[a.sessionId]?.count ?? 0)|\(lastSlash)"
            if chatSig[a.sessionId] == sig, chat[a.sessionId] != nil { return }
            chatSig[a.sessionId] = sig
            if var bs = boardSlashes[a.sessionId] {
                bs.removeAll { Date().timeIntervalSince($0.at) > 600 }
                boardSlashes[a.sessionId] = bs.isEmpty ? nil : bs
                for i in entries.indices where entries[i].role == .user && entries[i].text.hasPrefix("/") {
                    let t = entries[i].text, at = entries[i].time ?? .distantPast
                    if bs.contains(where: { $0.text == t && at >= $0.at.addingTimeInterval(-2) }) {
                        entries[i] = ChatEntry(id: entries[i].id, role: .system, text: t, toolName: "auto", time: entries[i].time)
                    }
                }
            }
            for e in lostEchoes[a.sessionId] ?? [] {
                entries.append(ChatEntry(id: e.id + "-lost", role: .system, text: L("⚠ 전달 확인 안 됨 — %@", e.text), toolName: "stderr", time: e.at))
            }
            for e in echoes[a.sessionId] ?? [] {
                entries.append(e.auto ? ChatEntry(id: e.id, role: .system, text: e.text, toolName: "auto", time: e.at) : ChatEntry(id: e.id, role: .user, text: e.text, toolName: "전송 중", time: e.at))
            }
            chat[a.sessionId] = entries
        }
    }

    private func transcript(for sid: String) -> String? {
        if let p = transcriptIndex[sid], FileManager.default.fileExists(atPath: p) { return p }
        if sid.contains("/") {                         // teammate key "team/name": look it up now
            let parts = sid.split(separator: "/", maxSplits: 1).map(String.init)
            if let p = teammateTranscript(team: parts[0], agent: parts[1], since: nil) { transcriptIndex[sid] = p; return p }
            return nil
        }
        let root = Shell.home + "/.claude/projects"
        guard let dirs = try? FileManager.default.contentsOfDirectory(atPath: root) else { return nil }
        for d in dirs {
            let p = "\(root)/\(d)/\(sid).jsonl"
            if FileManager.default.fileExists(atPath: p) { transcriptIndex[sid] = p; return p }
        }
        return nil
    }

    // MARK: one card per conversation
    /// The CLI's "← agents" screen moves an interactive session's conversation into a background job: from then on the
    /// interactive process is only a viewer (its session file carries `parkedJobId`; `claude agents` lists the job, not it),
    /// and `claude attach <job>` is the same kind of viewer without a session file. The job is the card. It borrows the
    /// viewer's pane (so the board can type into it) and the viewer's name; the viewer is never a card of its own.
    @discardableResult
    private func mergeViewers(_ sessions: inout [String: Agent], panes: [String: Int]) -> Set<String> {
        var viewers: [String: Agent] = [:]                       // job id -> viewer
        var hidden = Set<String>()                               // session ids of parked viewers
        for (k, a) in sessions where !a.isBackgroundJob {
            guard let j = a.parkedJobId else { continue }
            viewers[j] = a; sessions[k] = nil; hidden.insert(k)
            if a.nameSource == "user", !a.name.isEmpty, jobNames[j] != a.name { jobNames[j] = a.name }
        }
        for (pane, pid) in panes {
            guard let j = attachedJob(panePid: pid), viewers[j] == nil else { continue }
            var v = Agent(sessionId: "attach:" + j, pid: pid, name: ""); v.tmuxPane = pane
            viewers[j] = v
        }
        for (k, var b) in sessions where b.isBackgroundJob {
            guard let j = b.jobId else { continue }
            if b.name == j || b.name.isEmpty, let n = jobNames[j] { b.name = n }
            if let v = viewers.removeValue(forKey: j) {
                b.tmuxPane = v.tmuxPane; b.viewerPid = v.pid; b.parkedJobId = j
                if v.nameSource == "user", !v.name.isEmpty { b.name = v.name }
                if let p = b.tmuxPane {
                    b.overlay = TmuxCache.overlay(p)
                    if b.overlay == nil, let st = TmuxCache.state(p) {
                        b.stateUnconfirmed = unconfirmed(sid: b.sessionId, file: b.state, screen: st)
                        b.state = st; b.prompt = st == .needsInput ? TmuxCache.prompt(p) : nil; b.screen = TmuxCache.status(p)
                    }
                }
            }
            sessions[k] = b
        }
        // a viewer whose job is gone (stopped from the CLI): an interactive process with nothing behind it, shown as such
        for (j, v) in viewers where !v.sessionId.hasPrefix("attach:") { var a = v; a.parkedJobId = j; sessions[a.sessionId] = a; hidden.remove(a.sessionId) }
        return hidden
    }
    private var attachScan: [Int: (job: String?, tick: Int)] = [:]
    /// `claude attach <job>` as a pane's process (or its child): the job id. Found by command line, re-checked every 30 s.
    private func attachedJob(panePid pid: Int) -> String? {
        if let c = attachScan[pid], c.job != nil || tick - c.tick < 15 { return c.job }
        var found: String?
        let kids = Shell.run(["/usr/bin/pgrep", "-P", String(pid)], timeout: 2).out.split(separator: "\n").compactMap { Int($0.trimmingCharacters(in: .whitespaces)) }
        for p in [pid] + kids {
            let parts = Self.cmdline(p).split(separator: " ").map(String.init)
            guard parts.first?.lowercased().contains("claude") == true, let i = parts.firstIndex(of: "attach"), i + 1 < parts.count,
                  parts[i + 1].count == 8, parts[i + 1].allSatisfy(\.isHexDigit) else { continue }
            found = parts[i + 1]; break
        }
        attachScan[pid] = (found, tick)
        return found
    }
    static func overlayName(_ o: String) -> String { o == "agents" ? L("세션 목록(← agents)") : o == "resume" ? L("대화 선택(/resume)") : o }

    private var transcriptScan: (tick: Int, list: [(sid: String, path: String)]) = (-100, [])
    private static let probeProject = probeDir.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ".", with: "-")
    /// Every <id>.jsonl under ~/.claude/projects: the conversations `claude --resume` offers. Rescanned every other tick.
    private func transcriptList() -> [(sid: String, path: String)] {
        if tick - transcriptScan.tick < 2 { return transcriptScan.list }
        let fm = FileManager.default, root = Shell.home + "/.claude/projects"
        var out: [(sid: String, path: String)] = []
        for d in (try? fm.contentsOfDirectory(atPath: root)) ?? [] where d != Self.probeProject && !d.hasPrefix(".") {
            for f in (try? fm.contentsOfDirectory(atPath: "\(root)/\(d)")) ?? [] where f.hasSuffix(".jsonl") && !f.hasPrefix("agent-") {
                out.append((String(f.dropLast(6)), "\(root)/\(d)/\(f)"))
            }
        }
        transcriptScan = (tick, out)
        return out
    }
    private var cwdCache: [String: String] = [:]
    /// "cwd" of a transcript's first records, read once per file.
    private func transcriptCwd(_ path: String) -> String? {
        if let c = cwdCache[path] { return c }
        guard let fh = FileHandle(forReadingAtPath: path) else { return nil }
        let head = fh.readData(ofLength: 65_536); try? fh.close()
        for line in head.split(separator: 0x0A) {
            if let d = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any], let c = d["cwd"] as? String { cwdCache[path] = c; return c }
        }
        return nil
    }

    // MARK: CLI background jobs — ~/.claude/jobs/<id>/state.json, the list behind `claude agents` and the CLI's ← screen
    struct JobInfo: Equatable {
        var id: String; var name: String; var state: String; var sessionId: String
        var resumeSessionId: String?; var cwd: String?; var transcript: String?; var updatedAt: Date?
    }
    private var jobCache: [String: (stamp: String, info: JobInfo?)] = [:]     // parsed once per file version (size|mtime)
    private var jobRemoving = Set<String>()                                     // `claude stop/rm` in flight
    private static let isoFrac: ISO8601DateFormatter = { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f }()
    private func loadJobs() -> [String: JobInfo] {
        let root = Shell.home + "/.claude/jobs"
        let fm = FileManager.default
        guard let ids = try? fm.contentsOfDirectory(atPath: root) else { jobCache = [:]; return [:] }
        var out: [String: JobInfo] = [:], present = Set<String>()
        for id in ids {
            let p = "\(root)/\(id)/state.json"
            // no state.json: a process the CLI keeps warm for later (`claude bg-spare`) or a job not yet written; not a session
            guard let attrs = try? fm.attributesOfItem(atPath: p) else { continue }
            present.insert(id)
            let stamp = "\((attrs[.size] as? NSNumber)?.intValue ?? -1)|\((attrs[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0)"
            if let c = jobCache[id], c.stamp == stamp { if let i = c.info { out[id] = i }; continue }
            var info: JobInfo?
            if let d = try? Data(contentsOf: URL(fileURLWithPath: p)), let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
                let name = (j["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? id
                info = JobInfo(id: id, name: name, state: j["state"] as? String ?? "", sessionId: j["sessionId"] as? String ?? id,
                               resumeSessionId: j["resumeSessionId"] as? String, cwd: j["cwd"] as? String, transcript: j["linkScanPath"] as? String,
                               updatedAt: (j["updatedAt"] as? String).flatMap(Self.isoFrac.date(from:)))
            }
            jobCache[id] = (stamp, info)
            if let info { out[id] = info }
        }
        for k in jobCache.keys where !present.contains(k) { jobCache[k] = nil }
        return out
    }

    private func loadSessions(paneByPid: [Int: String], jobs: [String: JobInfo]) -> [String: Agent] {
        var out: [String: Agent] = [:]
        let dir = Shell.home + "/.claude/sessions"
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir) else { return out }
        for n in names where n.hasSuffix(".json") {
            guard let d = try? Data(contentsOf: URL(fileURLWithPath: dir + "/" + n)),
                  let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
                  let pid = j["pid"] as? Int, let sid = j["sessionId"] as? String else { continue }
            guard kill(pid_t(pid), 0) == 0 else { continue }          // process gone -> stale file
            guard isClaude(pid: pid, started: j["procStart"] as? String) else { continue }   // pid reused by another program
            if let c = j["cwd"] as? String, c == Self.probeDir || c.hasPrefix(Self.probeDir) { continue }   // our own usage probe
            var a = Agent(sessionId: sid, pid: pid, name: j["name"] as? String ?? sid.prefix(8).description)
            a.nameSource = j["nameSource"] as? String
            a.entrypoint = j["entrypoint"] as? String
            // the CLI derives a name on --resume even when the conversation has a stored title: show the stored one
            if a.nameSource == "derived", let path = transcript(for: sid), let t = Self.storedTitle(forTranscript: path) { a.name = t }
            a.isBackgroundJob = (j["kind"] as? String) == "bg"
            a.jobId = j["jobId"] as? String
            if a.isBackgroundJob, let id = a.jobId {
                // a background process the CLI does not list as a job is a spare it keeps warm: not a session of the user's
                guard let job = jobs[id] else { continue }
                if a.name.isEmpty || a.name == sid.prefix(8).description || a.name == id { a.name = job.name }
            }
            a.remoteControl = j["bridgeSessionId"] != nil   // Claude records the bridge while Remote Control is connected
            a.cwd = j["cwd"] as? String
            a.state = AgentState(rawValue: j["status"] as? String ?? "") ?? .unknown
            a.tmuxPane = paneByPid[pid] ?? Self.paneViaParent(pid: pid, paneByPid: paneByPid)
            // Claude's status file can lag or stick at "busy"; the footer shows "esc to interrupt"
            // only while a turn runs, so for a session in a pane the screen decides.
            // the screen decides when it can be read; only when it is unknown (not captured / timed out) the session file's status stands in.
            // The file can stick at "busy", so it never overrides a readable screen.
            a.parkedJobId = j["parkedJobId"] as? String
            if let p = a.tmuxPane {
                a.overlay = TmuxCache.overlay(p)                       // a list / picker on screen: the file's status stands
                if a.overlay == nil, let st = TmuxCache.state(p) {
                    let file = a.state
                    a.state = st
                    a.stateUnconfirmed = unconfirmed(sid: sid, file: file, screen: st)
                    a.prompt = st == .needsInput ? TmuxCache.prompt(p) : nil
                    a.screen = TmuxCache.status(p)
                }
            }
            if let t = j["tmux"] as? String, a.tmuxPane == nil, let pct = t.split(separator: ".").last, pct.hasPrefix("%") { a.tmuxPane = String(pct) }
            if a.effort == nil { a.effort = Self.effortFromCommandLine(pid: pid) }
            out[sid] = a
        }
        return out
    }

    /// A pane's pid is usually the shell; the agent is its child.
    // a process's parent and command line never change: look them up once per pid
    private static var ppidCache: [Int: Int] = [:]
    private static var cmdCache: [Int: String] = [:]
    private static func paneViaParent(pid: Int, paneByPid: [Int: String]) -> String? {
        if let pp = ppidCache[pid] { return paneByPid[pp] }
        let r = Shell.run(["/bin/ps", "-o", "ppid=", "-p", String(pid)], timeout: 2)
        guard let pp = Int(r.out.trimmingCharacters(in: .whitespacesAndNewlines)) else { return nil }
        ppidCache[pid] = pp
        return paneByPid[pp]
    }
    private static func effortFromCommandLine(pid: Int) -> String? {
        let out = cmdline(pid)
        guard let range = out.range(of: "--effort ") else { return nil }
        // ps output ends with a newline: without trimming, "low\n" rendered as a truncated chip
        return out[range.upperBound...].split(whereSeparator: { $0 == " " || $0 == "\n" }).first.map(String.init)
    }

    private func loadTeams(sessions: [String: Agent], panes: [String: Int], hidden: Set<String> = []) -> ([Team], Set<String>) {
        var teams: [Team] = []
        var claimed = Set<String>()
        let root = Shell.home + "/.claude/teams"
        let dirs = Set((try? FileManager.default.contentsOfDirectory(atPath: root)) ?? [])
        let now = Date()
        // Claude removes a team's config folder when its lead exits; the board keeps
        // the team (all members ended) from its own memory so it stays resumable.
        for d in dirs.union(seen.keys) {
            let data = try? Data(contentsOf: URL(fileURLWithPath: "\(root)/\(d)/config.json"))
            let j = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? ["name": d]
            if data == nil && (seen[d]?.isEmpty ?? true) { continue }
            let name = j["name"] as? String ?? d
            let leadSid = j["leadSessionId"] as? String
            var team = Team(name: name, createdAt: (j["createdAt"] as? Double).map { Date(timeIntervalSince1970: $0 / 1000) } ?? seen[d]?.values.map(\.firstSeen).min(), leadSessionId: leadSid, members: [])
            var bucket = seen[name] ?? [:]
            var liveMates: [String: Agent] = [:]
            for m in j["members"] as? [[String: Any]] ?? [] {
                let aid = m["agentId"] as? String ?? ""
                let isLead = (m["agentType"] as? String) == "team-lead" || aid == j["leadAgentId"] as? String
                var sid: String? = isLead ? leadSid : (m["sessionId"] as? String)
                if !isLead, sid == nil, let mname = m["name"] as? String {
                    // teammates never register in ~/.claude/sessions; their transcript
                    // carries teamName/agentName, and the config carries their pane
                    sid = "\(name)/\(mname)"
                    var procStart: Date?
                    if let lp = (m["tmuxPaneId"] as? String).flatMap({ panes[$0] }) {
                        // same name, new process (teammate re-created): forget the old conversation's file
                        if let old = matePids[sid!], old != lp { mateTranscripts[sid!] = nil; mateMisses[sid!] = nil; transcriptIndex[sid!] = nil }
                        matePids[sid!] = lp
                        procStart = Self.processStart(lp)
                    }
                    // a live process: only files born after it started (a re-created teammate must not get the old file)
                    let tpath = teammateTranscript(team: name, agent: mname, since: procStart ?? team.createdAt, strict: procStart != nil)
                    // sid is stable: it survives the transcript appearing, and a same-name replacement
                    if let pane = m["tmuxPaneId"] as? String, pane.hasPrefix("%"), let pid = panes[pane],
                       kill(pid_t(pid), 0) == 0, Self.cmdline(pid).contains("--agent-name \(mname)") {
                        var a = Agent(sessionId: sid!, pid: pid, name: mname)
                        a.tmuxPane = pane
                        a.state = TmuxCache.state(pane) ?? .idle
                        if a.state == .needsInput { a.prompt = TmuxCache.prompt(pane) }
                        a.screen = TmuxCache.status(pane)
                        let cl = Self.cmdline(pid)
                        a.effort = Self.flag("--effort", in: cl)
                        a.model = Self.flag("--model", in: cl).map(Self.expandModelAlias)
                        if let tpath { transcriptIndex[sid!] = tpath }
                        liveMates[sid!] = a
                    } else if let tpath { transcriptIndex[sid!] = tpath }
                }
                guard let sid else { continue }
                var sm = bucket[sid] ?? SeenMember(sessionId: sid, name: m["name"] as? String ?? aid, agentType: m["agentType"] as? String, teamAddress: aid, isLead: isLead, firstSeen: now, lastSeen: now)
                sm.lastSeen = now; sm.teamAddress = aid; sm.isLead = isLead
                if let live = sessions[sid] { if !live.name.isEmpty, live.name != sid.prefix(8).description { sm.name = live.name }; sm.origin = live.origin ?? sm.origin }
                bucket[sid] = sm
            }
            // live teammates that identify themselves on the command line but are missing from config
            for a in sessions.values where a.pid != nil {
                if let (addr, tname) = Self.teamIdentity(pid: a.pid!), tname == name, bucket[a.sessionId] == nil {
                    bucket[a.sessionId] = SeenMember(sessionId: a.sessionId, name: addr.split(separator: "@").first.map(String.init) ?? a.name, agentType: nil, teamAddress: addr, isLead: false, firstSeen: now, lastSeen: now)
                }
            }
            seen[name] = bucket
            for (sid, sm) in bucket where !deleted.contains(sid) && archive[sid] == nil && !hidden.contains(sid) {   // hidden: a parked viewer (its job is the card)
                var a = sessions[sid] ?? liveMates[sid] ?? Agent(sessionId: sid, pid: nil, name: sm.name, state: .ended)
                if sessions[sid] == nil && liveMates[sid] == nil { a.state = .ended }
                a.teamAddress = sm.teamAddress; a.teamName = name; a.agentType = sm.agentType; a.isLead = sm.isLead; a.origin = a.origin ?? sm.origin
                if a.nameSource != "user", a.name == sid.prefix(8).description || a.name.isEmpty { a.name = sm.name }
                team.members.append(a); claimed.insert(sid)
            }
            // every member deleted: nothing left to show — forget the team instead of drawing an empty box
            if team.members.isEmpty { seen[name] = nil; continue }
            teams.append(team)
        }
        return (teams, claimed)
    }

    private var mateTranscripts: [String: String] = [:]
    private var matePids: [String: Int] = [:]
    private var mateMisses: [String: Int] = [:]
    /// Finds a teammate's transcript: a .jsonl whose records carry this teamName/agentName.
    private func teammateTranscript(team: String, agent: String, since: Date?, strict: Bool = false) -> String? {
        let key = "\(team)/\(agent)"
        if let p = mateTranscripts[key], FileManager.default.fileExists(atPath: p) { return p }
        if let last = mateMisses[key], tick - last < 30 { return nil }     // re-scan every ~60 s
        mateMisses[key] = tick
        // the scan reads every project folder: do it in the background; the answer lands in the cache for the next tick
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let best = Self.scanTeammateTranscript(team: team, agent: agent, since: since, strict: strict)
            DispatchQueue.main.async {
                guard let self, let best else { return }
                self.mateTranscripts[key] = best; self.mateMisses[key] = nil
                self.refreshSoon()
            }
        }
        return nil
    }
    private static var startCache: [Int: Date] = [:]
    /// When a process started (ps lstart), cached per pid.
    static func processStart(_ pid: Int) -> Date? {
        if let d = startCache[pid] { return d }
        let out = Shell.run(["/bin/ps", "-o", "lstart=", "-p", String(pid)], timeout: 2).out.trimmingCharacters(in: .whitespacesAndNewlines)
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = "EEE MMM d HH:mm:ss yyyy"
        guard let d = f.date(from: out.split(separator: " ", omittingEmptySubsequences: true).joined(separator: " ")) else { return nil }
        startCache[pid] = d; return d
    }
    private static func scanTeammateTranscript(team: String, agent: String, since: Date?, strict: Bool) -> String? {
        let root = Shell.home + "/.claude/projects"
        let fm = FileManager.default
        let needleA = Data("\"teamName\":\"\(team)\"".utf8), needleB = Data("\"agentName\":\"\(agent)\"".utf8)
        let floor = (since ?? .distantPast).addingTimeInterval(strict ? -2 : -120)
        var best: (String, Date)?
        for d in (try? fm.contentsOfDirectory(atPath: root)) ?? [] {
            let dir = "\(root)/\(d)"
            for f in (try? fm.contentsOfDirectory(atPath: dir)) ?? [] where f.hasSuffix(".jsonl") {
                let p = "\(dir)/\(f)"
                guard let attrs = try? fm.attributesOfItem(atPath: p), let mt = attrs[.modificationDate] as? Date, mt >= floor,
                      let fh = FileHandle(forReadingAtPath: p) else { continue }
                let head = fh.readData(ofLength: 16_384); try? fh.close()
                if head.range(of: needleA) != nil && head.range(of: needleB) != nil, mt > (best?.1 ?? .distantPast) { best = (p, mt) }
            }
        }
        return best?.0
    }
    static func cmdline(_ pid: Int) -> String {
        if let c = cmdCache[pid] { return c }
        let c = Shell.run(["/bin/ps", "-o", "command=", "-p", String(pid)], timeout: 2).out.trimmingCharacters(in: .whitespacesAndNewlines)
        if !c.isEmpty { cmdCache[pid] = c }
        return c
    }
    static func flag(_ f: String, in cl: String) -> String? {
        let parts = cl.split(separator: " ").map(String.init)
        guard let i = parts.firstIndex(of: f), i + 1 < parts.count else { return nil }
        return parts[i + 1]
    }
    static func expandModelAlias(_ m: String) -> String {
        switch m { case "haiku": "claude-haiku-5-5"; case "sonnet": "claude-sonnet-5-5"; case "opus": "claude-opus-5-5"; case "fable": "claude-fable-5-1"; default: m }
    }
    /// Claude Code's footer reads "esc to interrupt" only while a turn is running.
    static func paneIsBusy(_ pane: String) -> Bool {
        if let b = TmuxCache.busy(pane) { return b }
        return false                                          // not captured yet (new pane): the next background update fills it
    }

    private var claudePids: [String: Bool] = [:]
    private func isClaude(pid: Int, started: String?) -> Bool {
        let key = "\(pid)|\(started ?? "")"
        if let v = claudePids[key] { return v }
        let cl = Self.cmdline(pid).lowercased()
        if cl.isEmpty { return true }                        // ps failed / timed out: unknown counts as "yes", and is not remembered
        let v = cl.contains("claude")
        claudePids[key] = v
        return v
    }
    /// Sessions launched before the PATH fix cannot spawn teammates (no tmux on their PATH).
    private var spawnable: [Int: Bool] = [:]
    private var spawnProbing = Set<Int>()
    func canSpawnTeammates(_ a: Agent) -> Bool {
        guard let pid = a.pid else { return false }
        if let v = spawnable[pid] { return v }
        // called from view bodies: never run ps here. Answer "yes" for now, look it up in the background.
        if spawnProbing.insert(pid).inserted {
            DispatchQueue.global(qos: .utility).async { [weak self] in
                let env = Shell.run(["/bin/ps", "eww", "-p", String(pid)], timeout: 2).out
                if env.isEmpty { DispatchQueue.main.async { self?.spawnProbing.remove(pid) }; return }     // ps failed: try again later, do not cache
                let tmuxDir = (Shell.tmux as NSString).deletingLastPathComponent
                let v = env.contains("TMUX=") && (env.range(of: "PATH=[^ ]*" + NSRegularExpression.escapedPattern(for: tmuxDir), options: .regularExpression) != nil
                                                  || FileManager.default.isExecutableFile(atPath: "/usr/bin/tmux"))
                DispatchQueue.main.async { self?.spawnable[pid] = v; self?.objectWillChange.send() }
            }
        }
        return true
    }

    private static var identityCache: [Int: (String, String)?] = [:]
    private static func teamIdentity(pid: Int) -> (String, String)? {
        if let c = identityCache[pid] { return c }
        var addr: String?, team: String?
        let parts = cmdline(pid).split(separator: " ").map(String.init)
        for (i, p) in parts.enumerated() where i + 1 < parts.count {
            if p == "--agent-id" { addr = parts[i + 1] }
            if p == "--team-name" { team = parts[i + 1] }
        }
        let v: (String, String)? = (addr != nil && team != nil) ? (addr!, team!) : nil
        identityCache[pid] = v
        return v
    }
    private static func sessionId(forTeamMember m: [String: Any], sessions: [String: Agent]) -> String? {
        if let s = m["sessionId"] as? String { return s }
        let aid = m["agentId"] as? String ?? ""
        for a in sessions.values where a.pid != nil { if let (addr, _) = teamIdentity(pid: a.pid!), addr == aid { return a.sessionId } }
        return nil
    }

    private func saveSeen() {
        try? FileManager.default.createDirectory(at: memoryURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let d = try? JSONEncoder().encode(seen) { try? d.write(to: memoryURL) }
        if let d = try? JSONEncoder().encode(jobNames) { try? d.write(to: jobNamesURL) }
    }

    // MARK: actions
    /// Messages shown at once, before Claude writes them to the transcript.
    private var chatSig: [String: String] = [:]
    private var pendingSince: [String: Date] = [:]
    private var probing = Set<String>()
    private var mismatchSince: [String: Date] = [:]
    /// File status and screen disagree (busy vs idle) for 10 s or more: the card shows "확인 중" while the screen's word is used.
    private func unconfirmed(sid: String, file: AgentState, screen: AgentState) -> Bool {
        let differ = (file == .busy && screen == .idle) || (file == .idle && screen == .busy)
        guard differ else { mismatchSince[sid] = nil; return false }
        let t = mismatchSince[sid] ?? Date(); mismatchSince[sid] = t
        return Date().timeIntervalSince(t) >= 10
    }
    private var heldNotified = Set<String>()
    private var unreachable = Set<String>()
    private var echoes: [String: [(id: String, text: String, at: Date, ttl: TimeInterval, auto: Bool)]] = [:]
    private var lostEchoes: [String: [(id: String, text: String, at: Date, ttl: TimeInterval, auto: Bool)]] = [:]   // sent, never recorded
    /// Slash commands the board itself sent (/model, /effort, /rename, /exit): shown as small status lines, not user bubbles.
    private var boardSlashes: [String: [(text: String, at: Date)]] = [:]
    private static func squash(_ s: String) -> String { s.split(whereSeparator: \.isWhitespace).joined(separator: " ") }
    private func addEcho(_ text: String, sid: String, ttl: TimeInterval, auto: Bool = false) {
        let e = (id: "echo-\(UUID().uuidString)", text: text, at: Date(), ttl: ttl, auto: auto)
        echoes[sid, default: []].append(e)
        if auto { boardSlashes[sid, default: []].append((text, e.at)) }
        else if text.hasPrefix("/") { lastSentAt = Date() }
        if var c = chat[sid] {                             // optimistic row, immediately (same id the refresh uses)
            c.append(auto ? ChatEntry(id: e.id, role: .system, text: text, toolName: "auto", time: e.at) : ChatEntry(id: e.id, role: .user, text: text, toolName: "전송 중", time: e.at))
            chat[sid] = c
        }
    }
    /// What each composer sent last (text as typed, attachments), so a message the CLI did not take can be put back.
    var lastSentDraft: [String: (String, [URL])] = [:]
    struct Bounce: Equatable { var sid: String; var gen: Int }
    @Published var bounce = Bounce(sid: "", gen: 0)
    /// Queued messages taken back out of the CLI's queue, for that session's composer to hold.
    struct Pulled: Equatable { var sid: String; var gen: Int; var texts: [String] }
    @Published var pulled = Pulled(sid: "", gen: 0, texts: [])
    func pullQueue(_ a: Agent) {
        guard let p = a.tmuxPane, let path = a.transcriptPath else { return }
        if TmuxCache.foreignTyped(p) { notice = L("'%@'의 CLI 입력창에 글이 있어 대기 메시지를 꺼내지 않았습니다. 그 글을 보내거나 지운 뒤 다시 시도하세요.", a.name); return }
        let texts = Self.queuedTexts(path)
        guard !texts.isEmpty else { return }
        TmuxControl.pullQueue(p, sid: a.sessionId) { [weak self] ok in
            guard let self else { return }
            guard ok else { self.notice = L("대기 메시지를 꺼내지 못했습니다. 이미 처리됐을 수 있습니다."); return }
            self.echoes[a.sessionId]?.removeAll { texts.contains($0.text) }
            if var c = self.chat[a.sessionId] { c.removeAll { $0.toolName == "전송 중" && texts.contains($0.text) }; self.chat[a.sessionId] = c }
            self.pulled = Pulled(sid: a.sessionId, gen: self.pulled.gen + 1, texts: texts)
            self.refreshSoon()
        }
    }
    /// Sessions whose message is still being typed into the CLI (it may be reading pasted images): their box holds Enter.
    @Published var sending: Set<String> = []
    var drafts: [String: (String, [URL])] = [:]             // half-typed text per agent; survives tab changes (not @Published)
    var userInitiated = false                               // set by SlashRouter while it forwards a command the user typed
    var lastSentAt = Date.distantPast                       // not @Published: only ChatView reads it, at scroll time
    @discardableResult
    func send(_ text: String, to a: Agent) -> Bool {
        let r = sendChecked(text, to: a)
        SendLog.note("store '\(a.name)' sid=\(a.sessionId.prefix(8)) pane=\(a.tmuxPane ?? "없음") state=\(a.state) " + (r ? "→ tmux로 보냄" : "→ 거절: \(notice ?? "-")"))
        return r
    }
    private func sendChecked(_ text: String, to a: Agent) -> Bool {
        guard let p = a.tmuxPane, a.state != .ended else { notice = L("'%@'은(는) 종료됐거나 tmux 화면이 없는 세션이라 보낼 수 없습니다.", a.name); return false }
        if let o = a.overlay { notice = L("'%@'의 CLI가 %@ 화면이라 보낼 수 없습니다. CLI에서 Esc를 눌러 대화로 돌아온 뒤 다시 보내세요.", a.name, Self.overlayName(o)); return false }
        if a.state == .needsInput, a.prompt != nil {
            notice = L("'%@'의 CLI가 질문에 대한 답을 기다리는 중이라 보내지 않았습니다. 질문 카드에서 먼저 답하거나 Esc로 취소한 뒤 다시 보내세요.", a.name); return false
        }
        if TmuxCache.foreignTyped(p) { notice = L("'%@'의 CLI 입력창에 입력 중인 글이 있어 보내지 않았습니다 (터미널에서 같이 쓰는 중). 그 글을 보내거나 지운 뒤 다시 시도하세요.", a.name); return false }
        lastSentAt = Date()
        if text.hasPrefix("/model") { TmuxCache.expectModelConfirm(p) }     // typed by the user: a "Switch model?" window is theirs too
        addEcho(text, sid: a.sessionId, ttl: 90)
        TmuxCache.markSent(p, busy: true)
        sending.insert(a.sessionId)
        TmuxControl.send(text, to: p, sid: a.sessionId)     // queued per pane, off the main thread
        for d in [0.5] {                                    // pick up the new state without waiting for the 2 s tick (coalesced)
            DispatchQueue.main.asyncAfter(deadline: .now() + d) { [weak self] in self?.refreshSoon() }
        }
        return true
    }
    func clearCLIInput(_ a: Agent) {
        guard let p = a.tmuxPane else { return }
        TmuxControl.clearInput(p)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in self?.refreshSoon() }
    }
    func interrupt(_ a: Agent) { if let p = a.tmuxPane { TmuxControl.interrupt(p) } }
    /// Messages typed while a turn runs wait in the CLI's queue. Esc stops the turn and the CLI puts the queued text back
    /// into its input box; Enter then submits it right away.
    func pushQueue(_ a: Agent) {
        guard let p = a.tmuxPane else { return }
        TmuxControl.queue(p) {
            TmuxControl.keys(["-t", p, "Escape"], what: L("중단(Esc)"))
            usleep(900_000)
            let box = Shell.tmux(["capture-pane", "-p", "-t", p, "-S", "-6"]).out
            // only press Enter when the box holds text (a "❯ " row with something after it)
            if box.split(separator: "\n").contains(where: { $0.trimmingCharacters(in: .whitespaces).hasPrefix("❯") && $0.trimmingCharacters(in: .whitespaces).count > 2 }) {
                TmuxControl.keys(["-t", p, "Enter"], what: L("대기열 전송(Enter)"))
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.refreshSoon() }
    }
    /// Shift+Tab in the CLI: default → accept edits → plan → … The footer shows the new mode on the next capture.
    func cycleMode(_ a: Agent) {
        guard let p = a.tmuxPane, a.state != .ended else { return }
        TmuxControl.queue(p) { TmuxControl.keys(["-t", p, "BTab"], what: L("모드 전환(Shift+Tab)")) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in self?.refreshSoon() }
    }
    /// Live + idle: /rename now. Live + busy: queued until idle. Ended: written to
    /// the transcript as a custom-title record, exactly as Claude stores it.
    func rename(_ a: Agent, to raw: String) {
        let name = raw.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty, name != a.name else { return }
        if let host = externalHost(a), a.state == .ended || a.tmuxPane == nil {
            notice = L("'%@'은(는) %@에서 만든 대화라 이름은 %@에서 바꿔 주세요. 앱이 기록 파일에 쓰면 %@가 이 세션을 거부합니다.", a.name, host, host, host); return
        }
        if a.state == .ended {
            writeTitle(name, for: a)
        } else if a.tmuxPane == nil {
            // running, but no way to type into it: store the title in its transcript;
            // Claude picks it up the next time the session is opened
            writeTitle(name, for: a)
            notice = L("'%@'은(는) 입력할 수 없는 세션이라 이름을 기록에 저장했습니다. 다음에 다시 시작할 때부터 '%@'(으)로 표시됩니다.", a.name, name)
        } else if a.working {
            pendingRenames[a.sessionId] = name
            notice = L("'%@' 작업 중 — 대기 상태가 되면 이름을 바꿉니다.", a.name)
        } else if let p = a.tmuxPane {
            TmuxControl.rename(name, pane: p)
        }
        if let t = a.teamName { seen[t]?[a.sessionId]?.name = name; saveSeen() }
        refresh()
    }
    private func writeTitle(_ name: String, for a: Agent) {
        guard let path = a.transcriptPath ?? transcript(for: a.sessionId),
              let fh = FileHandle(forWritingAtPath: path) else { notice = L("대화 기록 파일을 찾지 못해 이름을 저장하지 못했습니다."); return }
        let rec: [String: Any] = ["type": "custom-title", "customTitle": name, "sessionId": a.sessionId]
        guard var line = try? JSONSerialization.data(withJSONObject: rec) else { return }
        line.append(0x0A)
        fh.seekToEndOfFile(); fh.write(line); try? fh.close()
        // Claude restores the title on --resume from <transcript dir>/<sessionId>/custom-title.json,
        // not from the transcript records (verified) — write that file too.
        let sid = ((path as NSString).lastPathComponent as NSString).deletingPathExtension
        let dir = ((path as NSString).deletingLastPathComponent as NSString).appendingPathComponent(sid)
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        if let d = try? JSONSerialization.data(withJSONObject: ["customTitle": name]) {
            try? d.write(to: URL(fileURLWithPath: (dir as NSString).appendingPathComponent("custom-title.json")), options: .atomic)
        }
    }
    /// The program that created a conversation, when it is not the terminal CLI (the transcript's first "entrypoint").
    private var hostCache: [String: String?] = [:]
    func externalHost(_ a: Agent) -> String? {
        guard let path = a.transcriptPath ?? transcript(for: a.sessionId) else { return nil }
        if let h = hostCache[path] { return h }
        var h: String?
        if let fh = FileHandle(forReadingAtPath: path) {
            let head = String(decoding: fh.readData(ofLength: 256 * 1024), as: UTF8.self); try? fh.close()
            if let r = head.range(of: #""entrypoint":"([^"]+)""#, options: .regularExpression) {
                let e = String(head[r]).replacingOccurrences(of: #""entrypoint":""#, with: "", options: .regularExpression).dropLast()
                switch e {
                case "cli", "sdk-cli": h = nil
                case "claude-vscode": h = "VS Code"
                case "claude-desktop": h = L("Claude 데스크톱 앱")
                default: h = String(e)
                }
            }
        }
        hostCache[path] = h; return h
    }
    /// The CLI records its message queue in the transcript (enqueue / dequeue / remove / popAll): replay the tail.
    /// Task notifications the CLI queues itself are not counted.
    private static var queueCache: [String: (size: UInt64, texts: [String])] = [:]   // the tail is re-read only when the file grew
    static func queuedCount(_ path: String) -> Int { queuedTexts(path).count }
    static func queuedTexts(_ path: String) -> [String] {
        guard let fh = FileHandle(forReadingAtPath: path) else { return [] }
        defer { try? fh.close() }
        let end = fh.seekToEndOfFile()
        if let c = queueCache[path], c.size == end { return c.texts }
        fh.seek(toFileOffset: end > 400_000 ? end - 400_000 : 0)
        var q: [String] = []
        for line in String(decoding: fh.readDataToEndOfFile(), as: UTF8.self).split(separator: "\n") where line.contains("\"queue-operation\"") {
            guard let j = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any], let op = j["operation"] as? String else { continue }
            let c = j["content"] as? String ?? ""
            switch op {
            case "enqueue": q.append(c)
            case "dequeue": if !q.isEmpty { q.removeFirst() }
            case "remove": if let i = q.firstIndex(of: c) { q.remove(at: i) } else if !q.isEmpty { q.removeFirst() }
            case "popAll": q.removeAll()
            default: break
            }
        }
        let n = q.filter { !$0.hasPrefix("<task-notification") }
        queueCache[path] = (end, n)
        return n
    }
    /// The title Claude will use on resume, if one is stored.
    static func storedTitle(forTranscript path: String) -> String? {
        let sid = ((path as NSString).lastPathComponent as NSString).deletingPathExtension
        let p = ((path as NSString).deletingLastPathComponent as NSString).appendingPathComponent("\(sid)/custom-title.json")
        guard let d = try? Data(contentsOf: URL(fileURLWithPath: p)),
              let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return nil }
        return j["customTitle"] as? String
    }

    // MARK: model / effort / teammates / new sessions

    /// Slash command now if idle, otherwise queued until the agent is idle.
    func command(_ cmd: String, for a: Agent) {
        guard a.state != .ended, let p = a.tmuxPane else { notice = L("tmux pane이 없거나 종료된 세션이라 변경할 수 없습니다."); return }
        if !a.working && TmuxCache.isSettled(p) && (pendingCommands[a.sessionId] ?? []).isEmpty { sendSlash(cmd, to: p, sid: a.sessionId) }
        else { pendingCommands[a.sessionId, default: []].append(cmd); notice = L("'%@' 작업 중 — 대기 상태가 되면 %@ 을(를) 보냅니다.", a.name, cmd) }
        refresh()
    }
    /// `/model` and `/effort` also overwrite the user's defaults for new sessions
    /// in ~/.claude/settings.json. Snapshot those keys, send, then put them back:
    /// the running session keeps its new setting, the defaults stay the user's.
    private static let defaultKeys = ["model", "effortLevel", "modelSettings"]
    private static var settingsPath: String { Shell.home + "/.claude/settings.json" }
    /// Remote Control on/off for one session. Off goes through /remote-control's menu ("Disconnect this session").
    @Published var rcPending: Set<String> = []
    func toggleRemote(_ a: Agent) {
        guard let pane = a.tmuxPane, let on = a.remoteControl, !rcPending.contains(a.sessionId) else {
            notice = L("'%@'는 앱이 조작할 수 있는 터미널(tmux) 세션이 아니라 Remote Control을 바꿀 수 없습니다.", a.name); return }
        guard !a.working else { notice = L("'%@'가 작업 중입니다. 끝난 뒤 다시 눌러 주세요.", a.name); return }
        rcPending.insert(a.sessionId)
        TmuxControl.command("/remote-control", to: pane)
        Task { @MainActor in
            defer { self.rcPending.remove(a.sessionId) }
            if on {
                var picked = false
                for _ in 0..<15 {                                    // wait for the menu, then walk up to "Disconnect"
                    try? await Task.sleep(nanoseconds: 200_000_000)
                    let scr = await TmuxControl.exec(pane, ["capture-pane", "-p", "-t", pane]).out
                    guard scr.contains("Disconnect this session") else { continue }
                    if scr.split(separator: "\n").contains(where: { $0.contains("❯") && $0.contains("Disconnect this session") }) {
                        if (await TmuxControl.exec(pane, ["send-keys", "-t", pane, "Enter"])).code != 0 { self.notice = L("원격 제어 메뉴에 Enter를 보내지 못했습니다.") }; picked = true; break
                    }
                    _ = await TmuxControl.exec(pane, ["send-keys", "-t", pane, "Up"])
                }
                if !picked { _ = await TmuxControl.exec(pane, ["send-keys", "-t", pane, "Escape"]) }
            }
            for _ in 0..<12 {                                        // confirmed by the session file
                try? await Task.sleep(nanoseconds: 500_000_000)
                self.refresh()
                if let now = self.agent(a.sessionId)?.remoteControl, now != on {
                    self.notice = now ? L("'%@' Remote Control 켜짐 — 휴대폰·claude.ai/code에서 이어서 볼 수 있습니다.", a.name) : L("'%@' Remote Control 꺼짐 — 웹 목록에 더 이상 나타나지 않습니다.", a.name); return
                }
            }
            self.notice = L("'%@' Remote Control 전환을 확인하지 못했습니다. 세션 터미널을 확인해 주세요.", a.name)
        }
    }

    private func sendSlash(_ cmd: String, to pane: String, sid: String? = nil) {
        let touchesDefaults = cmd.hasPrefix("/model") || cmd.hasPrefix("/effort")
        let before = touchesDefaults ? Self.readDefaults() : nil
        let rawBefore = touchesDefaults ? try? Data(contentsOf: URL(fileURLWithPath: Self.settingsPath)) : nil
        TmuxCache.markSent(pane, busy: false)
        if cmd.hasPrefix("/model") { TmuxCache.expectModelConfirm(pane) }
        if let sid { addEcho(cmd, sid: sid, ttl: 20, auto: !userInitiated) }
        TmuxControl.command(cmd, to: pane)
        if touchesDefaults, let sid {
            // the pane answers at once ("Set model to …" / "Set effort level to …"): that is the real confirmation
            let key = sid + "|" + (cmd.hasPrefix("/model") ? "/model" : "/effort")
            confirmed.remove(key)
            Task { @MainActor in
                for _ in 0..<10 {
                    try? await Task.sleep(nanoseconds: 400_000_000)
                    let screen = await TmuxControl.exec(pane, ["capture-pane", "-p", "-t", pane, "-S", "-15"]).out
                    if screen.contains("Set model to") || screen.contains("Set effort level to") || screen.contains("Kept model as") {
                        self.confirmed.insert(key); self.refresh(); break
                    }
                }
            }
        }
        guard let before else { return }
        Task { @MainActor in
            for delay in [2.5, 6.0] {                       // Claude writes shortly after the command
                try? await Task.sleep(nanoseconds: UInt64(delay * 1e9))
                // Only the default keys changed? Put the original bytes back, so the
                // file keeps the user's exact formatting. Otherwise patch just those keys.
                if let raw = rawBefore, Self.onlyDefaultsChanged(since: raw) {
                    if (try? Data(contentsOf: URL(fileURLWithPath: Self.settingsPath))) != raw {
                        try? raw.write(to: URL(fileURLWithPath: Self.settingsPath), options: .atomic)
                    }
                } else {
                    Self.restoreDefaults(before)
                }
            }
        }
    }
    private static func onlyDefaultsChanged(since raw: Data) -> Bool {
        guard let now = try? Data(contentsOf: URL(fileURLWithPath: settingsPath)),
              var a = (try? JSONSerialization.jsonObject(with: raw)) as? [String: Any],
              var b = (try? JSONSerialization.jsonObject(with: now)) as? [String: Any] else { return false }
        for k in defaultKeys { a[k] = nil; b[k] = nil }
        return NSDictionary(dictionary: a).isEqual(to: b)
    }
    private static func readDefaults() -> [String: Any] {
        guard let d = try? Data(contentsOf: URL(fileURLWithPath: settingsPath)),
              let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return [:] }
        var out: [String: Any] = [:]
        for k in defaultKeys { out[k] = j[k] ?? NSNull() }
        return out
    }
    private static func restoreDefaults(_ before: [String: Any]) {
        guard !before.isEmpty, let d = try? Data(contentsOf: URL(fileURLWithPath: settingsPath)),
              var j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return }
        var changed = false
        for k in defaultKeys {
            let old = before[k]
            if old is NSNull || old == nil {
                if j[k] != nil { j[k] = nil; changed = true }
            } else if !NSDictionary(dictionary: [k: j[k] as Any]).isEqual(to: [k: old!]) {
                j[k] = old; changed = true
            }
        }
        guard changed, let out = try? JSONSerialization.data(withJSONObject: j, options: [.prettyPrinted, .withoutEscapingSlashes]) else { return }
        let tmp = settingsPath + ".agentboost.tmp"
        if (try? out.write(to: URL(fileURLWithPath: tmp))) != nil {
            _ = try? FileManager.default.replaceItemAt(URL(fileURLWithPath: settingsPath), withItemAt: URL(fileURLWithPath: tmp))
        }
    }

    // MARK: quit (the same for leads, teammates and single sessions)

    /// Only sessions the board can type into can be quit or deleted from the board.
    /// Sessions without a pane (Claude desktop app, plain terminals) are left alone:
    /// signalling them could kill the very conversation the user is in.
    func canControl(_ a: Agent) -> Bool { a.state != .ended && a.tmuxPane != nil }
    /// Anything with a live process can be really stopped: /exit if the board can
    /// type into it, otherwise SIGTERM. Nothing is ever only hidden.
    func canQuit(_ a: Agent) -> Bool { a.state != .ended && a.pid != nil }

    /// Types /exit into the session. Busy + .now: Esc first. Busy + .whenIdle: queued.
    /// If the process is still alive 10 s after /exit, SIGTERM as a last resort.
    func quit(_ a: Agent, mode: QuitMode = .now) {
        guard let pid = a.pid, a.state != .ended else { return }
        if a.working && mode == .whenIdle {
            pendingCommands[a.sessionId, default: []].append("/exit")
            notice = L("'%@' 작업이 끝나면 종료합니다.", a.name)  // queued /exit
            refresh(); return
        }
        if a.isBackgroundJob, let job = a.jobId {
            // a CLI background job: the CLI's own `claude stop` ends it for real. Its viewer (the interactive session whose
            // conversation was moved there, or `claude attach`) is closed with ctrl+c twice first: its /exit only returns to
            // the agents screen.
            if let pane = a.tmuxPane { Self.closeViewer(pane, pid: a.viewerPid) }
            stopJob(job, name: a.name, pid: pid)
            notice = L("'%@' 백그라운드 작업을 멈춥니다 (claude stop %@).", a.name, job) + (a.tmuxPane != nil ? L(" CLI 화면은 닫습니다.") : "")
            return
        }
        guard let pane = a.tmuxPane else {
            // no terminal to type /exit into: stop the process for real
            kill(pid_t(pid), SIGTERM)
            exitWatchdog(pid: pid, name: a.name, escalate: true)
            notice = L("'%@'에 종료 신호(SIGTERM)를 보냈습니다.", a.name) + (a.entrypoint == "claude-desktop" ? L(" 데스크톱 앱의 해당 대화가 끊깁니다.") : "")
            return
        }
        if a.parkedJobId != nil {                              // a viewer whose job is gone: /exit only returns to the agents screen
            Self.closeViewer(pane, pid: pid)
            notice = L("'%@' CLI 화면을 닫습니다 (대화는 백그라운드 작업으로 옮겨져 있었습니다).", a.name)
            return
        }
        if a.overlay != nil || a.working { TmuxControl.interrupt(pane, settle: 0.6) }   // leave the list / picker, or stop the turn, before /exit
        TmuxControl.command("/exit", to: pane)
        exitWatchdog(pid: pid, name: a.name)
        notice = L("'%@'에 /exit 을 보냈습니다.", a.name)
    }
    /// ctrl+c twice: how the CLI quits an interactive viewer of a background job (its /exit only returns to the agents screen).
    static func closeViewer(_ pane: String, pid: Int?) {
        // The CLI's own way first (ctrl+c twice); it is unreliable from the conversation view of a parked session (verified:
        // the presses switch screens instead), so the viewer process is then ended by signal. It holds no conversation
        // state — that lives in the job daemon, which is untouched.
        TmuxControl.queue(pane) {
            TmuxControl.keys(["-t", pane, "C-c"], what: L("CLI 화면 닫기(ctrl+c)")); usleep(600_000)
            TmuxControl.keys(["-t", pane, "C-c"], what: L("CLI 화면 닫기(ctrl+c)"))
            guard let pid else { return }
            for _ in 0..<12 where kill(pid_t(pid), 0) == 0 { usleep(250_000) }
            if kill(pid_t(pid), 0) == 0 { kill(pid_t(pid), SIGTERM) }
            for _ in 0..<20 where kill(pid_t(pid), 0) == 0 { usleep(250_000) }
            if kill(pid_t(pid), 0) == 0 { kill(pid_t(pid), SIGKILL) }
        }
    }
    /// `claude stop <job>` off the main thread; SIGTERM only if the process outlives it.
    private func stopJob(_ job: String, name: String, pid: Int) {
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let r = Shell.run([Shell.claude, "stop", job], timeout: 60)
            for _ in 0..<50 where kill(pid_t(pid), 0) == 0 { usleep(200_000) }
            let alive = kill(pid_t(pid), 0) == 0
            if alive { kill(pid_t(pid), SIGTERM) }
            DispatchQueue.main.async {
                guard let self else { return }
                if r.code != 0 { self.notice = L("'%@' claude stop %@ 실패: %@", name, job, String((r.err.isEmpty ? r.out : r.err).trimmingCharacters(in: .whitespacesAndNewlines).prefix(200))) }
                else if alive { self.notice = L("'%@' claude stop 후에도 프로세스가 남아 SIGTERM을 보냈습니다.", name) }
                self.refreshSoon()
            }
        }
    }
    private func exitWatchdog(pid: Int, name: String, escalate: Bool = false) {
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 30_000_000_000)
            if kill(pid_t(pid), 0) == 0 {
                kill(pid_t(pid), escalate ? SIGKILL : SIGTERM)
                self.notice = L("'%@'이(가) 30초 안에 끝나지 않아 강제 종료(%@)했습니다.", name, escalate ? "SIGKILL" : "SIGTERM")
            }
            self.refresh()
        }
    }

    // MARK: teammate creation check

    private static func modelMatches(_ want: ModelChoice, _ got: String?) -> Bool {
        guard let g = got.map(expandModelAlias) else { return false }
        return g.hasPrefix(want.rawValue)
    }
    private func verifySpawns(_ agents: [Agent]) {
        var next: [SpawnCheck] = []
        for var c in spawnChecks {
            if c.done && -c.started.timeIntervalSinceNow > 30 { continue }        // keep finished results briefly
            let lead = agents.first { $0.tmuxPane == c.leadPane && $0.state != .ended }
            let mates = lead?.teamName.flatMap { t in teams.first { $0.name == t } }?.workers ?? []
            for spec in c.specs where (c.results[spec.name] ?? .waiting) == .waiting {
                if let m = mates.first(where: { $0.name == spec.name && $0.state != .ended }) {
                    var diff: [String] = []
                    if !Self.modelMatches(spec.model, m.model) { diff.append(L("모델 %@", m.model ?? "?")) }
                    if let e = m.effort, e != spec.effort.rawValue { diff.append("effort \(e)") }
                    c.results[spec.name] = diff.isEmpty ? .ok : .mismatch(diff.joined(separator: ", "))
                } else if let why = lead.flatMap({ Self.leadReportedFailure($0, since: c.started) }) {
                    c.results[spec.name] = .failed; c.reason = why
                } else if -c.started.timeIntervalSinceNow > 120 {
                    c.results[spec.name] = .failed
                    c.leadScreen = Shell.tmux(["capture-pane", "-p", "-t", c.leadPane]).out
                        .split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.suffix(8).joined(separator: "\n")
                }
            }
            next.append(c)
        }
        if next != spawnChecks { spawnChecks = next }
    }
    /// The lead's newest reply after `since`, when it reads like a failure report.
    private static func leadReportedFailure(_ lead: Agent, since: Date) -> String? {
        guard let path = lead.transcriptPath, let fh = FileHandle(forReadingAtPath: path) else { return nil }
        defer { try? fh.close() }
        let size = (try? fh.seekToEnd()) ?? 0
        try? fh.seek(toOffset: size > 300_000 ? size - 300_000 : 0)
        let data = fh.readDataToEndOfFile()
        let iso = ISO8601DateFormatter(); iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var latest: (Date, String)?
        for line in data.split(separator: 0x0A) {
            guard let d = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any], d["type"] as? String == "assistant",
                  let ts = (d["timestamp"] as? String).flatMap(iso.date(from:)), ts > since,
                  let blocks = (d["message"] as? [String: Any])?["content"] as? [[String: Any]] else { continue }
            let text = blocks.compactMap { $0["type"] as? String == "text" ? $0["text"] as? String : nil }.joined(separator: "\n")
            if !text.isEmpty { latest = (ts, text) }
        }
        guard let t = latest?.1 else { return nil }
        let low = t.lowercased()
        let failed = ["실패", "failed", "could not", "couldn't", "unable", "거부", "rejected", "error"].contains { low.contains($0) }
        return failed ? String(t.prefix(400)) : nil
    }
    private func startSpawnCheck(leadPane: String, specs: [TeammateSpec]) {
        spawnChecks.append(SpawnCheck(leadPane: leadPane, specs: specs))
    }

    private var requested: [String: (model: String?, effort: String?, at: Date)] = [:]
    private var confirmed = Set<String>()   // "sid|/model" once the pane printed the confirmation
    func setModel(_ m: ModelChoice, for a: Agent) {
        var r = requested[a.sessionId] ?? (nil, nil, Date()); r.model = m.rawValue; r.at = Date(); requested[a.sessionId] = r
        command("/model \(m.rawValue)", for: a); notice = nil
    }
    func setEffort(_ e: EffortChoice, for a: Agent) {
        var r = requested[a.sessionId] ?? (nil, nil, Date()); r.effort = e.rawValue; r.at = Date(); requested[a.sessionId] = r
        command("/effort \(e.rawValue)", for: a); notice = nil
    }

    /// Teammates are created by the session itself, through Claude Code's own
    /// agent-team tooling: the board sends an explicit instruction naming each
    /// teammate's name, role, model and effort.
    static func teammateInstruction(_ specs: [TeammateSpec]) -> String {
        // Tested wording: names the tool and forbids researching first (Haiku leads
        // otherwise launch a guide agent instead of spawning the teammate).
        var s = "Spawn the following teammates right now using your Agent tool, one call per teammate. Do not research how teams work and do not launch any other agent first. Use exactly the given name, model and effort.\n"
        for t in specs where !t.name.trimmingCharacters(in: .whitespaces).isEmpty {
            let role = t.role.trimmingCharacters(in: .whitespaces)
            s += "- name \"\(t.name)\", model \(t.model.rawValue), effort \(t.effort.rawValue). Task: \(role.isEmpty ? "reply \"ready\" once, then stay idle and wait for instructions from the team lead." : role)\n"
        }
        s += "After spawning, report in one line per teammate whether it succeeded."
        return s
    }
    func addTeammates(_ specs: [TeammateSpec], to a: Agent) {
        let valid = specs.filter { $0.nameIsValid }
        if valid.count < specs.filter({ !$0.name.trimmingCharacters(in: .whitespaces).isEmpty }).count { notice = L("팀원 이름은 영문·숫자·_·- 만 쓸 수 있습니다 (Claude의 Agent 도구 제한). 잘못된 이름은 건너뛰었습니다.") }
        guard !valid.isEmpty else { return }
        guard a.state != .ended, a.tmuxPane != nil else { notice = L("tmux pane에서 실행 중인 세션에만 팀원을 추가할 수 있습니다."); return }
        send(Self.teammateInstruction(valid), to: a)
        if let p = a.tmuxPane { startSpawnCheck(leadPane: p, specs: valid) }
        notice = nil
    }

    /// Starts `claude -n NAME --model M --effort E [PROMPT]` in a new tmux session.
    @discardableResult
    func createSession(name: String, cwd: String, model: ModelChoice, effort: EffortChoice, teammates: [TeammateSpec], task: String, bypass: Bool = false) -> String? {
        let clean = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { notice = L("이름을 입력하세요."); return nil }
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: cwd, isDirectory: &isDir), isDir.boolValue else { notice = L("작업 폴더가 없습니다: %@", cwd); return nil }
        var prompt = ""
        let team = teammates.filter { !$0.name.trimmingCharacters(in: .whitespaces).isEmpty }
        if !team.isEmpty { prompt += Self.teammateInstruction(team) }
        if !task.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { prompt += (prompt.isEmpty ? "" : "\n") + L("작업: %@", task) }
        var argv = [Shell.claude, "-n", clean, "--model", model.rawValue, "--effort", effort.rawValue]
        if bypass { argv.append("--dangerously-skip-permissions") }
        if !prompt.isEmpty { argv.append(prompt) }
        guard let tmuxName = launchInTmux(label: clean, cwd: cwd, argv: argv) else { return nil }
        if !team.isEmpty, let pane = Shell.tmux(["list-panes", "-t", tmuxName, "-F", "#{pane_id}"]).out.split(separator: "\n").first {
            startSpawnCheck(leadPane: String(pane), specs: team)
        }
        notice = L("새 세션 '%@' 시작 (tmux: %@)", clean, tmuxName) + (team.isEmpty ? "" : L(" — 팀원 %@명 생성 지시 포함", String(team.count)))
        refresh(); refreshSoon()
        return tmuxName
    }
    /// `claude update` in the background; running sessions keep their version until restarted.
    func updateClaude() {
        notice = L("Claude Code 업데이트 확인 중…")
        DispatchQueue.global(qos: .utility).async {
            let r = Shell.run([Shell.claude, "update"], timeout: 300)
            let last = r.out.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.last ?? ""
            DispatchQueue.main.async {
                self.notice = r.code == 0 ? L("Claude Code 업데이트: %@ — 실행 중인 세션은 다시 시작해야 새 버전을 씁니다.", last)
                                          : L("Claude Code 업데이트 실패: %@", last)
            }
        }
    }
    /// One click: a home-folder session that analyses disk use and proposes a clean-up (nothing is removed before approval).
    func createDiskManager() {
        let bypass = UserDefaults.standard.object(forKey: "new.bypass") as? Bool ?? true
        _ = createSession(name: "Memory Manager", cwd: Shell.home, model: .sonnet, effort: .low, teammates: [], task: Self.diskManagerPrompt, bypass: bypass)
    }
    static var diskManagerPrompt: String { L("""
    너는 이 Mac의 디스크 관리자다. 지금은 분석하고 정리 방법을 제안만 한다. 내가 승인하기 전에는 아무것도 지우거나 옮기지 마라.
    아래를 조사해라. 오래 걸리는 du는 깊이를 제한하고, 권한 오류는 건너뛴다.
    1. 디스크 전체 용량과 여유 공간 (df -h /).
    2. 홈 폴더 아래 가장 큰 폴더 상위 20개.
    3. 개발·앱 캐시: ~/Library/Caches, ~/Library/Logs, ~/Library/Developer(DerivedData, 시뮬레이터), ~/.cache, ~/.npm, ~/.cargo, pip·conda·micromamba 캐시, Homebrew 캐시, Docker 이미지와 볼륨.
    4. 오래 쓰지 않은(90일 이상) 캐시와 임시 파일: $TMPDIR, /private/tmp, ~/Downloads 안의 오래되고 큰 파일.
    5. 최근 30일 안에 설치되었고 크기가 큰 앱 (/Applications, ~/Applications).
    6. 휴지통 크기와 로컬 Time Machine 스냅샷 (tmutil listlocalsnapshots /).
    결과는 "항목 · 크기 · 마지막 사용 · 판단(안전/확인 필요/위험) · 정리 방법(명령)" 표로 정리하고, 확보 가능한 용량 합계와 추천 순서를 제안해라.
    iCloud 동기화 폴더(~/Library/Mobile Documents), 문서·사진 원본, 연구 자료(~/Desktop/Research)는 정리 대상으로 제안하지 마라.
    """) }
    private func trackLaunches(knownPids: Set<Int>, usedPanes: Set<String>) {
        guard !launches.isEmpty else { return }
        var next: [Launch] = []
        for var l in launches {
            let r = Shell.tmux(["list-panes", "-t", l.tmuxName, "-F", "#{pane_pid}\u{1f}#{pane_dead}\u{1f}#{pane_id}"])
            let f = r.out.split(separator: "\n").first?.split(separator: "\u{1f}").map(String.init) ?? []
            guard r.code == 0, f.count == 3, let pid = Int(f[0]) else {
                notice = L("'%@' 세션이 시작 전에 종료되었습니다.", l.name)
                continue                                   // gone: drop it
            }
            if f[1] == "1" {                               // ended before registering: its last words are still on the pane (remain-on-exit)
                let screen = Screen.stripANSI(Shell.tmux(["capture-pane", "-p", "-t", f[2], "-S", "-40"]).out)
                Shell.tmux(["kill-session", "-t", l.tmuxName])
                launchFailed(l, screen: screen)
                continue
            }
            // registered: a session file for the process; for `claude attach` (none), the pane drawn on a job's card
            let registered = l.attachJob != nil ? usedPanes.contains(f[2])
                : (knownPids.contains(pid) || FileManager.default.fileExists(atPath: Shell.home + "/.claude/sessions/\(pid).json"))
            if registered { Shell.tmux(["set-option", "-w", "-t", l.tmuxName, "remain-on-exit", "off"]); continue }
            let screen = Shell.tmux(["capture-pane", "-p", "-t", l.tmuxName]).out
            l.screenTail = screen.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.suffix(6).joined(separator: "\n")
            if screen.contains("trust this folder") || screen.contains("Yes, I trust") { l.phase = .needsTrust }
            else if Self.isFirstRunScreen(screen) { l.phase = .needsSetup }
            else if -l.created.timeIntervalSinceNow > 90 { l.phase = .stuck }
            else { l.phase = .starting }
            next.append(l)
        }
        if next != launches { launches = next }
    }
    /// The CLI's own first-run flow (Claude Code 2.1.302): text style, login method, OAuth code. Not ours to answer.
    static func isFirstRunScreen(_ screen: String) -> Bool {
        ["Choose the text style", "Select login method", "Paste code here if prompted", "Let's get started"].contains { screen.contains($0) }
    }
    /// A launch stuck on the CLI's first-run flow: hand its tmux window to the Terminal so the person can finish there.
    func openLaunchTerminal(_ l: Launch) {
        guard let pane = Shell.tmux(["list-panes", "-t", l.tmuxName, "-F", "#{pane_id}"]).out.split(separator: "\n").first else { notice = L("'%@' 세션 창을 찾지 못했습니다.", l.name); return }
        let r = attachTerminal(session: l.tmuxName, pane: String(pane))
        notice = r.code == 0 ? L("터미널에서 '%@'을(를) 열었습니다. 설정과 로그인을 마치면 여기에 나타납니다.", l.name) : L("터미널을 열지 못했습니다: %@", String(r.err.prefix(120)))
    }
    /// The CLI quit before registering: act on the refusals it is known to print, show any other.
    private func launchFailed(_ l: Launch, screen: String) {
        let tail = screen.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.suffix(8).joined(separator: " ")
        if let r = l.resume {
            if let m = tail.range(of: #"running in the background \(([0-9a-f]{8})\)"#, options: .regularExpression) {
                let id = String(tail[m].dropLast().suffix(8))
                notice = L("'%@'은(는) 이미 CLI 백그라운드 작업 %@(으)로 실행 중입니다. 새로 띄우지 않고 그 화면을 붙입니다 (claude attach).", l.name, "\(id)")
                attach(job: id, label: l.name, cwd: l.cwd); return
            }
            if tail.contains("No deferred tool marker") {
                notice = L("'%@'은(는) CLI 백그라운드 작업의 대화라 --resume으로 열리지 않습니다. CLI 방식대로 --bg --resume으로 이어서 엽니다.", l.name)
                _ = resumeAsJob(sid: r.sid, jobId: nil, label: l.name, cwd: l.cwd, model: r.model, effort: r.effort, bypass: r.bypass); return
            }
        }
        notice = L("'%@' 세션이 시작 전에 종료되었습니다: %@", l.name, String(tail.prefix(240)))
    }
    /// The person's answer to Claude Code's own folder-trust prompt.
    func trustFolder(_ l: Launch) {
        let n = l.tmuxName
        TmuxControl.queue(n) {
            guard TmuxControl.keys(["-t", n, "Down"], what: L("폴더 신뢰 선택(↓)")) else { return }
            usleep(150_000)
            TmuxControl.keys(["-t", n, "Enter"], what: L("폴더 신뢰 확인(Enter)"))
        }
        notice = L("'%@' 폴더를 신뢰하고 '%@'을(를) 시작합니다.", l.cwd, l.name)
    }
    func cancelLaunch(_ l: Launch) {
        Shell.tmux(["kill-session", "-t", l.tmuxName])
        launches.removeAll { $0.id == l.id }
        notice = L("'%@' 시작을 취소했습니다.", l.name)
    }
    private func launchInTmux(label: String, cwd: String, argv: [String], attachJob: String? = nil, resume: Launch.ResumeArgs? = nil) -> String? {
        var slug = String(label.unicodeScalars.map { CharacterSet.alphanumerics.contains($0) && $0.isASCII ? Character($0) : "-" }).prefix(24).trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        if slug.isEmpty { slug = "session" }
        let tmuxName = "ab-\(slug)-" + String(Int(Date().timeIntervalSince1970) % 100000)
        var cmd = argv.map(Self.shellQuote).joined(separator: " ")
        // the CLI's own next-prompt prediction (dim text in its box) is off unless this is set; only the session itself
        // gets it (an `env` prefix, not the tmux session environment), so teammates it spawns do not pay for it
        if UserDefaults.standard.object(forKey: "ui.cliSuggest") as? Bool ?? true { cmd = "env CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=1 " + cmd }
        let r = Shell.tmux(["new-session", "-d", "-s", tmuxName, "-x", "220", "-y", "60", "-c", cwd, "-e", "PATH=\(Shell.path)", cmd])
        Shell.tmux(["set-environment", "-g", "PATH", Shell.path])
        if r.code != 0 { notice = L("세션 시작 실패: %@", String(r.err.prefix(160))); return nil }
        Shell.tmux(["set-option", "-w", "-t", tmuxName, "remain-on-exit", "on"])   // a refusal printed before the CLI registers stays readable (trackLaunches)
        var l = Launch(tmuxName: tmuxName, name: label, cwd: cwd); l.attachJob = attachJob; l.resume = resume
        launches.append(l)
        refresh(); refreshSoon()
        return tmuxName
    }

    /// The folder a session ran in, from its transcript (records carry "cwd").
    func workingDirectory(of a: Agent) -> String? {
        if let c = a.cwd { return c }
        guard let p = a.transcriptPath ?? transcript(for: a.sessionId) else { return nil }
        return transcriptCwd(p)
    }
    func canResume(_ a: Agent) -> Bool {
        a.state == .ended && (a.transcriptPath ?? transcript(for: a.sessionId)) != nil
    }
    /// Reopens an ended conversation the CLI's way: `claude --resume <id>` in a background tmux session; `--bg --resume` and
    /// `claude attach` for a conversation that belongs to a CLI background job. Model/effort are launch flags, so the user's
    /// defaults are untouched. Never a copy unless asked (`fork`): one conversation is one session id, in the CLI and here.
    @discardableResult
    func resume(_ a: Agent, model: ModelChoice, effort: EffortChoice, bypass: Bool = false, fork: Bool = false) -> String? {
        guard canResume(a) else { notice = L("대화 기록이 없어 다시 시작할 수 없습니다."); return nil }
        guard let cwd = workingDirectory(of: a), FileManager.default.fileExists(atPath: cwd) else {
            notice = L("원래 작업 폴더를 찾을 수 없습니다."); return nil
        }
        let sid = conversationId(a)
        // one conversation, one process: a second `claude --resume` of a running one is refused by the CLI (or, with
        // --fork-session, becomes a copy under a new id) — so it is never started from here by itself
        if let live = agent(sid), live.state != .ended { notice = L("'%@'은(는) 이미 실행 중입니다. 그 세션을 엽니다.", live.name); open(live); return nil }
        if let job = runningJob(for: sid) {
            notice = L("'%@'은(는) CLI 백그라운드 작업 %@(으)로 실행 중입니다. 새로 띄우지 않고 그 화면을 붙입니다 (claude attach).", a.name, "\(job.id)")
            return attach(job: job.id, label: a.name, cwd: cwd)
        }
        if let job = jobRecord(for: sid) { return resumeAsJob(sid: sid, jobId: job.id, label: a.name, cwd: cwd, model: model, effort: effort, bypass: bypass) }
        let argv = [Shell.claude, "--resume", sid] + (fork ? ["--fork-session"] : []) + ["--model", model.rawValue, "--effort", effort.rawValue] + (bypass ? ["--dangerously-skip-permissions"] : [])
        guard let t = launchInTmux(label: a.name, cwd: cwd, argv: argv, resume: Launch.ResumeArgs(sid: sid, model: model, effort: effort, bypass: bypass)) else { return nil }
        deleted.remove(sid)
        notice = L("'%@' 다시 시작 (tmux: %@)", a.name, t) + (fork ? L(" — 복사본(새 세션 ID)으로 분기합니다. 원본 대화는 그대로 남습니다.") : "") + (a.teamName != nil && !a.isLead ? L(" — 팀원 세션은 팀과 분리된 개별 세션으로 열립니다.") : "")
        return t
    }
    /// The id of the conversation behind a card: its transcript's name, else the card's own id.
    func conversationId(_ a: Agent) -> String {
        (a.transcriptPath ?? transcript(for: a.sessionId)).map { (($0 as NSString).lastPathComponent as NSString).deletingPathExtension } ?? a.sessionId
    }
    /// The CLI's job record for a conversation (also a stopped one: the record outlives the process until `claude rm`).
    func jobRecord(for sid: String) -> JobInfo? { lastJobs.values.first { $0.sessionId == sid || $0.resumeSessionId == sid } }
    /// The CLI background job that runs this conversation right now (a live process behind the record).
    func runningJob(for sid: String) -> JobInfo? {
        guard let j = jobRecord(for: sid) else { return nil }
        return (teams.flatMap(\.members) + loose).contains { $0.jobId == j.id && $0.state != .ended && $0.pid != nil } ? j : nil
    }
    /// The CLI's own viewer for a background job, in a tmux session the board can type into.
    @discardableResult
    func attach(job: String, label: String, cwd: String) -> String? {
        launchInTmux(label: label, cwd: cwd, argv: [Shell.claude, "attach", job], attachJob: job)
    }
    /// A conversation that belongs to a CLI background job: `--resume` cannot reopen it (the CLI answers "No deferred tool
    /// marker…", with or without --fork-session). The CLI's own way is `--bg --resume <id>` (same job, same session id),
    /// then `claude attach`.
    private func resumeAsJob(sid: String, jobId: String?, label: String, cwd: String, model: ModelChoice, effort: EffortChoice, bypass: Bool) -> String? {
        notice = L("'%@' 백그라운드 작업으로 다시 시작하는 중 (claude --bg --resume)…", label)
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            // a stopped job's record left in place makes the CLI start a COPY under a new id (verified); without the record
            // it continues under the same id. The record is only the CLI's list entry: the transcript stays.
            if let jobId { _ = Shell.run([Shell.claude, "rm", jobId], timeout: 30) }
            var argv = [Shell.claude, "--bg", "--resume", sid, "--model", model.rawValue, "--effort", effort.rawValue]
            if bypass { argv.append("--dangerously-skip-permissions") }
            let r = Shell.run(argv, timeout: 60, cwd: cwd)
            let text = r.out + "\n" + r.err
            let id = text.range(of: #"attach [0-9a-f]{8}"#, options: .regularExpression).map { String(text[$0].suffix(8)) }
            // what the CLI actually continued: the same conversation, or a copy it chose to make
            let got = id.flatMap { (try? Data(contentsOf: URL(fileURLWithPath: Shell.home + "/.claude/jobs/\($0)/state.json"))).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } }?["sessionId"] as? String
            DispatchQueue.main.async {
                guard let self else { return }
                guard r.code == 0, let id else {
                    self.notice = L("'%@' 다시 시작 실패 — claude --bg --resume: %@", label, String(text.trimmingCharacters(in: .whitespacesAndNewlines).suffix(220))); return
                }
                self.attach(job: id, label: label, cwd: cwd)
                self.notice = L("'%@' CLI 백그라운드 작업 %@(으)로 이어서 열었습니다 (claude --bg --resume + attach).", label, "\(id)")
                    + ((got != nil && got != sid) ? L(" ⚠️ CLI가 같은 ID로 잇지 않고 복사본(%@)을 만들었습니다. 원본 기록은 그대로 남아 있습니다.", String(got!.prefix(8))) : "")
                if let got, got != sid, self.jobNames[id] == nil { self.jobNames[id] = label }
                self.refreshSoon()
            }
        }
        return "bg:" + sid
    }

    static func shellQuote(_ s: String) -> String { "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'" }

    /// Stops the session if it is running, then moves its transcript to the Trash
    /// (recoverable). For an ended team's lead, the team folder goes too.
    /// The live or ended teammates of a lead (not the lead itself).
    func teammates(of a: Agent) -> [Agent] {
        guard a.isLead, let t = a.teamName, let team = teams.first(where: { $0.name == t }) else { return [] }
        return team.workers
    }
    func delete(_ a: Agent, withTeammates: Bool) {
        if withTeammates { for w in teammates(of: a) { delete(w) } }
        delete(a)
    }
    func delete(_ a: Agent) {
        // a CLI background job lives on in the CLI's own list (`claude agents`, its ← screen) until the CLI removes it:
        // stop, wait for the process, rm, and only then drop the board's records. In that order and off the main thread;
        // fired together, rm raced a still-running stop and the record stayed behind in one list but not the other.
        if let job = a.jobId {
            guard jobRemoving.insert(job).inserted else { return }
            let pid = a.state != .ended ? a.pid : nil
            notice = L("'%@' 백그라운드 작업을 CLI 목록에서 지우는 중…", a.name)
            DispatchQueue.global(qos: .utility).async { [weak self] in
                if let pid {
                    _ = Shell.run([Shell.claude, "stop", job], timeout: 60)
                    for _ in 0..<75 where kill(pid_t(pid), 0) == 0 { usleep(200_000) }        // up to 15 s for the process to leave
                    if kill(pid_t(pid), 0) == 0 { kill(pid_t(pid), SIGTERM) }
                }
                let r = Shell.run([Shell.claude, "rm", job], timeout: 60)
                DispatchQueue.main.async {
                    guard let self else { return }
                    self.jobRemoving.remove(job)
                    guard r.code == 0 else {
                        // the job stays in both lists, and the CLI's reason is shown (an unpushed worktree, for example)
                        let why = (r.err.isEmpty ? r.out : r.err).trimmingCharacters(in: .whitespacesAndNewlines)
                        self.notice = L("'%@' 삭제 실패 — claude rm %@: %@", a.name, "\(job)", String(why.prefix(220)))
                        self.refresh(); return
                    }
                    var e = a; e.state = .ended; e.jobId = nil; e.pid = nil
                    self.delete(e)
                }
            }
            return
        }
        if a.state != .ended {
            guard canQuit(a), let pid = a.pid else { return }
            quit(a, mode: .now)
            Task { @MainActor in
                for _ in 0..<120 where kill(pid_t(pid), 0) == 0 { try? await Task.sleep(nanoseconds: 100_000_000) }
                if kill(pid_t(pid), 0) == 0 { kill(pid_t(pid), SIGKILL) }
                var ended = a; ended.state = .ended
                self.delete(ended)
            }
            return
        }
        var trashed: [String] = []
        let fm = FileManager.default
        if let path = a.transcriptPath ?? transcript(for: a.sessionId) {
            // to the Trash (recoverable); plain removal only when the Trash refuses
            if (try? fm.trashItem(at: URL(fileURLWithPath: path), resultingItemURL: nil)) != nil || (try? fm.removeItem(atPath: path)) != nil { trashed.append(L("대화 기록")) }
            let sub = (path as NSString).deletingPathExtension   // subagent folder, if any
            if fm.fileExists(atPath: sub), (try? fm.trashItem(at: URL(fileURLWithPath: sub), resultingItemURL: nil)) == nil { try? fm.removeItem(atPath: sub) }
        }
        if let t = a.teamName {
            seen[t]?[a.sessionId] = nil
            let others = (seen[t] ?? [:]).keys.filter { $0 != a.sessionId }
            let othersEnded = others.allSatisfy { (agent($0)?.state ?? .ended) == .ended }
            if a.isLead, othersEnded {
                for dir in ["teams", "tasks"] {
                    let p = Shell.home + "/.claude/\(dir)/\(t)"
                    if fm.fileExists(atPath: p), (try? fm.removeItem(atPath: p)) != nil { trashed.append(L("팀 %@ 폴더", dir)) }
                }
                seen[t] = nil
            }
            saveSeen()
        }
        deleted.insert(a.sessionId)
        if let d = try? JSONEncoder().encode(deleted) { try? d.write(to: deletedURL) }
        transcriptIndex[a.sessionId] = nil
        transcriptScan.tick = -100                          // the file list changed: rescan now
        chat[a.sessionId] = nil
        if selectedAgent == a.sessionId { selectedAgent = nil }
        notice = L("'%@' 삭제: %@", a.name, trashed.isEmpty ? L("옮길 파일 없음") : L("%@을 휴지통으로 이동", trashed.joined(separator: ", ")))
        refresh()
    }
    func forget(_ a: Agent) {
        guard a.state == .ended, let t = a.teamName else { return }
        seen[t]?[a.sessionId] = nil; saveSeen(); refresh()
    }
    /// Opens a session's detail screen: its team tab, or 개별 세션 for a standalone session.
    func open(_ a: Agent) {
        selectedAgent = a.sessionId
        let tab = (a.teamName == nil || a.solo) ? "__loose" : a.teamName!
        if tab != "__loose" { selectedTeam = tab }
        navRequest = NavRequest(tab: tab)
    }
    // MARK: batch actions on selected cards
    var selectedAgents: [Agent] { selection.compactMap { agent($0) } }
    func wakeSelected() {
        var n = 0
        for a in selectedAgents where canResume(a) {
            let m = ModelChoice.allCases.first { (a.model ?? "").hasPrefix($0.rawValue) } ?? .opus
            let e = EffortChoice(rawValue: a.effort ?? "") ?? .low
            if resume(a, model: m, effort: e) != nil { n += 1 }
        }
        notice = L("%@개 세션을 다시 시작했습니다.", String(n))
        selection.removeAll()
    }
    func quitSelected(mode: QuitMode) {
        let targets = selectedAgents.filter { canQuit($0) }
        for a in targets { quit(a, mode: mode) }
        notice = mode == .whenIdle ? L("%@개 세션에 종료를 보냈습니다 (작업 중인 세션은 끝난 뒤 종료).", String(targets.count)) : L("%@개 세션에 종료를 보냈습니다.", String(targets.count))
        selection.removeAll()
    }
    func archiveSelected() {
        let targets = selectedAgents
        for a in targets { archive(a, withTeammates: false) }
        notice = L("%@개 세션을 보관함으로 옮겼습니다.", String(targets.count))
        selection.removeAll()
    }

    // MARK: app lifecycle: quit = sessions off, launch = sessions back on
    private var pendingRespawn: [String: [TeammateSpec]] = [:]   // tmux session of a resumed lead -> teammates to re-create
    struct SavedMate: Codable { var name: String; var model: String?; var effort: String? }
    struct SavedSession: Codable { var sessionId: String; var name: String; var model: String?; var effort: String?; var cwd: String?; var transcriptPath: String?; var teammates: [SavedMate]? }
    private static let savedURL = URL(fileURLWithPath: Shell.home + "/.agent-boost/resume-on-launch.json")
    static let skipShutdownFlag = Shell.home + "/.agent-boost/skip-shutdown-once"   // build.sh relaunch
    var controllableLive: [Agent] { (teams.flatMap(\.members) + loose).filter { $0.tmuxPane != nil && $0.state != .ended && $0.pid != nil } }

    /// Switches every session the board controls off the way the CLI does (/exit; ctrl+c twice and `claude stop` for a
    /// background job and its viewer), remembers leads and standalone sessions for the next launch. Returns what did not
    /// end cleanly, for the person to see before the app is gone.
    func shutdownAll() async -> [String] {
        timer?.invalidate(); timer = nil                      // no more refreshes while quitting
        refresh()
        let live = controllableLive
        let toSave = live.filter { $0.isLead || $0.teamName == nil || $0.solo }
        let saved = toSave.map { a in
            SavedSession(sessionId: a.sessionId, name: a.name, model: a.model, effort: a.effort,
                         cwd: a.cwd ?? workingDirectory(of: a), transcriptPath: a.transcriptPath ?? transcript(for: a.sessionId),
                         teammates: teammates(of: a).filter { $0.state != .ended }.map { SavedMate(name: $0.name, model: $0.model, effort: $0.effort) })
        }
        try? FileManager.default.createDirectory(at: Self.savedURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let d = try? JSONEncoder().encode(saved) { try? d.write(to: Self.savedURL) }
        var jobsToStop: [(job: String, name: String)] = []
        for a in live {
            guard let pane = a.tmuxPane else { continue }
            if a.overlay != nil { TmuxControl.interrupt(pane, settle: 0.5) }          // back from the agents list / picker first
            if a.isBackgroundJob, let job = a.jobId { Self.closeViewer(pane, pid: a.viewerPid); jobsToStop.append((job, a.name)); continue }
            if a.parkedJobId != nil { Self.closeViewer(pane, pid: a.pid); continue }
            if a.working { TmuxControl.interrupt(pane, settle: 0.3) }
            TmuxControl.command("/exit", to: pane)
        }
        var problems: [String] = []
        for j in jobsToStop {
            let r = await Task.detached { Shell.run([Shell.claude, "stop", j.job], timeout: 60) }.value
            if r.code != 0 { problems.append(L("'%@': claude stop %@ 실패 — %@", j.name, j.job, String((r.err.isEmpty ? r.out : r.err).trimmingCharacters(in: .whitespacesAndNewlines).prefix(160)))) }
        }
        let pids = live.compactMap(\.pid) + live.compactMap(\.viewerPid)
        for _ in 0..<60 {                                       // up to 30 s
            if pids.allSatisfy({ kill(pid_t($0), 0) != 0 }) { break }
            try? await Task.sleep(nanoseconds: 500_000_000)
        }
        for a in live {
            for p in [a.pid, a.viewerPid].compactMap({ $0 }) where kill(pid_t(p), 0) == 0 {
                kill(pid_t(p), SIGTERM)
                problems.append(L("'%@' (pid %@): 30초 안에 끝나지 않아 SIGTERM으로 강제 종료했습니다.", a.name, String(p)))
            }
        }
        return problems
    }
    /// Resume what the last quit switched off.
    func resumeSavedSessions() {
        guard let d = try? Data(contentsOf: Self.savedURL), let list = try? JSONDecoder().decode([SavedSession].self, from: d), !list.isEmpty else { return }
        try? FileManager.default.removeItem(at: Self.savedURL)
        var n = 0
        let liveNow = (teams.flatMap(\.members) + loose).filter { $0.state != .ended }
        let liveIds = Set(liveNow.map(\.sessionId)), livePids = liveNow.compactMap(\.pid)
        for it in list where !liveIds.contains(it.sessionId) && archive[it.sessionId] == nil && runningJob(for: it.sessionId) == nil {
            // the CLI may have carried the conversation on by itself (its terminal closed → a background job that resumed
            // it under a new session id): a live process whose command line names this conversation is not switched off
            if livePids.contains(where: { Self.cmdline($0).contains(it.sessionId) }) { continue }
            var a = Agent(sessionId: it.sessionId, pid: nil, name: it.name, state: .ended)
            a.cwd = it.cwd; a.transcriptPath = it.transcriptPath ?? transcript(for: it.sessionId)
            a.model = it.model; a.effort = it.effort
            let m = ModelChoice.allCases.first { (it.model ?? "").hasPrefix($0.rawValue) } ?? .opus
            let e = EffortChoice(rawValue: it.effort ?? "") ?? .low
            if let tmux = resume(a, model: m, effort: e) {
                n += 1
                // Official limitation: a resumed lead does not get its teammates back
                // ("tell the lead to spawn new teammates"). Queue exactly that, same names/models/effort.
                if let mates = it.teammates, !mates.isEmpty {
                    let specs = mates.map { mt in
                        TeammateSpec(name: mt.name, role: "You are \(mt.name), re-created after the team was restarted. Read any shared task list, then wait for the lead's instructions.",
                                     model: ModelChoice.allCases.first { (mt.model ?? "").hasPrefix($0.rawValue) } ?? .sonnet,
                                     effort: EffortChoice(rawValue: mt.effort ?? "") ?? .low)
                    }
                    pendingRespawn[tmux] = specs
                }
            }
        }
        notice = L("지난번 종료 때 끈 세션 %@개를 다시 시작했습니다.", String(n))
    }

    // MARK: archive
    /// Stops the session if running and hides it in the archive. Files stay; restorable.
    func archive(_ a: Agent, withTeammates: Bool) {
        if withTeammates { for w in teammates(of: a) { archive(w, withTeammates: false) } }
        if let job = a.jobId { Self.cliJob(["stop", job]) }        // stopped in the CLI too, or its agent view brings it back
        else if canQuit(a) { quit(a, mode: .now) }
        archive[a.sessionId] = ArchivedItem(sessionId: a.sessionId, name: a.name, teamName: a.teamName, isLead: a.isLead,
                                            model: a.model, effort: a.effort, cwd: a.cwd ?? workingDirectory(of: a),
                                            transcriptPath: a.transcriptPath ?? transcript(for: a.sessionId),
                                            tokensOut: a.tokens.output, tokensTotal: a.tokens.total, archivedAt: Date())
        selection.remove(a.sessionId)
        if selectedAgent == a.sessionId { selectedAgent = nil }
        saveArchive(); refresh()
    }
    func restore(_ ids: Set<String>) {
        // the card comes back from the CLI's own files (the transcript, or the live process)
        for id in ids where archive[id] != nil { deleted.remove(id); archive[id] = nil }
        archiveSelection.subtract(ids)
        saveArchive(); saveSeen(); refresh()
        notice = L("%@개 세션을 보관함에서 복원했습니다.", String(ids.count))
    }
    /// Permanent: the transcript and its folders are removed from disk.
    func purge(_ ids: Set<String>) {
        for id in ids {
            guard let it = archive[id] else { continue }
            var a = Agent(sessionId: it.sessionId, pid: nil, name: it.name, state: .ended)
            a.teamName = it.teamName; a.isLead = it.isLead; a.transcriptPath = it.transcriptPath
            delete(a)
            archive[id] = nil
        }
        archiveSelection.subtract(ids)
        saveArchive(); refresh()
        notice = L("%@개 세션을 영구 삭제했습니다.", String(ids.count))
    }
    private func saveArchive() {
        try? FileManager.default.createDirectory(at: archiveURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let d = try? JSONEncoder().encode(archive) { try? d.write(to: archiveURL) }
    }

    func agent(_ sid: String?) -> Agent? {
        guard let sid else { return nil }
        return (teams.flatMap(\.members) + loose).first { $0.sessionId == sid }
    }

    // MARK: terminal
    /// A fresh login shell in its own background tmux session, shown inside the app.
    func newTerminal(cwd: String?) -> String? {
        let dir = cwd.flatMap { FileManager.default.fileExists(atPath: $0) ? $0 : nil } ?? Shell.home
        let name = "ab-term-" + String(Int(Date().timeIntervalSince1970) % 100000)
        let r = Shell.tmux(["new-session", "-d", "-s", name, "-x", "120", "-y", "40", "-c", dir, "-e", "PATH=\(Shell.path)", "/bin/zsh -l"])
        guard r.code == 0 else { notice = L("새 터미널을 열지 못했습니다: %@", String(r.err.prefix(120))); return nil }
        return Shell.tmux(["list-panes", "-t", name, "-F", "#{pane_id}"]).out.split(separator: "\n").first.map(String.init)
    }
    func closeTerminal(pane: String) {
        let s = Shell.tmux(["display-message", "-p", "-t", pane, "#{session_name}"]).out.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("ab-term-") { Shell.tmux(["kill-session", "-t", s]) }
    }
    /// `claude stop|rm <job>`: the CLI's own background-job management.
    static func cliJob(_ args: [String]) {
        DispatchQueue.global(qos: .utility).async { _ = Shell.run([Shell.claude] + args, timeout: 30) }
    }
    /// Opens Terminal attached to the session's tmux session, with its pane selected.
    func openTerminal(_ a: Agent) {
        guard let sess = a.tmuxSession, let pane = a.tmuxPane else { notice = L("이 세션은 tmux 안에서 실행되고 있지 않아 터미널로 열 수 없습니다."); return }
        let r = attachTerminal(session: sess, pane: pane)
        notice = r.code == 0 ? L("터미널에서 '%@'의 tmux 세션을 열었습니다. 닫을 때는 창만 닫으면 되고(세션은 계속 실행), 터미널에서 입력한 것도 여기에 반영됩니다.", a.name) : L("터미널을 열지 못했습니다: %@", String(r.err.prefix(120)))
    }
    private static func q(_ s: String) -> String { "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'" }
    /// The default Terminal app attached to a tmux session, on `pane`'s window. No `resize-window` here (it would pin the
    /// window to `manual` size): with `window-size latest` the window follows the terminal while it is attached, and the
    /// app's own views stop resizing it for as long as a client is attached (TmuxResize / #{session_attached}).
    private func attachTerminal(session sess: String, pane: String) -> Shell.Result {
        let dir = Shell.home + "/.agent-boost"
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let file = dir + "/open-\(sess).command"
        let script = "#!/bin/zsh\nexec \(Self.q(Shell.tmux)) -u attach-session -t \(Self.q(sess)) \\; select-window -t \(Self.q(pane)) \\; select-pane -t \(Self.q(pane)) \\; set-window-option -t \(Self.q(pane)) window-size latest\n"
        try? script.write(toFile: file, atomically: true, encoding: .utf8)
        chmod(file, 0o755)
        return Shell.run(["/usr/bin/open", "-a", "Terminal", file], timeout: 10)
    }
    /// Any tmux pane (in-app shell tab or CLI screen) in the default Terminal app.
    @discardableResult
    func openExternal(pane: String, title: String) -> Bool {
        let sess = Shell.tmux(["display-message", "-p", "-t", pane, "#{session_name}"]).out.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !sess.isEmpty else { notice = L("터미널 '%@'을(를) 찾지 못했습니다.", title); return false }
        let r = attachTerminal(session: sess, pane: pane)
        notice = r.code == 0 ? L("'%@'을(를) 터미널 앱으로 내보냈습니다.", title) + (sess.hasPrefix("ab-term-") ? L(" 셸을 끝내려면 그 창에서 exit 하세요.") : "") : L("터미널을 열지 못했습니다: %@", String(r.err.prefix(120)))
        return r.code == 0
    }
    /// A plain shell in the default Terminal app, outside tmux and outside the app.
    func openExternalShell(cwd: String?) {
        let d = cwd.flatMap { FileManager.default.fileExists(atPath: $0) ? $0 : nil } ?? Shell.home
        let r = Shell.run(["/usr/bin/open", "-a", "Terminal", d], timeout: 10)
        if r.code != 0 { notice = L("터미널을 열지 못했습니다: %@", String(r.err.prefix(120))) }
    }

    // MARK: housekeeping
    /// Teams whose members are all ended and none has a transcript: nothing to show or resume.
    var emptyTeams: [Team] { teams.filter { t in !t.members.isEmpty && t.members.allSatisfy { $0.state == .ended && $0.transcriptPath == nil } } }
    func pruneEmptyTeams(silent: Bool = false) {
        let fm = FileManager.default
        var n = 0
        for t in emptyTeams {
            for dir in ["teams", "tasks"] {
                let p = Shell.home + "/.claude/\(dir)/\(t.name)"
                if fm.fileExists(atPath: p) { try? fm.trashItem(at: URL(fileURLWithPath: p), resultingItemURL: nil) }
            }
            seen[t.name] = nil; n += 1
        }
        saveSeen(); refresh()
        if !silent { notice = L("기록 없는 팀 %@개를 정리했습니다. 팀 폴더는 휴지통으로 옮겼습니다.", String(n)) }
    }

    // MARK: usage
    static let probeDir = Shell.home + "/.agent-boost/usage-probe"
    nonisolated private static func parseUsage(_ text: String) -> [UsageMeter] {
        var out: [UsageMeter] = []
        let re = try! NSRegularExpression(pattern: #"(?m)^\s*(Current [^:]+):\s*(\d+)% used(?:\s*·\s*resets ([^\n]+))?"#)
        for m in re.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
            func g(_ i: Int) -> String { Range(m.range(at: i), in: text).map { String(text[$0]) } ?? "" }
            out.append(UsageMeter(label: g(1), percent: Int(g(2)) ?? 0, resets: g(3)))
        }
        return out
    }
    func fetchUsage() async {
        if usageBusy { return }
        usageBusy = true
        let probe = Self.probeDir
        try? FileManager.default.createDirectory(atPath: probe, withIntermediateDirectories: true)
        // --no-session-persistence: the usage probe must not leave a session behind (it used to,
        // once every 5 minutes, which is where the tmp-xx cards came from)
        let r = await Task.detached { Shell.run([Shell.claude, "-p", "--no-session-persistence", "/usage"], timeout: 120, cwd: probe) }.value
        let parsed = Self.parseUsage(r.out)
        if parsed.isEmpty {
            // no usage lines: a CLI that is not logged in prints only a cost summary (exit 0, empty stderr), so ask it
            let login = await Task.detached { Self.loginStatus() }.value
            loggedOut = login == false
            usageError = login == false ? Self.loginHint : (r.err.isEmpty ? L("사용량 출력을 읽지 못함") : String(r.err.prefix(160)))
            if login == false, !loginNoticed { loginNoticed = true; notice = Self.loginHint }
        } else { meters = parsed; usageUpdated = Date(); usageError = nil; loggedOut = false }
        usageBusy = false
    }
    static var loginHint: String { L("Claude Code에 로그인되어 있지 않습니다. 터미널에서 claude 를 한 번 실행해 로그인하면 사용량과 세션이 동작합니다.") }
    private var loginNoticed = false
    /// `claude auth status` → {"loggedIn": true|false, …}. nil: the CLI did not answer (missing, old version, timeout).
    nonisolated static func loginStatus() -> Bool? {
        let r = Shell.run([Shell.claude, "auth", "status"], timeout: 30)
        guard let d = r.out.data(using: .utf8), let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return nil }
        return j["loggedIn"] as? Bool
    }
}
