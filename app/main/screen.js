// Port of ScreenDetect.swift (Screen, ScreenStatus, PromptDriver).
//
// Reads Claude Code's TUI from a capture-pane dump. Everything is judged by POSITION, never by a string appearing
// anywhere: the conversation may quote "esc to interrupt" or "Compiling… (12s)" and the session is still idle.
//
// Layout (bottom of the screen):
//     … conversation …
//     ✻ Crafting… (2s · thinking)      <- spinner line, only while a turn runs (a to-do list may sit between it and the box)
//     hint line(s)
//     ─────────────────────            <- input box top rule
//     ❯                                <- input
//     ─────────────────────            <- input box bottom rule
//       ⏸ manual mode on · esc to interrupt     <- status line ("esc to in…" when narrow)
//
// Notes on the port: Swift's `.whitespaces` is tab + Unicode Zs (it includes the no-break space), so trimWS() trims
// exactly that (not newlines). Swift counts Characters; here code points are counted ([...s].length), which is the same
// for every text the CLI draws. Swift's split(separator:) drops empty pieces; splitNE() does the same.

/** Trims tab and Unicode space separators (Swift's CharacterSet.whitespaces). */
function trimWS(s) { return s.replace(/^[\t\p{Zs}]+|[\t\p{Zs}]+$/gu, ''); }
/** split(separator:) with omittingEmptySubsequences (Swift's default). */
function splitNE(s, sep) { return s.split(sep).filter((x) => x.length > 0); }
function firstChar(s) { for (const c of s) return c; return undefined; }
function count(s) { return [...s].length; }
function lastIndex(arr, pred, end = arr.length) { for (let i = end - 1; i >= 0; i--) if (pred(arr[i])) return i; return -1; }

function clean(text) {
  return splitNE(text, '\n').map((l) => {
    let t = trimWS(l);
    if (t.startsWith('│')) t = trimWS(t.slice(1));
    return t;
  }).filter((t) => t.length > 0);
}
/** The input box's rules (and the legacy ╭/╰ box edges). */
function isInputRule(t) { return t.startsWith('────────') || t.startsWith('╭') || t.startsWith('╰'); }
/** Any rule, including the dashed ╌ lines that frame permission previews. */
function isAnyRule(t) { return isInputRule(t) || t.startsWith('╌╌╌╌╌╌╌╌') || t.startsWith('▔▔▔▔▔▔▔▔'); }
const spinnerStart = new Set([...'✽✳✶✢✻✷✸✹·*⎿']);

/** A status-line segment that is a (possibly cut) "esc to interrupt": "esc to interrupt", "esc to in…", "esc t…", "esc …". */
function statusSaysInterrupt(line) {
  return splitNE(line, '·').some((seg) => {
    let t = trimWS(seg);
    while (t.endsWith('…') || t.endsWith('.')) t = t.slice(0, -1);
    t = trimWS(t);
    return count(t) >= 3 && 'esc to interrupt'.startsWith(t);
  });
}

/** The index of the top rule of the input box: the rule before the bottom one when at most 6 lines above it, else bottom. */
function boxTop(rules, bottom) {
  if (rules.length >= 2) { const prev = rules[rules.length - 2]; if (bottom - prev <= 6) return prev; }
  return bottom;
}

function busy(text) {
  const ls = clean(text);
  const rules = ls.map((_, i) => i).filter((i) => isInputRule(ls[i]));
  if (rules.length === 0) return false;
  const bottom = rules[rules.length - 1];
  if (ls.slice(bottom + 1, bottom + 4).some(statusSaysInterrupt)) return true;
  const top = boxTop(rules, bottom);
  // the spinner sits above the input box, possibly with a to-do list ("⎿ ☐ …") and hints between: look up to 12 lines, never past another rule
  let from = top;
  while (from > 0 && top - from < 12 && !isInputRule(ls[from - 1])) from -= 1;
  return ls.slice(from, top).some((l) => {
    const f = firstChar(l);
    if (f === undefined || !spinnerStart.has(f)) return false;
    return /…\s*\(\d+\s*[smh]/u.test(l);
  });
}

/** A permission / choice prompt waits for the user. Only the block below the last rule counts, so a long diff preview
 *  cannot push the options out of range and old answers in the scrollback cannot trigger it. */
function needsInput(text) {
  if (busy(text)) return false;
  const ls = clean(text);
  if (isAgentList(ls)) return false;
  const r = lastIndex(ls, isAnyRule);
  const block = r >= 0 ? ls.slice(r + 1) : ls.slice(-12);
  const b = block.slice(-30);
  const numbered = (t) => /^(❯|>)?\s*\d+\.\s/u.test(t);
  const idle = (t) => isInputRule(t) || t.includes('? for shortcuts') || t === '❯' || t === '>';
  const last = lastIndex(b, numbered);
  if (last < 0) {
    // un-numbered list ("❯ No, exit" / "Yes, I trust …"): a ❯ line with options under it
    const c = lastIndex(b, (t) => t.startsWith('❯ '));
    if (c < 0 || c + 1 >= b.length) return false;
    return !b.slice(c + 1).some(idle);
  }
  if (b.slice(last + 1).some(idle)) return false;
  if (b.some((t) => /^❯\s*\d+\.\s/u.test(t))) return true;
  const joined = b.join('\n').toLowerCase();
  return b.filter(numbered).length >= 2 && (joined.includes('do you want') || joined.includes('esc to cancel') || joined.includes('would you like'));
}

/** The teammate list the CLI draws under its footer ("⏺ main" / "◯ teammate1  … ready and idle" / "↓ 3 more"):
 *  rows to pick an agent to view, not a question to answer. */
function isAgentList(ls) {
  const tail = ls.slice(-14);
  const rows = tail.filter((t) => t.startsWith('◯ ') || t.startsWith('⏺ main') || t.startsWith('● main') || t.startsWith('❯ ⏺') || t.startsWith('❯ ◯'));
  return rows.length >= 2;
}
/** Claude's "Switch model?" confirmation (shown by /model when the conversation is cached for the current model) with the
 *  cursor on "1. Yes, switch to …". Matched exactly so no other prompt is ever mistaken for it. */
function isSwitchModelPrompt(text) {
  const b = clean(text).slice(-14);
  return b.some((t) => t === 'Switch model?')
    && b.some((t) => t.startsWith('❯ 1. Yes, switch to '))
    && b.some((t) => t.startsWith('2. No, go back'));
}

/** Title, explanation, preview and options of the choice window on screen (null when no prompt waits).
 *  PromptInfo = {title, detail|null, preview|null, options: [string], cursor, numbered}. */
function prompt(text) {
  if (!needsInput(text)) return null;
  const ls = clean(text);
  const r = lastIndex(ls, isAnyRule);
  const start = r >= 0 ? r + 1 : Math.max(0, ls.length - 12);
  const b = ls.slice(start).slice(-30);
  const optionBody = (t) => {
    const m = /^(❯|>)?\s*(\d+)\.\s+/u.exec(t);
    if (!m) return null;
    const head = m[0];
    return { cursor: head.startsWith('❯') || head.startsWith('>'), label: t.slice(head.length) };
  };
  const isFooter = (t) => t.startsWith('Esc to') || t.startsWith('esc to') || t.startsWith('Enter to') || isAnyRule(t);
  let options = [], cursor = 0, numbered = true, first = 0;
  const f = b.findIndex((t) => optionBody(t) !== null);
  if (f >= 0) {
    first = f;
    for (const t of b.slice(f)) {
      if (isFooter(t)) break;
      const o = optionBody(t);
      if (o) { if (o.cursor) cursor = options.length; options.push(o.label); }
      else if (options.length > 0) options[options.length - 1] += ' ' + t;     // wrapped label (long path ...)
    }
  } else {
    const c = lastIndex(b, (t) => t.startsWith('❯ '));
    if (c >= 0) {
      numbered = false; first = c;
      for (const t of b.slice(c)) {
        if (isFooter(t)) break;
        if (t.startsWith('❯ ')) { cursor = options.length; options.push(t.slice(2)); } else options.push(t);
      }
    }
  }
  if (options.length < 2) return null;
  // title: the closest question above the options, else the first line of the block
  let q = lastIndex(b, (t) => t.endsWith('?'), first);
  if (q < 0) q = 0;
  const title = b.length === 0 ? '' : b[q];
  const detail = q + 1 < first ? b.slice(q + 1, first).join('\n') : '';
  let preview = null;
  if (r >= 0 && ls[r].startsWith('╌')) {                 // a command / diff preview exists only for permission requests
    const r0 = lastIndex(ls, isAnyRule, r);
    const lines = ls.slice(r0 >= 0 ? r0 + 1 : 0, r).slice(-30);
    if (lines.length > 0) preview = lines.join('\n');
  }
  return { title, detail: detail === '' ? null : detail, preview, options, cursor, numbered };
}

// ───────────────────────────── ScreenStatus ─────────────────────────────
// What Claude Code prints around its input box besides the conversation: the spinner line while a turn runs
// ("· Mustering… (2m 30s · ↓ 9.8k tokens)"), the "done" line after it ("✻ Cogitated for 2m 47s · done 2:16 AM")
// and the footer ("⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt · ← 3 agents").
//   verb        the spinner's word, without the ellipsis: "Mustering"
//   elapsed     "2m 30s"
//   tokens      "9.8k"
//   thinking    "(… · thinking)" while the model reasons
//   activity    the short progress line above the spinner: "Running 1 shell command…"
//   done        "Cogitated for 2m 47s · done 2:16 AM" (idle, until the next turn)
//   mode        "auto mode" / "accept edits" / "plan mode" / "bypass permissions"; null = default
//   agents      teammates the footer counts ("← 3 agents")
//   suggestion  the CLI's predicted next prompt, drawn dim in the empty box ("❯ 이제 실행해줘"); Tab accepts it there
function emptyStatus() {
  return { verb: null, elapsed: null, tokens: null, thinking: false, activity: null, done: null, mode: null, agents: null, suggestion: null };
}
/** ScreenStatus.isEmpty */
function statusIsEmpty(st) {
  const e = emptyStatus();
  return !!st && Object.keys(e).every((k) => (st[k] ?? null) === e[k]);
}
/** ScreenStatus is Equatable in Swift (the store compares the last capture with the new one). */
function statusEqual(a, b) {
  if (!a || !b) return a === b;
  return Object.keys(emptyStatus()).every((k) => (a[k] ?? null) === (b[k] ?? null));
}

const glyphs = new Set([...'✽✳✶✢✻✷✸✹·*']);
/** Lines of a capture, same cleaning as the state detectors (box edge stripped, blanks dropped). */
function lines(text) {
  return splitNE(text, '\n').map((l) => {
    let t = trimWS(l);
    if (t.startsWith('│')) t = trimWS(t.slice(1));
    return t.split(' ').join(' ');
  }).filter((t) => t.length > 0);
}
function rule(t) { return t.startsWith('────────') || t.startsWith('╭') || t.startsWith('╰'); }

/** Plain text of a `capture-pane -e` dump (SGR / other CSI and OSC sequences removed). */
function stripANSI(s) {
  if (!s.includes('\u001b')) return s;
  return s.replace(/\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-9;:?<=>]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[()][0-9A-Za-z]/g, '');
}
/** A CLI screen that replaces the conversation in the pane. "agents": the session list behind "← for agents" (the CLI moves
 *  the conversation to a background job and the box there dispatches a NEW session); "resume": the /resume picker.
 *  Anything typed into the pane then never reaches the agent. */
function overlay(text) {
  const tail = clean(text).slice(-40);
  if (tail.some((t) => t.startsWith('Your conversation moved to the background') || t.startsWith('❯ describe a task for a new session')
    || (t.includes('enter to return') && (t.includes('space to reply') || t.includes('ctrl+x to delete'))))) return 'agents';
  if (tail.some((t) => t === 'Resume session') && tail.some((t) => t.includes('Esc to cancel') && t.includes('Type to search'))) return 'resume';
  return null;
}

/** The raw input row after "❯" (nbsp / spaces skipped), null when there is no input box on screen. */
function inputRow(raw) {
  const rows = raw.split('\n');
  const plain = rows.map((r) => trimWS(stripANSI(r)));
  const bottom = lastIndex(plain, rule);
  if (bottom <= 0) return null;
  // the input line: the first "❯" row under the box's top rule (a multi-line box keeps it on its first row)
  const top = lastIndex(plain, rule, bottom);
  if (top < 0 || bottom - top > 6) return null;
  let i = -1;
  for (let k = top + 1; k < bottom; k++) if (plain[k].startsWith('❯')) { i = k; break; }
  if (i < 0) return null;
  const line = rows[i];
  const mark = line.indexOf('❯');
  if (mark < 0) return null;
  return line.slice(mark + 1);
}
/** Walks the input row past separators and colour resets. Returns {rest, dim, typed} (dim: starts with dim text). */
function inputText(raw) {
  let rest = inputRow(raw);
  if (rest === null) return null;
  while (rest.length > 0) {
    const f = rest[0];
    if (f === ' ' || f === ' ') { rest = rest.slice(1); continue; }
    if (f === '\u001b') {
      const m = /^\u001b\[[0-9;]*m/.exec(rest);
      if (m) {
        const code = m[0];
        if (code === '\u001b[2m' || code.startsWith('\u001b[2;') || code.includes(';2m') || code.includes(';2;')) return { rest, dim: true, typed: false };
        rest = rest.slice(code.length); continue;
      }
      return { rest, dim: false, typed: false };      // some other escape (cursor shape …): not text
    }
    return { rest, dim: false, typed: true };
  }
  return { rest, dim: false, typed: false };
}
/** Someone typed into the CLI's input box: text that is neither the dim suggestion nor the dim placeholder. */
function typedInput(raw) { const t = inputText(raw); return t ? t.typed : false; }
function hasInputBox(raw) { return inputText(raw) !== null; }

/** The dim text right after "❯" on the input line between the box rules: the CLI's suggestion. Typed text is not dim,
 *  so a box with something typed in it yields null. */
function suggestion(raw) {
  const t = inputText(raw);
  if (!t || !t.dim) return null;
  const rest = t.rest;
  if (!rest.startsWith('\u001b[')) return null;
  const text = trimWS(stripANSI(rest).split(' ').join(' '));
  // the box's own placeholder ("Try \"…\"") is dim too: only take a real prediction
  if (text === '' || text.startsWith('Try "') || text.startsWith('Message @') || text.startsWith('Press ')) return null;
  return text;
}

/** Everything the footer, spinner and done line say. Cheap: one pass over the last screen. */
function status(text) {
  const st = emptyStatus();
  const ls = lines(text);
  const rules = ls.map((_, i) => i).filter((i) => rule(ls[i]));
  if (rules.length === 0) return st;
  const bottom = rules[rules.length - 1];
  const top = boxTop(rules, bottom);
  // footer: up to 3 lines under the box
  for (const l of ls.slice(bottom + 1, bottom + 4)) {
    const m = /⏵⏵\s*([a-z ]+?) on\b/u.exec(l);
    if (m) st.mode = trimWS(m[0].split('⏵⏵').join('').split(' on').join(''));
    const a = /←\s*(\d+)\s*agent/u.exec(l);
    if (a) { const n = parseInt(a[0].replace(/\D/g, ''), 10); st.agents = Number.isNaN(n) ? null : n; }
  }
  // above the box: the spinner (running) or the done line (idle), never past another rule
  let from = top;
  while (from > 0 && top - from < 12 && !rule(ls[from - 1])) from -= 1;
  const block = ls.slice(from, top);
  for (let i = block.length - 1; i >= 0; i--) {
    const l = block[i];
    const f = firstChar(l);
    if (f === undefined || !glyphs.has(f)) continue;
    const body = trimWS(l.slice(f.length));
    // spinner: "Mustering… (2m 30s · ↓ 9.8k tokens · thinking)"
    const m = /^(.+?)…\s*\((.*)\)/u.exec(body);
    if (m) {
      const inner = m[0];
      const verb = trimWS(splitNE(inner, '…')[0] || '');
      const o = inner.indexOf('('), c = inner.lastIndexOf(')');
      if (o < 0 || c < 0 || o >= c) continue;
      const segs = splitNE(inner.slice(o + 1, c), '·').map(trimWS);
      if (segs.length === 0 || !/^\d+\s*[smh]/u.test(segs[0])) continue;
      st.verb = verb === '' ? null : verb;
      st.elapsed = segs[0];
      for (const seg of segs.slice(1)) {
        if (seg.endsWith('tokens')) st.tokens = trimWS(seg.split('tokens').join('').split('↓').join('').split('↑').join(''));
        else if (seg === 'thinking') st.thinking = true;
      }
      // the progress line right above it ("Running 1 shell command…"): short, ends with an ellipsis, not a to-do row
      for (let k = i - 1; k >= Math.max(0, i - 3); k--) {
        const a = block[k];
        if (a.startsWith('⎿') || a.startsWith('☐') || a.startsWith('☒') || a.startsWith('⏺') || a.startsWith('›')) continue;
        if (a.endsWith('…') && count(a) < 90 && !glyphs.has(firstChar(a))) st.activity = a;
        break;
      }
      return st;
    }
    // done: "Cogitated for 2m 47s · done 2:16 AM" (only the first glyph line from the bottom counts)
    if (/^\S+ for \d+/u.test(body)) { st.done = body; return st; }
  }
  return st;
}

// ───────────────────────────── PromptDriver ─────────────────────────────
/** Answers a Claude Code choice window by walking the cursor (Up/Down) and pressing Enter. Call it on the pane's queue
 *  (tmux.queue(pane, () => screen.answer(…))). Resolves to null when the window is gone afterwards; otherwise a message
 *  that says why not. */
async function answer(p, expected, optionIndex) {
  const shell = require('./shell');
  const tmux = require('./tmux');                // lazy: tmux.js requires this module
  const { L } = require('./l10n');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const screen = async () => { const r = await shell.tmux(['capture-pane', '-p', '-t', p, '-S', '-4']); return r.code === 0 ? r.out : null; };
  const same = (x) => !!x && x.title === expected.title && JSON.stringify(x.options) === JSON.stringify(expected.options);
  if (!(Number.isInteger(optionIndex) && optionIndex >= 0 && optionIndex < expected.options.length)) return L('없는 선택지입니다.');
  const now = await screen();
  const cur = now === null ? null : prompt(now);
  if (!same(cur)) return L('화면의 선택창이 바뀌었거나 읽을 수 없어 보내지 않았습니다.');
  const delta = optionIndex - cur.cursor;
  for (let i = 0; i < Math.abs(delta); i++) {
    if (!(await tmux.keys(['-t', p, delta > 0 ? 'Down' : 'Up'], L('선택 이동')))) return null;
    await sleep(90);
  }
  await sleep(200);
  const moved = await screen();
  const pr = moved === null ? null : prompt(moved);
  if (!same(pr) || pr.cursor !== optionIndex) return L('커서를 원하는 선택지로 옮기지 못해 취소했습니다. 터미널에서 직접 선택해 주세요.');
  if (!(await tmux.keys(['-t', p, 'Enter'], L('선택 확정')))) return null;
  await sleep(800);
  const after = await screen();
  if (after !== null && same(prompt(after))) return L('선택을 보냈지만 선택창이 아직 떠 있습니다. 터미널에서 확인해 주세요.');
  return null;
}
const PromptDriver = { answer };

module.exports = {
  busy, needsInput, isSwitchModelPrompt, prompt, stripANSI, overlay, typedInput, hasInputBox, suggestion, status,
  emptyStatus, statusIsEmpty, statusEqual, answer, PromptDriver,
};
