// Port of ToolLine.swift: one tool call as a quiet single line (summary + chevron); the details unfold underneath.
import { html, useState, useRef, useLayoutEffect } from '../lib.js';
import { Icon } from './widgets.js';
import { ensureStyles } from './board.js';

ensureStyles();

/**
 * props: summary, icon (SF name, default 'wrench.and.screwdriver'), isError, hasDetail (false: the summary is the whole
 * story — no arrow, not clickable), expanded, onToggle(), children (the details).
 */
export function ToolLine({ summary, icon = 'wrench.and.screwdriver', isError, hasDetail = true, expanded, onToggle, children }) {
  const [hover, setHover] = useState(false);
  const lit = hover || expanded;
  return html`<div class=${'tool-line' + (isError ? ' error' : '')}>
    <button type="button" class=${'tool-line-head' + (lit ? ' lit' : '')} disabled=${!hasDetail}
        onMouseEnter=${() => setHover(hasDetail)} onMouseLeave=${() => setHover(false)}
        onClick=${() => { if (hasDetail && onToggle) onToggle(); }}>
      <span class=${'tool-chevron' + (expanded ? ' open' : '')} style=${{ opacity: hasDetail ? 1 : 0 }}><${Icon} name="chevron.right" size=${9} strokeWidth=${3} /></span>
      <${Icon} name=${isError ? 'exclamationmark.triangle.fill' : icon} />
      <${MiddleText} class="tool-summary" text=${summary} />
    </button>
    ${expanded && hasDetail ? html`<div class="tool-detail selectable">${children}</div>` : null}
  </div>`;
}

// ── MiddleText ─────────────────────────────────────────────────────────────────────────────────────────────────────

let ctx2d = null;
/** Width of `s` in the CSS font `font` (a canvas measure: no layout). */
function measure(s, font) {
  if (!ctx2d) ctx2d = document.createElement('canvas').getContext('2d');
  if (ctx2d.font !== font) ctx2d.font = font;
  return ctx2d.measureText(s).width;
}
/** `s` cut in the middle with "…" so it fits `width` px (SwiftUI .truncationMode(.middle)): the start and the end of a
 *  long path or command stay visible, so a file name is not lost. */
export function middleTruncate(s, width, font) {
  if (!s || width <= 0 || measure(s, font) <= width) return s;
  const cs = Array.from(s);
  const cut = (k) => cs.slice(0, Math.ceil(k / 2)).join('') + '…' + cs.slice(cs.length - Math.floor(k / 2)).join('');
  let lo = 0, hi = cs.length - 1;
  while (lo < hi) {                       // the most characters that still fit
    const mid = (lo + hi + 1) >> 1;
    if (measure(cut(mid), font) <= width) lo = mid; else hi = mid - 1;
  }
  return cut(lo);
}

/** One line of text truncated in the middle to the width it is given (the element must get its width from its
 *  container: block, or flex: 1 1 auto with min-width 0). Re-cut when the width or the text changes; the full text is
 *  the tooltip when it was cut. props: text, class, style, title. */
export function MiddleText({ text, class: cls, style, title }) {
  const el = useRef(null);
  const [shown, setShown] = useState(text);
  const textRef = useRef(text); textRef.current = text;
  const fit = () => {
    const e = el.current; if (!e) return;
    const cs = getComputedStyle(e);
    const w = e.clientWidth - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0);
    const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const t = middleTruncate(String(textRef.current || ''), Math.floor(w), font);
    setShown((cur) => (cur === t ? cur : t));
  };
  useLayoutEffect(fit, [text]);
  useLayoutEffect(() => {
    const e = el.current; if (!e) return;
    let lastW = -1;
    const ro = new ResizeObserver(() => { const w = e.clientWidth; if (w !== lastW) { lastW = w; fit(); } });
    ro.observe(e);
    return () => ro.disconnect();
  }, []);
  return html`<span ref=${el} class=${'middle-text' + (cls ? ' ' + cls : '')} style=${style}
    title=${title != null ? title : shown !== text ? text : undefined}>${shown}</span>`;
}
