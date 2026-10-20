// Port of MarkdownView.swift: a small block-level Markdown renderer (headings, fenced code, tables, lists, quotes,
// paragraphs; inline bold / italic / code / links / file paths), the copy-on-hover button of quotes and code, and the
// composer's text box (Composer + ComposerField: 1–5 lines then it scrolls, Enter sends, Shift+Enter breaks the line and
// continues lists, a grey Tab suggestion drawn after the text, pasted / dropped files become attachments).
import { html, h, useState, useEffect, useRef, useLayoutEffect, L } from '../lib.js';
import { Icon, Label, Button } from './widgets.js';
import { PathLinks, usePathLinks } from './pathlinks.js';
import { act, useAppStorage, ensureStyles } from './board.js';

ensureStyles();

// ── MarkdownParser ─────────────────────────────────────────────────────────────────────────────────────────────────

const listRx = /^(\d+[.)]|[-*+])\s+/;
export const MarkdownParser = {
  /** Blocks: {kind:'heading', level, text} | {kind:'paragraph', text} | {kind:'code', text, lang} |
   *  {kind:'table', header, rows} | {kind:'list', items, ordered} | {kind:'quote', text} | {kind:'rule'}. */
  parse(text) {
    const blocks = [];
    const lines = String(text).replace(/\r\n/g, '\n').split('\n');
    let i = 0, para = [];
    const flush = () => { if (para.length) { blocks.push({ kind: 'paragraph', text: para.join('\n') }); para = []; } };
    const trim = (s) => s.replace(/^[ \t]+|[ \t]+$/g, '');
    while (i < lines.length) {
      const line = lines[i], t = trim(line);
      if (t.startsWith('```')) {
        flush(); const lang = trim(t.slice(3));
        const code = []; i += 1;
        while (i < lines.length && !trim(lines[i]).startsWith('```')) { code.push(lines[i]); i += 1; }
        blocks.push({ kind: 'code', text: code.join('\n'), lang: lang || null }); i += 1; continue;
      }
      if (t.startsWith('|') && i + 1 < lines.length && MarkdownParser.isSeparatorRow(lines[i + 1])) {
        flush(); const header = MarkdownParser.cells(t); i += 2; const rows = [];
        while (i < lines.length && trim(lines[i]).startsWith('|')) { rows.push(MarkdownParser.cells(lines[i])); i += 1; }
        blocks.push({ kind: 'table', header, rows }); continue;
      }
      const hm = /^#{1,6} /.exec(t);
      if (hm) { flush(); blocks.push({ kind: 'heading', level: hm[0].length - 1, text: t.slice(hm[0].length) }); i += 1; continue; }
      if (t === '---' || t === '***') { flush(); blocks.push({ kind: 'rule' }); i += 1; continue; }
      if (t.startsWith('> ') || t === '>') {
        flush(); const q = [];
        while (i < lines.length && trim(lines[i]).startsWith('>')) { q.push(trim(trim(lines[i]).slice(1))); i += 1; }
        blocks.push({ kind: 'quote', text: q.join('\n') }); continue;
      }
      if (MarkdownParser.isListItem(t)) {
        flush(); const items = []; const ordered = /^\d/.test(t);
        while (i < lines.length && MarkdownParser.isListItem(trim(lines[i]))) {
          let s = trim(lines[i]);
          const r = listRx.exec(s); if (r) s = s.slice(r[0].length);
          items.push(s); i += 1;
          // continuation lines (indented) join the item
          while (i < lines.length && lines[i].startsWith('  ') && !MarkdownParser.isListItem(trim(lines[i])) && trim(lines[i]) !== '') {
            items[items.length - 1] += ' ' + trim(lines[i]); i += 1;
          }
        }
        blocks.push({ kind: 'list', items, ordered }); continue;
      }
      if (t === '') flush(); else para.push(line);
      i += 1;
    }
    flush();
    return blocks;
  },
  isListItem(t) { return listRx.test(t); },
  isSeparatorRow(s) {
    const t = s.replace(/^[ \t]+|[ \t]+$/g, '');
    return t.startsWith('|') && /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(t);
  },
  cells(s) {
    let t = s.replace(/^[ \t]+|[ \t]+$/g, '');
    if (t.startsWith('|')) t = t.slice(1);
    if (t.endsWith('|')) t = t.slice(0, -1);
    return t.split('|').map((c) => c.replace(/^[ \t]+|[ \t]+$/g, ''));
  },
  /** Inline Markdown (AttributedString(markdown:, .inlineOnlyPreservingWhitespace)) plus PathLinks, as vnodes. */
  inline(s, key = '') { return inlineNodes(String(s), key); },
};

// Inline spans: `code`, [text](url), **bold** / __bold__, *italic* / _italic_, ~~strike~~; backslash escapes.
// Plain runs get the file-path links.
function inlineNodes(s, key) {
  const out = [];
  let buf = '', i = 0, n = 0;
  const flushText = () => { if (buf) { out.push(...PathLinks.link(buf, key + 't' + n++)); buf = ''; } };
  const findClose = (tok, from) => {
    let j = s.indexOf(tok, from);
    while (j > 0 && s[j - 1] === '\\') j = s.indexOf(tok, j + 1);
    return j;
  };
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && /[\\`*_\[\]()~#>|!-]/.test(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }
    if (c === '`') {
      let ticks = 1; while (s[i + ticks] === '`') ticks++;
      const tok = '`'.repeat(ticks);
      const j = s.indexOf(tok, i + ticks);
      if (j > i) {
        flushText();
        let code = s.slice(i + ticks, j);
        if (code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1);
        out.push(h('code', { key: key + 'c' + n++, class: 'md-code' }, PathLinks.link(code, key + 'cl' + n)));
        i = j + ticks; continue;
      }
    }
    if (c === '[') {
      const close = findClose(']', i + 1);
      if (close > i && s[close + 1] === '(') {
        const end = s.indexOf(')', close + 2);
        if (end > close) {
          flushText();
          const label = s.slice(i + 1, close), url = s.slice(close + 2, end).trim().split(/\s+/)[0];
          out.push(linkNode(url, inlineNodes(label, key + 'l' + n), key + 'a' + n++));
          i = end + 1; continue;
        }
      }
    }
    if ((c === '*' || c === '_') && s[i + 1] === c) {
      const tok = c + c, j = findClose(tok, i + 2);
      if (j > i + 2 && s[i + 2] !== ' ' && !(c === '_' && /\w/.test(s[i - 1] || ''))) {
        flushText(); out.push(h('strong', { key: key + 'b' + n++ }, inlineNodes(s.slice(i + 2, j), key + 'b' + n))); i = j + 2; continue;
      }
    }
    if (c === '~' && s[i + 1] === '~') {
      const j = findClose('~~', i + 2);
      if (j > i + 2) { flushText(); out.push(h('s', { key: key + 's' + n++ }, inlineNodes(s.slice(i + 2, j), key + 's' + n))); i = j + 2; continue; }
    }
    if ((c === '*' || c === '_') && s[i + 1] !== c && s[i + 1] && s[i + 1] !== ' ' && !(c === '_' && /\w/.test(s[i - 1] || ''))) {
      let j = findClose(c, i + 1);
      while (j > 0 && s[j + 1] === c) j = findClose(c, j + 2);
      if (j > i + 1 && s[j - 1] !== ' ' && !(c === '_' && /\w/.test(s[j + 1] || ''))) {
        flushText(); out.push(h('em', { key: key + 'i' + n++ }, inlineNodes(s.slice(i + 1, j), key + 'i' + n))); i = j + 1; continue;
      }
    }
    buf += c; i += 1;
  }
  flushText();
  return out;
}
/** A Markdown link: web links open in the browser (main's window-open handler), file links in the file manager. */
function linkNode(url, children, key) {
  if (/^file:/i.test(url) || url.startsWith('/') || url.startsWith('~/')) {
    const p = url.replace(/^file:\/\//i, '');
    return h('a', { key, href: '#', class: 'path-link', title: p, onClick: (e) => { e.preventDefault(); act('platform.openPathLink', decodeURI(p)); } }, children);
  }
  return h('a', { key, href: url, target: '_blank', rel: 'noreferrer', title: url }, children);
}

// ── MarkdownView ───────────────────────────────────────────────────────────────────────────────────────────────────

const blockCache = new Map();
/** Parsed once per text (rows are rebuilt on every chat update). */
function blocksOf(text) {
  let b = blockCache.get(text);
  if (!b) { b = MarkdownParser.parse(text); if (blockCache.size > 2000) blockCache.clear(); blockCache.set(text, b); }
  return b;
}

/** props: text, fontSize (px; default the chat font), mono (terminal-style chat: the same blocks monospaced),
 *  color (CSS colour of the body text), class, style. */
export function MarkdownView({ text, fontSize, mono, color, class: cls, style }) {
  usePathLinks();
  const [chatFont] = useAppStorage('ui.chatFont', 15);
  const fs = fontSize || chatFont;
  const blocks = blocksOf(text || '');
  return html`<div class=${'md' + (mono ? ' md-mono' : '') + (cls ? ' ' + cls : '')} style=${{ '--md-fs': `${fs}px`, ...(color ? { '--md-color': color } : null), ...style }}>
    ${blocks.map((b, i) => renderBlock(b, i, mono))}
  </div>`;
}

function renderBlock(b, i, mono) {
  const k = 'b' + i;
  switch (b.kind) {
    case 'heading':
      return html`<div key=${k} class=${'md-heading md-h' + Math.min(b.level, 3)}>${MarkdownParser.inline(b.text, k)}</div>`;
    case 'paragraph':
      return html`<div key=${k} class="md-paragraph selectable">${MarkdownParser.inline(b.text, k)}</div>`;
    case 'code':
      return html`<${CopyOnHover} key=${k} text=${b.text} class="md-codeblock">
        ${b.lang ? html`<div class="md-lang">${b.lang}</div>` : null}
        <div class="md-codescroll"><pre class="selectable">${b.text}</pre></div>
      <//>`;
    case 'table':
      return html`<div key=${k} class="md-table"><table>
        <thead><tr>${b.header.map((c, ci) => html`<th key=${ci} class="selectable">${MarkdownParser.inline(c, k + 'h' + ci)}</th>`)}</tr></thead>
        <tbody>${b.rows.map((r, ri) => html`<tr key=${ri} class=${ri % 2 ? 'odd' : ''}>${b.header.map((_, ci) => html`<td key=${ci} class="selectable">${MarkdownParser.inline(ci < r.length ? r[ci] : '', k + 'r' + ri + 'c' + ci)}</td>`)}</tr>`)}</tbody>
      </table></div>`;
    case 'list':
      return html`<div key=${k} class="md-list">${b.items.map((it, ii) => html`<div key=${ii} class="md-li">
        <span class="md-marker">${b.ordered ? `${ii + 1}.` : '•'}</span><span class="md-li-text selectable">${MarkdownParser.inline(it, k + 'i' + ii)}</span>
      </div>`)}</div>`;
    case 'quote':
      return html`<${CopyOnHover} key=${k} text=${b.text} class=${'md-quote' + (mono ? ' mono' : '')}>
        <i class="md-quote-bar"></i><div class="md-quote-text selectable">${MarkdownParser.inline(b.text, k)}</div>
      <//>`;
    case 'rule': return html`<hr key=${k} class="md-rule" />`;
    default: return null;
  }
}

/** A copy button in the top-right corner, shown while the pointer is over the block (nothing drawn otherwise). */
export function CopyOnHover({ text, class: cls, children }) {
  const [hover, setHover] = useState(false);
  const [copied, setCopied] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  return html`<div class=${'copy-hover ' + (cls || '')} onMouseEnter=${() => setHover(true)} onMouseLeave=${() => setHover(false)}>
    ${children}
    ${hover || copied ? html`<button type="button" class="copy-hover-btn" title=${L('이 칸의 내용을 복사합니다')}
        onClick=${() => { act('platform.copyText', text); setCopied(true); clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(false), 1200); }}>
      <${Label} icon=${copied ? 'checkmark' : 'doc.on.doc'} title=${copied ? L('복사됨') : L('복사')} />
    </button>` : null}
  </div>`;
}

// ── Composer ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Shift+Enter: lists continue themselves. After "1. text" the next line starts "2. "; on an empty "2. " the marker
 *  is removed and the list ends. Same for "- " / "* " / "• " bullets. */
export function newline(text) {
  const lines = text.split('\n');
  const last = lines[lines.length - 1] || '';
  let m = /^(\s*)(\d+)([.)])\s/.exec(last);
  if (m) {
    if (last.slice(m[0].length).trim() === '') { lines[lines.length - 1] = ''; return lines.join('\n'); }   // empty item: end the list
    const indent = m[1];
    const n = parseInt(m[2], 10) || 0;
    const sep = m[0].includes(')') ? ')' : '.';
    return text + `\n${indent}${n + 1}${sep} `;
  }
  m = /^(\s*)([-*•])\s/.exec(last);
  if (m) {
    if (last.slice(m[0].length).trim() === '') { lines[lines.length - 1] = ''; return lines.join('\n'); }
    return text + '\n' + m[0];
  }
  return text + '\n';
}

/**
 * The composer's text box. Grows from 1 to 5 lines, then scrolls. Enter sends, Shift+Enter makes a new line.
 * props: text, onText(t), placeholder, enabled, onSend(), onPaste(ClipboardEvent) → true when it took the paste (files /
 * images → attachments), keyHook(KeyboardEvent) → true to consume (palettes, history, Tab, Esc), ghost (the whole
 * suggested text, drawn dimmed after what is typed), onDropFiles(File[]) (files dropped on the text: attachments, not a
 * pasted path), onDragOver(bool) (the drop hint), inputRef.
 */
export function Composer({ text, onText, placeholder, enabled, onSend, onPaste, keyHook, ghost, onDropFiles, onDragOver, inputRef }) {
  const [chatFont] = useAppStorage('ui.chatFont', 15);
  const [focused, setFocused] = useState(false);
  const ta = useRef(null);
  const typed = useRef(text);         // the last value the field itself produced
  const line = Math.ceil(chatFont * 1.32);
  const inset = { w: 14, h: 10 };
  const [height, setHeight] = useState(line + inset.h * 2);

  /** Height for 1–5 lines; past that the field scrolls (and keeps the caret in view by itself). */
  const fit = () => {
    const el = ta.current; if (!el) return;
    el.style.height = '0px';
    const used = Math.max(line, el.scrollHeight - inset.h * 2);
    const hgt = Math.min(used, line * 5) + inset.h * 2;
    el.style.height = `${hgt}px`;
    if (Math.abs(hgt - height) > 0.5) setHeight(hgt);
  };
  // text changed from outside (sent → cleared, history, Tab fill): replace and put the caret at the end
  useLayoutEffect(() => {
    const el = ta.current; if (!el) return;
    if (text !== typed.current || el.value !== text) {
      typed.current = text;
      if (el.value !== text) el.value = text;
      if (document.activeElement === el) el.setSelectionRange(text.length, text.length);
      el.scrollTop = el.scrollHeight;
    }
    fit();
  }, [text, chatFont]);
  useEffect(() => { if (inputRef) inputRef.current = ta.current; });

  const rest = (() => {   // what is left of the suggestion after the typed text
    if (!ghost || !enabled) return null;
    if (!text) return ghost;
    if (!(ghost.length > text.length && ghost.toLowerCase().startsWith(text.toLowerCase()))) return null;
    return ghost.slice(text.length);
  })();

  const setText = (t) => { typed.current = t; onText(t); };
  const onKeyDown = (e) => {
    if (e.isComposing || e.keyCode === 229) return;                     // IME composing (hasMarkedText)
    if (keyHook && keyHook(e)) { e.preventDefault(); e.stopPropagation(); return; }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const el = ta.current;
    if (e.shiftKey) {
      // break at the caret (selection replaced), not at the end of the text
      const v = el.value, a = el.selectionStart, b = el.selectionEnd;
      const head = newline(v.slice(0, a));
      const t = head + v.slice(b);
      el.value = t; setText(t);
      el.setSelectionRange(head.length, head.length);
      fit(); return;
    }
    onSend();
  };
  const hasFiles = (dt) => dt && [...(dt.types || [])].includes('Files');
  return html`<div class=${'composer' + (focused ? ' focused' : '') + (enabled ? '' : ' disabled')} style=${{ '--composer-fs': `${chatFont}px`, '--composer-line': `${line}px` }}>
    <textarea ref=${ta} class="composer-field" rows="1" spellcheck=${false} disabled=${!enabled}
      style=${{ height: `${height}px` }}
      onInput=${(e) => { setText(e.currentTarget.value); fit(); }}
      onKeyDown=${onKeyDown}
      onFocus=${() => setFocused(true)} onBlur=${() => setFocused(false)}
      onPaste=${(e) => { if (onPaste && onPaste(e)) e.preventDefault(); }}
      onDragEnter=${(e) => { if (hasFiles(e.dataTransfer)) { e.preventDefault(); if (onDropFiles && onDragOver) onDragOver(true); } }}
      onDragOver=${(e) => { if (hasFiles(e.dataTransfer)) { e.preventDefault(); e.dataTransfer.dropEffect = onDropFiles ? 'copy' : 'none'; } }}
      onDragLeave=${() => onDragOver && onDragOver(false)}
      onDrop=${(e) => {
        if (onDragOver) onDragOver(false);
        if (!hasFiles(e.dataTransfer)) return;     // text drops insert as usual
        e.preventDefault(); e.stopPropagation();
        const files = [...e.dataTransfer.files];
        if (files.length && onDropFiles) onDropFiles(files);
      }}></textarea>
    ${!text.includes('\n') ? html`<div class=${'composer-ghost' + (rest == null && !text ? ' placeholder' : '')} aria-hidden="true" style=${{ maxHeight: `${height}px` }}><span class="ghost-typed">${rest == null ? '' : text}</span><span class="ghost-rest">${rest != null ? rest : (text ? '' : placeholder)}</span></div>` : null}
  </div>`;
}
Composer.newline = newline;
