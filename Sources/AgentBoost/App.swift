import AppKit
import SwiftUI

/// Saved window state could relaunch the app with no window at all (if the window was
/// closed last time). Ignore it so the board window always opens.
final class AppDelegate: NSObject, NSApplicationDelegate {
    static let showNote = Notification.Name("local.junil.agentboost.show")
    func applicationWillFinishLaunching(_ notification: Notification) {
        UserDefaults.standard.set(true, forKey: "ApplePersistenceIgnoreState")
        enforceSingleInstance()
        // a second launch asks the running board to come back to the front
        DistributedNotificationCenter.default().addObserver(forName: Self.showNote, object: nil, queue: .main) { _ in Self.showBoard() }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    /// Quitting the board switches its sessions off (explicit /exit); the next launch resumes them.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        let fm = FileManager.default
        if fm.fileExists(atPath: BoardStore.skipShutdownFlag) { try? fm.removeItem(atPath: BoardStore.skipShutdownFlag); return .terminateNow }
        if ProcessInfo.processInfo.arguments.contains("--snapshot") { return .terminateNow }
        guard let store = BoardStore.shared else { return .terminateNow }
        let live = store.controllableLive
        if live.isEmpty { Self.quitStops = nil; return .terminateNow }
        // ⌘Q / Dock quit come without a choice: ask which kind of quit.
        var stops = Self.quitStops
        Self.quitStops = nil
        if stops == nil {
            Self.showBoard()
            let a = NSAlert()
            a.messageText = L("Agent Boost를 종료합니다")
            a.informativeText = L("세션 %@개가 실행 중입니다. 세션은 그대로 두고 앱만 끌까요, 세션까지 모두 끌까요(/exit)? 세션까지 끄면 다음에 앱을 켤 때 다시 시작합니다.", String(live.count))
            a.addButton(withTitle: L("앱만 종료")); a.addButton(withTitle: L("세션까지 종료")); a.addButton(withTitle: L("취소"))
            switch a.runModal() {
            case .alertFirstButtonReturn: stops = false
            case .alertSecondButtonReturn: stops = true
            default: return .terminateCancel
            }
        }
        let waiting = live.filter { $0.state == .needsInput }
        if stops == false {
            // app only: the sessions keep running, but nobody will see their questions once the board is gone
            if !waiting.isEmpty {
                Self.showBoard()
                let a = NSAlert()
                a.messageText = L("응답을 기다리는 세션 %@개가 있습니다", String(waiting.count))
                a.informativeText = L("앱을 끄면 이 질문들의 알림을 받을 수 없습니다. 세션은 tmux에서 계속 답을 기다립니다.") + "\n\n" + Self.describe(waiting)
                a.addButton(withTitle: L("그래도 앱만 종료")); a.addButton(withTitle: L("취소 (답하러 가기)"))
                if a.runModal() != .alertFirstButtonReturn { return .terminateCancel }
            }
            return .terminateNow
        }
        let busy = live.filter { $0.state == .busy }, overlays = live.filter { $0.overlay != nil }
        // everything the quit would cut short is listed before it happens: a question nobody would otherwise see, a running
        // turn, a CLI that sits on its session list
        if !busy.isEmpty || !waiting.isEmpty || !overlays.isEmpty {
            Self.showBoard()
            let alert = NSAlert()
            alert.messageText = L("세션 %@개를 모두 끄고 종료할까요?", String(live.count))
            var lines: [String] = []
            if !waiting.isEmpty { lines.append(L("응답을 기다리는 세션 %@개 — 종료하면 그 질문은 취소(Esc)됩니다:", String(waiting.count)) + "\n" + Self.describe(waiting)) }
            if !busy.isEmpty { lines.append(L("작업 중인 세션 %@개 — 작업을 중단합니다: %@", String(busy.count), busy.map(\.name).joined(separator: ", "))) }
            if !overlays.isEmpty { lines.append(L("CLI가 세션 목록·선택 화면인 세션 %@개 — Esc로 대화로 돌아간 뒤 끕니다: %@", String(overlays.count), overlays.map(\.name).joined(separator: ", "))) }
            alert.informativeText = lines.joined(separator: "\n\n") + "\n\n" + L("다음에 앱을 켜면 다시 시작합니다.")
            alert.addButton(withTitle: waiting.isEmpty ? L("중단하고 종료") : L("질문 취소하고 종료")); alert.addButton(withTitle: L("취소"))
            if alert.runModal() != .alertFirstButtonReturn { return .terminateCancel }
        }
        Task { @MainActor in
            let problems = await store.shutdownAll()
            if !problems.isEmpty {                                 // the last chance to say it: the app is about to be gone
                Self.showBoard()
                let a = NSAlert()
                a.messageText = L("일부 세션이 정상 종료되지 않았습니다")
                a.informativeText = problems.joined(separator: "\n")
                a.addButton(withTitle: L("확인"))
                a.runModal()
            }
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }
    /// One line per session waiting for an answer: its name and the question on its screen.
    static func describe(_ waiting: [Agent]) -> String {
        waiting.map { a in
            var s = "• \(a.name)"
            if let p = a.prompt { s += ": \(p.title.prefix(80))"; if !p.options.isEmpty { s += "  [\(p.options.map { String($0.prefix(24)) }.joined(separator: " / "))]" } }
            return s
        }.joined(separator: "\n")
    }
    /// Double-clicking the app icon (or the Dock) while running brings the board back.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { Self.showBoard(); return true }

    /// Back to the user: Dock icon, window in front.
    /// Set by the always-alive menu-bar label: SwiftUI's openWindow, to recreate a closed window.
    static var openMainWindow: (() -> Void)?
    /// Set by an explicit quit button: true = also /exit every session, false = app only.
    static var quitStops: Bool?
    static func quit(stopSessions: Bool) { quitStops = stopSessions; NSApp.terminate(nil) }
    static func showBoard() {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        let wins = NSApp.windows.filter { $0.canBecomeMain && !($0.className.contains("MenuBarExtra")) && $0.contentView != nil }
        if wins.isEmpty {
            openMainWindow?()            // the window was closed (not just hidden): make a new one
        } else {
            for w in wins { w.makeKeyAndOrderFront(nil) }
        }
    }
    /// Background: window hidden, no Dock icon; sessions, monitoring and the menu-bar icon keep running.
    static func goBackground() {
        for w in NSApp.windows where w.canBecomeMain { w.orderOut(nil) }
        NSApp.setActivationPolicy(.accessory)
    }

    /// One board at a time — two would double-send commands and fight over sessions.
    /// A lock file decides, whatever the launch path (Finder, Dock, terminal, another copy).
    /// The holder is brought forward and this launch exits — unless the holder is a stale
    /// build (running since before this binary was built), which is replaced instead.
    private static var lockFD: Int32 = -1
    private func enforceSingleInstance() {
        if ProcessInfo.processInfo.arguments.contains("--snapshot") { return }   // self-tests run side by side
        let dir = Shell.home + "/.agent-boost"
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let path = dir + "/app.lock"
        let built = (try? Bundle.main.executableURL?.resourceValues(forKeys: [.contentModificationDateKey]))??.contentModificationDate ?? .distantPast
        for attempt in 0..<2 {
            let fd = open(path, O_RDWR | O_CREAT, 0o644)
            guard fd >= 0 else { return }
            if flock(fd, LOCK_EX | LOCK_NB) == 0 {
                ftruncate(fd, 0); let me = "\(getpid())"; _ = me.withCString { write(fd, $0, strlen($0)) }
                Self.lockFD = fd                       // held for the app's lifetime
                return
            }
            var buf = [UInt8](repeating: 0, count: 32); let n = read(fd, &buf, 31); close(fd)
            guard n > 0, let pid = Int32(String(decoding: buf[0..<n], as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)),
                  let holder = NSRunningApplication(processIdentifier: pid) else { return }
            let stale = (holder.launchDate ?? .distantPast) < built
            if !stale || attempt == 1 {
                DistributedNotificationCenter.default().postNotificationName(Self.showNote, object: nil, userInfo: nil, deliverImmediately: true)
                holder.activate()
                exit(0)
            }
            holder.terminate()
            for _ in 0..<100 where !holder.isTerminated { usleep(100_000) }   // a quitting board can take a few seconds
            if !holder.isTerminated { holder.forceTerminate(); usleep(300_000) }
        }
    }
}

@main
struct AgentBoostApp: App {
    /// The app was "Agent Board", then "Agent Bridge": move the data folder and settings over once. The old folder
    /// name stays as a link to the new one, so file paths already written into conversations keep working.
    static func migrateOldNames() {
        let fm = FileManager.default, home = Shell.home
        let new = home + "/.agent-boost"
        for old in [home + "/.agent-bridge", home + "/.agent-board"] {
            let isLink = (try? fm.destinationOfSymbolicLink(atPath: old)) != nil
            if !isLink, fm.fileExists(atPath: old), !fm.fileExists(atPath: new) {
                if (try? fm.moveItem(atPath: old, toPath: new)) != nil { try? fm.createSymbolicLink(atPath: old, withDestinationPath: new) }
            }
        }
        let d = UserDefaults.standard
        if d.object(forKey: "migratedFromAgentBridge") == nil {
            for dom in ["local.junil.agentbridge", "local.junil.agentboard"] {
                for (k, v) in d.persistentDomain(forName: dom) ?? [:] where d.object(forKey: k) == nil { d.set(v, forKey: k) }
            }
            d.set(true, forKey: "migratedFromAgentBridge")
        }
    }
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var store = BoardStore()
    @AppStorage("ui.chatFont") private var chatFont: Double = 15
    @AppStorage("ui.termFont") private var termFont: Double = 13
    @AppStorage("ui.showNotices") private var showNotices = true
    @AppStorage("ui.cliSuggest") private var cliSuggest = true
    @AppStorage("ui.termChat") private var termChat = true
    @AppStorage("ui.appearance") private var appearance = AppearanceMode.dark.rawValue
    @AppStorage(AppLang.key) private var language = ""
    init() {
        Self.migrateOldNames()
        let args = CommandLine.arguments
        if args.contains("--selftest-detect") { exit(DetectTest.run()) }
        if let i = args.firstIndex(of: "--selftest-answer"), i + 2 < args.count { exit(DetectTest.answer(pane: args[i + 1], index: Int(args[i + 2]) ?? 0)) }   // drives a real pane
    }
    var body: some Scene {
        WindowGroup("Agent Boost", id: "main") {
            Group {
                if language.isEmpty {
                    // first launch: pick a language, then the app starts with its power-on test and rocket loading
                    LanguagePickerView { l in
                        L10n.set(l); language = l.rawValue
                        store.manualRefresh()
                    }
                } else {
                    RootView().environmentObject(store).id(language)     // a new language redraws every text
                }
            }
            .frame(minWidth: 900, minHeight: 600)
            .background(Theme.background.ignoresSafeArea())
            .tint(Theme.accent).accentColor(Theme.accent)
        }.windowStyle(.hiddenTitleBar)
        MenuBarExtra {
            MenuBarContent().environmentObject(store).id(language)
        } label: {
            MenuBarLabel().environmentObject(store)
        }
        .commands {
            CommandGroup(after: .toolbar) {
                Button(L("대화 글자 크게")) { chatFont = min(24, chatFont + 1); termFont = min(20, termFont + 1) }.keyboardShortcut("=", modifiers: .command)
                Button(L("대화 글자 작게")) { chatFont = max(11, chatFont - 1); termFont = max(9, termFont - 1) }.keyboardShortcut("-", modifiers: .command)
                Button(L("대화 글자 기본")) { chatFont = 15; termFont = 13 }.keyboardShortcut("0", modifiers: .command)
                Divider()
                Picker(L("화면 모드"), selection: $appearance) {
                    ForEach(AppearanceMode.allCases, id: \.rawValue) { Text($0.title).tag($0.rawValue) }
                }
                Toggle(L("알림 표시"), isOn: $showNotices)
                Toggle(L("터미널식 대화 표시 (가벼움)"), isOn: $termChat)
                Toggle(L("CLI 다음 입력 제안 켜기 (새로 시작하는 세션부터)"), isOn: $cliSuggest)
                Divider()
                Button(L("Claude Code 업데이트")) { BoardStore.shared?.updateClaude() }
            }
        }
    }
}

struct RootView: View {
    @EnvironmentObject var store: BoardStore
    @State private var tab: String = "home"
    @State private var searching = false
    @State private var creating = false
    @State private var alive: [String] = ["home"]
    private func tabExists(_ k: String) -> Bool {
        if k == "home" || k == "__archive" || k == "__loose" { return true }
        return store.teams.contains { $0.name == k }
    }
    @ViewBuilder private func tabContent(_ k: String, active: Bool) -> some View {
        if k == "__archive" { ArchiveView().areaBox() }
        else if k == "__loose" { TeamDetailView(team: Team(name: L("개별 세션"), createdAt: nil, leadSessionId: nil, members: store.loose), isLoose: true, active: active) }
        else if let t = store.teams.first(where: { $0.name == k }) { TeamDetailView(team: t, active: active) }
        else { OrgChartView() }
    }
    @AppStorage("ui.showNotices") private var showNotices = true
    @AppStorage("ui.appearance") private var appearance = AppearanceMode.dark.rawValue
    /// NSApp.appearance, not preferredColorScheme: SwiftUI does not go back to "follow macOS" once a scheme was forced.
    static func applyAppearance(_ raw: String) {
        let args = ProcessInfo.processInfo.arguments
        let m = args.firstIndex(of: "--appearance").flatMap { $0 + 1 < args.count ? AppearanceMode(rawValue: args[$0 + 1]) : nil }
            ?? AppearanceMode(rawValue: raw) ?? .dark
        NSApp.appearance = m == .system ? nil : NSAppearance(named: m == .dark ? .darkAqua : .aqua)
    }
    @Environment(\.colorScheme) private var scheme
    private var isDark: Bool { scheme == .dark }
    private var waitingForAnswer: [Agent] { (store.teams.flatMap(\.members) + store.loose).filter { $0.state == .needsInput && $0.prompt != nil } }
    var body: some View {
        GeometryReader { geo in
        // VS Code's layout: every area a box of the same colour, the boxes a gap apart on the near-black base
        VStack(spacing: Theme.gap) {
            // the usage banner and the tab row: one box, no line between them
            VStack(spacing: 0) {
            UsageBanner(compact: geo.size.height < 700)
            HStack(spacing: 8) {
                TabButton(title: L("조직도"), icon: "rectangle.3.group", active: tab == "home") { tab = "home" }
                if !store.loose.isEmpty {
                    TabButton(title: L("개별 세션"), icon: "person", active: tab == "__loose", count: store.loose.filter { $0.state != .ended }.count) {
                        tab = "__loose"
                    }
                }
                // tabs: live teams only; an ended team shows a tab only while it is open (from 조직도 > 팀 열기)
                ForEach(store.teams.filter { $0.liveCount > 0 || $0.name == tab }) { t in
                    TabButton(title: t.displayName, icon: "person.3", active: tab == t.name, count: t.liveCount, attention: t.members.contains { $0.state == .needsInput }) { tab = t.name; store.selectedTeam = t.name }
                }
                Spacer(minLength: 12)
                HStack(spacing: 6) {
                Button { store.updateClaude() } label: { Label(L("업데이트"), systemImage: "arrow.down.circle") }
                    .buttonStyle(QuietButtonStyle()).help(L("claude update를 실행합니다. 실행 중인 세션은 다시 시작해야 새 버전을 씁니다."))
                Button { AppDelegate.goBackground() } label: { Label(L("백그라운드"), systemImage: "moon.zzz") }
                    .buttonStyle(QuietButtonStyle()).help(L("창을 숨기고 백그라운드에서 계속 실행합니다. 메뉴 막대 아이콘이나 앱 아이콘으로 다시 엽니다."))
                // the count sits beside the label, as on the other tabs (a badge over the corner covered the text)
                TabButton(title: L("보관함"), icon: "archivebox", active: tab == "__archive", count: store.archive.count, quiet: true) { tab = "__archive" }
                if !store.selection.isEmpty { SelectionBar() }
                Button { store.createDiskManager() } label: { Label(L("디스크 관리자 생성"), systemImage: "internaldrive") }
                    .buttonStyle(QuietButtonStyle())
                    .help(L("홈 폴더에 'Memory Manager' 세션(Sonnet 5.5 · low)을 만들고 디스크 분석·정리 제안을 바로 지시합니다. 실제 정리는 승인 후에만 합니다."))
                Button { appearance = isDark ? AppearanceMode.light.rawValue : AppearanceMode.dark.rawValue } label: {
                    Image(systemName: isDark ? "sun.max" : "moon").frame(width: 16)
                }
                .buttonStyle(QuietButtonStyle()).help(isDark ? L("화이트 모드로 바꿉니다") : L("다크 모드로 바꿉니다"))
                Button { searching = true } label: { Label(L("대화 검색"), systemImage: "magnifyingglass") }
                    .keyboardShortcut("f", modifiers: [.command, .shift]).buttonStyle(QuietButtonStyle()).help(L("모든 세션의 지난 대화에서 찾습니다 (⌘⇧F)"))
                Button { creating = true } label: { Label(L("새 세션"), systemImage: "plus") }.keyboardShortcut("n").buttonStyle(TabFaceStyle(strong: true))
                }
            }
            .padding(.horizontal, 8).padding(.vertical, 6)
            }
            .areaBox()
            .zIndex(20)
            if showNotices { AlertStrip() }
            // sessions still starting (folder trust question, stuck …): on every tab, not only the org chart — a new
            // session opened from a team tab used to wait on Claude's trust question with nothing on screen
            if tab != "home" && !store.launches.isEmpty {
                VStack(alignment: .leading, spacing: 8) { ForEach(store.launches) { l in LaunchCard(launch: l) } }
                    .padding(.horizontal, 12).padding(.vertical, 8).frame(maxWidth: .infinity, alignment: .leading).areaBox()
            }
            if showNotices { ForEach(store.spawnChecks) { c in SpawnCheckRow(check: c) } }
            // every tab visited stays built (hidden); a click only changes which one is visible
            let current = tabExists(tab) ? tab : "home"
            ZStack {
                ForEach(alive.filter(tabExists), id: \.self) { k in
                    tabContent(k, active: k == current)
                        .opacity(k == current ? 1 : 0).allowsHitTesting(k == current).zIndex(k == current ? 1 : 0)
                }
            }
            .onAppear { if !alive.contains(current) { alive.append(current) } }
            .onChange(of: current) { _, c in if !alive.contains(c) { alive.append(c) } }
        }
        .padding(Theme.gap)
        .background(Theme.base)
        .background { CloseInterceptor().frame(width: 0, height: 0) }
        .onAppear { Self.applyAppearance(appearance) }
        .onChange(of: appearance) { _, a in Self.applyAppearance(a) }
        .onAppear { PromptNotifier.shared.install(store: store); if let t = store.launchTab { tab = t }; SelfTest.runIfRequested(store: store) { tab = $0 } }
        .onChange(of: waitingForAnswer) { _, w in PromptNotifier.shared.update(waiting: w, enabled: showNotices) }
        .sheet(isPresented: $creating) { NewSessionSheet() }
        .sheet(isPresented: $searching) { ConvoSearchSheet() }
        .onChange(of: store.navRequest) { _, r in if let r { tab = r.tab } }
        .onChange(of: tab) { _, _ in store.refreshSoon() }   // tmux + files off the main thread first
        .onChange(of: store.selectedAgent) { _, sid in
            if let a = store.agent(sid), a.teamName == nil || a.solo, tab != "__loose", tab != "home" || store.selectedTeam == nil { tab = "__loose" }
        }
        .onChange(of: store.selectedTeam) { _, t in if let t, t != tab, store.teams.contains(where: { $0.name == t }) { tab = t } }
        }
        .ignoresSafeArea(.container, edges: .top)
    }
}

struct TabButton: View {
    var title: String; var icon: String; var active: Bool; var count: Int = 0; var attention = false; var quiet = false; var action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: icon)
                Text(title).lineLimit(1)
                if attention { Image(systemName: "hand.raised.fill").font(.caption).foregroundStyle(Theme.attention).help(L("응답을 기다리는 세션이 있습니다")) }
                if count > 0 {
                    CountBadge(count: count, tint: active ? Theme.accent : Theme.surface2, fg: active ? .white : .primary)
                }
            }
        }
        .modifier(TabLook(active: active, quiet: quiet))
    }
    private struct TabLook: ViewModifier {
        var active: Bool; var quiet: Bool
        func body(content: Content) -> some View {
            if quiet { content.buttonStyle(QuietButtonStyle(active: active)) } else { content.buttonStyle(TabFaceStyle(raised: active)) }
        }
    }
}

struct SpawnCheckRow: View {
    @EnvironmentObject var store: BoardStore
    var check: SpawnCheck
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 10) {
                Image(systemName: "person.badge.plus")
                Text(L("팀원 생성 확인")).font(.callout.bold())
                ForEach(check.specs) { s in
                    switch check.results[s.name] ?? .waiting {
                    case .waiting: Label(s.name, systemImage: "hourglass").foregroundStyle(.secondary)
                    case .ok: Label(s.name, systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                    case .mismatch(let why): Label("\(s.name) (\(why))", systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                    case .failed: Label(s.name, systemImage: "xmark.circle.fill").foregroundStyle(.red)
                    }
                }
                Spacer()
                if !check.done { TimelineView(.periodic(from: .now, by: 1)) { ctx in Text(L("확인 중 %@초 경과 · 최대 2분", String(Int(ctx.date.timeIntervalSince(check.started))))).font(.caption).foregroundStyle(.secondary) } }
                else { Text(L("확인 끝")).font(.caption).foregroundStyle(.secondary) }
                Button { store.spawnChecks.removeAll { $0.id == check.id } } label: { Image(systemName: "xmark") }.buttonStyle(.icon).help(L("닫기"))
            }.font(.callout)
            .help(L("팀장에게 팀원 생성을 지시한 뒤, 실제로 팀원 프로세스가 지정한 모델·effort로 떴는지 앱이 확인합니다. 팀장이 실패를 보고하면 즉시 실패로 표시합니다."))
            if !check.reason.isEmpty {
                Text(L("팀장 보고: %@", check.reason)).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            } else if !check.leadScreen.isEmpty {
                Text(L("팀장 화면:\n%@", check.leadScreen)).font(.system(.caption2, design: .monospaced)).foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 6).frame(maxWidth: .infinity, alignment: .leading).areaBox()
    }
}

/// Batch actions for the checked name cards.
struct SelectionBar: View {
    @EnvironmentObject var store: BoardStore
    @State private var confirmDelete = false
    @State private var askQuit = false
    var body: some View {
        let sel = store.selectedAgents
        let wake = sel.filter { store.canResume($0) }.count
        let quit = sel.filter { store.canQuit($0) }.count
        let busy = sel.filter { store.canQuit($0) && $0.state == .busy }.count
        HStack(spacing: 6) {
            Text(L("%@개 선택", String(sel.count))).font(.callout.bold()).foregroundStyle(Theme.accent)
            Button { store.wakeSelected() } label: { Label(L("깨우기 %@", String(wake)), systemImage: "power") }
                .buttonStyle(.raisedCompact).disabled(wake == 0).help(L("종료된 세션을 마지막 모델·effort로 다시 시작"))
            Button { if busy > 0 { askQuit = true } else { store.quitSelected(mode: .now) } } label: { Label(L("끄기 %@", String(quit)), systemImage: "power") }
                .buttonStyle(.raisedCompact).disabled(quit == 0).help(L("실행 중인 세션에 /exit"))
            Button { confirmDelete = true } label: { Label(L("보관 %@", String(sel.count)), systemImage: "archivebox") }
                .buttonStyle(.raisedCompact).help(L("종료 후 보관함으로 (복원 가능)"))
            Button { store.selection.removeAll() } label: { Image(systemName: "xmark.circle") }.buttonStyle(.icon).help(L("선택 해제"))
        }
        .confirmationDialog(L("선택한 %@개 세션을 보관할까요?", String(sel.count)), isPresented: $confirmDelete, titleVisibility: .visible) {
            Button(L("보관")) { store.archiveSelected() }
            Button(L("취소"), role: .cancel) {}
        } message: { Text(sel.map(\.name).joined(separator: ", ") + "\n" + L("실행 중인 세션은 먼저 종료합니다. 보관함에서 복원하거나 영구 삭제할 수 있습니다.")) }
        .confirmationDialog(L("작업 중인 세션이 %@개 있습니다", String(busy)), isPresented: $askQuit, titleVisibility: .visible) {
            Button(L("지금 모두 종료 (작업 중단)"), role: .destructive) { store.quitSelected(mode: .now) }
            Button(L("작업 끝나면 종료")) { store.quitSelected(mode: .whenIdle) }
            Button(L("취소"), role: .cancel) {}
        }
    }
}

/// 보관함: archived sessions, restorable or permanently deletable, one by one or in bulk.
struct ArchiveView: View {
    @EnvironmentObject var store: BoardStore
    @State private var confirmPurge: Set<String>? = nil
    var items: [ArchivedItem] { store.archive.values.sorted { $0.archivedAt > $1.archivedAt } }
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                Text(L("보관함")).font(.title2.bold())
                Text(L("%@개", String(items.count))).foregroundStyle(.secondary)
                Spacer()
                if !items.isEmpty {
                    Button(store.archiveSelection.count == items.count ? L("선택 해제") : L("전체 선택")) {
                        store.archiveSelection = store.archiveSelection.count == items.count ? [] : Set(items.map(\.id))
                    }
                    Button { store.restore(store.archiveSelection) } label: { Label(L("복원 %@", String(store.archiveSelection.count)), systemImage: "arrow.uturn.backward") }
                        .buttonStyle(.raised).disabled(store.archiveSelection.isEmpty)
                    Button(role: .destructive) { confirmPurge = store.archiveSelection } label: { Label(L("영구 삭제 %@", String(store.archiveSelection.count)), systemImage: "trash") }
                        .buttonStyle(.raised).disabled(store.archiveSelection.isEmpty)
                }
            }.padding(16)
            Divider().padding(.horizontal, 16)
            if items.isEmpty {
                ContentUnavailableView(L("보관함이 비어 있습니다"), systemImage: "archivebox", description: Text(L("보드에서 '보관'한 세션이 여기에 모입니다.")))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List {
                    ForEach(items) { it in
                        HStack(spacing: 10) {
                            Toggle("", isOn: Binding(get: { store.archiveSelection.contains(it.id) },
                                                     set: { on in if on { store.archiveSelection.insert(it.id) } else { store.archiveSelection.remove(it.id) } }))
                                .toggleStyle(.checkbox).labelsHidden()
                            VStack(alignment: .leading, spacing: 3) {
                                HStack(spacing: 6) {
                                    Text(it.name).font(.headline)
                                    if it.isLead { Chip(text: L("팀장"), tint: Theme.accent) }
                                    if let t = it.teamName, !it.isLead { Text(t).font(.caption).foregroundStyle(.tertiary) }
                                }
                                HStack(spacing: 8) {
                                    if let c = it.cwd { Label((c as NSString).lastPathComponent, systemImage: "folder").font(.caption).foregroundStyle(.secondary) }
                                    Text(L("출력 %@ · 합 %@", Fmt.tokens(it.tokensOut), Fmt.tokens(it.tokensTotal))).font(.caption).foregroundStyle(.secondary)
                                    Text(L("%@ 보관", Fmt.ago(it.archivedAt))).font(.caption).foregroundStyle(.tertiary)
                                    if it.transcriptPath == nil { Text(L("기록 없음")).font(.caption).foregroundStyle(.orange) }
                                }
                            }
                            Spacer()
                            Button(L("복원")) { store.restore([it.id]) }.buttonStyle(.raisedCompact)
                            Button(L("영구 삭제"), role: .destructive) { confirmPurge = [it.id] }.buttonStyle(.raisedCompact)
                        }.padding(.vertical, 4)
                    }
                }.scrollContentBackground(.hidden)
            }
        }
        .confirmationDialog(L("영구 삭제할까요?"), isPresented: Binding(get: { confirmPurge != nil }, set: { if !$0 { confirmPurge = nil } }), titleVisibility: .visible) {
            Button(L("영구 삭제 %@개", String(confirmPurge?.count ?? 0)), role: .destructive) { if let ids = confirmPurge { store.purge(ids) }; confirmPurge = nil }
            Button(L("취소"), role: .cancel) { confirmPurge = nil }
        } message: { Text(L("대화 기록과 관련 폴더를 디스크에서 지웁니다. 되돌릴 수 없습니다.")) }
    }
}

/// Menu-bar menu: live counts and the way back from background mode.
struct MenuBarContent: View {
    @EnvironmentObject var store: BoardStore
    var body: some View {
        let all = store.teams.flatMap(\.members) + store.loose
        let live = all.filter { $0.state != .ended }.count
        let busy = all.filter { $0.state == .busy }.count
        Text(L("실행 중 %@ · 작업 중 %@", String(live), String(busy)))
        if let s = store.meters.first { Text("\(s.label.replacingOccurrences(of: "Current session", with: L("현재 세션"))) \(s.percent)%") }
        Divider()
        Button(L("보드 열기")) { AppDelegate.showBoard() }.keyboardShortcut("o")
        Button(L("백그라운드로")) { AppDelegate.goBackground() }
        Divider()
        Button(L("앱만 종료 (세션 유지)")) { AppDelegate.quit(stopSessions: false) }
        Button(L("앱 + 세션 모두 종료")) { AppDelegate.quit(stopSessions: true) }
    }
}

/// Menu-bar icon. Being always alive, it also hands SwiftUI's openWindow to the app delegate.
struct MenuBarLabel: View {
    @EnvironmentObject var store: BoardStore
    /// The app's mark as a template image: macOS tints it for the menu bar (dark or light) like its own icons.
    @MainActor static let mark: NSImage = {
        let r = ImageRenderer(content: BoostLogo(tint: .black).frame(width: 16, height: 16).padding(1))
        r.scale = 2
        let img = r.nsImage ?? NSImage(systemSymbolName: "paperplane.fill", accessibilityDescription: nil)!
        img.size = NSSize(width: 18, height: 18)
        img.isTemplate = true
        return img
    }()
    @Environment(\.openWindow) private var openWindow
    var body: some View {
        let busy = (store.teams.flatMap(\.members) + store.loose).filter { $0.state == .busy }.count
        HStack(spacing: 2) {
            Image(nsImage: Self.mark)
            if busy > 0 { Text("\(busy)") }
        }
        .onAppear { AppDelegate.openMainWindow = { openWindow(id: "main") } }
    }
}

/// Slim, scrollable alert log under the banner (newest first). Shown while alerts are on.
struct AlertStrip: View {
    @EnvironmentObject var store: BoardStore
    var body: some View {
        if !store.noticeLog.isEmpty { strip }
    }
    private var strip: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "bell.fill").foregroundStyle(Theme.accent).padding(.top, 3)
            ScrollView {
                VStack(alignment: .leading, spacing: 3) {
                                        ForEach(Array(store.noticeLog.enumerated()), id: \.element.id) { i, n in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(Fmt.time(n.at)).font(.caption.monospacedDigit()).foregroundStyle(.tertiary)
                            Text(n.text).font(i == 0 ? .callout : .caption).foregroundStyle(i == 0 ? .primary : .secondary)
                                .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(height: store.noticeLog.count > 1 ? 44 : 22)
            .animation(.easeOut(duration: 0.2), value: store.noticeLog.count > 1)
            Button(L("지우기")) { store.noticeLog.removeAll(); store.notice = nil }.buttonStyle(.raisedCompact).help(L("알림 기록 지우기"))
        }
        .padding(.horizontal, 14).padding(.vertical, 6)
        .areaBox()
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.line).frame(height: 1) }
    }
}

/// The window's red ✕ (and ⌘W) asks: go to background, or switch every session off and quit.
struct CloseInterceptor: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView { Hook() }
    func updateNSView(_ v: NSView, context: Context) {}
    final class Hook: NSView {
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            guard let b = window?.standardWindowButton(.closeButton) else { return }
            b.target = self; b.action = #selector(askClose)
        }
        @objc func askClose() {
            let live = BoardStore.shared?.controllableLive.count ?? 0
            let a = NSAlert()
            a.messageText = L("창을 닫을까요?")
            a.informativeText = L("백그라운드: 창만 숨기고 앱·세션은 계속 돕니다 (메뉴 막대 아이콘으로 다시 열기).\n앱만 종료: 세션 %@개는 그대로 두고 앱만 끕니다.\n세션까지 종료: 세션 %@개를 모두 끄고(/exit) 앱을 끕니다. 다음 실행 때 다시 시작합니다.", String(live), String(live))
            a.addButton(withTitle: L("백그라운드로"))
            a.addButton(withTitle: L("앱만 종료"))
            a.addButton(withTitle: L("세션까지 종료"))
            a.addButton(withTitle: L("취소"))
            let go: (NSApplication.ModalResponse) -> Void = { r in
                switch r {
                case .alertFirstButtonReturn: AppDelegate.goBackground()
                case .alertSecondButtonReturn: AppDelegate.quit(stopSessions: false)
                case .alertThirdButtonReturn: AppDelegate.quit(stopSessions: true)
                default: break
                }
            }
            if let w = window { a.beginSheetModal(for: w, completionHandler: go) } else { go(a.runModal()) }
        }
    }
}
