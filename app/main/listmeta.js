// Metadata for the 세션 목록 tab, read cheaply: what the CLI's `claude --resume` picker shows for a conversation
// (created, last modified, message count, project folder, git branch, title) without parsing the whole transcript.
//  - head (first 64 KB): created (the first record's timestamp), cwd, git branch, a stored title, the first prompt;
//  - tail (last 64 KB): the newest title and git branch, the last timestamp;
//  - message count: user + assistant records, counted by a byte scan of complete lines in the background (one file at
//    a time, 4 MB reads), continued from where it stopped when the file grows.
// Cached per file by size + mtime in ~/.agent-boost/session-list.json, so a long history is read once and then only
// what was appended. The per-file transcript parsing (transcript.js) is untouched: this module never parses records
// into the chat.
const fs = require('fs');
const os = require('os');
const path = require('path');
const Shell = require('./shell');
const Only = require('./only');

const HEAD = 65536, TAIL = 65536, CHUNK = 4 * 1024 * 1024;

function filePath() {
  if (process.env.AB_LISTMETA_FILE) return process.env.AB_LISTMETA_FILE;
  if (Only.active()) return path.join(Only.dataDir(), 'session-list.json');
  if (process.env.AB_READONLY) return path.join(os.tmpdir(), 'agent-boost-readonly', 'session-list.json');
  return path.join(Shell.home, '.agent-boost', 'session-list.json');
}

let cache = null;            // path -> entry
let dirty = false, saveTimer = null;
let version = 0;             // bumped whenever an entry changed (the snapshot carries it; the list asks again)
let onChange = null;
function load() {
  if (cache) return cache;
  cache = {};
  try { const j = JSON.parse(fs.readFileSync(filePath(), 'utf8')); if (j && typeof j === 'object' && !Array.isArray(j)) cache = j; } catch { }
  return cache;
}
/** An entry changed: save soon; `visible` = the list shows something new (the version moves). */
function touch(visible = true) {
  dirty = true;
  if (visible) { version += 1; if (onChange) { try { onChange(); } catch { } } }
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; save(); }, 3000);
  if (saveTimer.unref) saveTimer.unref();
}
function save() {
  if (!dirty || !cache) return;
  dirty = false;
  for (const k of Object.keys(cache)) if (!fs.existsSync(k)) delete cache[k];   // vanished transcripts
  const p = filePath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(cache)); fs.renameSync(tmp, p);
  } catch (e) { console.error('[listmeta] save', e.message); }
}

// ── reading ───────────────────────────────────────────────────────────────────────────────────────────────────────
const stampOf = (st) => `${st.size}|${Math.trunc(st.mtimeMs)}`;
function readRangeSync(p, from, n) {
  let fd; try {
    fd = fs.openSync(p, 'r'); const b = Buffer.allocUnsafe(n); const got = fs.readSync(fd, b, 0, n, from); return b.subarray(0, got);
  } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { } }
}
async function readRange(p, from, n) {
  let fh; try {
    fh = await fs.promises.open(p, 'r'); const b = Buffer.allocUnsafe(n); const { bytesRead } = await fh.read(b, 0, n, from); return b.subarray(0, bytesRead);
  } catch { return null; } finally { if (fh) await fh.close().catch(() => { }); }
}
/** A JSON string value written by the CLI ("key":"…"), all matches in order. */
function stringValues(text, key) {
  const re = new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(text))) { try { out.push(JSON.parse(`"${m[1]}"`)); } catch { } }
  return out;
}
const ts = (s) => { const t = Date.parse(s); return Number.isNaN(t) ? null : t; };
/** created: the first timestamp in the head (the CLI stamps nearly every record; the first is when the conversation
 *  began). Escaped quotes inside message text never match, so only real keys count. */
function createdFromHead(text) { for (const v of stringValues(text, 'timestamp')) { const t = ts(v); if (t != null) return t; } return null; }
/** The first thing the user asked (the /resume picker's name for an untitled conversation), as transcript.js reads it. */
function firstPromptFromHead(text) {
  for (const line of text.split('\n')) {
    if (!line.includes('"type":"user"')) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (!d || d.type !== 'user' || d.isMeta === true || !d.message) continue;
    const c = d.message.content;
    const raw = typeof c === 'string' ? c : Array.isArray(c) ? (c.find((b) => b && b.type === 'text' && typeof b.text === 'string') || {}).text : null;
    if (typeof raw !== 'string') continue;
    const r = raw.replace(/<[/\\]?pasted_content[^>]*>\n?/g, '').trim();
    if (r.startsWith('<') || r.startsWith('/')) continue;
    const first = r.split('\n').map((x) => x.trim()).find((x) => x);
    if (first) return first.length > 120 ? first.slice(0, 120) : first;
  }
  return null;
}
const last = (a) => (a.length ? a[a.length - 1] : null);

/** Head + tail of a file into an entry (128 KB at most, read off the main thread's way: async). */
async function readEnds(p, st, e) {
  const head = await readRange(p, 0, Math.min(HEAD, st.size));
  const tail = st.size > HEAD ? await readRange(p, Math.max(0, st.size - TAIL), Math.min(TAIL, st.size)) : null;
  const h = head ? head.toString('utf8') : '', t = tail ? tail.toString('utf8') : '';
  if (e.created == null) e.created = createdFromHead(h) ?? fileBirth(st);
  e.cwd = stringValues(h, 'cwd')[0] ?? last(stringValues(t, 'cwd')) ?? null;
  e.branch = last(stringValues(t, 'gitBranch')) ?? last(stringValues(h, 'gitBranch')) ?? null;
  e.customTitle = last(stringValues(t, 'customTitle')) ?? last(stringValues(h, 'customTitle')) ?? null;
  e.aiTitle = last(stringValues(t, 'aiTitle')) ?? last(stringValues(h, 'aiTitle')) ?? null;
  e.firstPrompt = firstPromptFromHead(h);
  e.lastAt = Math.trunc(st.mtimeMs);
  e.stamp = stampOf(st);
}
const fileBirth = (st) => (st.birthtimeMs > 0 ? Math.trunc(st.birthtimeMs) : Math.trunc(st.mtimeMs));

/** When the conversation was created (ms), from the cache or the file's head; null when the file is unreadable.
 *  Used for the pin rule on every refresh, so it is synchronous and read once per file (16 KB, 64 KB when the first
 *  records carry no timestamp). */
function created(p) {
  const c = load();
  const e = c[p];
  if (e && e.created != null) return e.created;
  let st; try { st = fs.statSync(p); } catch { return null; }
  let t = null;
  for (const n of [16384, HEAD]) {
    const head = readRangeSync(p, 0, Math.min(n, st.size));
    t = createdFromHead(head ? head.toString('utf8') : '');
    if (t != null || st.size <= n) break;
  }
  const n = c[p] || { count: null, countOffset: 0 };
  n.created = t ?? fileBirth(st);
  c[p] = n; touch(false);
  return n.created;
}

/** The list metadata of a file as far as it is known now: the cached entry (null for a file never seen). A file that
 *  changed since is read again in the background (head/tail first, then the message count from where it stopped);
 *  the version moves when the answer lands. `count` is null until it is known. */
function meta(p) {
  const c = load();
  let st; try { st = fs.statSync(p); } catch { return null; }
  const e = c[p];
  if (e && e.stamp === stampOf(st)) { if (e.count == null || e.countOffset < st.size) queue(p, 'count'); return e; }
  queue(p, 'ends');
  return e || null;
}
async function refreshEnds(p) {
  let st; try { st = await fs.promises.stat(p); } catch { return; }
  const c = load();
  const e = c[p] || { count: null, countOffset: 0, created: null };
  if (e.stamp === stampOf(st)) return;
  if (e.countOffset > st.size) { e.count = null; e.countOffset = 0; e.created = null; }   // replaced, not appended
  await readEnds(p, st, e);
  c[p] = e; touch();
  queue(p, 'count');
}

// ── message count: complete lines holding a user or assistant record ─────────────────────────────────────────────
const NU = Buffer.from('"type":"user"'), NA = Buffer.from('"type":"assistant"');
/** Lines of `buf` (complete lines only) that hold a user / assistant record, and where the complete lines end. */
function countLines(buf) {
  const end = buf.lastIndexOf(10) + 1;          // bytes after the last newline belong to a line still being written
  let n = 0, pos = 0, iu = -2, ia = -2;
  while (pos < end) {
    if (iu !== -1 && iu < pos) iu = buf.indexOf(NU, pos);
    if (ia !== -1 && ia < pos) ia = buf.indexOf(NA, pos);
    const k = iu < 0 ? ia : ia < 0 ? iu : Math.min(iu, ia);
    if (k < 0 || k >= end) break;
    n += 1;
    const nl = buf.indexOf(10, k);
    pos = nl < 0 ? end : nl + 1;
  }
  return { n, end };
}
// one background worker: head/tail reads first (they name the rows), counts after
const endsQ = [], countQ = [];
const queued = new Set();
let working = false;
function queue(p, kind) {
  const k = kind + '|' + p;
  if (queued.has(k)) return;
  queued.add(k); (kind === 'ends' ? endsQ : countQ).push(p);
  if (!working) run();
}
async function run() {
  working = true;
  while (endsQ.length || countQ.length) {
    const kind = endsQ.length ? 'ends' : 'count';
    const p = (kind === 'ends' ? endsQ : countQ).shift();
    queued.delete(kind + '|' + p);
    try { if (kind === 'ends') await refreshEnds(p); else await countFile(p); } catch (e) { console.error('[listmeta]', kind, e.message); }
  }
  working = false;
}
async function countFile(p) {
  const e = load()[p];
  if (!e) return;
  let size; try { size = (await fs.promises.stat(p)).size; } catch { return; }
  if (e.countOffset > size) { e.countOffset = 0; e.count = null; }
  let off = e.countOffset || 0, n = e.count || 0, chunk = CHUNK;
  while (off < size) {
    const buf = await readRange(p, off, Math.min(chunk, size - off));
    if (!buf || !buf.length) break;
    const r = countLines(buf);
    if (r.end === 0) {                            // one line longer than the chunk (an inline image): read more
      if (off + buf.length >= size) break;        // the last line is still being written
      chunk *= 2; continue;
    }
    n += r.n; off += r.end; chunk = CHUNK;
  }
  if (e.count !== n || e.countOffset !== off) { e.count = n; e.countOffset = off; touch(); }
}

module.exports = {
  filePath, created, meta, countLines, createdFromHead, firstPromptFromHead,
  version: () => version,
  setOnChange: (f) => { onChange = f; },
  /** Resolves when every queued count is done (tests). */
  idle: async () => { while (working || endsQ.length || countQ.length) await new Promise((r) => setTimeout(r, 20)); },
  /** Writes the cache now (tests; the app saves 3 s after a change). */
  flush: () => { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } dirty = true; save(); },
  _reset: () => { cache = null; version = 0; endsQ.length = 0; countQ.length = 0; queued.clear(); },
};
