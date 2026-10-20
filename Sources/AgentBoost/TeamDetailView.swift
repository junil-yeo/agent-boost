import SwiftUI

/// One team: member list on the left, a friendly chat view + controls on the right.
struct TeamDetailView: View {
    @EnvironmentObject var store: BoardStore
    var team: Team
    var isLoose = false
    var active = true                       // the tab on screen (hidden tabs stay built, so switching is instant)
    @State private var addingToLead = false
    @State private var sel: String?         // this tab's own selection; mirrored to the store only while active
    /// Split view: [lead (left, big), teammates (right, top→bottom)]. A click on a teammate puts it beside the lead, a
    /// second click takes it out; with no teammate open the lead's full panel shows. No switch: the clicks are the control.
    @State private var slots: [String] = []
    private var split: Bool { !isLoose && slots.count > 1 }
    private func belongs(_ a: Agent) -> Bool { isLoose ? (a.teamName == nil || a.solo) : a.teamName == team.name }
    @AppStorage("ui.sidebarWidth") private var sideWidth: Double = 240
    var body: some View {
        HStack(spacing: 0) {
            VStack(spacing: 0) {
            List(selection: $sel) {
                if isLoose {
                    let live = team.members.filter { $0.state != .ended }, done = team.members.filter { $0.state == .ended }
                    Section(L("실행 중 %@", String(live.count))) { ForEach(live) { a in MemberRow(agent: a).tag(a.sessionId) } }
                    if !done.isEmpty { Section(L("종료됨 %@ — 다시 시작 가능", String(done.count))) { ForEach(done) { a in MemberRow(agent: a).tag(a.sessionId) } } }
                } else {
                    if let lead = team.lead { Section(L("팀장")) { MemberRow(agent: lead).tag(lead.sessionId) } }
                    Section(L("팀원 %@명", String(team.workers.count))) {
                        ForEach(team.workers) { a in
                            MemberRow(agent: a).tag(a.sessionId)
                                // every click toggles the teammate beside the lead (List selection does not report a click on the selected row)
                                .simultaneousGesture(TapGesture().onEnded { toggleSlot(a.sessionId) })
                                .overlay(alignment: .leading) { if slots.contains(a.sessionId) { Rectangle().fill(Theme.accent).frame(width: 3).offset(x: -8) } }
                                .help(slots.contains(a.sessionId) ? L("다시 누르면 분할 화면에서 뺍니다") : L("누르면 팀장 옆에 나란히 엽니다"))
                        }
                        if let lead = team.lead, store.canControl(lead) {
                            Button { addingToLead = true } label: { Label(L("팀원 추가…"), systemImage: "person.badge.plus").foregroundStyle(Theme.accent) }.buttonStyle(.icon)
                        }
                    }
                }
            }
            .listStyle(.sidebar).scrollContentBackground(.hidden)   // opaque: no desktop showing through
            }
            .areaBox()
            .frame(width: sideWidth)
            // the gap between the side bar and the conversation is also its resize handle
            ResizeGap(axis: .horizontal) { d in sideWidth = min(420, max(200, sideWidth + d)) }
            if split {
                splitArea
            } else if let a = store.agent(sel), belongs(a) {
                AgentPanel(agent: a)
            } else {
                emptyState.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .onAppear { if let s = store.selectedAgent, let a = store.agent(s), belongs(a) { sel = s }; autoSelect(); if active { store.selectedAgent = sel } }
        .onChange(of: team.members.map(\.sessionId)) { _, _ in autoSelect() }
        .onChange(of: sel) { old, s in
            if active { store.selectedAgent = s }
        }
        .onChange(of: active) { _, on in if on { store.selectedAgent = sel } }
        .onChange(of: store.selectedAgent) { _, s in       // chosen elsewhere (org chart, notification): follow if it is ours
            if active, let s, s != sel, let a = store.agent(s), belongs(a) {
                sel = s
                if !isLoose, s != team.lead?.sessionId, team.lead != nil, !slots.contains(s) { fixSlots(); slots.append(s) }   // a teammate opens beside the lead
            }
        }
        .onAppear { fixSlots() }
        .sheet(isPresented: $addingToLead) { if let lead = team.lead { AddTeammateSheet(agent: lead) } }
    }
    /// Entering a team opens the lead's conversation right away.
    private func autoSelect() {
        let ok = store.agent(sel).map(belongs) ?? false
        if !ok { sel = (team.lead ?? team.members.first)?.sessionId }
        fixSlots()
    }
    private func toggleSlot(_ s: String) {
        guard !isLoose, let lead = team.lead?.sessionId, s != lead else { return }
        fixSlots()
        if slots.contains(s) {
            slots.removeAll { $0 == s }
            if slots.count == 1 { sel = lead }            // the last teammate left: back to the lead's full panel
        } else { slots.append(s) }
    }
    /// Split slots: the lead is always in (left unless a drag swapped it), plus the teammates still in the team.
    private func fixSlots() {
        guard !isLoose, let l = team.lead?.sessionId else { slots = []; return }
        let ids = Set(team.workers.map(\.sessionId))
        var s = slots.filter { $0 == l || ids.contains($0) }
        if !s.contains(l) { s.insert(l, at: 0) }
        if s != slots { slots = s }
    }
    @ViewBuilder private var splitArea: some View {
        let agents = slots.compactMap { store.agent($0) }
        if let left = agents.first {
            let right = Array(agents.dropFirst())
            if right.isEmpty { SplitPane(agent: left, swap: swap) }
            else {
                ResizableSplit(axis: .horizontal, count: 2, min: 320) { i in
                    if i == 0 { SplitPane(agent: left, swap: swap) }
                    else {
                        ResizableSplit(axis: .vertical, count: right.count, min: 140) { j in SplitPane(agent: right[j], swap: swap) }
                            .id(right.map(\.sessionId).joined())        // new pane set: start again from equal parts
                    }
                }
            }
        } else { emptyState.frame(maxWidth: .infinity, maxHeight: .infinity) }
    }
    /// Dropping pane `a` on pane `b`: they trade places (a teammate dropped on the left takes the big slot).
    private func swap(_ a: String, _ b: String) {
        guard a != b, let i = slots.firstIndex(of: a), let j = slots.firstIndex(of: b) else { return }
        slots.swapAt(i, j)
    }
    @ViewBuilder private var emptyState: some View {
        if isLoose {
            ContentUnavailableView(L("개별 세션이 없습니다"), systemImage: "person", description: Text(L("+ 새 세션으로 시작할 수 있습니다.")))
        } else if let lead = team.lead, store.canControl(lead) {
            VStack(spacing: 12) {
                Image(systemName: "person.3").font(.system(size: 40)).foregroundStyle(.secondary)
                Text(L("아직 팀원이 없습니다")).font(.title3)
                Text(L("팀장 '%@'이(가) 팀원을 만듭니다. 이름·역할·모델·effort를 정해 주세요.", lead.name)).font(.callout).foregroundStyle(.secondary)
                Button { addingToLead = true } label: { Label(L("팀원 추가"), systemImage: "person.badge.plus") }.buttonStyle(.raisedProminent)
            }
        } else if let lead = team.lead, store.canResume(lead) {
            VStack(spacing: 12) {
                Image(systemName: "moon.zzz").font(.system(size: 40)).foregroundStyle(.secondary)
                Text(L("팀장이 종료된 팀입니다")).font(.title3)
                Text(L("팀장을 다시 시작하면 대화를 이어가고 팀원도 새로 만들 수 있습니다.")).font(.callout).foregroundStyle(.secondary)
                Button(L("팀장 선택")) { store.selectedAgent = lead.sessionId }.buttonStyle(.raisedProminent)
            }
        } else {
            ContentUnavailableView(L("표시할 세션이 없습니다"), systemImage: "person.crop.rectangle")
        }
    }
}

struct MemberRow: View {
    var agent: Agent
    private var store: BoardStore { BoardStore.shared! }   // read at click time only: rows must not observe the whole store
    @State private var hover = false
    /// Quick quit / archive on hover, each behind a short confirmation.
    private var quickActions: some View {
        HStack(spacing: 2) {
            if agent.state != .ended && agent.pid != nil {
                Button { if confirm(L("'%@' 세션을 종료할까요?", agent.name), L("보드에 남아 다시 시작할 수 있습니다.")) { store.quit(agent, mode: .now) } } label: { Image(systemName: "power") }
                    .buttonStyle(.icon).help(L("종료 (/exit)"))
            } else if agent.state == .ended, agent.transcriptPath != nil, !agent.isSubagent {
                reviveButton                       // same place and size as 종료: power, then 보관
            }
            Button { if confirm(L("'%@' 세션을 보관할까요?", agent.name), L("세션을 끄고 보드에서 치웁니다. 보관함에서 복원할 수 있습니다.")) { store.archive(agent, withTeammates: false) } } label: { Image(systemName: "archivebox") }
                .buttonStyle(.icon).help(L("보관"))
        }.font(.caption)
    }
    /// An ended session: start it again from the row (same ID, its last model and effort). A teammate comes back as a
    /// loose session, so that is said first and confirmed.
    private var reviveButton: some View {
        Button {
            let mate = agent.teamName != nil && !agent.isLead
            guard confirm(L("'%@' 세션을 다시 시작할까요?", agent.name),
                          mate ? L("재시작하는 팀원은 팀과 분리된 개별 세션으로 열립니다. 팀장과의 연결은 복구되지 않습니다.") : L("이전 대화를 같은 세션 ID로 이어서 엽니다.")) else { return }
            let model = ModelChoice(rawValue: agent.model ?? "") ?? ModelChoice.allCases.first { (agent.model ?? "").hasPrefix($0.rawValue) } ?? .sonnet
            _ = store.resume(agent, model: model, effort: EffortChoice(rawValue: agent.effort ?? "") ?? .medium)
        } label: { Image(systemName: "power") }
        .buttonStyle(.icon).help(L("다시 시작 — 같은 세션 ID로 이어서 엽니다"))
    }
    private func confirm(_ title: String, _ info: String) -> Bool {
        let a = NSAlert(); a.messageText = title; a.informativeText = info
        a.addButton(withTitle: L("확인")); a.addButton(withTitle: L("취소"))
        return a.runModal() == .alertFirstButtonReturn
    }
    var body: some View {
        HStack(spacing: 8) {
            StateDot(state: agent.state)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    if agent.isSubagent { Text(L("서브")).font(.caption2.weight(.semibold)).padding(.horizontal, 4).background(Capsule().fill(Theme.ink.opacity(0.12))).help(L("팀장이 Agent 도구로 띄운 서브에이전트 — 보기 전용")) }
                    Text(agent.name).font(.headline).foregroundStyle(Color.primary).lineLimit(1)
                }
                HStack(spacing: 4) {
                    Text((agent.isBackgroundJob ? L("백그라운드 분기 · ") : "") + L("%@ · 출력 %@", agent.displayModel, Fmt.tokens(agent.tokens.output))).font(.callout).foregroundStyle(.secondary).lineLimit(1).opacity(agent.isEstimated ? 0.6 : 1)
                    if agent.requestedModel != nil || agent.requestedEffort != nil {
                        Image(systemName: "hourglass").font(.caption).foregroundStyle(.orange).help(L("모델·effort 변경 적용 대기 중"))
                    }
                }
            }
            Spacer()
            if hover { quickActions }
            // the plain state ("작업 중"); the CLI's verb and time go to the tooltip
            let live = agent.state == .busy ? agent.screen.flatMap { s in s.verb.map { v in v + "…" + (s.elapsed.map { " " + $0 } ?? "") } } : nil
            Text(Fmt.stateLabel(agent.state)).font(.caption.weight(.semibold)).foregroundStyle(Fmt.stateColor(agent.state)).lineLimit(1)
                .padding(.horizontal, 7).padding(.vertical, 2)
                .background(Capsule().fill(Fmt.stateColor(agent.state).opacity(0.14)))
                .opacity(agent.stateUnconfirmed ? 0.7 : 1).help(agent.stateUnconfirmed ? L("%@ — 상태 확인 중", Fmt.stateLabel(agent.state)) : (live ?? ""))
        }.padding(.vertical, 2).contentShape(Rectangle()).onHover { hover = $0 }
    }
}

struct AgentPanel: View {
    @EnvironmentObject var store: BoardStore
    var agent: Agent
    @State private var renaming = false
    @State private var deleting = false
    @State private var addingTeammate = false
    @State private var resuming = false
    @State private var quitting = false
    @AppStorage("chat.showThinking") private var showThinking = false
    @AppStorage("chat.expandTools") private var showTools = false      // true = every tool call / result expanded
    @AppStorage("ui.termChat") private var termChat = true
    private let paneChat = true   // the CLI screen is the only chat view (the transcript view stays for sessions without one)
    @AppStorage("ui.chatFont") private var chatFont: Double = 15
    @State private var terms: [TermTab] = []          // terminal tabs beside the chat
    @State private var termSel: UUID?
    @State private var headerWidth: CGFloat = 1000

    /// The team leader's session alias (looked up at display time, so /rename shows at once).
    private var leadAlias: String {
        let lead = store.teams.first { $0.name == agent.teamName }?.lead ?? (agent.isLead ? agent : nil)
        guard let n = lead?.name, !n.isEmpty, n != "team-lead", n != "main", n != lead?.sessionId.prefix(8).description else { return L("팀장") }
        return n
    }
    var body: some View {
        VStack(spacing: Theme.gap) {
            HSplitView {
                // name, chat and input box: one box, like an editor group in VS Code (no lines between them)
                VStack(spacing: 0) {
                    header
                    Group {
                    if Bench.noChat { Color.clear } else if paneChat, let p = agent.tmuxPane, agent.state != .ended {
                        PaneChatView(pane: p, sid: agent.sessionId).id(agent.sessionId)       // the CLI's own screen (conversation part)
                    } else {
                    ChatView(entries: store.chat[agent.sessionId] ?? [], showThinking: showThinking, showTools: showTools,
                             agentName: agent.name, userLabel: (agent.teamName != nil && !agent.isLead && !agent.solo) ? L("팀장 지시") : L("나"), leadName: leadAlias,
                             loading: store.chat[agent.sessionId] == nil && agent.transcriptPath != nil, sessionId: agent.sessionId,
                             lastSent: { store.lastSentAt }, holdOlderRows: { [store, sid = agent.sessionId] in store.holdOlderRows($0, sid: sid) }, termStyle: termChat, fontSize: chatFont)
                        .equatable()
                        .id(agent.sessionId)
                        
                    }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    if !Bench.noComposer { ComposerBar(agent: agent, quitting: $quitting, openTerminal: openSessionTerminal).id(agent.sessionId) }
                }
                .areaBox()
                .frame(minWidth: 380)
                if !terms.isEmpty {
                    VStack(spacing: 0) {
                        termTabBar
                        if let t = terms.first(where: { $0.id == termSel }) ?? terms.first {
                            // .id: every tab gets its own view (and its own poll timer / key target)
                            TerminalPanel(pane: t.pane, title: t.title, fitWindow: t.owned) { closeTab(t) }
                                .id(t.id)
                        }
                    }
                    .frame(minWidth: 360, idealWidth: 560)
                    .areaBox()
                    .padding(.leading, Theme.gap)
                }
            }
        }
        .onChange(of: agent.sessionId) { _, _ in
            terms.removeAll { !$0.owned }                       // another agent's CLI screen doesn't belong here
            if !terms.contains(where: { $0.id == termSel }) { termSel = terms.last?.id }
        }
        .onAppear { _ = store.canSpawnTeammates(agent) }
        .onDisappear { for t in terms where t.owned { store.closeTerminal(pane: t.pane) } }
    }
    private func openNewTerminal() {
        guard let p = store.newTerminal(cwd: agent.cwd ?? store.workingDirectory(of: agent)) else { return }
        let n = terms.filter(\.owned).count + 1
        let t = TermTab(pane: p, title: L("셸 %@", String(n)), owned: true); terms.append(t); termSel = t.id
    }
    private func openSessionTerminal() {
        guard let p = agent.tmuxPane else { return }
        if let t = terms.first(where: { $0.pane == p }) { termSel = t.id; return }   // already open: just switch to it
        let t = TermTab(pane: p, title: "\(agent.name) CLI", owned: false); terms.append(t); termSel = t.id
    }
    private func closeTab(_ t: TermTab) {
        if t.owned { store.closeTerminal(pane: t.pane) }
        let i = terms.firstIndex(where: { $0.id == t.id }) ?? 0
        terms.removeAll { $0.id == t.id }
        if termSel == t.id { termSel = terms.isEmpty ? nil : terms[min(i, terms.count - 1)].id }
    }
    /// Hands a tab to the default Terminal app (the tmux session keeps running there) and removes it here.
    private func popOut(_ t: TermTab) {
        guard store.openExternal(pane: t.pane, title: t.title) else { return }
        terms.removeAll { $0.id == t.id }
        if termSel == t.id { termSel = terms.last?.id }
    }
    private var termTabBar: some View {
        HStack(spacing: 4) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 4) {
                    ForEach(terms) { t in
                        let sel = t.id == (termSel ?? terms.first?.id)
                        HStack(spacing: 5) {
                            Image(systemName: t.owned ? "apple.terminal" : "sparkles").font(.caption)
                            Text(t.title).font(.callout.weight(sel ? .semibold : .regular)).lineLimit(1)
                            Button { closeTab(t) } label: { Image(systemName: "xmark").font(.caption2.bold()) }
                                .buttonStyle(.plain).foregroundStyle(.secondary).help(t.owned ? L("닫기 (셸 종료)") : L("닫기 (세션은 계속 실행)"))
                        }
                        .padding(.horizontal, 9).padding(.vertical, 5)
                        .background(RoundedRectangle(cornerRadius: 6).fill(sel ? Theme.accent.opacity(0.22) : Theme.ink.opacity(0.10)))
                        .overlay(RoundedRectangle(cornerRadius: 6).stroke(sel ? Theme.accent.opacity(0.6) : Theme.lineHi))
                        .contentShape(Rectangle()).onTapGesture { termSel = t.id }
                        .contextMenu { Button(L("기본 터미널 앱으로 내보내기")) { popOut(t) }; Button(L("닫기")) { closeTab(t) } }
                    }
                }
            }
            Menu {
                Button(L("새 터미널 (셸)")) { openNewTerminal() }
                Button(L("세션 터미널 (CLI 화면)")) { openSessionTerminal() }.disabled(agent.tmuxPane == nil || agent.state == .ended)
            } label: { Image(systemName: "plus") }
            .menuStyle(.button).buttonStyle(.raisedCompact).menuIndicator(.hidden).fixedSize().help(L("터미널 탭 추가"))
            if let t = terms.first(where: { $0.id == termSel }) ?? terms.first {
                Button { popOut(t) } label: { Image(systemName: "arrow.up.forward.app") }
                    .buttonStyle(.raisedCompact).help(L("이 탭을 기본 터미널 앱으로 내보내기 (앱 밖에서 계속 실행)"))
            }
        }
        .padding(.horizontal, 8).padding(.vertical, 5).background(.bar)
    }

    private var actionButtons: some View {
        HStack(spacing: 8) {
                LazyMenu(entries: {
                    let live = agent.tmuxPane != nil && agent.state != .ended
                    var e: [MenuEntry] = [.header(L("앱 안에서 (탭으로 추가)")),
                        .item(L("새 터미널 — 이 세션 폴더에서 깨끗한 셸")) { openNewTerminal() },
                        .item(L("세션 터미널 — 이 세션의 실제 CLI 화면"), enabled: live) { openSessionTerminal() },
                        .separator, .header(L("기본 터미널 앱으로 (외부)")),
                        .item(L("새 터미널 — 이 세션 폴더에서")) { store.openExternalShell(cwd: agent.cwd ?? store.workingDirectory(of: agent)) },
                        .item(L("세션 터미널 — 이 세션의 CLI 화면"), enabled: live) { store.openTerminal(agent) }]
                    if !terms.isEmpty { e += [.separator, .item(L("터미널 탭 모두 닫기")) { for t in terms { closeTab(t) } }] }
                    return e
                }) { Label(L("터미널"), systemImage: "terminal") }
                .buttonStyle(.raisedCompact).fixedSize().help(L("대화창 옆에 터미널을 엽니다"))
                if store.canQuit(agent) {
                    Button { quitting = true } label: { Label(L("종료"), systemImage: "power") }.buttonStyle(.raisedCompact).fixedSize().help(L("종료 (/exit) — 세션을 끕니다. 보드에는 남아 다시 시작할 수 있습니다"))
                }
                if store.canResume(agent) {
                    Button { resuming = true } label: { Label(L("다시 시작"), systemImage: "power") }.buttonStyle(.raisedCompact).fixedSize().help(L("다시 시작"))
                } else {
                    Button { addingTeammate = true } label: { Label(L("팀원 추가"), systemImage: "person.badge.plus") }
                        .buttonStyle(.raisedCompact).fixedSize().disabled(!agent.canReceiveInput).help(L("팀원 추가"))
                }
                Button { deleting = true } label: { Label(L("보관"), systemImage: "archivebox") }
                    .buttonStyle(.raisedCompact).fixedSize()
                    .help(L("보관 — 세션을 끄고 보드에서 치웁니다 (보관함에서 복원할 수 있습니다)"))
        }
        .fixedSize()                                         // the buttons never squeeze; the name gives way instead
    }

    private var header: some View {
        HStack(spacing: 8) {     // one row: who it is, its settings and status, then the actions (the chat keeps the height)
            StateDot(state: agent.state)
            Text(agent.name).font(.title3.bold()).lineLimit(1).truncationMode(.tail).frame(minWidth: 80, alignment: .leading)
                .layoutPriority(1)
                .help(agent.teamAddress.map { L("%@\n팀 주소: %@", agent.name, $0) } ?? agent.name)
            Button { renaming = true } label: { Image(systemName: "pencil") }.buttonStyle(.icon).help(L("이름 변경"))
            if let p = agent.pendingName { Text(L("→ '%@' 대기 중", p)).font(.caption).foregroundStyle(.orange).lineLimit(1) }
            if agent.isLead && !agent.solo { Chip(text: L("팀장"), tint: Theme.accent) }
            if let o = agent.overlay { Chip(text: "CLI: " + BoardStore.overlayName(o), tint: .orange).help(L("CLI 화면이 대화가 아니라 목록·선택 화면입니다. 입력은 CLI에서 Esc로 돌아온 뒤에 할 수 있습니다.")) }
            if agent.isBackgroundJob, let j = agent.jobId { Chip(text: L("백그라운드 작업 %@", j), tint: .white).help(L("claude agents에 실린 CLI 백그라운드 작업입니다 (← agents 화면으로 들어가면서 옮겨졌거나 --bg로 시작). 종료는 claude stop, 화면은 claude attach로 붙입니다.")) }
            LazyMenu(entries: { ModelChoice.allCases.map { m in .item(m.label + (agent.model == m.rawValue ? " ✓" : "")) { store.setModel(m, for: agent) } } }) {
                Chip(text: agent.displayModel + (agent.requestedModel != nil ? " ⏳" : ""), tint: .white).opacity(agent.modelIsGuess ? 0.55 : 1)
            }
            .buttonStyle(.plain).fixedSize()
            .disabled(!agent.canReceiveInput).help(agent.requestedModel != nil ? L("다음 응답부터 적용됩니다") : L("모델 변경"))
            LazyMenu(entries: { EffortChoice.allCases.map { e in .item(e.rawValue + (agent.effort == e.rawValue ? " ✓" : "")) { store.setEffort(e, for: agent) } } }) {
                Chip(text: "effort \(agent.effort ?? "?")" + (agent.requestedEffort != nil ? " ⏳" : ""), tint: .white)
            }
            .buttonStyle(.plain).fixedSize()
            .disabled(!agent.canReceiveInput).help(agent.requestedEffort != nil ? L("다음 응답부터 적용됩니다") : L("effort 변경"))
            Chip(text: Fmt.stateLabel(agent.state), tint: Fmt.stateColor(agent.state)).opacity(agent.stateUnconfirmed ? 0.7 : 1).help(agent.stateUnconfirmed ? L("상태 확인 중") : "")
            RemoteChip(agent: agent)
            if agent.state == .needsInput, !agent.pendingCommands.isEmpty { Button(L("그래도 보내기")) { store.forceSendPending(agent) }.buttonStyle(.raisedCompact).fixedSize().help(L("질문 대기로 보이지만 대기 중인 명령을 지금 보냅니다")) }
            if agent.pendingCommands.contains("/exit") { Text(L("작업 끝나면 종료")).font(.caption).foregroundStyle(.orange).fixedSize() }
            if headerWidth >= 1000, let c = agent.cwd ?? store.workingDirectory(of: agent) {     // first to go when narrow
                Label((c as NSString).lastPathComponent, systemImage: "folder").font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle).help(c)
            }
            if agent.tmuxPane == nil && agent.state != .ended {
                Label(agent.entrypoint == "claude-desktop" ? L("데스크톱 앱 세션 · 보기 전용") : L("보기 전용"), systemImage: "eye")
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1).fixedSize()
                    .help(agent.entrypoint == "claude-desktop" ? L("Claude 데스크톱 앱의 세션이라 이 앱에서는 입력할 수 없습니다") : L("이 앱에서 입력할 수 없는 세션입니다"))
            }
            Spacer(minLength: 8)
            if agent.tmuxPane == nil || agent.state == .ended {
                Toggle(L("도구 펼침"), isOn: $showTools).toggleStyle(.checkbox).font(.caption).fixedSize()
                Toggle(L("생각"), isOn: $showThinking).toggleStyle(.checkbox).font(.caption).fixedSize()
            }
            // titles when they fit, icons (with tooltips) otherwise — measured, the row is built once
            if headerWidth >= 1400 { actionButtons.labelStyle(.titleAndIcon) } else { actionButtons.labelStyle(.iconOnly) }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .onGeometryChange(for: Int.self) { $0.size.width >= 1400 ? 1400 : $0.size.width >= 1000 ? 1000 : 0 } action: { headerWidth = CGFloat($0) }
        .background(Theme.area)
        .agentActions(agent, renaming: $renaming, deleting: $deleting)
        .sheet(isPresented: $addingTeammate) { AddTeammateSheet(agent: agent) }
        .sheet(isPresented: $resuming) { ResumeSheet(agent: agent) }
        .quitDialog(agent, isPresented: $quitting)
    }
}

extension Notification.Name { static let attachToComposer = Notification.Name("agentboost.attachToComposer") }
/// The drop target look: light blue, fine dashes, a faint white fill.
struct DropHint: View {
    var body: some View {
        RoundedRectangle(cornerRadius: 6).fill(Theme.ink.opacity(0.06))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(Theme.busy, style: StrokeStyle(lineWidth: 2, dash: [4, 3])))
            .padding(4)
    }
}
/// The input line with its own state (draft, attachments, slash palette): a keystroke redraws only this view, never the chat above it.
struct ComposerBar: View {
    @EnvironmentObject var store: BoardStore
    var agent: Agent
    @Binding var quitting: Bool
    var openTerminal: () -> Void
    @State private var draft = ""
    @State private var attachments: [URL] = []
    @State private var dropping = false
    @State private var refused: String?                    // why the last send did not go through, shown at the box
    @StateObject private var slash = SlashController()
    @StateObject private var mention = MentionController()
    @State private var hist = HistoryNav()
    @State private var completer = HistoryCompleter()          // a class: its caches survive body passes
    private var sid: String { agent.sessionId }
    private var entries: [ChatEntry] { store.chat[sid] ?? [] }
    /// Grey text Tab would fill: while typing, the newest earlier prompt that starts the same way; on an empty box,
    /// the next step the conversation suggests (an answer to the agent's question …).
    private var ghost: String? {
        guard agent.canReceiveInput, !hist.active, slash.items(for: draft).isEmpty, mention.items(for: draft).isEmpty else { return nil }
        // only the CLI's own prediction (its model wrote it for this conversation); no history / rule guesses
        guard agent.state == .idle, let cli = agent.screen?.suggestion else { return nil }
        if draft.isEmpty { return cli }
        if cli.count > draft.count, cli.lowercased().hasPrefix(draft.lowercased()) { return cli }
        return nil
    }
    /// Newest tool call since my last message ("Bash · ls -la"): what the agent is doing right now.
    private var currentTool: String? {
        guard agent.state == .busy else { return nil }
        for e in entries.reversed() {
            if e.role == .user && e.toolName != "전송 중" { return nil }
            if e.role == .tool, e.toolName != "결과" {
                let first = e.text.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
                return (e.toolName ?? "tool") + (first.isEmpty ? "" : " · " + first)
            }
        }
        return nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            let g = ghost                                   // once per pass: the field and the footer both show it
            TurnStatusBar(agent: agent, lastTool: currentTool, queued: agent.tmuxPane != nil && agent.state != .ended ? agent.queued : entries.filter { $0.toolName == "전송 중" }.count, onInterrupt: { store.interrupt(agent) }, onPushQueue: { store.pushQueue(agent) }, onPullQueue: { store.pullQueue(agent) })
                .padding(.horizontal, -20)
            if agent.state == .needsInput, let p = agent.prompt {
                PromptCard(title: p.title, detail: p.detail, preview: p.preview, options: p.options, cursor: p.cursor,
                           sending: store.promptSending.contains(agent.sessionId),
                           onChoose: { store.answerPrompt(agent, optionIndex: $0) }, onCancel: { store.cancelPrompt(agent) })
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            if !attachments.isEmpty { AttachmentStrip(urls: $attachments) }
            if let why = refused {
                // shown here even with notices off: a send that silently did nothing looked like a broken box
                HStack(spacing: 10) {
                    Label(why, systemImage: "exclamationmark.triangle.fill").font(.callout).foregroundStyle(Theme.attention)
                        .fixedSize(horizontal: false, vertical: true)
                    if agent.tmuxPane != nil, agent.overlay == nil {
                        // text left in the CLI's box blocks every send: let the user empty it from here
                        Button(L("CLI 입력창 비우기")) { store.clearCLIInput(agent); refused = nil }.buttonStyle(.raisedCompact)
                            .help(L("CLI 입력창에 남은 글을 지웁니다 (Ctrl+U). 실행 중인 작업은 멈추지 않습니다."))
                    }
                }
                .task(id: why) { try? await Task.sleep(for: .seconds(15)); if refused == why { refused = nil } }
            }
            HStack(alignment: .bottom, spacing: 8) {
                Button { pickFiles() } label: { Image(systemName: "paperclip").font(.system(size: 16, weight: .medium)).frame(width: 34, height: 42) }
                    .buttonStyle(.icon).disabled(!agent.canReceiveInput).help(L("파일 첨부 (창에 끌어다 놓거나 ⌘V로 스크린샷 붙여넣기도 됩니다)"))
                Composer(text: $draft, placeholder: agent.canReceiveInput ? L("메시지 입력 — Enter 전송 · ⇧Enter 줄바꿈 · / 명령")
                         : (agent.overlay.map { L("입력 불가: CLI가 %@ 화면입니다 — CLI에서 Esc로 대화로 돌아오면 입력할 수 있습니다", BoardStore.overlayName($0)) } ?? L("입력 불가: 종료됐거나 이 앱에서 입력할 수 없는 세션")),
                         enabled: agent.canReceiveInput, onSend: send,
                         onPasteImage: { if let u = Attach.pastedImage() { attachments.append(u); return true }; return false },
                         keyHook: handleKey, ghost: g,
                         onDropFiles: { u in if agent.canReceiveInput { attachments.append(contentsOf: u.filter { !attachments.contains($0) }) } },
                         onDragOver: { over in if agent.canReceiveInput { dropping = over } })   // the text view takes the drag itself: light the same hint
                let empty = draft.trimmingCharacters(in: .whitespaces).isEmpty && attachments.isEmpty
                let busy = store.sending.contains(sid)
                Button { send() } label: {
                    Group {
                        if busy { BootClock { ChaseRing(t: $0) }.frame(width: 16, height: 16) }   // the last message is still going in
                        else { Image(systemName: "arrow.up").font(.system(size: 15, weight: .bold)).foregroundStyle(empty ? Color.secondary : .white) }
                    }
                    .frame(width: 34, height: 34)
                    .background(Circle().fill(empty || busy ? AnyShapeStyle(Theme.ink.opacity(0.12)) : AnyShapeStyle(Theme.accentGrad)))
                }.buttonStyle(.plain).padding(.bottom, 4).help(busy ? L("앞 메시지를 CLI에 넣는 중입니다 (첨부 이미지 처리 중). 끝나면 다시 보낼 수 있습니다.") : L("보내기 (Enter, ⌘↩)"))
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(!agent.canReceiveInput || empty || busy)
                if agent.state == .busy {          // stop, next to send (was on the status line)
                    Button { store.interrupt(agent) } label: {
                        Image(systemName: "stop.fill").font(.system(size: 12, weight: .bold)).foregroundStyle(Color.primary)
                            .frame(width: 34, height: 34).background(Circle().fill(Theme.surface3))
                    }.buttonStyle(.plain).padding(.bottom, 4).help(L("지금 하던 작업만 멈춥니다 (Esc)"))
                }
            }
            ComposerFooter(agent: agent, ghost: g, pendingCommands: agent.pendingCommands.count).padding(.horizontal, -24).padding(.bottom, -10)
        }
        .padding(.horizontal, 20).padding(.top, 12).padding(.bottom, 10)
        .frame(maxWidth: 820).frame(maxWidth: .infinity)     // same reading column as the chat
        .overlay(alignment: .topLeading) {
            VStack(alignment: .leading, spacing: 0) {
                SlashPaletteView(ctl: slash, draft: $draft, onSend: send)
                MentionPaletteView(ctl: mention, draft: $draft)
            }.padding(.horizontal, 10).alignmentGuide(.top) { $0[.bottom] }
        }
        .onAppear {
            restore()
            let cwd = agent.cwd ?? store.workingDirectory(of: agent)
            slash.reload(cwd: cwd); mention.reload(cwd: cwd)
            PromptHistory.shared.prepare(sessionId: sid, cwd: cwd) { c, nav in completer = c; hist.items = nav }
        }
        .onChange(of: draft) { _, d in hist.noteEdit(d) }
        .onChange(of: store.pulled) { _, q in
            // queued messages taken back from the CLI: into this box to edit or delete. A line of file paths (the
            // attachments it was sent with) goes back into the strip.
            guard q.sid == sid else { return }
            var texts: [String] = [], files: [URL] = []
            for t in q.texts {
                var keep: [Substring] = []
                for l in t.split(separator: "\n", omittingEmptySubsequences: false) {
                    let parts = l.split(separator: " ").map(String.init)
                    if !parts.isEmpty, parts.allSatisfy({ $0.hasPrefix("/") && FileManager.default.fileExists(atPath: $0) }) {
                        files += parts.map { URL(fileURLWithPath: $0) }
                    } else { keep.append(l) }
                }
                texts.append(keep.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines))
            }
            let back = texts.filter { !$0.isEmpty }.joined(separator: "\n\n")
            draft = draft.isEmpty ? back : back + "\n" + draft
            attachments = files.filter { !attachments.contains($0) } + attachments
            refused = L("대기 중이던 메시지 %@개를 입력창으로 가져왔습니다. 고치거나 지운 뒤 보내세요.", String(q.texts.count))
        }
        .onChange(of: attachments) { _, a in        // copied while the file is still there (a screenshot's temp file goes soon)
            let st = Attach.staged(a)
            if st != a { attachments = st }
        }
        .onChange(of: store.bounce) { _, b in
            // the CLI did not take the last message: back into the box (ahead of anything typed since)
            guard b.sid == sid, let (t, files) = store.lastSentDraft.removeValue(forKey: sid) else { return }
            draft = draft.isEmpty ? t : t + "\n" + draft
            attachments = files + attachments.filter { !files.contains($0) }
            refused = L("전달되지 않아 되돌려 놓았습니다. 다시 보내 주세요.")
        }
        .onChange(of: agent.state) { old, new in       // a turn just ended: my new prompt is in the history file now
            if old == .busy && new != .busy { PromptHistory.shared.prepare(sessionId: sid, cwd: agent.cwd) { c, nav in completer = c; hist.items = nav } }
        }
        .onDisappear { store.drafts[sid] = (draft, attachments); SendLog.note("composer '\(agent.name)' sid=\(sid.prefix(8)) 닫힘, 쓰던 글 \(draft.count)자 보관") }
        .onReceive(NotificationCenter.default.publisher(for: .attachToComposer)) { n in   // files dropped on the chat above
            guard (n.object as? String) == sid, agent.canReceiveInput, let u = n.userInfo?["urls"] as? [URL] else { return }
            attachments.append(contentsOf: u.filter { !attachments.contains($0) })
        }
        .onDrop(of: [.fileURL, .image], isTargeted: $dropping) { providers in
            guard agent.canReceiveInput else { return false }
            Attach.load(providers) { attachments.append(contentsOf: $0.filter { !attachments.contains($0) }) }
            return true
        }
        .overlay(DropHint().opacity(dropping ? 1 : 0).allowsHitTesting(false))
    }
    /// Keys the box handles before the text field sees them, in the CLI's order: the open question, the "/" and "@"
    /// palettes, Tab (fill the suggestion), Shift+Tab (permission mode), Esc (interrupt / cancel), ↑↓ (history).
    private func handleKey(_ ev: NSEvent) -> Bool {
        if agent.state == .needsInput, let p = agent.prompt, !draft.hasPrefix("/"),
           PromptCard.handleKey(ev, optionCount: p.options.count, sending: store.promptSending.contains(agent.sessionId), composerEmpty: draft.isEmpty,
                                onChoose: { store.answerPrompt(agent, optionIndex: $0) }, onCancel: { store.cancelPrompt(agent) }) { return true }
        if slash.handle(ev, draft: $draft, send: send) { return true }
        if mention.handle(ev, draft: $draft) { return true }
        let mods = ev.modifierFlags.intersection([.command, .control, .option, .shift])
        switch ev.keyCode {
        case 48:                                                     // Tab
            if mods == .shift { store.cycleMode(agent); return true }
            guard mods.isEmpty else { return false }
            if let g = ghost { draft = g; return true }
            return true                                              // nothing to fill: keep the focus here, like the CLI
        case 53:                                                     // Esc
            if hist.active { hist.cancel(&draft); return true }
            if agent.working, agent.canReceiveInput { store.interrupt(agent); return true }
            return false
        case 126 where mods.isEmpty:                                 // ↑: history when the box is empty or already browsing
            guard hist.active || draft.isEmpty else { return false }
            return hist.up(&draft)
        case 125 where mods.isEmpty:                                 // ↓
            guard hist.active else { return false }
            return hist.down(&draft)
        default: return false
        }
    }
    private func pickFiles() {
        let p = NSOpenPanel(); p.allowsMultipleSelection = true; p.canChooseDirectories = true
        if p.runModal() == .OK { attachments.append(contentsOf: p.urls.filter { !attachments.contains($0) }) }
    }
    private func send() {
        // the previous message is still going in (the CLI reads pasted images first): an Enter now would be lost, so it waits
        guard !store.sending.contains(sid) else { return }
        var t = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        SendLog.note("composer '\(agent.name)' sid=\(sid.prefix(8)) 보내기: " + SendLog.head(t) + " 첨부 \(attachments.count)")
        guard !t.isEmpty || !attachments.isEmpty else { return }
        if t.hasPrefix("/") {
            let typed = draft, kept = attachments
            if t == "/exit", store.canQuit(agent) { draft = ""; quitting = true; return }   // same confirmation as the header button
            // commands the board handles itself (/model, /effort, /rename …) take no files: those stay in the strip
            if SlashRouter.route(t, agent: agent, store: store) { draft = ""; return }
            // a command the CLI runs (/goal …, custom commands): files ride along as paths after its argument, as in a
            // normal message (they were dropped before, so "/goal … + screenshot" lost the screenshot)
            if !attachments.isEmpty {
                t += " " + attachments.map { $0.path.contains(" ") ? "\"" + $0.path + "\"" : $0.path }.joined(separator: " ")
                attachments = []
            }
            draft = ""; refused = nil
            guard store.send(t, to: agent) else {
                draft = typed; attachments = kept
                refused = store.notice ?? L("보내지 못했습니다. CLI 화면을 확인해 주세요.")
                return
            }
            if SlashCatalog.isTerminalOnly(t) { openTerminal() }
            return
        }
        if !attachments.isEmpty {
            // bare paths after the text: the CLI turns image paths into "[Image #n]" chips and Claude reads the rest. (A
            // "[첨부 파일]" header with "- path" lines left a bare "-" per image in the CLI's own screen.)
            let list = attachments.map { $0.path.contains(" ") ? "\"" + $0.path + "\"" : $0.path }.joined(separator: " ")
            t = (t.isEmpty ? L("첨부한 파일을 확인해 주세요.") : t) + "\n" + list
        }
        let kept = attachments, typed = draft
        store.lastSentDraft[sid] = (typed, kept)
        draft = ""; attachments = []; refused = nil                    // clear first: the box responds instantly
        if !store.send(t, to: agent) {
            // refused (CLI list on screen, someone typing there): put back what was typed and attached, as it was (the
            // text with the file paths already appended used to come back, so the paths showed up in the box)
            draft = typed; attachments = kept
            refused = store.notice ?? L("보내지 못했습니다. CLI 화면을 확인해 주세요.")
        }
    }
    // each agent keeps its own half-typed text and attachments (the bar is recreated per agent: .id(sessionId))
    private func restore() {
        if let d = store.drafts[sid] { (draft, attachments) = d }
        SendLog.note("composer '\(agent.name)' sid=\(sid.prefix(8)) 열림, 보관된 글 \(draft.count)자")
    }
}

struct ChatView: View, Equatable {
    var entries: [ChatEntry]
    var showThinking: Bool
    var showTools: Bool
    var agentName: String = L("에이전트")
    var userLabel: String = L("나")
    var leadName: String = L("팀장")
    var loading = false
    var sessionId = ""
    var lastSent: () -> Date = { .distantPast }          // closures instead of the store: this view must not redraw on every store change
    var holdOlderRows: (Bool) -> Void = { _ in }
    var termStyle = true                     // one monospaced Text per row, like the CLI (light) vs. bubbles with Markdown blocks
    var fontSize: Double = 15
    static func == (a: ChatView, b: ChatView) -> Bool {
        a.termStyle == b.termStyle && a.fontSize == b.fontSize && a.sessionId == b.sessionId && a.showThinking == b.showThinking && a.showTools == b.showTools && a.loading == b.loading
            && a.agentName == b.agentName && a.userLabel == b.userLabel && a.leadName == b.leadName && a.entries == b.entries
    }
    @State private var turns = 3              // newest N of my turns only (fast to lay out); scrolling to the top brings older ones
    @State private var extra = 0              // rows that arrived while reading history (keeps the window from sliding)
    /// Rows from the n-th newest user message to the end.
    private func rowsFor(_ n: Int, in v: [ChatEntry]) -> Int {
        var seen = 0
        for i in v.indices.reversed() where v[i].role == .user && !v[i].text.hasPrefix("/") {
            seen += 1
            if seen == n { return Swift.min(Swift.max(v.count - i, 12), n * 12) }   // long tool-heavy turns: at most ~12 rows each
        }
        return Swift.min(v.count, n * 12)
    }
    var visible: [ChatEntry] { entries.filter { ($0.isThinking ? showThinking : true) } }
    @State private var wheelAt = Date.distantPast
    @State private var dragging = false       // the user is scrolling (older turns load only then, not when a tab reappears at offset 0)
    @State private var pinned = true          // the user is at the bottom: keep following new / growing content
    private static func nearBottom(_ g: ScrollGeometry) -> Bool {
        g.contentSize.height - (g.contentOffset.y + g.containerSize.height + g.contentInsets.bottom) < 80
    }
    /// The answer's text: the assistant's words since my last message (tools and thinking left out).
    static func answerText(_ rows: [ChatEntry], upTo i: Int) -> String {
        var parts: [String] = []
        var k = i
        while k >= 0, rows[k].role != .user {
            if rows[k].role == .assistant && !rows[k].isThinking { parts.append(rows[k].text) }
            k -= 1
        }
        return parts.reversed().joined(separator: "\n\n")
    }
    /// A user slash command or an auto ⚙ line: the following ⎿ result reads as part of the same group.
    private static func isCommand(_ e: ChatEntry) -> Bool {
        (e.role == .user && e.text.hasPrefix("/")) || e.role == .system
    }
    /// Consecutive messages from the same speaker read as one group (no repeated name/avatar).
    private static func sameSpeaker(_ a: ChatEntry, _ b: ChatEntry) -> Bool {
        guard a.role == b.role else { return false }
        switch b.role {
        case .assistant: return true
        case .user: return !b.text.hasPrefix("/")
        case .peer: return a.toolName == b.toolName
        default: return false
        }
    }
    private func loadOlder(_ proxy: ScrollViewProxy, all: [ChatEntry], shown: Int) {
        let anchor = all.suffix(shown).first?.id
        turns += 4
        if let anchor { DispatchQueue.main.async { proxy.scrollTo(anchor, anchor: .top) } }
    }
    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                // a plain VStack: only a few turns are built, and lazy rows re-measured on every resize made the chat jump
                VStack(alignment: .leading, spacing: 0) {
                    let all = visible
                    let shown = Swift.min(all.count, rowsFor(turns, in: all) + extra)
                    if all.isEmpty { Text(loading ? L("대화 기록을 불러오는 중…") : L("대화 기록이 없습니다.")).foregroundStyle(.secondary).padding() }
                    if all.count > shown {
                        Button(L("이전 대화 더 보기 (%@줄 남음)", String(all.count - shown))) { loadOlder(proxy, all: all, shown: shown) }
                            .buttonStyle(.raisedCompact).frame(maxWidth: .infinity).padding(.bottom, 10)
                    }
                    let rows = Array(all.suffix(shown))
                    ForEach(Array(rows.enumerated()), id: \.element.id) { i, e in
                        let cont = i > 0 && Self.sameSpeaker(rows[i - 1], e)
                        if termStyle {
                            TermLine(entry: e, name: e.role == .peer ? (e.toolName ?? L("팀원")).split(separator: "@").first.map(String.init) ?? L("팀원") : agentName,
                                     expandAll: showTools, size: fontSize).id(e.id)
                                .padding(.top, i == 0 ? 0 : (e.role == .tool || e.role == .system ? 2 : 12))
                        } else {
                        Bubble(entry: e, agentName: agentName, userLabel: userLabel, leadName: leadName, expandAll: showTools, showHeader: !cont).id(e.id)
                            .padding(.top, i == 0 ? 0 : (e.role == .system && Self.isCommand(rows[i - 1]) ? 3 : (e.role == .tool && rows[i - 1].role == .tool && !showTools ? 4 : (cont ? 8 : 22))))
                        }
                        // end of an answer (my next message follows, or it is the newest row): copy / pass it to another agent
                        if e.role == .assistant && !e.isThinking && (i == rows.count - 1 || rows[i + 1].role == .user) {
                            AnswerActions(text: { Self.answerText(rows, upTo: i) }, from: agentName, fromId: sessionId)
                        }
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }.padding(.horizontal, 20).padding(.vertical, 18)
                .frame(maxWidth: 820).frame(maxWidth: .infinity)     // a centred reading column on wide windows
            }
            .defaultScrollAnchor(.bottom)
            .environment(\.openURL, OpenURLAction { u in       // a path in the chat: its folder in Finder
                guard u.isFileURL else { return .systemAction }
                PathLinks.open(u); return .handled
            })
            // pinned changes only when the user scrolls (content growth must not unpin)
            .onScrollPhaseChange { _, new, ctx in
                dragging = new == .interacting || new == .decelerating
                if new == .interacting || new == .decelerating || new == .idle { pinned = Self.nearBottom(ctx.geometry) }
            }
            // a mouse wheel moves the view without reporting a scroll phase: an upward move of the offset (content growth
            // never moves it up) unpins, so the chat no longer snaps back to the bottom while reading with the wheel
            .onScrollGeometryChange(for: ScrollGeometry.self) { $0 } action: { old, g in
                if g.contentOffset.y < old.contentOffset.y - 1, g.contentSize == old.contentSize, g.containerSize == old.containerSize { pinned = false; wheelAt = Date() }
                else if Self.nearBottom(g) { pinned = true }
            }
            // scrolled up to the top: bring the next few older turns, keeping the reading position
            .onScrollGeometryChange(for: Bool.self) { $0.contentOffset.y < 40 && $0.contentSize.height > $0.containerSize.height } action: { _, top in
                guard top, dragging || Date().timeIntervalSince(wheelAt) < 1, !pinned else { return }
                let all = visible, shown = Swift.min(all.count, rowsFor(turns, in: all) + extra)
                if all.count > shown { loadOlder(proxy, all: all, shown: shown) }
            }
            // new rows, a growing last bubble, or a rewrap after a width change: stay at the bottom
            .onScrollGeometryChange(for: CGFloat.self) { $0.contentSize.height } action: { _, _ in
                if pinned { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            // reading older history: new rows must not slide the 200-row window under the reader
            .onChange(of: visible.count) { old, new in
                if !pinned && new > old { extra += new - old }
            }
            .onDisappear { holdOlderRows(false) }
            .onChange(of: pinned) { _, p in
                if p && (turns != 3 || extra != 0) { turns = 3; extra = 0 }
                holdOlderRows(!p)          // reading history: the reader keeps rows past its cap until we are back at the bottom
            }
            .onChange(of: visible.last?.id) { _, _ in
                // follow when at the bottom, or right after the user sent something; app-sent commands do not scroll
                if pinned || Date().timeIntervalSince(lastSent()) < 2 { pinned = true; proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .onAppear {
                proxy.scrollTo("bottom", anchor: .bottom)
                DispatchQueue.main.async { proxy.scrollTo("bottom", anchor: .bottom) }   // lazy rows lay out after the first frame
            }
        }
    }
}

struct Bubble: View {
    @AppStorage("ui.chatFont") private var chatFont: Double = 15
    var entry: ChatEntry
    var agentName: String = L("에이전트")
    var userLabel: String = L("나")
    var leadName: String = L("팀장")
    var expandAll = false
    var showHeader = true
    @State private var expanded = false
    var body: some View {
        if entry.role == .system { systemLine }
        else if entry.role == .tool { toolLine.onAppear { if entry.isError { expanded = true } } }
        else { bubble }
    }
    /// A tool call or result folded to one line (tool name + first argument); a click opens the details.
    private var toolLine: some View {
        let head = entry.text.prefix(300)                       // a result can be long: only its start is needed
        let first = head.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
        let isResult = entry.toolName == "결과"
        return ToolLine(summary: isResult ? L("결과 · %@", first) : (entry.toolName ?? "tool") + " · " + first, icon: entry.isError ? "exclamationmark.triangle.fill" : (isResult ? "arrow.turn.down.right" : "wrench.and.screwdriver"), isError: entry.isError,
                        hasDetail: isResult || entry.text.contains("\n") || entry.text.count > 90, expanded: expandAll ? .constant(true) : $expanded) {
            // a one-line, short argument is already the summary: show details only when there is more than that
            if isResult || entry.text.contains("\n") || entry.text.count > 90 { Text(entry.text) }
        }
    }
    /// Slash-command output: a small ⎿ line (stderr in the warning colour).
    private var systemLine: some View {
        HStack(alignment: .top, spacing: 6) {
            Text(entry.toolName == "auto" ? "⚙" : "⎿").foregroundStyle(.tertiary)
            Text(entry.text).textSelection(.enabled).foregroundStyle(entry.toolName == "stderr" ? Color.orange : Color.secondary)
            Spacer(minLength: 60)
        }
        .font(.system(size: chatFont - 3, design: .monospaced)).padding(.horizontal, 12)
    }
    private var bubble: some View {
        Group {
            if entry.role == .user { userBubble } else { speakerBlock }
        }
    }
    /// Mine: a soft rounded bubble on the right, no name (it is always me), the time underneath.
    private var userBubble: some View {
        HStack(alignment: .bottom, spacing: 0) {
            Spacer(minLength: 80)
            VStack(alignment: .trailing, spacing: 4) {
                MarkdownView(text: entry.text, font: .system(size: chatFont))
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Theme.userBubble))
                    .opacity(entry.toolName == "전송 중" ? 0.6 : 1)
                Text(entry.toolName == "전송 중" ? L("전송 중…") : Fmt.time(entry.time))
                    .font(.system(size: 11)).foregroundStyle(.tertiary).padding(.trailing, 6)
            }
        }
    }
    /// Agent / lead / teammate: no box, like a document — an avatar + name line, then the text.
    private var speakerBlock: some View {
        HStack(alignment: .top, spacing: 12) {
            if showHeader { Avatar(label: title, tint: tint) } else { Color.clear.frame(width: 26, height: 1) }
            VStack(alignment: .leading, spacing: 6) {
                if showHeader {
                    HStack(spacing: 8) {
                        Text(title).font(.system(size: 13, weight: .semibold)).foregroundStyle(Color.primary.opacity(0.92))
                        if entry.isThinking { Text(L("생각")).font(.system(size: 11, weight: .medium)).foregroundStyle(.secondary) }
                        Text(Fmt.time(entry.time)).font(.system(size: 11)).foregroundStyle(.tertiary)
                    }.padding(.top, 3)
                }
                if entry.isThinking {
                    Text(markdown(entry.text)).textSelection(.enabled).font(.system(size: chatFont - 1).italic())
                        .foregroundStyle(Color.primary.opacity(0.6)).lineSpacing(5)
                        .padding(.leading, 12).overlay(alignment: .leading) { Capsule().fill(Theme.ink.opacity(0.14)).frame(width: 2) }
                } else if entry.role == .peer {
                    MarkdownView(text: entry.text, font: .system(size: chatFont))
                        .padding(.horizontal, 14).padding(.vertical, 10)
                        .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Theme.peerBubble))
                } else {
                    MarkdownView(text: entry.text, font: .system(size: chatFont))
                }
            }
            Spacer(minLength: 40)
        }
    }
    private static func isLeadAddress(_ a: String?) -> Bool {
        let n = (a ?? "").split(separator: "@").first.map(String.init) ?? ""
        return n == "team-lead" || n == "main" || n == "lead"
    }
    private var title: String {
        switch entry.role {
        case .user: entry.toolName == "전송 중" ? L("%@ · 전송 중…", userLabel) : userLabel
        case .assistant: entry.isThinking ? L("%@ · 생각", agentName) : agentName
        case .tool: entry.toolName == "결과" ? L("도구 결과") : L("도구 · %@", entry.toolName ?? "")
        case .system: L("시스템")
        case .peer: Self.isLeadAddress(entry.toolName) ? leadName : ((entry.toolName ?? "").split(separator: "@").first.map(String.init) ?? L("팀원"))
        }
    }
    private var tint: Color {
        switch entry.role {
        case .user: Theme.accent
        case .assistant: Theme.accent
        case .peer: Self.isLeadAddress(entry.toolName) ? Theme.busy : Theme.modelTint
        default: .gray
        }
    }
    private var background: some ShapeStyle {
        switch entry.role {
        case .user: AnyShapeStyle(Theme.accent.opacity(0.22))
        case .tool: AnyShapeStyle(Theme.dyn(0x332B21, 0xF4EEE6))
        case .peer: AnyShapeStyle(Theme.dyn(0x332945, 0xEFEAF7))
        default: AnyShapeStyle(Theme.card)
        }
    }
    private func markdown(_ s: String) -> AttributedString {
        (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
    }
}

struct TermTab: Identifiable, Equatable { var id = UUID(); var pane: String; var title: String; var owned: Bool }

enum Bench { static let env = ProcessInfo.processInfo.environment; static let noList = env["BENCH_NOLIST"] != nil; static let noComposer = env["BENCH_NOCOMPOSER"] != nil; static let noChat = env["BENCH_NOCHAT"] != nil }

/// One conversation row the way the CLI prints it: "❯ mine", "⏺ agent", "  ⎿ tool". A single Text (inline Markdown
/// only, monospaced) — a fraction of the views a bubble with Markdown blocks needs. Tool rows show one line; click opens.
struct TermLine: View {
    var entry: ChatEntry
    var name: String
    var expandAll: Bool
    var size: Double
    @State private var open = false
    private static let cache = NSCache<NSString, AttrBox>()
    final class AttrBox { let v: AttributedString; init(_ v: AttributedString) { self.v = v } }
    private static func inline(_ s: String) -> AttributedString {
        let k = s as NSString
        if let c = cache.object(forKey: k) { return c.v }
        let v = PathLinks.link((try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s))
        cache.setObject(AttrBox(v), forKey: k)
        return v
    }
    /// Cheap test before parsing: does any line start a block (#, >, |, ```, ---)?
    static func hasBlocks(_ t: String) -> Bool {
        for l in t.split(separator: "\n", omittingEmptySubsequences: true) {
            let x = l.drop(while: { $0 == " " })
            if x.hasPrefix("#") || x.hasPrefix(">") || x.hasPrefix("|") || x.hasPrefix("```") || x == "---" { return true }
        }
        return false
    }
    var body: some View {
        let mono = Font.system(size: size - 1, design: .monospaced)
        switch entry.role {
        case .user:
            (Text("❯ ").foregroundColor(Theme.accent) + Text(entry.text).foregroundColor(Color.primary.opacity(entry.toolName == "전송 중" ? 0.5 : 0.95)))
                .font(mono.weight(.semibold)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 4).padding(.horizontal, 6).background(Theme.ink.opacity(0.05))
        case .assistant where !entry.isThinking && Self.hasBlocks(entry.text):
            // headings, quotes, tables, code, rules: drawn as blocks (quotes and code get a copy button)
            HStack(alignment: .firstTextBaseline, spacing: 0) {
                Text("⏺ ").font(mono).foregroundColor(.primary)
                MarkdownView(text: entry.text, font: mono, mono: true).foregroundStyle(Color.primary.opacity(0.9))
            }.frame(maxWidth: .infinity, alignment: .leading)
        case .assistant:
            (Text(entry.isThinking ? "✻ " : "⏺ ").foregroundColor(entry.isThinking ? .secondary : Color.primary)
             + Text(Self.inline(entry.text)).foregroundColor(entry.isThinking ? Color.primary.opacity(0.5) : Color.primary.opacity(0.9)))
                .font(entry.isThinking ? mono.italic() : mono).lineSpacing(3).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
        case .peer:
            (Text("✉ \(name): ").foregroundColor(Theme.busy) + Text(Self.inline(entry.text)).foregroundColor(Color.primary.opacity(0.85)))
                .font(mono).lineSpacing(3).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
        case .system:
            Text((entry.toolName == "auto" ? "⚙ " : "  ⎿ ") + entry.text).font(mono).foregroundColor(entry.toolName == "stderr" ? .orange : .secondary)
                .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
        case .tool:
            let isResult = entry.toolName == "결과"
            let full = expandAll || open
            let head = entry.text.prefix(300).split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
            let line = isResult ? "  ⎿ " + (full ? entry.text : head) : "⏺ " + (entry.toolName ?? "tool") + "(" + (full ? entry.text : head) + ")"
            Text(line).font(mono).lineLimit(full ? nil : 1).truncationMode(.middle)
                .foregroundColor(entry.isError ? Theme.errorTone : (isResult ? Color.secondary : Theme.dyn(0x8CCC99, 0x2E7D45)))
                .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                .onTapGesture { open.toggle() }
        }
    }
}

/// One session in the split view: a slim title bar (drag it onto another pane to trade places), its chat and its input.
struct SplitPane: View {
    @EnvironmentObject var store: BoardStore
    private let paneChat = true   // the CLI screen is the only chat view (the transcript view stays for sessions without one)
    var agent: Agent
    var swap: (String, String) -> Void
    @State private var quitting = false
    @State private var target = false
    @State private var renaming = false
    @State private var deleting = false
    @State private var resuming = false
    @State private var addingTeammate = false
    @AppStorage("ui.termChat") private var termChat = true
    @AppStorage("ui.chatFont") private var chatFont: Double = 15
    /// The single view's header, in its order (name, 팀장, model, effort, state, RC, folder); the actions sit behind "⋯".
    private var header: some View {
        HStack(spacing: 6) {
            Image(systemName: "line.3.horizontal").font(.caption).foregroundStyle(.tertiary).help(L("끌어서 다른 칸과 자리를 바꿉니다"))
            StateDot(state: agent.state)
            Text(agent.name).font(.callout.bold()).lineLimit(1).layoutPriority(2)
            if agent.isLead && !agent.solo { Chip(text: L("팀장"), tint: Theme.accent) }
            LazyMenu(entries: { ModelChoice.allCases.map { m in .item(m.label + (agent.model == m.rawValue ? " ✓" : "")) { store.setModel(m, for: agent) } } }) {
                Chip(text: agent.displayModel + (agent.requestedModel != nil ? " ⏳" : ""), tint: .white).opacity(agent.modelIsGuess ? 0.55 : 1)
            }.buttonStyle(.plain).fixedSize().disabled(!agent.canReceiveInput).help(L("모델 변경"))
            LazyMenu(entries: { EffortChoice.allCases.map { e in .item(e.rawValue + (agent.effort == e.rawValue ? " ✓" : "")) { store.setEffort(e, for: agent) } } }) {
                Chip(text: "effort \(agent.effort ?? "?")" + (agent.requestedEffort != nil ? " ⏳" : ""), tint: .white)
            }.buttonStyle(.plain).fixedSize().disabled(!agent.canReceiveInput).help(L("effort 변경"))
            Chip(text: Fmt.stateLabel(agent.state), tint: Fmt.stateColor(agent.state)).fixedSize().opacity(agent.stateUnconfirmed ? 0.7 : 1)
            RemoteChip(agent: agent).fixedSize()
            if let c = agent.cwd ?? store.workingDirectory(of: agent) {      // shrinks first, then hides
                Label((c as NSString).lastPathComponent, systemImage: "folder").font(.caption).foregroundStyle(.secondary)
                    .lineLimit(1).truncationMode(.middle).layoutPriority(-1).help(c)
            }
            Spacer(minLength: 4)
            LazyMenu(entries: {
                let live = agent.tmuxPane != nil && agent.state != .ended
                var e: [MenuEntry] = [.item(L("이름 변경…")) { renaming = true },
                    .separator, .header(L("기본 터미널 앱으로")),
                    .item(L("세션 터미널 — 이 세션의 CLI 화면"), enabled: live) { store.openTerminal(agent) },
                    .item(L("새 터미널 — 이 세션 폴더에서")) { store.openExternalShell(cwd: agent.cwd ?? store.workingDirectory(of: agent)) },
                    .separator]
                if store.canQuit(agent) { e.append(.item(L("종료 (/exit)")) { quitting = true }) }
                if store.canResume(agent) { e.append(.item(L("다시 시작…")) { resuming = true }) }
                else { e.append(.item(L("팀원 추가…"), enabled: agent.canReceiveInput) { addingTeammate = true }) }
                e.append(.item(L("보관…")) { deleting = true })
                return e
            }) { Image(systemName: "ellipsis").font(.system(size: 13, weight: .semibold)).frame(width: 24, height: 20).contentShape(Rectangle()) }
            .buttonStyle(.plain).fixedSize().foregroundStyle(.secondary).help(L("터미널 · 종료 · 팀원 추가 · 보관"))
        }
        .padding(.horizontal, 10).padding(.vertical, 6).background(target ? Theme.accent.opacity(0.25) : Theme.area)
        .contentShape(Rectangle())
        .draggable(agent.sessionId)
        .agentActions(agent, renaming: $renaming, deleting: $deleting)
        .sheet(isPresented: $addingTeammate) { AddTeammateSheet(agent: agent) }
        .sheet(isPresented: $resuming) { ResumeSheet(agent: agent) }
    }
    var body: some View {
        VStack(spacing: 0) {
            header
if paneChat, let p = agent.tmuxPane, agent.state != .ended { PaneChatView(pane: p, sid: agent.sessionId).id(agent.sessionId) } else {
                        ChatView(entries: store.chat[agent.sessionId] ?? [], showThinking: false, showTools: false, agentName: agent.name,
                     userLabel: L("나"), leadName: L("팀장"), loading: store.chat[agent.sessionId] == nil && agent.transcriptPath != nil,
                     sessionId: agent.sessionId, lastSent: { store.lastSentAt }, termStyle: termChat, fontSize: chatFont)
                .equatable().id(agent.sessionId)
            }
            ComposerBar(agent: agent, quitting: $quitting, openTerminal: { store.openTerminal(agent) }).id(agent.sessionId)
        }
        .areaBox()
        .dropDestination(for: String.self) { items, _ in
            if let from = items.first { swap(from, agent.sessionId) }
            return true
        } isTargeted: { target = $0 }
        .onTapGesture { store.selectedAgent = agent.sessionId }
        .onAppear { store.paneChats[agent.sessionId, default: 0] += 1; store.refreshSoon() }
        .onDisappear { store.paneChats[agent.sessionId, default: 1] -= 1 }
        .quitDialog(agent, isPresented: $quitting)
    }
}

/// The gap between two areas, draggable: reports each move's distance along `axis`.
struct ResizeGap: View {
    var axis: Axis
    var onDrag: (CGFloat) -> Void
    @State private var last: CGFloat = 0
    var body: some View {
        Color.clear
            .frame(width: axis == .horizontal ? Theme.gap : nil, height: axis == .vertical ? Theme.gap : nil)
            .contentShape(Rectangle())
            .onHover { inside in
                if inside { (axis == .horizontal ? NSCursor.resizeLeftRight : NSCursor.resizeUpDown).push() } else { NSCursor.pop() }
            }
            .gesture(DragGesture(minimumDistance: 1, coordinateSpace: .global).onChanged { v in
                let t = axis == .horizontal ? v.translation.width : v.translation.height
                onDrag(t - last); last = t
            }.onEnded { _ in last = 0 })
    }
}

/// Panes side by side (or stacked) in equal parts at first, with draggable dividers between them.
struct ResizableSplit<Content: View>: View {
    var axis: Axis
    var count: Int
    var min: CGFloat
    @ViewBuilder var content: (Int) -> Content
    @State private var fr: [CGFloat] = []          // fractions, sum 1
    @State private var dragStart: [CGFloat]?
    var body: some View {
        GeometryReader { g in
            let total = (axis == .horizontal ? g.size.width : g.size.height) - CGFloat(count - 1) * Theme.gap
            let f = fr.count == count ? fr : Array(repeating: 1 / CGFloat(count), count: count)
            let stack = Group {
                ForEach(0..<count, id: \.self) { i in
                    content(i).frame(width: axis == .horizontal ? total * f[i] : nil, height: axis == .vertical ? total * f[i] : nil)
                    if i < count - 1 { divider(i, total: total, f: f) }
                }
            }
            if axis == .horizontal { HStack(spacing: 0) { stack } } else { VStack(spacing: 0) { stack } }
        }
    }
    private func divider(_ i: Int, total: CGFloat, f: [CGFloat]) -> some View {
        // the gap between two pane boxes is the handle: no drawn line
        Color.clear
            .frame(width: axis == .horizontal ? Theme.gap : nil, height: axis == .vertical ? Theme.gap : nil)
            .contentShape(Rectangle())
            .onHover { inside in
                if inside { (axis == .horizontal ? NSCursor.resizeLeftRight : NSCursor.resizeUpDown).push() } else { NSCursor.pop() }
            }
            .gesture(DragGesture(minimumDistance: 1, coordinateSpace: .global).onChanged { v in
                let base = dragStart ?? f
                if dragStart == nil { dragStart = f }
                let d = (axis == .horizontal ? v.translation.width : v.translation.height) / Swift.max(total, 1)
                let pair = base[i] + base[i + 1], lo = min / Swift.max(total, 1)
                var a = base[i] + d
                a = Swift.min(Swift.max(a, lo), pair - lo)
                var n = base; n[i] = a; n[i + 1] = pair - a
                fr = n
            }.onEnded { _ in dragStart = nil })
    }
}

/// Under each answer: copy all of it, or type it into another running agent's CLI (the board only relays the text).
/// Two plain buttons; the agent list is built only when the menu opens.
struct AnswerActions: View {
    var text: () -> String                  // read when a button is pressed
    var compact = false
    var from: String
    var fromId: String
    var recent: (() -> [(asked: String, answer: String)])? = nil   // read when the menu opens
    @State private var copied = false
    private func copy(_ t: String) {
        guard !t.isEmpty else { return }
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(t, forType: .string)
        copied = true; DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { copied = false }
    }
    var body: some View {
        HStack(spacing: 12) {
            HStack(spacing: 3) {
                Button { copy(text()) } label: { Label(copied ? L("복사됨") : L("답변 복사"), systemImage: copied ? "checkmark" : "doc.on.doc") }
                    .help(compact ? L("마지막 답변 전체를 복사합니다") : L("이 답변 전체를 복사합니다"))
                if let recent {
                    LazyMenu(entries: {
                        let list = recent()
                        guard !list.isEmpty else { return [.header(L("복사할 답변이 없습니다"))] }
                        return [.header(L("최근 답변 복사 (내 메시지 기준)"))] + list.enumerated().map { i, r in
                            let q = r.asked.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
                            let label = q.isEmpty ? String(r.answer.prefix(40)) : (q.count > 40 ? String(q.prefix(40)) + "…" : q)
                            return .item(L("%@. %@  (%@자)", String(i + 1), label, String(r.answer.count))) { copy(r.answer) }
                        }
                    }) { Image(systemName: "chevron.down").font(.system(size: 8, weight: .bold)) }
                    .help(L("최근 답변 5개 중에서 골라 복사합니다"))
                }
            }
            LazyMenu(entries: { Self.targets(text: text(), from: from, fromId: fromId) }) {
                Label(L("동료 에이전트에게 전달"), systemImage: "arrowshape.turn.up.right")
            }.help(compact ? L("마지막 답변을 동료 에이전트의 입력창에 그대로 넣습니다") : L("이 답변을 동료 에이전트의 입력창에 그대로 넣습니다"))
        }
        .buttonStyle(.plain).font(.caption).foregroundStyle(.secondary)
        .padding(.top, compact ? 0 : 6).padding(.leading, compact ? 0 : 18)
    }
    @MainActor static func targets(text: String, from: String, fromId: String) -> [MenuEntry] {
        guard let store = BoardStore.shared else { return [] }
        guard !text.isEmpty else { return [.header(L("보낼 답변이 없습니다"))] }
        var out: [MenuEntry] = [.header(L("동료 에이전트에게 전달 (꺼진 세션은 고를 수 없음)"))]
        func add(_ a: Agent, _ label: String) {
            guard a.sessionId != fromId else { return }
            out.append(.item(label + (a.state == .ended ? L(" — 꺼짐") : ""), enabled: a.canReceiveInput) {
                store.send(L("[%@의 답변을 전달합니다]", from) + "\n\n" + text, to: a)
                store.notice = L("'%@'의 답변을 '%@'에게 보냈습니다.", from, a.name)
            })
        }
        for t in store.teams where !t.members.isEmpty {
            out.append(.separator); out.append(.header(t.displayName))
            for m in t.members { add(m, m.name) }
        }
        if !store.loose.isEmpty { out.append(.separator); out.append(.header(L("개별 세션"))); for a in store.loose { add(a, a.name) } }
        return out
    }
}
