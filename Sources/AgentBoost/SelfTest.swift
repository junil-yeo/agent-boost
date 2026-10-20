import AppKit
import SwiftUI

/// `--snapshot DIR` saves the window as PNGs without needing screen access.
/// `--selftest` additionally renames and deletes members of the fixture team
/// `zz-boardtest` and writes report.json. Never touches any other team.
@MainActor
enum SelfTest {
    static func runIfRequested(store: BoardStore, setTab: @escaping (String) -> Void) {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "--snapshot"), i + 1 < args.count else { return }
        let dir = URL(fileURLWithPath: args[i + 1])
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let selftest = args.contains("--selftest")
        Task { @MainActor in
            var report: [String: Any] = [:]
            func shot(_ name: String) async {
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                guard let w = NSApp.windows.first(where: { $0.isVisible }), let v = w.contentView,
                      let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) else { report["shot_\(name)"] = "no window"; return }
                v.cacheDisplay(in: v.bounds, to: rep)
                try? rep.representation(using: .png, properties: [:])?.write(to: dir.appendingPathComponent("\(name).png"))
                report["shot_\(name)"] = "ok"
            }
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            if let w = NSApp.windows.first { w.setContentSize(NSSize(width: 1400, height: 900)) }
            setTab("home"); await shot("1-home")
            if let t = store.launchTab, store.selectedAgent != nil { setTab(t); await shot("0-selected") }
            if args.contains("--bench-tabs") {
                // switch tabs / agents like a user clicking, timing each switch until the window has redrawn
                guard let w = NSApp.windows.first(where: { $0.isVisible }) else { finish(dir, report); return }
                let teams = store.teams.filter { $0.liveCount > 0 }.map(\.name)
                var steps: [(String, () -> Void)] = [("home", { setTab("home") }), ("loose", { setTab("__loose"); store.selectedAgent = store.loose.first?.sessionId })]
                for t in teams { steps.append(("team:" + t, { setTab(t); store.selectedTeam = t; store.selectedAgent = store.teams.first { $0.name == t }?.members.first?.sessionId })) }
                for a in store.loose.prefix(3) { steps.append(("agent:" + a.name, { setTab("__loose"); store.selectedAgent = a.sessionId })) }
                var out: [String] = []
                var per: [String: [Int]] = [:]
                for round in 0..<6 {
                    for (name, act) in steps {
                        let t0 = CFAbsoluteTimeGetCurrent()
                        act(); await Task.yield(); w.contentView?.layoutSubtreeIfNeeded(); w.displayIfNeeded()
                        let ms = Int((CFAbsoluteTimeGetCurrent() - t0) * 1000); out.append("r\(round) \(name)=\(ms)ms"); if round > 0 { per[name, default: []].append(ms) }
                        try? await Task.sleep(nanoseconds: 400_000_000)
                    }
                }
                print("MEDIAN", per.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value.sorted()[$0.value.count / 2])ms" }.joined(separator: " "))
                print("TABS", out.joined(separator: " | ")); report["tabs"] = out; finish(dir, report); return
            }
            if args.contains("--bench-typing") { report["bench"] = await benchTyping(store); finish(dir, report); return }
            if selftest {
                let team = "zz-boardtest"
                guard let t = store.teams.first(where: { $0.name == team }) else { report["error"] = "fixture team missing"; finish(dir, report); return }
                report["fixture_members"] = t.members.map { "\($0.name)|\($0.state.rawValue)|\($0.displayModel)|out=\($0.tokens.output)" }
                // rename an ended member -> must be written to its transcript as custom-title
                if let worker = t.workers.first {
                    store.rename(worker, to: "픽스처-새이름")
                    store.refresh()
                    let tail = (try? String(contentsOfFile: worker.transcriptPath ?? "", encoding: .utf8))?.split(separator: "\n").last.map(String.init) ?? ""
                    report["rename_transcript_tail"] = tail
                    report["rename_visible_name"] = store.agent(worker.sessionId)?.name ?? "missing"
                    report["rename_title_file"] = BoardStore.storedTitle(forTranscript: worker.transcriptPath ?? "") ?? "missing"
                    store.selectedTeam = team; store.selectedAgent = worker.sessionId
                    setTab(team); await shot("2-team-detail")
                    // delete it -> transcript to Trash, card gone
                    let path = worker.transcriptPath ?? ""
                    store.delete(store.agent(worker.sessionId) ?? worker)
                    report["delete_file_still_exists"] = FileManager.default.fileExists(atPath: path)
                    report["delete_card_still_listed"] = store.agent(worker.sessionId) != nil
                    report["delete_notice"] = store.notice ?? ""
                    setTab(team); await shot("3-after-delete")
                }
                // ---- live session: create -> /model -> /effort -> delete (idle, no prompt => no tokens)
                if ProcessInfo.processInfo.arguments.contains("--selftest-live") {
                    let name = "zz-boardtest-live"
                    let tmuxName = store.createSession(name: name, cwd: ProcessInfo.processInfo.environment["BOARD_TEST_CWD"] ?? "/tmp", model: .haiku, effort: .low, teammates: [], task: "")
                    report["live_tmux"] = tmuxName ?? "failed: \(store.notice ?? "")"
                    var live: Agent?
                    for _ in 0..<60 {
                        try? await Task.sleep(nanoseconds: 1_000_000_000); store.refresh()
                        let panePid = Int(Shell.tmux(["list-panes", "-t", tmuxName ?? "-", "-F", "#{pane_pid}"]).out.split(separator: "\n").first ?? "")
                        let all = store.teams.flatMap(\.members) + store.loose
                        if let a = all.first(where: { $0.pid == panePid && $0.state == .idle }) { live = a; break }
                    }
                    report["live_seen_sessions"] = (store.teams.flatMap(\.members) + store.loose).filter { $0.state != .ended }
                        .map { "\($0.name)|\($0.state.rawValue)|pid=\($0.pid ?? 0)|team=\($0.teamName ?? "-")|pane=\($0.tmuxPane ?? "-")" }
                    let settingsBefore = try? String(contentsOfFile: Shell.home + "/.claude/settings.json", encoding: .utf8)
                    report["live_launch_phase"] = store.launches.first.map { "\($0.phase)" } ?? "registered"
                    report["live_found"] = live.map { "\($0.name)|\($0.state.rawValue)|pane=\($0.tmuxPane ?? "-")|effortArg=\($0.effort ?? "-")" } ?? "not found"
                    if let a = live, let pane = a.tmuxPane {
                        report["live_origin"] = a.origin ?? "nil"
                        store.setModel(.sonnet, for: a)
                        try? await Task.sleep(nanoseconds: 4_000_000_000)
                        store.setEffort(.high, for: a)
                        try? await Task.sleep(nanoseconds: 9_000_000_000)   // let the default-restore pass run
                        let settingsAfter = try? String(contentsOfFile: Shell.home + "/.claude/settings.json", encoding: .utf8)
                        report["live_defaults_preserved"] = settingsBefore == settingsAfter
                        report["live_status_model"] = { () -> String in
                            TmuxControl.command("/status", to: pane); usleep(3_000_000)
                            let s = Shell.tmux(["capture-pane", "-p", "-t", pane]).out
                            Shell.tmux(["send-keys", "-t", pane, "Escape"])
                            return s.split(separator: "\n").first { $0.contains("Model:") }.map(String.init) ?? "?"
                        }()
                        let screen = Shell.tmux(["capture-pane", "-p", "-t", pane, "-S", "-40"]).out
                        report["live_screen_mentions"] = ["sonnet", "Sonnet", "high"].filter { screen.contains($0) }
                        report["live_screen_tail"] = screen.split(separator: "\n").suffix(12).joined(separator: "\n")
                        store.selectedAgent = a.sessionId; setTab("__loose"); await shot("4-live-session")
                        store.delete(store.agent(a.sessionId) ?? a)
                        try? await Task.sleep(nanoseconds: 1_500_000_000); store.refresh()
                        report["live_after_delete_running"] = kill(pid_t(a.pid ?? 0), 0) == 0
                        report["live_after_delete_listed"] = store.agent(a.sessionId) != nil
                        // a second standalone session: quit (not delete) -> must remain as an ended, resumable card
                        if let t2 = store.createSession(name: "zz-standalone", cwd: ProcessInfo.processInfo.environment["BOARD_TEST_CWD"] ?? "/tmp", model: .haiku, effort: .low, teammates: [], task: "") {
                            var s2: Agent?
                            for _ in 0..<60 {
                                try? await Task.sleep(nanoseconds: 1_000_000_000); store.refresh()
                                let pp = Int(Shell.tmux(["list-panes", "-t", t2, "-F", "#{pane_pid}"]).out.split(separator: "\n").first ?? "")
                                s2 = (store.teams.flatMap(\.members) + store.loose).first { $0.pid == pp && $0.state == .idle }; if s2 != nil { break }
                            }
                            report["standalone_found"] = s2.map { "\($0.name)|solo=\($0.solo)|inLoose=\(store.loose.contains { $0.sessionId == s2!.sessionId })" } ?? "missing"
                            do {
                            }
                            if let s2 {
                                // give it a transcript (one tiny Haiku reply), quit, rename while ended, resume: name must survive
                                store.send("Reply with exactly: ok", to: s2)
                                for _ in 0..<40 { try? await Task.sleep(nanoseconds: 1_000_000_000); store.refresh(); if store.agent(s2.sessionId)?.state == .idle, (store.agent(s2.sessionId)?.tokens.output ?? 0) > 0 { break } }
                                store.quit(store.agent(s2.sessionId) ?? s2)
                                for _ in 0..<25 { try? await Task.sleep(nanoseconds: 1_000_000_000); store.refresh(); if store.agent(s2.sessionId)?.state == .ended { break } }
                                if let e = store.agent(s2.sessionId), e.state == .ended {
                                    store.rename(e, to: "종료후-새이름"); store.refresh()
                                    report["ended_rename_title_file"] = BoardStore.storedTitle(forTranscript: e.transcriptPath ?? "") ?? "missing"
                                    report["ended_rename_visible"] = store.agent(e.sessionId)?.name ?? "missing"
                                    if let e2 = store.agent(e.sessionId), store.canResume(e2) {
                                        let rt = store.resume(e2, model: .haiku, effort: .low)
                                        var back: Agent?
                                        for _ in 0..<60 {
                                            try? await Task.sleep(nanoseconds: 1_000_000_000); store.refresh()
                                            let pp = Int(Shell.tmux(["list-panes", "-t", rt ?? "-", "-F", "#{pane_pid}"]).out.split(separator: "\n").first ?? "")
                                            back = (store.teams.flatMap(\.members) + store.loose).first { $0.pid == pp && $0.state != .ended }; if back != nil { break }
                                        }
                                        report["ended_rename_after_resume"] = back.map { "\($0.name)|\($0.state.rawValue)" } ?? "not running"
                                        if let b = back { store.delete(b); try? await Task.sleep(nanoseconds: 5_000_000_000) }
                                        if let rt { Shell.tmux(["kill-session", "-t", rt]) }
                                    }
                                } else { report["ended_rename_after_resume"] = "quit did not end: \(store.agent(s2.sessionId)?.state.rawValue ?? "gone")" }
                                Shell.tmux(["kill-session", "-t", t2])
                            }
                            if false, let s2 {
                                store.quit(s2)
                                for _ in 0..<25 { try? await Task.sleep(nanoseconds: 1_000_000_000); store.refresh(); if store.agent(s2.sessionId)?.state == .ended { break } }
                                let ended = store.agent(s2.sessionId)
                                report["standalone_after_quit"] = ended.map { "\($0.name)|\($0.state.rawValue)|resumable=\(store.canResume($0))|origin=\($0.origin ?? "nil")" } ?? "missing"
                                if let e = ended, store.canResume(e) {
                                    let rt = store.resume(e, model: .haiku, effort: .low)
                                    var back: Agent?
                                    for _ in 0..<60 {
                                        try? await Task.sleep(nanoseconds: 1_000_000_000); store.refresh()
                                        let pp = Int(Shell.tmux(["list-panes", "-t", rt ?? "-", "-F", "#{pane_pid}"]).out.split(separator: "\n").first ?? "")
                                        back = (store.teams.flatMap(\.members) + store.loose).first { $0.pid == pp && $0.state != .ended }; if back != nil { break }
                                    }
                                    report["standalone_resume"] = back.map { "\($0.name)|\($0.state.rawValue)|sameSid=\($0.sessionId == e.sessionId)" } ?? "not running"
                                    if let b = back { store.delete(b); try? await Task.sleep(nanoseconds: 5_000_000_000) }
                                    if let rt { Shell.tmux(["kill-session", "-t", rt]) }
                                } else if let e = ended { store.delete(e) }
                            }
                            Shell.tmux(["kill-session", "-t", t2])
                        }
                    }
                    if let t = tmuxName { Shell.tmux(["kill-session", "-t", t]) }
                }
            }
            if ProcessInfo.processInfo.arguments.contains("--selftest-archive") {
                let sid = "00000000-a7c1-4e57-8000-0000000000cc"
                store.refresh()
                guard let a = (store.teams.flatMap(\.members) + store.loose).first(where: { $0.sessionId == sid }) else {
                    report["archive_error"] = "fixture not visible"; finish(dir, report); return
                }
                let path = a.transcriptPath ?? ""
                store.archive(a, withTeammates: false)
                report["archive_hidden"] = store.agent(sid) == nil
                report["archive_listed"] = store.archive[sid] != nil
                report["archive_file_kept"] = FileManager.default.fileExists(atPath: path)
                setTab("__archive"); await shot("7-archive")
                store.restore([sid])
                report["restore_visible"] = store.agent(sid) != nil
                if let b = store.agent(sid) { store.archive(b, withTeammates: false) }
                store.purge([sid])
                report["purge_file_gone"] = !FileManager.default.fileExists(atPath: path)
                report["purge_unlisted"] = store.archive[sid] == nil && store.agent(sid) == nil
            }
            if ProcessInfo.processInfo.arguments.contains("--selftest-team") {
                var log: [String] = []
                func note(_ s: String) { log.append("\(Int(Date().timeIntervalSince1970) % 100000): \(s)") }
                let cwd = ProcessInfo.processInfo.environment["BOARD_TEST_CWD"] ?? "/tmp"
                let mate = TeammateSpec(name: "helper", role: "테스트용 팀원. 아무 작업도 하지 말고 대기", model: .haiku, effort: .low)
                let tmuxName = store.createSession(name: "zz-teamtest", cwd: cwd, model: .sonnet, effort: .low, teammates: [mate], task: "")
                note("created tmux=\(tmuxName ?? "nil")")
                func panes() -> [String] { Shell.tmux(["list-panes", "-s", "-t", tmuxName ?? "-", "-F", "#{pane_id}"]).out.split(separator: "\n").map(String.init) }
                var lead: Agent?, helper: Agent?
                for i in 0..<240 {                       // up to 4 min for the lead to spawn the teammate
                    try? await Task.sleep(nanoseconds: 1_000_000_000); store.refresh()
                    let ps = panes()
                    let all = store.teams.flatMap(\.members) + store.loose
                    lead = lead ?? all.first { $0.name == "zz-teamtest" && $0.state != .ended }
                    if let l = lead, let t = l.teamName {
                        helper = store.teams.first { $0.name == t }?.workers.first { $0.state != .ended }
                    }
                    if i % 15 == 0 { note("t=\(i)s panes=\(ps.count) lead=\(lead.map { "\($0.state.rawValue)/\($0.teamName ?? "-")" } ?? "-") helper=\(helper?.name ?? "-")") }
                    if helper != nil && ps.count >= 2 { break }
                }
                report["team_panes"] = panes().count
                lead = lead.flatMap { store.agent($0.sessionId) } ?? lead
                report["team_lead"] = lead.map { "\($0.name)|\($0.state.rawValue)|team=\($0.teamName ?? "-")|\($0.displayModel)" } ?? "missing"
                report["team_helper"] = helper.map { "\($0.name)|\($0.state.rawValue)|addr=\($0.teamAddress ?? "-")|pane=\($0.tmuxPane ?? "-")|\($0.displayModel)|effort=\($0.effort ?? "-")" } ?? "missing"
                if let l = lead, let t = l.teamName { store.selectedTeam = t; store.selectedAgent = (helper ?? l).sessionId; setTab(t); await shot("5-team") }
                report["spawn_check"] = store.spawnChecks.first.map { c in c.specs.map { "\($0.name)=\(String(describing: c.results[$0.name] ?? .waiting))" } } ?? []
                if let h = helper, let l = lead {
                    // 1) quit the LEAD first while the teammate is alive
                    store.quit(store.agent(l.sessionId) ?? l)
                    var leadSecs = 0
                    for i in 0..<30 { try? await Task.sleep(nanoseconds: 1_000_000_000); if kill(pid_t(l.pid ?? 0), 0) != 0 { leadSecs = i; break } }
                    report["lead_quit_seconds"] = leadSecs
                    try? await Task.sleep(nanoseconds: 3_000_000_000); store.refresh()
                    report["lead_quit_ended"] = kill(pid_t(l.pid ?? 0), 0) != 0
                    report["helper_alive_after_lead_quit"] = kill(pid_t(h.pid ?? 0), 0) == 0
                    report["panes_after_lead_quit"] = panes().count
                    // 2) quit the teammate if it survived
                    if let hh = store.agent(h.sessionId), hh.state != .ended {
                        store.quit(hh)
                        for _ in 0..<20 { try? await Task.sleep(nanoseconds: 1_000_000_000); if kill(pid_t(hh.pid ?? 0), 0) != 0 { break } }
                    }
                    store.refresh()
                    report["team_helper_after"] = store.agent(h.sessionId).map { "\($0.name)|\($0.state.rawValue)|tokens.out=\($0.tokens.output)|transcript=\($0.transcriptPath != nil)" } ?? "gone"
                    if let t = l.teamName { setTab(t); await shot("6-after-quit") }
                    // 3) resume the ended teammate (standalone, no prompt -> no tokens)
                    if let ended = store.agent(h.sessionId), store.canResume(ended) {
                        let rt = store.resume(ended, model: .haiku, effort: .low)
                        note("resume tmux=\(rt ?? "nil") notice=\(store.notice ?? "")")
                        var back: Agent?
                        for _ in 0..<60 {
                            try? await Task.sleep(nanoseconds: 1_000_000_000); store.refresh()
                            let pp = Int(Shell.tmux(["list-panes", "-t", rt ?? "-", "-F", "#{pane_pid}"]).out.split(separator: "\n").first ?? "")
                            back = (store.teams.flatMap(\.members) + store.loose).first { $0.pid == pp && $0.state != .ended }
                            if back != nil { break }
                        }
                        report["resume_result"] = back.map { "\($0.name)|\($0.state.rawValue)|\($0.displayModel)|raw=\($0.model ?? "nil")|effort=\($0.effort ?? "nil")|sid=\($0.sessionId)" } ?? "not running"
                        if let b = back { store.quit(b); try? await Task.sleep(nanoseconds: 4_000_000_000) }
                        if let rt { Shell.tmux(["kill-session", "-t", rt]) }
                    } else { report["resume_result"] = "canResume=false" }
                }
                store.refresh()
                for a in (store.teams.flatMap(\.members) + store.loose) where a.name == "zz-teamtest" || a.name == "helper" { store.delete(a) }
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                if let t = tmuxName { Shell.tmux(["kill-session", "-t", t]) }
                report["team_log"] = log
            }
            // ---- `--selftest-sync`: the board as a faithful mirror of the CLI while both are used at once.
            // A session started from a plain terminal (not the board) must appear; the CLI's "← agents" screen (which moves
            // the conversation into a background job) must yield ONE card that refuses typing; Esc releases held commands;
            // quit ends the job the CLI's way; resume of a job conversation goes through --bg --resume + attach; delete
            // clears the CLI's own list. Haiku, one-word prompt: tokens near zero.
            if ProcessInfo.processInfo.arguments.contains("--selftest-sync") {
                let cwd = ProcessInfo.processInfo.environment["BOARD_TEST_CWD"] ?? "/tmp"
                @MainActor func all() -> [Agent] { store.teams.flatMap(\.members) + store.loose }
                @MainActor func wait(_ secs: Int, _ cond: () -> Bool) async -> Bool {
                    for _ in 0..<secs { try? await Task.sleep(nanoseconds: 1_000_000_000); store.refresh(); if cond() { return true } }
                    return false
                }
                @MainActor func dump() -> String { all().map { "\($0.name)|\($0.sessionId.prefix(8))|job=\($0.jobId ?? "-")|pane=\($0.tmuxPane ?? "-")|ov=\($0.overlay ?? "-")|st=\($0.state.rawValue)|pid=\($0.pid ?? 0)" }.joined(separator: " ;; ") }
                let t1 = "zz-sync-" + String(Int(Date().timeIntervalSince1970) % 100000)
                Shell.tmux(["new-session", "-d", "-s", t1, "-x", "200", "-y", "50", "-c", cwd, "-e", "PATH=\(Shell.path)", "\(Shell.claude) --model haiku --effort low -n zz-sync-cli"])
                let pid1 = Int(Shell.tmux(["list-panes", "-t", t1, "-F", "#{pane_pid}"]).out.split(separator: "\n").first ?? "")
                var a1: Agent?
                report["1_cli_session_seen"] = await wait(60) { a1 = all().first { $0.pid == pid1 && $0.state == .idle }; return a1 != nil }
                if let a1, let pane = a1.tmuxPane {
                    let sid1 = a1.sessionId
                    report["1_cli_session_origin"] = a1.origin ?? "nil"
                    store.send("Reply with exactly: ok", to: a1)
                    report["1_transcript_written"] = await wait(60) { (store.agent(sid1)?.tokens.output ?? 0) > 0 && store.agent(sid1)?.state == .idle }
                    // 2. the person opens the CLI's agents screen in that very pane
                    Shell.tmux(["send-keys", "-t", pane, "Left"])
                    var merged: Agent?
                    report["2_parked_one_card"] = await wait(25) {
                        let cards = all().filter { $0.tmuxPane == pane || $0.sessionId == sid1 }
                        merged = cards.first { $0.isBackgroundJob && $0.tmuxPane == pane && $0.overlay == "agents" }
                        return merged != nil && cards.count == 1
                    }
                    report["2_cards"] = dump()
                    if let m = merged {
                        report["2_parked_card"] = "\(m.name)|job=\(m.jobId ?? "-")|sid=\(m.sessionId.prefix(8))|overlay=\(m.overlay ?? "-")|canInput=\(m.canReceiveInput)|named=\(m.name == "zz-sync-cli")"
                        report["2_send_refused_on_overlay"] = !store.send("this must not be sent", to: m)
                        report["2_refuse_notice"] = store.notice ?? ""
                        store.setModel(.sonnet, for: m)                          // must be held, never typed into the list's box
                        try? await Task.sleep(nanoseconds: 4_000_000_000); store.refresh()
                        let scr = Shell.tmux(["capture-pane", "-p", "-t", pane]).out
                        report["2_overlay_box_untouched"] = !scr.contains("/model") && scr.contains("describe a task for a new session")
                        report["2_held_command"] = store.agent(m.sessionId)?.pendingCommands ?? []
                        await shot("8-parked")
                        // 3. Esc returns to the conversation: the held command goes out now
                        Shell.tmux(["send-keys", "-t", pane, "Escape"])
                        report["3_overlay_cleared"] = await wait(15) { store.agent(m.sessionId)?.overlay == nil }
                        report["3_held_command_sent"] = await wait(25) {
                            (store.agent(m.sessionId)?.pendingCommands ?? []).isEmpty && Shell.tmux(["capture-pane", "-p", "-t", pane, "-S", "-30"]).out.contains("Set model to")
                        }
                        // the resume guard: a running conversation is never started a second time
                        if var ended = store.agent(m.sessionId) {
                            ended.state = .ended; ended.pid = nil
                            report["3_resume_guard_nil"] = store.resume(ended, model: .haiku, effort: .low) == nil
                            report["3_resume_guard_notice"] = store.notice ?? ""
                            report["3_cards_after_guard"] = dump()
                        }
                        // 4. quit: the viewer is closed (ctrl+c twice) and the job stopped (claude stop); the CLI's list is clean
                        if let m2 = store.agent(m.sessionId) {
                            let jobPid = m2.pid ?? 0, jobId = m2.jobId ?? "-"
                            store.quit(m2, mode: .now)
                            report["4_quit_processes_gone"] = await wait(45) { kill(pid_t(jobPid), 0) != 0 && kill(pid_t(pid1 ?? 0), 0) != 0 }
                            report["4_cli_agents_clean"] = !Shell.run([Shell.claude, "agents", "--json"], timeout: 30).out.contains(jobId)
                            report["4_ended_card_kept"] = await wait(15) { store.agent(m.sessionId).map { $0.state == .ended && $0.transcriptPath != nil } ?? false }
                            report["4_ended_card"] = store.agent(m.sessionId).map { "\($0.name)|job=\($0.jobId ?? "-")|bg=\($0.isBackgroundJob)" } ?? "missing: " + dump()
                            // 5. resume: a job conversation reopens the CLI's way (--bg --resume, then attach) under the same id
                            if let e = store.agent(m.sessionId) {
                                report["5_resume_path"] = store.resume(e, model: .haiku, effort: .low) ?? "nil"
                                var back: Agent?
                                report["5_resumed_live_with_pane"] = await wait(60) { back = store.agent(m.sessionId); return back?.state != .ended && back?.tmuxPane != nil && back?.overlay == nil }
                                report["5_resumed_card"] = back.map { "\($0.name)|job=\($0.jobId ?? "-")|pane=\($0.tmuxPane ?? "-")|st=\($0.state.rawValue)|viewer=\($0.viewerPid ?? 0)|canInput=\($0.canReceiveInput)" } ?? "missing: " + dump()
                                try? await Task.sleep(nanoseconds: 3_000_000_000); store.refresh()
                                report["5_launch_cards_left"] = store.launches.count
                                report["5_notice"] = store.notice ?? ""
                                await shot("9-attached")
                                if let b = back, b.state != .ended {
                                    store.delete(b)                                  // stop + rm + transcript to the Trash
                                    report["6_deleted_gone"] = await wait(45) { store.agent(m.sessionId) == nil && !Shell.run([Shell.claude, "agents", "--json", "--all"], timeout: 30).out.contains(b.jobId ?? "zzzz") }
                                    report["6_after_delete"] = dump()
                                }
                            }
                        }
                    }
                }
                Shell.tmux(["kill-session", "-t", t1])
                for t in Shell.tmux(["list-sessions", "-F", "#{session_name}"]).out.split(separator: "\n") where t.hasPrefix("ab-zz-sync") { Shell.tmux(["kill-session", "-t", String(t)]) }
            }
            // ---- `--selftest-plain`: the ordinary path with no board memory at all — a board-started session, /exit, an
            // ended card that comes from the transcript alone (named like the CLI's picker), plain --resume under the same
            // id, delete. Haiku, one-word prompt.
            if ProcessInfo.processInfo.arguments.contains("--selftest-plain") {
                let cwd = ProcessInfo.processInfo.environment["BOARD_TEST_CWD"] ?? "/tmp"
                @MainActor func all() -> [Agent] { store.teams.flatMap(\.members) + store.loose }
                @MainActor func wait(_ secs: Int, _ cond: () -> Bool) async -> Bool {
                    for _ in 0..<secs { try? await Task.sleep(nanoseconds: 1_000_000_000); store.refresh(); if cond() { return true } }
                    return false
                }
                @MainActor func dump() -> String { all().map { "\($0.name)|\($0.sessionId.prefix(8))|job=\($0.jobId ?? "-")|pane=\($0.tmuxPane ?? "-")|st=\($0.state.rawValue)|tp=\($0.transcriptPath != nil)" }.joined(separator: " ;; ") }
                let tmuxName = store.createSession(name: "zz-plain", cwd: cwd, model: .haiku, effort: .low, teammates: [], task: "")
                report["p1_created"] = tmuxName ?? "nil: \(store.notice ?? "")"
                var a: Agent?
                report["p1_live"] = await wait(60) {
                    let pp = Int(Shell.tmux(["list-panes", "-t", tmuxName ?? "-", "-F", "#{pane_pid}"]).out.split(separator: "\n").first ?? "")
                    a = all().first { $0.pid == pp && $0.state == .idle }; return a != nil
                }
                if let a {
                    let sid = a.sessionId
                    report["p1_launch_cards_left"] = store.launches.count
                    store.send("Reply with exactly: ok", to: a)
                    report["p2_answered"] = await wait(60) { (store.agent(sid)?.tokens.output ?? 0) > 0 && store.agent(sid)?.state == .idle }
                    store.quit(store.agent(sid) ?? a, mode: .now)
                    report["p3_ended_from_transcript"] = await wait(40) { store.agent(sid).map { $0.state == .ended && $0.transcriptPath != nil } ?? false }
                    report["p3_ended_card"] = store.agent(sid).map { "\($0.name)|cwd=\($0.cwd ?? store.workingDirectory(of: $0) ?? "-")" } ?? "missing: " + dump()
                    report["p3_tmux_gone"] = await wait(10) { Shell.tmux(["has-session", "-t", tmuxName ?? "-"]).code != 0 }
                    if let e = store.agent(sid) {
                        let rt = store.resume(e, model: .haiku, effort: .low)
                        report["p4_resume_tmux"] = rt ?? "nil: \(store.notice ?? "")"
                        var back: Agent?
                        report["p4_live_same_id"] = await wait(60) { back = store.agent(sid); return back?.state == .idle && back?.tmuxPane != nil }
                        report["p4_card"] = back.map { "\($0.name)|pane=\($0.tmuxPane ?? "-")|st=\($0.state.rawValue)|origin=\($0.origin ?? "-")" } ?? "missing: " + dump()
                        try? await Task.sleep(nanoseconds: 2_000_000_000); store.refresh()
                        report["p4_launch_cards_left"] = store.launches.count
                        if let b = back {
                            store.delete(b)
                            report["p5_deleted"] = await wait(40) { store.agent(sid) == nil }
                            report["p5_after"] = dump()
                        }
                    }
                }
                for t in Shell.tmux(["list-sessions", "-F", "#{session_name}"]).out.split(separator: "\n") where t.hasPrefix("ab-zz-plain") { Shell.tmux(["kill-session", "-t", String(t)]) }
            }
            finish(dir, report)
        }
    }
    /// `--bench-typing`: types into the composer with synthetic key events and times each keystroke until the window
    /// has redrawn (what a user feels as input lag). Runs inside the app, so no accessibility permission is needed.
    static func benchTyping(_ store: BoardStore) async -> [String: Any] {
        guard let w = NSApp.windows.first(where: { $0.isVisible }), let root = w.contentView else { return ["error": "no window"] }
        func find(_ v: NSView) -> NSView? {
            if let t = v as? NSTextView, t.isEditable { return t }
            if let t = v as? NSTextField, t.isEditable { return t }
            for s in v.subviews { if let f = find(s) { return f } }
            return nil
        }
        guard let field = find(root) else { return ["error": "no text field"] }
        w.makeKeyAndOrderFront(nil); w.makeFirstResponder(field)
        try? await Task.sleep(nanoseconds: 500_000_000)
        func key(_ c: String, code: UInt16) -> NSEvent? {
            NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                             windowNumber: w.windowNumber, context: nil, characters: c, charactersIgnoringModifiers: c, isARepeat: false, keyCode: code)
        }
        // warm-up round: type and erase once, so one-time costs (text system, first layout) are not counted below
        var warm: [Int] = []
        for ch in Array("warm") {
            let t0 = CFAbsoluteTimeGetCurrent()
            if let e = key(String(ch), code: 0) { NSApp.sendEvent(e) }
            await Task.yield(); RunLoop.main.run(mode: .default, before: Date()); w.contentView?.layoutSubtreeIfNeeded(); w.displayIfNeeded()
            warm.append(Int((CFAbsoluteTimeGetCurrent() - t0) * 1000))
        }
        for _ in 0..<4 { if let e = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: w.windowNumber, context: nil, characters: "\u{7f}", charactersIgnoringModifiers: "\u{7f}", isARepeat: false, keyCode: 51) { NSApp.sendEvent(e) } }
        await Task.yield(); RunLoop.main.run(mode: .default, before: Date()); w.displayIfNeeded()
        try? await Task.sleep(nanoseconds: 2_500_000_000)
        var times: [Double] = [], cpu: [Double] = []
        func cpuNow() -> Double { var u = rusage(); getrusage(RUSAGE_SELF, &u); return Double(u.ru_utime.tv_sec + u.ru_stime.tv_sec) * 1000 + Double(u.ru_utime.tv_usec + u.ru_stime.tv_usec) / 1000 }
        let text = Array(String(repeating: ProcessInfo.processInfo.environment["BENCH_TEXT"] ?? "please check the build output and fix the warnings ", count: ProcessInfo.processInfo.arguments.contains("--bench-long") ? 4 : 1))
        let toggle = ProcessInfo.processInfo.environment["BENCH_TOGGLE"] != nil   // "a", Backspace, "a" …: the grey suggestion comes and goes
        for (n, ch) in text.enumerated() {
            let t0 = CFAbsoluteTimeGetCurrent(), c0 = cpuNow()
            if toggle { if let e = n % 2 == 0 ? key("a", code: 0) : key("\u{7f}", code: 51) { NSApp.sendEvent(e) } }
            else if let e = key(String(ch), code: ch == " " ? 49 : 0) { NSApp.sendEvent(e) }
            await Task.yield()
            // let SwiftUI run its update for this keystroke, then lay out and draw like a real frame
            RunLoop.main.run(mode: .default, before: Date())
            w.contentView?.layoutSubtreeIfNeeded(); w.displayIfNeeded()
            times.append((CFAbsoluteTimeGetCurrent() - t0) * 1000); cpu.append(cpuNow() - c0)
        }
        let typed = (field as? NSTextView)?.string ?? (field as? NSTextField)?.stringValue ?? ""
        // erase what was typed (Backspace), so the draft is left as it was
        for _ in text { if let e = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: w.windowNumber, context: nil, characters: "\u{7f}", charactersIgnoringModifiers: "\u{7f}", isARepeat: false, keyCode: 51) { NSApp.sendEvent(e) } }
        // one board refresh (the 2 s tick) plus the redraw it causes: how long typing freezes when it lands
        var refresh: [Int] = []
        for _ in 0..<5 {
            let t0 = CFAbsoluteTimeGetCurrent()
            store.refresh(); await Task.yield(); RunLoop.main.run(mode: .default, before: Date())
            w.contentView?.layoutSubtreeIfNeeded(); w.displayIfNeeded()
            refresh.append(Int((CFAbsoluteTimeGetCurrent() - t0) * 1000))
            try? await Task.sleep(nanoseconds: 300_000_000)
        }
        let sorted = times.sorted()
        func pct(_ p: Double) -> Double { sorted.isEmpty ? 0 : sorted[min(sorted.count - 1, Int(Double(sorted.count) * p))] }
        let r: [String: Any] = ["keys": times.count, "typed_ok": typed.hasPrefix("please check"), "avg_ms": times.reduce(0, +) / Double(max(1, times.count)),
                                "p50_ms": pct(0.5), "p90_ms": pct(0.9), "max_ms": sorted.last ?? 0,
                                "refresh_ms": refresh, "cpu_p50_ms": cpu.sorted()[cpu.count / 2], "cpu_avg_ms": cpu.reduce(0, +) / Double(max(1, cpu.count)), "warmup_ms": warm, "slow": times.enumerated().filter { $0.element > 40 }.map { "#\($0.offset)=\(Int($0.element))ms" }]
        print("BENCH", r)
        return r
    }

    static func finish(_ dir: URL, _ report: [String: Any]) {
        if let d = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) {
            try? d.write(to: dir.appendingPathComponent("report.json"))
        }
        NSApp.terminate(nil)
    }
}
