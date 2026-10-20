// PathLinks (Format.swift): file paths in chat text ("/home/…/a.png", "~/x/y") become links that open the folder in the
// file manager (a file: its folder, the file selected). A path with a space ends at the space; the link then opens the
// deepest part of it that exists.
//
// The renderer cannot stat files, so existence is asked of the main process in batches (one `sh` that tests each
// candidate and its parents) and cached; texts drawn before the answer arrives are redrawn once it is in
// (usePathLinks). Swift kept at most 4000 cached answers; so does this.
import { html, useState, useEffect } from '../lib.js';
import { act } from './board.js';

// (?<![\p{L}\p{N}._/~-])~?/(?:[\p{L}\p{N}._@%+~#=-]+/)+[\p{L}\p{N}._@%+~#=-]*
const rx = /(?<![\p{L}\p{N}._/~-])~?\/(?:[\p{L}\p{N}._@%+~#=-]+\/)+[\p{L}\p{N}._@%+~#=-]*/gu;

const exists = new Map();      // raw path (as typed, "~" kept) -> {dir: bool} | null (does not exist)
const cache = new Map();       // matched path -> {path, dir} | null (nothing existing) ; undefined = not known yet
const pending = new Set();     // raw paths waiting for the batch
let batchTimer = null;
const subs = new Set();        // redraw callbacks of the views that drew links

/** The parents of a path, deepest first, down to two levels ("/home/x"): the candidates `target` walks. "~" is the
 *  home folder, itself two levels ("/home/x" — Swift expands it before counting), so "~/missing/x" ends at the home
 *  folder: written "~/" (the main process expands "~/", not a bare "~"). */
function ancestors(p) {
  const out = [];
  let u = p.replace(/\/+$/, '') || p;
  for (;;) {
    if (u === '~') { out.push('~/'); break; }      // the home folder itself
    const comps = u.split('/').filter((x) => x && x !== '~').length + (u.startsWith('~/') ? 2 : 0);
    if (comps < 2) break;                          // URL.pathComponents.count >= 3 ("/", "Users", "x")
    out.push(u);
    const i = u.lastIndexOf('/');
    if (i <= 0) break;
    u = u.slice(0, i);
  }
  return out;
}

/** Default resolver: the main process tests each raw path ("~/" expanded) and answers 'd' / 'f' for those that exist. */
let resolver = async (paths) => {
  const r = await act('platform.pathKinds', paths);
  const found = new Map();
  for (const [p, k] of Object.entries(r || {})) found.set(p, { dir: k === 'd' });
  return found;
};

function flush() {
  batchTimer = null;
  const list = [...pending]; pending.clear();
  if (!list.length) return;
  resolver(list).then((found) => {
    for (const p of list) exists.set(p, found.get(p) || null);
    if (exists.size > 4000) exists.clear();
    subs.forEach((f) => f());
  }, () => { for (const p of list) exists.set(p, null); });
}

/** The deepest existing part of the path (at least two levels), {path, dir} — null when none exists, undefined while
 *  the answer is still coming. */
function target(p) {
  if (cache.has(p)) return cache.get(p);
  const anc = ancestors(p);
  let missing = false;
  for (const a of anc) {
    if (!exists.has(a)) { missing = true; if (!pending.has(a)) pending.add(a); }
  }
  if (missing) { if (!batchTimer) batchTimer = setTimeout(flush, 30); return undefined; }
  let found = null;
  for (const a of anc) { const e = exists.get(a); if (e) { found = { path: a, dir: e.dir }; break; } }
  if (cache.size > 4000) cache.clear();
  cache.set(p, found);
  return found;
}

export const PathLinks = {
  /** Ranges of the paths in `s` and what each opens: [{start, end, target: {path, dir}}] (UTF-16 offsets). Only paths
   *  whose folder exists on this machine (paths not checked yet are left out and asked for). */
  find(s) {
    if (!s || !s.includes('/')) return [];
    const out = [];
    rx.lastIndex = 0;
    let m;
    while ((m = rx.exec(s))) {
      let end = m.index + m[0].length;
      while (end > m.index && '.,-:'.includes(s[end - 1])) end--;
      const t = target(s.slice(m.index, end));
      if (t) out.push({ start: m.index, end, target: t });
    }
    return out;
  },
  /** A folder opens in the file manager; a file shows in its folder, selected. The main process expands "~/" itself
   *  (platform.openPathLink), so the first click on a "~/" link needs no home folder known here. */
  open(t) {
    if (!t) return;
    act('platform.openPathLink', t.path);
  },
  /** The text split into strings and link vnodes (the same links on rendered text). `key` keeps keys unique. */
  link(s, key = '') {
    const found = PathLinks.find(s);
    if (!found.length) return [s];
    const out = [];
    let at = 0;
    found.forEach((f, i) => {
      if (f.start > at) out.push(s.slice(at, f.start));
      out.push(html`<a key=${key + 'p' + i} class="path-link" href="#" title=${f.target.path}
        onClick=${(e) => { e.preventDefault(); e.stopPropagation(); PathLinks.open(f.target); }}>${s.slice(f.start, f.end)}</a>`);
      at = f.end;
    });
    if (at < s.length) out.push(s.slice(at));
    return out;
  },
  /** The paths (as given) that exist now: Promise<Set>. FileManager.fileExists for views that must decide on files. */
  async exists(paths) {
    if (!paths.length) return new Set();
    const found = await resolver(paths);
    return new Set(paths.filter((p) => found.has(p)));
  },
  /** Dev fixtures: answer existence without the main process. fn(paths[]) → Promise<Map(raw → {dir})>. */
  setResolver(fn) { resolver = fn; exists.clear(); cache.clear(); },
};

/** Redraws the calling view when path answers arrive (texts drawn before them get their links). */
export function usePathLinks() {
  const [, tick] = useState(0);
  useEffect(() => { const f = () => tick((n) => n + 1); subs.add(f); return () => subs.delete(f); }, []);
}
