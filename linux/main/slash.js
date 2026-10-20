// The non-UI part of SlashPalette.swift: the "/" catalog (built-ins + custom commands and skills read from disk, cached
// per folder for 30 s) and SlashRouter (typed commands the app handles itself).
// The pure logic (catalog, filter, palette keys, routing rules) lives in renderer/logic/slash.mjs so the palette can use
// it per keystroke without an IPC round trip; this module loads that same file.
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
const pure = loadPure('slash.mjs');
pure.setL(L);

const home = () => os.homedir();

// ── custom commands and skills (cached per folder) ────────────────────────────────────────
const cache = new Map();   // cwd ('' for none) -> { at: ms, items }

function cached(cwd) {
  const hit = cache.get(cwd || '');
  return hit ? hit.items : null;
}
/** Fresh enough (< 30 s) → the cached list; otherwise the folder is scanned again. */
function load(cwd) {
  const key = cwd || '';
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 30000) return hit.items;
  const items = scan(cwd);
  cache.set(key, { at: Date.now(), items });
  return items;
}

function scan(cwd) {
  const h = path.join(home(), '.claude');
  let out = [];
  out = out.concat(commands(path.join(h, 'commands'), 'user'));
  out = out.concat(skills(path.join(h, 'skills'), 'skill'));
  if (cwd && cwd !== home()) {
    out = out.concat(commands(path.join(cwd, '.claude', 'commands'), 'project'));
    out = out.concat(skills(path.join(cwd, '.claude', 'skills'), 'skill'));
  }
  const seen = new Set(pure.builtin().map((c) => c.name));
  const uniq = [];
  for (const c of out) if (!seen.has(c.name)) { seen.add(c.name); uniq.push(c); }
  return uniq.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Every *.md under the folder (recursively, like FileManager's enumerator): "a/b.md" becomes "/a:b". */
function walk(dir, rel, out) {
  let ents;
  try { ents = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) walk(dir, r, out);
    else out.push(r);
  }
}
function commands(dir, source) {
  const rels = [];
  walk(dir, '', rels);
  const out = [];
  for (const rel of rels) {
    if (!rel.endsWith('.md')) continue;
    const name = rel.slice(0, -3).split('/').join(':');
    const fm = frontmatter(path.join(dir, rel));
    out.push(pure.command(name, fm.desc ?? L('사용자 정의 명령'), { argHint: fm.hint, source }));
  }
  return out;
}
function skills(dir, source) {
  let subs;
  try { subs = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const d of subs) {
    if (d.startsWith('.')) continue;
    const p = path.join(dir, d, 'SKILL.md');
    if (!fs.existsSync(p)) continue;
    const fm = frontmatter(p);
    out.push(pure.command(fm.name ?? d, fm.desc ?? L('스킬'), { argHint: fm.hint, source }));
  }
  return out;
}

/** Bytes cut mid-character at the end of a read are dropped (a complete UTF-8 prefix). */
function utf8Prefix(buf) {
  let end = buf.length;
  let k = end - 1, n = 0;
  while (k >= 0 && n < 4 && (buf[k] & 0xC0) === 0x80) { k--; n++; }
  if (k >= 0) {
    const b = buf[k];
    const need = b >= 0xF0 ? 4 : b >= 0xE0 ? 3 : b >= 0xC0 ? 2 : 1;
    if (need > n + 1) end = k;
  }
  return buf.subarray(0, end);
}
const trimWS = (s) => s.replace(/^[ \t  - 　]+|[ \t  - 　]+$/g, '');

/** name / description / argument-hint from the file's YAML front matter (first 4 KB). */
function frontmatter(p) {
  const none = { name: null, desc: null, hint: null };
  let buf;
  try {
    const fd = fs.openSync(p, 'r');
    try { buf = Buffer.alloc(4096); buf = buf.subarray(0, fs.readSync(fd, buf, 0, 4096, 0)); } finally { fs.closeSync(fd); }
  } catch { return none; }
  let s;
  try { s = new TextDecoder('utf-8', { fatal: true }).decode(utf8Prefix(buf)); } catch { return none; }
  if (!s.startsWith('---')) return none;
  let name = null, desc = null, hint = null;
  const lines = s.split('\n').slice(1);
  for (const l of lines) {
    if (l.startsWith('---')) break;
    const val = (k) => {
      if (!l.startsWith(k + ':')) return null;
      let v = trimWS(l.slice(k.length + 1));
      if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) v = v.slice(1, -1);
      return !v || v === '>' || v === '|' ? null : v;
    };
    let v;
    if ((v = val('name')) !== null) name = v;
    if ((v = val('description')) !== null) desc = v;
    if ((v = val('argument-hint')) !== null) hint = v;
  }
  if (desc !== null) { const a = Array.from(desc); if (a.length > 140) desc = a.slice(0, 140).join('') + '…'; }
  return { name, desc, hint };
}

// ── SlashRouter ───────────────────────────────────────────────────────────────────────────

/** Typed slash commands the app already implements itself go through the same path as its buttons.
 *  Returns true when the app handled the command (the composer then clears the draft). */
function route(text, sid) {
  const act = pure.routeAction(text);
  if (!act) return false;
  const store = require('./store');
  // commands the user typed show as their bubble
  if (typeof store.setUserInitiated === 'function') store.setUserInitiated(true);
  try {
    switch (act.action) {
      case 'setModel': store.setModel(act.model, sid); return true;
      case 'setEffort': store.setEffort(act.effort, sid); return true;
      case 'rename': store.rename(sid, act.name); return true;
      default: return false;
    }
  } finally {
    if (typeof store.setUserInitiated === 'function') store.setUserInitiated(false);
  }
}

module.exports = {
  // catalog
  builtin: () => pure.builtin(),
  isTerminalOnly: (text) => pure.isTerminalOnly(text),
  filter: (all, query) => pure.filter(all, query),
  cached, load, scan, frontmatter,
  // router
  route, routeAction: (text) => pure.routeAction(text),
  MODEL_CHOICES: pure.MODEL_CHOICES, EFFORT_CHOICES: pure.EFFORT_CHOICES,

};
