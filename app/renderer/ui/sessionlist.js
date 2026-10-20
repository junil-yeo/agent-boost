// 세션 목록 tab: every session the board detects (live and ended, teams and solos), like the CLI's own lists (the
// `claude --resume` picker: title, last modified, message count, project folder, git branch) plus state, model and
// output tokens. The org chart is the other view of the same sessions: it shows only the pinned ones, and each row here
// puts a session on it or takes it off (store.setPinned). Also the first-launch picker (PinSetupSheet) that chooses
// what the org chart starts with.
//
// A long history is hundreds of rows: they are drawn virtually (only the rows in view exist), and the metadata comes
// from store.sessionListMeta (head/tail reads cached by size + mtime, message counts in the background; main/listmeta.js).
// Numbers not read yet show "…", never 0.
import { html, useState, useEffect, useRef, useMemo, useLayoutEffect, call, L } from '../lib.js';
import { Icon, Label, Button, Chip, StateDot, Checkbox, EmptyState, Picker, Segmented, Sheet, showMenu } from './widgets.js';
import { Fmt } from '../fmt.js';
import { cardMenuEntries, DeleteSheetLazy, LazyView } from './orgchart.js';

{
  if (!document.querySelector('link[data-ab-sessionlist]')) {
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = new URL('./sessionlist.css', import.meta.url).href; l.setAttribute('data-ab-sessionlist', '');
    document.head.appendChild(l);
  }
}

const basename = (p) => { const s = String(p).replace(/\/+$/, ''); const i = s.lastIndexOf('/'); return i >= 0 ? s.slice(i + 1) : s; };
const pad2 = (n) => String(n).padStart(2, '0');
/** "10-20 14:03" this year, "2025-12-01" before. */
function fmtDate(t) {
  if (t == null) return '';
  const d = new Date(t), now = new Date();
  return d.getFullYear() === now.getFullYear() ? `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
    : `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
const live = (a) => a.state !== 'ended';

/** The list's metadata ({sid: {created, lastAt, count, branch, cwd, customTitle, aiTitle, firstPrompt}}), asked again when
 *  the store says it moved, when the sessions change, and every 5 s while shown. */
export function useListMeta(active, version, key) {
  const [meta, setMeta] = useState({});
  useEffect(() => {
    if (!active) return undefined;
    let on = true;
    const get = () => call('store.sessionListMeta').then((m) => { if (on && m) setMeta(m); }).catch(() => { });
    get();
    const id = setInterval(get, 5000);
    return () => { on = false; clearInterval(id); };
  }, [active, version, key]);
  return meta;
}

/** The name a row shows: the session's own (the store names ended ones like the /resume picker once their file is read),
 *  else the file's stored title or first prompt, which the list reads cheaply before that. */
function titleOf(a, m) {
  const own = a.name && a.name !== a.sessionId.slice(0, 8) ? a.name : null;
  return own ?? (m && (m.customTitle || m.aiTitle || m.firstPrompt)) ?? a.name ?? a.sessionId.slice(0, 8);
}

/** Every session of the state, once each: team members (with their team), then the others. */
function sessionRows(s, meta, pinned) {
  const out = [], seen = new Set();
  const add = (a, team) => {
    if (a.isSubagent || seen.has(a.sessionId)) return;
    seen.add(a.sessionId);
    const m = meta[a.sessionId] || null;
    const folder = a.cwd || (m && m.cwd) || null;
    out.push({
      key: a.sessionId, a, team, m, folder, title: titleOf(a, m), pinned: pinned.has(a.sessionId),
      last: (m && m.lastAt) ?? a.lastActivity ?? null, created: m ? m.created : null,
    });
  };
  for (const t of (s && s.teams) || []) for (const m of t.members || []) add(m, t);
  for (const a of (s && s.loose) || []) add(a, null);
  return out;
}

const SORTS = {
  last: (x, y) => (y.last ?? -Infinity) - (x.last ?? -Infinity),
  name: (x, y) => x.title.localeCompare(y.title),
  created: (x, y) => (y.created ?? -Infinity) - (x.created ?? -Infinity),
  folder: (x, y) => (x.folder || '￿').localeCompare(y.folder || '￿') || SORTS.last(x, y),
};

// ── virtual list ────────────────────────────────────────────────────────────────────────────────────────────────────
/** Only the items in view (plus a few) are drawn. props: items [{key, …}], sizeOf(item) → px, render(item). */
export function VirtualList({ items, sizeOf, render, class: cls, style, overscan = 8 }) {
  const ref = useRef(null);
  const [top, setTop] = useState(0);
  const [vh, setVh] = useState(800);
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return undefined;
    const ro = new ResizeObserver(() => setVh(el.clientHeight || 800));
    ro.observe(el); setVh(el.clientHeight || 800);
    return () => ro.disconnect();
  }, []);
  const offs = useMemo(() => {
    const o = new Array(items.length + 1); o[0] = 0;
    for (let i = 0; i < items.length; i++) o[i + 1] = o[i] + sizeOf(items[i]);
    return o;
  }, [items]);
  let lo = 0, hi = items.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (offs[mid + 1] <= top) lo = mid + 1; else hi = mid; }
  const start = Math.max(0, lo - overscan);
  let end = lo;
  while (end < items.length && offs[end] < top + vh) end++;
  end = Math.min(items.length, end + overscan);
  const shown = [];
  for (let i = start; i < end; i++) {
    const it = items[i];
    shown.push(html`<div key=${it.key} class="vlist-item" style=${{ top: `${offs[i]}px`, height: `${sizeOf(it)}px` }}>${render(it)}</div>`);
  }
  return html`<div ref=${ref} class=${'vlist ' + (cls || '')} style=${style} onScroll=${(e) => setTop(e.currentTarget.scrollTop)}>
    <div class="vlist-body" style=${{ height: `${offs[items.length]}px` }}>${shown}</div>
  </div>`;
}

// ── the tab ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const ROW_H = 54, GROUP_H = 34;
const prefKey = 'ui.sessionList';
function readPrefs() { try { return JSON.parse(localStorage.getItem(prefKey) || '{}') || {}; } catch { return {}; } }
function writePrefs(p) { try { localStorage.setItem(prefKey, JSON.stringify(p)); } catch { /* storage unavailable */ } }

/** props: s (store state), active (the tab is shown). */
export function SessionListView({ s, active = true }) {
  const saved = useMemo(readPrefs, []);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState(SORTS[saved.sort] ? saved.sort : 'last');
  const [show, setShow] = useState(['all', 'pinned', 'unpinned'].includes(saved.show) ? saved.show : 'all');
  const [folder, setFolder] = useState(null);
  const [grouped, setGrouped] = useState(!!saved.grouped);
  const [resuming, setResuming] = useState(null);
  const [deleting, setDeleting] = useState(null);
  useEffect(() => { writePrefs({ sort, show, grouped }); }, [sort, show, grouped]);

  const all = ((s && s.teams) || []).reduce((n, t) => n + t.members.length, 0) + ((s && s.loose) || []).length;
  const meta = useListMeta(active, s && s.listMetaVersion, all);
  const pinned = useMemo(() => new Set((s && s.pinned) || []), [s && s.pinned]);
  const rows = useMemo(() => sessionRows(s, meta, pinned), [s, meta, pinned]);

  const folders = useMemo(() => {
    const n = new Map();
    for (const r of rows) if (r.folder) n.set(r.folder, (n.get(r.folder) || 0) + 1);
    return [...n.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));
  }, [rows]);
  const q = query.trim().toLowerCase();
  const visible = useMemo(() => {
    const out = rows.filter((r) => {
      if (show === 'pinned' && !r.pinned) return false;
      if (show === 'unpinned' && r.pinned) return false;
      if (folder && r.folder !== folder) return false;
      if (!q) return true;
      const hay = [r.title, r.folder, r.m && r.m.branch, r.team && r.team.displayName, r.a.model, r.a.sessionId, r.m && r.m.firstPrompt].filter(Boolean).join('\n').toLowerCase();
      return q.split(/\s+/).every((w) => hay.includes(w));
    });
    return out.sort(SORTS[sort]);
  }, [rows, show, folder, q, sort]);
  const items = useMemo(() => {
    if (!grouped) return visible;
    const groups = new Map();
    for (const r of visible) { const k = r.folder || ''; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
    // folders in the order of their first row (so "last used" puts the folder used last on top)
    const out = [];
    for (const [k, rs] of groups) { out.push({ key: 'group:' + k, group: k, count: rs.length }); out.push(...rs); }
    return out;
  }, [visible, grouped]);
  const onChart = rows.filter((r) => r.pinned).length;

  const sortOptions = [
    { value: 'last', label: L('마지막 사용순') }, { value: 'name', label: L('이름순') },
    { value: 'created', label: L('만든 날짜순') }, { value: 'folder', label: L('폴더순') },
  ];
  const folderOptions = [{ value: null, label: L('모든 폴더 (%@)', String(folders.length)) },
    ...folders.map(([f, n]) => ({ value: f, label: `${basename(f)} (${n})` }))];
  const rowFor = (it) => (it.group != null
    ? html`<div class="sl-group"><${Icon} name="folder" /><span class="t-bold">${it.group ? basename(it.group) : L('폴더 모름')}</span>
        <span class="fg-tertiary one-line t-caption">${it.group}</span><span class="spacer"></span><span class="org-count">${L('%@개', String(it.count))}</span></div>`
    : html`<${SessionRow} r=${it} onResume=${() => setResuming(it.a.sessionId)} onArchive=${() => setDeleting(it.a)} />`);
  return html`<div class="area-box tab-fill session-list">
    <div class="sl-toolbar">
      <span class="t-title2 t-bold">${L('세션 목록')}</span>
      <span class="fg-secondary t-callout">${L('%@개 · 조직도 %@개', String(rows.length), String(onChart))}</span>
      <span class="spacer"></span>
      <div class="sl-search">
        <${Icon} name="magnifyingglass" class="fg-tertiary" />
        <input class="textfield-plain" value=${query} placeholder=${L('이름·폴더·브랜치 검색')} onInput=${(e) => setQuery(e.currentTarget.value)}
          onKeyDown=${(e) => { if (e.key === 'Escape' && query) { e.stopPropagation(); setQuery(''); } }} />
        ${query ? html`<${Button} kind="icon" help=${L('지우기')} onClick=${() => setQuery('')}><${Icon} name="xmark.circle.fill" /><//>` : null}
      </div>
    </div>
    <div class="sl-toolbar sl-filters">
      <${Segmented} value=${show} onChange=${setShow} options=${[
        { value: 'all', label: L('전체') }, { value: 'pinned', label: L('조직도에 있음') }, { value: 'unpinned', label: L('조직도에 없음') }]} />
      <${Picker} value=${folder} options=${folderOptions} onChange=${setFolder} width=${220} help=${L('폴더로 거르기')} />
      <${Checkbox} checked=${grouped} onChange=${setGrouped} label=${L('폴더별로 묶기')} />
      <span class="spacer"></span>
      <span class="t-caption fg-secondary">${L('정렬')}</span>
      <${Picker} value=${sort} options=${sortOptions} onChange=${setSort} width=${150} />
    </div>
    <div class="sl-head">
      <span>${L('세션')}</span><span>${L('상태')}</span><span class="num">${L('메시지')}</span><span>${L('모델')}</span>
      <span class="num">${L('출력')}</span><span>${L('마지막 사용')}</span><span>${L('만든 날짜')}</span><span></span>
    </div>
    ${visible.length === 0
      ? html`<div class="sl-empty"><${EmptyState} icon="list.bullet" title=${rows.length ? L('맞는 세션이 없습니다') : L('세션이 없습니다')}
          description=${rows.length ? L('검색어나 거르기를 바꿔 보세요.') : L('Claude Code로 만든 대화가 여기에 모두 나옵니다.')} /></div>`
      : html`<${VirtualList} class="sl-rows" items=${items} sizeOf=${(it) => (it.group != null ? GROUP_H : ROW_H)} render=${rowFor} />`}
    ${resuming ? html`<${LazyView} file="sheets.js" name="ResumeSheet" sheet=${true} sid=${resuming} onClose=${() => setResuming(null)} />` : null}
    ${deleting ? html`<${DeleteSheetLazy} agent=${deleting} onClose=${() => setDeleting(null)} />` : null}
  </div>`;
}

/** One session: name and where it ran, state, numbers, and the toggle / open / menu. */
function SessionRow({ r, onResume, onArchive }) {
  const a = r.a, m = r.m;
  const open = () => call('store.open', a.sessionId);
  const menu = (e) => { e.preventDefault(); e.stopPropagation(); showMenu(cardMenuEntries(a, { resume: onResume, archive: onArchive }), e); };
  const inTeam = r.team != null && !a.solo;
  const toggle = (e) => { e.stopPropagation(); call('store.setPinned', a.sessionId, !r.pinned); };
  const noFile = a.transcriptPath == null;
  const count = noFile ? '—' : m && m.count != null ? String(m.count) : '…';
  const out = a.tokensUnread ? '…' : Fmt.tokens(a.tokens ? a.tokens.output : 0);
  const model = a.model == null && a.tokensUnread ? '…' : a.displayModel;
  const branch = m && m.branch ? m.branch : null;
  return html`<div class=${'sl-row' + (r.pinned ? ' pinned' : '') + (live(a) ? '' : ' ended')} onDblClick=${open} onContextMenu=${menu}>
    <div class="sl-title">
      <${StateDot} state=${a.state} />
      <div class="vstack" style=${{ minWidth: 0, gap: '2px' }}>
        <div class="hstack" style=${{ gap: '6px', minWidth: 0 }}>
          <span class="one-line sl-name" title=${r.title}>${r.title}</span>
          ${inTeam ? html`<${Chip} text=${a.isLead ? L('팀장') : r.team.displayName} tint=${a.isLead ? 'var(--accent)' : 'var(--secondary)'} help=${L('팀 %@', r.team.displayName)} />` : null}
          ${a.isBackgroundJob ? html`<${Icon} name="moon.stars" class="t-caption" color="var(--secondary)" help=${L('CLI 백그라운드 작업 %@', a.jobId || '')} />` : null}
        </div>
        <span class="sl-sub t-caption fg-tertiary" title=${[r.folder, branch].filter(Boolean).join('\n')}>
          <span class="one-line">${r.folder ? basename(r.folder) : '—'}</span>
          ${branch ? html`<span class="sep">·</span><${Icon} name="branch" size=${11} /><span class="one-line">${branch}</span>` : null}
        </span>
      </div>
    </div>
    <span class="t-caption" style=${{ color: Fmt.stateColor(a.state) }}>${Fmt.stateLabel(a.state)}</span>
    <span class="num t-digits">${count}</span>
    <span class="one-line t-caption" style=${{ opacity: a.modelIsGuess ? 0.55 : 1 }}>${model}</span>
    <span class="num t-digits" style=${{ opacity: a.isEstimated && !a.tokensUnread ? 0.55 : 1 }} title=${a.tokensUnread ? L('아직 읽는 중') : a.isEstimated ? L('이전 실행 기준 추정값') : ''}>${out}</span>
    <span class="t-caption fg-secondary" title=${r.last != null ? fmtDate(r.last) : ''}>${r.last != null ? Fmt.ago(r.last) : noFile ? '—' : '…'}</span>
    <span class="t-caption fg-secondary t-digits">${r.created != null ? fmtDate(r.created) : noFile ? '—' : '…'}</span>
    <span class="sl-actions">
      <${Button} kind="raisedCompact" class=${'sl-pin' + (r.pinned ? ' on' : '')} onClick=${toggle}
          help=${inTeam ? L('팀 단위로 올리고 내립니다 (팀장 기준)') : r.pinned ? L('조직도에서 뺍니다. 세션은 그대로이고 이 목록에 남습니다.') : L('조직도에 보이게 합니다')}>
        <${Label} icon=${r.pinned ? 'pin.slash' : 'pin'} title=${r.pinned ? L('조직도에서 내리기') : L('조직도에 올리기')} /><//>
      <${Button} kind="raisedCompact" onClick=${(e) => { e.stopPropagation(); open(); }}>${L('열기')}<//>
      <${Button} kind="icon" help=${L('더 보기')} onClick=${menu}><${Icon} name="ellipsis" /><//>
    </span>
  </div>`;
}

// ── first launch: what the org chart starts with ──────────────────────────────────────────────────────────────────
/** The units the store's finishPinSetup takes: one per team (its lead, else its first member) and per other session. */
function pinUnits(s, meta) {
  const out = [];
  for (const t of (s && s.teams) || []) {
    const ms = (t.members || []).filter((m) => !m.isSubagent);
    if (!ms.length) continue;
    const head = ms.find((m) => m.isLead) || ms[0];
    const last = Math.max(-Infinity, ...ms.map((m) => (meta[m.sessionId] && meta[m.sessionId].lastAt) ?? m.lastActivity ?? -Infinity));
    out.push({ key: head.sessionId, sid: head.sessionId, title: t.displayName, team: t, live: t.liveCount > 0, folder: head.cwd || (meta[head.sessionId] || {}).cwd || null, last });
  }
  for (const a of (s && s.loose) || []) {
    if (a.isSubagent) continue;
    const m = meta[a.sessionId] || null;
    out.push({ key: a.sessionId, sid: a.sessionId, title: titleOf(a, m), team: null, agent: a, live: live(a), folder: a.cwd || (m && m.cwd) || null, last: (m && m.lastAt) ?? a.lastActivity ?? -Infinity });
  }
  return out.sort((x, y) => (y.live ? 1 : 0) - (x.live ? 1 : 0) || y.last - x.last);
}

/** Shown once, after the board's first load on the first launch of the pinning version (after the language picker).
 *  props: s, onClose. */
export function PinSetupSheet({ s, onClose }) {
  const meta = useListMeta(true, s && s.listMetaVersion, 0);
  const units = useMemo(() => pinUnits(s, meta), [s, meta]);
  const [checked, setChecked] = useState(null);
  const [query, setQuery] = useState('');
  useEffect(() => { if (checked == null && s && s.firstScanDone) setChecked(new Set(units.filter((u) => u.live).map((u) => u.sid))); }, [units]);
  const sel = checked || new Set();
  const q = query.trim().toLowerCase();
  const shown = q ? units.filter((u) => [u.title, u.folder].filter(Boolean).join('\n').toLowerCase().includes(q)) : units;
  const setAll = (on) => { const n = new Set(sel); for (const u of shown) { if (on) n.add(u.sid); else n.delete(u.sid); } setChecked(n); };
  const flip = (sid, on) => { const n = new Set(sel); if (on) n.add(sid); else n.delete(sid); setChecked(n); };
  const done = useRef(false);
  const finish = (sids) => { if (done.current) return; done.current = true; call('store.finishPinSetup', sids).catch(() => { }); onClose(); };
  const later = () => finish(null);
  return html`<${Sheet} width=${680} onClose=${later} class="pin-setup">
    <div class="vstack" style=${{ gap: '12px' }}>
      <div class="hstack" style=${{ gap: '10px' }}>
        <${Icon} name="pin" size=${20} color="var(--accent)" />
        <span class="t-title3 t-bold">${L('조직도에 올릴 세션을 고르세요')}</span>
      </div>
      <div class="t-callout fg-secondary" style=${{ whiteSpace: 'pre-wrap' }}>${L('이제 조직도에는 고른 세션만 보입니다. 모든 세션은 \'세션 목록\' 탭에 그대로 있고, 언제든 올리거나 내릴 수 있습니다. 앞으로 새로 만드는 세션은 자동으로 올라갑니다.')}</div>
      <div class="hstack" style=${{ gap: '8px' }}>
        <div class="sl-search" style=${{ flex: '1 1 auto' }}>
          <${Icon} name="magnifyingglass" class="fg-tertiary" />
          <input class="textfield-plain" value=${query} placeholder=${L('이름·폴더 검색')} onInput=${(e) => setQuery(e.currentTarget.value)} />
        </div>
        <${Button} kind="raisedCompact" onClick=${() => setAll(true)}>${L('전체 선택')}<//>
        <${Button} kind="raisedCompact" onClick=${() => setAll(false)}>${L('선택 해제')}<//>
      </div>
      <${VirtualList} class="pin-list" items=${shown} sizeOf=${() => 44} render=${(u) => html`<label class="pin-row">
          <input type="checkbox" checked=${sel.has(u.sid)} onChange=${(e) => flip(u.sid, e.currentTarget.checked)} />
          <${StateDot} state=${u.live ? (u.team ? 'idle' : u.agent.state) : 'ended'} />
          <span class="vstack" style=${{ minWidth: 0, gap: '1px', flex: '1 1 auto' }}>
            <span class="hstack" style=${{ gap: '6px', minWidth: 0 }}>
              <span class="one-line t-callout t-bold">${u.title}</span>
              ${u.team ? html`<${Chip} text=${L('팀 %@명', String(u.team.members.filter((m) => !m.isSubagent).length))} tint="var(--accent)" />` : null}
            </span>
            <span class="one-line t-caption fg-tertiary">${u.folder ? basename(u.folder) : '—'}</span>
          </span>
          <span class="t-caption fg-secondary">${u.live ? L('실행 중') : Number.isFinite(u.last) ? Fmt.ago(u.last) : ''}</span>
        </label>`} />
      <div class="hstack" style=${{ gap: '8px' }}>
        <span class="t-caption fg-secondary">${L('%@개 중 %@개 선택', String(units.length), String(sel.size))}</span>
        <span class="spacer"></span>
        <${Button} kind="raised" onClick=${later} help=${L('실행 중인 세션만 올립니다. 나머지는 세션 목록에서 언제든 올릴 수 있습니다.')}>${L('나중에')}<//>
        <${Button} kind="raisedProminent" disabled=${checked == null} onClick=${() => finish([...sel])}>${L('조직도에 올리기 (%@)', String(sel.size))}<//>
      </div>
    </div>
  <//>`;
}
