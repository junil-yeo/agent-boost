import SwiftUI
import AppKit

/// Rows for editing a list of teammates (name, role, model, effort).
struct TeammateEditor: View {
    @Binding var specs: [TeammateSpec]
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach($specs) { $t in
                HStack(spacing: 6) {
                    TextField(L("이름 (영문)"), text: $t.name).frame(width: 120)
                        .overlay(RoundedRectangle(cornerRadius: 4).stroke(t.name.isEmpty || t.nameIsValid ? Color.clear : Color.red))
                    TextField(L("역할 (선택)"), text: $t.role).frame(minWidth: 160)
                    Picker("", selection: $t.model) { ForEach(ModelChoice.allCases) { Text($0.label).tag($0) } }.frame(width: 120)
                    Picker("", selection: $t.effort) { ForEach(EffortChoice.allCases) { Text($0.rawValue).tag($0) } }.frame(width: 90)
                    Button { specs.removeAll { $0.id == t.id } } label: { Image(systemName: "minus.circle") }.buttonStyle(.icon)
                }
            }
            Button { specs.append(TeammateSpec(name: "teammate\(specs.count + 1)")) } label: { Label(L("팀원 추가"), systemImage: "plus.circle") }
                .buttonStyle(.raisedCompact)
            Text(L("팀원 이름은 팀 주소(name@team)가 되므로 영문·숫자·_·- 만 됩니다 (Claude 제한). 역할은 자유롭게 한글로 적어도 됩니다."))
                .font(.caption2).foregroundStyle(specs.contains { !$0.name.isEmpty && !$0.nameIsValid } ? .red : .secondary)
        }
    }
}

struct NewSessionSheet: View {
    @EnvironmentObject var store: BoardStore
    @Environment(\.dismiss) private var dismiss
    @AppStorage("new.cwd") private var cwd = Shell.home
    @AppStorage("new.model.v2") private var modelRaw = ModelChoice.opus.rawValue
    @AppStorage("new.effort.v2") private var effortRaw = EffortChoice.low.rawValue
    @AppStorage("new.bypass") private var bypass = true
    @State private var name = ""
    @State private var withTeam = false
    @State private var team: [TeammateSpec] = [TeammateSpec(name: "teammate1")]
    @State private var task = ""
    @AppStorage("new.cloud") private var cloud = false
    @State private var repos: [(name: String, priv: Bool)] = []
    @State private var repoNote: String?            // loading / why the list is empty
    @State private var picked: [String] = []
    @State private var repoQuery = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text(L("새 세션")).font(.title2.bold())
                Spacer()
                Picker("", selection: $cloud) {
                    Label(L("이 Mac"), systemImage: "desktopcomputer").tag(false)
                    Label(L("클라우드 (웹)"), systemImage: "cloud").tag(true)
                }.pickerStyle(.segmented).labelsHidden().fixedSize()
            }
            if cloud { cloudForm } else { localForm }
        }
        .padding(20).frame(width: 720).background(Theme.background).animation(.easeOut(duration: 0.15), value: withTeam)
        .task(id: cloud) { if cloud && repos.isEmpty { await loadRepos() } }
    }

    /// A cloud session on claude.ai/code: GitHub repositories cloned there, the first task prefilled. It runs and is
    /// watched on the web (or the mobile app): no transcript comes to this Mac, so it does not appear on the board.
    @ViewBuilder private var cloudForm: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(L("GitHub 저장소")).font(.callout).foregroundStyle(.secondary)
            HStack {
                TextField("", text: $repoQuery, prompt: Text(L("검색하거나 owner/repo 직접 입력"))).textFieldStyle(.roundedBorder)
                    .onSubmit { addTyped() }
                if repoQuery.contains("/"), !picked.contains(repoQuery.trimmingCharacters(in: .whitespaces)) {
                    Button(L("추가")) { addTyped() }.buttonStyle(.raisedCompact)
                }
            }
            if !picked.isEmpty {
                HStack(spacing: 6) {
                    ForEach(picked, id: \.self) { r in
                        HStack(spacing: 4) {
                            Text(r).font(.caption)
                            Button { picked.removeAll { $0 == r } } label: { Image(systemName: "xmark").font(.system(size: 8, weight: .bold)) }.buttonStyle(.plain)
                        }
                        .padding(.horizontal, 8).padding(.vertical, 3).background(Capsule().fill(Theme.accent.opacity(0.15)))
                    }
                }
            }
            let q = repoQuery.lowercased().trimmingCharacters(in: .whitespaces)
            let shown = repos.filter { q.isEmpty || $0.name.lowercased().contains(q) }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if let n = repoNote { Text(n).font(.caption).foregroundStyle(.secondary).padding(8) }
                    ForEach(shown, id: \.name) { r in
                        let on = picked.contains(r.name)
                        Button { if on { picked.removeAll { $0 == r.name } } else { picked.append(r.name) } } label: {
                            HStack {
                                Image(systemName: on ? "checkmark.circle.fill" : "circle").foregroundStyle(on ? Theme.accent : .secondary)
                                Text(r.name)
                                if r.priv { Image(systemName: "lock.fill").font(.caption2).foregroundStyle(.secondary) }
                                Spacer()
                            }.contentShape(Rectangle()).padding(.horizontal, 8).padding(.vertical, 5)
                        }.buttonStyle(.plain)
                    }
                }
            }
            .frame(height: 200).background(Theme.panel).clipShape(RoundedRectangle(cornerRadius: 8))
        }
        VStack(alignment: .leading, spacing: 4) {
            Text(L("첫 작업 (선택)")).font(.callout).foregroundStyle(.secondary)
            TextField("", text: $task, prompt: Text(L("웹 입력창에 미리 채워집니다. 보내기는 웹에서 누릅니다")), axis: .vertical)
                .lineLimit(2...5).textFieldStyle(.roundedBorder).multilineTextAlignment(.leading)
        }
        Text(L("claude.ai/code가 브라우저에서 열리고, 고른 저장소와 첫 작업이 채워진 상태로 시작합니다. 클라우드 세션의 대화는 웹이나 모바일 앱에서 보며, 이 앱의 세션 목록에는 나타나지 않습니다. 비공개 저장소는 Claude GitHub 앱이 설치돼 있어야 합니다."))
            .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        HStack {
            Spacer()
            Button(L("취소")) { dismiss() }.keyboardShortcut(.cancelAction).buttonStyle(.raised)
            Button(L("웹에서 열기")) { openCloud() }
                .keyboardShortcut(.defaultAction).buttonStyle(.raisedProminent).disabled(picked.isEmpty)
        }
    }
    private func addTyped() {
        let r = repoQuery.trimmingCharacters(in: .whitespaces)
        guard r.split(separator: "/").count == 2, !picked.contains(r) else { return }
        picked.append(r); repoQuery = ""
    }
    private func openCloud() {
        var c = URLComponents(string: "https://claude.ai/code")!
        var items = [URLQueryItem(name: "repositories", value: picked.joined(separator: ","))]
        let t = task.trimmingCharacters(in: .whitespacesAndNewlines)
        if !t.isEmpty { items.insert(URLQueryItem(name: "prompt", value: t), at: 0) }
        c.queryItems = items
        // "+" and "&" inside a value must not read as a space or a new parameter
        c.percentEncodedQuery = c.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        if let u = c.url { NSWorkspace.shared.open(u); SendLog.note("새 클라우드 세션: \(picked.joined(separator: ",")) 웹으로 열기") }
        dismiss()
    }
    /// The user's repositories through the gh CLI (own, collaborator and organisation ones), most recently pushed first.
    private func loadRepos() async {
        repoNote = L("저장소 목록을 불러오는 중…")
        let gh = Shell.gh
        let r = await Task.detached {
            Shell.run([gh, "api", "--paginate", "user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member",
                       "--jq", ".[] | [.full_name, (.private|tostring)] | @tsv"], timeout: 25)
        }.value
        let rows = r.out.split(separator: "\n").compactMap { l -> (name: String, priv: Bool)? in
            let f = l.split(separator: "\t")
            return f.count == 2 ? (String(f[0]), f[1] == "true") : nil
        }
        repos = rows
        repoNote = rows.isEmpty ? (FileManager.default.isExecutableFile(atPath: gh)
            ? L("저장소 목록을 불러오지 못했습니다 (gh auth login 필요할 수 있음). owner/repo를 위에 직접 입력하세요.")
            : L("gh(GitHub CLI)가 없어 목록을 불러오지 못했습니다. owner/repo를 위에 직접 입력하세요.")) : nil
    }

    @ViewBuilder private var localForm: some View {
            Form {
                TextField(L("이름 (표시용 별칭)"), text: $name, prompt: Text(L("예: 논문 그림 리뷰 — 한글 가능, 나중에 /rename 으로 변경 가능"))).multilineTextAlignment(.leading)
                HStack {
                    TextField(L("작업 폴더"), text: $cwd).multilineTextAlignment(.leading)
                    Button(L("선택…")) { pickFolder() }.buttonStyle(.raisedCompact)
                }
                Picker(L("모델"), selection: $modelRaw) { ForEach(ModelChoice.allCases) { Text($0.label).tag($0.rawValue) } }
                Picker("effort", selection: $effortRaw) { ForEach(EffortChoice.allCases) { Text($0.rawValue).tag($0.rawValue) } }
                Toggle(L("팀원 구성 (이 세션이 팀장이 됨)"), isOn: $withTeam)
                BypassToggle(on: $bypass)
            }
            .formStyle(.grouped).scrollContentBackground(.hidden).scrollDisabled(true).fixedSize(horizontal: false, vertical: true)
            VStack(alignment: .leading, spacing: 4) {      // outside the Form: a grouped Form right-aligns its text fields
                Text(L("첫 작업 (선택)")).font(.callout).foregroundStyle(.secondary)
                TextField("", text: $task, prompt: Text(L("비워 두면 지시를 기다립니다")), axis: .vertical)
                    .lineLimit(2...5).textFieldStyle(.roundedBorder).multilineTextAlignment(.leading)
            }
            if withTeam {
                // full-width block under the form, so the form's columns keep their widths
                VStack(alignment: .leading, spacing: 8) {
                    Text(L("팀원")).font(.headline)
                    ScrollView { TeammateEditor(specs: $team).frame(maxWidth: .infinity, alignment: .leading) }.frame(maxHeight: 160)
                    if modelRaw == ModelChoice.haiku.rawValue || modelRaw == ModelChoice.haiku45.rawValue { HaikuLeadWarning() }
                }
                .padding(12).background(Theme.panel).clipShape(RoundedRectangle(cornerRadius: 8))
                .transition(.opacity)
            }
            Text(withTeam ? L("세션이 시작되면 위 팀원 구성을 지시받아 Claude의 팀 기능으로 팀원을 만듭니다. 팀원 생성부터 토큰을 사용합니다.") : L("첫 작업을 비워 두면 토큰을 쓰지 않고 대기합니다."))
                .font(.caption).foregroundStyle(.secondary)
            HStack {
                Spacer()
                Button(L("취소")) { dismiss() }.keyboardShortcut(.cancelAction).buttonStyle(.raised)
                Button(L("시작")) {
                    if store.createSession(name: name, cwd: cwd, model: ModelChoice(rawValue: modelRaw) ?? .sonnet,
                                           effort: EffortChoice(rawValue: effortRaw) ?? .medium,
                                           teammates: withTeam ? team : [], task: task, bypass: bypass) != nil { dismiss() }
                }
                .keyboardShortcut(.defaultAction).buttonStyle(.raisedProminent).disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
            }
    }
    private func pickFolder() {
        let p = NSOpenPanel(); p.canChooseDirectories = true; p.canChooseFiles = false
        p.directoryURL = URL(fileURLWithPath: cwd)
        if p.runModal() == .OK, let u = p.url { cwd = u.path }
    }
}

struct AddTeammateSheet: View {
    @EnvironmentObject var store: BoardStore
    @Environment(\.dismiss) private var dismiss
    var agent: Agent
    @State private var specs: [TeammateSpec] = [TeammateSpec(name: "teammate1")]
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L("'%@'에 팀원 추가", agent.name)).font(.title3.bold())
            Text(agent.isLead || agent.teamName != nil ? L("이 세션이 팀장으로서 팀원을 만듭니다.") : L("개별 세션입니다. 이 세션이 팀을 만들고 팀장이 됩니다."))
                .font(.caption).foregroundStyle(.secondary)
            TeammateEditor(specs: $specs)
            if (agent.model ?? "").contains("haiku") { HaikuLeadWarning() }
            if !store.canSpawnTeammates(agent) {
                Label(L("이 세션은 tmux를 찾을 수 없는 환경에서 시작돼 팀원을 만들 수 없습니다 (이전 버전 앱의 문제). 종료한 뒤 '다시 시작'하면 해결됩니다."), systemImage: "exclamationmark.octagon")
                    .font(.caption).foregroundStyle(.red)
            }
            if agent.state == .busy { Text(L("작업 중이라 지시가 현재 작업 뒤에 대기열로 들어갑니다.")).font(.caption).foregroundStyle(.orange) }
            HStack {
                Spacer()
                Button(L("취소")) { dismiss() }.keyboardShortcut(.cancelAction).buttonStyle(.raised)
                Button(L("만들기")) { store.addTeammates(specs, to: agent); dismiss() }.keyboardShortcut(.defaultAction).buttonStyle(.raisedProminent)
                    .disabled(!specs.contains { $0.nameIsValid })
            }
        }.padding(20).frame(width: 600).background(Theme.background)
        .onAppear { _ = store.canSpawnTeammates(agent) }          // start the background check before the warning is needed
    }
}

struct ResumeSheet: View {
    @EnvironmentObject var store: BoardStore
    @Environment(\.dismiss) private var dismiss
    var agent: Agent
    @State private var model: ModelChoice = .sonnet
    @State private var effort: EffortChoice = .medium
    @State private var fork = false
    @AppStorage("new.bypass") private var bypass = true
    var body: some View {
        let job = store.jobRecord(for: store.conversationId(agent))
        VStack(alignment: .leading, spacing: 12) {
            Text(L("'%@' 다시 시작", agent.name)).font(.title3.bold())
            Text(job != nil ? L("CLI 백그라운드 작업의 대화입니다. CLI 방식대로 같은 ID로 백그라운드에서 이어서 열고(claude --bg --resume) 화면을 붙입니다(claude attach).")
                            : L("이전 대화를 같은 세션 ID로 그대로 이어서 엽니다 (claude --resume).")).font(.caption).foregroundStyle(.secondary)
            if let cwd = store.workingDirectory(of: agent) { Label(cwd, systemImage: "folder").font(.caption).lineLimit(1).truncationMode(.middle) }
            Form {
                Picker(L("모델"), selection: $model) { ForEach(ModelChoice.allCases) { Text($0.label).tag($0) } }
                Picker("effort", selection: $effort) { ForEach(EffortChoice.allCases) { Text($0.rawValue).tag($0) } }
                BypassToggle(on: $bypass)
                if job == nil {
                    Toggle(L("복사본으로 분기해서 열기 (--fork-session, 새 세션 ID)"), isOn: $fork)
                    if let h = store.externalHost(agent) {
                        Text(L("%@에서 만든 대화입니다. 끄면 원본을 같은 ID로 이어가고(%@의 목록과 같은 대화), 켜면 원본은 두고 복사본을 엽니다.", h, h)).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            Text(L("시작 옵션으로 지정하므로 기본 설정은 바뀌지 않습니다.")).font(.caption).foregroundStyle(.secondary)
            if agent.teamName != nil && !agent.isLead {
                Text(L("팀원 세션은 팀과 분리된 개별 세션으로 열립니다. 팀장과의 연결은 복구되지 않습니다.")).font(.caption).foregroundStyle(.orange)
            }
            HStack {
                Spacer()
                Button(L("취소")) { dismiss() }.keyboardShortcut(.cancelAction).buttonStyle(.raised)
                Button(L("시작")) { if store.resume(agent, model: model, effort: effort, bypass: bypass, fork: fork) != nil { dismiss() } }.keyboardShortcut(.defaultAction).buttonStyle(.raisedProminent)
            }
        }
        .padding(20).frame(width: 520).background(Theme.background)
        .onAppear {
            model = ModelChoice(rawValue: agent.model ?? "") ?? ModelChoice.allCases.first { (agent.model ?? "").hasPrefix($0.rawValue) } ?? .sonnet
            effort = EffortChoice(rawValue: agent.effort ?? "") ?? .medium
        }
    }
}

/// Small models do not follow Claude Code's team protocol reliably (tested).
struct HaikuLeadWarning: View {
    var body: some View {
        Label(L("Haiku 팀장은 팀원 생성·종료 규약을 자주 틀립니다 (테스트에서 실패). 팀장은 Sonnet 이상을 권장합니다."), systemImage: "exclamationmark.triangle")
            .font(.caption).foregroundStyle(.orange)
    }
}

/// "Ask nothing" start option: `--dangerously-skip-permissions` (every tool call runs without a permission question).
struct BypassToggle: View {
    @Binding var on: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Toggle(L("권한 확인 없이 실행 (--dangerously-skip-permissions)"), isOn: $on)
            Text(on ? L("파일 수정·셸 명령을 묻지 않고 모두 실행합니다. 믿을 수 있는 폴더에서만 쓰세요.") : L("Claude Code의 권한 설정대로 필요할 때 묻습니다."))
                .font(.caption).foregroundStyle(on ? Color.orange : Color.secondary)
        }
    }
}
