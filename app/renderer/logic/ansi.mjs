// Pure text logic of TerminalPanel.swift (no DOM, no IPC), so node tests can import it:
//   ANSI            minimal SGR renderer for tmux `capture-pane -e` output (enum ANSI)
//   PaneChat.*      the static helpers of PaneChatView: forLight, isWide, conversation, padBackgrounds, width, plain
// Colours are [r, g, b, a] arrays with components 0…1, as SwiftUI Color(red:green:blue:) / NSColor sRGB components.

const rgb = (r, g, b) => [r, g, b, 1];

/** Minimal SGR (colour/bold/underline/reverse) renderer for tmux `capture-pane -e` output. */
export const ANSI = {
  base16: [
    rgb(0.10, 0.11, 0.13), rgb(0.89, 0.36, 0.33), rgb(0.45, 0.79, 0.47), rgb(0.90, 0.75, 0.40),
    rgb(0.42, 0.62, 0.95), rgb(0.78, 0.50, 0.86), rgb(0.40, 0.80, 0.85), rgb(0.85, 0.86, 0.88),
    rgb(0.45, 0.47, 0.52), rgb(1.00, 0.48, 0.45), rgb(0.56, 0.90, 0.58), rgb(1.00, 0.86, 0.50),
    rgb(0.55, 0.73, 1.00), rgb(0.88, 0.62, 0.96), rgb(0.52, 0.90, 0.95), rgb(0.97, 0.97, 0.98)],
  /** Default foreground / the reverse-video background when none is set. */
  defaultFg: rgb(0.86, 0.87, 0.89),
  reverseBg: rgb(0.051, 0.055, 0.063),

  xterm(n) {
    if (n < 16) return ANSI.base16[Math.max(0, n)];
    if (n < 232) { const i = n - 16; const f = (v) => (v === 0 ? 0 : 55 + v * 40) / 255; return rgb(f(Math.trunc(i / 36)), f(Math.trunc(i / 6) % 6), f(i % 6)); }
    const g = (8 + (Math.min(n, 255) - 232) * 10) / 255; return rgb(g, g, g);
  },
  style() { return { fg: null, bg: null, bold: false, dim: false, italic: false, under: false, reverse: false }; },

  /**
   * Text → lines of runs: [[{text, fg, bg|null, bold, italic, under}]]. `cursor` = [x, y] draws a reverse-video cell
   * at that column of that line (TerminalPanel); null for the read-only CLI screen.
   */
  render(text, cursor) {
    const out = [];
    let st = ANSI.style();
    const lines = String(text).split('\n');
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const runs = [];
      let run = '';
      const flush = () => { if (!run) return; runs.push(ANSI.apply(st, run)); run = ''; };
      const cur = cursor && cursor[1] === li ? cursor[0] : -1;
      let col = 0;
      const chars = splitChars(line);
      for (let i = 0; i < chars.length; i++) {
        const ch = chars[i];
        if (ch === '\u001b' && chars[i + 1] === '[') {
          let j = i + 2, params = '';
          while (j < chars.length && !isLetter(chars[j])) { params += chars[j]; j++; }
          if (j < chars.length) {
            if (chars[j] === 'm') { flush(); ANSI.sgr(params, st); }
            i = j; continue;
          }
        }
        if (cur >= 0 && cur === col) {
          flush(); const cs = { ...st, reverse: !st.reverse }; runs.push(ANSI.apply(cs, ch));
        } else run += ch;
        col += cellWidth(ch);
      }
      flush();
      if (cur >= 0 && cur >= col) {
        if (cur - col > 0) runs.push(ANSI.apply(st, ' '.repeat(cur - col)));
        runs.push(ANSI.apply({ ...st, reverse: true }, ' '));
      }
      out.push(runs);
    }
    return out;
  },
  /** A style → the run's resolved colours (reverse swaps them, dim is 60 % opacity). */
  apply(s, text) {
    let fg = s.fg || ANSI.defaultFg, bg = s.bg;
    if (s.reverse) { const t = fg; fg = bg || ANSI.reverseBg; bg = t; }
    return { text, fg: s.dim ? [fg[0], fg[1], fg[2], fg[3] * 0.6] : fg, bg: bg || null, bold: s.bold, italic: s.italic, under: s.under };
  },
  sgr(p, s) {
    let codes = p.split(';').map((x) => { const n = parseInt(x, 10); return Number.isNaN(n) || !/^\d+$/.test(x) ? 0 : n; });
    if (!codes.length) codes = [0];
    for (let k = 0; k < codes.length; k++) {
      const c = codes[k];
      if (c === 0) Object.assign(s, ANSI.style());
      else if (c === 1) s.bold = true;
      else if (c === 2) s.dim = true;
      else if (c === 3) s.italic = true;
      else if (c === 4) s.under = true;
      else if (c === 7) s.reverse = true;
      else if (c === 22) { s.bold = false; s.dim = false; }
      else if (c === 23) s.italic = false;
      else if (c === 24) s.under = false;
      else if (c === 27) s.reverse = false;
      else if (c >= 30 && c <= 37) s.fg = ANSI.base16[c - 30];
      else if (c >= 90 && c <= 97) s.fg = ANSI.base16[c - 90 + 8];
      else if (c >= 40 && c <= 47) s.bg = ANSI.base16[c - 40];
      else if (c >= 100 && c <= 107) s.bg = ANSI.base16[c - 100 + 8];
      else if (c === 39) s.fg = null;
      else if (c === 49) s.bg = null;
      else if (c === 38 || c === 48) {
        let col = null;
        if (k + 2 < codes.length && codes[k + 1] === 5) { col = ANSI.xterm(codes[k + 2]); k += 2; }
        else if (k + 4 < codes.length && codes[k + 1] === 2) { col = rgb(codes[k + 2] / 255, codes[k + 3] / 255, codes[k + 4] / 255); k += 4; }
        if (c === 38) s.fg = col; else s.bg = col;
      }
    }
  },
};

const LETTER = /^\p{L}$/u;
function isLetter(ch) { return LETTER.test(ch); }
const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
/** Swift Characters (grapheme clusters); plain ASCII lines split by code unit. */
function splitChars(line) {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7f]*$/.test(line) || !segmenter) return Array.from(line);
  return Array.from(segmenter.segment(line), (x) => x.segment);
}
const EMOJI = /^\p{Emoji_Presentation}/u;
/** TerminalPanel's cursor column rule: a wide (Hangul, CJK, full-width) or emoji character takes two cells. */
function cellWidth(ch) {
  const v = ch.codePointAt(0);
  if (v === undefined) return 1;
  return v > 0x1100 && (EMOJI.test(ch) || (v >= 0x1100 && v <= 0x115F) || (v >= 0x2E80 && v <= 0xA4CF) || (v >= 0xAC00 && v <= 0xD7A3)
    || (v >= 0xF900 && v <= 0xFAFF) || (v >= 0xFF00 && v <= 0xFF60)) ? 2 : 1;
}

/** The static helpers of PaneChatView. */
export const PaneChat = {
  /** White Mode: the CLI draws for a dark terminal. Greys swap lightness (its text, rules and highlighted rows), and
   *  light hues are darkened until they read on white; saturated mid colours stay as they are. */
  forLight(c, background) {
    const [r, g, b, a] = c;
    if (Math.max(r, g, b) - Math.min(r, g, b) < 0.08) {
      const l = (r + g + b) / 3, n = background ? 1 - l * 0.4 : 1 - l;
      return [n, n, n, a];
    }
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (background) return [r, g, b, a * 0.25];
    if (!(lum > 0.45)) return c;
    const k = 0.45 / lum;
    return [r * k, g * k, b * k, a];
  },
  /** East Asian wide ranges (enough for Korean, CJK, full-width forms). */
  isWide(v) {
    return (v >= 0x1100 && v <= 0x115F) || (v >= 0x2E80 && v <= 0x303E) || (v >= 0x3041 && v <= 0x33FF) || (v >= 0x3400 && v <= 0x4DBF)
      || (v >= 0x4E00 && v <= 0x9FFF) || (v >= 0xA960 && v <= 0xA97F) || (v >= 0xAC00 && v <= 0xD7A3) || (v >= 0xD7B0 && v <= 0xD7FF)
      || (v >= 0xF900 && v <= 0xFAFF) || (v >= 0xFE30 && v <= 0xFE4F) || (v >= 0xFF00 && v <= 0xFF60) || (v >= 0xFFE0 && v <= 0xFFE6)
      || (v >= 0x1F300 && v <= 0x1FAFF) || (v >= 0x20000 && v <= 0x3FFFD) || (v >= 0x3130 && v <= 0x318F);
  },
  /** Everything above the CLI's input box: the box's top border is the last rule line before the "❯" prompt. */
  conversation(s0) {
    // OSC sequences (hyperlinks "ESC ] 8 ; … ESC \\") are not drawn by the colour renderer: drop them; "⏺" falls back to an emoji box
    // eslint-disable-next-line no-control-regex
    const s = String(s0).replace(/\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)/g, '').split('⏺').join('●');
    const lines = s.split('\n');
    const blank = (l) => PaneChat.plain(l).trim() === '';
    while (lines.length && blank(lines[lines.length - 1])) lines.pop();
    let prompt = -1;
    for (let i = lines.length - 1; i >= 0; i--) if (PaneChat.plain(lines[i]).startsWith('❯')) { prompt = i; break; }
    if (prompt >= 0) {
      let border = -1;
      for (let i = prompt - 1; i >= 0; i--) if (trimSpaces(PaneChat.plain(lines[i])).startsWith('──')) { border = i; break; }
      if (border >= 0) lines.length = border;
    }
    // then the CLI's status lines just above the box (the board shows its own): the spinner line ("✻ Working… (12s …)"),
    // update notices, blanks
    const glyphs = new Set(['·', '✢', '✳', '✶', '✻', '✽', '*', '✔', '✘', '✗']);
    while (lines.length) {
      const t = trimSpaces(PaneChat.plain(lines[lines.length - 1]));
      if (t === '' || (t.startsWith('⎿') && t.includes('Tip:')) || t.includes('Auto-update') || t.includes('Update installed') || t.includes('esc to interrupt')
        || (t.length > 0 && glyphs.has(Array.from(t)[0]) && t.includes('…'))) lines.pop();
      else break;
    }
    return lines.join('\n');
  },
  /** A line that ends inside a background colour (my messages): fill it to the full width with that colour, so the
   *  highlight is a band across the view, not a box behind the letters. */
  padBackgrounds(s, cols) {
    return String(s).split('\n').map((line) => {
      // eslint-disable-next-line no-control-regex
      if (!/\u001b\[[0-9;]*m/.test(line)) return line;
      // still inside a background: a bg code (48;… / 40–47 / 100–107) not reset before the end
      // eslint-disable-next-line no-control-regex
      const bgOpen = lastMatch(line, /\u001b\[[0-9;]*(48;|4[0-7]m|10[0-7]m)[0-9;]*m?/g);
      // eslint-disable-next-line no-control-regex
      const reset = lastMatch(line, /\u001b\[(0|49)?m/g);
      if (!bgOpen || bgOpen.index < (reset ? reset.index + reset[0].length : 0)) return line;
      const w = PaneChat.width(PaneChat.plain(line));
      return w < cols ? line + ' '.repeat(cols - w) : line;
    }).join('\n');
  },
  /** Terminal columns of plain text (wide characters count 2). */
  width(s) {
    let n = 0;
    for (const ch of String(s)) { const v = ch.codePointAt(0); n += v >= 0x1100 && PaneChat.isWide(v) ? 2 : 1; }
    return n;
  },
  // eslint-disable-next-line no-control-regex
  plain(s) { return String(s).replace(/\u001b\[[0-9;]*m/g, ''); },
};
/** Swift's trimmingCharacters(in: .whitespaces): spaces and tabs (and other horizontal blanks), not newlines. */
function trimSpaces(s) { return s.replace(/^[\p{Zs}\t]+|[\p{Zs}\t]+$/gu, ''); }
function lastMatch(s, rx) { let m, last = null; while ((m = rx.exec(s))) { last = m; if (m[0] === '') rx.lastIndex++; } return last; }
