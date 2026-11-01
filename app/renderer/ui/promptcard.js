// Port of PromptCard.swift: the question Claude Code is asking in the terminal (permission, trust, model switch …),
// answered from here. Pure display: the caller supplies the texts and what happens on choose / cancel.
import { html, useState, L } from '../lib.js';
import { Icon, Button, ProgressSpinner } from './widgets.js';
import { ensureStyles } from './board.js';

ensureStyles();

/** props: title, detail, preview, options (labels), cursor, sending, onChoose(i, text), onCancel().
 *  A question of the AskUserQuestion tool also passes descs (a line under each label), checked (checkbox states of a
 *  multiSelect question, null for rows without a box) and textOption (the "Type something" row, answered with text). */
export function PromptCard({ title, detail, preview, options = [], descs = null, checked = null, textOption = -1, cursor, sending, onChoose, onCancel }) {
  return html`<div class="prompt-card">
    <div class="hstack" style=${{ gap: '8px' }}>
      <${Icon} name="hand.raised.fill" color="var(--attention)" />
      <span class="prompt-title selectable">${title}</span>
      <span class="spacer"></span>
      ${sending ? html`<${ProgressSpinner} /><span class="t-caption fg-secondary">${L('전송 중…')}</span>` : null}
    </div>
    ${detail ? html`<div class="prompt-detail selectable">${detail}</div>` : null}
    ${preview ? html`<${PreviewBox} text=${preview} />` : null}
    <div class="prompt-options">
      ${options.map((label, i) => i === textOption
        ? html`<${FreeText} key=${i} num=${i + 1} placeholder=${label} sending=${sending} onSend=${(t) => onChoose(i, t)} />`
        : html`<${Button} key=${i} kind="raised" prominent=${i === 0} minHeight=${30} disabled=${sending} class="prompt-option" onClick=${() => onChoose(i)}>
        <span class="prompt-num" style=${{ background: `color-mix(in srgb, var(--ink) ${i === 0 ? 28 : 12}%, transparent)` }}>${i + 1}</span>
        ${checked && checked[i] != null ? html`<${Icon} name=${checked[i] ? 'checkmark.square.fill' : 'square'} size=${14} />` : null}
        <span class="vstack prompt-text">
          <span class="prompt-label">${label}</span>
          ${descs && descs[i] ? html`<span class="prompt-desc">${descs[i]}</span>` : null}
        </span>
        <span class="spacer"></span>
        ${i === cursor && !sending ? html`<span class="t-caption2 fg-secondary prompt-default">${L('기본')}</span>` : null}
      <//>`)}
    </div>
    <div class="hstack">
      <span class="t-caption fg-secondary">${L('숫자 키 1–%@로 선택 · Esc로 취소', String(Math.max(1, Math.min(options.length, 9))))}</span>
      <span class="spacer"></span>
      <${Button} kind="raisedCompact" disabled=${sending} onClick=${onCancel}>${L('취소 (Esc)')}<//>
    </div>
  </div>`;
}

/** The question's "Type something" row: a field; Enter (or the button) answers with its text. */
function FreeText({ num, placeholder, sending, onSend }) {
  const [text, setText] = useState('');
  const go = () => { const t = text.trim(); if (t && !sending) { onSend(t); setText(''); } };
  return html`<div class="prompt-free hstack">
    <span class="prompt-num" style=${{ background: 'color-mix(in srgb, var(--ink) 12%, transparent)' }}>${num}</span>
    <input class="textfield-plain t-callout" style=${{ flex: '1 1 auto', minWidth: 0 }} placeholder=${placeholder} value=${text} disabled=${sending}
      onInput=${(e) => setText(e.currentTarget.value)}
      onKeyDown=${(e) => {
        e.stopPropagation();                              // the composer's keys (numbers, Esc) stay out of this field
        if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); go(); }
        else if (e.key === 'Escape') { e.preventDefault(); e.currentTarget.blur(); }
      }} />
    <${Button} kind="raisedCompact" disabled=${sending || !text.trim()} onClick=${go}>${L('보내기')}<//>
  </div>`;
}

function PreviewBox({ text }) {
  const [open, setOpen] = useState(true);
  const long = text.split('\n').length > 7;     // a short command needs no scroll view
  return html`<div class="prompt-preview">
    <button type="button" class="btn btn-plain prompt-preview-toggle" onClick=${() => setOpen(!open)}>
      <span class=${'tool-chevron' + (open ? ' open' : '')}><${Icon} name="chevron.right" size=${9} strokeWidth=${3} /></span>
      <span class="t-caption">${L('미리보기')}</span>
    </button>
    ${open ? html`<div class=${'prompt-preview-box' + (long ? ' scroll' : '')}><pre class="selectable">${text}</pre></div>` : null}
  </div>`;
}

/** 1–9 chooses, Esc cancels. Returns true when the key was used. `composerEmpty`: numbers are text while typing. */
PromptCard.handleKey = (ev, { optionCount, textOption = -1, sending, composerEmpty, onChoose, onCancel }) => {
  if (sending) return false;
  if (ev.key === 'Escape') { onCancel(); return true; }
  if (!composerEmpty || ev.metaKey || ev.ctrlKey || ev.altKey) return false;
  const n = /^[1-9]$/.test(ev.key) ? Number(ev.key) : NaN;
  if (!(n >= 1 && n <= Math.min(optionCount, 9)) || n - 1 === textOption) return false;   // the free-text row needs its field
  onChoose(n - 1); return true;
};
