import SwiftUI

/// Home: every team as an org chart — lead on top, workers beneath as name cards.
struct OrgChartView: View {
    @EnvironmentObject var store: BoardStore
    /// The launch screen plays once per app start (self-test snapshots skip it unless asked with --rocket).
    @State private var launched = { let a = ProcessInfo.processInfo.arguments; return a.contains("--snapshot") && !a.contains("--rocket") }()
    var body: some View {
        Group {
            if launched { chart.transition(.opacity) }
            else { RocketLaunch(loaded: store.firstScanDone && !store.rebooting) { withAnimation(.easeOut(duration: 0.25)) { launched = true } }.areaBox() }
        }
        .onChange(of: store.rebootGen) { _, _ in launched = false }       // the refresh button: launch again
    }
    private var chart: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.gap) {
                if store.teams.isEmpty && store.loose.isEmpty {
                    ContentUnavailableView("에이전트가 없습니다", systemImage: "person.3",
                                           description: Text("오른쪽 위 '새 세션'(⌘N)으로 시작하거나, tmux에서 Claude 팀을 띄우면 여기에 나타납니다."))
                        .frame(maxWidth: .infinity, minHeight: 420).areaBox()
                }
                if !store.launches.isEmpty {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("시작 중인 세션").font(.headline)
                        ForEach(store.launches) { l in LaunchCard(launch: l) }
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(14).areaBox()
                }
                if !store.emptyTeams.isEmpty {
                    HStack {
                        Image(systemName: "trash.slash")
                        Text("대화 기록이 없는 종료된 팀 \(store.emptyTeams.count)개 — 보여줄 것도, 다시 시작할 것도 없습니다.").font(.callout)
                        Spacer()
                        Button("정리 (휴지통)") { store.pruneEmptyTeams() }.buttonStyle(.raisedCompact)
                    }.padding(10).areaBox()
                }
                if !store.teams.isEmpty {     // an empty grid still took a row: one gap more than on the other tabs
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible(minimum: 380), spacing: Theme.gap, alignment: .top), count: max(1, min(store.teams.count, 3))), alignment: .leading, spacing: Theme.gap) {
                        ForEach(store.teams) { team in TeamCard(team: team) }
                    }
                }
                if !store.loose.isEmpty {
                    VStack(alignment: .leading, spacing: 10) {
                        Group {
                            let live = store.loose.filter { $0.state != .ended }.count
                            HStack(alignment: .firstTextBaseline, spacing: 10) {
                                HStack(spacing: 8) {
                                    Image(systemName: "person").font(.system(size: 14, weight: .medium)).foregroundStyle(live > 0 ? .green : .secondary)
                                    Text("개별 세션").font(.system(size: 15, weight: .semibold))
                                }
                                Text("실행 \(live)").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.textDim)
                                Text("종료 \(store.loose.count - live)").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.textDim)
                            }
                            FillGrid(items: store.loose, spacing: 12) { NameCard(agent: $0) }
                        }
                    }
                    .padding(14).panelBox()
                }
            }
        }
    }
}

struct LaunchCard: View {
    @EnvironmentObject var store: BoardStore
    var launch: Launch
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                ProgressView().controlSize(.small).opacity(launch.phase == .starting ? 1 : 0)
                Text(launch.name).font(.subheadline.bold())
                Text(launch.cwd).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                Spacer()
                switch launch.phase {
                case .needsTrust:
                    Text("폴더 신뢰 확인 필요").font(.caption).foregroundStyle(.orange)
                    Button("이 폴더 신뢰하고 시작") { store.trustFolder(launch) }.buttonStyle(.raisedProminent)
                case .needsSetup:
                    Text("Claude Code 첫 설정 필요").font(.caption).foregroundStyle(.orange)
                    Button("터미널에서 설정 마치기") { store.openLaunchTerminal(launch) }.buttonStyle(.raisedProminent)
                case .stuck: Text("응답 없음").font(.caption).foregroundStyle(.red)
                default: Text("시작 중…").font(.caption).foregroundStyle(.secondary)
                }
                Button("취소") { store.cancelLaunch(launch) }
            }
            if launch.phase == .needsTrust {
                Text("Claude Code가 이 폴더의 파일을 읽고, 수정하고, 실행할 수 있게 됩니다. 직접 만든 폴더이거나 믿을 수 있는 경우에만 신뢰하세요.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if launch.phase == .needsSetup {
                Text("이 Mac에서 Claude Code를 처음 실행했습니다. 글자 스타일 선택과 로그인은 CLI가 직접 묻는 단계라, 터미널에서 한 번 마치면 그 뒤로는 이 앱에서 바로 시작됩니다.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if launch.phase == .stuck, !launch.screenTail.isEmpty {
                Text(launch.screenTail).font(.system(.caption2, design: .monospaced)).foregroundStyle(.secondary)
            }
        }
        .padding(10).background(Theme.surface1).clipShape(RoundedRectangle(cornerRadius: 6))
    }
}

/// One team as a compact column: header, lead, then workers stacked under a guide line.
struct TeamCard: View {
    @EnvironmentObject var store: BoardStore
    var team: Team
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "person.3").font(.system(size: 14, weight: .medium)).foregroundStyle(team.liveCount > 0 ? .green : .secondary)
                Text(team.displayName).font(.system(size: 15, weight: .semibold)).lineLimit(1)
                Spacer()
                let ids = Set(team.members.map(\.sessionId))
                let all = ids.isSubset(of: store.selection)
                Button { if all { store.selection.subtract(ids) } else { store.selection.formUnion(ids) } } label: {
                    Label(all ? "팀 선택 해제" : "팀 전체 선택", systemImage: all ? "checkmark.square.fill" : "checkmark.square")
                }.buttonStyle(.raisedCompact).help("이 팀의 팀장·팀원을 한 번에 선택")
                Button("열기") { if let a = team.lead ?? team.members.first { store.open(a) } }.buttonStyle(.raisedCompact)
            }
            HStack(spacing: 6) {
                Chip(text: "\(team.liveCount)/\(team.members.count)명 활동", tint: team.liveCount > 0 ? .green : .secondary)
                Chip(text: "토큰 \(Fmt.tokens(team.tokens.total))")
                // last activity of any member (what the CLI's session list shows), not when the team was made
                if let last = team.members.compactMap(\.lastActivity).max() ?? team.createdAt {
                    Text(Fmt.ago(last)).font(.caption).foregroundStyle(.secondary).help("마지막 활동 \(Fmt.time(last))")
                }
            }
            if let lead = team.lead { NameCard(agent: lead, badge: "팀장") }
            else {
                Label("팀장 없음 — 삭제되었거나 종료됨. 팀원만 남아 있습니다.", systemImage: "person.crop.circle.badge.exclamationmark")
                    .font(.callout).foregroundStyle(.orange)
            }
            if !team.workers.isEmpty {
                FillGrid(items: team.workers, spacing: 10) { NameCard(agent: $0) }
            } else if team.lead != nil {
                Text("팀원 없음").font(.callout).foregroundStyle(.secondary).padding(.leading, 4)
            }
        }
        .padding(14)
        .panelBox()
    }
}

struct NameCard: View {
    @EnvironmentObject var store: BoardStore
    var agent: Agent
    var badge: String? = nil
    @State private var renaming = false
    @State private var deleting = false
    @State private var hover = false
    @State private var resuming = false
    @State private var quitting = false
    var body: some View {
        Button { store.open(agent) } label: {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Toggle("", isOn: Binding(get: { store.selection.contains(agent.sessionId) },
                                             set: { on in if on { store.selection.insert(agent.sessionId) } else { store.selection.remove(agent.sessionId) } }))
                        .toggleStyle(.checkbox).labelsHidden().help("선택")
                    StateDot(state: agent.state)
                    Text(agent.name).font(.system(size: 14, weight: .semibold)).lineLimit(1)
                    if let b = badge { Chip(text: b, tint: Theme.accent) }
                    if agent.origin == "board" { Image(systemName: "macwindow.badge.plus").font(.caption).foregroundStyle(.teal).help("이 앱에서 시작한 세션") }
                    if agent.overlay != nil { Image(systemName: "list.bullet.rectangle").font(.caption).foregroundStyle(.orange).help("CLI가 \(BoardStore.overlayName(agent.overlay!)) 화면입니다 — 입력 불가") }
                    if agent.isBackgroundJob { Image(systemName: "moon.stars").font(.caption).foregroundStyle(.secondary).help("CLI 백그라운드 작업 \(agent.jobId ?? "")") }
                    Spacer()
                    // action buttons keep their space; hover only reveals them (no resize)
                    HStack(spacing: 6) {
                        if store.canResume(agent) { Button { resuming = true } label: { Image(systemName: "power") }.buttonStyle(.icon).help("다시 시작") }
                        if store.canQuit(agent) { Button { quitting = true } label: { Image(systemName: "power") }.buttonStyle(.icon).help("종료 (/exit)") }
                        Button { renaming = true } label: { Image(systemName: "pencil") }.buttonStyle(.icon).help("이름 변경")
                        Button { deleting = true } label: { Image(systemName: "archivebox") }.buttonStyle(.icon).help("보관")
                    }
                    .opacity(hover ? 1 : 0).allowsHitTesting(hover)
                    Text(Fmt.stateLabel(agent.state)).font(.caption.weight(.semibold)).foregroundStyle(Fmt.stateColor(agent.state))
                        .padding(.horizontal, 7).padding(.vertical, 2)
                        .background(RoundedRectangle(cornerRadius: 3).fill(Fmt.stateColor(agent.state).opacity(0.12)))
                        .overlay(RoundedRectangle(cornerRadius: 3).stroke(Fmt.stateColor(agent.state).opacity(0.45), lineWidth: 1))
                        .opacity(agent.stateUnconfirmed ? 0.7 : 1).help(agent.stateUnconfirmed ? "\(Fmt.stateLabel(agent.state)) — 상태 확인 중" : "")
                }
                if let p = agent.pendingName { Text("→ '\(p)'(으)로 변경 대기 중").font(.caption2).foregroundStyle(.orange) }
                // one consistent second line for every card: the working folder
                HStack(spacing: 4) {
                    Image(systemName: "folder").font(.caption)
                    Text(((agent.cwd ?? store.workingDirectory(of: agent) ?? "—") as NSString).lastPathComponent).font(.caption).lineLimit(1)
                }.foregroundStyle(.tertiary)
                HStack(spacing: 6) {
                    Chip(text: agent.displayModel, tint: .white).opacity(agent.modelIsGuess ? 0.55 : 1).help(agent.modelIsGuess ? "이전 실행 기준 추정값 — 실행 인자에서 읽은 모델입니다" : "")
                    if let e = agent.effort { Chip(text: e, tint: .white).help("effort \(e)") }
                    RemoteChip(agent: agent)
                    Spacer(minLength: 0)
                }
                HStack {
                    Text("출력 \(Fmt.tokens(agent.tokens.output)) · 합 \(Fmt.tokens(agent.tokens.total))").font(.system(size: 12, weight: .medium)).monospacedDigit().foregroundStyle(Theme.textDim).opacity(agent.isEstimated ? 0.55 : 1).help(agent.isEstimated ? "이전 실행 기준 추정값" : "")
                    Spacer()
                    Text(Fmt.ago(agent.lastActivity)).font(.caption2).foregroundStyle(.tertiary)
                }
            }
            .padding(.leading, 16).padding(.trailing, 12).padding(.vertical, 12).frame(maxWidth: .infinity, alignment: .leading)
            .cardSurface(stripe: agent.state == .ended ? Theme.ink.opacity(0.15) : Fmt.stateColor(agent.state), radius: 6, selected: store.selection.contains(agent.sessionId), hover: hover)
            .opacity(agent.state == .ended ? 0.75 : 1)
        }.buttonStyle(.plain)
        .onHover { hover = $0 }
        .contextMenu {
            if store.canResume(agent) { Button("다시 시작…") { resuming = true } }
            Button("이름 변경…") { renaming = true }
            if store.canQuit(agent) { Button("종료…") { quitting = true } }
            if agent.tmuxSession != nil && agent.state != .ended { Button("터미널에서 열기") { store.openTerminal(agent) } }
            Divider()
            Button(agent.state == .ended ? "보관…" : "종료하고 보관…") { deleting = true }
        }
        .agentActions(agent, renaming: $renaming, deleting: $deleting)
        .sheet(isPresented: $resuming) { ResumeSheet(agent: agent) }
        .quitDialog(agent, isPresented: $quitting)
    }
}

/// Cards in as many columns as fit (min 300pt, up to 4, never more than there are cards); the cards share the full width.
struct FillGrid<Item: Identifiable, Content: View>: View {
    var items: [Item]
    var spacing: CGFloat
    @ViewBuilder var content: (Item) -> Content
    private func grid(_ n: Int) -> some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(minimum: 300), spacing: spacing, alignment: .top), count: n), alignment: .leading, spacing: spacing) {
            ForEach(items) { content($0) }
        }
    }
    var body: some View {
        let top = max(1, min(items.count, 4))
        ViewThatFits(in: .horizontal) {
            ForEach(Array((1...top).reversed()), id: \.self) { n in grid(n) }
        }
    }
}
