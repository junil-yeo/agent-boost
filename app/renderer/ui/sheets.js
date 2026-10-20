// Port of CreateViews.swift: the new-session sheet (this computer / cloud on claude.ai/code), the teammate editor, the
// add-teammate and resume sheets, and the small HaikuLeadWarning / BypassToggle pieces.
//
// Exports: TeammateEditor({specs, onChange}), newTeammateSpec(name), NewSessionSheet({onClose}),
// AddTeammateSheet({sid, onClose}), ResumeSheet({sid, onClose}), HaikuLeadWarning(), BypassToggle({on, onChange}).
// A sheet is shown while rendered (SwiftUI .sheet): ${creating && html`<${NewSessionSheet} onClose=${…} />`}.
// Store calls go through board.js's act() so the team-detail dev fixture can stand in for the main process.
import { html, useState, useEffect, useRef, L, isMac } from '../lib.js';
import { Icon, Label, Button, Picker, Segmented, Switch, FormRow, Sheet } from './widgets.js';
import { ModelChoice, EffortChoice, teammateNameIsValid } from '../fmt.js';
import { act, useBoard, agentIn, useAppStorage } from './board.js';
import { MiddleText } from './orgchart.js';

const CSS = `
.ab-sheet-v { display: flex; flex-direction: column; align-items: stretch; }
.ab-sheet-v .textfield { width: 100%; box-sizing: border-box; }
.ab-sheet-v textarea.textfield { font-family: inherit; }
.tm-row { display: flex; align-items: center; gap: 6px; }
.tm-row .textfield.invalid { border-color: var(--sys-red); }
.repo-list { height: 200px; overflow-y: auto; background: var(--panel); border-radius: 8px; }
.repo-row { display: flex; align-items: center; gap: 8px; width: 100%; padding: 5px 8px; border: 0; background: transparent; color: var(--fg); text-align: left; cursor: default; font-size: 13px; }
.repo-row:hover { background: color-mix(in srgb, var(--ink) 5%, transparent); }
.repo-chip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border-radius: 999px; background: color-mix(in srgb, var(--accent) 15%, transparent); font-size: var(--fs-caption); }
.repo-chip button { border: 0; background: transparent; color: inherit; padding: 0; display: inline-flex; cursor: default; }
.team-box { padding: 12px; background: var(--panel); border-radius: 8px; display: flex; flex-direction: column; gap: 8px; animation: ab-fade .15s ease-out; }
.ab-warn { display: flex; gap: 6px; align-items: flex-start; font-size: var(--fs-caption); }
`;
function ensureCSS() {
  if (document.querySelector('style[data-ab-sheets]')) return;
  const s = document.createElement('style'); s.setAttribute('data-ab-sheets', ''); s.textContent = CSS; document.head.appendChild(s);
}

const trimWS = (s) => String(s || '').replace(/^[ \t]+|[ \t]+$/g, '');
const modelOptions = () => ModelChoice.map((m) => ({ value: m.raw, label: m.label }));
const effortOptions = () => EffortChoice.map((e) => ({ value: e, label: e }));
let specSeq = 0;
/** TeammateSpec(name:) with Swift's defaults: model .sonnet, effort .low. */
export function newTeammateSpec(name = '') { return { id: `tm${++specSeq}`, name, role: '', model: 'claude-sonnet-5-5', effort: 'low' }; }
const specJSON = (t) => ({ name: t.name, role: t.role, model: t.model, effort: t.effort });

/** TextField(axis: .vertical).lineLimit(lo...hi): a text area that grows with its lines. */
function GrowingField({ value, onInput, placeholder, lo = 2, hi = 5 }) {
  const rows = Math.min(hi, Math.max(lo, String(value || '').split('\n').length));
  return html`<textarea class="textfield" rows=${rows} value=${value} placeholder=${placeholder} onInput=${(e) => onInput(e.currentTarget.value)}></textarea>`;
}
/** .keyboardShortcut(.defaultAction): Enter outside a multi-line field runs the sheet's main button. */
function defaultAction(run, enabled) {
  return (e) => {
    if (e.key !== 'Enter' || e.isComposing || e.shiftKey || !enabled) return;
    if (e.target && e.target.tagName === 'TEXTAREA') return;
    if (e.target && e.target.tagName === 'BUTTON') return;
    e.preventDefault(); run();
  };
}

/** Rows for editing a list of teammates (name, role, model, effort). props: specs, onChange(specs). */
export function TeammateEditor({ specs, onChange }) {
  ensureCSS();
  const set = (id, patch) => onChange(specs.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  const bad = specs.some((t) => t.name && !teammateNameIsValid(t.name));
  return html`<div class="vstack" style=${{ alignItems: 'flex-start', gap: '6px' }}>
    ${specs.map((t) => html`<div class="tm-row" key=${t.id}>
      <input class=${'textfield' + (t.name && !teammateNameIsValid(t.name) ? ' invalid' : '')} style=${{ width: '120px' }} value=${t.name}
        placeholder=${L('이름 (영문)')} onInput=${(e) => set(t.id, { name: e.currentTarget.value })} />
      <input class="textfield" style=${{ minWidth: '160px', flex: '1 1 auto' }} value=${t.role} placeholder=${L('역할 (선택)')}
        onInput=${(e) => set(t.id, { role: e.currentTarget.value })} />
      <${Picker} width=${120} value=${t.model} options=${modelOptions()} onChange=${(v) => set(t.id, { model: v })} />
      <${Picker} width=${90} value=${t.effort} options=${effortOptions()} onChange=${(v) => set(t.id, { effort: v })} />
      <${Button} kind="icon" onClick=${() => onChange(specs.filter((x) => x.id !== t.id))}><${Icon} name="minus.circle" /><//>
    </div>`)}
    <${Button} kind="raisedCompact" onClick=${() => onChange(specs.concat([newTeammateSpec(`teammate${specs.length + 1}`)]))}>
      <${Label} icon="plus.circle" title=${L('팀원 추가')} />
    <//>
    <span class="t-caption2" style=${{ color: bad ? 'var(--sys-red)' : 'var(--secondary)' }}>${L('팀원 이름은 팀 주소(name@team)가 되므로 영문·숫자·_·- 만 됩니다 (Claude 제한). 역할은 자유롭게 한글로 적어도 됩니다.')}</span>
  </div>`;
}

/** Small models do not follow Claude Code's team protocol reliably (tested). */
export function HaikuLeadWarning() {
  ensureCSS();
  return html`<div class="ab-warn" style=${{ color: 'var(--sys-orange)' }}>
    <${Icon} name="exclamationmark.triangle" /><span>${L('Haiku 팀장은 팀원 생성·종료 규약을 자주 틀립니다 (테스트에서 실패). 팀장은 Sonnet 이상을 권장합니다.')}</span>
  </div>`;
}

/** "Ask nothing" start option: `--dangerously-skip-permissions` (every tool call runs without a permission question).
 *  props: on, onChange(bool). */
export function BypassToggle({ on, onChange }) {
  return html`<div class="vstack" style=${{ gap: '2px', width: '100%' }}>
    <${Switch} checked=${on} onChange=${onChange} label=${L('권한 확인 없이 실행 (--dangerously-skip-permissions)')} style=${{ justifyContent: 'space-between', width: '100%' }} />
    <span class="t-caption" style=${{ color: on ? 'var(--sys-orange)' : 'var(--secondary)' }}>${on ? L('파일 수정·셸 명령을 묻지 않고 모두 실행합니다. 믿을 수 있는 폴더에서만 쓰세요.') : L('Claude Code의 권한 설정대로 필요할 때 묻습니다.')}</span>
  </div>`;
}
/** new.bypass is also read by the store (resumed sessions): keep its copy in step. */
function useBypass() {
  const [bypass, setBypass] = useAppStorage('new.bypass', true);
  return [bypass, (v) => { setBypass(v); act('store.setPref', 'new.bypass', v); }];
}

// ── NewSessionSheet ────────────────────────────────────────────────────────────────────────────────────────────────
/** props: onClose. */
export function NewSessionSheet({ onClose }) {
  ensureCSS();
  const [cloud, setCloud] = useAppStorage('new.cloud', false);
  // the sheet's @State: shared by both forms (switching keeps them), fresh when the sheet opens again
  const [name, setName] = useState('');
  const [withTeam, setWithTeam] = useState(false);
  const [team, setTeam] = useState(() => [newTeammateSpec('teammate1')]);
  const [task, setTask] = useState('');
  const [repos, setRepos] = useState([]);
  const [repoNote, setRepoNote] = useState(null);       // loading / why the list is empty
  const [picked, setPicked] = useState([]);
  const [repoQuery, setRepoQuery] = useState('');
  const st = { name, setName, withTeam, setWithTeam, team, setTeam, task, setTask, repos, setRepos, repoNote, setRepoNote, picked, setPicked, repoQuery, setRepoQuery };
  return html`<${Sheet} width=${720} onClose=${onClose}>
    <div class="ab-sheet-v" style=${{ gap: '14px' }}>
      <div class="hstack">
        <span class="t-title2 t-bold">${L('새 세션')}</span>
        <span class="spacer"></span>
        <${Segmented} value=${!!cloud} onChange=${setCloud}
          options=${[{ value: false, label: isMac ? L('이 Mac') : L('이 컴퓨터'), icon: 'desktopcomputer' }, { value: true, label: L('클라우드 (웹)'), icon: 'cloud' }]} />
      </div>
      ${cloud ? html`<${CloudForm} st=${st} onClose=${onClose} />` : html`<${LocalForm} st=${st} onClose=${onClose} />`}
    </div>
  <//>`;
}

/** Query value as URLComponents writes it: percent-encoded, with "+" and "&" inside a value encoded too (they must not
 *  read as a space or a new parameter); "/", ",", ":" and "@" stay as they are. */
function queryValue(v) { return encodeURIComponent(v).replace(/%2F/g, '/').replace(/%2C/g, ',').replace(/%3A/g, ':').replace(/%40/g, '@'); }
/** The claude.ai/code address with the first task and repositories prefilled. */
export function cloudURL(task, repos) {
  const items = [['repositories', repos.join(',')]];
  const t = String(task || '').trim();
  if (t) items.unshift(['prompt', t]);
  return 'https://claude.ai/code?' + items.map(([k, v]) => `${k}=${queryValue(v)}`).join('&');
}

/** A cloud session on claude.ai/code: GitHub repositories cloned there, the first task prefilled. It runs and is
 *  watched on the web (or the mobile app): no transcript comes to this computer, so it does not appear on the board. */
function CloudForm({ st, onClose }) {
  const { repos, setRepos, repoNote, setRepoNote, picked, setPicked, repoQuery, setRepoQuery, task, setTask } = st;
  useEffect(() => { if (!repos.length) loadRepos(); }, []);
  /** The user's repositories through the gh CLI (own, collaborator and organisation ones), most recently pushed first. */
  async function loadRepos() {
    setRepoNote(L('저장소 목록을 불러오는 중…'));
    const r = (await act('cloud.loadRepos')) || { rows: [], gh: false };
    const rows = r.rows || [];
    const note = rows.length ? null : (r.gh
      ? L('저장소 목록을 불러오지 못했습니다 (gh auth login 필요할 수 있음). owner/repo를 위에 직접 입력하세요.')
      : L('gh(GitHub CLI)가 없어 목록을 불러오지 못했습니다. owner/repo를 위에 직접 입력하세요.'));
    setRepos(rows); setRepoNote(note);
  }
  const typed = trimWS(repoQuery);
  const addTyped = () => {
    if (typed.split('/').filter(Boolean).length !== 2 || picked.includes(typed)) return;
    setPicked(picked.concat([typed])); setRepoQuery('');
  };
  const openCloud = () => {
    act('platform.openExternal', cloudURL(task, picked));
    act('cloud.noteOpened', picked);
    onClose();
  };
  const q = typed.toLowerCase();
  const shown = repos.filter((r) => !q || r.name.toLowerCase().includes(q));
  const toggle = (name) => setPicked(picked.includes(name) ? picked.filter((x) => x !== name) : picked.concat([name]));
  return html`
    <div class="vstack" style=${{ gap: '8px' }}>
      <span class="t-callout fg-secondary">${L('GitHub 저장소')}</span>
      <div class="hstack" style=${{ gap: '8px' }}>
        <input class="textfield" style=${{ flex: '1 1 auto' }} value=${repoQuery} placeholder=${L('검색하거나 owner/repo 직접 입력')}
          onInput=${(e) => setRepoQuery(e.currentTarget.value)} onKeyDown=${(e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addTyped(); } }} />
        ${repoQuery.includes('/') && !picked.includes(typed) ? html`<${Button} kind="raisedCompact" onClick=${addTyped}>${L('추가')}<//>` : null}
      </div>
      ${picked.length ? html`<div class="hstack" style=${{ gap: '6px', flexWrap: 'wrap' }}>
        ${picked.map((r) => html`<span class="repo-chip" key=${r}>${r}
          <button type="button" onClick=${() => setPicked(picked.filter((x) => x !== r))}><${Icon} name="xmark" size=${8} strokeWidth=${3} /></button></span>`)}
      </div>` : null}
      <div class="repo-list">
        ${repoNote ? html`<div class="t-caption fg-secondary" style=${{ padding: '8px' }}>${repoNote}</div>` : null}
        ${shown.map((r) => {
          const on = picked.includes(r.name);
          return html`<button type="button" class="repo-row" key=${r.name} onClick=${() => toggle(r.name)}>
            <${Icon} name=${on ? 'checkmark.circle.fill' : 'circle'} color=${on ? 'var(--accent)' : 'var(--secondary)'} />
            <span class="one-line">${r.name}</span>
            ${r.priv ? html`<${Icon} name="lock.fill" class="t-caption2" color="var(--secondary)" size=${10} />` : null}
          </button>`;
        })}
      </div>
    </div>
    <div class="vstack" style=${{ gap: '4px' }}>
      <span class="t-callout fg-secondary">${L('첫 작업 (선택)')}</span>
      <${GrowingField} value=${task} onInput=${setTask} placeholder=${L('웹 입력창에 미리 채워집니다. 보내기는 웹에서 누릅니다')} />
    </div>
    <span class="t-caption fg-secondary">${L('claude.ai/code가 브라우저에서 열리고, 고른 저장소와 첫 작업이 채워진 상태로 시작합니다. 클라우드 세션의 대화는 웹이나 모바일 앱에서 보며, 이 앱의 세션 목록에는 나타나지 않습니다. 비공개 저장소는 Claude GitHub 앱이 설치돼 있어야 합니다.')}</span>
    <div class="hstack" style=${{ gap: '8px' }}>
      <span class="spacer"></span>
      <${Button} kind="raised" onClick=${onClose}>${L('취소')}<//>
      <${Button} kind="raisedProminent" disabled=${!picked.length} onClick=${openCloud}>${L('웹에서 열기')}<//>
    </div>`;
}
function LocalForm({ st, onClose }) {
  const { name, setName, withTeam, setWithTeam, team, setTeam, task, setTask } = st;
  const [cwdStored, setCwd] = useAppStorage('new.cwd', '');
  const [home, setHome] = useState('');
  const [modelRaw, setModel] = useAppStorage('new.model.v2', 'claude-opus-5-5');
  const [effortRaw, setEffort] = useAppStorage('new.effort.v2', 'low');
  const [bypass, setBypass] = useBypass();
  useEffect(() => { act('panes.home').then((h) => setHome(h || ''), () => {}); }, []);
  const cwd = cwdStored || home;            // @AppStorage("new.cwd") default: Shell.home
  const pickFolder = async () => { const p = await act('platform.pickFolder', cwd); if (p) setCwd(p); };
  const canStart = trimWS(name) !== '';
  const start = async () => {
    const model = ModelChoice.some((m) => m.raw === modelRaw) ? modelRaw : 'claude-sonnet-5-5';
    const effort = EffortChoice.includes(effortRaw) ? effortRaw : 'medium';
    const r = await act('store.createSession', name, cwd, model, effort, withTeam ? team.map(specJSON) : [], task, bypass);
    if (r != null) onClose();
  };
  const haiku = modelRaw === 'claude-haiku-5-5' || modelRaw === 'claude-haiku-4-5';
  return html`<div class="ab-sheet-v" style=${{ gap: '14px' }} onKeyDown=${defaultAction(start, canStart)}>
    <div class="form-grouped">
      <${FormRow} label=${L('이름 (표시용 별칭)')}>
        <input class="textfield" value=${name} placeholder=${L('예: 논문 그림 리뷰 — 한글 가능, 나중에 /rename 으로 변경 가능')} onInput=${(e) => setName(e.currentTarget.value)} />
      <//>
      <${FormRow} label=${L('작업 폴더')}>
        <input class="textfield" value=${cwd} onInput=${(e) => setCwd(e.currentTarget.value)} />
        <${Button} kind="raisedCompact" onClick=${pickFolder}>${L('선택…')}<//>
      <//>
      <${FormRow} label=${L('모델')}><${Picker} value=${modelRaw} options=${modelOptions()} onChange=${setModel} /><//>
      <${FormRow} label="effort"><${Picker} value=${effortRaw} options=${effortOptions()} onChange=${setEffort} /><//>
      <div class="form-row"><${Switch} checked=${withTeam} onChange=${setWithTeam} label=${L('팀원 구성 (이 세션이 팀장이 됨)')} style=${{ justifyContent: 'space-between', width: '100%' }} /></div>
      <div class="form-row"><${BypassToggle} on=${bypass} onChange=${setBypass} /></div>
    </div>
    <div class="vstack" style=${{ gap: '4px' }}>
      <span class="t-callout fg-secondary">${L('첫 작업 (선택)')}</span>
      <${GrowingField} value=${task} onInput=${setTask} placeholder=${L('비워 두면 지시를 기다립니다')} />
    </div>
    ${withTeam ? html`<div class="team-box">
      <span class="t-headline">${L('팀원')}</span>
      <div style=${{ maxHeight: '160px', overflowY: 'auto' }}><${TeammateEditor} specs=${team} onChange=${setTeam} /></div>
      ${haiku ? html`<${HaikuLeadWarning} />` : null}
    </div>` : null}
    <span class="t-caption fg-secondary">${withTeam ? L('세션이 시작되면 위 팀원 구성을 지시받아 Claude의 팀 기능으로 팀원을 만듭니다. 팀원 생성부터 토큰을 사용합니다.') : L('첫 작업을 비워 두면 토큰을 쓰지 않고 대기합니다.')}</span>
    <div class="hstack" style=${{ gap: '8px' }}>
      <span class="spacer"></span>
      <${Button} kind="raised" onClick=${onClose}>${L('취소')}<//>
      <${Button} kind="raisedProminent" disabled=${!canStart} onClick=${start}>${L('시작')}<//>
    </div>
  </div>`;
}

// ── AddTeammateSheet ───────────────────────────────────────────────────────────────────────────────────────────────
/** props: sid (the session that gets the teammates), onClose. */
export function AddTeammateSheet({ sid, onClose }) {
  ensureCSS();
  const s = useBoard();
  const agent = agentIn(s, sid);
  const [specs, setSpecs] = useState(() => [newTeammateSpec('teammate1')]);
  const [canSpawn, setCanSpawn] = useState(true);
  // start the background check before the warning is needed; asked again as the state moves (its answer arrives later)
  useEffect(() => { let live = true; act('store.canSpawnTeammates', sid).then((v) => { if (live) setCanSpawn(v !== false); }, () => {}); return () => { live = false; }; }, [sid, s && JSON.stringify(s.spawnChecks || null)]);
  if (!agent) return null;
  const valid = specs.some((t) => teammateNameIsValid(t.name));
  const create = () => { act('store.addTeammates', specs.map(specJSON), sid); onClose(); };
  return html`<${Sheet} width=${600} onClose=${onClose}>
    <div class="ab-sheet-v" style=${{ gap: '12px' }} onKeyDown=${defaultAction(create, valid)}>
      <span class="t-title3 t-bold">${L("'%@'에 팀원 추가", agent.name)}</span>
      <span class="t-caption fg-secondary">${agent.isLead || agent.teamName != null ? L('이 세션이 팀장으로서 팀원을 만듭니다.') : L('개별 세션입니다. 이 세션이 팀을 만들고 팀장이 됩니다.')}</span>
      <${TeammateEditor} specs=${specs} onChange=${setSpecs} />
      ${(agent.model || '').includes('haiku') ? html`<${HaikuLeadWarning} />` : null}
      ${!canSpawn ? html`<div class="ab-warn" style=${{ color: 'var(--sys-red)' }}><${Icon} name="exclamationmark.octagon" />
        <span>${L('이 세션은 tmux를 찾을 수 없는 환경에서 시작돼 팀원을 만들 수 없습니다 (이전 버전 앱의 문제). 종료한 뒤 \'다시 시작\'하면 해결됩니다.')}</span></div>` : null}
      ${agent.state === 'busy' ? html`<span class="t-caption" style=${{ color: 'var(--sys-orange)' }}>${L('작업 중이라 지시가 현재 작업 뒤에 대기열로 들어갑니다.')}</span>` : null}
      <div class="hstack" style=${{ gap: '8px' }}>
        <span class="spacer"></span>
        <${Button} kind="raised" onClick=${onClose}>${L('취소')}<//>
        <${Button} kind="raisedProminent" disabled=${!valid} onClick=${create}>${L('만들기')}<//>
      </div>
    </div>
  <//>`;
}

// ── ResumeSheet ────────────────────────────────────────────────────────────────────────────────────────────────────
/** props: sid (the ended session to open again), onClose. */
export function ResumeSheet({ sid, onClose }) {
  ensureCSS();
  const s = useBoard();
  const agent = agentIn(s, sid);
  const [model, setModel] = useState('claude-sonnet-5-5');
  const [effort, setEffort] = useState('medium');
  const [fork, setFork] = useState(false);
  const [bypass, setBypass] = useBypass();
  const [info, setInfo] = useState({ job: null, cwd: null, host: null });
  const ready = useRef(false);
  useEffect(() => {
    if (!agent || ready.current) return;
    ready.current = true;
    const m = agent.model || '';
    setModel((ModelChoice.find((c) => c.raw === m) || ModelChoice.find((c) => m.startsWith(c.raw)) || { raw: 'claude-sonnet-5-5' }).raw);
    setEffort(EffortChoice.includes(agent.effort) ? agent.effort : 'medium');
  }, [agent]);
  useEffect(() => {
    let live = true;
    (async () => {
      const conv = await act('store.conversationId', sid);
      const [job, cwd, host] = await Promise.all([act('store.jobRecord', conv || sid), act('store.workingDirectory', sid), act('store.externalHost', sid)]);
      if (live) setInfo({ job: job || null, cwd: cwd || null, host: host || null });
    })().catch(() => {});
    return () => { live = false; };
  }, [sid]);
  if (!agent) return null;
  const { job, cwd, host } = info;
  const start = async () => { const r = await act('store.resume', sid, model, effort, bypass, fork); if (r != null) onClose(); };
  return html`<${Sheet} width=${520} onClose=${onClose}>
    <div class="ab-sheet-v" style=${{ gap: '12px' }} onKeyDown=${defaultAction(start, true)}>
      <span class="t-title3 t-bold">${L("'%@' 다시 시작", agent.name)}</span>
      <span class="t-caption fg-secondary">${job != null ? L('CLI 백그라운드 작업의 대화입니다. CLI 방식대로 같은 ID로 백그라운드에서 이어서 열고(claude --bg --resume) 화면을 붙입니다(claude attach).')
        : L('이전 대화를 같은 세션 ID로 그대로 이어서 엽니다 (claude --resume).')}</span>
      ${cwd ? html`<span class="t-caption hstack" style=${{ gap: '5px', minWidth: 0 }} title=${cwd}><${Icon} name="folder" />
        <${MiddleText} text=${cwd} /></span>` : null}
      <div class="form-grouped">
        <${FormRow} label=${L('모델')}><${Picker} value=${model} options=${modelOptions()} onChange=${setModel} /><//>
        <${FormRow} label="effort"><${Picker} value=${effort} options=${effortOptions()} onChange=${setEffort} /><//>
        <div class="form-row"><${BypassToggle} on=${bypass} onChange=${setBypass} /></div>
        ${job == null ? html`<div class="form-row" style=${{ flexDirection: 'column', alignItems: 'stretch', gap: '2px' }}>
          <${Switch} checked=${fork} onChange=${setFork} label=${L('복사본으로 분기해서 열기 (--fork-session, 새 세션 ID)')} style=${{ justifyContent: 'space-between', width: '100%' }} />
          ${host ? html`<span class="t-caption fg-secondary">${L('%@에서 만든 대화입니다. 끄면 원본을 같은 ID로 이어가고(%@의 목록과 같은 대화), 켜면 원본은 두고 복사본을 엽니다.', host, host)}</span>` : null}
        </div>` : null}
      </div>
      <span class="t-caption fg-secondary">${L('시작 옵션으로 지정하므로 기본 설정은 바뀌지 않습니다.')}</span>
      ${agent.teamName != null && !agent.isLead ? html`<span class="t-caption" style=${{ color: 'var(--sys-orange)' }}>${L('팀원 세션은 팀과 분리된 개별 세션으로 열립니다. 팀장과의 연결은 복구되지 않습니다.')}</span>` : null}
      <div class="hstack" style=${{ gap: '8px' }}>
        <span class="spacer"></span>
        <${Button} kind="raised" onClick=${onClose}>${L('취소')}<//>
        <${Button} kind="raisedProminent" onClick=${start}>${L('시작')}<//>
      </div>
    </div>
  <//>`;
}

