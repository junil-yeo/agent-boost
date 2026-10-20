// Port of ConvoSearch.swift's ConvoIndex: every recorded conversation (~/.claude/projects/*/*.jsonl), reduced to my
// messages and the agents' answers, for search (Ctrl+Shift+F). The first search reads all files; later ones read only
// what was appended since. The sheet itself is a renderer view; it calls refresh(), search(q) and context(path, index).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { unwrapPaste } = require('./transcript');

// The Swift app tests each raw line with memmem for "custom-title" / "ai-title" / "type":"user" / "tool_use_id" /
// "type":"assistant" / "type":"text". Buffer.indexOf is far slower than memmem when a pattern starts with a byte as
// common as '"' (~250 MB/s here), so each pattern is found through an anchor that starts with a rarer byte, once over
// the whole buffer, and the bytes around each hit are checked: same matches, about ten times faster.
const B = (s) => Buffer.from(s, 'latin1');
const A_TITLE = B('-title"'), A_TYPE = B('ype":"'), A_TOOL = B('_use_id"');
const at = (data, pos, bytes) => {
  if (pos < 0 || pos + bytes.length > data.length) return false;
  for (let k = 0; k < bytes.length; k++) if (data[pos + k] !== bytes[k]) return false;
  return true;
};
const PRE_CUSTOM = B('"custom'), PRE_AI = B('"ai'), PRE_T = B('"t'), PRE_TOOL = B('"tool');
const POST_USER = B('user"'), POST_ASSISTANT = B('assistant"'), POST_TEXT = B('text"');
/** Every position of `anchor` in data[from…] whose surroundings `ok(pos)` accepts. */
function hits(data, from, anchor, ok) {
  const out = [];
  for (let i = data.indexOf(anchor, from); i >= 0; i = data.indexOf(anchor, i + 1)) if (ok(i)) out.push(i);
  return out;
}

/** ISO8601 with fractional seconds, as the Swift formatter (without them: null). */
function isoDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+(Z|[+-]\d\d:?\d\d)$/.test(s)) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}
const trimAll = (s) => s.replace(/^[\s\u0085]+|[\s\u0085]+$/g, '');

class ConvoIndex {
  constructor(root) {
    this.root = root || path.join(os.homedir(), '.claude', 'projects');
    this.files = new Map();     // path -> {sid, project, offset, title, msgs: [{user, time, text, low}]}
    this.refreshing = null;
  }
  snapshot() { return Array.from(this.files.values()); }

  /** Reads what was appended to every transcript. Async: yields to the event loop between files so the main
   *  process keeps answering while a first index of ~150 MB is built. Concurrent calls share one run. */
  refresh() {
    if (this.refreshing) return this.refreshing;
    const run = (async () => {
      {
        const seen = new Set();
        let slice = Date.now();
        let dirs = [];
        try { dirs = fs.readdirSync(this.root); } catch { }
        for (const d of dirs) {
          let names = [];
          try { names = fs.readdirSync(path.join(this.root, d)); } catch { continue; }
          for (const f of names) {
            if (!f.endsWith('.jsonl')) continue;
            const p = path.join(this.root, d, f);
            seen.add(p);
            const file = this.files.get(p) || { path: p, sid: f.slice(0, -6), project: d, offset: 0, title: null, msgs: [] };
            this.read(p, file);
            this.files.set(p, file);
            if (Date.now() - slice > 40) { await new Promise((r) => setImmediate(r)); slice = Date.now(); }
          }
        }
        for (const k of Array.from(this.files.keys())) if (!seen.has(k)) this.files.delete(k);
      }
      return this.files.size;
    })();
    // cleared once settled (a run without a pause would finish before this assignment)
    this.refreshing = run.finally(() => { if (this.refreshing === guarded) this.refreshing = null; });
    const guarded = this.refreshing;
    return this.refreshing;
  }
  /** Synchronous refresh (tests, tools). */
  refreshSync() {
    const seen = new Set();
    let dirs = [];
    try { dirs = fs.readdirSync(this.root); } catch { }
    for (const d of dirs) {
      let names = [];
      try { names = fs.readdirSync(path.join(this.root, d)); } catch { continue; }
      for (const f of names) {
        if (!f.endsWith('.jsonl')) continue;
        const p = path.join(this.root, d, f);
        seen.add(p);
        const file = this.files.get(p) || { path: p, sid: f.slice(0, -6), project: d, offset: 0, title: null, msgs: [] };
        this.read(p, file);
        this.files.set(p, file);
      }
    }
    for (const k of Array.from(this.files.keys())) if (!seen.has(k)) this.files.delete(k);
    return this.files.size;
  }

  /** Appends the records written after `offset` (up to the last full line). Lines are tested as bytes (indexOf on a
   *  subarray): turning every line into a String first took 13 s over 150 MB of transcripts in the Swift app. */
  read(p, f) {
    let fd;
    try { fd = fs.openSync(p, 'r'); } catch { return; }
    let data;
    try {
      const end = fs.fstatSync(fd).size;
      if (end < f.offset) { f.offset = 0; f.title = null; f.msgs = []; }               // rewritten: start over
      if (end <= f.offset) return;
      data = Buffer.allocUnsafe(end - f.offset);
      let got = 0;
      while (got < data.length) { const n = fs.readSync(fd, data, got, data.length - got, f.offset + got); if (!n) break; got += n; }
      data = data.subarray(0, got);
    } catch { return; } finally { fs.closeSync(fd); }
    const lines = [], titles = [];
    // pattern hits, ascending: "custom-title"/"ai-title", "type":"user", "type":"assistant", "type":"text", "tool_use_id"
    const title = hits(data, 0, A_TITLE, (i) => at(data, i - 7, PRE_CUSTOM) || at(data, i - 3, PRE_AI));
    const types = hits(data, 0, A_TYPE, (i) => at(data, i - 2, PRE_T));
    const tUser = types.filter((i) => at(data, i + 6, POST_USER));
    const tAsst = types.filter((i) => at(data, i + 6, POST_ASSISTANT));
    const tText = types.filter((i) => at(data, i + 6, POST_TEXT));
    const tool = hits(data, 0, A_TOOL, (i) => at(data, i - 5, PRE_TOOL));
    const cur = [0, 0, 0, 0, 0];
    const lists = [title, tUser, tAsst, tText, tool];
    /** Whether list k has a hit inside [s, e) (lines come in order, so each list is walked once). */
    const within = (k, s0, e) => {
      const l = lists[k];
      while (cur[k] < l.length && l[cur[k]] < s0) cur[k]++;
      return cur[k] < l.length && l[cur[k]] < e;
    };
    let start = 0;
    while (start < data.length) {
      const nl = data.indexOf(10, start);
      if (nl < 0) break;                                                                 // an unfinished last line: next time
      // tool output and thinking are most of the file and never searched: skipped without parsing
      if (within(0, start, nl)) titles.push(data.subarray(start, nl));
      else if ((within(1, start, nl) && !within(4, start, nl)) || (within(2, start, nl) && within(3, start, nl))) lines.push(data.subarray(start, nl));
      start = nl + 1;
    }
    f.offset += start;
    for (const t of titles) {
      let d; try { d = JSON.parse(t.toString('utf8')); } catch { continue; }
      if (!d || typeof d !== 'object') continue;
      if (typeof d.customTitle === 'string') f.title = d.customTitle;
      else if (f.title == null && typeof d.aiTitle === 'string') f.title = d.aiTitle;
    }
    for (const line of lines) {
      let d; try { d = JSON.parse(line.toString('utf8')); } catch { continue; }
      if (!d || typeof d !== 'object' || typeof d.type !== 'string') continue;
      const msg = d.message;
      if (!msg || typeof msg !== 'object' || Array.isArray(msg) || d.isMeta === true || d.isCompactSummary === true) continue;
      const type = d.type;
      const time = isoDate(d.timestamp);
      let text = '';
      if (type === 'user') {
        let c = null;
        if (typeof msg.content === 'string') c = msg.content;
        else if (Array.isArray(msg.content)) { const b = msg.content.find((x) => x && x.type === 'text'); c = b && typeof b.text === 'string' ? b.text : null; }
        if (c == null || c.startsWith('<')) continue;
        text = unwrapPaste(c);
      } else if (type === 'assistant' && Array.isArray(msg.content)) {
        text = msg.content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n\n');
      }
      text = trimAll(text);
      if (!text) continue;
      f.msgs.push({ user: type === 'user', time, text, low: text.toLowerCase() });
    }
  }

  /** Messages holding every word of the query, newest first. → [{id, sid, path, project, title, index, user, time, text}]
   *  `path` is the hit's transcript: Swift's Hit carries its File, so the preview reads that file even when the same
   *  <sid>.jsonl exists under two project folders. */
  search(q, limit = 300) {
    const words = String(q || '').toLowerCase().split(' ').filter((w) => w);
    if (!words.length) return [];
    const out = [];
    for (const f of this.files.values()) {
      const msgs = f.msgs;
      for (let i = 0; i < msgs.length; i++) {
        const low = msgs[i].low;
        let all = true;
        for (const w of words) if (!low.includes(w)) { all = false; break; }
        if (all) out.push({ f, i });
      }
    }
    out.sort((a, b) => (b.f.msgs[b.i].time ?? -8.64e15) - (a.f.msgs[a.i].time ?? -8.64e15));
    return out.slice(0, limit).map(({ f, i }) => {
      const m = f.msgs[i];
      return { id: f.sid + '#' + i, sid: f.sid, path: f.path, project: f.project, title: f.title, index: i, user: m.user, time: m.time, text: m.text };
    });
  }

  /** The picked message with the messages around it (the preview pane): index ± radius. `key` is the hit's `path` (the
   *  file the hit came from, as Swift's Hit.file) or, for older callers, its session id (the first file with that id). */
  context(key, index, radius = 3) {
    let f = this.files.get(key) || null;
    if (!f) for (const x of this.files.values()) if (x.sid === key) { f = x; break; }
    if (!f || index < 0 || index >= f.msgs.length) return null;
    const msgs = [];
    for (let i = Math.max(0, index - radius); i <= Math.min(f.msgs.length - 1, index + radius); i++) {
      const m = f.msgs[i];
      msgs.push({ index: i, user: m.user, time: m.time, text: m.text });
    }
    return { sid: f.sid, path: f.path, project: f.project, title: f.title, index, msgs };
  }
}

// ── the shared index lives in a worker thread ─────────────────────────────────────────────────────────────────────
// Swift builds and refreshes ConvoIndex on a background queue (the store warms it 15 s after launch); its first build
// reads every transcript (~150 MB). Here the shared index is held by one long-lived worker thread, so the Electron main
// process (IPC, state pushes, the tray) never waits on it. Without worker threads (AB_NO_WORKERS, or a failure) the
// index runs in-process as before.
const wt = (() => { try { return require('worker_threads'); } catch { return null; } })();
if (wt && !wt.isMainThread && wt.workerData && wt.workerData.convoIndex) {
  const ix = new ConvoIndex(wt.workerData.root || undefined);
  wt.parentPort.on('message', async ({ id, op, args }) => {
    let result = null, error = null;
    try {
      if (op === 'refresh') result = await ix.refresh();
      else if (op === 'sessions') result = ix.files.size;
      else if (op === 'search') result = ix.search(...args);
      else if (op === 'context') result = ix.context(...args);
    } catch (e) { error = String((e && e.stack) || e); }
    wt.parentPort.postMessage({ id, result, error });
  });
}

const shared = new ConvoIndex();
let worker = null, workerFailed = false, nextId = 1;
const waiting = new Map();
function useWorker() {
  if (worker) return worker;
  if (workerFailed || !wt || !wt.isMainThread || process.env.AB_NO_WORKERS) return null;
  try {
    worker = new wt.Worker(__filename, { workerData: { convoIndex: true, root: shared.root } });
    worker.on('message', ({ id, result, error }) => {
      const w = waiting.get(id); if (!w) return;
      waiting.delete(id);
      if (!waiting.size && worker) worker.unref();
      if (error) w.reject(new Error(error)); else w.resolve(result);
    });
    const fail = (e) => {
      console.error('[search] index worker stopped; indexing in-process', e || '');
      workerFailed = true; worker = null;
      for (const w of waiting.values()) w.fallback();
      waiting.clear();
    };
    worker.on('error', fail);
    worker.on('exit', (code) => { if (worker) fail(`exit ${code}`); });
    worker.unref();   // idle, it never keeps the app (or a test) alive; ask() refs it while an answer is awaited
  } catch (e) { workerFailed = true; worker = null; }
  return worker;
}
/** Runs op on the worker's index; in-process on the shared index when there is no worker. */
function ask(op, args, local) {
  const w = useWorker();
  if (!w) return Promise.resolve().then(local);
  return new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve, reject, fallback: () => Promise.resolve().then(local).then(resolve, reject) });
    w.ref();
    w.postMessage({ id, op, args });
  });
}

module.exports = {
  ConvoIndex, shared,
  refresh: () => ask('refresh', [], () => shared.refresh()),
  /** Number of indexed sessions ("세션 %@개의 대화를 검색합니다"). */
  sessions: () => ask('sessions', [], () => shared.files.size),
  search: (q, limit) => ask('search', [q, limit], () => shared.search(q, limit)),
  /** context(hit.path, index) — or a session id, for callers that do not pass the path. */
  context: (key, index, radius) => ask('context', [key, index, radius], () => shared.context(key, index, radius)),
};
