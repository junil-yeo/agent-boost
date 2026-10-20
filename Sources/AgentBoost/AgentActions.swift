import SwiftUI

/// Rename + delete, shared by the org-chart cards and the team detail header.
struct AgentActions: ViewModifier {
    @EnvironmentObject var store: BoardStore
    var agent: Agent
    @Binding var renaming: Bool
    @Binding var deleting: Bool
    @State private var newName = ""

    func body(content: Content) -> some View {
        content
            .onChange(of: renaming) { _, on in if on { newName = agent.name } }
            .alert(L("이름 변경"), isPresented: $renaming) {
                TextField(L("새 이름"), text: $newName)
                Button(L("변경")) { store.rename(agent, to: newName) }
                Button(L("취소"), role: .cancel) {}
            } message: { Text(renameMessage) }
            .sheet(isPresented: $deleting) { DeleteSheet(agent: agent, message: deleteMessage) }
    }
    private var renameMessage: String {
        let base: String
        switch agent.state {
        case .ended: base = L("종료된 세션입니다. 대화 기록에 이름을 저장하므로 나중에 이어서 열어도 유지됩니다.")
        case .needsInput: base = L("입력을 기다리는 중입니다. 응답 후 /rename을 보냅니다.")
        case .busy: base = L("작업 중입니다. 대기 상태가 되면 /rename을 보냅니다.")
        default: base = agent.tmuxPane == nil ? L("이 세션에는 입력할 수 없어 이름을 기록에 저장합니다. 다음에 다시 시작할 때부터 적용됩니다.") : L("에이전트에 /rename을 보냅니다.")
        }
        return base + (agent.teamAddress.map { "\n" + L("팀 주소(%@)는 바뀌지 않습니다.", $0) } ?? "")
    }
    private var deleteMessage: String {
        (agent.state == .ended ? "" : L("먼저 /exit 으로 종료합니다.") + "\n") +
        L("보드에서 숨기고 보관함으로 옮깁니다. 파일은 그대로 두므로 보관함에서 복원하거나, 거기서 영구 삭제할 수 있습니다.")
    }
}
extension View {
    func agentActions(_ a: Agent, renaming: Binding<Bool>, deleting: Binding<Bool>) -> some View {
        modifier(AgentActions(agent: a, renaming: renaming, deleting: deleting))
    }
}

/// Quit confirmation. Idle: one button. Busy: interrupt now, or exit when the turn ends.
struct QuitDialog: ViewModifier {
    @EnvironmentObject var store: BoardStore
    var agent: Agent
    @Binding var isPresented: Bool
    func body(content: Content) -> some View {
        content.confirmationDialog(L("'%@' 종료", agent.name), isPresented: $isPresented, titleVisibility: .visible) {
            if agent.working {
                Button(L("지금 종료 (작업 중단)"), role: .destructive) { store.quit(agent, mode: .now) }
                Button(L("작업 끝나면 종료")) { store.quit(agent, mode: .whenIdle) }
            } else {
                Button(L("종료"), role: .destructive) { store.quit(agent, mode: .now) }
            }
            Button(L("취소"), role: .cancel) {}
        } message: {
            Text(quitMessage)
        }
    }
}
extension QuitDialog {
    var quitMessage: String {
        var s: String
        if agent.isBackgroundJob { s = agent.tmuxPane != nil ? L("CLI 백그라운드 작업입니다. claude stop %@(으)로 멈추고, 붙어 있는 CLI 화면은 ctrl+c 두 번으로 닫습니다.", agent.jobId ?? "") : L("CLI 백그라운드 작업입니다. claude stop %@(으)로 멈추고 목록(claude agents)에는 남습니다.", agent.jobId ?? "") }
        else if agent.tmuxPane != nil { s = agent.working ? L("작업 중입니다.") : (agent.overlay != nil ? L("CLI가 %@ 화면이라 Esc로 돌아간 뒤 /exit 을 보냅니다.", BoardStore.overlayName(agent.overlay!)) : L("/exit 을 입력해 실제로 종료합니다.")) }
        else { s = L("입력할 수 없는 세션이라 종료 신호(SIGTERM)로 프로세스를 실제로 끕니다.") }
        if agent.entrypoint == "claude-desktop" {
            s += "\n" + L("⚠️ Claude 데스크톱 앱의 대화입니다. 끄면 데스크톱 앱의 해당 대화가 끊기고, 데스크톱 앱이 다음 메시지 때 다시 띄울 수 있습니다.")
        }
        return s + "\n" + L("대화 기록은 남고, 나중에 다시 시작할 수 있습니다.")
    }
}
extension View {
    func quitDialog(_ a: Agent, isPresented: Binding<Bool>) -> some View { modifier(QuitDialog(agent: a, isPresented: isPresented)) }
}

/// Delete confirmation. For a lead with teammates: a checkbox to stop and delete them too
/// (otherwise they keep running without a lead).
struct DeleteSheet: View {
    @EnvironmentObject var store: BoardStore
    @Environment(\.dismiss) private var dismiss
    var agent: Agent
    var message: String
    @AppStorage("delete.withTeammates") private var withTeammates = true
    var body: some View {
        let mates = store.teammates(of: agent)
        VStack(alignment: .leading, spacing: 12) {
            Text(L("'%@' 세션을 보관할까요?", agent.name)).font(.title3.bold())
            Text(message).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if !mates.isEmpty {
                Toggle(isOn: $withTeammates) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(L("팀원 %@명도 함께 보관", String(mates.count))).font(.callout.bold())
                        Text(mates.map(\.name).joined(separator: ", ")).font(.caption).foregroundStyle(.secondary)
                    }
                }.toggleStyle(.checkbox)
                if !withTeammates {
                    Label(L("팀원은 팀장 없이 계속 실행됩니다."), systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.orange)
                }
            }
            HStack {
                Spacer()
                Button(L("취소")) { dismiss() }.keyboardShortcut(.cancelAction).buttonStyle(.raised)
                Button(agent.state == .ended ? L("보관") : L("종료하고 보관")) {
                    store.archive(agent, withTeammates: withTeammates && !mates.isEmpty); dismiss()
                }.keyboardShortcut(.defaultAction).buttonStyle(.raisedProminent)
            }
        }.padding(20).frame(width: 460).background(Theme.background)
    }
}
