// Port of ToolLine.swift: one tool call as a quiet single line (summary + chevron); the details unfold underneath.
import { html, useState } from '../lib.js';
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
      <span class="tool-summary">${summary}</span>
    </button>
    ${expanded && hasDetail ? html`<div class="tool-detail selectable">${children}</div>` : null}
  </div>`;
}
