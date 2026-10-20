// The "/" command palette and the "@" file palette above the composer: the views of SlashPalette.swift
// (SlashPaletteView) and Suggest.swift (MentionPaletteView). Their state and key handling live in
// renderer/logic/slash.mjs (SlashController) and renderer/logic/suggest.mjs (MentionController); the composer owns one
// of each and redraws when they change.
import { html, useEffect, useRef, L } from '../lib.js';
import { Icon } from './widgets.js';
import { ensureStyles } from './board.js';
import { MiddleText } from './toolline.js';

ensureStyles();

/** Keeps the selected row in view (ScrollViewReader.scrollTo). */
function useScrollToSelected(sel) {
  const box = useRef(null);
  useEffect(() => {
    const el = box.current && box.current.querySelector('.palette-row.selected');
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [sel]);
  return box;
}

/** props: ctl (SlashController), draft, onPick(command) (a click: ctl.pick(c, true) with send). */
export function SlashPaletteView({ ctl, draft, onPick }) {
  const list = ctl.items(draft);
  ctl.clamp(list.length);
  const sel = Math.min(ctl.index, Math.max(0, list.length - 1));
  const box = useScrollToSelected(list.length ? list[sel].id : null);
  if (!list.length) return null;
  return html`<div class="palette" ref=${box} style=${{ height: `${Math.min(list.length * 34 + 10, 276)}px` }}>
    ${list.map((c, i) => html`<div key=${c.id} class=${'palette-row slash-row' + (i === sel ? ' selected' : '')}
        onMouseDown=${(e) => e.preventDefault()} onClick=${() => onPick(c)}>
      <span class="slash-name">${c.text}</span>
      ${c.argHint ? html`<span class="slash-hint">${c.argHint}</span>` : null}
      <span class="slash-desc">${c.desc}</span>
      <span class="spacer" style=${{ minWidth: '4px' }}></span>
      ${c.terminalOnly ? html`<span class="palette-tag">${L('터미널에서 열림')}</span>` : null}
      ${c.source === 'user' ? html`<span class="palette-tag">${L('사용자')}</span>`
        : c.source === 'project' ? html`<span class="palette-tag">${L('프로젝트')}</span>`
        : c.source === 'skill' ? html`<span class="palette-tag">${L('스킬')}</span>` : null}
    </div>`)}
  </div>`;
}

/** props: ctl (MentionController), draft, onPick(path). Long paths are cut in the middle (Suggest.swift
 *  .truncationMode(.middle)): the file name at the end stays visible. */
export function MentionPaletteView({ ctl, draft, onPick }) {
  const list = ctl.items(draft);
  if (ctl.index >= list.length) ctl.index = Math.max(0, list.length - 1);
  const sel = Math.min(ctl.index, Math.max(0, list.length - 1));
  const box = useScrollToSelected(list.length ? list[sel] : null);
  if (!list.length) return null;
  return html`<div class="palette" ref=${box} style=${{ height: `${Math.min(list.length * 28 + 10, 250)}px` }}>
    ${list.map((p, i) => html`<div key=${p} class=${'palette-row mention-row' + (i === sel ? ' selected' : '')}
        onMouseDown=${(e) => e.preventDefault()} onClick=${() => onPick(p)}>
      <${Icon} name=${p.endsWith('/') ? 'folder' : 'doc.text'} class="mention-icon" />
      <${MiddleText} class="mention-path" text=${p} />
    </div>`)}
  </div>`;
}
