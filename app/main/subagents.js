// Subagents of one session: what its Agent / Task tool started, read off the CLI's own files (Claude Code 2.1.304):
//
//   ~/.claude/projects/<proj>/<sid>/subagents/agent-<agentId>.jsonl       the subagent's conversation
//   ~/.claude/projects/<proj>/<sid>/subagents/agent-<agentId>.meta.json   {agentType, description, toolUseId,
//                                                                          requestShape, finished?, model?, taskKind?}
//
// In-process teammates of an agent team live in the same folder (meta.taskKind "in_process_teammate", file
// agent-a<name>-<hash>.jsonl): they are team members (store.js / inprocess.js), never listed here.
//
// Running or done: done when the meta says finished; otherwise running while the parent is live and either the parent's
// Agent/Task tool_use for it has no tool_result yet (matched by meta.toolUseId), the file is still growing, or it is a
// background agent the CLI has not marked finished. A subagent of an ended session is done.
//
// Everything here only reads. The page asks list(sid) every 2 s while the tab is visible; reads are cheap: metas and
// first records are cached by file stamp, the parent transcript is read incrementally from where the last read ended.
const fs = require('fs');
const path = require('path');
const os = require('os');

const home = os.homedir();
const now = () => Date.now();
const stat = (p) => { try { return fs.statSync(p); } catch { return null; } };
const readJSON = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const stampOf = (st) => (st ? `${st.size}|${st.mtimeMs}` : '');
/** A file still being written within this window counts as running (a subagent between two tool calls). */
const GROWING_MS = 30000;
/** A background subagent without the CLI's finished mark stops counting as running after this long without a write
 *  (only when no sibling meta in the folder carries a "finished" key at all: a CLI version that never writes it). */
const UNMARKED_BG_MS = 120000;
/** How much of a parent transcript the first read looks at (later reads continue from its end). */
const PARENT_FIRST_READ = 8 * 1024 * 1024;

function mod(n) { try { return require('./' + n); } catch { return null; } }

// ── the folder ───────────────────────────────────────────────────────────────────────────────────────────────────
const metaCache = new Map();    // meta path -> {stamp, meta}
const headCache = new Map();    // jsonl path -> {started (ms|null)} (the first record never changes)
/** Every agent-*.jsonl in a subagents folder with its meta: [{id, agentId, file, metaFile, meta, size, mtimeMs}]. */
function scanDir(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const f of names) {
    if (!f.startsWith('agent-') || !f.endsWith('.jsonl')) continue;
    const file = path.join(dir, f);
    const st = stat(file);
    if (!st) continue;
    const id = f.slice(0, -6);
    const metaFile = path.join(dir, id + '.meta.json');
    const ms = stat(metaFile);
    let meta = {};
    if (ms) {
      const c = metaCache.get(metaFile);
      if (c && c.stamp === stampOf(ms)) meta = c.meta;
      else { meta = readJSON(metaFile) || {}; metaCache.set(metaFile, { stamp: stampOf(ms), meta }); }
    }
    out.push({ id, agentId: id.replace(/^agent-/, ''), file, metaFile, meta, size: st.size, mtimeMs: st.mtimeMs });
  }
  return out;
}
/** The subagents folder of the session whose transcript is `transcriptPath` (<dir>/<sid>.jsonl → <dir>/<sid>/subagents). */
function dirOf(transcriptPath) {
  return path.join(path.dirname(transcriptPath), path.basename(transcriptPath).replace(/\.jsonl$/, ''), 'subagents');
}
const isTeammate = (meta) => !!meta && meta.taskKind === 'in_process_teammate';

/** When a subagent started: its first record's timestamp (cached; the file's birth time when unreadable). */
function startedAt(file, st) {
  const c = headCache.get(file);
  if (c && c.started != null) return c.started;
  let started = null;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(16384);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const first = buf.subarray(0, n).toString('utf8').split('\n')[0];
    const m = /"timestamp":"([^"]+)"/.exec(first);
    if (m) { const t = Date.parse(m[1]); if (!Number.isNaN(t)) started = t; }
  } catch { } finally { if (fd != null) try { fs.closeSync(fd); } catch { } }
  if (started == null && st) started = st.birthtimeMs || st.mtimeMs;
  headCache.set(file, { started });
  return started;
}

// ── the parent's Agent / Task calls still waiting for their result ─────────────────────────────────────────────────
const parents = new Map();      // parent transcript -> {offset, ino, open: Set(tool_use id), closed: Set(tool_use id)}
/** Reads what was appended to the parent transcript since the last call and returns {open, closed} tool_use ids of its
 *  Agent / Task calls (open = no tool_result seen yet). The first read covers the last 8 MB only. */
function parentCalls(p) {
  const st = stat(p);
  let c = parents.get(p);
  if (!st) { parents.delete(p); return { open: new Set(), closed: new Set() }; }
  if (!c || c.ino !== st.ino || st.size < c.offset) {
    c = { offset: Math.max(0, st.size - PARENT_FIRST_READ), ino: st.ino, open: new Set(), closed: new Set(), partial: '' };
    parents.set(p, c);
  }
  if (st.size > c.offset) {
    let fd;
    try {
      fd = fs.openSync(p, 'r');
      const len = st.size - c.offset;
      const buf = Buffer.allocUnsafe(len);
      let got = 0;
      while (got < len) { const k = fs.readSync(fd, buf, got, len - got, c.offset + got); if (!k) break; got += k; }
      c.offset += got;
      const text = c.partial + buf.subarray(0, got).toString('utf8');
      const ls = text.split('\n');
      c.partial = ls.pop() || '';                 // an unfinished last line is read again next time
      for (const l of ls) noteParentLine(l, c);
    } catch { } finally { if (fd != null) try { fs.closeSync(fd); } catch { } }
  }
  return c;
}
function noteParentLine(l, c) {
  const isUse = l.includes('"tool_use"') && (l.includes('"name":"Agent"') || l.includes('"name":"Task"'));
  const isResult = l.includes('"tool_result"');
  if (!isUse && !isResult) return;
  let d; try { d = JSON.parse(l); } catch { return; }
  const content = d && d.message && Array.isArray(d.message.content) ? d.message.content : [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'tool_use' && (b.name === 'Agent' || b.name === 'Task') && typeof b.id === 'string') { if (!c.closed.has(b.id)) c.open.add(b.id); }
    else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') { c.open.delete(b.tool_use_id); c.closed.add(b.tool_use_id); }
  }
}

/** Running or done (see the header). `parent`: {live, startedAt (process start, ms|null)}; `calls`: parentCalls(). */
function isRunning(item, parent, calls, markedFolder, t = now()) {
  const m = item.meta || {};
  if (!parent || !parent.live) return false;
  if (m.finished === true) return false;
  // a file last written before this process started belongs to an earlier run of the conversation (resumed since)
  if (parent.startedAt != null && item.mtimeMs < parent.startedAt - 2000) return false;
  if (typeof m.toolUseId === 'string' && calls && calls.open.has(m.toolUseId)) return true;
  if (t - item.mtimeMs < GROWING_MS) return true;
  if (m.requestShape === 'background') return markedFolder ? true : t - item.mtimeMs < UNMARKED_BG_MS;
  return false;
}

// ── the session ──────────────────────────────────────────────────────────────────────────────────────────────────
const transcriptOf = new Map(); // sid -> transcript path
/** The session's transcript: the store's when it knows the session, else ~/.claude/projects/<any>/<sid>.jsonl. */
function sessionTranscript(sid) {
  const store = mod('store');
  const a = store && store.agent ? store.agent(sid) : null;
  if (a && a.transcriptPath && !a.inProcess && !a.isSubagent) return a.transcriptPath;
  const k = transcriptOf.get(sid);
  if (k && stat(k)) return k;
  if (typeof sid !== 'string' || !/^[0-9A-Za-z_-]+$/.test(sid)) return null;
  const root = path.join(home, '.claude', 'projects');
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch { return null; }
  for (const d of dirs) {
    const p = path.join(root, d, sid + '.jsonl');
    if (stat(p)) { transcriptOf.set(sid, p); return p; }
  }
  return null;
}
/** The parent's liveness for isRunning: a live session in the store (its process start bounds which files count). */
function parentInfo(sid) {
  const store = mod('store');
  const a = store && store.agent ? store.agent(sid) : null;
  if (!a || a.state === 'ended' || a.pid == null) return { live: false, startedAt: null };
  let started = null;
  try { started = store.processStart ? store.processStart(a.pid) : null; } catch { started = null; }
  return { live: true, startedAt: started };
}

const versions = new Map();     // sid -> bumped when a background transcript parse lands
/** Token use and model of a subagent transcript through the shared transcript reader (parsed in the background the
 *  first time; the last known numbers meanwhile). */
function usage(file, sid) {
  const T = mod('transcript');
  if (!T || !T.shared) return { tokens: null, model: null, last: null, loading: false };
  const R = T.shared;
  const loading = R.needsWarm(file, T.Mode.skip, () => versions.set(sid, (versions.get(sid) || 0) + 1));
  const s = loading ? R.peek(file) : R.snapshot(file, T.Mode.skip);
  return { tokens: s.tokens || null, model: s.model || null, last: s.last ?? null, loading: !!loading };
}

/** The session's subagents, newest first: [{agentId, description, agentType, model, running, started, ended,
 *  duration (ms), tokens {input, cacheWrite, cacheRead, output}, total, toolUseId, background, path}]. */
function list(sid) {
  const p = sessionTranscript(sid);
  if (!p) return { items: [], version: versions.get(sid) || 0 };
  const items = scanDir(dirOf(p)).filter((x) => !isTeammate(x.meta));
  if (!items.length) return { items: [], version: versions.get(sid) || 0 };
  const parent = parentInfo(sid);
  const calls = parent.live ? parentCalls(p) : null;
  const marked = items.some((x) => x.meta && Object.prototype.hasOwnProperty.call(x.meta, 'finished'));
  const t = now();
  const rows = items.map((x) => {
    const st = { size: x.size, mtimeMs: x.mtimeMs, birthtimeMs: null };
    const started = startedAt(x.file, st);
    const running = isRunning(x, parent, calls, marked, t);
    const u = usage(x.file, sid);
    const tk = u.tokens || { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
    const ended = running ? null : (u.last ?? x.mtimeMs);
    const m = x.meta || {};
    return {
      agentId: x.agentId,
      description: typeof m.description === 'string' && m.description ? m.description : x.agentId,
      agentType: typeof m.agentType === 'string' ? m.agentType : null,
      model: u.model || (typeof m.model === 'string' ? m.model : null),
      running, started, ended,
      duration: started == null ? null : Math.max(0, (running ? t : ended) - started),
      tokens: tk, total: (tk.input || 0) + (tk.cacheWrite || 0) + (tk.cacheRead || 0) + (tk.output || 0),
      tokensLoading: u.loading && !(u.tokens && (u.tokens.output || u.tokens.input)),
      parsing: u.loading,
      toolUseId: typeof m.toolUseId === 'string' ? m.toolUseId : null,
      background: m.requestShape === 'background',
      path: x.file,
    };
  });
  rows.sort((a, b) => (b.running - a.running) || ((b.started || 0) - (a.started || 0)));
  return { items: rows, version: versions.get(sid) || 0 };
}

/** The subagent file of a session by agent id (null when unknown or a teammate's). */
function fileOf(sid, agentId) {
  const p = sessionTranscript(sid);
  if (!p || typeof agentId !== 'string' || !/^[0-9A-Za-z_-]+$/.test(agentId)) return null;
  const f = path.join(dirOf(p), 'agent-' + agentId + '.jsonl');
  const meta = readJSON(path.join(dirOf(p), 'agent-' + agentId + '.meta.json'));
  if (isTeammate(meta) || !stat(f)) return null;
  return f;
}

/** One subagent's conversation for the read-only view: {entries, version, loading}. `since` = the version the page
 *  holds: unchanged → {same: true} (no entries sent again). */
function chat(sid, agentId, since = null) {
  const f = fileOf(sid, agentId);
  if (!f) return { entries: [], version: 0, loading: false, missing: true };
  const T = mod('transcript');
  if (!T || !T.shared) return { entries: [], version: 0, loading: false };
  const R = T.shared;
  const mode = R.effective(f, T.Mode.full);
  // the focused priority: a background token parse of the same file (list) is moved to the front of the queue
  if (R.needsWarm(f, mode, () => versions.set(sid, (versions.get(sid) || 0) + 1), T.PRIO ? T.PRIO.focused : undefined)) return { entries: [], version: 0, loading: true };
  const s = R.snapshot(f, mode);
  const v = `${s.offset}|${s.version}`;
  if (since != null && since === v) return { same: true, version: v };
  const ms = (d) => (d == null ? null : typeof d === 'number' ? d : (Number.isNaN(Date.parse(d)) ? null : Date.parse(d)));
  const entries = (s.entries || []).map((e) => ({ id: e.id, role: e.role, text: e.text, toolName: e.toolName ?? null, time: ms(e.time), isThinking: !!e.isThinking, isError: !!e.isError }));
  return { entries, version: v, loading: false };
}

module.exports = { list, chat, fileOf, scanDir, dirOf, isTeammate, isRunning, parentCalls, startedAt, sessionTranscript, GROWING_MS, UNMARKED_BG_MS };
