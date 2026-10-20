// AB_ONLY=<prefix>: a sandbox mode for end-to-end tests against a real Claude Code CLI on a machine whose other sessions
// must stay untouched (the developer's own live sessions run beside the test).
//
//  - Start-up routines that act on sessions or files (resumeSavedSessions, pruneEmptyTeams, saving seen-members /
//    job names, settings restore, CLICheck's version note, the single-instance lock) are skipped, as under AB_READONLY.
//  - Every store action and every tmux write is allowed only for a target that belongs to the sandbox:
//      an agent whose display name starts with the prefix, or whose cwd is inside AB_ONLY_DIR (when set), or whose pane
//      belongs to a tmux session whose name contains the prefix;
//      a tmux target (pane id, session name, session:window) whose tmux session name contains the prefix.
//    Anything else logs "[only] refused <action>" and does nothing.
//  - shell.tmux / shell.tmuxSync enforce it again at the lowest layer: a writing tmux command is run only when every
//    target it names resolves (read-only `tmux display-message`) to a sandbox session; a command with no target (a
//    server-wide option, kill-server…) is refused. Named paste buffers (load-buffer / paste's -d) are the exception:
//    they hold the text being pasted and touch no session.
//  - The board's own data files (~/.agent-boost/archived.json, deleted-sessions.json …) are written to a temp folder
//    instead (dataDir()); send.log stays where it is.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const prefix = () => process.env.AB_ONLY || '';
const active = () => !!process.env.AB_ONLY;

function real(p) {
  if (!p) return null;
  // a folder that no longer exists (an ended session's cwd) is resolved through its nearest existing parent, so
  // /tmp/… and /private/tmp/… (macOS symlinks) still compare equal
  let cur = path.resolve(p), rest = '';
  for (;;) {
    try { return path.join(fs.realpathSync(cur), rest); } catch { }
    const up = path.dirname(cur);
    if (up === cur) return path.resolve(p);
    rest = path.join(path.basename(cur), rest); cur = up;
  }
}
/** The sandbox folder (AB_ONLY_DIR), resolved, with a trailing slash; null when unset. */
function sandboxDir() {
  const d = process.env.AB_ONLY_DIR;
  if (!d) return null;
  return real(d).replace(/\/+$/, '') + '/';
}
/** Where the board's own data files go in this mode (never ~/.agent-boost). */
function dataDir() { return process.env.AB_ONLY_DATA || path.join(os.tmpdir(), 'agent-boost-only'); }

function nameOk(name) { return active() && typeof name === 'string' && name.startsWith(prefix()); }
function tmuxNameOk(s) { return active() && typeof s === 'string' && s.length > 0 && s.includes(prefix()); }
function cwdOk(cwd) {
  const d = sandboxDir();
  if (!d || typeof cwd !== 'string' || !cwd) return false;
  return (real(cwd).replace(/\/+$/, '') + '/').startsWith(d);
}

// pane / target → tmux session name, read with `tmux display-message` (read-only). Cached briefly: a test sends many
// keys to the same pane; a pane id is never reused while the server runs, a session can be renamed (2 s is plenty).
const cache = new Map();
let tmuxBin = null;
function tmuxPath() { if (!tmuxBin) tmuxBin = require('./shell').tmuxPath; return tmuxBin; }
function sessionOf(target) {
  if (typeof target !== 'string' || !target) return null;
  const c = cache.get(target);
  if (c && Date.now() - c.at < 2000) return c.name;
  let name = null;
  try {
    // `=name` would be an exact-match session target; plain targets are passed as the caller wrote them
    const r = spawnSync(tmuxPath(), ['-u', 'display-message', '-p', '-t', target, '#{session_name}'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    if (r.status === 0) name = (r.stdout || '').trim() || null;
  } catch { name = null; }
  cache.set(target, { name, at: Date.now() });
  return name;
}
function paneOk(target) { return tmuxNameOk(sessionOf(target)); }

/** An agent (or anything with name / cwd / tmuxPane / tmuxName), a pane id, a tmux session name, or a list of those
 *  (every one must belong to the sandbox). */
function allows(target) {
  if (!active()) return true;
  if (target == null) return false;
  if (Array.isArray(target)) return target.length > 0 && target.every(allows);
  if (typeof target === 'string') return target.startsWith('%') ? paneOk(target) : (tmuxNameOk(target) || paneOk(target));
  if (typeof target === 'object') {
    if (nameOk(target.name) || cwdOk(target.cwd)) return true;
    if (target.tmuxName && tmuxNameOk(target.tmuxName)) return true;
    if (target.tmuxPane && paneOk(target.tmuxPane)) return true;
    return false;
  }
  return false;
}
function refuse(action) { console.log(`[only] refused ${action}`); return true; }

// ── the lowest layer: tmux argv ───────────────────────────────────────────────────────────────────────────────────
const READ_ONLY = new Set(['list-panes', 'lsp', 'list-sessions', 'ls', 'list-windows', 'lsw', 'list-clients', 'lsc', 'capture-pane', 'capturep',
  'display-message', 'display', 'show-options', 'show', 'show-window-options', 'showw', 'has-session', 'has', 'show-environment', 'showenv',
  'show-buffer', 'showb', 'list-buffers', 'lsb', 'list-keys', 'lsk', 'list-commands', 'lscm', 'info', 'server-info', '-V']);
const BUFFER_ONLY = new Set(['load-buffer', 'loadb', 'set-buffer', 'setb', 'delete-buffer', 'deleteb']);
/** Splits `a b ; c d` into commands. */
function segments(args) {
  const out = [[]];
  for (const a of args) { if (a === ';') out.push([]); else out[out.length - 1].push(a); }
  return out.filter((s) => s.length > 0);
}
/** null = allowed; otherwise the reason it is refused. */
function tmuxRefusal(args) {
  if (!active()) return null;
  for (const seg of segments(args)) {
    const sub = seg.find((a) => !a.startsWith('-') || a === '-V');
    if (READ_ONLY.has(sub)) continue;
    if (BUFFER_ONLY.has(sub) && !seg.includes('-t')) continue;
    if (sub === 'new-session' || sub === 'new') {
      const i = seg.indexOf('-s');
      const n = i >= 0 ? seg[i + 1] : null;
      if (!tmuxNameOk(n)) return `${sub} -s ${n}`;
      continue;
    }
    const targets = [];
    seg.forEach((a, i) => { if ((a === '-t' || a === '-s') && i + 1 < seg.length) targets.push(seg[i + 1]); });
    if (targets.length === 0) return `${sub} (no target)`;
    for (const t of targets) if (!paneOk(t)) return `${sub} -t ${t} (session ${sessionOf(t) ?? '?'})`;
  }
  return null;
}

module.exports = { active, prefix, sandboxDir, dataDir, nameOk, tmuxNameOk, cwdOk, sessionOf, paneOk, allows, refuse, tmuxRefusal, segments };
