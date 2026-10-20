// Port of TeamDetailView.swift: one team — the member list on the left, the selected session's conversation and
// controls on the right (AgentPanel), or the lead and the opened teammates side by side (SplitPane, ResizableSplit).
// Also the input line (ComposerBar), the rebuilt chat for sessions without a live CLI screen (ChatView, Bubble,
// TermLine), the answer actions (AnswerActions), and Format.swift's AttachmentStrip and DropHint.
//
// Exports: TeamDetailView({team, isLoose, active}), MemberRow, AgentPanel, ComposerBar, ChatView, Bubble, TermLine,
// SplitPane, ResizeGap, ResizableSplit, AnswerActions, AttachmentStrip, DropHint.
// Other modules: ui/panechat.js (PaneChatView, TerminalPanel) and ui/sheets.js (AddTeammateSheet, ResumeSheet) are
// loaded with import() and show a neutral placeholder while missing. Files dropped on a chat reach the session's
// composer as window event 'ab-attach-to-composer' {detail: {sid, paths}} (Swift: Notification .attachToComposer).
import { html, useState, useEffect, useRef, useLayoutEffect, useMemo, L } from '../lib.js';
import {
  Icon, Label, Button, Chip, StateDot, Avatar, Checkbox, EmptyState, LazyMenu, ChaseRing, showMenu, confirm,
} from './widgets.js';
import { Fmt, ModelChoice, EffortChoice, overlayName } from '../fmt.js';
import { useBoard, board, agentIn, act, useChat, useAppStorage, ensureStyles, fixtureOpt } from './board.js';
import { MarkdownView, MarkdownParser, Composer } from './markdown.js';
import { ToolLine } from './toolline.js';
import { PromptCard } from './promptcard.js';
import { TurnStatusBar, ComposerFooter } from './turnstatus.js';
import { SlashPaletteView, MentionPaletteView } from './slashpalette.js';
import { useAgentActions, quitDialog } from './agentactions.js';
import { usePathLinks, PathLinks } from './pathlinks.js';
import { RemoteChip } from './orgchart.js';
import { SlashController, routeAction, isTerminalOnly, setL as setSlashL } from '../logic/slash.mjs';
import { MentionController, HistoryNav, HistoryCompleter, setL as setSuggestL } from '../logic/suggest.mjs';

ensureStyles();
setSlashL(L); setSuggestL(L);

// ── store checks the views need synchronously (the snapshot carries what they read) ──────────────────────────────
/** BoardStore.canControl: the app can type into it. */
const canControl = (a) => a.state !== 'ended' && a.tmuxPane != null;
/** BoardStore.canQuit: a live session with a process to stop. */
const canQuit = (a) => a.state !== 'ended' && a.pid != null;
/** BoardStore.canResume: an ended session with a conversation file. */
const canResume = (a) => a.state === 'ended' && a.transcriptPath != null;
const working = (a) => a.state === 'busy' || a.state === 'needsInput';
const basename = (p) => { const s = String(p).replace(/\/+$/, ''); const i = s.lastIndexOf('/'); return i >= 0 ? s.slice(i + 1) || s : s; };
const quotePath = (p) => (p.includes(' ') ? '"' + p + '"' : p);
const firstLine = (s) => { const t = String(s || '').slice(0, 300); const m = /^[^\r\n]*/.exec(t.replace(/^[\r\n]+/, '')); return m ? m[0] : ''; };

/** agent.cwd, else store.workingDirectory(of:) (asked of the main process: it may read the transcript). */
function useWorkingDirectory(agent) {
  const [wd, setWd] = useState(null);
  const sid = agent && agent.sessionId, cwd = agent && agent.cwd;
  useEffect(() => {
    if (!sid || cwd) return;
    let live = true;
    act('store.workingDirectory', sid).then((d) => { if (live) setWd(d || null); }, () => {});
    return () => { live = false; };
  }, [sid, cwd]);
  return cwd || wd;
}

// ── modules other agents write (import(), neutral placeholder until they load) ─────────────────────────────────────
const lazyMods = {};
function loadMod(file) {
  if (!lazyMods[file]) lazyMods[file] = import(`./${file}`).catch((e) => { delete lazyMods[file]; console.error(`ui/${file}`, e.message); return null; });
  return lazyMods[file];
}
function useLazy(file, name) {
  const [C, setC] = useState(null);
  useEffect(() => {
    let live = true, timer = 0;
    const tryLoad = () => loadMod(file).then((m) => {
      if (!live) return;
      if (m && typeof m[name] === 'function') setC(() => m[name]); else timer = setTimeout(tryLoad, 3000);   // still being written
    });
    tryLoad();
    return () => { live = false; clearTimeout(timer); };
  }, [file, name]);
  return C;
}
function Lazy({ file, name, placeholder = null, ...props }) {
  const C = useLazy(file, name);
  return C ? html`<${C} ...${props} />` : placeholder;
}
const panePlaceholder = html`<div class="pane-placeholder"></div>`;

// ── TeamDetailView ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One team: member list on the left, a friendly chat view + controls on the right.
 * props: team (snapshot Team: {name, members, lead …}; the loose sessions as a team without lead for isLoose), isLoose,
 * active (the tab on screen — hidden tabs stay built, so switching is instant).
 */
export function TeamDetailView({ team, isLoose = false, active = true }) {
  const s = useBoard();
  const [addingToLead, setAddingToLead] = useState(false);
  const members = team.members || [];
  const lead = isLoose ? null : members.find((m) => m.isLead) || null;
  const workers = members.filter((m) => !m.isLead);
  const belongs = (a) => (isLoose ? a.teamName == null || a.solo : a.teamName === team.name);
  const agent = (sid) => agentIn(s, sid);
  // this tab's own selection; mirrored to the store only while active. onAppear: the store's selection when it is
  // ours, else the lead (entering a team opens the lead's conversation right away)
  const [sel, setSel] = useState(() => {
    const st = s && s.selectedAgent, a = agent(st);
    if (a && belongs(a)) return st;
    const f = lead || members[0];
    return f ? f.sessionId : null;
  });
  /** Split view: [lead (left, big), teammates (right, top→bottom)]. A click on a teammate puts it beside the lead, a
   *  second click takes it out; with no teammate open the lead's full panel shows. No switch: the clicks are the control. */
  const [slots, setSlots] = useState([]);
  const [sideWidth, setSideWidth] = useAppStorage('ui.sidebarWidth', 240);
  const memberIds = members.map((m) => m.sessionId).join('|');

  /** Split slots: the lead is always in (left unless a drag swapped it), plus the teammates still in the team. */
  const fixSlots = (sl) => {
    if (isLoose || !lead) return [];
    const ids = new Set(workers.map((w) => w.sessionId));
    const out = sl.filter((x) => x === lead.sessionId || ids.has(x));
    if (!out.includes(lead.sessionId)) out.unshift(lead.sessionId);
    return out;
  };
  const cur = fixSlots(slots);
  const split = !isLoose && cur.length > 1;
  const selRef = useRef(sel); selRef.current = sel;

  /** Entering a team opens the lead's conversation right away. */
  const autoSelect = () => {
    const a = agent(selRef.current);
    if (!(a && belongs(a))) { const f = lead || members[0]; setSel(f ? f.sessionId : null); }
  };
  const toggleSlot = (sid) => {
    if (isLoose || !lead || sid === lead.sessionId) return;
    setSlots((prev) => {
      const sl = fixSlots(prev);
      if (!sl.includes(sid)) return [...sl, sid];
      const n = sl.filter((x) => x !== sid);
      if (n.length === 1) setSel(lead.sessionId);          // the last teammate left: back to the lead's full panel
      return n;
    });
  };
  /** Dropping pane `a` on pane `b`: they trade places (a teammate dropped on the left takes the big slot). */
  const swap = (a, b) => {
    const sl = fixSlots(slots);
    const i = sl.indexOf(a), j = sl.indexOf(b);
    if (a === b || i < 0 || j < 0) return;
    const n = [...sl]; n[i] = b; n[j] = a; setSlots(n);
  };

  const firstMembers = useRef(true);
  useEffect(() => { if (firstMembers.current) { firstMembers.current = false; return; } autoSelect(); }, [memberIds]);
  useEffect(() => { if (active && sel != null) act('store.setSelectedAgent', sel); }, [sel, active]);
  // chosen elsewhere (org chart, notification): follow if it is ours
  const storeSel = s ? s.selectedAgent : null;
  useEffect(() => {
    if (!active || !storeSel || storeSel === selRef.current) return;
    const a = agent(storeSel);
    if (!a || !belongs(a)) return;
    setSel(storeSel);
    if (!isLoose && lead && storeSel !== lead.sessionId && !cur.includes(storeSel)) setSlots([...cur, storeSel]);   // a teammate opens beside the lead
  }, [storeSel]);

  const rowFor = (a, opts = {}) => html`<${MemberRow} key=${a.sessionId} agent=${a} selected=${sel === a.sessionId} slotted=${opts.slotted}
      help=${opts.help} onClick=${() => { setSel(a.sessionId); if (opts.toggle) toggleSlot(a.sessionId); }} />`;
  let list;
  if (isLoose) {
    const live = members.filter((m) => m.state !== 'ended'), done = members.filter((m) => m.state === 'ended');
    list = html`
      <div class="side-section">${L('실행 중 %@', String(live.length))}</div>
      ${live.map((a) => rowFor(a))}
      ${done.length ? html`<div class="side-section">${L('종료됨 %@ — 다시 시작 가능', String(done.length))}</div>${done.map((a) => rowFor(a))}` : null}`;
  } else {
    list = html`
      ${lead ? html`<div class="side-section">${L('팀장')}</div>${rowFor(lead)}` : null}
      <div class="side-section">${L('팀원 %@명', String(workers.length))}</div>
      ${workers.map((a) => {
        // every click toggles the teammate beside the lead
        const on = cur.includes(a.sessionId);
        return rowFor(a, { slotted: on, toggle: true, help: on ? L('다시 누르면 분할 화면에서 뺍니다') : L('누르면 팀장 옆에 나란히 엽니다') });
      })}
      ${lead && canControl(lead) ? html`<${Button} kind="icon" class="side-add" onClick=${() => setAddingToLead(true)}>
        <${Label} icon="person.badge.plus" title=${L('팀원 추가…')} iconColor="var(--accent)" style=${{ color: 'var(--accent)' }} /><//>` : null}`;
  }

  const selAgent = agent(sel);
  let right;
  if (split) right = html`<${SplitArea} ids=${cur} s=${s} swap=${swap} empty=${emptyState()} />`;
  else if (selAgent && belongs(selAgent)) right = html`<${AgentPanel} key=${'panel'} agent=${selAgent} />`;
  else right = html`<div class="td-empty">${emptyState()}</div>`;

  function emptyState() {
    if (isLoose) return html`<${EmptyState} title=${L('개별 세션이 없습니다')} icon="person" description=${L('+ 새 세션으로 시작할 수 있습니다.')} />`;
    if (lead && canControl(lead)) {
      return html`<div class="td-empty-box">
        <${Icon} name="person.3" size=${40} class="fg-secondary" />
        <div class="t-title3">${L('아직 팀원이 없습니다')}</div>
        <div class="t-callout fg-secondary">${L("팀장 '%@'이(가) 팀원을 만듭니다. 이름·역할·모델·effort를 정해 주세요.", lead.name)}</div>
        <${Button} kind="raisedProminent" onClick=${() => setAddingToLead(true)}><${Label} icon="person.badge.plus" title=${L('팀원 추가')} /><//>
      </div>`;
    }
    if (lead && canResume(lead)) {
      return html`<div class="td-empty-box">
        <${Icon} name="moon.zzz" size=${40} class="fg-secondary" />
        <div class="t-title3">${L('팀장이 종료된 팀입니다')}</div>
        <div class="t-callout fg-secondary">${L('팀장을 다시 시작하면 대화를 이어가고 팀원도 새로 만들 수 있습니다.')}</div>
        <${Button} kind="raisedProminent" onClick=${() => { setSel(lead.sessionId); act('store.setSelectedAgent', lead.sessionId); }}>${L('팀장 선택')}<//>
      </div>`;
    }
    return html`<${EmptyState} title=${L('표시할 세션이 없습니다')} icon="person.crop.rectangle" />`;
  }

  return html`<div class="team-detail">
    <div class="area-box td-side" style=${{ width: `${sideWidth}px` }}>
      <div class="td-side-list">${list}</div>
    </div>
    <${ResizeGap} axis="horizontal" onDrag=${(d) => setSideWidth(Math.min(420, Math.max(200, Number(sideWidth) + d)))} />
    <div class="td-main">${right}</div>
    ${addingToLead && lead ? html`<${Lazy} file="sheets.js" name="AddTeammateSheet" sid=${lead.sessionId} agent=${lead} onClose=${() => setAddingToLead(false)} />` : null}
  </div>`;
}

/** The split view: the left pane big, the opened teammates stacked on the right. */
function SplitArea({ ids, s, swap, empty }) {
  const agents = ids.map((x) => agentIn(s, x)).filter(Boolean);
  if (!agents.length) return html`<div class="td-empty">${empty}</div>`;
  const [left, ...right] = agents;
  if (!right.length) return html`<${SplitPane} key=${left.sessionId} agent=${left} swap=${swap} />`;
  return html`<${ResizableSplit} axis="horizontal" count=${2} min=${320}>
    ${(i) => (i === 0 ? html`<${SplitPane} key=${left.sessionId} agent=${left} swap=${swap} />`
      // a new pane set starts again from equal parts
      : html`<${ResizableSplit} key=${right.map((a) => a.sessionId).join('')} axis="vertical" count=${right.length} min=${140}>
          ${(j) => html`<${SplitPane} key=${right[j].sessionId} agent=${right[j]} swap=${swap} />`}
        <//>`)}
  <//>`;
}

// ── MemberRow ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** One session in the side bar. Quick quit / archive on hover, each behind a short confirmation.
 *  props: agent, selected, slotted (open in the split view: accent bar on the left), help, onClick. */
/** The live CLI screen takes no drops itself: files dropped on it go to this session's composer (Swift: the enclosing
 *  view's .onDrop → .attachToComposer). */
function PaneDrop({ sid, children }) {
  const files = (e) => [...((e.dataTransfer && e.dataTransfer.types) || [])].includes('Files');
  return html`<div class="pane-drop" style=${{ display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0 }}
      onDragOver=${(e) => { if (files(e)) e.preventDefault(); }}
      onDrop=${(e) => {
        if (!files(e)) return;
        e.preventDefault();
        filePaths([...e.dataTransfer.files]).then((paths) => { if (paths.length) window.dispatchEvent(new CustomEvent('ab-attach-to-composer', { detail: { sid, paths } })); });
      }}>${children}</div>`;
}

export function MemberRow({ agent, selected, slotted, help, onClick }) {
  const [hover, setHover] = useState(false);
  const live = agent.state === 'busy' && agent.screen && agent.screen.verb
    ? agent.screen.verb + '…' + (agent.screen.elapsed ? ' ' + agent.screen.elapsed : '') : null;   // the CLI's verb and time go to the tooltip
  const stateColor = Fmt.stateColor(agent.state);
  const quickQuit = async (e) => {
    e.stopPropagation();
    if (await confirm(L("'%@' 세션을 종료할까요?", agent.name), L('보드에 남아 다시 시작할 수 있습니다.'))) act('store.quit', agent.sessionId, 'now');
  };
  const quickArchive = async (e) => {
    e.stopPropagation();
    if (await confirm(L("'%@' 세션을 보관할까요?", agent.name), L('세션을 끄고 보드에서 치웁니다. 보관함에서 복원할 수 있습니다.'))) act('store.archive', agent.sessionId, false);
  };
  /** An ended session: start it again from the row (same ID, its last model and effort). A teammate comes back as a
   *  loose session, so that is said first and confirmed. */
  const revive = async (e) => {
    e.stopPropagation();
    const mate = agent.teamName != null && !agent.isLead;
    const ok = await confirm(L("'%@' 세션을 다시 시작할까요?", agent.name),
      mate ? L('재시작하는 팀원은 팀과 분리된 개별 세션으로 열립니다. 팀장과의 연결은 복구되지 않습니다.') : L('이전 대화를 같은 세션 ID로 이어서 엽니다.'));
    if (!ok) return;
    const m = agent.model || '';
    const model = (ModelChoice.find((c) => c.raw === m) || ModelChoice.find((c) => m.startsWith(c.raw)) || { raw: 'claude-sonnet-5-5' }).raw;
    act('store.resume', agent.sessionId, model, EffortChoice.includes(agent.effort) ? agent.effort : 'medium');
  };
  return html`<div class=${'member-row' + (selected ? ' selected' : '') + (slotted ? ' slotted' : '')} title=${help}
      onMouseEnter=${() => setHover(true)} onMouseLeave=${() => setHover(false)} onClick=${onClick}>
    <${StateDot} state=${agent.state} />
    <div class="member-text">
      <div class="hstack" style=${{ gap: '4px', minWidth: 0 }}>
        ${agent.isSubagent ? html`<span class="sub-badge" title=${L('팀장이 Agent 도구로 띄운 서브에이전트 — 보기 전용')}>${L('서브')}</span>` : null}
        <span class="member-name one-line">${agent.name}</span>
      </div>
      <div class="hstack" style=${{ gap: '4px', minWidth: 0 }}>
        <span class="member-sub one-line" style=${{ opacity: agent.isEstimated ? 0.6 : 1 }}>${(agent.isBackgroundJob ? L('백그라운드 분기 · ') : '') + L('%@ · 출력 %@', agent.displayModel, Fmt.tokens((agent.tokens || {}).output || 0))}</span>
        ${agent.requestedModel != null || agent.requestedEffort != null ? html`<${Icon} name="hourglass" class="t-caption" color="var(--sys-orange)" help=${L('모델·effort 변경 적용 대기 중')} />` : null}
      </div>
    </div>
    <span class="spacer"></span>
    ${hover ? html`<span class="hstack member-quick" style=${{ gap: '2px' }}>
      ${agent.state !== 'ended' && agent.pid != null
        ? html`<${Button} kind="icon" help=${L('종료 (/exit)')} onClick=${quickQuit}><${Icon} name="power" /><//>`
        : agent.state === 'ended' && agent.transcriptPath != null && !agent.isSubagent
          ? html`<${Button} kind="icon" help=${L('다시 시작 — 같은 세션 ID로 이어서 엽니다')} onClick=${revive}><${Icon} name="power" /><//>`   // same place and size as 종료: power, then 보관
          : null}
      <${Button} kind="icon" help=${L('보관')} onClick=${quickArchive}><${Icon} name="archivebox" /><//>
    </span>` : null}
    <span class="state-capsule" style=${{ '--tint': stateColor, opacity: agent.stateUnconfirmed ? 0.7 : 1 }}
      title=${agent.stateUnconfirmed ? L('%@ — 상태 확인 중', Fmt.stateLabel(agent.state)) : live || ''}>${Fmt.stateLabel(agent.state)}</span>
  </div>`;
}

// ── AgentPanel ─────────────────────────────────────────────────────────────────────────────────────────────────────

let termSeq = 0;
/** One session: header, chat (the CLI's own screen, or the rebuilt chat), input line; terminal tabs beside it. */
export function AgentPanel({ agent }) {
  const s = useBoard();
  const sid = agent.sessionId;
  const [showThinking, setShowThinking] = useAppStorage('chat.showThinking', false);
  const [showTools, setShowTools] = useAppStorage('chat.expandTools', false);   // true = every tool call / result expanded
  const [termChat] = useAppStorage('ui.termChat', true);
  const [chatFont] = useAppStorage('ui.chatFont', 15);
  const [terms, setTerms] = useState([]);          // terminal tabs beside the chat
  const [termSel, setTermSel] = useState(null);
  const [headerWidth, setHeaderWidth] = useState(1000);
  const [addingTeammate, setAddingTeammate] = useState(false);
  const [resuming, setResuming] = useState(false);
  const acts = useAgentActions(agent);
  const cwd = useWorkingDirectory(agent);
  const entries = useChat(sid);
  const header = useRef(null);
  const termsRef = useRef(terms); termsRef.current = terms;

  useEffect(() => { act('store.canSpawnTeammates', sid); }, []);
  // another agent's CLI screen doesn't belong here
  const prevSid = useRef(sid);
  useEffect(() => {
    if (prevSid.current === sid) return;
    prevSid.current = sid;
    const kept = termsRef.current.filter((t) => t.owned);
    setTerms(kept);
    if (!kept.some((t) => t.id === termSel)) setTermSel(kept.length ? kept[kept.length - 1].id : null);
  }, [sid]);
  useEffect(() => () => { for (const t of termsRef.current) if (t.owned) act('store.closeTerminal', t.pane); }, []);
  // titles when they fit, icons (with tooltips) otherwise — measured
  useEffect(() => {
    const el = header.current; if (!el) return;
    const ro = new ResizeObserver(() => { const w = el.getBoundingClientRect().width; setHeaderWidth(w >= 1400 ? 1400 : w >= 1000 ? 1000 : 0); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /** The team leader's session alias (looked up at display time, so /rename shows at once). */
  const leadAlias = (() => {
    const t = ((s && s.teams) || []).find((x) => x.name === agent.teamName);
    const lead = (t && t.members.find((m) => m.isLead)) || (agent.isLead ? agent : null);
    const n = lead && lead.name;
    if (!n || n === 'team-lead' || n === 'main' || n === lead.sessionId.slice(0, 8)) return L('팀장');
    return n;
  })();

  const openNewTerminal = async () => {
    const p = await act('store.newTerminal', cwd);
    if (!p) return;
    const n = termsRef.current.filter((t) => t.owned).length + 1;
    const t = { id: ++termSeq, pane: p, title: L('셸 %@', String(n)), owned: true };
    setTerms([...termsRef.current, t]); setTermSel(t.id);
  };
  const openSessionTerminal = () => {
    const p = agent.tmuxPane; if (!p) return;
    const ex = termsRef.current.find((t) => t.pane === p);
    if (ex) { setTermSel(ex.id); return; }   // already open: just switch to it
    const t = { id: ++termSeq, pane: p, title: `${agent.name} CLI`, owned: false };
    setTerms([...termsRef.current, t]); setTermSel(t.id);
  };
  const closeTab = (t) => {
    if (t.owned) act('store.closeTerminal', t.pane);
    const cur = termsRef.current;
    const i = Math.max(0, cur.findIndex((x) => x.id === t.id));
    const rest = cur.filter((x) => x.id !== t.id);
    termsRef.current = rest;
    setTerms(rest);
    setTermSel((sel) => (sel === t.id ? (rest.length ? rest[Math.min(i, rest.length - 1)].id : null) : sel));
  };
  /** Hands a tab to the desktop's terminal app (the tmux session keeps running there) and removes it here. */
  const popOut = async (t) => {
    if (!(await act('store.openExternal', t.pane, t.title))) return;
    const rest = termsRef.current.filter((x) => x.id !== t.id);
    setTerms(rest);
    setTermSel((sel) => (sel === t.id ? (rest.length ? rest[rest.length - 1].id : null) : sel));
  };
  const curTerm = terms.find((t) => t.id === termSel) || terms[0];
  const live = agent.tmuxPane != null && agent.state !== 'ended';

  const terminalMenu = () => {
    const e = [{ header: L('앱 안에서 (탭으로 추가)') },
      { item: L('새 터미널 — 이 세션 폴더에서 깨끗한 셸'), action: openNewTerminal },
      { item: L('세션 터미널 — 이 세션의 실제 CLI 화면'), enabled: live, action: openSessionTerminal },
      '-', { header: L('기본 터미널 앱으로 (외부)') },
      { item: L('새 터미널 — 이 세션 폴더에서'), action: () => act('store.openExternalShell', cwd) },
      { item: L('세션 터미널 — 이 세션의 CLI 화면'), enabled: live, action: () => act('store.openTerminal', sid) }];
    if (termsRef.current.length) e.push('-', { item: L('터미널 탭 모두 닫기'), action: () => { for (const t of [...termsRef.current]) closeTab(t); } });
    return e;
  };
  const iconOnly = headerWidth < 1400;
  const actionButtons = html`<span class="hstack header-actions">
    <${LazyMenu} kind="raisedCompact" entries=${terminalMenu} help=${L('대화창 옆에 터미널을 엽니다')}><${Label} icon="terminal" title=${L('터미널')} iconOnly=${iconOnly} /><//>
    ${canQuit(agent) ? html`<${Button} kind="raisedCompact" onClick=${() => quitDialog(agent)} help=${L('종료 (/exit) — 세션을 끕니다. 보드에는 남아 다시 시작할 수 있습니다')}><${Label} icon="power" title=${L('종료')} iconOnly=${iconOnly} /><//>` : null}
    ${canResume(agent)
      ? html`<${Button} kind="raisedCompact" onClick=${() => setResuming(true)} help=${L('다시 시작')}><${Label} icon="power" title=${L('다시 시작')} iconOnly=${iconOnly} /><//>`
      : html`<${Button} kind="raisedCompact" disabled=${!agent.canReceiveInput} onClick=${() => setAddingTeammate(true)} help=${L('팀원 추가')}><${Label} icon="person.badge.plus" title=${L('팀원 추가')} iconOnly=${iconOnly} /><//>`}
    <${Button} kind="raisedCompact" onClick=${acts.askDelete} help=${L('보관 — 세션을 끄고 보드에서 치웁니다 (보관함에서 복원할 수 있습니다)')}><${Label} icon="archivebox" title=${L('보관')} iconOnly=${iconOnly} /><//>
  </span>`;

  const forceSend = async () => {
    const first = (agent.pendingCommands || [])[0]; if (!first) return;
    const v = await confirm(L("'%@' 에 %@ 을(를) 지금 보낼까요?", agent.name, first),
      L("질문이나 권한 요청이 떠 있으면 Enter가 첫 번째 선택(허용)을 확정할 수 있습니다. 'Esc 후 보내기'는 먼저 Esc로 프롬프트를 닫습니다(거절로 처리될 수 있음)."),
      [{ label: L('취소'), role: 'cancel' }, { label: L('Esc 후 보내기'), value: 'esc' }, { label: L('그대로 보내기'), value: 'asis' }]);
    if (v === 'esc' || v === 'asis') act('store.forceSendPending', sid, v);
  };

  const showPane = agent.tmuxPane != null && agent.state !== 'ended' && !fixtureOpt('transcriptChat');
  return html`<div class="agent-panel">
    <div class="area-box agent-main">
      <div class="agent-header" ref=${header}>
        <${StateDot} state=${agent.state} />
        <span class="agent-title one-line" title=${agent.teamAddress ? L('%@\n팀 주소: %@', agent.name, agent.teamAddress) : agent.name}>${agent.name}</span>
        <${Button} kind="icon" help=${L('이름 변경')} onClick=${acts.rename}><${Icon} name="pencil" /><//>
        ${agent.pendingName ? html`<span class="t-caption fg-orange one-line">${L("→ '%@' 대기 중", agent.pendingName)}</span>` : null}
        ${agent.isLead && !agent.solo ? html`<${Chip} text=${L('팀장')} tint="var(--accent)" />` : null}
        ${agent.overlay ? html`<${Chip} text=${'CLI: ' + overlayName(agent.overlay)} tint="var(--sys-orange)" help=${L('CLI 화면이 대화가 아니라 목록·선택 화면입니다. 입력은 CLI에서 Esc로 돌아온 뒤에 할 수 있습니다.')} />` : null}
        ${agent.isBackgroundJob && agent.jobId ? html`<${Chip} text=${L('백그라운드 작업 %@', agent.jobId)} tint="white" help=${L('claude agents에 실린 CLI 백그라운드 작업입니다 (← agents 화면으로 들어가면서 옮겨졌거나 --bg로 시작). 종료는 claude stop, 화면은 claude attach로 붙입니다.')} />` : null}
        <${ModelEffortChips} agent=${agent} detailed=${true} />
        <${Chip} text=${Fmt.stateLabel(agent.state)} tint=${Fmt.stateColor(agent.state)} style=${{ opacity: agent.stateUnconfirmed ? 0.7 : 1 }} help=${agent.stateUnconfirmed ? L('상태 확인 중') : undefined} />
        <${RemoteChip} agent=${agent} s=${s} />
        ${agent.state === 'needsInput' && (agent.pendingCommands || []).length ? html`<${Button} kind="raisedCompact" onClick=${forceSend} help=${L('질문 대기로 보이지만 대기 중인 명령을 지금 보냅니다')}>${L('그래도 보내기')}<//>` : null}
        ${(agent.pendingCommands || []).includes('/exit') ? html`<span class="t-caption fg-orange" style=${{ flex: '0 0 auto' }}>${L('작업 끝나면 종료')}</span>` : null}
        ${headerWidth >= 1000 && cwd ? html`<${Label} class="t-caption fg-secondary header-folder" icon="folder" title=${basename(cwd)} help=${cwd} />` : null}
        ${agent.tmuxPane == null && agent.state !== 'ended' ? html`<${Label} class="t-caption fg-secondary" style=${{ flex: '0 0 auto' }} icon="eye"
            title=${agent.entrypoint === 'claude-desktop' ? L('데스크톱 앱 세션 · 보기 전용') : L('보기 전용')}
            help=${agent.entrypoint === 'claude-desktop' ? L('Claude 데스크톱 앱의 세션이라 이 앱에서는 입력할 수 없습니다') : L('이 앱에서 입력할 수 없는 세션입니다')} />` : null}
        <span class="spacer" style=${{ minWidth: '8px' }}></span>
        ${!showPane ? html`
          <${Checkbox} class="t-caption" checked=${showTools} onChange=${setShowTools} label=${L('도구 펼침')} />
          <${Checkbox} class="t-caption" checked=${showThinking} onChange=${setShowThinking} label=${L('생각')} />` : null}
        ${actionButtons}
      </div>
      <div class="agent-chat">
        ${showPane
          ? html`<${PaneDrop} sid=${sid}><${Lazy} key=${sid} file="panechat.js" name="PaneChatView" pane=${agent.tmuxPane} sid=${sid} placeholder=${panePlaceholder} /></${PaneDrop}>`   // the CLI's own screen (conversation part)
          : html`<${ChatView} key=${sid} entries=${entries || []} showThinking=${showThinking} showTools=${showTools}
              agentName=${agent.name} userLabel=${agent.teamName != null && !agent.isLead && !agent.solo ? L('팀장 지시') : L('나')} leadName=${leadAlias}
              loading=${entries == null && agent.transcriptPath != null} sessionId=${sid} termStyle=${termChat} fontSize=${chatFont} />`}
      </div>
      <${ComposerBar} key=${sid} agent=${agent} openTerminal=${openSessionTerminal} />
    </div>
    ${terms.length ? html`<div class="area-box term-side">
      <div class="term-tabbar">
        <div class="term-tabs">
          ${terms.map((t) => {
            const on = t.id === (curTerm && curTerm.id);
            return html`<div key=${t.id} class=${'term-tab' + (on ? ' selected' : '')} onClick=${() => setTermSel(t.id)}
                onContextMenu=${(e) => { e.preventDefault(); showMenu([{ item: L('기본 터미널 앱으로 내보내기'), action: () => popOut(t) }, { item: L('닫기'), action: () => closeTab(t) }], e); }}>
              <${Icon} name=${t.owned ? 'apple.terminal' : 'sparkles'} class="t-caption" />
              <span class="one-line">${t.title}</span>
              <button type="button" class="btn btn-plain term-tab-close" title=${t.owned ? L('닫기 (셸 종료)') : L('닫기 (세션은 계속 실행)')}
                onClick=${(e) => { e.stopPropagation(); closeTab(t); }}><${Icon} name="xmark" size=${9} strokeWidth=${3} /></button>
            </div>`;
          })}
        </div>
        <${LazyMenu} kind="raisedCompact" help=${L('터미널 탭 추가')} entries=${() => [
          { item: L('새 터미널 (셸)'), action: openNewTerminal },
          { item: L('세션 터미널 (CLI 화면)'), enabled: !(agent.tmuxPane == null || agent.state === 'ended'), action: openSessionTerminal }]}><${Icon} name="plus" /><//>
        ${curTerm ? html`<${Button} kind="raisedCompact" help=${L('이 탭을 기본 터미널 앱으로 내보내기 (앱 밖에서 계속 실행)')} onClick=${() => popOut(curTerm)}><${Icon} name="arrow.up.forward.app" /><//>` : null}
      </div>
      ${curTerm ? html`<${Lazy} key=${curTerm.id} file="panechat.js" name="TerminalPanel" pane=${curTerm.pane} title=${curTerm.title} fitWindow=${curTerm.owned}
          onClose=${() => closeTab(curTerm)} placeholder=${panePlaceholder} />` : null}
    </div>` : null}
    ${acts.sheets}
    ${addingTeammate ? html`<${Lazy} file="sheets.js" name="AddTeammateSheet" sid=${sid} agent=${agent} onClose=${() => setAddingTeammate(false)} />` : null}
    ${resuming ? html`<${Lazy} file="sheets.js" name="ResumeSheet" sid=${sid} agent=${agent} onClose=${() => setResuming(false)} />` : null}
  </div>`;
}

/** The model and effort chips with their menus (header and split pane). `detailed`: the header's tooltips. */
function ModelEffortChips({ agent, detailed }) {
  const sid = agent.sessionId;
  return html`
    <${LazyMenu} class="chip-menu" disabled=${!agent.canReceiveInput}
        help=${detailed && agent.requestedModel != null ? L('다음 응답부터 적용됩니다') : L('모델 변경')}
        entries=${() => ModelChoice.map((m) => ({ item: m.label + (agent.model === m.raw ? ' ✓' : ''), action: () => act('store.setModel', m.raw, sid) }))}>
      <${Chip} tint="white" text=${agent.displayModel + (agent.requestedModel != null ? ' ⏳' : '')} style=${{ opacity: agent.modelIsGuess ? 0.55 : 1 }} />
    <//>
    <${LazyMenu} class="chip-menu" disabled=${!agent.canReceiveInput}
        help=${detailed && agent.requestedEffort != null ? L('다음 응답부터 적용됩니다') : L('effort 변경')}
        entries=${() => EffortChoice.map((e) => ({ item: e + (agent.effort === e ? ' ✓' : ''), action: () => act('store.setEffort', e, sid) }))}>
      <${Chip} tint="white" text=${`effort ${agent.effort || '?'}` + (agent.requestedEffort != null ? ' ⏳' : '')} />
    <//>`;
}

// ── ComposerBar ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The drop target look: light blue, fine dashes, a faint white fill. */
export function DropHint({ on }) {
  return html`<div class="drop-hint" style=${{ opacity: on ? 1 : 0 }}></div>`;
}

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'heic', 'webp', 'tiff'];
const extOf = (p) => { const b = basename(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i + 1).toLowerCase() : ''; };
/** The files of the chat box: thumbnails for images, a document icon otherwise; × removes one. props: paths, onRemove(p). */
export function AttachmentStrip({ paths, onRemove }) {
  return html`<div class="attach-strip">
    ${paths.map((p) => html`<div key=${p} class="attach-item" title=${p}>
      ${IMAGE_EXT.includes(extOf(p)) ? html`<img class="attach-thumb" src=${'file://' + encodeURI(p)} alt="" onError=${(e) => { e.currentTarget.replaceWith(Object.assign(document.createElement('span'), { className: 'attach-thumb attach-missing' })); }} />` : html`<${Icon} name="doc.text" size=${22} class="fg-secondary" />`}
      <span class="t-caption one-line" style=${{ maxWidth: '180px' }}>${basename(p)}</span>
      <button type="button" class="btn btn-plain fg-secondary" onClick=${() => onRemove(p)}><${Icon} name="xmark.circle.fill" /></button>
    </div>`)}
  </div>`;
}

/** Files from a drop / paste: their paths (window.api.pathOf); an image with no file behind it is saved as PNG first. */
async function filePaths(files) {
  const out = [];
  for (const f of files) {
    let p = '';
    try { p = window.api && window.api.pathOf ? window.api.pathOf(f) : ''; } catch { p = ''; }
    if (p) { out.push(p); continue; }
    if (f.type && f.type.startsWith('image/')) {
      const data = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => res(null); r.readAsDataURL(f); });
      const saved = data ? await act('attach.save', data) : null;
      if (saved) out.push(saved);
    }
  }
  return out;
}

const historyShared = { stamp: null, completer: new HistoryCompleter() };   // one completer for every composer

/**
 * The input line with its own state (draft, attachments, slash palette): a keystroke redraws only this view, never the
 * chat above it. props: agent, openTerminal (a terminal-only command was sent: show the CLI screen).
 */
export function ComposerBar({ agent, openTerminal }) {
  const s = useBoard();
  const sid = agent.sessionId;
  const [draft, setDraftState] = useState('');
  const [attachments, setAttachState] = useState([]);
  const [dropping, setDropping] = useState(false);
  const [refused, setRefused] = useState(null);     // why the last send did not go through, shown at the box
  const [localSending, setLocalSending] = useState(false);
  const [, tick] = useState(0);
  const redraw = () => tick((n) => n + 1);
  const ctl = useRef(null);
  if (!ctl.current) {
    ctl.current = {
      slash: new SlashController(),
      mention: new MentionController((cwd) => act('suggest.files', cwd), () => redraw()),
      hist: new HistoryNav(),
    };
  }
  const { slash, mention, hist } = ctl.current;
  const draftRef = useRef(draft), attRef = useRef(attachments), agentRef = useRef(agent);
  agentRef.current = agent;
  const setDraft = (t) => {
    if (t === draftRef.current) return;
    draftRef.current = t; setDraftState(t);
    hist.noteEdit(t);
    slash.draftChanged(); mention.index = 0;        // the palettes start again at the top
  };
  const setAttachments = (a) => { attRef.current = a; setAttachState(a); };
  const addAttachments = (paths) => { const cur = attRef.current; setAttachments([...cur, ...paths.filter((p) => !cur.includes(p))]); };
  const cwd = useWorkingDirectory(agent);
  const entries = useChat(sid) || [];

  // each agent keeps its own half-typed text and attachments (the bar is recreated per agent: key = sessionId)
  useEffect(() => {
    act('store.getDraft', sid).then((d) => {
      if (d && !draftRef.current && !attRef.current.length) { setDraft(d.text || ''); setAttachments(d.paths || []); }
    }, () => {});
    return () => { act('store.setDraft', sid, draftRef.current, attRef.current); };
  }, []);
  const prepareHistory = () => act('suggest.prepare', sid, cwd, historyShared.stamp).then((r) => {
    if (!r) return;
    if (r.items) { historyShared.completer.set(r.items); historyShared.stamp = r.stamp; }
    hist.items = r.nav || [];
  }, () => {});
  useEffect(() => {
    act('slash.load', cwd).then((items) => { slash.setCustom(items); redraw(); }, () => {});
    mention.reload(cwd);
    prepareHistory();
  }, [cwd]);
  // a turn just ended: my new prompt is in the history file now
  const prevState = useRef(agent.state);
  useEffect(() => {
    if (prevState.current === 'busy' && agent.state !== 'busy') prepareHistory();
    prevState.current = agent.state;
  }, [agent.state]);
  // copied while the file is still there (a screenshot's temp file goes soon)
  useEffect(() => {
    if (!attachments.length) return;
    let live = true;
    act('attach.staged', attachments).then((st) => {
      if (live && st && JSON.stringify(st) !== JSON.stringify(attRef.current) && JSON.stringify(attachments) === JSON.stringify(attRef.current)) setAttachments(st);
    }, () => {});
    return () => { live = false; };
  }, [attachments]);
  // queued messages taken back from the CLI: into this box to edit or delete. A line of file paths (the attachments it
  // was sent with) goes back into the strip.
  const pulledGen = useRef(s && s.pulled ? s.pulled.gen : 0);
  useEffect(() => {
    const q = s && s.pulled;
    if (!q || q.gen === pulledGen.current) return;
    pulledGen.current = q.gen;
    if (q.sid !== sid) return;
    (async () => {
      const cand = [];
      for (const t of q.texts) for (const l of t.split('\n')) {
        const parts = l.split(' ').filter((x) => x);
        if (parts.length && parts.every((x) => x.startsWith('/'))) cand.push(...parts);
      }
      const there = await PathLinks.exists([...new Set(cand)]);
      const texts = [], files = [];
      for (const t of q.texts) {
        const keep = [];
        for (const l of t.split('\n')) {
          const parts = l.split(' ').filter((x) => x);
          if (parts.length && parts.every((x) => x.startsWith('/') && there.has(x))) files.push(...parts);
          else keep.push(l);
        }
        texts.push(keep.join('\n').trim());
      }
      const back = texts.filter((x) => x).join('\n\n');
      setDraft(draftRef.current ? back + '\n' + draftRef.current : back);
      const cur = attRef.current;
      setAttachments([...files.filter((f) => !cur.includes(f)), ...cur]);
      setRefused(L('대기 중이던 메시지 %@개를 입력창으로 가져왔습니다. 고치거나 지운 뒤 보내세요.', String(q.texts.length)));
    })();
  }, [s && s.pulled && s.pulled.gen]);
  // the CLI did not take the last message: back into the box (ahead of anything typed since)
  const bounceGen = useRef(s && s.bounce ? s.bounce.gen : 0);
  useEffect(() => {
    const b = s && s.bounce;
    if (!b || b.gen === bounceGen.current) return;
    bounceGen.current = b.gen;
    if (b.sid !== sid) return;
    act('store.takeLastSentDraft', sid).then((d) => {
      if (!d) return;
      setDraft(draftRef.current ? d.text + '\n' + draftRef.current : d.text);
      const files = d.paths || [];
      setAttachments([...files, ...attRef.current.filter((p) => !files.includes(p))]);
      setRefused(L('전달되지 않아 되돌려 놓았습니다. 다시 보내 주세요.'));
    }, () => {});
  }, [s && s.bounce && s.bounce.gen]);
  // files dropped on the chat above
  useEffect(() => {
    const f = (e) => { const d = e.detail || {}; if (d.sid === sid && agentRef.current.canReceiveInput && d.paths) addAttachments(d.paths); };
    window.addEventListener('ab-attach-to-composer', f);
    return () => window.removeEventListener('ab-attach-to-composer', f);
  }, []);
  // shown here even with notices off: a send that silently did nothing looked like a broken box
  useEffect(() => {
    if (!refused) return;
    const why = refused;
    const id = setTimeout(() => setRefused((r) => (r === why ? null : r)), 15000);
    return () => clearTimeout(id);
  }, [refused]);

  /** Grey text Tab would fill: only the CLI's own prediction (its model wrote it for this conversation); no history /
   *  rule guesses. On an empty box the whole suggestion; while typing, when it starts the same way. */
  const ghost = (() => {
    if (!agent.canReceiveInput || hist.active || slash.items(draft).length || mention.items(draft).length) return null;
    const cli = agent.state === 'idle' && agent.screen ? agent.screen.suggestion : null;
    if (!cli) return null;
    if (!draft) return cli;
    if (cli.length > draft.length && cli.toLowerCase().startsWith(draft.toLowerCase())) return cli;
    return null;
  })();
  /** Newest tool call since my last message ("Bash · ls -la"): what the agent is doing right now. */
  const currentTool = (() => {
    if (agent.state !== 'busy') return null;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.role === 'user' && e.toolName !== '전송 중') return null;
      if (e.role === 'tool' && e.toolName !== '결과') { const f = firstLine(e.text); return (e.toolName || 'tool') + (f ? ' · ' + f : ''); }
    }
    return null;
  })();
  const busy = ((s && s.sending) || []).includes(sid) || localSending;

  const sendingRef = useRef(false);
  const refusedNotice = async () => {
    let n = null;
    try { const st = await act('store.getState'); n = st && st.notice; } catch { /* none */ }
    return n || L('보내지 못했습니다. CLI 화면을 확인해 주세요.');
  };
  const send = async () => {
    // the previous message is still going in (the CLI reads pasted images first): an Enter now would be lost, so it waits
    const st = board();
    if (((st && st.sending) || []).includes(sid) || sendingRef.current) return;
    const a = agentRef.current;
    let t = draftRef.current.trim();
    const atts = attRef.current;
    if (!t && !atts.length) return;
    if (t.startsWith('/')) {
      const typed = draftRef.current, kept = atts;
      if (t === '/exit' && canQuit(a)) { setDraft(''); quitDialog(a); return; }   // same confirmation as the header button
      // commands the board handles itself (/model, /effort, /rename …) take no files: those stay in the strip
      if (routeAction(t)) { setDraft(''); act('slash.route', t, sid); return; }
      // a command the CLI runs (/goal …, custom commands): files ride along as paths after its argument, as in a
      // normal message (they were dropped before, so "/goal … + screenshot" lost the screenshot)
      if (atts.length) { t += ' ' + atts.map(quotePath).join(' '); setAttachments([]); }
      setDraft(''); setRefused(null);
      sendingRef.current = true; setLocalSending(true);
      const ok = await act('store.send', t, sid);
      sendingRef.current = false; setLocalSending(false);
      if (!ok) { setDraft(typed); setAttachments(kept); setRefused(await refusedNotice()); return; }
      if (isTerminalOnly(t) && openTerminal) openTerminal();
      return;
    }
    if (atts.length) {
      // bare paths after the text: the CLI turns image paths into "[Image #n]" chips and Claude reads the rest. (A
      // "[첨부 파일]" header with "- path" lines left a bare "-" per image in the CLI's own screen.)
      t = (t || L('첨부한 파일을 확인해 주세요.')) + '\n' + atts.map(quotePath).join(' ');
    }
    const kept = atts, typed = draftRef.current;
    act('store.setLastSentDraft', sid, typed, kept);
    setDraft(''); setAttachments([]); setRefused(null);                  // clear first: the box responds instantly
    sendingRef.current = true; setLocalSending(true);
    const ok = await act('store.send', t, sid);
    sendingRef.current = false; setLocalSending(false);
    if (!ok) {
      // refused (CLI list on screen, someone typing there): put back what was typed and attached, as it was (the text
      // with the file paths already appended used to come back, so the paths showed up in the box)
      setDraft(typed); setAttachments(kept);
      setRefused(await refusedNotice());
    }
  };

  /** Keys the box handles before the text field sees them, in the CLI's order: the open question, the "/" and "@"
   *  palettes, Tab (fill the suggestion), Shift+Tab (permission mode), Esc (interrupt / cancel), ↑↓ (history). */
  const handleKey = (e) => {
    const a = agentRef.current, d = draftRef.current;
    const st = board();
    if (a.state === 'needsInput' && a.prompt && !d.startsWith('/')
      && PromptCard.handleKey(e, { optionCount: a.prompt.options.length, sending: ((st && st.promptSending) || []).includes(sid), composerEmpty: !d,
        onChoose: (i) => act('store.answerPrompt', sid, i), onCancel: () => act('store.cancelPrompt', sid) })) return true;
    const key = ['ArrowDown', 'ArrowUp', 'Escape', 'Tab', 'Enter'].includes(e.key) ? e.key : null;
    if (key) {
      const r = slash.handle(key, e.shiftKey, d);
      if (r.consumed) { if (r.draft !== d) setDraft(r.draft); redraw(); if (r.send) send(); return true; }
      const m = mention.handle(key, e.shiftKey, d);
      if (m.consumed) { if (m.draft !== d) setDraft(m.draft); redraw(); return true; }
    }
    const mods = (e.metaKey ? 1 : 0) + (e.ctrlKey ? 2 : 0) + (e.altKey ? 4 : 0) + (e.shiftKey ? 8 : 0);
    switch (e.key) {
      case 'Tab':
        if (mods === 8) { act('store.cycleMode', sid); return true; }
        if (mods) return false;
        if (ghost) { setDraft(ghost); return true; }
        return true;                                                    // nothing to fill: keep the focus here, like the CLI
      case 'Escape':
        if (hist.active) { setDraft(hist.cancel(d).draft); return true; }
        if (working(a) && a.canReceiveInput) { act('store.interrupt', sid); return true; }
        return false;
      case 'ArrowUp': {                                                 // history when the box is empty or already browsing
        if (mods || !(hist.active || !d)) return false;
        const r = hist.up(d);
        if (r.draft !== d) { draftRef.current = r.draft; setDraftState(r.draft); slash.draftChanged(); mention.index = 0; }
        return r.handled;
      }
      case 'ArrowDown': {
        if (mods || !hist.active) return false;
        const r = hist.down(d);
        if (r.draft !== d) { draftRef.current = r.draft; setDraftState(r.draft); slash.draftChanged(); mention.index = 0; }
        return r.handled;
      }
      default:
        // Ctrl/⌘+Enter sends (the send button's shortcut)
        return false;
    }
  };
  const pickFiles = async () => {
    const p = await act('platform.pickFiles');
    if (p && p.length) addAttachments(p);
  };
  /** A clipboard image (screenshot) or copied files become attachments; text pastes as usual. */
  const onPaste = (e) => {
    const cd = e.clipboardData;
    if (!cd) return false;
    const files = [...(cd.files || [])];
    if (files.length) { filePaths(files).then((p) => { if (p.length) addAttachments(p); }); return true; }
    const types = [...(cd.types || [])];
    if (types.includes('text/plain')) return false;
    act('attach.pastedImage').then((p) => { if (p) addAttachments([p]); }, () => {});
    return true;
  };
  const dropFiles = (files) => { if (agentRef.current.canReceiveInput) filePaths(files).then((p) => { if (p.length) addAttachments(p); }); };

  const empty = !draft.trim() && !attachments.length;
  const enabled = agent.canReceiveInput;
  const placeholder = enabled ? L('메시지 입력 — Enter 전송 · ⇧Enter 줄바꿈 · / 명령')
    : agent.overlay ? L('입력 불가: CLI가 %@ 화면입니다 — CLI에서 Esc로 대화로 돌아오면 입력할 수 있습니다', overlayName(agent.overlay))
      : L('입력 불가: 종료됐거나 이 앱에서 입력할 수 없는 세션');
  const queued = agent.tmuxPane != null && agent.state !== 'ended' ? agent.queued || 0 : entries.filter((e) => e.toolName === '전송 중').length;
  const promptSending = ((s && s.promptSending) || []).includes(sid);
  const hasFiles = (dt) => dt && [...(dt.types || [])].includes('Files');

  return html`<div class="composer-bar"
      onDragOver=${(e) => { if (hasFiles(e.dataTransfer) && agent.canReceiveInput) { e.preventDefault(); setDropping(true); } }}
      onDragLeave=${(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDropping(false); }}
      onDrop=${(e) => { setDropping(false); if (!hasFiles(e.dataTransfer)) return; e.preventDefault(); dropFiles([...e.dataTransfer.files]); }}>
    <div class="composer-column">
      <div class="composer-palettes">
        <${SlashPaletteView} ctl=${slash} draft=${draft} onPick=${(c) => { const r = slash.pick(c, true); setDraft(r.draft); redraw(); if (r.send) send(); }} />
        <${MentionPaletteView} ctl=${mention} draft=${draft} onPick=${(p) => { setDraft(mention.pick(p, draftRef.current)); redraw(); }} />
      </div>
      <${TurnStatusBar} agent=${agent} lastTool=${currentTool} queued=${queued}
        onInterrupt=${() => act('store.interrupt', sid)} onPushQueue=${() => act('store.pushQueue', sid)} onPullQueue=${() => act('store.pullQueue', sid)} />
      ${agent.state === 'needsInput' && agent.prompt ? html`<div class="prompt-in"><${PromptCard} title=${agent.prompt.title} detail=${agent.prompt.detail} preview=${agent.prompt.preview}
          options=${agent.prompt.options || []} cursor=${agent.prompt.cursor} sending=${promptSending}
          onChoose=${(i) => act('store.answerPrompt', sid, i)} onCancel=${() => act('store.cancelPrompt', sid)} /></div>` : null}
      ${attachments.length ? html`<${AttachmentStrip} paths=${attachments} onRemove=${(p) => setAttachments(attRef.current.filter((x) => x !== p))} />` : null}
      ${refused ? html`<div class="hstack refused-row">
        <${Label} class="t-callout" icon="exclamationmark.triangle.fill" iconColor="var(--attention)" style=${{ color: 'var(--attention)', whiteSpace: 'normal' }} title=${refused} />
        ${agent.tmuxPane != null && agent.overlay == null ? html`<${Button} kind="raisedCompact"
            help=${L('CLI 입력창에 남은 글을 지웁니다 (Ctrl+U). 실행 중인 작업은 멈추지 않습니다.')}
            onClick=${() => { act('store.clearCLIInput', sid); setRefused(null); }}>${L('CLI 입력창 비우기')}<//>` : null}
      </div>` : null}
      <div class="composer-row">
        <${Button} kind="icon" class="composer-clip" disabled=${!enabled} onClick=${pickFiles}
          help=${L('파일 첨부 (창에 끌어다 놓거나 ⌘V로 스크린샷 붙여넣기도 됩니다)')}><${Icon} name="paperclip" size=${16} /><//>
        <div class="composer-field-wrap">
          <${Composer} text=${draft} onText=${setDraft} placeholder=${placeholder} enabled=${enabled} onSend=${send}
            onPaste=${onPaste} keyHook=${(e) => { const r = handleKey(e); if (!r && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { send(); return true; } return r; }}
            ghost=${ghost} onDropFiles=${dropFiles} onDragOver=${(over) => { if (agent.canReceiveInput) setDropping(over); }} />
        </div>
        <button type="button" class=${'send-btn' + (empty || busy ? ' idle' : '')} disabled=${!enabled || empty || busy}
            title=${busy ? L('앞 메시지를 CLI에 넣는 중입니다 (첨부 이미지 처리 중). 끝나면 다시 보낼 수 있습니다.') : L('보내기 (Enter, ⌘↩)')} onClick=${send}>
          ${busy ? html`<${ChaseRing} size=${14} />` : html`<${Icon} name="arrow.up" size=${15} strokeWidth=${3} />`}
        </button>
        ${agent.state === 'busy' ? html`<button type="button" class="stop-btn" title=${L('지금 하던 작업만 멈춥니다 (Esc)')} onClick=${() => act('store.interrupt', sid)}>
          <${Icon} name="stop.fill" size=${12} /></button>` : null}
      </div>
      <${ComposerFooter} agent=${agent} ghost=${ghost} pendingCommands=${(agent.pendingCommands || []).length} />
    </div>
    <${DropHint} on=${dropping} />
  </div>`;
}

// ── ChatView ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Rows from the n-th newest user message to the end (long tool-heavy turns: at most ~12 rows each). */
function rowsFor(n, v) {
  let seen = 0;
  for (let i = v.length - 1; i >= 0; i--) {
    if (v[i].role !== 'user' || v[i].text.startsWith('/')) continue;
    seen += 1;
    if (seen === n) return Math.min(Math.max(v.length - i, 12), n * 12);
  }
  return Math.min(v.length, n * 12);
}
/** The answer's text: the assistant's words since my last message (tools and thinking left out). */
export function answerText(rows, i) {
  const parts = [];
  for (let k = i; k >= 0 && rows[k].role !== 'user'; k--) if (rows[k].role === 'assistant' && !rows[k].isThinking) parts.push(rows[k].text);
  return parts.reverse().join('\n\n');
}
/** A user slash command or an auto ⚙ line: the following ⎿ result reads as part of the same group. */
const isCommand = (e) => (e.role === 'user' && e.text.startsWith('/')) || e.role === 'system';
/** Consecutive messages from the same speaker read as one group (no repeated name/avatar). */
function sameSpeaker(a, b) {
  if (a.role !== b.role) return false;
  switch (b.role) {
    case 'assistant': return true;
    case 'user': return !b.text.startsWith('/');
    case 'peer': return a.toolName === b.toolName;
    default: return false;
  }
}
const nearBottom = (el) => el.scrollHeight - (el.scrollTop + el.clientHeight) < 80;

/**
 * The rebuilt conversation (sessions without a live CLI screen): newest few turns, older ones when scrolled to the top.
 * props: entries, showThinking, showTools, agentName, userLabel, leadName, loading, sessionId, termStyle (one
 * monospaced line per row like the CLI, vs bubbles with Markdown blocks), fontSize.
 */
export function ChatView({ entries, showThinking, showTools, agentName = L('에이전트'), userLabel = L('나'), leadName = L('팀장'), loading, sessionId = '', termStyle = true, fontSize = 15 }) {
  const [turns, setTurns] = useState(3);    // newest N of my turns only (fast to lay out); scrolling to the top brings older ones
  const [extra, setExtra] = useState(0);    // rows that arrived while reading history (keeps the window from sliding)
  const scroller = useRef(null), content = useRef(null);
  const pinned = useRef(true);              // the user is at the bottom: keep following new / growing content
  const wheelAt = useRef(0), dragging = useRef(false), anchor = useRef(null);
  const visible = useMemo(() => entries.filter((e) => (e.isThinking ? showThinking : true)), [entries, showThinking]);
  const shown = Math.min(visible.length, rowsFor(turns, visible) + extra);
  const rows = visible.slice(visible.length - shown);
  const toBottom = () => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight; };
  const setPinned = (p) => {
    if (pinned.current === p) return;
    pinned.current = p;
    if (p && (turns !== 3 || extra !== 0)) { setTurns(3); setExtra(0); }
    act('store.holdOlderRows', !p, sessionId);   // reading history: the reader keeps rows past its cap until we are back at the bottom
  };
  const loadOlder = () => {
    anchor.current = rows.length ? rows[0].id : null;
    setTurns((t) => t + 4);
  };
  useLayoutEffect(() => {
    const el = scroller.current; if (!el) return;
    if (anchor.current) {                       // keep the reading position: the old first row at the top
      const a = el.querySelector(`[data-row="${CSS.escape(String(anchor.current))}"]`);
      anchor.current = null;
      if (a) { el.scrollTop = a.offsetTop - 18; return; }
    }
    if (pinned.current) toBottom();
  });
  // new rows, a growing last bubble, or a rewrap after a width change: stay at the bottom
  useEffect(() => {
    const ro = new ResizeObserver(() => { if (pinned.current) toBottom(); });
    if (content.current) ro.observe(content.current);
    if (scroller.current) ro.observe(scroller.current);
    return () => { ro.disconnect(); act('store.holdOlderRows', false, sessionId); };
  }, []);
  // reading older history: new rows must not slide the window under the reader
  const prevCount = useRef(visible.length);
  useEffect(() => {
    if (!pinned.current && visible.length > prevCount.current) setExtra((x) => x + visible.length - prevCount.current);
    prevCount.current = visible.length;
  }, [visible.length]);
  // follow when at the bottom, or right after the user sent something; app-sent commands do not scroll
  const lastId = visible.length ? visible[visible.length - 1].id : null;
  useEffect(() => {
    const st = board();
    if (pinned.current || (st && st.lastSentAt && Date.now() - st.lastSentAt < 2000)) { setPinned(true); toBottom(); }
  }, [lastId]);
  const onScroll = () => {
    const el = scroller.current; if (!el) return;
    setPinned(nearBottom(el));
    // scrolled up to the top: bring the next few older turns, keeping the reading position
    if (el.scrollTop < 40 && el.scrollHeight > el.clientHeight && (dragging.current || Date.now() - wheelAt.current < 1000) && !pinned.current
      && visible.length > shown) loadOlder();
  };
  // a path in the chat opens its folder (PathLinks); files dropped here go to this session's composer
  const onDrop = (e) => {
    if (![...(e.dataTransfer.types || [])].includes('Files')) return;
    e.preventDefault();
    filePaths([...e.dataTransfer.files]).then((paths) => { if (paths.length) window.dispatchEvent(new CustomEvent('ab-attach-to-composer', { detail: { sid: sessionId, paths } })); });
  };
  return html`<div class="chat-scroll" ref=${scroller} onScroll=${onScroll}
      onWheel=${(e) => { if (e.deltaY < 0) { wheelAt.current = Date.now(); if (pinned.current && scroller.current && scroller.current.scrollTop > 0) { /* upward wheel unpins in onScroll */ } } }}
      onMouseDown=${() => { dragging.current = true; }} onMouseUp=${() => { dragging.current = false; }}
      onDragOver=${(e) => { if ([...(e.dataTransfer.types || [])].includes('Files')) e.preventDefault(); }} onDrop=${onDrop}>
    <div class="chat-column" ref=${content} style=${{ '--chat-fs': `${fontSize}px` }}>
      ${!visible.length ? html`<div class="fg-secondary chat-none">${loading ? L('대화 기록을 불러오는 중…') : L('대화 기록이 없습니다.')}</div>` : null}
      ${visible.length > shown ? html`<div class="chat-older"><${Button} kind="raisedCompact" onClick=${loadOlder}>${L('이전 대화 더 보기 (%@줄 남음)', String(visible.length - shown))}<//></div>` : null}
      ${rows.map((e, i) => {
        const cont = i > 0 && sameSpeaker(rows[i - 1], e);
        let pad;
        if (termStyle) pad = i === 0 ? 0 : e.role === 'tool' || e.role === 'system' ? 2 : 12;
        else pad = i === 0 ? 0 : e.role === 'system' && isCommand(rows[i - 1]) ? 3 : e.role === 'tool' && rows[i - 1].role === 'tool' && !showTools ? 4 : cont ? 8 : 22;
        const peerName = (String(e.toolName || L('팀원')).split('@')[0]) || L('팀원');
        // end of an answer (my next message follows, or it is the newest row): copy / pass it to another agent
        const endOfAnswer = e.role === 'assistant' && !e.isThinking && (i === rows.length - 1 || rows[i + 1].role === 'user');
        return html`<div key=${e.id} data-row=${e.id} style=${{ paddingTop: `${pad}px` }}>
          ${termStyle
            ? html`<${TermLine} entry=${e} name=${e.role === 'peer' ? peerName : agentName} expandAll=${showTools} size=${fontSize} />`
            : html`<${Bubble} entry=${e} agentName=${agentName} userLabel=${userLabel} leadName=${leadName} expandAll=${showTools} showHeader=${!cont} />`}
          ${endOfAnswer ? html`<${AnswerActions} text=${() => answerText(rows, i)} from=${agentName} fromId=${sessionId} />` : null}
        </div>`;
      })}
      <div style=${{ height: '1px' }}></div>
    </div>
  </div>`;
}

// ── Bubble ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const isLeadAddress = (a) => { const n = String(a || '').split('@')[0]; return n === 'team-lead' || n === 'main' || n === 'lead'; };

/** One chat row in the bubble style. props: entry, agentName, userLabel, leadName, expandAll, showHeader. */
export function Bubble({ entry, agentName = L('에이전트'), userLabel = L('나'), leadName = L('팀장'), expandAll, showHeader = true }) {
  const [chatFont] = useAppStorage('ui.chatFont', 15);
  const [expanded, setExpanded] = useState(!!entry.isError);
  usePathLinks();
  const e = entry;
  if (e.role === 'system') {
    // slash-command output: a small ⎿ line (stderr in the warning colour)
    return html`<div class="sys-line" style=${{ fontSize: `${chatFont - 3}px` }}>
      <span class="fg-tertiary">${e.toolName === 'auto' ? '⚙' : '⎿'}</span>
      <span class="selectable" style=${{ color: e.toolName === 'stderr' ? 'var(--sys-orange)' : 'var(--secondary)', whiteSpace: 'pre-wrap' }}>${e.text}</span>
      <span style=${{ minWidth: '60px', flex: '1 1 auto' }}></span>
    </div>`;
  }
  if (e.role === 'tool') {
    // a tool call or result folded to one line (tool name + first argument); a click opens the details
    const first = firstLine(e.text);
    const isResult = e.toolName === '결과';
    const hasDetail = isResult || e.text.includes('\n') || e.text.length > 90;   // a one-line, short argument is already the summary
    return html`<${ToolLine} summary=${isResult ? L('결과 · %@', first) : (e.toolName || 'tool') + ' · ' + first}
        icon=${e.isError ? 'exclamationmark.triangle.fill' : isResult ? 'arrow.turn.down.right' : 'wrench.and.screwdriver'} isError=${e.isError}
        hasDetail=${hasDetail} expanded=${expandAll || expanded} onToggle=${() => setExpanded(!expanded)}>
      ${hasDetail ? html`<span style=${{ whiteSpace: 'pre-wrap' }}>${e.text}</span>` : null}
    <//>`;
  }
  if (e.role === 'user') {
    // mine: a soft rounded bubble on the right, no name (it is always me), the time underneath
    const sending = e.toolName === '전송 중';
    return html`<div class="user-row">
      <div class="user-col">
        <div class="user-bubble" style=${{ opacity: sending ? 0.6 : 1 }}><${MarkdownView} text=${e.text} fontSize=${chatFont} /></div>
        <span class="bubble-time">${sending ? L('전송 중…') : Fmt.time(e.time)}</span>
      </div>
    </div>`;
  }
  // agent / lead / teammate: no box, like a document — an avatar + name line, then the text
  const title = e.role === 'assistant' ? (e.isThinking ? L('%@ · 생각', agentName) : agentName)
    : e.role === 'peer' ? (isLeadAddress(e.toolName) ? leadName : (String(e.toolName || '').split('@')[0] || L('팀원'))) : L('시스템');
  const tint = e.role === 'peer' ? (isLeadAddress(e.toolName) ? 'var(--busy)' : 'var(--model-tint)') : 'var(--accent)';
  return html`<div class="speaker-row">
    ${showHeader ? html`<${Avatar} label=${title} tint=${tint} />` : html`<span style=${{ width: '26px', flex: '0 0 26px' }}></span>`}
    <div class="speaker-col">
      ${showHeader ? html`<div class="hstack speaker-head">
        <span class="speaker-name">${title}</span>
        ${e.isThinking ? html`<span class="speaker-thinking">${L('생각')}</span>` : null}
        <span class="bubble-time">${Fmt.time(e.time)}</span>
      </div>` : null}
      ${e.isThinking
        ? html`<div class="thinking-text selectable" style=${{ fontSize: `${chatFont - 1}px` }}>${MarkdownParser.inline(e.text)}</div>`
        : e.role === 'peer'
          ? html`<div class="peer-bubble"><${MarkdownView} text=${e.text} fontSize=${chatFont} /></div>`
          : html`<${MarkdownView} text=${e.text} fontSize=${chatFont} />`}
    </div>
    <span style=${{ minWidth: '40px', flex: '0 0 40px' }}></span>
  </div>`;
}

// ── TermLine ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Cheap test before parsing: does any line start a block (#, >, |, ```, ---)? */
function hasBlocks(t) {
  for (const l of t.split('\n')) {
    if (!l) continue;
    const x = l.replace(/^ +/, '');
    if (x.startsWith('#') || x.startsWith('>') || x.startsWith('|') || x.startsWith('```') || x === '---') return true;
  }
  return false;
}

/** One conversation row the way the CLI prints it: "❯ mine", "⏺ agent", "  ⎿ tool". Inline Markdown only, monospaced;
 *  tool rows show one line, a click opens them. props: entry, name, expandAll, size. */
export function TermLine({ entry, name, expandAll, size = 15 }) {
  const [open, setOpen] = useState(false);
  usePathLinks();
  const e = entry;
  const st = { fontSize: `${size - 1}px` };
  switch (e.role) {
    case 'user':
      return html`<div class="term-line term-user selectable" style=${st}><span class="fg-accent">❯ </span><span style=${{ opacity: e.toolName === '전송 중' ? 0.5 : 0.95 }}>${e.text}</span></div>`;
    case 'assistant':
      if (!e.isThinking && hasBlocks(e.text)) {
        // headings, quotes, tables, code, rules: drawn as blocks (quotes and code get a copy button)
        return html`<div class="term-line term-blocks" style=${st}><span class="term-glyph">⏺ </span><${MarkdownView} text=${e.text} fontSize=${size - 1} mono=${true} color="color-mix(in srgb, var(--fg-solid) 90%, transparent)" /></div>`;
      }
      return html`<div class=${'term-line selectable' + (e.isThinking ? ' term-thinking' : '')} style=${st}>
        <span class=${e.isThinking ? 'fg-secondary' : 'term-glyph'}>${e.isThinking ? '✻ ' : '⏺ '}</span><span class="term-text">${MarkdownParser.inline(e.text)}</span>
      </div>`;
    case 'peer':
      return html`<div class="term-line selectable" style=${st}><span class="fg-busy">${`✉ ${name}: `}</span><span class="term-peer">${MarkdownParser.inline(e.text)}</span></div>`;
    case 'system':
      return html`<div class="term-line selectable" style=${{ ...st, color: e.toolName === 'stderr' ? 'var(--sys-orange)' : 'var(--secondary)' }}>${(e.toolName === 'auto' ? '⚙ ' : '  ⎿ ') + e.text}</div>`;
    case 'tool': {
      const isResult = e.toolName === '결과';
      const full = expandAll || open;
      const head = firstLine(e.text);
      const line = isResult ? '  ⎿ ' + (full ? e.text : head) : '⏺ ' + (e.toolName || 'tool') + '(' + (full ? e.text : head) + ')';
      return html`<div class=${'term-line term-tool' + (full ? ' full' : '')} onClick=${() => setOpen(!open)}
          style=${{ ...st, color: e.isError ? 'var(--error)' : isResult ? 'var(--secondary)' : 'var(--tool-green)' }}>${line}</div>`;
    }
    default: return null;
  }
}

// ── SplitPane ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** One session in the split view: a slim title bar (drag it onto another pane to trade places), its chat and input.
 *  props: agent, swap(fromSid, toSid). */
export function SplitPane({ agent, swap }) {
  const s = useBoard();
  const sid = agent.sessionId;
  const [target, setTarget] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [addingTeammate, setAddingTeammate] = useState(false);
  const [termChat] = useAppStorage('ui.termChat', true);
  const [chatFont] = useAppStorage('ui.chatFont', 15);
  const acts = useAgentActions(agent);
  const cwd = useWorkingDirectory(agent);
  const entries = useChat(sid);
  useEffect(() => { act('store.paneChat', sid, 1); return () => act('store.paneChat', sid, -1); }, [sid]);
  const live = agent.tmuxPane != null && agent.state !== 'ended';
  const menu = () => {
    const e = [{ item: L('이름 변경…'), action: acts.rename },
      '-', { header: L('기본 터미널 앱으로') },
      { item: L('세션 터미널 — 이 세션의 CLI 화면'), enabled: live, action: () => act('store.openTerminal', sid) },
      { item: L('새 터미널 — 이 세션 폴더에서'), action: () => act('store.openExternalShell', cwd) },
      '-'];
    if (canQuit(agent)) e.push({ item: L('종료 (/exit)'), action: () => quitDialog(agent) });
    if (canResume(agent)) e.push({ item: L('다시 시작…'), action: () => setResuming(true) });
    else e.push({ item: L('팀원 추가…'), enabled: agent.canReceiveInput, action: () => setAddingTeammate(true) });
    e.push({ item: L('보관…'), action: acts.askDelete });
    return e;
  };
  const isPaneDrag = (dt) => dt && [...(dt.types || [])].includes('application/x-ab-session');
  return html`<div class="area-box split-pane" onClick=${() => act('store.setSelectedAgent', sid)}
      onDragOver=${(e) => { if (isPaneDrag(e.dataTransfer)) { e.preventDefault(); setTarget(true); } }}
      onDragLeave=${(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setTarget(false); }}
      onDrop=${(e) => { if (!isPaneDrag(e.dataTransfer)) return; e.preventDefault(); setTarget(false); const from = e.dataTransfer.getData('application/x-ab-session'); if (from) swap(from, sid); }}>
    <div class=${'split-header' + (target ? ' target' : '')} draggable="true"
        onDragStart=${(e) => { e.dataTransfer.setData('application/x-ab-session', sid); e.dataTransfer.effectAllowed = 'move'; }}>
      <${Icon} name="line.3.horizontal" class="t-caption fg-tertiary" help=${L('끌어서 다른 칸과 자리를 바꿉니다')} />
      <${StateDot} state=${agent.state} />
      <span class="split-name one-line">${agent.name}</span>
      ${agent.isLead && !agent.solo ? html`<${Chip} text=${L('팀장')} tint="var(--accent)" />` : null}
      <${ModelEffortChips} agent=${agent} />
      <${Chip} text=${Fmt.stateLabel(agent.state)} tint=${Fmt.stateColor(agent.state)} style=${{ opacity: agent.stateUnconfirmed ? 0.7 : 1 }} />
      <${RemoteChip} agent=${agent} s=${s} />
      ${cwd ? html`<${Label} class="t-caption fg-secondary split-folder" icon="folder" title=${basename(cwd)} help=${cwd} />` : null}
      <span class="spacer" style=${{ minWidth: '4px' }}></span>
      <${LazyMenu} class="split-more fg-secondary" entries=${menu} help=${L('터미널 · 종료 · 팀원 추가 · 보관')}><${Icon} name="ellipsis" size=${15} strokeWidth=${2.5} /><//>
    </div>
    <div class="agent-chat">
      ${live && !fixtureOpt('transcriptChat')
        ? html`<${PaneDrop} sid=${sid}><${Lazy} key=${sid} file="panechat.js" name="PaneChatView" pane=${agent.tmuxPane} sid=${sid} placeholder=${panePlaceholder} /></${PaneDrop}>`
        : html`<${ChatView} key=${sid} entries=${entries || []} showThinking=${false} showTools=${false} agentName=${agent.name} userLabel=${L('나')} leadName=${L('팀장')}
            loading=${entries == null && agent.transcriptPath != null} sessionId=${sid} termStyle=${termChat} fontSize=${chatFont} />`}
    </div>
    <${ComposerBar} key=${sid} agent=${agent} openTerminal=${() => act('store.openTerminal', sid)} />
    ${acts.sheets}
    ${addingTeammate ? html`<${Lazy} file="sheets.js" name="AddTeammateSheet" sid=${sid} agent=${agent} onClose=${() => setAddingTeammate(false)} />` : null}
    ${resuming ? html`<${Lazy} file="sheets.js" name="ResumeSheet" sid=${sid} agent=${agent} onClose=${() => setResuming(false)} />` : null}
  </div>`;
}

// ── ResizeGap / ResizableSplit ─────────────────────────────────────────────────────────────────────────────────────

/** Starts a pointer drag; onMove(dx, dy) gets the distance from the start, onEnd() at release. */
function dragFrom(e, onMove, onEnd) {
  e.preventDefault();
  const x0 = e.clientX, y0 = e.clientY;
  const move = (ev) => onMove(ev.clientX - x0, ev.clientY - y0);
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); document.body.classList.remove('resizing'); if (onEnd) onEnd(); };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  document.body.classList.add('resizing');
}

/** The gap between two areas, draggable: reports each move's distance along `axis` ('horizontal' | 'vertical'). */
export function ResizeGap({ axis, onDrag }) {
  const last = useRef(0);
  return html`<div class=${'resize-gap ' + axis}
    onPointerDown=${(e) => { last.current = 0; dragFrom(e, (dx, dy) => { const t = axis === 'horizontal' ? dx : dy; onDrag(t - last.current); last.current = t; }); }}></div>`;
}

/** Panes side by side (or stacked) in equal parts at first, with draggable dividers between them (the gap between two
 *  pane boxes is the handle: no drawn line). props: axis, count, min (px), children: (i) => vnode. */
export function ResizableSplit({ axis, count, min, children }) {
  const [fr, setFr] = useState([]);           // fractions, sum 1
  const box = useRef(null);
  const content = Array.isArray(children) ? children[0] : children;
  const f = fr.length === count ? fr : Array.from({ length: count }, () => 1 / count);
  const horizontal = axis === 'horizontal';
  const startDrag = (i, e) => {
    const el = box.current; if (!el) return;
    const r = el.getBoundingClientRect();
    const total = (horizontal ? r.width : r.height) - (count - 1) * 4;
    const base = f;
    dragFrom(e, (dx, dy) => {
      const d = (horizontal ? dx : dy) / Math.max(total, 1);
      const pair = base[i] + base[i + 1], lo = min / Math.max(total, 1);
      const a = Math.min(Math.max(base[i] + d, lo), pair - lo);
      const n = [...base]; n[i] = a; n[i + 1] = pair - a;
      setFr(n);
    });
  };
  const parts = [];
  for (let i = 0; i < count; i++) {
    parts.push(html`<div key=${'p' + i} class="split-part" style=${{ flex: `${f[i]} 1 0px` }}>${content(i)}</div>`);
    if (i < count - 1) parts.push(html`<div key=${'g' + i} class=${'resize-gap ' + axis} onPointerDown=${(e) => startDrag(i, e)}></div>`);
  }
  return html`<div ref=${box} class=${'resizable-split ' + axis}>${parts}</div>`;
}

// ── AnswerActions ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Under each answer: copy all of it, or type it into another running agent's CLI (the board only relays the text). Two
 * plain buttons; the agent list is built only when the menu opens.
 * props: text (() → string or Promise, read when a button is pressed), compact (the footer's form: the last answer),
 * iconOnly (narrow footer), from (agent name), fromId (its session id), recent (() → Promise<[{asked, answer}]>, read
 * when the ▾ menu opens).
 */
export function AnswerActions({ text, compact, iconOnly, from, fromId, recent }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = (t) => {
    if (!t) return;
    act('platform.copyText', t);
    setCopied(true); clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(false), 1200);
  };
  const recentMenu = async (e) => {
    const at = { x: e.clientX, y: e.clientY };
    const list = (await recent()) || [];
    if (!list.length) { showMenu([{ header: L('복사할 답변이 없습니다') }], at); return; }
    showMenu([{ header: L('최근 답변 복사 (내 메시지 기준)') }, ...list.map((r, i) => {
      const q = firstLine(r.asked || '');
      const qa = Array.from(q), aa = Array.from(r.answer || '');
      const label = !q ? aa.slice(0, 40).join('') : qa.length > 40 ? qa.slice(0, 40).join('') + '…' : q;
      return { item: L('%@. %@  (%@자)', String(i + 1), label, String(aa.length)), action: () => copy(r.answer) };
    })], at);
  };
  const forwardMenu = async (e) => {
    const at = { x: e.clientX, y: e.clientY };
    showMenu(AnswerActions.targets((await text()) || '', from, fromId), at);
  };
  return html`<div class=${'answer-actions' + (compact ? ' compact' : '')}>
    <span class="hstack" style=${{ gap: '3px' }}>
      <button type="button" class="btn btn-plain answer-btn" onClick=${async () => copy(await text())}
          title=${compact ? L('마지막 답변 전체를 복사합니다') : L('이 답변 전체를 복사합니다')}>
        <${Label} icon=${copied ? 'checkmark' : 'doc.on.doc'} title=${copied ? L('복사됨') : L('답변 복사')} iconOnly=${iconOnly} />
      </button>
      ${recent ? html`<button type="button" class="btn btn-plain answer-btn" onClick=${recentMenu} title=${L('최근 답변 5개 중에서 골라 복사합니다')}>
        <${Icon} name="chevron.down" size=${8} strokeWidth=${3.5} /></button>` : null}
    </span>
    <button type="button" class="btn btn-plain answer-btn" onClick=${forwardMenu}
        title=${compact ? L('마지막 답변을 동료 에이전트의 입력창에 그대로 넣습니다') : L('이 답변을 동료 에이전트의 입력창에 그대로 넣습니다')}>
      <${Label} icon="arrowshape.turn.up.right" title=${L('동료 에이전트에게 전달')} iconOnly=${iconOnly} />
    </button>
  </div>`;
}
/** The forward menu: every team's members and the loose sessions (ended ones disabled), the sender left out. */
AnswerActions.targets = (text, from, fromId) => {
  const s = board();
  if (!s) return [];
  if (!text) return [{ header: L('보낼 답변이 없습니다') }];
  const out = [{ header: L('동료 에이전트에게 전달 (꺼진 세션은 고를 수 없음)') }];
  const add = (a, label) => {
    if (a.sessionId === fromId) return;
    out.push({ item: label + (a.state === 'ended' ? L(' — 꺼짐') : ''), enabled: a.canReceiveInput, action: () => {
      act('store.send', L('[%@의 답변을 전달합니다]', from) + '\n\n' + text, a.sessionId);
      act('store.setNotice', L("'%@'의 답변을 '%@'에게 보냈습니다.", from, a.name));
    } });
  };
  for (const t of s.teams || []) {
    if (!(t.members || []).length) continue;
    out.push('-', { header: t.displayName || t.name });
    for (const m of t.members) add(m, m.name);
  }
  if ((s.loose || []).length) { out.push('-', { header: L('개별 세션') }); for (const a of s.loose) add(a, a.name); }
  return out;
};
