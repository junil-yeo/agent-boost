// Pure logic of Suggest.swift that the composer needs per keystroke: prompt-history completion (HistoryCompleter),
// ↑/↓ history (HistoryNav, navigation), the next-step suggestion (Suggest.next), the "@" palette's fuzzy file filter
// (FileIndex.filter) and its controller (MentionController). No Node or DOM APIs: the renderer imports it as an ES
// module, main/suggest.js loads the very same file; main provides the data (history items, file lists).

let tr = (k, ...args) => { let i = 0; return k.replace(/%@/g, (m) => (i < args.length ? String(args[i++]) : m)); };
/** Installs the translation function (renderer: lib.js's L, main: l10n.js's L). */
export function setL(fn) { tr = fn; }

// Swift counts Characters (grapheme clusters); a UTF-16 length is never smaller, so it is a cheap first test.
let seg = null;
/** Number of user-perceived characters (Swift's String.count). */
export function charCount(s) {
  if (!/[^\u0000-˿]/.test(s)) return s.length;          // plain Latin text: one unit per character
  if (!seg && typeof Intl !== 'undefined' && Intl.Segmenter) seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  if (!seg) return Array.from(s).length;
  let n = 0; for (const _ of seg.segment(s)) n++;            // eslint-disable-line no-unused-vars
  return n;
}
const longerThan = (s, n) => s.length > n && charCount(s) > n;

// ── prompt history ────────────────────────────────────────────────────────────────────────

/** Prompts for ↑/↓: this session first, then the same folder, then everything — newest first, no repeats.
 *  all: history items {text, at, sessionId, project}, newest last. */
export function navigation(all, sessionId, cwd) {
  const seen = new Set(), out = [];
  const take = (pred) => {
    for (let k = all.length - 1; k >= 0; k--) {
      const it = all[k];
      if (!pred(it)) continue;
      const t = it.text;
      if (longerThan(t, 4000)) continue;
      if (!seen.has(t)) { seen.add(t); out.push(t); }
    }
  };
  take((it) => it.sessionId === sessionId);
  if (cwd != null) take((it) => it.project === cwd);
  take(() => true);
  return out.slice(0, 500);
}

/** Prefix completion over the prompt history, cheap enough to run on every keystroke: the candidates are lowercased
 *  once when the history loads, and while the user keeps typing the same word only the previous matches are searched. */
export class HistoryCompleter {
  constructor() { this.cands = []; this.lastPrefix = ''; this.lastMatches = []; this.lastAnswer = null; }
  /** items: history items, newest last. */
  set(items) {
    const seen = new Set(), out = [];                           // newest first, one line, no repeats
    for (let k = items.length - 1; k >= 0; k--) {
      const it = items[k], t = it.text;
      if (longerThan(t, 300) || t.includes('\n') || seen.has(t)) continue;
      seen.add(t);
      out.push({ lower: t.toLowerCase(), text: t, project: it.project ?? null });
    }
    this.cands = out; this.lastPrefix = ''; this.lastMatches = []; this.lastAnswer = null;
  }
  /** Newest earlier prompt that begins with what was typed (≥ 2 characters, one line, longer than the typed text);
   *  the same folder wins over others. */
  complete(prefix, cwd) {
    if (charCount(prefix) < 2 || prefix.includes('\n') || !this.cands.length) return null;
    const key = prefix + '\u001f' + (cwd ?? '');
    if (this.lastAnswer && this.lastAnswer.key === key) return this.lastAnswer.value;   // the view asks several times per keystroke
    const p = prefix.toLowerCase();
    const base = this.lastPrefix && p.startsWith(this.lastPrefix) ? this.lastMatches : this.cands.map((_, i) => i);
    // a strict prefix that is longer (in UTF-16 units, which for a prefix means longer in bytes too)
    const matches = base.filter((i) => { const l = this.cands[i].lower; return l.length > p.length && l.startsWith(p); });
    this.lastPrefix = p; this.lastMatches = matches;
    let pick = matches.find((i) => cwd != null && this.cands[i].project === cwd);
    if (pick === undefined) pick = matches[0];
    const value = pick === undefined ? null : this.cands[pick].text;
    this.lastAnswer = { key, value };
    return value;
  }
}

// ── ↑/↓ history of the composer ───────────────────────────────────────────────────────────

/** Walks earlier prompts into the draft (↑ older, ↓ newer; past the newest the typed text comes back).
 *  up/down/cancel return {handled, draft}. */
export class HistoryNav {
  constructor(items = []) { this.items = items; this.pos = -1; this.saved = ''; }   // items newest first; pos -1: not browsing
  get active() { return this.pos >= 0; }
  up(draft) {
    if (!(this.pos + 1 < this.items.length)) return { handled: this.items.length > 0, draft };
    if (this.pos < 0) this.saved = draft;
    this.pos += 1;
    return { handled: true, draft: this.items[this.pos] };
  }
  down(draft) {
    if (this.pos < 0) return { handled: false, draft };
    this.pos -= 1;
    return { handled: true, draft: this.pos >= 0 ? this.items[this.pos] : this.saved };
  }
  /** The user edited the text: stop browsing. */
  noteEdit(draft) { if (this.pos >= 0 && draft !== this.items[this.pos]) this.pos = -1; }
  cancel(draft) {
    if (this.pos < 0) return { handled: false, draft };
    this.pos = -1;
    return { handled: true, draft: this.saved };
  }
}

// ── next-step suggestion from the conversation ────────────────────────────────────────────

const trimAll = (s) => s.replace(/^[\s　]+|[\s　]+$/g, '');
const trimSpaces = (s) => s.replace(/^[^\S\n\r\u2028\u2029\u0085]+|[^\S\n\r\u2028\u2029\u0085]+$/g, '');
const ASKS = ['할까요', '드릴까요', '할까', '원하시면', '원하면', '괜찮을까요', '진행할까요', 'Should I', 'Would you like', 'Do you want', 'Shall I', 'Want me to', 'Let me know'];

let memo = null;   // same conversation tail and state as the last call: same answer (the composer asks on every keystroke)
/** What the user most likely wants to type next, read off the end of the conversation (the CLI shows its own
 *  suggestion the same way: dimmed in the box, Tab fills it). Only offered when the turn is over.
 *  entries: chat entries {id, role, text, toolName, isThinking, isError}; agent: {sessionId, state, canReceiveInput}. */
export function next(entries, agent) {
  if (agent.state !== 'idle' || !agent.canReceiveInput) return null;
  const last = entries[entries.length - 1];
  const key = `${agent.sessionId}|${entries.length}|${last ? last.id : ''}|${last ? last.toolName ?? '' : ''}`;
  if (memo && memo.key === key) return memo.value;
  const v = compute(entries);
  memo = { key, value: v };
  return v;
}
function compute(entries) {
  const L = tr;
  // the turn must have ended with the agent speaking (nothing of mine after it, nothing still being sent)
  let lastIdx = -1;
  for (let k = entries.length - 1; k >= 0; k--) {
    const e = entries[k];
    if (e.role === 'user' || (e.role === 'assistant' && !e.isThinking) || e.role === 'tool') { lastIdx = k; break; }
  }
  if (lastIdx < 0 || entries[lastIdx].role === 'user' || entries.some((e) => e.toolName === '전송 중')) return null;
  const tail = entries.slice(-12);
  let lastSpoken = null;
  for (let k = tail.length - 1; k >= 0; k--) if (tail[k].role === 'assistant' && !tail[k].isThinking) { lastSpoken = tail[k]; break; }
  if (lastSpoken) {
    const text = trimAll(lastSpoken.text);
    const lines = text.split('\n').map(trimSpaces).filter((l) => l);
    const end = lines.slice(-4).join(' ');
    const asks = end.endsWith('?') || end.endsWith('？') || ASKS.some((a) => end.includes(a));
    const numbered = lines.filter((l) => /^\d+[.)]\s/.test(l)).length >= 2;
    if (asks) {
      if (numbered) return L('1번으로 진행해 주세요');
      const low = end.toLowerCase();
      if (low.includes('커밋') || low.includes('commit')) return L('네, 커밋해 주세요');
      if (low.includes('테스트') || low.includes('test')) return L('네, 테스트까지 돌려 주세요');
      if (low.includes('삭제') || low.includes('지울까') || low.includes('delete') || low.includes('remove')) return L('네, 지워 주세요');
      return L('네, 그렇게 진행해 주세요');
    }
    if (lines.length >= 8 && tail.some((e) => e.role === 'tool' && e.toolName !== '결과')) return L('변경한 내용을 한 번 더 점검하고 문제 없으면 마무리해 주세요');
  }
  let lastTool = null;
  for (let k = tail.length - 1; k >= 0; k--) if (tail[k].role === 'tool') { lastTool = tail[k]; break; }
  if (lastTool && lastTool.isError && tail[tail.length - 1].role === 'tool') return L('오류 원인을 찾아 고쳐 주세요');
  return null;
}

// ── "@" file mention ──────────────────────────────────────────────────────────────────────

/** Loose subsequence match: every character of q appears in l in order. */
function subsequence(q, l) {
  const a = Array.from(l);
  let k = 0;
  for (const ch of q) {
    while (k < a.length && a[k] !== ch) k++;
    if (k >= a.length) return false;
    k++;
  }
  return true;
}
/** FileIndex.filter: basename prefix first, then path substring, then a loose subsequence; shorter paths win ties. */
export function filterFiles(all, query, limit = 14) {
  const q = query.toLowerCase();
  if (!q) return all.slice(0, limit);
  const score = (p) => {
    const l = p.toLowerCase();
    const parts = (l.endsWith('/') ? l.slice(0, -1) : l).split('/').filter((x) => x);
    const base = parts.length ? parts[parts.length - 1] : l;
    if (base.startsWith(q)) return 0;
    if (base.includes(q)) return 1;
    if (l.includes(q)) return 2;
    if (charCount(q) < 3) return null;
    return subsequence(q, l) ? 3 : null;
  };
  const scored = [];
  for (const p of all) { const r = score(p); if (r !== null) scored.push({ path: p, rank: r, n: charCount(p) }); }
  scored.sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.n - b.n));
  return scored.slice(0, limit).map((x) => x.path);
}

const isWS = (ch) => /\s/.test(ch);

/** State of the "@" palette: the trailing "@word" of the draft is the query; Tab/Enter replace it with "@path ".
 *  loader(cwd) → Promise<string[]> (main: suggest.files(cwd)); onChange() is called when the file list arrives. */
export class MentionController {
  constructor(loader, onChange) {
    this.loader = loader; this.onChange = onChange || (() => {});
    this.index = 0; this.files = []; this.dismissedFor = null;
    this.loadedCwd = null; this.wantCwd = null;
  }
  /** Only remembers the folder: the scan runs when "@" is first typed. Scanning on every open cost the main thread a
   *  6000-item publish, and a session working in "/" or ~ walked into Desktop / Documents (macOS permission popups). */
  reload(cwd) {
    if (this.wantCwd !== cwd) { this.files = []; this.loadedCwd = null; }
    this.wantCwd = cwd;
  }
  loadIfNeeded() {
    const cwd = this.wantCwd;
    if (!cwd || this.loadedCwd === cwd) return;
    this.loadedCwd = cwd;
    // main refuses folders too broad to list ("/", home, /Users, /home) and answers from its 30 s cache
    Promise.resolve(this.loader(cwd)).then((items) => {
      if (this.loadedCwd === cwd) { this.files = items || []; this.onChange(); }
    }, () => {});
  }
  /** The "@…" token being typed at the end of the draft (preceded by start / whitespace): its start index, or -1. */
  token(draft) {
    const at = draft.lastIndexOf('@');
    if (at < 0) return -1;
    if (at > 0 && !isWS(draft[at - 1])) return -1;
    if (/\s/.test(draft.slice(at + 1))) return -1;
    return at;
  }
  items(draft) {
    const at = this.token(draft);
    if (this.dismissedFor === draft || at < 0) return [];
    if (this.loadedCwd !== this.wantCwd) setTimeout(() => this.loadIfNeeded(), 0);
    return filterFiles(this.files, draft.slice(at + 1));
  }
  dismiss(draft) { this.dismissedFor = draft; }
  /** The draft with the token replaced by "@path " (a folder keeps going: no space). */
  pick(p, draft) {
    const at = this.token(draft);
    if (at < 0) return draft;
    this.index = 0;
    return draft.slice(0, at) + '@' + p + (p.endsWith('/') ? '' : ' ');
  }
  /** Key handling. key: 'ArrowDown' | 'ArrowUp' | 'Escape' | 'Tab' | 'Enter'. Returns {consumed, draft}. */
  handle(key, shift, draft) {
    const list = this.items(draft);
    const no = { consumed: false, draft };
    if (!list.length) return no;
    const i = Math.min(this.index, list.length - 1);
    switch (key) {
      case 'ArrowDown': this.index = (i + 1) % list.length; return { consumed: true, draft };
      case 'ArrowUp': this.index = (i - 1 + list.length) % list.length; return { consumed: true, draft };
      case 'Escape': this.dismiss(draft); return { consumed: true, draft };
      case 'Tab': if (shift) return no; return { consumed: true, draft: this.pick(list[i], draft) };
      case 'Enter': if (shift) return no; return { consumed: true, draft: this.pick(list[i], draft) };
      default: return no;
    }
  }
}
