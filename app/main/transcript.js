// Port of TranscriptReader.swift: reads a session transcript (~/.claude/projects/<proj>/<sid>.jsonl) incrementally —
// keeps a byte offset per file and only parses lines appended since the last read.
// (ToolLine.swift is a view only — one tool call as a quiet single line — and has no parsing logic to port here.)
//
// Snapshot (plain JSON except seenMessageIds, a Set kept inside this module):
//   {model, effort, last (epoch ms), customTitle, aiTitle, firstPrompt, lastTurnEnded, tokens {input, cacheWrite,
//    cacheRead, output}, lastContext, entries [ChatEntry], offset, entriesLoaded, truncated, version}
// ChatEntry: {id, role: 'user'|'assistant'|'tool'|'system'|'peer', text, toolName, time (epoch ms|null), isThinking, isError}
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { L } = require('./l10n');

/** How much of a file the caller needs. `skip`: tokens/model only (ended, unfocused); `light`: entries with long
 *  text cut (unfocused, live); `full`: complete entries (the focused session). */
const Mode = { skip: 1, light: 2, full: 3 };
const lightLimit = 4096;
const modeOf = (m) => (typeof m === 'number' ? m : Mode[m] || Mode.full);

/** ModelChoice raw values and labels (Models.swift). */
const MODEL_CHOICES = [
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];

const readonly = () => !!process.env.AB_READONLY;
const uuid = () => crypto.randomUUID().toUpperCase();

function newSnapshot() {
  return {
    model: null, effort: null, last: null,
    customTitle: null, aiTitle: null,
    firstPrompt: null,             // the first thing the user asked: the CLI's /resume picker names untitled conversations by it
    lastTurnEnded: false,
    tokens: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
    lastContext: 0,                // input + cache tokens of the newest assistant request: how full the context is
    entries: [],
    seenMessageIds: new Set(),
    offset: 0,
    entriesLoaded: false,
    truncated: false,              // some entry text was cut (unfocused): a focused read re-parses
    version: 0,                    // bumped whenever new lines were ingested: cheap change detection for the chat
  };
}
function cloneSnapshot(s) {
  return { ...s, tokens: { ...s.tokens }, entries: s.entries.slice(), seenMessageIds: new Set(s.seenMessageIds) };
}

// ── small string helpers (Swift semantics) ───────────────────────────────────────────────

/** ISO8601DateFormatter with .withInternetDateTime + .withFractionalSeconds: a timestamp without fractional seconds
 *  does not parse (null), as in the Swift app. */
function isoDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+(Z|[+-]\d\d:?\d\d)$/.test(s)) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}
const WS = '[ \\t\\u00A0\\u1680\\u2000-\\u200A\\u202F\\u205F\\u3000]';
const reTrimWS = new RegExp(`^${WS}+|${WS}+$`, 'g');
const reTrimAll = new RegExp(`^(?:${WS}|[\\n\\r\\u000B\\u000C\\u0085\\u2028\\u2029])+|(?:${WS}|[\\n\\r\\u000B\\u000C\\u0085\\u2028\\u2029])+$`, 'g');
/** trimmingCharacters(in: .whitespaces) */
const trimWS = (s) => s.replace(reTrimWS, '');
/** trimmingCharacters(in: .whitespacesAndNewlines) */
const trimAll = (s) => s.replace(reTrimAll, '');
let seg = null;
/** String(s.prefix(n)): the first n Characters (grapheme clusters). */
function prefixChars(s, n) {
  if (s.length <= n) return s;
  if (!/[^\u0000-\u02FF]/.test(s.slice(0, n + 1))) return s.slice(0, n);
  if (!seg) seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let k = 0, end = 0;
  for (const g of seg.segment(s)) { if (k === n) break; end = g.index + g.segment.length; k++; }
  return s.slice(0, end);
}
const isStr = (v) => typeof v === 'string';
const isInt = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0);
/** First text block's text of a message content (string, or a list of blocks: text + image). */
function firstText(content) {
  if (isStr(content)) return content;
  if (Array.isArray(content)) {
    const b = content.find((x) => x && x.type === 'text');
    return b && isStr(b.text) ? b.text : null;
  }
  return null;
}

// ── the reader ───────────────────────────────────────────────────────────────────────────

class TranscriptReader {
  constructor() {
    this.files = new Map();          // path -> Snapshot
    // A file's first read never blocks the caller: the focused session gets its own immediate worker, the rest a
    // small queue (2 at a time); callers use peek() (cached / tail-scanned metadata) until `done`.
    this.warming = new Set();
    this.levels = new Map();         // path -> Mode reached (0 = never read)
    this.triedAt = new Map();
    this.tried = new Map();          // path -> "size|mtime" of the last read attempt: unchanged = do not retry
    this.holdPaths = new Set();      // files whose reader scrolled up: keep older rows past the cap
    this.recentFull = [];            // most recently focused files stay .full (re-focus must not re-parse)
    this.queue = [];                 // pending background warms (not focused)
    this.running = 0;
    // metadata shown before a file is parsed (model, tokens of the previous run)
    this.meta = {};
    this.metaLoaded = false;
    this.metaDirty = false;
    this.saveScheduled = false;
    this.metaPath = path.join(os.homedir(), '.agent-boost', 'transcript-meta.json');
  }

  setHoldCap(h, p) { if (h) this.holdPaths.add(p); else this.holdPaths.delete(p); }

  static stamp(p) {
    try { const s = fs.statSync(p); return `${s.size}|${s.mtimeMs / 1000}`; } catch { return '-1|0'; }
  }

  /** Keeps the last few focused files at .full. */
  effective(p, mode) {
    mode = modeOf(mode);
    if (mode === Mode.full) {
      this.recentFull = this.recentFull.filter((x) => x !== p);
      this.recentFull.push(p);
      if (this.recentFull.length > 5) this.recentFull.shift();
      return Mode.full;
    }
    return this.recentFull.includes(p) ? Mode.full : mode;
  }

  /** True when the file must be (re)parsed in the background first; callers use peek() meanwhile and `done` runs
   *  when the parse is in. */
  needsWarm(p, mode, done) {
    mode = modeOf(mode);
    const st = TranscriptReader.stamp(p);
    if (this.warming.has(p)) return true;
    if ((this.levels.get(p) || 0) >= mode) return false;                                  // loaded at this level
    // a failed try at this level with the file unchanged: still not parsed here (the caller would parse inline), but
    // do not retry a broken file more than every 30 s. Only failures count: a successful light read used to count
    // too, so selecting that session waited up to 30 s for its full conversation.
    const key = st + '|' + mode;
    if (this.tried.get(p) === key && this.triedAt.has(p) && Date.now() - this.triedAt.get(p) < 30000) return true;
    this.warming.add(p);
    const job = { p, mode, st, key, done };
    if (mode === Mode.full) this.runWarm(job, true);
    else { this.queue.push(job); this.pump(); }
    return true;
  }
  pump() {
    while (this.running < 2 && this.queue.length) this.runWarm(this.queue.shift(), false);
  }
  runWarm(job, immediate) {
    if (!immediate) this.running++;
    const finish = (res) => {
      if (res) this.commit(job.p, res.st, res.size);
      this.warming.delete(job.p);
      if ((this.levels.get(job.p) || 0) >= job.mode) { this.tried.delete(job.p); this.triedAt.delete(job.p); }
      else { this.tried.set(job.p, job.key); this.triedAt.set(job.p, Date.now()); }
      if (!immediate) { this.running--; this.pump(); }
      if (job.done) { try { job.done(); } catch (e) { console.error(e); } }
    };
    const base = this.files.get(job.p) || newSnapshot();
    const hold = this.holdPaths.has(job.p);
    warmInWorker(job.p, job.mode, base, hold).then(finish, () => {
      // no worker available: parse here, after the caller has moved on
      setImmediate(() => { let r = null; try { r = readInto(cloneSnapshot(base), job.p, job.mode, hold); } catch (e) { console.error(e); } finish(r); });
    });
  }

  // ── metadata shown before a file is parsed ─────────────────────────────────────────────
  loadMeta() {
    if (this.metaLoaded) return;
    this.metaLoaded = true;
    try { const m = JSON.parse(fs.readFileSync(this.metaPath, 'utf8')); if (m && typeof m === 'object') this.meta = m; } catch { }
  }
  /** Debounced (2 s) write; vanished transcripts are dropped. */
  saveMeta() {
    if (this.saveScheduled) return;
    this.saveScheduled = true;
    setTimeout(() => {
      this.saveScheduled = false;
      if (!this.metaDirty) return;
      this.metaDirty = false;
      const live = {};
      for (const k of Object.keys(this.meta)) { if (fs.existsSync(k)) live[k] = this.meta[k]; else delete this.meta[k]; }
      if (readonly()) { console.log('[readonly] transcript.saveMeta'); return; }
      try {
        fs.mkdirSync(path.dirname(this.metaPath), { recursive: true });
        const tmp = this.metaPath + '.tmp-' + process.pid;
        fs.writeFileSync(tmp, JSON.stringify(live));
        fs.renameSync(tmp, this.metaPath);
      } catch (e) { console.error('transcript meta', e.message); }
    }, 2000).unref?.();
  }

  /** What can be shown while the file is not parsed yet: a finished snapshot, else the last run's numbers, else the
   *  file tail's model. */
  peek(p) {
    this.loadMeta();
    const f = this.files.get(p);
    if (f) return f;
    const s = newSnapshot();
    const m = this.meta[p];
    if (m) {
      s.model = m.model ?? null; s.effort = m.effort ?? null;
      s.tokens = { input: isInt(m.input), cacheWrite: isInt(m.cw), cacheRead: isInt(m.cr), output: isInt(m.out) };
      s.last = typeof m.last === 'number' ? m.last * 1000 : null;
      s.lastContext = isInt(m.ctx);
    }
    if (s.model == null) {                         // last 64KB: the newest assistant record names the model
      const tail = readTail(p, 65536);
      if (tail) {
        const lines = tail.toString('utf8').split('\n');
        for (let k = lines.length - 1; k >= 0; k--) {
          const line = lines[k];
          if (!line || !line.includes('"model"')) continue;
          let d; try { d = JSON.parse(line); } catch { continue; }
          const mm = d && d.message && d.message.model;
          if (isStr(mm) && mm !== '<synthetic>') { s.model = mm; break; }
        }
      }
    }
    return s;
  }

  snapshot(p, mode) {
    mode = modeOf(mode);
    const base = this.files.get(p) || newSnapshot();
    const r = readInto(cloneSnapshot(base), p, mode, this.holdPaths.has(p));
    if (!r) return base;
    return this.commit(p, r.st, r.size);
  }
  /** Stores a read's result: level reached, and the metadata kept for the next launch. */
  commit(p, st, size) {
    const level = !st.entriesLoaded ? Mode.skip : (st.truncated ? Mode.light : Mode.full);
    this.files.set(p, st);
    this.levels.set(p, size === 0 ? Mode.full : level);
    this.loadMeta();
    const m = { model: st.model ?? undefined, effort: st.effort ?? undefined, input: st.tokens.input, cw: st.tokens.cacheWrite, cr: st.tokens.cacheRead, out: st.tokens.output, last: st.last != null ? st.last / 1000 : undefined, ctx: st.lastContext };
    if (!metaEqual(this.meta[p], m)) { this.meta[p] = JSON.parse(JSON.stringify(m)); this.metaDirty = true; this.saveMeta(); }
    return st;
  }
}
function metaEqual(a, b) {
  if (!a) return false;
  for (const k of ['model', 'effort', 'input', 'cw', 'cr', 'out', 'last', 'ctx']) if ((a[k] ?? null) !== (b[k] ?? null)) return false;
  return true;
}

function readTail(p, n) {
  let fd;
  try { fd = fs.openSync(p, 'r'); } catch { return null; }
  try {
    const size = fs.fstatSync(fd).size;
    const from = size > n ? size - n : 0;
    return readRange(fd, from, size);
  } catch { return null; } finally { fs.closeSync(fd); }
}
function readRange(fd, from, to) {
  const buf = Buffer.allocUnsafe(Math.max(0, to - from));
  let got = 0;
  while (got < buf.length) { const k = fs.readSync(fd, buf, got, buf.length - got, from + got); if (!k) break; got += k; }
  return buf.subarray(0, got);
}

/** Reads what was appended to `p` since st.offset into st (re-parsing from the start when needed). Pure apart from the
 *  file read: runs in a worker for background warms. Returns {st, size}, or null when the file cannot be opened. */
function readInto(st, p, mode, hold) {
  const wantEntries = mode !== Mode.skip;
  let fd;
  try { fd = fs.openSync(p, 'r'); } catch { return null; }
  let size;
  try {
    size = fs.fstatSync(fd).size;
    if (size < st.offset) st = newSnapshot();
    const needFull = (wantEntries && !st.entriesLoaded) || (mode === Mode.full && st.truncated);
    if (size === 0 && wantEntries) st.entriesLoaded = true;                              // empty file = empty conversation
    if (size > st.offset || (needFull && size > 0)) {
      if (needFull) { st.offset = 0; st.seenMessageIds = new Set(); st.tokens = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }; st.entries = []; st.truncated = false; }
      const data = readRange(fd, st.offset, size);
      let consumed = 0, start = 0;
      for (;;) {
        const i = data.indexOf(10, start);
        if (i < 0) break;
        consumed = i + 1;
        const before = st.entries.length;
        if (i > start) ingest(data.toString('utf8', start, i), st, wantEntries);
        start = i + 1;
        if (mode === Mode.light) {
          for (let k = before; k < st.entries.length; k++) {
            const e = st.entries[k];
            if (e.text.length > lightLimit / 4 && Buffer.byteLength(e.text) > lightLimit) { e.text = prefixChars(e.text, lightLimit) + '…'; st.truncated = true; }
          }
        }
      }
      st.offset += consumed;
      if (consumed > 0) st.version = (st.version + 1) | 0;
      if (wantEntries) st.entriesLoaded = true;
      else if (consumed > 0) { st.entriesLoaded = false; st.entries = []; }            // lines went by unrecorded: rebuild on focus, no gap
    }
  } finally { fs.closeSync(fd); }
  const cap = hold ? 3000 : 600;
  if (st.entries.length > cap) st.entries.splice(0, st.entries.length - cap);           // one cap for every kind of entry
  return { st, size };
}

// ── parsing ──────────────────────────────────────────────────────────────────────────────

/** Splits Claude's relayed `<teammate-message teammate_id="…">…</teammate-message>` blocks;
 *  idle notifications become a short status line. → [{from, text}] */
function teammateMessages(s) {
  const re = /<teammate-message[^>]*teammate_id="([^"]+)"[^>]*>([\s\S]*?)<\/teammate-message>/g;
  const out = [];
  let m;
  while ((m = re.exec(s))) {
    let body = trimAll(m[2]);
    if (body.startsWith('{')) {
      let j = null; try { j = JSON.parse(body); } catch { }
      if (j && typeof j === 'object' && !Array.isArray(j)) {
        const kind = isStr(j.type) ? j.type : '';
        const result = isStr(j.result) ? j.result : isStr(j.message) ? j.message : '';
        body = kind === 'idle_notification' ? L('⏸ 대기 중') + (result ? ' — ' + result : '') : (result ? result : kind);
      }
    }
    out.push({ from: m[1], text: body });
  }
  return out;
}

function tag(name, s) {
  const a = s.indexOf(`<${name}>`);
  if (a < 0) return null;
  const from = a + name.length + 2;
  const b = s.indexOf(`</${name}>`, from);
  if (b < 0) return null;
  return s.slice(from, b);
}
const stripANSI = (s) => s.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, '');
function entry(id, role, text, o = {}) {
  return { id, role, text, toolName: o.toolName ?? null, time: o.time ?? null, isThinking: !!o.isThinking, isError: !!o.isError };
}

/** A slash command the user ran (shown as their bubble) or its output (a small ⎿ line; stderr is a warning). */
function appendLocal(s, id, time, st) {
  const add = (e) => {
    const l = st.entries[st.entries.length - 1];
    if (l && l.role === e.role && l.text === e.text && l.toolName === e.toolName) return;   // same record seen twice
    st.entries.push(e);
  };
  const nameTag = tag('command-name', s);
  const name = nameTag == null ? '' : trimAll(nameTag);
  if (name) {
    const args = trimAll(tag('command-args', s) ?? '');
    add(entry(id, 'user', args ? name + ' ' + args : name, { time }));
  }
  for (const [t, kind] of [['local-command-stdout', 'stdout'], ['local-command-stderr', 'stderr']]) {
    const o = tag(t, s);
    if (o != null) {
      const text = trimAll(stripANSI(o));
      if (text) add(entry(id + '-' + kind, 'system', text, { toolName: kind, time }));
    }
  }
}

function noteSetting(c, st) {
  const plain = stripANSI(c);
  const e = plain.match(/Set effort level to ([a-z]+)/);
  if (e) { const parts = e[0].split(' ').filter((x) => x); st.effort = parts[parts.length - 1] || ''; }
  let r = plain.indexOf('Set model to'), len = 'Set model to'.length;
  if (r < 0) { r = plain.indexOf('Kept model as'); len = 'Kept model as'.length; }
  if (r < 0) return;
  const rest = prefixChars(plain.slice(r + len), 80);
  const m = rest.match(/claude-[a-z]+-[0-9][0-9a-z\-[\]]*/);
  if (m) { st.model = m[0]; return; }
  // display name ("`Sonnet 5.5 (default)`"): the model it names
  const low = rest.toLowerCase();
  const c2 = MODEL_CHOICES.find((x) => low.includes(x.label.toLowerCase()));
  if (c2) st.model = c2.id;
}

/** A message typed while a tool ran is recorded once as queued; if the user then interrupts, the CLI submits it again
 *  on a new branch. Keep only the later copy. The CLI's own "[Request interrupted …]" record is a notice, not my words. */
function addUser(text, id, time, st) {
  if (text.startsWith('[Request interrupted')) {
    st.entries.push(entry(id, 'system', text.includes('tool use') ? L('중단됨 — 도구 실행을 멈췄습니다') : L('중단됨'), { toolName: 'auto', time }));
    return;
  }
  if (time != null) {
    const lo = Math.max(0, st.entries.length - 30);
    for (let k = st.entries.length - 1; k >= lo; k--) {
      const e = st.entries[k];
      // a missing time is .distantPast: never within 120 s
      if (e.role === 'user' && e.text === text && e.time != null && (time - e.time) / 1000 < 120) { st.entries.splice(k, 1); break; }
    }
  }
  st.entries.push(entry(id, 'user', text, { time }));
}

function ingest(line, st, wantEntries) {
  let d;
  try { d = JSON.parse(line); } catch { return; }
  if (!d || typeof d !== 'object' || Array.isArray(d) || !isStr(d.type)) return;
  const type = d.type;
  if (type === 'custom-title' && isStr(d.customTitle)) { st.customTitle = d.customTitle; return; }
  if (type === 'ai-title' && isStr(d.aiTitle)) { st.aiTitle = d.aiTitle; return; }
  // a message typed while a turn runs and taken in mid-turn ("absorbed_mid_turn") gets no user record, only this
  // attachment: without it the message vanished from the chat once its "전송 중" row expired
  const att = d.attachment;
  if (type === 'attachment' && att && typeof att === 'object' && att.type === 'queued_command') {
    if (!wantEntries || (isStr(att.commandMode) ? att.commandMode : 'prompt') !== 'prompt') return;
    let pr = null;
    if (isStr(att.prompt)) pr = att.prompt;
    else if (Array.isArray(att.prompt)) pr = att.prompt.filter((b) => b && b.type === 'text' && isStr(b.text)).map((b) => b.text).join('\n');
    if (pr != null && trimAll(pr) && !pr.startsWith('<')) {
      addUser(unwrapPaste(pr), isStr(d.uuid) ? d.uuid : uuid(), isoDate(d.timestamp), st);
    }
    return;
  }
  const msg0 = d.message && typeof d.message === 'object' && !Array.isArray(d.message) ? d.message : null;
  // "/effort low" → "Set effort level to low …", "/model …" → "Set model to … (claude-…)": the session changed now,
  // long before the next assistant record carries the new value
  if (type === 'system' && d.subtype === 'local_command' && isStr(d.content)) noteSetting(d.content, st);
  if (type === 'user' && msg0 && isStr(msg0.content) && msg0.content.includes('<local-command-stdout>')) noteSetting(msg0.content, st);
  if (type === 'system' && wantEntries && d.subtype === 'local_command' && isStr(d.content)) {
    appendLocal(d.content, isStr(d.uuid) ? d.uuid : uuid(), isoDate(d.timestamp), st);
    return;
  }
  if ((type !== 'user' && type !== 'assistant') || !msg0) return;
  const msg = msg0;
  const ts = isoDate(d.timestamp);
  const id = isStr(d.uuid) ? d.uuid : uuid();
  st.lastTurnEnded = type === 'assistant' && msg.stop_reason === 'end_turn';
  if (type === 'user' && st.firstPrompt == null && d.isMeta !== true) {
    const raw = firstText(msg.content);
    if (raw != null) {
      const r = unwrapPaste(raw);
      if (!r.startsWith('<') && !r.startsWith('/')) {
        const first = r.split('\n').map(trimWS).find((x) => x);
        if (first) st.firstPrompt = first;
      }
    }
  }
  if (type === 'assistant') {
    if (isStr(msg.model) && msg.model !== '<synthetic>') st.model = msg.model;
    if (isStr(d.effort)) st.effort = d.effort;
    st.last = ts ?? st.last;
    const mid = isStr(msg.id) ? msg.id : isStr(d.requestId) ? d.requestId : id;
    const u = msg.usage;
    if (!st.seenMessageIds.has(mid) && u && typeof u === 'object' && !Array.isArray(u)) {
      st.seenMessageIds.add(mid);
      st.tokens.input += isInt(u.input_tokens);
      st.tokens.cacheWrite += isInt(u.cache_creation_input_tokens);
      st.tokens.cacheRead += isInt(u.cache_read_input_tokens);
      st.tokens.output += isInt(u.output_tokens);
      st.lastContext = isInt(u.input_tokens) + isInt(u.cache_creation_input_tokens) + isInt(u.cache_read_input_tokens);
    }
  }
  if (!wantEntries) return;
  if (d.isMeta === true) return;
  if (isStr(msg.content)) {
    const s = msg.content;
    // slash commands and their output become a user line / small ⎿ lines (appendLocal)
    if (s.startsWith('<command-name>') || s.startsWith('<local-command') || s.startsWith('<command-message>')) {
      if (!s.startsWith('<local-command-caveat>')) appendLocal(s, id, ts, st);
      return;
    }
    if (type === 'user' && s.includes('<teammate-message')) {
      teammateMessages(s).forEach((m, i) => st.entries.push(entry(`${id}-tm${i}`, 'peer', m.text, { toolName: m.from, time: ts })));
      return;
    }
    if (type === 'user' && s) addUser(unwrapPaste(s), id, ts, st);
    return;
  }
  if (!Array.isArray(msg.content)) return;
  msg.content.forEach((b, i) => {
    if (!b || typeof b !== 'object') return;
    const bid = `${id}-${i}`;
    switch (b.type) {
      case 'text': {
        if (type === 'user' && isStr(b.text) && b.text.includes('<teammate-message')) {
          teammateMessages(b.text).forEach((m, k) => st.entries.push(entry(`${bid}-tm${k}`, 'peer', m.text, { toolName: m.from, time: ts })));
          break;
        }
        if (isStr(b.text) && trimAll(b.text)) {
          if (type === 'user') addUser(unwrapPaste(b.text), bid, ts, st);
          else st.entries.push(entry(bid, 'assistant', b.text, { time: ts }));
        }
        break;
      }
      case 'thinking':
        if (isStr(b.thinking) && b.thinking) st.entries.push(entry(bid, 'assistant', b.thinking, { time: ts, isThinking: true }));
        break;
      case 'tool_use': {
        const name = isStr(b.name) ? b.name : 'tool';
        let summary = '';
        const input = b.input;
        if (input && typeof input === 'object' && !Array.isArray(input)) {
          summary = [input.command, input.file_path, input.description, input.prompt].find(isStr) ?? '';
        }
        st.entries.push(entry(bid, 'tool', summary, { toolName: name, time: ts }));
        break;
      }
      case 'tool_result': {
        let text = '';
        if (isStr(b.content)) text = b.content;
        else if (Array.isArray(b.content)) text = b.content.filter((x) => x && isStr(x.text)).map((x) => x.text).join('\n');
        text = trimAll(text);
        if (text) {
          const head = prefixChars(text, 80).toLowerCase();
          const failed = b.is_error === true || head.startsWith('error') || head.startsWith('fatal')
            || (head.includes('denied') && [...head].length < 80 && !head.includes('\n') && head.startsWith('permission'));
          st.entries.push(entry(bid, 'tool', prefixChars(text, 1200), { toolName: '결과', time: ts, isError: failed }));
        }
        break;
      }
      default: break;
    }
  });
}

/** Pasted text is recorded inside <pasted_content id="…"> … </pasted_content id="…"> marks: show only the text. */
function unwrapPaste(s) {
  if (s.includes('pasted_content')) s = s.replace(/<[/\\]?pasted_content[^>]*>\n?/g, '');
  // "[첨부 파일]" lists (the board's, or one pasted inside a message): images became "[Image #n]" elsewhere, leaving bare
  // "-" lines; files keep a path. Each list becomes "📎 name" lines, or nothing.
  const mark = '[첨부 파일]\n';
  for (;;) {
    const r = s.indexOf(mark);
    if (r < 0) break;
    let end = r + mark.length;
    const names = [];
    while (end < s.length && s[end] === '-') {
      let lineEnd = s.indexOf('\n', end);
      if (lineEnd < 0) lineEnd = s.length;
      const item = trimWS(s.slice(end + 1, lineEnd));
      if (item) { const parts = item.split('/').filter((x) => x); names.push('📎 ' + (parts.length ? parts[parts.length - 1] : item)); }
      end = lineEnd < s.length ? lineEnd + 1 : lineEnd;
    }
    let start = r;
    while (start > 0 && s[start - 1] === '\n') start--;
    s = s.slice(0, start) + (names.length ? '\n' + names.join('\n') + '\n' : '\n') + s.slice(end);
  }
  return trimAll(s);
}

/** The newest answer: the assistant's text since my last message, read from the file's tail (on demand, ~1 ms). */
function lastAnswer(p) { const r = recentAnswers(p, 1); return r.length ? r[0].answer : ''; }

/** The last `count` answers, newest first, each with the message it answers ([{asked, answer}]). Read only when asked
 *  (a button press): the file's last 600 KB, or 4 MB when long tool outputs left fewer turns than asked for in that. */
function recentAnswers(p, count = 5) {
  let fd;
  try { fd = fs.openSync(p, 'r'); } catch { return []; }
  try {
    const size = fs.fstatSync(fd).size;
    let out = [];
    for (const win of [600000, 4000000]) {
      const lines = readRange(fd, size > win ? size - win : 0, size).toString('utf8').split('\n');
      out = [];
      let parts = [];
      for (let k = lines.length - 1; k >= 0; k--) {
        const l = lines[k];
        if (!l) continue;
        let d; try { d = JSON.parse(l); } catch { continue; }
        if (!d || typeof d !== 'object' || !isStr(d.type) || !d.message || typeof d.message !== 'object' || Array.isArray(d.message)) continue;
        const type = d.type, msg = d.message;
        // my message: the answer starts after it. A slash command's records (<command-name>, <local-command-stdout>, …)
        // are user records too; a /model run after the answer made the answer look empty, so they are passed over.
        // So is the summary a compaction leaves: it read as my message with no answer after it.
        // A message with images is a list of blocks (text + image), not a string: it counts too.
        if (type === 'user' && d.isMeta !== true && d.isCompactSummary !== true) {
          const c = firstText(msg.content);
          if (c == null || c.startsWith('<')) continue;
          if (parts.length) out.push({ asked: unwrapPaste(c), answer: parts.slice().reverse().join('\n\n') });
          parts = [];
          if (out.length >= count) return out;
          continue;
        }
        if (type !== 'assistant' || !Array.isArray(msg.content)) continue;
        for (let j = msg.content.length - 1; j >= 0; j--) {
          const b = msg.content[j];
          if (b && b.type === 'text' && isStr(b.text) && b.text) parts.push(b.text);
        }
      }
      if (parts.length && out.length < count) out.push({ asked: '', answer: parts.slice().reverse().join('\n\n') });   // the window began mid-answer
      if (size <= win) break;
    }
    return out;
  } catch { return []; } finally { fs.closeSync(fd); }
}

// ── background parsing in a worker thread ────────────────────────────────────────────────
let WorkerCtor = null;
try { WorkerCtor = require('worker_threads').Worker; } catch { }
function warmInWorker(p, mode, base, hold) {
  return new Promise((resolve, reject) => {
    if (!WorkerCtor || process.env.AB_NO_WORKERS) { reject(new Error('no workers')); return; }
    let w;
    try { w = new WorkerCtor(__filename, { workerData: { transcriptWarm: true, p, mode, base, hold } }); } catch (e) { reject(e); return; }
    let settled = false;
    w.once('message', (r) => { settled = true; resolve(r); w.terminate(); });
    w.once('error', (e) => { if (!settled) { settled = true; reject(e); } });
    w.once('exit', () => { if (!settled) { settled = true; reject(new Error('worker exited')); } });
  });
}
{
  const wt = (() => { try { return require('worker_threads'); } catch { return null; } })();
  if (wt && !wt.isMainThread && wt.workerData && wt.workerData.transcriptWarm) {
    const { p, mode, base, hold } = wt.workerData;
    let r = null;
    try { r = readInto(base, p, mode, hold); } catch { r = null; }
    wt.parentPort.postMessage(r);
  }
}

// ── module API: the shared reader (the store's `reader`) plus the static helpers ─────────
const shared = new TranscriptReader();
module.exports = {
  Mode, TranscriptReader, shared, MODEL_CHOICES,
  snapshot: (p, mode) => shared.snapshot(p, mode),
  peek: (p) => shared.peek(p),
  effective: (p, mode) => shared.effective(p, mode),
  needsWarm: (p, mode, done) => shared.needsWarm(p, mode, done),
  setHoldCap: (h, p) => shared.setHoldCap(h, p),
  teammateMessages, unwrapPaste, lastAnswer, recentAnswers,
  // internals for tests
  _ingest: ingest, _newSnapshot: newSnapshot, _readInto: readInto, _isoDate: isoDate,
};
