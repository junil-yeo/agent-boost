// Port of ConvoSearch.swift's ConvoSearchSheet (Ctrl+Shift+F, ⌘⇧F on the Mac): search all conversations. Results on
// the left; the picked message with the messages around it on the right. The index (ConvoIndex) is main/search.js:
//   search.refresh()                 read what was appended since the last time (the first call reads every file)
//   search.sessions()                number of indexed sessions
//   search.search(q, limit = 300)    → [{id, sid, project, title, index, user, time, text}], newest first
//   search.context(sid, index, r=3)  → {sid, project, title, index, msgs: [{index, user, time, text}]}
// Export: ConvoSearchSheet({onClose}) — shown while rendered.
import { html, useState, useEffect, useRef, useLayoutEffect, L } from '../lib.js';
import { Icon, Label, Button, Sheet, ProgressSpinner } from './widgets.js';
import { act, useBoard, agentIn, useAppStorage } from './board.js';

const CSS = `
.cs-bar { display: flex; align-items: center; gap: 8px; padding: 10px; border-radius: 8px; background: var(--panel); }
.cs-bar input { flex: 1 1 auto; min-width: 0; font-size: var(--fs-title3); }
.cs-split { flex: 1 1 auto; min-height: 0; display: flex; }
.cs-list { overflow-y: auto; min-width: 320px; outline: none; }
.cs-row { padding: 4px 8px; border-radius: 5px; display: flex; flex-direction: column; gap: 3px; cursor: default; }
.cs-row.sel { background: var(--accent); color: #fff; }
.cs-row.sel .cs-dim { color: rgba(255,255,255,.8); }
.cs-dim { color: var(--secondary); }
.cs-who { font-size: var(--fs-caption2); padding: 1px 5px; border-radius: 999px; flex: 0 0 auto; }
.cs-snippet { font-size: var(--fs-caption); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.cs-mark { background: color-mix(in srgb, var(--accent) 28%, transparent); color: var(--fg-solid); }
.cs-divider { flex: 0 0 9px; cursor: col-resize; position: relative; }
.cs-divider::after { content: ""; position: absolute; top: 0; bottom: 0; left: 4px; width: 1px; background: var(--line); }
.cs-detail { flex: 1 1 auto; min-width: 380px; display: flex; flex-direction: column; gap: 8px; min-height: 0; }
.cs-msgs { flex: 1 1 auto; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; padding: 4px; }
.cs-msg { padding: 10px; border-radius: 8px; background: var(--panel); border: 1px solid transparent; display: flex; flex-direction: column; gap: 4px; }
.cs-msg.hit { background: color-mix(in srgb, var(--accent) 8%, transparent); border-color: color-mix(in srgb, var(--accent) 50%, transparent); }
.cs-msg .cs-text { font-size: var(--fs-callout); white-space: pre-wrap; overflow-wrap: anywhere; }
`;
function ensureCSS() {
  if (document.querySelector('style[data-ab-search]')) return;
  const s = document.createElement('style'); s.setAttribute('data-ab-search', ''); s.textContent = CSS; document.head.appendChild(s);
}

const pad2 = (n) => String(n).padStart(2, '0');
/** "M/d HH:mm" */
function day(t) { if (t == null) return ''; const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
const wordsOf = (q) => String(q || '').toLowerCase().split(' ').filter((w) => w);

/** The text with every query word marked (vnodes). */
function mark(s, words) {
  const low = s.toLowerCase();
  if (low.length !== s.length || !words.length) return s;        // lower-casing changed the length: no marks
  const on = new Uint8Array(s.length);
  for (const w of words) {
    let from = 0, i;
    while ((i = low.indexOf(w, from)) !== -1) { on.fill(1, i, i + w.length); from = i + w.length; }
  }
  const out = [];
  let i = 0;
  while (i < s.length) {
    let j = i; while (j < s.length && on[j] === on[i]) j++;
    out.push(on[i] ? html`<span class="cs-mark">${s.slice(i, j)}</span>` : s.slice(i, j));
    i = j;
  }
  return out;
}
/** The text around the first word found, that word marked. */
function snippet(text, query) {
  const flat = text.split('\n').join(' ');
  const words = wordsOf(query);
  const w = words[0];
  const at = w ? flat.toLowerCase().indexOf(w) : -1;
  if (at < 0) return Array.from(flat).slice(0, 120).join('');
  const start = Math.max(0, at - 40);
  const piece = (start > 0 ? '…' : '') + Array.from(flat.slice(start)).slice(0, 160).join('');
  return mark(piece, words);
}

/** props: onClose. */
export function ConvoSearchSheet({ onClose }) {
  ensureCSS();
  const s = useBoard();
  const [query, setQuery] = useAppStorage('search.query', '');
  const [hits, setHits] = useState([]);
  const [picked, setPicked] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sessions, setSessions] = useState(0);
  const [leftW, setLeftW] = useState(380);
  const field = useRef(null);
  const seq = useRef(0);
  const pickedRef = useRef(null);
  pickedRef.current = picked;
  // run() reads the query at the time it runs, as Swift's run() does (`let q = query`): text typed while the index was
  // loading is what the first search after loading uses, not the query captured when the sheet opened.
  const queryRef = useRef(query);
  queryRef.current = query;
  // Contexts (the hit ±3) by hit id. Swift has every message in hand and draws the context at once. Here it takes an
  // IPC round trip, so contexts are fetched ahead (the picked hit and its neighbours) and the detail keeps the last
  // shown one until the new one is in, instead of flashing the single message first.
  const ctxCache = useRef(new Map());
  const [shown, setShown] = useState(null);           // {h, ctx}

  /** {promise, done, value} for a hit's context, fetched once per sheet (the index is read once, on open). */
  const loadCtx = (h) => {
    const c = ctxCache.current;
    if (!c.has(h.id)) {
      const e = { done: false, value: null };
      e.promise = act('search.context', h.path || h.sid, h.index, 3).then((x) => x || null, () => null)
        .then((x) => { e.done = true; e.value = x; return x; });
      c.set(h.id, e);
    }
    return c.get(h.id);
  };

  const run = async (q = queryRef.current) => {
    const n = ++seq.current;
    const r = (await act('search.search', q)) || [];
    if (n !== seq.current) return;
    setHits(r);
    if (pickedRef.current == null || !r.some((h) => h.id === pickedRef.current)) setPicked(r.length ? r[0].id : null);
  };
  useEffect(() => { if (field.current) field.current.focus(); }, []);
  useEffect(() => {
    let live = true;
    (async () => {
      await act('search.refresh');
      const n = await act('search.sessions');
      if (!live) return;
      setSessions(n || 0);
      setLoading(false);
      run();
    })();
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (loading) return;
    const t = setTimeout(() => run(), 200);
    return () => clearTimeout(t);
  }, [query]);

  const title = (h) => { const a = agentIn(s, h.sid); return (a && a.name) || h.title || (h.project || '').split('-').pop(); };
  const status = loading ? L('대화 기록을 읽는 중…')
    : query.trim() === '' ? L('세션 %@개의 대화를 검색합니다', String(sessions))
      : L('%@개 찾음 · 세션 %@개 검색', hits.length === 300 ? '300+' : String(hits.length), String(sessions));
  const listKey = (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const i = hits.findIndex((h) => h.id === picked);
    const j = Math.max(0, Math.min(hits.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
    if (hits[j]) setPicked(hits[j].id);
  };
  const drag = (e) => {
    e.preventDefault();
    const x0 = e.clientX, w0 = leftW;
    const move = (m) => setLeftW(Math.max(320, Math.min(1000 - 32 - 380 - 9, w0 + m.clientX - x0)));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  const hit = hits.find((h) => h.id === picked) || null;

  // Show the picked hit's context: at once when it was fetched ahead, else when it arrives. Neighbours are fetched
  // ahead so arrow-key moves find theirs ready.
  useLayoutEffect(() => {
    if (!hit) { setShown(null); return; }
    let live = true;
    const show = (ctx) => { if (live) setShown({ h: hit, ctx }); };
    const e = loadCtx(hit);
    if (e.done) show(e.value); else e.promise.then(show);
    const i = hits.indexOf(hit);
    for (const j of [i + 1, i - 1, i + 2, i - 2]) if (hits[j]) loadCtx(hits[j]);
    return () => { live = false; };
  }, [hit && hit.id, hits]);
  const view = hit ? shown : null;

  return html`<${Sheet} width=${1000} height=${640} padding=${16} onClose=${onClose} style=${{ display: 'flex', flexDirection: 'column', gap: '10px', overflow: 'hidden' }}>
    <div class="cs-bar">
      <${Icon} name="magnifyingglass" color="var(--secondary)" />
      <input ref=${field} class="textfield-plain" value=${query} placeholder=${L('모든 세션의 대화에서 찾기 (여러 단어는 모두 포함)')}
        onInput=${(e) => setQuery(e.currentTarget.value)} />
      ${loading ? html`<${ProgressSpinner} />` : null}
      <${Button} kind="raisedCompact" onClick=${onClose}>${L('닫기')}<//>
    </div>
    <span class="t-caption fg-secondary">${status}</span>
    <div class="cs-split">
      <div class="cs-list" tabIndex="0" style=${{ width: `${leftW}px`, flex: `0 0 ${leftW}px` }} onKeyDown=${listKey}>
        ${hits.map((h) => html`<${Row} key=${h.id} h=${h} title=${title(h)} query=${query} sel=${h.id === picked} onPick=${() => setPicked(h.id)} />`)}
      </div>
      <div class="cs-divider" onPointerDown=${drag}></div>
      <div class="cs-detail">
        ${hit ? (view ? html`<${Detail} h=${view.h} ctx=${view.ctx} title=${title(view.h)} query=${query} agent=${agentIn(s, view.h.sid)} onClose=${onClose} />` : null)
          : html`<div class="fg-secondary" style=${{ flex: '1 1 auto', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>${loading ? '' : L('왼쪽에서 결과를 고르세요')}</div>`}
      </div>
    </div>
  <//>`;
}

function Row({ h, title, query, sel, onPick }) {
  const ref = useRef(null);
  useLayoutEffect(() => { if (sel && ref.current) ref.current.scrollIntoView({ block: 'nearest' }); }, [sel]);
  const tint = h.user ? 'var(--accent)' : 'var(--ink)';
  return html`<div ref=${ref} class=${'cs-row' + (sel ? ' sel' : '')} onMouseDown=${onPick}>
    <div class="hstack" style=${{ gap: '6px' }}>
      <span class="t-callout t-semibold one-line">${title}</span>
      <span class="cs-who" style=${{ background: `color-mix(in srgb, ${tint} 12%, transparent)` }}>${h.user ? L('나') : L('에이전트')}</span>
      <span class="spacer"></span>
      ${h.time != null ? html`<span class="t-caption cs-dim">${day(h.time)}</span>` : null}
    </div>
    <span class="cs-snippet cs-dim">${snippet(h.text, query)}</span>
  </div>`;
}

function Detail({ h, ctx, title, query, agent, onClose }) {
  const box = useRef(null);
  // the picked message in the middle of the view
  useLayoutEffect(() => {
    const el = box.current && box.current.querySelector('.cs-msg.hit');
    if (el) el.scrollIntoView({ block: 'center' });
  }, [h.id]);
  const words = wordsOf(query);
  const msgs = ctx ? ctx.msgs : [{ index: h.index, user: h.user, time: h.time, text: h.text }];
  return html`
    <div class="hstack" style=${{ gap: '8px' }}>
      <span class="t-headline one-line">${title}</span>
      <span class="spacer"></span>
      <${Button} kind="raisedCompact" onClick=${() => act('platform.copyText', h.text)}><${Label} icon="doc.on.doc" title=${L('메시지 복사')} /><//>
      ${agent ? html`<${Button} kind="raisedCompact" help=${L('이 세션의 대화창을 엽니다')} onClick=${() => { act('store.open', h.sid); onClose(); }}>
        <${Label} icon="arrow.right.circle" title=${L('세션으로 이동')} /><//>` : null}
    </div>
    <div class="cs-msgs" ref=${box}>
      ${msgs.map((m) => html`<div key=${h.id + '/' + m.index} class=${'cs-msg' + (m.index === h.index ? ' hit' : '')}>
        <div class="hstack" style=${{ gap: '8px' }}>
          <span class="t-caption t-semibold" style=${{ color: m.user ? 'var(--accent)' : 'var(--secondary)' }}>${m.user ? L('나') : L('에이전트')}</span>
          ${m.time != null ? html`<span class="t-caption fg-secondary">${day(m.time)}</span>` : null}
        </div>
        <div class="cs-text selectable">${m.index === h.index ? mark(m.text, words) : m.text}</div>
      </div>`)}
    </div>`;
}
