// Root of the Linux app, ported from App.swift: the first-launch language picker, then RootView — the usage banner and
// the tab row in one box, the notices strip, sessions still starting, teammate-spawn checks, and the tabs (org chart,
// individual sessions, each live team, the archive), every visited tab kept built and only hidden. Also the
// keyboard shortcuts (⌘ on the Mac as in Swift, Ctrl on Linux), the View menu (the menu bar's View menu on the Mac,
// main/appmenu.js; a menu button in the tab row on Linux), the window-close question and the quit confirmation flow
// (AppDelegate.applicationShouldTerminate; main/store.js asks with 'quit-request').
import { html, render, useState, useEffect, useRef, loadL10n, currentLang, setLang, call, on, L, useStore, isMac, modKey, keys } from './lib.js';
import { applyAppearance, useAppearance, AppearanceMode, Icon, Label, Button, TabButton, Menu, Chip, Checkbox, EmptyState, ProgressSpinner, BoostLogo, confirm } from './ui/widgets.js';
import { Fmt } from './fmt.js';
import { UsageBanner, useAppStorage, setAppStorage, getAppStorage, chooseLanguage } from './ui/banner.js';
import { OrgChartView, LaunchCard, LazyView, canQuit, canResume } from './ui/orgchart.js';

// Window appearance from localStorage 'ui.appearance' (system | dark | light, default dark), as App.applyAppearance.
applyAppearance();
// this file's views and the banner's styles (index.html stays untouched)
{
  const l = document.createElement('link');
  l.rel = 'stylesheet'; l.href = new URL('./app.css', import.meta.url).href;
  document.head.appendChild(l);
}

// ── store state: pushed by main, fetched once at start, or the dev fixture (location.hash contains 'fixture') ─────
let initialState = null, fixtureState = null;
const rootSubs = new Set();
const bump = () => rootSubs.forEach((f) => f((n) => n + 1));
call('store.getState').then((s) => { initialState = s; bump(); }).catch(() => { });
/** The board state the root views draw: the fixture's, else the latest push (or the first read before any push). */
function useRootState() {
  const pushed = useStore();
  const [, tick] = useState(0);
  useEffect(() => { rootSubs.add(tick); return () => rootSubs.delete(tick); }, []);
  if (fixtureState) return fixtureState;
  return pushed || initialState;
}
async function syncFixture() {
  const want = location.hash.includes('fixture');
  if (want && !fixtureState) {
    const m = await import('./dev/fixture-state.js');
    fixtureState = m.fixtureState();
    // the team detail views read the store through ui/board.js: hand them the same fixture
    try { (await import('./ui/board.js')).setFixture({ state: fixtureState, chat: m.fixtureChat ? m.fixtureChat() : {} }); } catch { /* not there yet */ }
    bump();
  } else if (!want && fixtureState) {
    fixtureState = null;
    try { (await import('./ui/board.js')).setFixture(null); } catch { /* not there yet */ }
    bump();
  }
}

const allAgents = (s) => (s ? [...(s.teams || []).flatMap((t) => t.members || []), ...(s.loose || [])] : []);
const agentIn = (s, sid) => allAgents(s).find((a) => a.sessionId === sid) || null;

// ── RootView ──────────────────────────────────────────────────────────────────────────────────────────────────────

function useWindowHeight() {
  const [h, setH] = useState(window.innerHeight);
  useEffect(() => { const f = () => setH(window.innerHeight); window.addEventListener('resize', f); return () => window.removeEventListener('resize', f); }, []);
  return h;
}

/** The loose sessions as a pseudo-team for the team detail view (Team(name: 개별 세션, members: store.loose)). */
function looseTeam(s) {
  const members = (s && s.loose) || [];
  return {
    name: L('개별 세션'), id: '__loose', createdAt: null, leadSessionId: null, members, lead: null,
    liveCount: members.filter((m) => m.state === 'busy' || m.state === 'idle' || m.state === 'needsInput').length,
    isSolo: false, displayName: L('개별 세션'),
    tokens: members.reduce((t, m) => ({ input: t.input + (m.tokens?.input || 0), cacheWrite: t.cacheWrite + (m.tokens?.cacheWrite || 0), cacheRead: t.cacheRead + (m.tokens?.cacheRead || 0), output: t.output + (m.tokens?.output || 0) }), { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }),
  };
}

function RootView() {
  const s = useRootState();
  const [tab, setTab] = useState('home');
  const [searching, setSearching] = useState(false);
  const [creating, setCreating] = useState(false);
  const [alive, setAlive] = useState(['home']);
  const [showNotices] = useAppStorage('ui.showNotices', true);
  const [, , isDark] = useAppearance();
  const compact = useWindowHeight() < 700;
  const teams = (s && s.teams) || [], loose = (s && s.loose) || [];

  const tabExists = (k) => k === 'home' || k === '__archive' || k === '__loose' || teams.some((t) => t.name === k);
  const current = tabExists(tab) ? tab : 'home';
  // every tab visited stays built (hidden); a click only changes which one is visible
  useEffect(() => { if (!alive.includes(current)) setAlive([...alive, current]); }, [current]);
  // tmux + files read again first
  const firstTab = useRef(true);
  useEffect(() => { if (firstTab.current) { firstTab.current = false; return; } call('store.refreshSoon').catch(() => { }); }, [tab]);

  // store → tab: the launch tab (--tab), a navigation request, the selected agent / team
  const seen = useRef({ launch: false, nav: null, agent: undefined, team: undefined });
  useEffect(() => {
    if (!s) return;
    const r = seen.current;
    if (!r.launch) { r.launch = true; if (s.launchTab) setTab(s.launchTab); }
    const navToken = s.navRequest ? s.navRequest.token || JSON.stringify(s.navRequest) : null;
    if (navToken !== r.nav) { r.nav = navToken; if (s.navRequest && navToken) setTab(s.navRequest.tab); }
    if (s.selectedAgent !== r.agent) {
      const first = r.agent === undefined;
      r.agent = s.selectedAgent;
      const a = agentIn(s, s.selectedAgent);
      if (!first && a && (a.teamName == null || a.solo) && tab !== '__loose' && (tab !== 'home' || s.selectedTeam == null)) setTab('__loose');
    }
    if (s.selectedTeam !== r.team) {
      const first = r.team === undefined;
      r.team = s.selectedTeam;
      const t = s.selectedTeam;
      if (!first && t && t !== tab && teams.some((x) => x.name === t)) setTab(t);
    }
  }, [s]);

  // the store reads the notices switch for its desktop notifications (PromptNotifier)
  useEffect(() => { call('store.setPref', 'ui.showNotices', showNotices).catch(() => { }); }, [showNotices]);
  useShortcuts({ newSession: () => setCreating(true), search: () => setSearching(true) });
  useTrayMark(s);

  const tabContent = (k, active) => {
    if (k === '__archive') return html`<div class="area-box tab-fill"><${ArchiveView} s=${s} /></div>`;
    if (k === '__loose') return html`<${LazyView} file="teamdetail.js" name="TeamDetailView" team=${looseTeam(s)} isLoose=${true} active=${active} />`;
    const t = teams.find((x) => x.name === k);
    if (t) return html`<${LazyView} file="teamdetail.js" name="TeamDetailView" team=${t} isLoose=${false} active=${active} />`;
    return html`<${OrgChartView} s=${s} />`;
  };
  const launches = (s && s.launches) || [];
  const archiveCount = s && s.archive ? Object.keys(s.archive).length : 0;
  return html`<div class="root">
    <div class="area-box top-box">
      <${UsageBanner} s=${s} compact=${compact} />
      <div class="tab-row">
        <div class="tabs">
          <${TabButton} title=${L('조직도')} icon="rectangle.3.group" active=${tab === 'home'} onClick=${() => setTab('home')} />
          ${loose.length ? html`<${TabButton} title=${L('개별 세션')} icon="person" active=${tab === '__loose'} count=${loose.filter((a) => a.state !== 'ended').length} onClick=${() => setTab('__loose')} />` : null}
          ${teams.filter((t) => t.liveCount > 0 || t.name === tab).map((t) => html`<${TabButton} key=${t.name} title=${t.displayName} icon="person.3" active=${tab === t.name}
              count=${t.liveCount} attention=${t.members.some((m) => m.state === 'needsInput')} onClick=${() => { setTab(t.name); call('store.setSelectedTeam', t.name); }} />`)}
        </div>
        <span class="spacer" style=${{ minWidth: '12px' }}></span>
        <div class="utility">
          <${Button} kind="quiet" help=${L('claude update를 실행합니다. 실행 중인 세션은 다시 시작해야 새 버전을 씁니다.')} onClick=${() => call('store.updateClaude')}>
            <${Label} icon="arrow.down.circle" title=${L('업데이트')} /><//>
          <${Button} kind="quiet" help=${L('창을 숨기고 백그라운드에서 계속 실행합니다. 메뉴 막대 아이콘이나 앱 아이콘으로 다시 엽니다.')} onClick=${() => call('tray.goBackground')}>
            <${Label} icon="moon.zzz" title=${L('백그라운드')} /><//>
          <${TabButton} title=${L('보관함')} icon="archivebox" active=${tab === '__archive'} count=${archiveCount} quiet=${true} onClick=${() => setTab('__archive')} />
          ${s && (s.selection || []).length ? html`<${SelectionBar} s=${s} />` : null}
          <${Button} kind="quiet" help=${L("홈 폴더에 'Memory Manager' 세션(Sonnet 5.5 · low)을 만들고 디스크 분석·정리 제안을 바로 지시합니다. 실제 정리는 승인 후에만 합니다.")} onClick=${() => call('store.createDiskManager')}>
            <${Label} icon="internaldrive" title=${L('디스크 관리자 생성')} /><//>
          <${Button} kind="quiet" help=${isDark ? L('화이트 모드로 바꿉니다') : L('다크 모드로 바꿉니다')} onClick=${() => applyAppearance(isDark ? 'light' : 'dark', true)}>
            <${Icon} name=${isDark ? 'sun.max' : 'moon'} style=${{ width: '16px' }} /><//>
          ${isMac ? null : html`<${ViewMenu} />`}
          <${Button} kind="quiet" help=${keys(L('모든 세션의 지난 대화에서 찾습니다 (⌘⇧F)'))} onClick=${() => setSearching(true)}>
            <${Label} icon="magnifyingglass" title=${L('대화 검색')} /><//>
          <${Button} kind="tab" strong=${true} help=${keys('⌘N')} onClick=${() => setCreating(true)}><${Label} icon="plus" title=${L('새 세션')} /><//>
        </div>
      </div>
    </div>
    ${showNotices && s ? html`<${AlertStrip} s=${s} />` : null}
    ${tab !== 'home' && launches.length ? html`<div class="area-box launch-box">${launches.map((l) => html`<${LaunchCard} key=${l.id} launch=${l} />`)}</div>` : null}
    ${showNotices && s ? html`<${SpawnChecks} s=${s} />` : null}
    <div class="tab-stack">
      ${alive.filter(tabExists).map((k) => html`<div key=${k} class=${'tab-layer ' + (k === current ? 'current' : 'hidden')}>${tabContent(k, k === current)}</div>`)}
    </div>
    ${creating ? html`<${LazyView} file="sheets.js" name="NewSessionSheet" sheet=${true} onClose=${() => setCreating(false)} />` : null}
    ${searching ? html`<${LazyView} file="search.js" name="ConvoSearchSheet" sheet=${true} onClose=${() => setSearching(false)} />` : null}
  </div>`;
}

// ── keyboard shortcuts (⌘ on the Mac, Ctrl on Linux) ────────────────────────────────────────────────────────────────
const fontStep = {
  bigger() { setAppStorage('ui.chatFont', Math.min(24, getAppStorage('ui.chatFont', 15) + 1)); setAppStorage('ui.termFont', Math.min(20, getAppStorage('ui.termFont', 13) + 1)); },
  smaller() { setAppStorage('ui.chatFont', Math.max(11, getAppStorage('ui.chatFont', 15) - 1)); setAppStorage('ui.termFont', Math.max(9, getAppStorage('ui.termFont', 13) - 1)); },
  reset() { setAppStorage('ui.chatFont', 15); setAppStorage('ui.termFont', 13); },
};
function useShortcuts({ newSession, search }) {
  useEffect(() => {
    const key = (e) => {
      if (!modKey(e) || e.altKey) return;
      // Linux: Ctrl is also the terminal's control key. A key the terminal panel took (it sends Ctrl+N, Ctrl+-, Ctrl+0,
      // Ctrl+= as bytes, as Swift's KeyCatcher does) is not an app shortcut. macOS: ⌘ keys still reach the app, as in Swift
      if (e.defaultPrevented || (!isMac && e.target && e.target.closest && e.target.closest('.term-screen'))) return;
      const k = e.key.toLowerCase();
      if (k === 'n' && !e.shiftKey) { e.preventDefault(); newSession(); }
      else if (k === 'f' && e.shiftKey) { e.preventDefault(); search(); }
      // macOS: ⌘= ⌘- ⌘0 belong to the View menu (main/appmenu.js), which sends them here as 'menu' actions
      else if (isMac) return;
      else if (k === '=' || k === '+') { e.preventDefault(); fontStep.bigger(); }
      else if (k === '-' || k === '_') { e.preventDefault(); fontStep.smaller(); }
      else if (k === '0') { e.preventDefault(); fontStep.reset(); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
}

/** The View menu bar items (AgentBoostApp.commands) picked on the Mac: main/appmenu.js sends {action, value}. */
on('menu', (m) => {
  const { action, value } = m || {};
  if (action === 'fontBigger') fontStep.bigger();
  else if (action === 'fontSmaller') fontStep.smaller();
  else if (action === 'fontReset') fontStep.reset();
  else if (action === 'appearance') applyAppearance(value, true);
  else if (action === 'showNotices') { setAppStorage('ui.showNotices', !!value); call('store.setPref', 'ui.showNotices', !!value).catch(() => { }); }
  else if (action === 'termChat') setAppStorage('ui.termChat', !!value);
  else if (action === 'cliSuggest') { setAppStorage('ui.cliSuggest', !!value); call('store.setPref', 'ui.cliSuggest', !!value).catch(() => { }); }
});
/** Keeps the menu bar's check marks (and the native appearance) on the page's settings. macOS only. */
function MenuBarSync() {
  const [mode] = useAppearance();
  const [showNotices] = useAppStorage('ui.showNotices', true);
  const [termChat] = useAppStorage('ui.termChat', true);
  const [cliSuggest] = useAppStorage('ui.cliSuggest', true);
  useEffect(() => { call('appmenu.setViewState', { appearance: mode, showNotices, termChat, cliSuggest }).catch(() => { }); }, [mode, showNotices, termChat, cliSuggest]);
  return null;
}

/** The macOS View menu's items (AgentBoostApp.commands) as a menu button in the tab row (Linux; the Mac has them in
 *  its menu bar). */
function ViewMenu() {
  const [mode, setMode] = useAppearance();
  const [showNotices, setShowNotices] = useAppStorage('ui.showNotices', true);
  const [termChat, setTermChat] = useAppStorage('ui.termChat', true);
  const [cliSuggest, setCliSuggest] = useAppStorage('ui.cliSuggest', true);
  const entries = () => [
    { item: `${L('대화 글자 크게')}   ${keys('⌘=')}`, action: fontStep.bigger },
    { item: `${L('대화 글자 작게')}   ${keys('⌘-')}`, action: fontStep.smaller },
    { item: `${L('대화 글자 기본')}   ${keys('⌘0')}`, action: fontStep.reset },
    '-',
    { header: L('화면 모드') },
    ...AppearanceMode.all.map((m) => ({ item: AppearanceMode.title(m), checked: mode === m, action: () => setMode(m) })),
    '-',
    { item: L('알림 표시'), checked: showNotices, action: () => { setShowNotices(!showNotices); call('store.setPref', 'ui.showNotices', !showNotices).catch(() => { }); } },
    { item: L('터미널식 대화 표시 (가벼움)'), checked: termChat, action: () => setTermChat(!termChat) },
    { item: L('CLI 다음 입력 제안 켜기 (새로 시작하는 세션부터)'), checked: cliSuggest, action: () => { setCliSuggest(!cliSuggest); call('store.setPref', 'ui.cliSuggest', !cliSuggest).catch(() => { }); } },
    '-',
    { item: L('Claude Code 업데이트'), action: () => call('store.updateClaude') },
  ];
  return html`<${Menu} kind="quiet" help=${L('보기')} entries=${entries} label=${html`<${Icon} name="line.3.horizontal" style=${{ width: '16px' }} />`} />`;
}

// ── AlertStrip, SpawnCheckRow, SelectionBar, ArchiveView ──────────────────────────────────────────────────────────

/** Slim, scrollable alert log under the banner (newest first). Shown while alerts are on. */
function AlertStrip({ s }) {
  const [clearedAt, setClearedAt] = useState(0);
  const log = (s.noticeLog || []).filter((n) => n.at > clearedAt);
  if (!log.length) return null;
  const clear = () => {
    // noticeLog.removeAll(); notice = nil — the store's setter when it has one; the strip forgets the shown rows either way
    setClearedAt(Math.max(...log.map((n) => n.at)));
    call('store.clearNoticeLog').catch(() => call('store.setNotice', null).catch(() => { }));
  };
  return html`<div class="area-box alert-strip">
    <${Icon} name="bell.fill" color="var(--accent)" style=${{ marginTop: '3px' }} />
    <div class="log" style=${{ height: `${log.length > 1 ? 44 : 22}px` }}>
      ${log.map((n, i) => html`<div key=${n.id} class="log-row">
        <span class="t-caption t-digits fg-tertiary" style=${{ flex: '0 0 auto' }}>${Fmt.time(n.at)}</span>
        <span class=${(i === 0 ? 't-callout fg' : 't-caption fg-secondary') + ' selectable'} style=${{ whiteSpace: 'pre-wrap' }}>${n.text}</span>
      </div>`)}
    </div>
    <${Button} kind="raisedCompact" help=${L('알림 기록 지우기')} onClick=${clear}>${L('지우기')}<//>
  </div>`;
}

/** Teammate spawn checks: did the processes the lead was told to create come up with the right model and effort. */
function SpawnChecks({ s }) {
  const [dismissed, setDismissed] = useState([]);
  return (s.spawnChecks || []).filter((c) => !dismissed.includes(c.id)).map((c) => html`<${SpawnCheckRow} key=${c.id} check=${c}
    onClose=${() => { setDismissed([...dismissed, c.id]); call('store.removeSpawnCheck', c.id).catch(() => { }); }} />`);
}
function SpawnCheckRow({ check, onClose }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (check.done) return undefined; const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, [check.done]);
  const result = (spec) => {
    const r = (check.results || {})[spec.name] || 'waiting';
    if (r === 'ok') return html`<span class="fg-green"><${Label} icon="checkmark.circle.fill" title=${spec.name} /></span>`;
    if (r === 'failed') return html`<span class="fg-red"><${Label} icon="xmark.circle.fill" title=${spec.name} /></span>`;
    if (r && typeof r === 'object' && r.mismatch != null) return html`<span class="fg-orange"><${Label} icon="exclamationmark.triangle.fill" title=${`${spec.name} (${r.mismatch})`} /></span>`;
    return html`<span class="fg-secondary"><${Label} icon="hourglass" title=${spec.name} /></span>`;
  };
  return html`<div class="area-box spawn-row">
    <div class="hstack" style=${{ gap: '10px' }} title=${L('팀장에게 팀원 생성을 지시한 뒤, 실제로 팀원 프로세스가 지정한 모델·effort로 떴는지 앱이 확인합니다. 팀장이 실패를 보고하면 즉시 실패로 표시합니다.')}>
      <${Icon} name="person.badge.plus" />
      <span class="t-bold">${L('팀원 생성 확인')}</span>
      ${(check.specs || []).map((sp) => html`<span key=${sp.name}>${result(sp)}</span>`)}
      <span class="spacer"></span>
      <span class="t-caption fg-secondary">${check.done ? L('확인 끝') : L('확인 중 %@초 경과 · 최대 2분', String(Math.max(0, Math.trunc((now - check.started) / 1000))))}</span>
      <${Button} kind="icon" help=${L('닫기')} onClick=${onClose}><${Icon} name="xmark" /><//>
    </div>
    ${check.reason ? html`<span class="t-caption fg-secondary selectable">${L('팀장 보고: %@', check.reason)}</span>`
      : check.leadScreen ? html`<pre class="t-mono t-caption2 fg-secondary" style=${{ margin: 0, whiteSpace: 'pre-wrap' }}>${L('팀장 화면:\n%@', check.leadScreen)}</pre>` : null}
  </div>`;
}

/** Batch actions for the checked name cards. */
function SelectionBar({ s }) {
  const sel = (s.selection || []).map((id) => agentIn(s, id)).filter(Boolean);
  const wake = sel.filter(canResume).length;
  const quit = sel.filter(canQuit).length;
  const busy = sel.filter((a) => canQuit(a) && a.state === 'busy').length;
  const askQuit = async () => {
    if (busy === 0) { call('store.quitSelected', 'now'); return; }
    const v = await confirm(L('작업 중인 세션이 %@개 있습니다', String(busy)), null, [
      { label: L('지금 모두 종료 (작업 중단)'), role: 'destructive', value: 'now' },
      { label: L('작업 끝나면 종료'), value: 'whenIdle' },
      { label: L('취소'), role: 'cancel' }]);
    if (v) call('store.quitSelected', v);
  };
  const askArchive = async () => {
    const v = await confirm(L('선택한 %@개 세션을 보관할까요?', String(sel.length)),
      sel.map((a) => a.name).join(', ') + '\n' + L('실행 중인 세션은 먼저 종료합니다. 보관함에서 복원하거나 영구 삭제할 수 있습니다.'),
      [{ label: L('보관'), value: true }, { label: L('취소'), role: 'cancel' }]);
    if (v) call('store.archiveSelected');
  };
  return html`<div class="hstack" style=${{ gap: '6px' }}>
    <span class="t-callout t-bold fg-accent">${L('%@개 선택', String(sel.length))}</span>
    <${Button} kind="raisedCompact" disabled=${wake === 0} help=${L('종료된 세션을 마지막 모델·effort로 다시 시작')} onClick=${() => call('store.wakeSelected')}><${Label} icon="power" title=${L('깨우기 %@', String(wake))} /><//>
    <${Button} kind="raisedCompact" disabled=${quit === 0} help=${L('실행 중인 세션에 /exit')} onClick=${askQuit}><${Label} icon="power" title=${L('끄기 %@', String(quit))} /><//>
    <${Button} kind="raisedCompact" help=${L('종료 후 보관함으로 (복원 가능)')} onClick=${askArchive}><${Label} icon="archivebox" title=${L('보관 %@', String(sel.length))} /><//>
    <${Button} kind="icon" help=${L('선택 해제')} onClick=${() => call('store.setSelection', [])}><${Icon} name="xmark.circle" /><//>
  </div>`;
}

/** 보관함: archived sessions, restorable or permanently deletable, one by one or in bulk. */
function ArchiveView({ s }) {
  const items = Object.values((s && s.archive) || {}).sort((a, b) => b.archivedAt - a.archivedAt);
  const selection = new Set((s && s.archiveSelection) || []);
  const setSel = (ids) => call('store.setArchiveSelection', [...ids]);
  const askPurge = async (ids) => {
    const v = await confirm(L('영구 삭제할까요?'), L('대화 기록과 관련 폴더를 디스크에서 지웁니다. 되돌릴 수 없습니다.'), [
      { label: L('영구 삭제 %@개', String(ids.length)), role: 'destructive', value: true }, { label: L('취소'), role: 'cancel' }]);
    if (v) call('store.purge', ids);
  };
  const allOn = selection.size === items.length;
  return html`<div class="archive">
    <div class="archive-head">
      <span class="t-title2 t-bold">${L('보관함')}</span>
      <span class="fg-secondary">${L('%@개', String(items.length))}</span>
      <span class="spacer"></span>
      ${items.length ? html`
        <${Button} kind="raised" onClick=${() => setSel(allOn ? [] : items.map((i) => i.id))}>${allOn ? L('선택 해제') : L('전체 선택')}<//>
        <${Button} kind="raised" disabled=${selection.size === 0} onClick=${() => call('store.restore', [...selection])}><${Label} icon="arrow.uturn.backward" title=${L('복원 %@', String(selection.size))} /><//>
        <${Button} kind="raised" destructive=${true} disabled=${selection.size === 0} onClick=${() => askPurge([...selection])}><${Label} icon="trash" title=${L('영구 삭제 %@', String(selection.size))} /><//>` : null}
    </div>
    <div class="archive-divider"></div>
    ${!items.length ? html`<${EmptyState} icon="archivebox" title=${L('보관함이 비어 있습니다')} description=${L("보드에서 '보관'한 세션이 여기에 모입니다.")} />`
      : html`<div class="archive-list">${items.map((it) => html`<div key=${it.id} class="archive-row">
        <${Checkbox} checked=${selection.has(it.id)} onChange=${(on) => { const n = new Set(selection); if (on) n.add(it.id); else n.delete(it.id); setSel(n); }} />
        <div class="vstack" style=${{ gap: '3px', minWidth: 0 }}>
          <div class="hstack" style=${{ gap: '6px' }}>
            <span class="t-headline">${it.name}</span>
            ${it.isLead ? html`<${Chip} text=${L('팀장')} tint="var(--accent)" />` : null}
            ${it.teamName && !it.isLead ? html`<span class="t-caption fg-tertiary">${it.teamName}</span>` : null}
          </div>
          <div class="hstack t-caption" style=${{ gap: '8px' }}>
            ${it.cwd ? html`<span class="fg-secondary"><${Label} icon="folder" title=${it.cwd.replace(/\/+$/, '').split('/').pop()} /></span>` : null}
            <span class="fg-secondary">${L('출력 %@ · 합 %@', Fmt.tokens(it.tokensOut), Fmt.tokens(it.tokensTotal))}</span>
            <span class="fg-tertiary">${L('%@ 보관', Fmt.ago(it.archivedAt))}</span>
            ${it.transcriptPath == null ? html`<span class="fg-orange">${L('기록 없음')}</span>` : null}
          </div>
        </div>
        <span class="spacer"></span>
        <${Button} kind="raisedCompact" onClick=${() => call('store.restore', [it.id])}>${L('복원')}<//>
        <${Button} kind="raisedCompact" destructive=${true} onClick=${() => askPurge([it.id])}>${L('영구 삭제')}<//>
      </div>`)}</div>`}
  </div>`;
}

// ── tray mark (MenuBarLabel): the logo and the busy count, drawn here and handed to main/tray.js ───────────────────
const LOGO_ARCH = new Path2D('M27 100 L27 56 Q27 22 50 6 Q73 22 73 56 L73 100');
const LOGO_FINS = new Path2D('M27 70 L6 90 L6 100 L27 100 Z M73 70 L94 90 L94 100 L73 100 Z');
function trayImage(busy) {
  const S = 32, pad = 2, logo = S - 2 * pad;
  const text = busy > 0 ? String(busy) : '';
  const c = document.createElement('canvas');
  const ctx0 = c.getContext('2d'); ctx0.font = `700 ${Math.round(S * 0.62)}px system-ui, sans-serif`;
  const tw = text ? Math.ceil(ctx0.measureText(text).width) + 3 : 0;
  c.width = S + tw; c.height = S;
  const ctx = c.getContext('2d');
  const col = '#F26133';   // the brand orange reads on dark and light panels (Linux trays have no template images)
  ctx.save(); ctx.translate(pad, pad); ctx.scale(logo / 100, logo / 100);
  ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 15; ctx.lineCap = 'butt'; ctx.lineJoin = 'miter'; ctx.miterLimit = 6;
  ctx.stroke(LOGO_ARCH); ctx.fill(LOGO_FINS);
  ctx.beginPath(); ctx.arc(50, 56, 8.5, 0, 2 * Math.PI); ctx.fill();
  ctx.restore();
  if (text) { ctx.font = `700 ${Math.round(S * 0.62)}px system-ui, sans-serif`; ctx.fillStyle = col; ctx.textBaseline = 'middle'; ctx.fillText(text, S + 1, S / 2 + 1); }
  return c.toDataURL('image/png');
}
function useTrayMark(s) {
  const busy = allAgents(s).filter((a) => a.state === 'busy').length;
  useEffect(() => { call('tray.setImage', trayImage(busy), busy).catch(() => { }); }, [busy]);
}

// ── window close and quit (CloseInterceptor, AppDelegate.applicationShouldTerminate) ──────────────────────────────

/** The window's ✕ asks: go to background, quit the app only, or switch every session off and quit. */
async function askClose() {
  const live = ((await call('store.controllableLive').catch(() => [])) || []).length;
  const v = await confirm(L('창을 닫을까요?'),
    L('백그라운드: 창만 숨기고 앱·세션은 계속 돕니다 (메뉴 막대 아이콘으로 다시 열기).\n앱만 종료: 세션 %@개는 그대로 두고 앱만 끕니다.\n세션까지 종료: 세션 %@개를 모두 끄고(/exit) 앱을 끕니다. 다음 실행 때 다시 시작합니다.', String(live), String(live)),
    [{ label: L('백그라운드로'), value: 'bg' }, { label: L('앱만 종료'), value: 'app' }, { label: L('세션까지 종료'), value: 'all' }, { label: L('취소'), role: 'cancel' }]);
  if (v === 'bg') call('tray.goBackground');
  else if (v === 'app') call('store.requestQuit', false);
  else if (v === 'all') call('store.requestQuit', true);
}

/**
 * Quitting the board switches its sessions off (explicit /exit); the next launch resumes them. The store found live
 * sessions and held the quit: q = {stops (true/false from a quit button, null from ⌘Q / Ctrl+Q / the system), live,
 * waiting (names), waitingText (one line each with its question), busy (names), overlays (names)}.
 */
async function onQuitRequest(q) {
  let stops = q.stops;
  if (stops == null) {
    // a quit without a choice: ask which kind of quit
    const v = await confirm(L('Agent Boost를 종료합니다'),
      L('세션 %@개가 실행 중입니다. 세션은 그대로 두고 앱만 끌까요, 세션까지 모두 끌까요(/exit)? 세션까지 끄면 다음에 앱을 켤 때 다시 시작합니다.', String(q.live)),
      [{ label: L('앱만 종료'), value: 'app' }, { label: L('세션까지 종료'), value: 'all' }, { label: L('취소'), role: 'cancel' }]);
    if (!v) return;
    stops = v === 'all';
  }
  const waiting = q.waiting || [], busy = q.busy || [], overlays = q.overlays || [];
  if (stops === false) {
    // app only: the sessions keep running, but nobody will see their questions once the board is gone
    if (waiting.length) {
      const v = await confirm(L('응답을 기다리는 세션 %@개가 있습니다', String(waiting.length)),
        L('앱을 끄면 이 질문들의 알림을 받을 수 없습니다. 세션은 tmux에서 계속 답을 기다립니다.') + '\n\n' + (q.waitingText || ''),
        [{ label: L('그래도 앱만 종료'), value: true }, { label: L('취소 (답하러 가기)'), role: 'cancel' }]);
      if (!v) return;
    }
    call('store.confirmQuit', false);
    return;
  }
  // everything the quit would cut short is listed before it happens: a question nobody would otherwise see, a running
  // turn, a CLI that sits on its session list
  if (busy.length || waiting.length || overlays.length) {
    const lines = [];
    if (waiting.length) lines.push(L('응답을 기다리는 세션 %@개 — 종료하면 그 질문은 취소(Esc)됩니다:', String(waiting.length)) + '\n' + (q.waitingText || ''));
    if (busy.length) lines.push(L('작업 중인 세션 %@개 — 작업을 중단합니다: %@', String(busy.length), busy.join(', ')));
    if (overlays.length) lines.push(L('CLI가 세션 목록·선택 화면인 세션 %@개 — Esc로 대화로 돌아간 뒤 끕니다: %@', String(overlays.length), overlays.join(', ')));
    const v = await confirm(L('세션 %@개를 모두 끄고 종료할까요?', String(q.live)), lines.join('\n\n') + '\n\n' + L('다음에 앱을 켜면 다시 시작합니다.'),
      [{ label: waiting.length ? L('질문 취소하고 종료') : L('중단하고 종료'), value: true }, { label: L('취소'), role: 'cancel' }]);
    if (!v) return;
  }
  const problems = (await call('store.confirmQuit', true)) || [];
  if (problems.length) {   // the last chance to say it: the app is about to be gone
    await confirm(L('일부 세션이 정상 종료되지 않았습니다'), problems.join('\n'), [{ label: L('확인'), value: true }]);
    call('store.finishQuit');
  }
}
on('quit-request', (q) => { onQuitRequest(q || {}); });
on('close-request', () => { askClose(); });

// ── first launch: LanguagePickerView ──────────────────────────────────────────────────────────────────────────────

/** A black screen with the logo, the name and the five languages. Picking one starts the app (its power-on self-test
 *  and the rocket loading screen run as the sessions are read). */
function LanguagePickerView({ onPick }) {
  const [shown, setShown] = useState(false);
  useEffect(() => { requestAnimationFrame(() => requestAnimationFrame(() => setShown(true))); }, []);
  const langs = [['en', 'English'], ['ko', '한국어'], ['ja', '日本語'], ['zh', '简体中文'], ['es', 'Español']];
  return html`<div class="lang-picker">
    <div class=${'inner' + (shown ? ' shown' : '')}>
      <${BoostLogo} size=${96} />
      <div class="title"><span>Agent</span><span class="accent">Boost</span></div>
      <div class="langs">${langs.map(([id, name]) => html`<button key=${id} type="button" class="lang-btn" onClick=${() => onPick(id)}>${name}</button>`)}</div>
    </div>
  </div>`;
}

// ── App ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** location.hash: '#gallery' shows the widget gallery; 'fixture' anywhere draws the dev fixture state. */
function useHash() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const f = () => { applyAppearance(); syncFixture().then(() => setHash(location.hash)); };
    window.addEventListener('hashchange', f);
    f();   // a hash set between the first draw and this effect
    return () => window.removeEventListener('hashchange', f);
  }, []);
  return hash;
}
function GalleryLoader() {
  const [G, set] = useState(null);
  useEffect(() => { import('./ui/gallery.js').then((m) => set(() => m.Gallery)); }, []);
  return G ? html`<${G} />` : null;
}

function App() {
  const [lang, setL] = useState(currentLang());
  const hash = useHash();
  // a language picked in the banner menu: every text is drawn again (RootView().id(language))
  useEffect(() => {
    const f = (e) => { setLang(e.detail); setL(e.detail); };
    window.addEventListener('ab-language', f);
    return () => window.removeEventListener('ab-language', f);
  }, []);
  const menuSync = isMac ? html`<${MenuBarSync} />` : null;
  if (hash === '#gallery') return html`<${GalleryLoader} />`;
  if (!lang) {
    // first launch: pick a language, then the app starts with its power-on test and rocket loading
    return html`${menuSync}<${LanguagePickerView} onPick=${async (l) => {
      await chooseLanguage(l);
      call('store.manualRefresh').catch(() => { });
    }} />`;
  }
  // the fixture swaps the whole state source: a fresh root, so the store's tab requests do not carry over
  return html`${menuSync}<${RootView} key=${lang + (fixtureState ? ':fixture' : '')} />`;
}

// the store saves these switches itself (it needs them before the page exists): the page's copies follow it
async function syncPrefs() {
  try {
    const p = await call('store.getPref');
    for (const k of ['ui.cliSuggest', 'new.bypass', 'ui.showNotices']) if (p && typeof p[k] === 'boolean') setAppStorage(k, p[k]);
  } catch { /* store not ready: keep the page's values */ }
}
// stray file drops must never open the file in place of the app (the guard lives with the session views)
import('./ui/board.js').then((b) => b.installDropGuard && b.installDropGuard()).catch(() => { });
Promise.all([loadL10n(), syncPrefs()]).then(() => render(html`<${App} />`, document.getElementById('root')));
