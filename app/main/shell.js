// Port of Shell.swift: where the tools are, the PATH every child gets, and running a program with a timeout.
//
// Differences from the Swift version (Node has no blocking calls on the main thread worth having):
//   run(argv, {timeout, cwd})  -> Promise<{code, out, err}>   (timeout in SECONDS, as Swift's TimeInterval)
//   runSync(argv, {timeout, cwd}) -> {code, out, err}         (blocks; only for start-up and tests)
//   tmux(args, timeout = 4)    -> Promise<{code, out, err}>
//   tmuxSync(args, timeout = 4)
// Swift's `Shell.tmux` is both the tool path and the function; here the path is `tmuxPath` and the function `tmux`.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

/** The user's home. BOARD_HOME overrides it (fresh-machine tests). Every other module reads this, never os.homedir(). */
const home = process.env.BOARD_HOME || os.homedir();

/** PATH of the user's login shell, or a fixed list when the shell does not answer within 5 s. An app started from the
 *  desktop (a .desktop launcher) may only get a short PATH, so without this a session's teammate spawner could not find
 *  tmux. The login shell is $SHELL (bash/zsh/fish…); /bin/sh when unset. */
const isMac = process.platform === 'darwin';
const loginPath = (() => {
  // macOS: as Shell.swift, zsh's login PATH and the Homebrew / ~/.local fallback (an app started from the Finder or the
  // Dock gets only /usr/bin:/bin:…)
  const fallback = (isMac ? [home + '/.local/bin', '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
    : [home + '/.local/bin', '/home/linuxbrew/.linuxbrew/bin', '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']).join(':');
  const sh = isMac ? '/bin/zsh' : process.env.SHELL && fs.existsSync(process.env.SHELL) ? process.env.SHELL : '/bin/sh';
  // fish does not understand `printf %s "$PATH"` the same way: its $PATH is a list; `string join` gives the colon form
  const script = path.basename(sh) === 'fish' ? 'string join : $PATH' : 'printf %s "$PATH"';
  try {
    const r = spawnSync(sh, ['-lc', script], { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (r.error || r.signal) return fallback;
    const s = (r.stdout || '').trim();
    return s ? s : fallback;
  } catch { return fallback; }
})();

function isExecutable(p) {
  try { const st = fs.statSync(p); if (!st.isFile()) return false; fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
}

/** A tool's path: the BOARD_* override, then the usual install dirs, then the login shell's PATH. Falls back to the
 *  first candidate (not present) so the start-up check can name the path it looked for. */
function find(tool, env, dirs) {
  if (process.env[env] !== undefined) return process.env[env];   // an override is final, even when missing (tests)
  const candidates = dirs.map((d) => d + '/' + tool).concat(loginPath.split(':').filter(Boolean).map((d) => d + '/' + tool));
  return candidates.find(isExecutable) || dirs[0] + '/' + tool;
}
// the install folders looked at first, in Shell.swift's order on macOS (Homebrew, then /usr/local, MacPorts)
const tmuxPath = find('tmux', 'BOARD_TMUX', isMac ? [home + '/.local/bin', '/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin']
  : [home + '/.local/bin', '/usr/bin', '/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin', '/opt/homebrew/bin', '/opt/local/bin']);
const gh = find('gh', 'BOARD_GH', isMac ? [home + '/.local/bin', '/opt/homebrew/bin', '/usr/local/bin']
  : [home + '/.local/bin', '/usr/bin', '/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin', '/opt/homebrew/bin']);
const claude = find('claude', 'BOARD_CLAUDE', isMac ? [home + '/.local/bin', '/opt/homebrew/bin', '/usr/local/bin']
  : [home + '/.local/bin', '/usr/local/bin', '/usr/bin', '/home/linuxbrew/.linuxbrew/bin', '/opt/homebrew/bin']);

/** PATH handed to every child: the login shell's, with tmux's directory in front (teammate spawning needs it). */
const PATH = (() => {
  const tmuxDir = path.dirname(tmuxPath);
  return loginPath.split(':').includes(tmuxDir) ? loginPath : tmuxDir + ':' + loginPath;
})();

function childEnv() {
  return Object.assign({}, process.env, { LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', PATH });
}

/** AB_READONLY: a tmux command that only reads may run; anything else (send-keys, kill-session, resize…) is logged and
 *  refused here as a last safety net (the store already refuses its actions). */
const READ_ONLY_TMUX = new Set(['list-panes', 'lsp', 'list-sessions', 'ls', 'list-windows', 'lsw', 'list-clients', 'lsc', 'capture-pane', 'capturep',
  'display-message', 'display', 'show-options', 'show', 'show-window-options', 'showw', 'has-session', 'has', 'show-environment', 'showenv',
  'show-buffer', 'showb', 'list-buffers', 'lsb', 'list-keys', 'lsk', 'list-commands', 'lscm', 'info', 'server-info', '-V']);
function readonly() { return !!process.env.AB_READONLY; }
function tmuxBlocked(args) {
  if (!readonly()) return false;
  const sub = args.find((a) => !a.startsWith('-') || a === '-V');
  return !READ_ONLY_TMUX.has(sub);
}

/**
 * Runs argv[0] with the arguments, stdin /dev/null, PATH = the login PATH. Completion = both pipes reach EOF (the child
 * exited or closed them); then the exit status is reaped for at most ~50 ms. Timed out: SIGTERM and {code: -1, err:
 * "timeout"} (whatever the child printed is not read). A spawn failure is {code: -1, err: <reason>}.
 */
function run(argv, opts = {}) {
  const timeout = opts.timeout === undefined ? 5 : opts.timeout;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd: opts.cwd || undefined, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) { resolve({ code: -1, out: '', err: String(e.message || e) }); return; }
    const out = [], err = [];
    let ended = 0, exitCode = null, finished = false, timer = null;
    const finish = (r) => { if (finished) return; finished = true; clearTimeout(timer); resolve(r); };
    child.on('error', (e) => finish({ code: -1, out: '', err: String(e.message || e) }));
    // a child killed by a signal has no exit code: as Shell.swift, it then counts as 0 (nothing on stderr) or 1, never
    // -1 (-1 means only "timed out" or "could not start", and callers keep their old state on -1)
    child.on('exit', (code, signal) => { exitCode = signal ? 'signal' : code; });
    const settle = () => {
      // reap: give the exit status ~50 ms after both pipes closed
      let n = 0;
      const poll = () => {
        if (exitCode !== null || n++ >= 50) {
          const o = Buffer.concat(out).toString('utf8'), e = Buffer.concat(err).toString('utf8');
          const code = exitCode !== null && exitCode !== 'signal' ? exitCode : (e.length === 0 ? 0 : 1);
          finish({ code, out: o, err: e });
        } else setTimeout(poll, 1);
      };
      poll();
    };
    const onEnd = () => { if (++ended === 2) settle(); };
    child.stdout.on('data', (d) => out.push(d)); child.stdout.on('end', onEnd);
    child.stderr.on('data', (d) => err.push(d)); child.stderr.on('end', onEnd);
    timer = setTimeout(() => {
      // timed out: report failure and never read what it printed so far
      try { child.kill('SIGTERM'); } catch { }
      finish({ code: -1, out: '', err: 'timeout' });
    }, timeout * 1000);
  });
}

/** Blocking variant of run() (spawnSync). Only for start-up checks and tests: it stalls the main process. */
function runSync(argv, opts = {}) {
  const timeout = opts.timeout === undefined ? 5 : opts.timeout;
  const r = spawnSync(argv[0], argv.slice(1), { cwd: opts.cwd || undefined, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'], timeout: timeout * 1000, encoding: 'utf8' });
  if (r.error && r.error.code === 'ETIMEDOUT') return { code: -1, out: '', err: 'timeout' };
  if (r.error) return { code: -1, out: '', err: String(r.error.message || r.error) };
  if (r.signal) return { code: (r.stderr || '') === '' ? 0 : 1, out: r.stdout || '', err: r.stderr || '' };   // as run()
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

function tmux(args, timeout = 4) {
  if (tmuxBlocked(args)) { console.log(`[readonly] tmux ${args.join(' ').slice(0, 120)}`); return Promise.resolve({ code: 1, out: '', err: 'readonly' }); }
  return run([tmuxPath, '-u'].concat(args), { timeout });
}
function tmuxSync(args, timeout = 4) {
  if (tmuxBlocked(args)) { console.log(`[readonly] tmux ${args.join(' ').slice(0, 120)}`); return { code: 1, out: '', err: 'readonly' }; }
  return runSync([tmuxPath, '-u'].concat(args), { timeout });
}

module.exports = { home, loginPath, tmuxPath, gh, claude, path: PATH, run, runSync, tmux, tmuxSync, readonly };
