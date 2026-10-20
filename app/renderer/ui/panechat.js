// Port of TerminalPanel.swift: the session's real CLI screen in place of a rebuilt chat (PaneChatView + PaneText), the
// in-app terminal panel over a tmux pane (TerminalPanel + KeyCatcher), TmuxResize and the ANSI colour renderer.
// The pure text logic (ANSI, PaneChatView's static helpers) is in ../logic/ansi.mjs so node tests can use it; the tmux
// calls are main/panes.js (capture, captureTerm, resize, want, fit, sendHex, sendLine).
//
// Exports: PaneChatView({pane, sid}), PaneText({screen, onWheel}), TerminalPanel({pane, title, fitWindow, onClose}),
// TmuxResize.apply(pane, cols, rows), KeyCatcher.bytes(keyboardEvent), ANSI, PaneChat, buildScreen(text, opts).
import { html, useState, useEffect, useRef, useMemo, useLayoutEffect, call, L, isMac } from '../lib.js';
import { Icon, Button, useAppearance } from './widgets.js';
import { useAppStorage } from './board.js';
import { PathLinks, usePathLinks } from './pathlinks.js';
import { ANSI, PaneChat } from '../logic/ansi.mjs';

export { ANSI, PaneChat };

// ── styles (added once; theme.css stays shared) ────────────────────────────────────────────────────────────────────
const CSS = `
.pane-chat { position: relative; flex: 1 1 auto; min-height: 0; min-width: 0; display: flex; background: var(--screen); }
.pane-text { position: relative; flex: 1 1 auto; min-width: 0; overflow-x: hidden; overflow-y: auto; user-select: text; -webkit-user-select: text; cursor: text; }
.pane-text .pt-body { padding: 10px 0 10px 14px; font-family: var(--font-mono); white-space: pre; min-width: 100%; box-sizing: border-box; }
.pane-text .pt-ln { overflow: visible; height: var(--pt-lh); }
.pane-text .wc, .term-screen .wc { display: inline-block; width: 2ch; vertical-align: top; }
.pane-text a.pl-link { color: inherit; text-decoration: underline; cursor: pointer; }
.pane-measure { position: absolute; visibility: hidden; white-space: pre; font-family: var(--font-mono); left: -9999px; top: 0; }
.term-panel { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; min-width: 0; }
.term-panel .term-bar { display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: color-mix(in srgb, var(--ink) 4%, var(--area)); }
.term-panel .term-input { display: flex; align-items: center; gap: 6px; padding: 6px; background: color-mix(in srgb, var(--ink) 4%, var(--area)); }
.term-panel .term-input .textfield { flex: 1 1 auto; min-width: 0; }
.term-screen { position: relative; flex: 1 1 auto; min-height: 0; overflow: auto; background: var(--screen); outline: none; border-radius: 2px; user-select: text; -webkit-user-select: text; cursor: text; }
.term-screen.focused { box-shadow: inset 0 0 0 1.5px var(--accent); }
.term-screen .ts-body { padding: 8px; font-family: var(--font-mono); white-space: pre; line-height: 1.18; min-width: 100%; min-height: 100%; box-sizing: border-box; width: max-content; }
`;
function ensureCSS() {
  if (document.querySelector('style[data-ab-panechat]')) return;
  const s = document.createElement('style'); s.setAttribute('data-ab-panechat', ''); s.textContent = CSS; document.head.appendChild(s);
}

// ── colour → CSS, HTML building ────────────────────────────────────────────────────────────────────────────────────
const css = (c) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${+c[3].toFixed(3)})`;
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (s) => s.replace(/[&<>"]/g, (c) => ESC[c]);
const TABLE = /[─-╿]/;
const sameColor = (a, b) => a === b || (!!a && !!b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3]);

/** Text of a run with every wide character (Hangul, CJK, full-width) in a cell exactly two columns wide. Table lines
 *  only: fallback fonts draw Hangul a little narrower or wider than two Latin cells, so every "│" after Korean text
 *  drifted; elsewhere the text keeps its natural width. */
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
function kerned(s, table) {
  if (!table) return esc(s);
  // per composed character sequence (Swift: rangeOfComposedCharacterSequence), not per code point: an emoji with a
  // skin-tone modifier or a ZWJ sequence, and decomposed (NFD) Hangul such as macOS file names, are one cluster that
  // takes its two cells as a whole; the cluster counts as wide when its first scalar is
  let out = '';
  for (const { segment: ch } of graphemes.segment(s)) {
    const v = ch.codePointAt(0);
    out += v >= 0x1100 && PaneChat.isWide(v) ? `<span class="wc">${esc(ch)}</span>` : esc(ch);
  }
  return out;
}
function runStyle(r, light, dropBg, italic, recolour) {
  const fg = light && recolour ? recolour(r.fg, false) : r.fg;
  let st = `color:${css(fg)};`;
  if (r.bg && !dropBg) st += `background:${css(light && recolour ? recolour(r.bg, true) : r.bg)};`;
  if (r.bold) st += 'font-weight:700;';
  if (italic && r.italic) st += 'font-style:italic;';
  if (r.under) st += 'text-decoration:underline;';
  return st;
}

/**
 * PaneChatView.appKit: rendered lines (ANSI.render) → {html, lines (plain text per line), plain, key}.
 * opts: light (White Mode recolouring), links (true: path links), the same rules as the Swift attributed string:
 *  - table lines (box-drawing characters): wide characters take exactly two columns so the borders line up;
 *  - path links (click: open the folder);
 *  - one fixed line height (each line is a block of the row height, so enlarged Hangul cannot make its line taller);
 *  - lines that end inside a background (my messages): the colour becomes one band across the full width for each run
 *    of such lines, with no gaps between rows, instead of a ragged box behind each line's letters; blank lines inside
 *    one message (between two lines of the same background) join the band.
 */
export function buildScreen(rendered, { light = false, links = true } = {}) {
  const lines = rendered.map((runs) => runs.map((r) => r.text).join(''));
  const paras = rendered.map((runs, i) => {
    const last = runs.length ? runs[runs.length - 1] : null;
    return { bg: lines[i].length > 0 && last ? last.bg : null, blank: lines[i].trim() === '' };
  });
  for (let i = 0; i < paras.length; i++) {
    if (paras[i].bg || !paras[i].blank) continue;
    let a = null, b = null;
    for (let j = i - 1; j >= 0; j--) if (!paras[j].blank) { a = paras[j]; break; }
    for (let j = i + 1; j < paras.length; j++) if (!paras[j].blank) { b = paras[j]; break; }
    if (a && b && a.bg && sameColor(a.bg, b.bg)) paras[i].bg = a.bg;
  }
  let out = '';
  for (let i = 0; i < rendered.length; i++) {
    const text = lines[i], table = TABLE.test(text), band = paras[i].bg;
    const found = links && text.includes('/') ? PathLinks.find(text) : [];
    let body = '', off = 0, li = 0;
    for (const r of rendered[i]) {
      const st = runStyle(r, light, !!band, false, PaneChat.forLight);
      // cut the run at link boundaries so each link is one <a> around whole spans
      let s = r.text, at = off;
      while (s.length) {
        const f = found[li];
        let cut = s.length;
        if (f && at < f.start) cut = Math.min(cut, f.start - at);
        else if (f && at >= f.start && at < f.end) cut = Math.min(cut, f.end - at);
        if (f && at === f.start) body += `<a class="pl-link" data-path="${esc(f.target.path)}" data-dir="${f.target.dir ? 1 : 0}">`;
        body += `<span style="${st}">${kerned(s.slice(0, cut), table)}</span>`;
        at += cut; s = s.slice(cut);
        if (f && at === f.end) { body += '</a>'; li++; }
      }
      off += r.text.length;
    }
    const bandStyle = band ? ` style="background:${css(light ? PaneChat.forLight(band, true) : band)}"` : '';
    out += `<div class="pt-ln"${bandStyle}>${body}</div>`;
  }
  const plain = lines.join('\n');
  return { html: out, lines, plain, key: (light ? 'L' : 'D') + out.length + ':' + out };
}

// ── PaneText: the read-only screen view ────────────────────────────────────────────────────────────────────────────
/**
 * Read-only text view for PaneChatView: it shows exactly the CLI's screen (the tmux window is sized to it), and a push
 * of the wheel past the top or bottom calls onWheel(up) (Swift's hook to page the CLI itself; PaneChatView, like the
 * Swift one, passes none). props: screen (buildScreen result), fontSize, lineHeight, onWheel.
 * No drop target here: files go to the input box below (drops are not handled, so they reach the enclosing view).
 */
export function PaneText({ screen, fontSize = 13, lineHeight, onWheel }) {
  const el = useRef(null), body = useRef(null);
  const tv = useRef(null);
  if (!tv.current) tv.current = makeTextView();
  const v = tv.current;
  v.onWheel = onWheel || (() => {});
  useLayoutEffect(() => { v.attach(el.current, body.current); return () => v.detach(); }, []);
  useLayoutEffect(() => { if (screen) v.update(screen); }, [screen]);
  const lh = lineHeight || Math.ceil(fontSize * 1.18);
  return html`<div class="pane-text" ref=${el}>
    <div class="pt-body" ref=${body} style=${{ fontSize: `${fontSize}px`, lineHeight: `${lh}px`, '--pt-lh': `${lh}px` }}></div>
  </div>`;
}

/** The NSScrollView + NSTextView pair of PaneText (WheelScroll + DropTV), on a scrolling <div>. */
function makeTextView() {
  const v = {
    el: null, body: null, cur: null,
    /** A screen that arrived while the user was selecting text (or reading further up): replacing the text would drop
     *  the selection, so it waits here until the selection is let go (cleared, or focus moves elsewhere such as the
     *  composer) or the reader is back at the bottom. */
    pending: null,
    misses: 0,          // screens in a row that lost the line being read (see apply)
    paged: 0,           // pages the CLI is scrolled back
    /** Follow new output (and open at the latest line) until the user scrolls up; back at the bottom, follow again. */
    stick: true,
    acc: 0, last: 0, userAt: 0, pointerDown: false,
    onWheel: () => {},
    cleanup: [],
  };
  const listen = (t, ev, f, o) => { t.addEventListener(ev, f, o); v.cleanup.push(() => t.removeEventListener(ev, f, o)); };
  /** Swift's `holding` (selection in the view) plus the mouse button held down in it: AppKit's mouse-tracking loop
   *  keeps the 1 s default-mode timer from firing during a drag, so Swift never swaps the screen mid-drag. Here the
   *  selection is still collapsed between mousedown and the first move, and replacing the HTML then lost the anchor. */
  v.holding = () => {
    if (v.el && v.pointerDown) return true;
    const sel = window.getSelection();
    return !!(v.el && sel && sel.rangeCount > 0 && !sel.isCollapsed && v.el.contains(sel.anchorNode));
  };
  v.atBottom = (slack) => v.el.scrollTop + v.el.clientHeight >= v.el.scrollHeight - slack;
  v.toEnd = () => { v.el.scrollTop = v.el.scrollHeight; };
  v.flushPending = () => {
    if (!v.pending || v.holding()) return;
    if (!v.stick && v.paged === 0) return;          // still reading further up
    const p = v.pending; v.pending = null;
    v.apply(p);
  };
  v.noteUserScroll = () => {
    const was = v.stick;
    v.stick = v.atBottom(40);
    // back at the bottom: show the screens held while reading further up
    if (v.stick && !was) v.flushPending();
  };
  v.attach = (el, body) => {
    v.el = el; v.body = body;
    // normal scrolling inside the screen; only a push past the top (older) or the bottom (back) pages the CLI
    listen(el, 'wheel', (e) => {
      v.userAt = Date.now();
      const dy = -e.deltaY * (e.deltaMode === 1 ? 12 : e.deltaMode === 2 ? el.clientHeight : 1);
      // Swift tests the edges after super.scrollWheel has scrolled; the page applies this event's scroll only after
      // the listener, so test where this event leaves the view (its offset clamped to the content)
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      const after = Math.max(0, Math.min(max, el.scrollTop - dy));
      const atTop = after <= 1, atBottom = after >= max - 1;
      if ((dy > 0 && atTop) || (dy < 0 && atBottom && v.paged > 0)) v.acc += dy; else v.acc = 0;
      if (Math.abs(v.acc) >= 160 && Date.now() - v.last > 400) {
        const up = v.acc > 0;
        if (up) v.paged += 1; else v.paged -= 1;
        v.onWheel(up); v.acc = 0; v.last = Date.now();
      }
    }, { passive: true });
    // scroller drags and keys count as the user's scroll too (programmatic scrolls do not)
    listen(el, 'pointerdown', () => { v.pointerDown = true; v.userAt = Date.now(); });
    // the button let go: a screen held during the press shows now unless a selection was made (then it waits for that)
    const release = () => { if (v.pointerDown) { v.pointerDown = false; v.userAt = Date.now(); if (v.pending) setTimeout(v.flushPending, 0); } };
    listen(window, 'pointerup', release);
    listen(window, 'pointercancel', release);
    listen(window, 'blur', release);
    listen(el, 'keydown', () => { v.userAt = Date.now(); });
    listen(el, 'scroll', () => { if (v.pointerDown || Date.now() - v.userAt < 700) v.noteUserScroll(); });
    // the selection let go (cleared, or moved elsewhere such as the composer): show the held screen
    listen(document, 'selectionchange', () => { if (v.pending) setTimeout(v.flushPending, 0); });
    // links: a path opens its folder (a file: shown in its folder)
    listen(body, 'click', (e) => {
      const a = e.target.closest && e.target.closest('a.pl-link');
      if (!a || !window.getSelection().isCollapsed) return;
      e.preventDefault();
      PathLinks.open({ path: a.getAttribute('data-path'), dir: a.getAttribute('data-dir') === '1' });
    });
    // a tab shown for the first time, or a resize: keep the latest line in view
    const ro = new ResizeObserver(() => { if (v.stick) v.toEnd(); });
    ro.observe(el); ro.observe(body);
    v.cleanup.push(() => ro.disconnect());
  };
  v.detach = () => { v.cleanup.forEach((f) => f()); v.cleanup = []; };
  v.update = (text) => {
    if (v.cur && v.cur.key === text.key) { v.pending = null; return; }
    // the user is selecting in here: keep their selection, show the new screen once they let go
    if (v.holding()) { v.pending = text; return; }
    // reading further up (not paged back in the CLI): hold new screens until they scroll back to the bottom. The CLI
    // redraws its whole screen while it answers, older lines included (tool summaries fold, half-drawn rows), so
    // replacing the text under the reader every second made the part being read flicker.
    if (!v.stick && v.paged === 0 && v.cur && v.cur.plain.length > 0) { v.pending = text; return; }
    v.pending = null;
    v.apply(text);
  };
  v.apply = (text) => {
    const follow = v.stick || !v.cur;       // at the bottom: follow new output
    // reading further up: the CLI draws on a fixed-height screen, so new output moves every earlier line up. Keeping
    // the pixel offset would slide newer text under the reader; keep the line they were reading in place instead.
    const anchor = follow ? null : readingAnchor(v);
    // the CLI redraws its whole screen on new output; a capture taken mid-redraw lacks the line being read, and
    // showing it made the view flash to another place and back a second later. Keep the current screen for up to
    // three such captures (the next complete one has the line again); after that, take the new screen anyway.
    if (anchor) {
      if (!text.plain.includes(anchor.snippet) && v.misses < 3) { v.misses += 1; return; }
      v.misses = 0;
    }
    const top = v.el.scrollTop;
    v.body.innerHTML = text.html;
    v.cur = text;
    if (follow) { v.toEnd(); return; }
    let y = top;
    const at = anchor ? locate(anchor, text.plain) : null;
    if (at != null) { const ly = lineY(v, lineOf(text.plain, at)); if (ly != null) y = Math.max(0, ly - anchor.dy); }
    v.el.scrollTop = y;
  };
  return v;
}
/** Top of line `i` in the scroll view's content coordinates. */
function lineY(v, i) { const n = v.body.children[i]; return n ? n.offsetTop : null; }
/** The line index holding character offset `at` of the plain text. */
function lineOf(plain, at) { let n = 0; for (let k = plain.indexOf('\n'); k !== -1 && k < at; k = plain.indexOf('\n', k + 1)) n++; return n; }
/** The first non-blank line at the top of the view, the two lines after it (to tell repeated lines apart), and how
 *  far below the view's top edge it sits. */
function readingAnchor(v) {
  const lines = v.cur ? v.cur.lines : null;
  if (!lines || !lines.length) return null;
  const top = v.el.scrollTop, kids = v.body.children;
  let i = 0;
  while (i < kids.length - 1 && kids[i + 1].offsetTop <= top) i++;
  for (let k = 0; k < 40 && lines[i] !== undefined && lines[i].trim() === ''; k++) i++;
  if (i >= lines.length) return null;
  const ly = lineY(v, i);
  if (ly == null) return null;
  let location = 0;
  for (let k = 0; k < i; k++) location += lines[k].length + 1;
  return { snippet: lines.slice(i, i + 3).join('\n'), location, dy: ly - top };
}
/** Where the anchor's text is now: the nearest copy at or before its old place (output only moves text up), else anywhere. */
function locate(a, plain) {
  const upto = Math.min(plain.length, a.location + a.snippet.length);
  let r = upto - a.snippet.length >= 0 ? plain.lastIndexOf(a.snippet, upto - a.snippet.length) : -1;
  if (r === -1) r = plain.indexOf(a.snippet);
  return r === -1 ? null : r;
}

// ── measuring the monospaced cell ──────────────────────────────────────────────────────────────────────────────────
/** Width of one "M" of the monospaced font at `size` px (NSFont.monospacedSystemFont "M" width). */
function cellWidth(host, size) {
  const m = document.createElement('span');
  m.className = 'pane-measure'; m.style.fontSize = `${size}px`; m.textContent = 'M'.repeat(100);
  (host || document.body).appendChild(m);
  const w = m.getBoundingClientRect().width / 100;
  m.remove();
  return w || size * 0.602;
}

// ── PaneChatView ───────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * The conversation part of a session's real CLI screen, in place of the rebuilt chat: the pane's screen with the CLI's
 * own input box and footer cut off (the board's input box below replaces them). Nothing is parsed or rebuilt; the pane
 * is read only while this view is on screen (one capture a second). props: pane (tmux pane id), sid (session id; unused
 * here, as in Swift).
 */
export function PaneChatView({ pane, sid = '' }) {   // eslint-disable-line no-unused-vars
  ensureCSS();
  usePathLinks();                                   // redraw when path answers arrive (their links appear)
  const [fontSize] = useAppStorage('ui.termFont', 13);
  const [, , isDark] = useAppearance();
  const light = !isDark;
  const [cut, setCut] = useState('');
  const box = useRef(null);
  const s = useRef({ raw: '', inFlight: false, attached: false, panes: 1, cols: 120, rows: 40, fitTimer: 0, pane, light });
  const st = s.current;
  st.pane = pane; st.light = light;

  // Width of this view, height fixed and tall: the CLI fills it with its conversation (changing the height made the CLI
  // clear its screen). Debounced; never while a terminal is attached (the terminal's size stands until it leaves).
  const fit = () => {
    clearTimeout(st.fitTimer);
    if (st.attached) return;
    const p = st.pane, c = st.cols, n = st.panes;
    call('panes.want', p, c);
    st.fitTimer = setTimeout(() => { call('panes.fit', p, c, n); }, 400);
  };
  const poll = async (force = false) => {
    if (st.inFlight) return;
    st.inFlight = true;
    const p = st.pane;
    let r = null;
    try { r = await call('panes.capture', p); } catch { r = null; }
    st.inFlight = false;
    if (!r || p !== st.pane) return;
    if (st.attached !== r.attached) {
      st.attached = r.attached;
      if (!r.attached) fit();                         // the terminal closed: back to the tall window
    }
    if (st.panes !== r.panes) { st.panes = r.panes; fit(); }   // a teammate pane came or went: re-share the width
    const c = PaneChat.conversation(r.screen);
    if (force || c !== st.raw) { st.raw = c; setCut(c); }
  };

  // the CLI wraps at the tmux width (220 columns at launch): make that the visible width, or every long line wrapped
  // twice and jutted out
  useLayoutEffect(() => {
    const el = box.current;
    const measure = () => {
      const cw = cellWidth(el, fontSize), lh = Math.ceil(fontSize * 1.18);
      const w = el.clientWidth, h = el.clientHeight;
      const cols = Math.max(50, Math.trunc((w - 28 - 24) / Math.max(cw, 1)) - 2), rows = Math.max(15, Math.trunc((h - 20) / Math.max(lh, 1)));
      if (cols !== st.cols || rows !== st.rows || !st.measured) { st.cols = cols; st.rows = rows; st.measured = true; fit(); }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fontSize]);

  useEffect(() => {
    st.raw = ''; st.attached = false; setCut('');
    poll();
    const t = setInterval(() => poll(), 1000);
    return () => { clearInterval(t); clearTimeout(st.fitTimer); call('panes.want', pane, null); };
  }, [pane]);
  // recolour the screen for the new appearance
  const firstLight = useRef(true);
  useEffect(() => { if (firstLight.current) { firstLight.current = false; return; } st.raw = ''; poll(true); }, [light]);

  const rendered = useMemo(() => ANSI.render(cut, null), [cut]);
  // which path links are known now (answers arrive asynchronously; usePathLinks redraws when they do)
  const linkSig = rendered.map((runs) => {
    const t = runs.map((r) => r.text).join('');
    return t.includes('/') ? PathLinks.find(t).length : 0;
  }).join(',');
  const screen = useMemo(() => buildScreen(rendered, { light }), [rendered, light, linkSig]);
  return html`<div class="pane-chat" ref=${box}>
    <${PaneText} screen=${screen} fontSize=${fontSize} />
  </div>`;
}

// ── TerminalPanel ──────────────────────────────────────────────────────────────────────────────────────────────────
/** TmuxResize.apply — the one way the app sizes a tmux window (main/panes.js resize; see its comment). */
export const TmuxResize = { apply: (pane, cols, rows) => call('panes.resize', pane, cols, rows) };

/** KeyCatcher: key presses while focused → terminal bytes (null = not ours, let the page have it). Ctrl+Shift+V pastes
 *  (Linux terminals' paste; plain Ctrl+V is the 0x16 byte); Alt+key sends ESC + key, as Linux terminals do.
 *  macOS (TerminalPanel.swift's KeyCatcher): ⌘V pastes the clipboard's text, other ⌘ keys go to the app, and Option+key
 *  sends the character it types (e.characters), not ESC + key. */
export const KeyCatcher = {
  map: {
    Enter: '\r', Backspace: '\u007f', Tab: '\t', Escape: '\u001b',
    ArrowLeft: '\u001b[D', ArrowRight: '\u001b[C', ArrowDown: '\u001b[B', ArrowUp: '\u001b[A',
    Delete: '\u001b[3~', Home: '\u001b[H', End: '\u001b[F', PageUp: '\u001b[5~', PageDown: '\u001b[6~',
  },
  /** Ctrl + a non-letter key → the control byte a terminal sends (xterm's table; Ctrl+2…8 included). */
  ctrl: {
    ' ': 0x00, '@': 0x00, '2': 0x00, '[': 0x1b, '3': 0x1b, '\\': 0x1c, '4': 0x1c, ']': 0x1d, '5': 0x1d,
    '^': 0x1e, '6': 0x1e, '_': 0x1f, '-': 0x1f, '/': 0x1f, '7': 0x1f, '?': 0x7f, '8': 0x7f,
  },
  bytes(e) {
    if (e.isComposing || e.keyCode === 229) return null;        // IME: Korean goes through the input line below
    if (e.metaKey) return null;
    if (e.key === 'Tab' && e.shiftKey) return utf8('\u001b[Z');
    const m = KeyCatcher.map[e.key];
    if (m && !e.ctrlKey && !e.altKey) return utf8(m);
    if (e.ctrlKey && !e.altKey && e.key.length === 1) {
      const c = e.key.toLowerCase().charCodeAt(0);
      if (c >= 0x61 && c <= 0x7a) return [c & 0x1f];
      // Swift falls through to e.characters, where AppKit has already made the control character (Ctrl+[ → ESC,
      // Ctrl+Space → NUL, Ctrl+] → 0x1d). The page gives the plain key, so map it as terminals (xterm) do; any other
      // key sends its character, as e.characters does
      const ctl = KeyCatcher.ctrl[e.key];
      return ctl != null ? [ctl] : utf8(e.key);
    }
    if (e.altKey && !e.ctrlKey && e.key.length === 1) return isMac ? utf8(e.key) : [0x1b].concat(utf8(e.key));
    if (m) return utf8(m);
    if (e.key.length >= 1 && [...e.key].length === 1) return utf8(e.key);
    return null;
  },
};
function utf8(s) { return Array.from(new TextEncoder().encode(s)); }

/** One rendered terminal line (SwiftUI Text runs: bold, italic, underline, colours; White Mode recoloured). */
function termHTML(rendered, light) {
  return rendered.map((runs) => runs.map((r) => `<span style="${runStyle(r, light, false, true, PaneChat.forLight)}">${esc(r.text)}</span>`).join('')).join('\n');
}

/**
 * In-app terminal view over a tmux pane: polls `capture-pane -e`, renders ANSI colours, and forwards keystrokes with
 * `send-keys -H`. Korean text goes through the input line below (raw key events cannot carry IME composition).
 * props: pane, title, fitWindow (resize the tmux window to the panel; only for terminals the app owns), onClose.
 */
export function TerminalPanel({ pane, title, fitWindow = false, onClose }) {
  ensureCSS();
  const [fontSize] = useAppStorage('ui.termFont', 13);
  const [, , isDark] = useAppearance();
  const [rendered, setRendered] = useState([]);
  const [focused, setFocused] = useState(false);
  const [line, setLine] = useState('');
  const scroller = useRef(null);
  const s = useRef({ raw: '', inFlight: false, quiet: 0, tickN: 0, lastSize: { w: 0, h: 0 }, attached: false, fitTimer: 0, pane, fitWindow, fontSize });
  const st = s.current;
  st.pane = pane; st.fitWindow = fitWindow; st.fontSize = fontSize;

  const poll = async () => {
    if (st.inFlight) return;
    st.inFlight = true;
    const p = st.pane;
    let r = null;
    try { r = await call('panes.captureTerm', p); } catch { r = null; }
    st.inFlight = false;
    if (!r || p !== st.pane) return;
    if (st.attached !== r.attached) {
      st.attached = r.attached;
      if (!r.attached) fit(st.lastSize);              // the terminal went away: take the size back
    }
    if (r.key === st.raw) { st.quiet += 1; return; }
    st.quiet = 0;
    st.raw = r.key;
    setRendered(ANSI.render(r.screen, r.cursor));
  };
  /** Sizes the tmux window to this panel, debounced (a window drag fires many layout passes). While a real terminal is
   *  attached, that terminal owns the size and the app stays out of it. */
  const fit = (size) => {
    if (!st.fitWindow || st.attached || size.w <= 100 || size.h <= 60) return;
    const cw = st.fontSize * 0.602, lh = st.fontSize * 1.18;
    const cols = Math.max(40, Math.trunc((size.w - 16) / cw)), rows = Math.max(10, Math.trunc((size.h - 16) / lh));
    const p = st.pane;
    clearTimeout(st.fitTimer);
    st.fitTimer = setTimeout(() => TmuxResize.apply(p, cols, rows), 300);
  };
  const send = (bytes) => {
    if (!bytes || !bytes.length) return;
    call('panes.sendHex', st.pane, bytes.map((b) => b.toString(16).padStart(2, '0')));
    st.quiet = 0;
    setTimeout(poll, 50);
  };
  const sendLine = () => {
    if (!line) return;
    call('panes.sendLine', st.pane, line);
    setLine(''); st.quiet = 0;
    setTimeout(poll, 250);
  };

  useEffect(() => {
    st.raw = ''; st.quiet = 0;
    poll();
    const t = setInterval(() => {
      st.tickN += 1;
      if (!document.hasFocus() && st.tickN % 6 !== 0) return;     // in the background: every ~2 s
      if (st.quiet > 12 && st.tickN % 3 !== 0) return;             // a still screen: ~1 poll/s instead of ~3
      poll();
    }, 350);
    return () => { clearInterval(t); clearTimeout(st.fitTimer); };
  }, [pane]);
  useLayoutEffect(() => {
    const el = scroller.current;
    const ro = new ResizeObserver(() => { st.lastSize = { w: el.clientWidth, h: el.clientHeight }; fit(st.lastSize); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // the latest line in view (defaultScrollAnchor .bottomLeading), unless the user scrolled up
  const pinned = useRef(true);
  useLayoutEffect(() => { const el = scroller.current; if (pinned.current) el.scrollTop = el.scrollHeight; }, [rendered]);
  const onScroll = (e) => { const el = e.currentTarget; pinned.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 20; };

  const onKeyDown = async (e) => {
    const pasteKey = isMac ? e.metaKey && (e.key === 'v' || e.key === 'V') : e.ctrlKey && e.shiftKey && (e.key === 'V' || e.key === 'v');
    if (pasteKey) {
      e.preventDefault();
      const t = await call('platform.readText');
      if (t) send(utf8(t));
      return;
    }
    if (e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'c')) return;   // copy the selection (the page does it)
    const b = KeyCatcher.bytes(e);
    if (b) { e.preventDefault(); send(b); }
  };
  const termHtml = useMemo(() => termHTML(rendered, !isDark), [rendered, isDark]);

  return html`<div class="term-panel">
    <div class="term-bar">
      <${Icon} name="terminal" />
      <span class="t-callout t-bold one-line" title=${L('tmux 패널 ID %@', pane)}>${title}</span>
      <span class="spacer"></span>
      <span class="t-caption" style=${{ color: focused ? 'var(--accent)' : 'var(--secondary)' }}>${focused ? L('키 입력 중 — 바깥 클릭하면 해제') : L('클릭하면 키 입력')}</span>
      <${Button} kind="icon" help=${L('터미널 패널 닫기')} onClick=${() => onClose && onClose()}><${Icon} name="xmark" /><//>
    </div>
    <div class=${'term-screen' + (focused ? ' focused' : '')} ref=${scroller} tabIndex="0" onScroll=${onScroll}
         onFocus=${() => setFocused(true)} onBlur=${() => setFocused(false)} onKeyDown=${onKeyDown}>
      <div class="ts-body" style=${{ fontSize: `${fontSize}px` }} dangerouslySetInnerHTML=${{ __html: termHtml }}></div>
    </div>
    <div class="term-input">
      <input class="textfield" value=${line} placeholder=${L('한글 등 텍스트 입력 후 Enter (명령 줄로 전송)')}
        onInput=${(e) => setLine(e.currentTarget.value)} onKeyDown=${(e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); sendLine(); } }} />
      <${Button} kind="raised" disabled=${!line} onClick=${sendLine}>${L('보내기')}<//>
    </div>
  </div>`;
}
