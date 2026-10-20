// The banner's task area, ported from TodoCard.swift (the views; the data lives in main/todo.js, TodoStore):
// three or more cards the size of the usage cards; clicking one unfolds its full checklist in a popover.
// Compact banner: one checklist icon with the open-item count, every card in one popover.
import { html, useState, useEffect, useRef, call, on, L } from '../lib.js';
import { Icon, Button, Popover } from './widgets.js';
import { Bar } from './banner.js';

/** TodoStore.count: at least three cards; more with the + button. */
const COUNT = 3;
const remaining = (b) => b.items.filter((x) => !x.done).length;

// one shared copy of the boards for every card on screen; main pushes 'todos' after each change
let boardsCache = null;
const subs = new Set();
function publish(b) { if (Array.isArray(b)) { boardsCache = b; subs.forEach((f) => f(b)); } }
on('todos', publish);
/** TodoStore.shared as a hook: [boards, act(name, ...args)] — act calls todo.<name> and takes the boards it returns. */
function useTodos() {
  const [b, set] = useState(boardsCache || []);
  useEffect(() => {
    subs.add(set);
    if (!boardsCache) call('todo.boards').then(publish).catch(() => { });
    return () => subs.delete(set);
  }, []);
  const act = (name, ...args) => call('todo.' + name, ...args).then(publish).catch((e) => console.error('todo', name, e));
  return [b, act];
}

/** The banner's task area. forceIcon: compact banner (one icon, every card in a popover). */
export function TodoCard({ forceIcon = false }) {
  const [boards, act] = useTodos();
  const [open, setOpen] = useState(false);
  const iconRef = useRef(null);
  if (forceIcon) {
    const r = boards.reduce((n, b) => n + remaining(b), 0);
    return html`<span ref=${iconRef} style=${{ display: 'inline-flex' }}>
      <${Button} kind="icon" help=${L('과제')} onClick=${() => setOpen(!open)}>
        <span class="hstack fg-secondary" style=${{ gap: '4px' }}>
          <${Icon} name="checklist" size=${14} />
          ${r > 0 ? html`<span class="t-caption t-digits t-semibold">${r}</span>` : null}
        </span>
      <//>
      ${open ? html`<${Popover} anchor=${iconRef} width=${300} padding=${12} onClose=${() => setOpen(false)}>
        <div class="vstack" style=${{ gap: '10px' }}>${boards.map((b, i) => html`<${TaskPanel} key=${b.id} board=${b} index=${i + 1} count=${boards.length} act=${act} />`)}</div>
      <//>` : null}
    </span>`;
  }
  // cards in a row that scrolls sideways; + adds one (the banner never pushes the window wider)
  return html`<div class="todo-row">
    ${boards.map((b, i) => html`<${TaskCardView} key=${b.id} board=${b} index=${i + 1} count=${boards.length} act=${act} />`)}
    <${Button} kind="plain" class="todo-add" help=${L('과제 카드 추가')} onClick=${() => act('addBoard')}><${Icon} name="plus" size=${14} strokeWidth=${2.5} /><//>
  </div>`;
}

/** Folded card (usage-card size). A click opens the full panel in a popover below it without moving anything. */
function TaskCardView({ board, index, count, act }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const done = board.items.length - remaining(board);
  return html`<div ref=${ref} class=${'task-card' + (open ? ' open' : '')} onClick=${() => setOpen(!open)}>
    <div class="hstack" style=${{ gap: '6px' }}>
      <span class="t-caption t-semibold one-line" style=${{ color: board.title ? 'color-mix(in srgb, var(--fg-solid) 90%, transparent)' : 'var(--secondary)' }}>${board.title || L('과제 %@', String(index))}</span>
      <span class="spacer" style=${{ minWidth: '4px' }}></span>
      ${board.items.length ? html`<span class="t-caption2 t-digits fg-secondary">${done}/${board.items.length}</span>` : null}
    </div>
    <${Bar} value=${board.items.length ? done / board.items.length : 0} tint="color-mix(in srgb, var(--accent) 85%, transparent)" height=${4} />
    ${board.items.length === 0
      ? html`<span class="t-caption2 fg-tertiary one-line">${L('클릭해서 할 일 추가')}</span>`
      : board.items.slice(0, 2).map((it) => html`<span key=${it.id} class="t-caption2 fg-tertiary one-line" style=${it.done ? { textDecoration: 'line-through' } : null}>${it.text}</span>`)}
    ${open ? html`<${Popover} anchor=${ref} width=${304} padding=${12} onClose=${() => setOpen(false)}>
      <div onClick=${(e) => e.stopPropagation()}><${TaskPanel} board=${board} index=${index} count=${count} act=${act} /></div>
    <//>` : null}
  </div>`;
}

/** The unfolded card: editable title, every item with a checkbox, an add field. Items reorder by drag and drop. */
function TaskPanel({ board, index, count, act }) {
  const [title, setTitle] = useState(board.title);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(null);
  const [editText, setEditText] = useState('');
  const addRef = useRef(null);
  const commitTitle = () => { if (title.trim() !== board.title) act('setTitle', board.id, title); };
  return html`<div class="task-panel vstack" style=${{ gap: '8px' }}>
    <div class="hstack" style=${{ gap: '6px' }}>
      <input class="textfield-plain" style=${{ flex: '1 1 auto', fontSize: '14px', fontWeight: 600, minWidth: 0 }} placeholder=${L('과제 %@ 제목', String(index))}
        value=${title} onInput=${(e) => setTitle(e.currentTarget.value)} onBlur=${commitTitle}
        onKeyDown=${(e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); commitTitle(); } }} />
      ${board.items.some((x) => x.done) ? html`<${Button} kind="plain" class="t-caption fg-secondary" onClick=${() => act('clearDone', board.id)}>${L('완료 지우기')}<//>` : null}
      ${count > COUNT ? html`<${Button} kind="icon" help=${L('이 과제 카드 삭제')} onClick=${() => act('removeBoard', board.id)}><${Icon} name="trash" /><//>` : null}
    </div>
    <div class="task-divider"></div>
    <div class="task-list">
      ${board.items.map((it) => html`<div key=${it.id} class="task-row" draggable=${editing !== it.id}
          onDragStart=${(e) => { e.dataTransfer.setData('text/plain', it.id); e.dataTransfer.effectAllowed = 'move'; }}
          onDragOver=${(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
          onDrop=${(e) => { e.preventDefault(); const id = e.dataTransfer.getData('text/plain'); if (id) act('move', board.id, id, it.id); }}>
        <${Button} kind="plain" onClick=${() => act('toggle', board.id, it.id)}>
          <${Icon} name=${it.done ? 'checkmark.circle.fill' : 'circle'} size=${14} color=${it.done ? 'var(--accent)' : 'var(--secondary)'} />
        <//>
        ${editing === it.id
          ? html`<input class="textfield-plain t-callout" style=${{ flex: '1 1 auto', minWidth: 0 }} value=${editText} ref=${(el) => el && document.activeElement !== el && el.focus()}
              onInput=${(e) => setEditText(e.currentTarget.value)}
              onKeyDown=${(e) => {
                if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); act('edit', board.id, it.id, editText); setEditing(null); }
                else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditing(null); }
              }} />`
          : html`<span class="t-callout task-text" style=${{ color: it.done ? 'var(--secondary)' : 'color-mix(in srgb, var(--fg-solid) 90%, transparent)', textDecoration: it.done ? 'line-through' : null }}
              onDblClick=${() => { setEditText(it.text); setEditing(it.id); }}>${it.text}</span>`}
        <${Button} kind="icon" help=${L('삭제')} onClick=${() => act('remove', board.id, it.id)}><${Icon} name="xmark" size=${9} /><//>
      </div>`)}
      ${board.items.length === 0 ? html`<span class="t-callout fg-tertiary" style=${{ padding: '6px 0' }}>${L('아직 항목이 없습니다')}</span>` : null}
    </div>
    <div class="task-add hstack">
      <${Icon} name="plus" class="t-caption fg-tertiary" />
      <input ref=${addRef} class="textfield-plain t-callout" style=${{ flex: '1 1 auto', minWidth: 0 }} placeholder=${L('항목 추가 후 Enter')} value=${draft}
        onInput=${(e) => setDraft(e.currentTarget.value)}
        onKeyDown=${(e) => {
          if (e.key !== 'Enter') return;
          // Enter while the IME composes: the syllable is committed first, then added (one Enter, as in Swift)
          if (e.isComposing) { addRef.pendingAdd = true; return; }
          e.preventDefault();
          act('add', board.id, e.currentTarget.value);
          setDraft('');
          if (addRef.current) addRef.current.focus();
        }}
        onCompositionEnd=${(e) => {
          if (!addRef.pendingAdd) return;
          addRef.pendingAdd = false;
          const v = e.currentTarget.value;
          setTimeout(() => { act('add', board.id, v); setDraft(''); }, 0);
        }} />
    </div>
  </div>`;
}
