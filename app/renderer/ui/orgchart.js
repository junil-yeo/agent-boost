// Home tab, ported from OrgChartView.swift: every team as an org chart (lead on top, workers beneath as name cards), the
// individual sessions, sessions still starting (LaunchCard) and the rocket loading screen on first load. Also
// Format.swift's RemoteChip, exported for the other views. The per-agent dialogs (rename, archive, quit) come from
// ui/agentactions.js.
import { html, useState, useEffect, useRef, useLayoutEffect, call, L, keys } from '../lib.js';
import { Icon, Label, Button, Chip, StateDot, Checkbox, EmptyState, ProgressSpinner, LazyMenu, Sheet, showMenu } from './widgets.js';
import { Fmt, overlayName } from '../fmt.js';
import { RocketLaunch } from './rocket.js';

const basename = (p) => { const s = String(p).replace(/\/+$/, ''); const i = s.lastIndexOf('/'); return i >= 0 ? s.slice(i + 1) : s; };
const selSet = (s) => new Set((s && s.selection) || []);

// ── store checks the views need synchronously (BoardStore.canQuit / canResume) ──────────────────────────────────────
/** BoardStore.canQuit: a live session with a process to stop. */
export const canQuit = (a) => a.state !== 'ended' && a.pid != null;
/** BoardStore.canResume: an ended session with a conversation file (the snapshot carries its transcriptPath). */
export const canResume = (a) => a.state === 'ended' && a.transcriptPath != null;

// ── modules other agents write (dynamic import, neutral placeholder until they load) ───────────────────────────────
const modCache = {};
function loadModule(file) {
  if (!modCache[file]) modCache[file] = import(`./${file}`).then((m) => ({ m }), (e) => { console.error(`ui/${file}`, e.message); delete modCache[file]; return { e }; });
  return modCache[file];
}
/**
 * Renders export `name` of ui/<file> with the other props, loaded on first use. While the module is missing or fails
 * to load: `sheet` → a sheet with a spinner and a close button; otherwise a spinner in an area box.
 */
export function LazyView({ file, name, sheet, ...props }) {
  const [C, setC] = useState(() => null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    const tryLoad = () => loadModule(file).then(({ m }) => {
      if (!live) return;
      if (m && typeof m[name] === 'function') { setC(() => m[name]); setFailed(false); } else setFailed(true);
    });
    tryLoad();
    const id = setInterval(() => { if (!C) tryLoad(); }, 3000);   // modules still being written appear later
    return () => { live = false; clearInterval(id); };
  }, [file, name, C]);
  if (C) return html`<${C} ...${props} />`;
  if (sheet) {
    return html`<${Sheet} width=${360} onClose=${props.onClose}>
      <div class="vstack" style=${{ alignItems: 'center', gap: '14px' }}>
        <${ProgressSpinner} large=${true} />
        <${Button} kind="raised" onClick=${props.onClose}>${L('닫기')}<//>
      </div>
    <//>`;
  }
  return html`<div class="area-box lazy-placeholder" data-failed=${failed}><${ProgressSpinner} large=${true} /></div>`;
}

// ── OrgChartView ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Home: every team as an org chart. props: s (store state, null while loading). */
export function OrgChartView({ s }) {
  // the launch screen plays once per app start (location.hash 'norocket' skips it, as the Swift snapshots do)
  const [launched, setLaunched] = useState(() => location.hash.includes('norocket'));
  const [fading, setFading] = useState(false);
  const gen = useRef(s ? s.rebootGen : null);
  useEffect(() => {   // the refresh button: launch again
    const g = s ? s.rebootGen : null;
    if (gen.current != null && g != null && g !== gen.current) { setLaunched(false); setFading(false); }
    gen.current = g;
  }, [s && s.rebootGen]);
  if (!launched || !s) {
    const loaded = !!(s && s.firstScanDone && !s.rebooting);
    return html`<div class="area-box tab-fill"><${RocketLaunch} loaded=${loaded} onDone=${() => { setFading(true); setLaunched(true); }} /></div>`;
  }
  return html`<div class=${'org-scroll' + (fading ? ' fade-in' : '')}><${Chart} s=${s} /></div>`;
}

function Chart({ s }) {
  const teams = s.teams || [], loose = s.loose || [], launches = s.launches || [], empty = s.emptyTeams || [];
  const sel = selSet(s);
  const cols = Math.max(1, Math.min(teams.length, 3));
  return html`<div class="vstack" style=${{ gap: 'var(--gap)' }}>
    ${teams.length === 0 && loose.length === 0 ? html`<div class="area-box" style=${{ minHeight: '420px', display: 'flex' }}>
      <${EmptyState} icon="person.3" title=${L('에이전트가 없습니다')} description=${keys(L("오른쪽 위 '새 세션'(⌘N)으로 시작하거나, tmux에서 Claude 팀을 띄우면 여기에 나타납니다."))} />
    </div>` : null}
    ${launches.length ? html`<div class="area-box vstack" style=${{ gap: '10px', padding: '14px' }}>
      <span class="t-headline">${L('시작 중인 세션')}</span>
      ${launches.map((l) => html`<${LaunchCard} key=${l.id} launch=${l} />`)}
    </div>` : null}
    ${empty.length ? html`<div class="area-box hstack" style=${{ padding: '10px', gap: '8px' }}>
      <${Icon} name="trash.slash" />
      <span class="t-callout">${L('대화 기록이 없는 종료된 팀 %@개 — 보여줄 것도, 다시 시작할 것도 없습니다.', String(empty.length))}</span>
      <span class="spacer"></span>
      <${Button} kind="raisedCompact" onClick=${() => call('store.pruneEmptyTeams')}>${L('정리 (휴지통)')}<//>
    </div>` : null}
    ${teams.length ? html`<div class="team-grid" style=${{ gridTemplateColumns: `repeat(${cols}, minmax(380px, 1fr))` }}>
      ${teams.map((t) => html`<${TeamCard} key=${t.name} team=${t} s=${s} sel=${sel} />`)}
    </div>` : null}
    ${loose.length ? html`<${LooseGroup} s=${s} loose=${loose} sel=${sel} />` : null}
  </div>`;
}

function LooseGroup({ s, loose, sel }) {
  const live = loose.filter((a) => a.state !== 'ended').length;
  return html`<div class="area-box vstack" style=${{ gap: '10px', padding: '14px' }}>
    <div class="hstack" style=${{ gap: '10px', alignItems: 'baseline' }}>
      <span class="hstack" style=${{ gap: '8px', alignSelf: 'center' }}>
        <${Icon} name="person" size=${14} color=${live > 0 ? 'var(--sys-green)' : 'var(--secondary)'} />
        <span style=${{ fontSize: '15px', fontWeight: 600 }}>${L('개별 세션')}</span>
      </span>
      <span class="org-count">${L('실행 %@', String(live))}</span>
      <span class="org-count">${L('종료 %@', String(loose.length - live))}</span>
    </div>
    <${FillGrid} items=${loose} spacing=${12} render=${(a) => html`<${NameCard} key=${a.sessionId} agent=${a} s=${s} selected=${sel.has(a.sessionId)} />`} />
  </div>`;
}

/** One session the board started that has not registered with Claude yet: the trust question, first-run setup, stuck. */
export function LaunchCard({ launch }) {
  const id = launch.id || launch.tmuxName;
  let status;
  switch (launch.phase) {
    case 'needsTrust':
      status = html`<span class="t-caption fg-orange">${L('폴더 신뢰 확인 필요')}</span>
        <${Button} kind="raisedProminent" onClick=${() => call('store.trustFolder', id)}>${L('이 폴더 신뢰하고 시작')}<//>`;
      break;
    case 'needsSetup':
      status = html`<span class="t-caption fg-orange">${L('Claude Code 첫 설정 필요')}</span>
        <${Button} kind="raisedProminent" onClick=${() => call('store.openLaunchTerminal', id)}>${L('터미널에서 설정 마치기')}<//>`;
      break;
    case 'stuck': status = html`<span class="t-caption fg-red">${L('응답 없음')}</span>`; break;
    default: status = html`<span class="t-caption fg-secondary">${L('시작 중…')}</span>`;
  }
  return html`<div class="launch-card vstack" style=${{ gap: '6px' }}>
    <div class="hstack" style=${{ gap: '8px' }}>
      <${ProgressSpinner} style=${{ opacity: launch.phase === 'starting' ? 1 : 0 }} />
      <span class="t-subheadline t-bold" style=${{ whiteSpace: 'nowrap' }}>${launch.name}</span>
      <${MiddleText} text=${launch.cwd || ''} class="t-caption fg-secondary" />
      <span class="spacer"></span>
      ${status}
      <${Button} kind="raised" onClick=${() => call('store.cancelLaunch', id)}>${L('취소')}<//>
    </div>
    ${launch.phase === 'needsTrust' ? html`<span class="t-caption fg-secondary">${L('Claude Code가 이 폴더의 파일을 읽고, 수정하고, 실행할 수 있게 됩니다. 직접 만든 폴더이거나 믿을 수 있는 경우에만 신뢰하세요.')}</span>` : null}
    ${launch.phase === 'needsSetup' ? html`<span class="t-caption fg-secondary">${L('이 Mac에서 Claude Code를 처음 실행했습니다. 글자 스타일 선택과 로그인은 CLI가 직접 묻는 단계라, 터미널에서 한 번 마치면 그 뒤로는 이 앱에서 바로 시작됩니다.')}</span>` : null}
    ${launch.phase === 'stuck' && launch.screenTail ? html`<pre class="t-mono t-caption2 fg-secondary selectable" style=${{ margin: 0, whiteSpace: 'pre-wrap' }}>${launch.screenTail}</pre>` : null}
  </div>`;
}

/** One line truncated in the middle (.truncationMode(.middle)): the text is split in two halves that shrink together,
 *  the head ending in "…" and the tail losing its start, so both ends stay readable. */
export function MiddleText({ text, class: cls, style }) {
  const t = Array.from(String(text));
  const half = Math.ceil(t.length / 2);
  return html`<span class=${'middle-text ' + (cls || '')} style=${style} title=${t.join('')}><span class="mt-head">${t.slice(0, half).join('')}</span><span class="mt-tail"><span>${t.slice(half).join('')}</span></span></span>`;
}

/** One team as a compact column: header, lead, then workers stacked under a guide line. */
function TeamCard({ team, s, sel }) {
  const lead = team.members.find((m) => m.sessionId === team.lead) || null;
  const workers = team.members.filter((m) => !m.isLead);
  const ids = team.members.map((m) => m.sessionId);
  const all = ids.every((x) => sel.has(x));
  const toggleAll = () => {
    const next = new Set(sel);
    ids.forEach((x) => (all ? next.delete(x) : next.add(x)));
    call('store.setSelection', [...next]);
  };
  // last activity of any member (what the CLI's session list shows), not when the team was made
  const acts = team.members.map((m) => m.lastActivity).filter((x) => x != null);
  const last = acts.length ? Math.max(...acts) : team.createdAt;
  return html`<div class="area-box vstack" style=${{ gap: '10px', padding: '14px' }}>
    <div class="hstack" style=${{ gap: '8px' }}>
      <${Icon} name="person.3" size=${14} color=${team.liveCount > 0 ? 'var(--sys-green)' : 'var(--secondary)'} />
      <span class="one-line" style=${{ fontSize: '15px', fontWeight: 600 }}>${team.displayName}</span>
      <span class="spacer"></span>
      <${Button} kind="raisedCompact" help=${L('이 팀의 팀장·팀원을 한 번에 선택')} onClick=${toggleAll}>
        <${Label} icon=${all ? 'checkmark.square.fill' : 'checkmark.square'} title=${all ? L('팀 선택 해제') : L('팀 전체 선택')} />
      <//>
      <${Button} kind="raisedCompact" onClick=${() => { const a = lead || team.members[0]; if (a) call('store.open', a.sessionId); }}>${L('열기')}<//>
    </div>
    <div class="hstack" style=${{ gap: '6px' }}>
      <${Chip} text=${L('%@/%@명 활동', String(team.liveCount), String(team.members.length))} tint=${team.liveCount > 0 ? 'var(--sys-green)' : 'var(--secondary)'} />
      <${Chip} text=${L('토큰 %@', Fmt.tokens(team.tokens ? team.tokens.total ?? sumTokens(team.tokens) : 0))} />
      ${last != null ? html`<span class="t-caption fg-secondary" title=${L('마지막 활동 %@', Fmt.time(last))}>${Fmt.ago(last)}</span>` : null}
    </div>
    ${lead ? html`<${NameCard} agent=${lead} s=${s} badge=${L('팀장')} selected=${sel.has(lead.sessionId)} />`
      : html`<span class="t-callout fg-orange"><${Label} icon="person.crop.circle.badge.exclamationmark" title=${L('팀장 없음 — 삭제되었거나 종료됨. 팀원만 남아 있습니다.')} /></span>`}
    ${workers.length ? html`<${FillGrid} items=${workers} spacing=${10} render=${(a) => html`<${NameCard} key=${a.sessionId} agent=${a} s=${s} selected=${sel.has(a.sessionId)} />`} />`
      : lead ? html`<span class="t-callout fg-secondary" style=${{ paddingLeft: '4px' }}>${L('팀원 없음')}</span>` : null}
  </div>`;
}
/** TokenUsage.total when the snapshot carries only its parts. */
// TokenUsage.total (Models.swift): input + cacheWrite + cacheRead + output. The snapshot carries the four parts only.
function sumTokens(t) { return (t.input || 0) + (t.cacheWrite || 0) + (t.cacheRead || 0) + (t.output || 0); }
const tokenTotal = (t) => (t ? (t.total ?? sumTokens(t)) : 0);

/** Cards in as many columns as fit (min 300 px, up to 4, never more than there are cards); the cards share the width. */
export function FillGrid({ items, spacing, render }) {
  const ref = useRef(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return undefined;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el); setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const top = Math.max(1, Math.min(items.length, 4));
  // ViewThatFits: the most columns (top … 1) whose minimum widths fit
  let n = 1;
  for (let k = top; k >= 1; k--) { if (k * 300 + (k - 1) * spacing <= w) { n = k; break; } }
  return html`<div ref=${ref} class="fill-grid" style=${{ gap: `${spacing}px`, gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>${items.map(render)}</div>`;
}

// folders of sessions without a cwd field, read once per session (BoardStore.workingDirectory)
const cwdCache = {};
function useWorkingDirectory(a) {
  const [v, setV] = useState(a.cwd ?? cwdCache[a.sessionId] ?? null);
  useEffect(() => {
    if (a.cwd != null) { setV(a.cwd); return; }
    if (a.sessionId in cwdCache) { setV(cwdCache[a.sessionId]); return; }
    call('store.workingDirectory', a.sessionId).then((d) => { cwdCache[a.sessionId] = d ?? null; setV(d ?? null); }).catch(() => { });
  }, [a.sessionId, a.cwd]);
  return v;
}

/** One session's card. props: agent, s (state), badge (팀장), selected. */
export function NameCard({ agent, s, badge, selected }) {
  const [resuming, setResuming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const cwd = useWorkingDirectory(agent);
  const sid = agent.sessionId;
  const ended = agent.state === 'ended';
  const toggleSel = (on) => {
    const next = selSet(s);
    if (on) next.add(sid); else next.delete(sid);
    call('store.setSelection', [...next]);
  };
  const menu = (e) => {
    e.preventDefault();
    showMenu([
      ...(canResume(agent) ? [{ item: L('다시 시작…'), action: () => setResuming(true) }] : []),
      { item: L('이름 변경…'), action: () => renameAgent(agent) },
      ...(canQuit(agent) ? [{ item: L('종료…'), action: () => quitAgent(agent) }] : []),
      ...(agent.tmuxSession != null && !ended ? [{ item: L('터미널에서 열기'), action: () => call('store.openTerminal', sid) }] : []),
      '-',
      { item: ended ? L('보관…') : L('종료하고 보관…'), action: () => setDeleting(true) },
    ], e);
  };
  const stop = (f) => (e) => { e.stopPropagation(); f(); };
  const stateColor = Fmt.stateColor(agent.state);
  return html`<div class=${'name-card card-surface' + (selected ? ' selected' : '')} style=${{ opacity: ended ? 0.75 : 1 }}
      onClick=${() => call('store.open', sid)} onContextMenu=${menu}>
    <div class="hstack" style=${{ gap: '8px' }}>
      <span onClick=${(e) => e.stopPropagation()}><${Checkbox} checked=${selected} onChange=${toggleSel} help=${L('선택')} /></span>
      <${StateDot} state=${agent.state} />
      <span class="one-line" style=${{ fontSize: '14px', fontWeight: 600 }}>${agent.name}</span>
      ${badge ? html`<${Chip} text=${badge} tint="var(--accent)" />` : null}
      ${agent.origin === 'board' ? html`<${Icon} name="macwindow.badge.plus" class="t-caption" color="var(--sys-teal)" help=${L('이 앱에서 시작한 세션')} />` : null}
      ${agent.overlay != null ? html`<${Icon} name="list.bullet.rectangle" class="t-caption" color="var(--sys-orange)" help=${L('CLI가 %@ 화면입니다 — 입력 불가', overlayName(agent.overlay))} />` : null}
      ${agent.isBackgroundJob ? html`<${Icon} name="moon.stars" class="t-caption" color="var(--secondary)" help=${L('CLI 백그라운드 작업 %@', agent.jobId || '')} />` : null}
      <span class="spacer"></span>
      <span class="card-actions hstack" style=${{ gap: '6px' }}>
        ${canResume(agent) ? html`<${Button} kind="icon" help=${L('다시 시작')} onClick=${stop(() => setResuming(true))}><${Icon} name="power" /><//>` : null}
        ${canQuit(agent) ? html`<${Button} kind="icon" help=${L('종료 (/exit)')} onClick=${stop(() => quitAgent(agent))}><${Icon} name="power" /><//>` : null}
        <${Button} kind="icon" help=${L('이름 변경')} onClick=${stop(() => renameAgent(agent))}><${Icon} name="pencil" /><//>
        <${Button} kind="icon" help=${L('보관')} onClick=${stop(() => setDeleting(true))}><${Icon} name="archivebox" /><//>
      </span>
      <span class="state-label" style=${{ '--c': stateColor, opacity: agent.stateUnconfirmed ? 0.7 : 1 }}
          title=${agent.stateUnconfirmed ? L('%@ — 상태 확인 중', Fmt.stateLabel(agent.state)) : ''}>${Fmt.stateLabel(agent.state)}</span>
    </div>
    ${agent.pendingName ? html`<span class="t-caption2 fg-orange">${L("→ '%@'(으)로 변경 대기 중", agent.pendingName)}</span>` : null}
    <span class="hstack t-caption fg-tertiary" style=${{ gap: '4px' }}>
      <${Icon} name="folder" /><span class="one-line">${basename(cwd ?? '—')}</span>
    </span>
    <div class="hstack" style=${{ gap: '6px' }}>
      <${Chip} text=${agent.displayModel} neutral=${true} style=${{ opacity: agent.modelIsGuess ? 0.55 : 1 }} help=${agent.modelIsGuess ? L('이전 실행 기준 추정값 — 실행 인자에서 읽은 모델입니다') : ''} />
      ${agent.effort ? html`<${Chip} text=${agent.effort} neutral=${true} help=${`effort ${agent.effort}`} />` : null}
      <span onClick=${(e) => e.stopPropagation()}><${RemoteChip} agent=${agent} s=${s} /></span>
    </div>
    <div class="hstack">
      <span class="t-digits" style=${{ fontSize: '12px', fontWeight: 500, color: 'var(--text-dim)', opacity: agent.isEstimated ? 0.55 : 1 }} title=${agent.isEstimated ? L('이전 실행 기준 추정값') : ''}>
        ${L('출력 %@ · 합 %@', Fmt.tokens(agent.tokens ? agent.tokens.output : 0), Fmt.tokens(tokenTotal(agent.tokens)))}</span>
      <span class="spacer"></span>
      <span class="t-caption2 fg-tertiary">${Fmt.ago(agent.lastActivity)}</span>
    </div>
    ${resuming ? html`<span onClick=${(e) => e.stopPropagation()}><${LazyView} file="sheets.js" name="ResumeSheet" sheet=${true} sid=${sid} onClose=${() => setResuming(false)} /></span>` : null}
    ${deleting ? html`<span onClick=${(e) => e.stopPropagation()}><${DeleteSheetLazy} agent=${agent} onClose=${() => setDeleting(false)} /></span>` : null}
  </div>`;
}

/** Remote Control chip (Format.swift): on/off menu; disabled while switching or for a session without a pane. */
export function RemoteChip({ agent, s }) {
  if (agent.remoteControl == null || agent.state === 'ended') return null;
  const on = agent.remoteControl;
  const pending = ((s && s.rcPending) || []).includes(agent.sessionId);
  const tint = on ? 'var(--rc-on)' : 'var(--secondary)';
  const help = agent.tmuxPane == null
    ? (on ? L('Remote Control 켜짐 — 데스크톱 앱 세션은 여기서 바꿀 수 없습니다') : L('Remote Control 꺼짐 — 데스크톱 앱 세션은 여기서 바꿀 수 없습니다'))
    : on ? L('Remote Control 켜짐: 휴대폰·claude.ai/code에서 보입니다. 누르면 끕니다.') : L('Remote Control 꺼짐. 누르면 켭니다.');
  return html`<${LazyMenu} disabled=${pending || agent.tmuxPane == null} help=${help} entries=${() => [
      { header: L('Remote Control (휴대폰·claude.ai/code에서 보기)') },
      { item: (on ? '✓ ' : '   ') + L('켜기'), enabled: !on, action: () => call('store.toggleRemote', agent.sessionId) },
      { item: (!on ? '✓ ' : '   ') + L('끄기'), enabled: on, action: () => call('store.toggleRemote', agent.sessionId) },
    ]}>
    <span class=${'chip rc' + (on ? ' on' : '')} style=${{ '--tint': tint, fontSize: '12px', fontWeight: 500 }}>
      <${Icon} name=${on ? 'antenna.radiowaves.left.and.right' : 'antenna.radiowaves.left.and.right.slash'} />
      ${pending ? L('RC 전환 중…') : on ? L('RC 켜짐') : L('RC 꺼짐')}
    </span>
  <//>`;
}

// ── AgentActions.swift (ui/agentactions.js, written alongside the team detail view) ──────────────────────────────────
/** Runs export `name` of ui/agentactions.js with the agent (renameAgent / quitDialog). */
function agentAction(name, agent) {
  loadModule('agentactions.js').then(({ m }) => { if (m && m[name]) m[name](agent); });
}
const renameAgent = (a) => agentAction('renameAgent', a);
const quitAgent = (a) => agentAction('quitDialog', a);
/** The archive sheet (agentactions.js DeleteSheet) with its message. */
function DeleteSheetLazy({ agent, onClose }) {
  const [msg, setMsg] = useState(null);
  useEffect(() => { loadModule('agentactions.js').then(({ m }) => setMsg(m && m.deleteMessage ? m.deleteMessage(agent) : '')); }, [agent.sessionId, agent.state]);
  return html`<${LazyView} file="agentactions.js" name="DeleteSheet" sheet=${true} agent=${agent} message=${msg || ''} onClose=${onClose} />`;
}
