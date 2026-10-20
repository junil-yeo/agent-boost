// Linux replacements for the macOS-only APIs the Swift app uses:
//   Terminal.app via `open -a Terminal x.command` (BoardStore.attachTerminal / openExternalShell) -> openTerminal()
//   NSWorkspace open / activateFileViewerSelecting (PathLinks.open, CreateViews)                  -> openPath() / reveal() / openPathLink()
//   NSOpenPanel (CreateViews.pickFolder, ComposerBar.pickFiles)                                   -> pickFolder() / pickFiles()
//   UserNotifications (PromptNotifier)                                                            -> notify() / notifierInstall() / notifierUpdate()
//   NSApp.dockTile.badgeLabel (BoardStore.refresh)                                                -> setBadge() / dockBadge()
//   HostMemory (UsageBanner)                                                                      -> hostMemory() / availableGB() / diskFreeGB()
//   NSWorkspace.open(url) (CreateViews: cloud session on the web)                                 -> openExternal()
//   NSPasteboard setString (chat / search "copy")                                                 -> copyText() / readText()
// On macOS every function does what the Swift app does there: the Terminal app through a .command file and
// `open -a Terminal`, Finder through `open` / `open -R`, the Dock badge, host_statistics64 (via vm_stat) and the volume's
// "available for important usage" for HostMemory.
const fs = require('fs');
const os = require('os');
const path = require('path');
const url = require('url');
const { spawn } = require('child_process');
const shell = require('./shell');
const { L } = require('./l10n');

const isMac = process.platform === 'darwin';
function electron() { return require('electron'); }
function mainWindow() { try { return require('./main').window || null; } catch { return null; } }

function which(tool) {
  for (const d of shell.path.split(':').filter(Boolean)) {
    const p = path.join(d, tool);
    try { if (fs.statSync(p).isFile()) { fs.accessSync(p, fs.constants.X_OK); return p; } } catch { }
  }
  return null;
}
/** Single-quoted for sh. */
function q(s) { return "'" + String(s).split("'").join("'\\''") + "'"; }

/** Starts a program detached from the app. Resolves {code, out, err}: code 0 when it is still running after `grace` ms or
 *  exited 0 by then (most terminals hand the window to a server and exit at once); otherwise its exit code / error. */
function launch(argv, opts = {}) {
  const grace = opts.grace === undefined ? 1200 : opts.grace;
  return new Promise((resolve) => {
    let child, done = false, errText = '';
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    try {
      child = spawn(argv[0], argv.slice(1), {
        detached: true, cwd: opts.cwd || shell.home, stdio: ['ignore', 'ignore', 'pipe'],
        env: Object.assign({}, process.env, { PATH: shell.path }),
      });
    } catch (e) { finish({ code: -1, out: '', err: String(e.message || e) }); return; }
    child.stderr.on('data', (d) => { if (errText.length < 400) errText += d.toString('utf8'); });
    child.on('error', (e) => finish({ code: -1, out: '', err: String(e.message || e) }));
    child.on('exit', (code) => finish({ code: code === 0 ? 0 : (code || -1), out: '', err: errText.trim() }));
    setTimeout(() => { child.stderr.destroy(); child.unref(); finish({ code: 0, out: '', err: '' }); }, grace);
  });
}

// ───────────────────────────── terminal ─────────────────────────────
/** Terminal emulators in order, each with its own "run this program" arguments. The command itself goes into a small
 *  script (no quoting differences between terminals); the window title is set with an escape sequence for the same reason. */
const TERMINALS = [
  ['x-terminal-emulator', (s) => ['-e', s]],
  ['gnome-terminal', (s) => ['--', s]],
  ['konsole', (s) => ['-e', s]],
  ['xfce4-terminal', (s) => ['-x', s]],
  ['kitty', (s) => [s]],
  ['alacritty', (s) => ['-e', s]],
  ['wezterm', (s) => ['start', '--', s]],
  ['foot', (s) => [s]],
  ['xterm', (s, title) => ['-T', title, '-e', s]],
];
function scriptDir() {
  const d = path.join(os.tmpdir(), `agent-boost-${process.getuid ? process.getuid() : 'u'}`);
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}
/** Writes the script a terminal runs: title, folder, then the command (or a login shell when command is empty). */
function writeScript(command, title, cwd) {
  const ext = isMac ? '.command' : '.sh';
  const file = path.join(scriptDir(), `open-${String(title || 'shell').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40)}-${process.pid}${ext}`);
  const lines = ['#!/bin/sh'];
  if (title) lines.push(`printf '\\033]0;%s\\007' ${q(title)}`);
  if (cwd) lines.push(`cd ${q(cwd)} 2>/dev/null || cd`);
  lines.push(command ? `exec sh -c ${q(command)}` : `exec "\${SHELL:-/bin/sh}" -l`);
  fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o755 });
  fs.chmodSync(file, 0o755);
  return file;
}
/** Opens a terminal window running `command` (a shell command line; empty = a login shell) in `cwd`. The first terminal
 *  emulator that starts wins. Resolves {code, out, err} like shell.run. */
async function openTerminal(command, title = 'Agent Boost', cwd = null) {
  let script;
  try { script = writeScript(command, title, cwd); } catch (e) { return { code: -1, out: '', err: String(e.message || e) }; }
  if (isMac) return launch(['/usr/bin/open', '-a', 'Terminal', script], { grace: 3000 });
  let last = null;
  for (const [name, args] of TERMINALS) {
    const bin = which(name);
    if (!bin) continue;
    const r = await launch([bin].concat(args(script, title)), { cwd: cwd || shell.home });
    if (r.code === 0) return r;
    last = r;
  }
  return last || { code: -1, out: '', err: L('터미널 프로그램을 찾지 못했습니다 (%@)', TERMINALS.map((t) => t[0]).join(', ')) };
}
/** A terminal attached to a tmux session, on `pane`'s window (BoardStore.attachTerminal). No `resize-window` here (it
 *  would pin the window to `manual` size): with `window-size latest` the window follows the terminal while it is
 *  attached, and the app's own views stop resizing it for as long as a client is attached (#{session_attached}). */
function attachTerminal(session, pane) {
  if (isMac) return attachTerminalMac(session, pane);
  const cmd = `exec ${q(shell.tmuxPath)} -u attach-session -t ${q(session)} \\; select-window -t ${q(pane)} \\; select-pane -t ${q(pane)} \\; set-window-option -t ${q(pane)} window-size latest`;
  return openTerminal(cmd, session);
}
/** A plain login shell in a terminal, outside tmux and outside the app (BoardStore.openExternalShell). */
function openShell(cwd) {
  const d = cwd && fs.existsSync(cwd) ? cwd : shell.home;
  if (isMac) return shell.run(['/usr/bin/open', '-a', 'Terminal', d], { timeout: 10 });   // Terminal opens a shell there
  return openTerminal('', path.basename(d) || 'shell', d);
}
/** macOS, as BoardStore.attachTerminal: the default Terminal app runs ~/.agent-boost/open-<session>.command (a zsh
 *  script that attaches) via `open -a Terminal`. Resolves {code, out, err}. */
async function attachTerminalMac(sess, pane) {
  const dir = path.join(shell.home, '.agent-boost');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { }
  const file = `${dir}/open-${sess}.command`;
  const script = `#!/bin/zsh\nexec ${q(shell.tmuxPath)} -u attach-session -t ${q(sess)} \\; select-window -t ${q(pane)} \\; select-pane -t ${q(pane)} \\; set-window-option -t ${q(pane)} window-size latest\n`;
  try { fs.writeFileSync(file, script); fs.chmodSync(file, 0o755); } catch { }
  return shell.run(['/usr/bin/open', '-a', 'Terminal', file], { timeout: 10 });
}

// ───────────────────────────── files ─────────────────────────────
/** Opens a file or folder with its default application (xdg-open). Resolves true when the opener started. */
async function openPath(p) {
  const opener = isMac ? '/usr/bin/open' : which('xdg-open');
  if (opener) return (await launch([opener, p], { grace: 800 })).code === 0;
  const err = await electron().shell.openPath(p);
  return err === '';
}
/** Shows a file in its folder, selected: the FileManager1 DBus interface (Nautilus, Dolphin, Nemo, Thunar …) via gdbus,
 *  else the parent folder with xdg-open. */
async function reveal(p) {
  if (isMac) return (await launch(['/usr/bin/open', '-R', p], { grace: 800 })).code === 0;
  const gdbus = which('gdbus');
  if (gdbus) {
    const href = url.pathToFileURL(p).href.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const r = await shell.run([gdbus, 'call', '--session', '--dest', 'org.freedesktop.FileManager1', '--object-path', '/org/freedesktop/FileManager1',
      '--method', 'org.freedesktop.FileManager1.ShowItems', `['${href}']`, ''], { timeout: 5 });
    if (r.code === 0) return true;
  }
  return openPath(path.dirname(p));
}
/** PathLinks.open: a folder opens in the file manager; a file shows in its folder, selected. */
function openPathLink(p) {
  const full = p.startsWith('~/') ? path.join(shell.home, p.slice(2)) : p;
  let isDir = false;
  try { isDir = fs.statSync(full).isDirectory(); } catch { }
  return isDir ? openPath(full) : reveal(full);
}
/** Folder picker (NSOpenPanel, directories only). Resolves the path, or null when cancelled. */
async function pickFolder(defaultPath) {
  const { dialog } = electron();
  const opts = { properties: ['openDirectory', 'createDirectory'], defaultPath: defaultPath || shell.home };
  const w = mainWindow();
  const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
  return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
}
/** Files to attach (NSOpenPanel, several). The Swift panel also takes folders; GTK's dialog cannot pick files and folders
 *  at once, so on Linux it picks files (a folder can still be dropped onto the composer). Resolves [paths]. */
async function pickFiles() {
  const { dialog } = electron();
  const opts = { properties: isMac ? ['openFile', 'openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'] };
  const w = mainWindow();
  const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
  return r.canceled ? [] : r.filePaths;
}
/** Opens a web link in the browser (http/https/mailto only). */
async function openExternal(link) {
  if (!/^(https?:|mailto:)/i.test(String(link))) return false;
  await electron().shell.openExternal(String(link));
  return true;
}
function copyText(s) { electron().clipboard.writeText(String(s)); return true; }
function readText() { return electron().clipboard.readText(); }

// ───────────────────────────── notifications ─────────────────────────────
const live = new Set();       // shown notifications (kept referenced so their click handler survives garbage collection)
/** A desktop notification. `onClick` runs when it is clicked. Returns false when the desktop has no notification service. */
function notify(title, body, onClick) {
  const { Notification } = electron();
  if (!Notification.isSupported()) return false;
  const n = new Notification({ title: String(title), body: String(body || ''), silent: false });   // .sound = .default
  live.add(n);
  const drop = () => live.delete(n);
  n.on('click', () => { drop(); focusWindow(); if (typeof onClick === 'function') onClick(); });
  n.on('close', drop);
  n.show();
  return true;
}
function focusWindow() {
  // macOS: NSApp.activate + the window in front (from background mode the Dock icon comes back too)
  if (isMac) { try { const t = require('./tray'); if (t.showBoard) { t.showBoard(); return; } } catch { } }
  const w = mainWindow();
  if (!w) return;
  if (w.isMinimized()) w.restore();
  w.show(); w.focus();
}

// PromptNotifier: a notification when an agent starts waiting for an answer while the app is in the background.
// Clicking it brings the app forward and opens that agent's conversation (where the PromptCard is).
const notifier = { store: null, notified: new Set() };   // sessionIds already announced for the current wait
function notifierInstall(store) { notifier.store = store; }
/** Call whenever the set of agents waiting for an answer changes. `waiting`: agents ({sessionId, name, prompt}). */
function notifierUpdate(waiting, enabled) {
  const ids = new Set((waiting || []).map((a) => a.sessionId));
  for (const s of [...notifier.notified]) if (!ids.has(s)) notifier.notified.delete(s);   // a finished wait can notify again next time
  const { BrowserWindow } = electron();
  if (!enabled || BrowserWindow.getFocusedWindow() !== null) return;
  for (const a of waiting || []) {
    if (notifier.notified.has(a.sessionId)) continue;
    notifier.notified.add(a.sessionId);
    const sid = a.sessionId;
    notify(L('%@: 응답 필요', a.name), (a.prompt && a.prompt.title) || L('에이전트가 답을 기다리고 있습니다'), () => {
      const s = notifier.store;
      if (s && typeof s.open === 'function') s.open(sid);
    });
  }
}

// ───────────────────────────── badge ─────────────────────────────
/** Launcher badge (Unity / KDE / some GNOME docks honour it; others ignore it) plus a count in the window title.
 *  macOS: the Dock tile's badge label (NSApp.dockTile.badgeLabel), nothing else. */
function setBadge(n, label) {
  const { app } = electron();
  if (isMac) {
    const text = label != null && label !== '' ? String(label) : (n > 0 ? String(n) : '');
    try { if (app.dock) app.dock.setBadge(text); } catch { }
    return true;
  }
  try { app.setBadgeCount(Math.max(0, Number(n) || 0)); } catch { }
  const w = mainWindow();
  if (w && !w.isDestroyed()) {
    const text = label != null && label !== '' ? String(label) : (n > 0 ? String(n) : '');
    w.setTitle(text ? `Agent Boost — ${text}` : 'Agent Boost');
  }
  return true;
}
/** BoardStore's dock label: "응답 n" while agents wait for an answer, else the number of busy agents, else nothing. */
function dockBadge(waiting, busy) {
  if (waiting > 0) return setBadge(waiting, L('응답 %@', String(waiting)));
  if (busy > 0) return setBadge(busy, String(busy));
  return setBadge(0, null);
}

// ───────────────────────────── HostMemory ─────────────────────────────
/** Memory the host can hand out now: MemAvailable from /proc/meminfo (the kernel's own estimate of free + reclaimable
 *  page cache, the closest match to what Swift counts as free + inactive + speculative + purgeable). GiB.
 *  macOS: exactly Swift's count, (free + inactive + speculative + purgeable) pages × page size from host_statistics64,
 *  which `vm_stat` prints. */
function availableGB() {
  if (isMac) return macAvailableGB();
  try {
    const m = /^MemAvailable:\s+(\d+)\s*kB/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
    if (m) return (parseInt(m[1], 10) * 1024) / 1073741824;
  } catch { }
  return os.freemem() / 1073741824;
}
/** Free space for the user on the home volume, in GB (10^9, as Finder / the Swift version show it); NaN when unknown.
 *  macOS: diskFreeGBMac (Swift's value, including purgeable space). */
function diskFreeGB() {
  if (isMac) return diskFreeGBMac();
  try { const s = fs.statfsSync(shell.home); return (s.bavail * s.bsize) / 1e9; } catch { return NaN; }
}
// ── HostMemory on macOS ──
/** (free + inactive + speculative + purgeable) × page size, GiB; 0 when vm_stat cannot be read (Swift: KERN failure →
 *  0). The first call reads it at once (~10 ms); later calls answer the last value and read again in the background. */
const macMem = { gb: null, at: 0, busy: false };
function parseVmStat(out) {
  const page = Number((/page size of (\d+) bytes/.exec(out) || [])[1]) || 4096;
  const count = (k) => Number((new RegExp(`^Pages ${k}:\\s+(\\d+)`, 'm').exec(out) || [])[1]) || 0;
  const pages = count('free') + count('inactive') + count('speculative') + count('purgeable');
  return /Pages free:/.test(out) ? (pages * page) / 1073741824 : 0;
}
function macAvailableGB() {
  const { execFile, execFileSync } = require('child_process');
  if (macMem.gb == null) {
    try { macMem.gb = parseVmStat(execFileSync('/usr/bin/vm_stat', { encoding: 'utf8', timeout: 2000 })); } catch { macMem.gb = 0; }
    macMem.at = Date.now();
  } else if (!macMem.busy && Date.now() - macMem.at > 1000) {
    macMem.busy = true;
    execFile('/usr/bin/vm_stat', { encoding: 'utf8', timeout: 2000 }, (err, out) => {
      macMem.busy = false; macMem.at = Date.now();
      macMem.gb = err ? 0 : parseVmStat(out);
    });
  }
  return macMem.gb;
}
/** Free space on the startup volume as Finder shows it (includes purgeable space macOS can clear):
 *  volumeAvailableCapacityForImportantUsage of "/", asked through JavaScript for Automation (Foundation's NSURL, the
 *  same call as Swift). Asking takes ~0.1–0.5 s, so it is read in the background at most every 30 s and the last value
 *  is shown; NaN until the first answer (Swift too). statfs of "/" when the question fails. */
const macDisk = { gb: null, at: 0, busy: false };
const JXA_DISK = 'ObjC.import("Foundation"); var v = Ref(); $.NSURL.fileURLWithPath("/").getResourceValueForKeyError(v, $.NSURLVolumeAvailableCapacityForImportantUsageKey, null); ObjC.unwrap(v[0]).toString()';
function diskFreeGBMac() {
  if (!macDisk.busy && Date.now() - macDisk.at > 30000) {
    macDisk.busy = true;
    require('child_process').execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', JXA_DISK], { encoding: 'utf8', timeout: 10000 }, (err, out) => {
      let gb = err ? NaN : Number(String(out).trim()) / 1e9;
      if (!(gb > 0)) { try { const st = fs.statfsSync('/'); gb = (st.bavail * st.bsize) / 1e9; } catch { gb = NaN; } }
      macDisk.gb = gb; macDisk.at = Date.now(); macDisk.busy = false;
    });
  }
  return macDisk.gb == null ? NaN : macDisk.gb;
}

/** Both, JSON-safe (null when unknown). */
function hostMemory() {
  const d = diskFreeGB();
  return { availableGB: availableGB(), diskFreeGB: Number.isNaN(d) ? null : d };
}


// ── read-only file facts the renderer needs (it never runs shell commands itself) ─────────────────────────────────
/** For each path ("~/" expanded): 'd' (folder), 'f' (file) or nothing when it does not exist. */
function pathKinds(paths) {
  const out = {};
  for (const p of paths || []) {
    const q = typeof p === 'string' && p.startsWith('~/') ? require('os').homedir() + p.slice(1) : p;
    try { out[p] = require('fs').statSync(q).isDirectory() ? 'd' : 'f'; } catch { /* missing */ }
  }
  return out;
}
function homeDir() { return require('os').homedir(); }
/** Claude Code's background jobs: [{id, mtime (ms), state (parsed state.json)}] from ~/.claude/jobs/<id>/state.json. */
function backgroundJobs() {
  const fs = require('fs'), path = require('path');
  const root = path.join(require('os').homedir(), '.claude', 'jobs');
  const out = [];
  for (const id of (fs.existsSync(root) ? fs.readdirSync(root) : [])) {
    const f = path.join(root, id, 'state.json');
    try { out.push({ id, mtime: fs.statSync(f).mtimeMs, state: JSON.parse(fs.readFileSync(f, 'utf8')) }); } catch { /* none */ }
  }
  return out;
}

// ───────────────────────────── one board at a time (App.swift enforceSingleInstance) ─────────────────────────────
// The Swift app takes an flock on ~/.agent-boost/app.lock for its lifetime and writes its pid into it. Node has no
// flock, so a small perl helper takes it for this app (the same lock, so the Swift app and this one exclude each other)
// and holds it while its stdin is open: when this process dies, the pipe closes, the helper exits and the lock is
// released, as with the Swift app's file descriptor.
const LOCK_HELPER = `use Fcntl qw(:flock);
my ($f, $pid, $out) = @ARGV;
sub say_ { open(my $o, '>', $out . '.part') or exit 2; print $o $_[0]; close $o; rename($out . '.part', $out); }
open(my $h, '+>>', $f) or do { say_("error"); exit 1 };
if (!flock($h, LOCK_EX | LOCK_NB)) { say_("busy"); exit 0 }
truncate($h, 0); select((select($h), $| = 1)[0]); print $h $pid;
say_("ok");
1 while <STDIN>;
exit 0;`;
let lockHelper = null;
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
/** The pid written in the lock file (the holder), or null. */
function lockHolder(file) {
  try { const n = parseInt(fs.readFileSync(file, 'utf8').trim(), 10); return Number.isInteger(n) && n > 0 ? n : null; } catch { return null; }
}
/** Takes ~/.agent-boost/app.lock (flock, held until this process exits) and writes `pid` into it.
 *  → {ok: true} | {ok: false, holder: pid|null} | {ok: null} (no perl / the helper failed: the lock could not be tried).
 *  Blocks for at most ~3 s (start-up only). */
function takeAppLock(home = shell.home, pid = process.pid) {
  if (lockHelper) return { ok: true };
  const dir = path.join(home, '.agent-boost'), file = path.join(dir, 'app.lock');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { }
  const perl = ['/usr/bin/perl', '/bin/perl', '/usr/local/bin/perl'].find((p) => fs.existsSync(p)) || which('perl');
  if (!perl) return { ok: null };
  const out = path.join(os.tmpdir(), `ab-lock-${process.pid}-${Date.now()}`);
  let child;
  try { child = spawn(perl, ['-e', LOCK_HELPER, file, String(pid), out], { stdio: ['pipe', 'ignore', 'ignore'] }); } catch { return { ok: null }; }
  child.on('error', () => { });
  let answer = null;
  for (let i = 0; i < 300 && answer == null; i++) {
    try { answer = fs.readFileSync(out, 'utf8'); } catch { sleepSync(10); }
  }
  try { fs.rmSync(out, { force: true }); } catch { }
  if (answer === 'ok') {
    lockHelper = child;
    child.unref(); child.stdin.unref && child.stdin.unref();   // never keeps the app alive; closes when it exits
    return { ok: true };
  }
  try { child.kill(); } catch { }
  if (answer === 'busy') return { ok: false, holder: lockHolder(file) };
  return { ok: null };
}
/** Lets go of the lock (tests; the app keeps it until it exits). */
function releaseAppLock() { if (lockHelper) { try { lockHelper.stdin.end(); lockHelper.kill(); } catch { } lockHelper = null; } }
/** When the process started (epoch ms), or null. */
function processStarted(pid) {
  try {
    const r = require('child_process').spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000, env: Object.assign({}, process.env, { LC_ALL: 'C', LANG: 'C' }) });
    const t = Date.parse((r.stdout || '').trim().replace(/\s+/g, ' '));
    return Number.isNaN(t) ? null : t;
  } catch { return null; }
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
/** NSRunningApplication.terminate, then forceTerminate after 10 s (a quitting board can take a few seconds).
 *  macOS: the polite quit goes through AppKit (the app asks its own questions); elsewhere SIGTERM. Blocks. */
function terminateHolder(pid) {
  if (isMac) {
    require('child_process').spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e',
      `ObjC.import('AppKit'); const a = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${Number(pid)}); if (a) a.terminate;`], { timeout: 5000, stdio: 'ignore' });
  } else { try { process.kill(pid, 'SIGTERM'); } catch { } }
  for (let i = 0; i < 100 && alive(pid); i++) sleepSync(100);
  if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { } sleepSync(300); }
}

module.exports = {
  pathKinds, homeDir, backgroundJobs,
  openTerminal, attachTerminal, openShell, openPath, reveal, openPathLink, pickFolder, pickFiles, openExternal, copyText, readText,
  notify, notifierInstall, notifierUpdate, setBadge, dockBadge, hostMemory, availableGB, diskFreeGB,
  takeAppLock, releaseAppLock, lockHolder, processStarted, terminateHolder,
};
