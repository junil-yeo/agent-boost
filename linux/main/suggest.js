// Port of Suggest.swift, main-process side: the prompt history (~/.claude/history.jsonl) and the "@" palette's file
// listing. The per-keystroke logic (HistoryCompleter, HistoryNav, Suggest.next, FileIndex.filter, MentionController)
// lives in renderer/logic/suggest.mjs; this module loads that same file and re-exports it, and hands the renderer the
// data (history items, ↑/↓ list, file lists).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { L } = require('./l10n');

/** Loads a dependency-free ES module of renderer/logic as plain functions (one source for renderer and main). */
function loadPure(file) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'logic', file), 'utf8');
  const names = [];
  const body = src.replace(/^export\s+(async\s+function|function|class|const|let)\s+([A-Za-z_$][\w$]*)/gm, (_m, kind, name) => { names.push(name); return `${kind} ${name}`; });
  return new Function(body + '\nreturn { ' + names.join(', ') + ' };')();   // eslint-disable-line no-new-func
}
const pure = loadPure('suggest.mjs');
pure.setL(L);

// ── prompt history (~/.claude/history.jsonl) ──────────────────────────────────────────────
// Every prompt the user ever typed into a Claude Code session, as the CLI records it (newest last).
// Feeds the ↑/↓ history of the composer and the inline completion ("fish"-style ghost text).

const historyPath = () => path.join(os.homedir(), '.claude', 'history.jsonl');
let items = [];       // {text, at (epoch ms), sessionId, project}
let itemsStamp = '';

function stamp() {
  try { const s = fs.statSync(historyPath()); return `${s.size}|${s.mtimeMs / 1000}`; } catch { return '-1|0'; }
}
/** Only the file's tail is parsed (the last ~600 KB: a few thousand prompts), newest last. */
function parse() {
  let buf;
  try {
    const fd = fs.openSync(historyPath(), 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const limit = 600000;
      const from = size > limit ? size - limit : 0;
      buf = Buffer.alloc(size - from);
      let got = 0;
      while (got < buf.length) { const n = fs.readSync(fd, buf, got, buf.length - got, from + got); if (!n) break; got += n; }
      buf = buf.subarray(0, got);
    } finally { fs.closeSync(fd); }
  } catch { return []; }
  const out = [];
  let start = 0;
  while (start < buf.length) {
    let nl = buf.indexOf(10, start);
    if (nl < 0) nl = buf.length;
    if (nl > start) {
      let d = null;
      try { d = JSON.parse(buf.toString('utf8', start, nl)); } catch { }
      if (d && typeof d === 'object' && typeof d.display === 'string' && d.display) {
        out.push({
          text: d.display,
          at: typeof d.timestamp === 'number' ? d.timestamp : null,
          sessionId: typeof d.sessionId === 'string' ? d.sessionId : null,
          project: typeof d.project === 'string' ? d.project : null,
        });
      }
    }
    start = nl + 1;
  }
  if (out.length > 3000) out.splice(0, out.length - 3000);
  return out;
}
/** The history items (newest last), re-read when the file changed. */
function load() {
  const now = stamp();
  if (now !== itemsStamp) { items = parse(); itemsStamp = now; }
  return items;
}
/** Everything the composer needs from the history: the items for its HistoryCompleter (only when the file changed
 *  since `knownStamp`, else null: the renderer keeps one completer, rebuilt only when the file changes) and the
 *  ↑/↓ list for one session. → {stamp, items|null, nav} */
function prepare(sessionId, cwd, knownStamp) {
  const all = load();
  return { stamp: itemsStamp, items: knownStamp === itemsStamp ? null : all, nav: pure.navigation(all, sessionId, cwd ?? null) };
}

// ── "@" file mention: files under the agent's folder (relative paths, cached per folder) ─

const fileCache = new Map();   // cwd -> {at, items}
const SKIP = new Set(['node_modules', '.git', '.build', 'build', 'dist', 'target', 'Pods', 'DerivedData', '.next', '__pycache__', '.venv', 'venv', '.DS_Store']);

function cachedFiles(cwd) { const h = fileCache.get(cwd); return h ? h.items : null; }
/** The folder's files from a 30 s cache, else scanned now. */
function loadFiles(cwd) {
  const hit = fileCache.get(cwd);
  if (hit && Date.now() - hit.at < 30000) return hit.items;
  const list = scan(cwd);
  fileCache.set(cwd, { at: Date.now(), items: list });
  return list;
}
/** Depth-first walk (hidden files skipped, junk folders skipped, folders 7 levels down listed but not entered),
 *  at most 6000 entries; folders end with "/". Sorted shortest first. */
function scan(cwd) {
  const out = [];
  const walk = (dir, rel, level) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (out.length >= 6000) return;
      const name = e.name;
      if (name.startsWith('.')) continue;            // skipsHiddenFiles
      if (SKIP.has(name)) continue;
      const isDir = e.isDirectory();
      const r = rel ? rel + '/' + name : name;
      out.push(r + (isDir ? '/' : ''));
      if (out.length >= 6000) return;
      if (isDir && level < 7) walk(path.join(dir, name), r, level + 1);
    }
  };
  walk(path.resolve(cwd), '', 1);
  const n = (s) => pure.charCount(s);
  return out.sort((a, b) => { const d = n(a) - n(b); return d || (a < b ? -1 : a > b ? 1 : 0); });
}
/** MentionController's loader: refuses folders too broad to list (and holding protected folders). */
function files(cwd) {
  if (!cwd) return [];
  const p = path.resolve(cwd);
  const home = os.homedir();
  if (p === '/' || p === home || p === '/Users' || p === '/home') return [];
  return loadFiles(cwd);
}

module.exports = {
  // PromptHistory
  load, prepare, parse, stamp,
  navigation: (all, sessionId, cwd) => pure.navigation(all, sessionId, cwd),
  // Suggest
  next: (entries, agent) => pure.next(entries, agent),
  // FileIndex / MentionController data
  files, loadFiles, cachedFiles, scan,
  filter: (all, query, limit) => pure.filterFiles(all, query, limit),
  // the pure classes, for main-side users and tests
  HistoryCompleter: pure.HistoryCompleter, HistoryNav: pure.HistoryNav, MentionController: pure.MentionController,
  charCount: pure.charCount,
};
