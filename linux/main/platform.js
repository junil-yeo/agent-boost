// Linux replacements for the macOS-only APIs the Swift app uses:
//   Terminal.app via `open -a Terminal x.command` (BoardStore.attachTerminal / openExternalShell) -> openTerminal()
//   NSWorkspace open / activateFileViewerSelecting (PathLinks.open, CreateViews)                  -> openPath() / reveal() / openPathLink()
//   NSOpenPanel (CreateViews.pickFolder, ComposerBar.pickFiles)                                   -> pickFolder() / pickFiles()
//   UserNotifications (PromptNotifier)                                                            -> notify() / notifierInstall() / notifierUpdate()
//   NSApp.dockTile.badgeLabel (BoardStore.refresh)                                                -> setBadge() / dockBadge()
//   HostMemory (UsageBanner)                                                                      -> hostMemory() / availableGB() / diskFreeGB()
//   NSWorkspace.open(url) (CreateViews: cloud session on the web)                                 -> openExternal()
//   NSPasteboard setString (chat / search "copy")                                                 -> copyText() / readText()
// On macOS (where this is developed) the same functions fall back to `open`, so the app can be tried there.
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
  const cmd = `exec ${q(shell.tmuxPath)} -u attach-session -t ${q(session)} \\; select-window -t ${q(pane)} \\; select-pane -t ${q(pane)} \\; set-window-option -t ${q(pane)} window-size latest`;
  return openTerminal(cmd, session);
}
/** A plain login shell in a terminal, outside tmux and outside the app (BoardStore.openExternalShell). */
function openShell(cwd) {
  const d = cwd && fs.existsSync(cwd) ? cwd : shell.home;
  return openTerminal('', path.basename(d) || 'shell', d);
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
  const n = new Notification({ title: String(title), body: String(body || ''), silent: false });
  live.add(n);
  const drop = () => live.delete(n);
  n.on('click', () => { drop(); focusWindow(); if (typeof onClick === 'function') onClick(); });
  n.on('close', drop);
  n.show();
  return true;
}
function focusWindow() {
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
/** Launcher badge (Unity / KDE / some GNOME docks honour it; others ignore it) plus a count in the window title. */
function setBadge(n, label) {
  const { app } = electron();
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
 *  page cache, the closest match to what Swift counts as free + inactive + speculative + purgeable). GiB. */
function availableGB() {
  try {
    const m = /^MemAvailable:\s+(\d+)\s*kB/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
    if (m) return (parseInt(m[1], 10) * 1024) / 1073741824;
  } catch { }
  return os.freemem() / 1073741824;
}
/** Free space for the user on the home volume, in GB (10^9, as Finder / the Swift version show it); NaN when unknown. */
function diskFreeGB() {
  try { const s = fs.statfsSync(shell.home); return (s.bavail * s.bsize) / 1e9; } catch { return NaN; }
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

module.exports = {
  pathKinds, homeDir, backgroundJobs,
  openTerminal, attachTerminal, openShell, openPath, reveal, openPathLink, pickFolder, pickFiles, openExternal, copyText, readText,
  notify, notifierInstall, notifierUpdate, setBadge, dockBadge, hostMemory, availableGB, diskFreeGB,
};
