import Foundation

enum Shell {
    /// The user's home. BOARD_HOME overrides it (fresh-machine tests). Every other file reads this, never NSHomeDirectory().
    static let home: String = ProcessInfo.processInfo.environment["BOARD_HOME"] ?? FileManager.default.homeDirectoryForCurrentUser.path
    /// PATH of the user's login shell, or a fixed list when the shell does not answer within 5 s. An app started from
    /// Finder only gets /usr/bin:/bin:…, so without this a session's teammate spawner could not find tmux.
    private static let loginPath: String = {
        let fallback = [home + "/.local/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].joined(separator: ":")
        let p = Process(); p.executableURL = URL(fileURLWithPath: "/bin/zsh"); p.arguments = ["-lc", "printf %s \"$PATH\""]
        let o = Pipe(); p.standardOutput = o; p.standardError = Pipe()
        let done = DispatchSemaphore(value: 0)
        p.terminationHandler = { _ in done.signal() }
        guard (try? p.run()) != nil else { return fallback }
        if done.wait(timeout: .now() + 5) == .timedOut { p.terminate(); return fallback }
        let s = String(decoding: o.fileHandleForReading.availableData, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return s.isEmpty ? fallback : s
    }()
    /// A tool's path: the BOARD_* override, then the usual install dirs, then the login shell's PATH. Falls back to the
    /// first candidate (not present) so the start-up check can name the path it looked for.
    private static func find(_ tool: String, env: String, dirs: [String]) -> String {
        if let forced = ProcessInfo.processInfo.environment[env] { return forced }   // an override is final, even when missing (tests)
        let candidates = dirs.map { $0 + "/" + tool } + loginPath.split(separator: ":").map { $0 + "/" + tool }
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) } ?? dirs[0] + "/" + tool
    }
    static let tmux = find("tmux", env: "BOARD_TMUX", dirs: [home + "/.local/bin", "/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"])
    static let gh = find("gh", env: "BOARD_GH", dirs: [home + "/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"])
    static let claude = find("claude", env: "BOARD_CLAUDE", dirs: [home + "/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"])
    /// PATH handed to every child: the login shell's, with tmux's directory in front (teammate spawning needs it).
    static let path: String = {
        let tmuxDir = (tmux as NSString).deletingLastPathComponent
        return loginPath.split(separator: ":").contains(Substring(tmuxDir)) ? loginPath : tmuxDir + ":" + loginPath
    }()

    struct Result { var code: Int32; var out: String; var err: String }

    @discardableResult
    static func run(_ argv: [String], timeout: TimeInterval = 5, cwd: String? = nil) -> Result {
        // posix_spawn + waitpid: Foundation's Process reported child exits late in this app
        // (its notification rides a run loop), which made every short tmux/ps call cost ~1.5 s.
        var env = ProcessInfo.processInfo.environment
        env["LANG"] = "en_US.UTF-8"; env["LC_ALL"] = "en_US.UTF-8"; env["PATH"] = path
        var outPipe: [Int32] = [0, 0], errPipe: [Int32] = [0, 0]
        guard pipe(&outPipe) == 0, pipe(&errPipe) == 0 else { return Result(code: -1, out: "", err: "pipe failed") }
        // Close-on-exec everywhere: otherwise concurrent children (and the long-lived tmux
        // server) inherit each other's pipe ends and a pipe only closes when they exit.
        for fd in outPipe + errPipe { _ = fcntl(fd, F_SETFD, FD_CLOEXEC) }
        var fa: posix_spawn_file_actions_t? = nil
        posix_spawn_file_actions_init(&fa)
        posix_spawn_file_actions_adddup2(&fa, outPipe[1], 1)
        posix_spawn_file_actions_adddup2(&fa, errPipe[1], 2)
        posix_spawn_file_actions_addclose(&fa, outPipe[0]); posix_spawn_file_actions_addclose(&fa, errPipe[0])
        posix_spawn_file_actions_addopen(&fa, 0, "/dev/null", O_RDONLY, 0)
        if let cwd { posix_spawn_file_actions_addchdir_np(&fa, cwd) }
        let cArgs = argv.map { strdup($0) } + [nil]
        let cEnv = env.map { strdup("\($0.key)=\($0.value)") } + [nil]
        defer { cArgs.forEach { free($0) }; cEnv.forEach { free($0) }; posix_spawn_file_actions_destroy(&fa) }
        var attr: posix_spawnattr_t? = nil
        posix_spawnattr_init(&attr)
        posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_CLOEXEC_DEFAULT))   // child gets only fds 0, 1, 2
        defer { posix_spawnattr_destroy(&attr) }
        var pid: pid_t = 0
        let rc = posix_spawn(&pid, argv[0], &fa, &attr, cArgs, cEnv)
        close(outPipe[1]); close(errPipe[1])
        guard rc == 0 else { close(outPipe[0]); close(errPipe[0]); return Result(code: -1, out: "", err: String(cString: strerror(rc))) }
        var out = Data(), err = Data()
        let readers = DispatchGroup()
        func drain(_ fd: Int32, into: @escaping (Data) -> Void) {
            readers.enter()
            DispatchQueue.global(qos: .userInitiated).async {
                let h = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
                into(h.readDataToEndOfFile()); readers.leave()
            }
        }
        drain(outPipe[0]) { out = $0 }; drain(errPipe[0]) { err = $0 }
        // Completion = both pipes reach EOF (the child exited or closed them). Waiting on
        // waitpid alone proved unreliable here: exited children stayed unreported.
        if readers.wait(timeout: .now() + timeout) == .timedOut {
            // timed out: the drain threads may still be writing out/err, so never read them; reap in the background and report failure
            kill(pid, SIGTERM)
            DispatchQueue.global(qos: .background).async { var st: Int32 = 0; waitpid(pid, &st, 0) }
            return Result(code: -1, out: "", err: "timeout")
        }
        var status: Int32 = 0, code: Int32 = -1
        for _ in 0..<50 {                                   // reap; give up after ~50 ms
            let r = waitpid(pid, &status, WNOHANG)
            if r == pid { code = (status & 0x7f) == 0 ? (status >> 8) & 0xff : -1; break }
            if r == -1 { break }
            usleep(1_000)
        }
        if code == -1 { code = err.isEmpty ? 0 : 1; DispatchQueue.global(qos: .background).async { var st: Int32 = 0; waitpid(pid, &st, 0) } }
        return Result(code: code, out: String(decoding: out, as: UTF8.self), err: String(decoding: err, as: UTF8.self))
    }

    static func tmux(_ args: [String], timeout: TimeInterval = 4) -> Result {
        run([tmux, "-u"] + args, timeout: timeout)
    }
}
