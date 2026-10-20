// The session view's "서브에이전트" tab: the subagents this session started with its Agent / Task tool (main/subagents.js
// reads them off <sid>/subagents/agent-*.jsonl + .meta.json; in-process team members are not here, they are team
// members). Each row: description, agent type, running / done, started, duration, tokens, model. A click opens that
// subagent's conversation read-only (the same ChatView ended sessions use). "중단 요청" on a running row only types a
// request into the PARENT session's input (the normal send path); nothing is killed or deleted from here.
//
// Exports: SubagentsPanel({agent}), useSubagentCount(agent).
import { html, useState, useEffect, useRef, L } from '../lib.js';
import { Icon, Button, Chip, StateDot, EmptyState, confirm } from './widgets.js';
import { Fmt } from '../fmt.js';
import { act, useAppStorage, ensureStyles } from './board.js';
import { ChatView } from './teamdetail.js';

ensureStyles();

const POLL_MS = 2000;
const shortModel = (m) => {
  if (!m) return '—';
  const x = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(m);
  return x ? `${x[1][0].toUpperCase()}${x[1].slice(1)} ${x[2]}.${x[3]}` : m;
};
/** 75 s → "1분 15초", 3 h → "3시간 0분". */
function duration(ms) {
  if (ms == null) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return L('%@초', String(s));
  if (s < 3600) return L('%@분 %@초', String(Math.floor(s / 60)), String(s % 60));
  return L('%@시간 %@분', String(Math.floor(s / 3600)), String(Math.floor((s % 3600) / 60)));
}
/** Started time: "HH:mm" today, else "M/d HH:mm". */
function startedText(t) {
  if (t == null) return '—';
  const d = new Date(t), n = new Date();
  const hm = Fmt.time(t);
  return d.toDateString() === n.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/** subagents.list(sid), polled every 2 s while `on` (the tab is visible). */
function useSubagents(sid, on) {
  const [data, setData] = useState(null);
  useEffect(() => {
    if (!on || !sid) return;
    let live = true, timer = 0;
    const tick = () => {
      Promise.resolve(act('subagents.list', sid)).then((r) => { if (live) { setData(r || { items: [] }); timer = setTimeout(tick, POLL_MS); } },
        () => { if (live) timer = setTimeout(tick, POLL_MS); });
    };
    tick();
    return () => { live = false; clearTimeout(timer); };
  }, [sid, on]);
  return data;
}
/** How many subagents a session has (for the tab's label): asked when the session changes state, every 10 s while it
 *  is live; nothing while ended and already counted. */
export function useSubagentCount(agent) {
  const sid = agent && agent.sessionId;
  const [n, setN] = useState({ total: 0, running: 0 });
  const state = agent && agent.state;
  useEffect(() => {
    if (!sid || (agent && (agent.inProcess || agent.isSubagent))) { setN({ total: 0, running: 0 }); return; }
    let live = true, timer = 0;
    const ask = () => Promise.resolve(act('subagents.list', sid)).then((r) => {
      if (!live) return;
      const items = (r && r.items) || [];
      setN({ total: items.length, running: items.filter((x) => x.running).length });
      if (state !== 'ended') timer = setTimeout(ask, 10000);
    }, () => {});
    ask();
    return () => { live = false; clearTimeout(timer); };
  }, [sid, state]);
  return n;
}

/** The read-only conversation of one subagent, polled every 2 s while shown (only new versions are sent). */
function useSubagentChat(sid, agentId) {
  const [entries, setEntries] = useState(null);
  const ver = useRef(null);
  useEffect(() => {
    if (!sid || !agentId) return;
    let live = true, timer = 0;
    ver.current = null; setEntries(null);
    const tick = () => Promise.resolve(act('subagents.chat', sid, agentId, ver.current)).then((r) => {
      if (!live) return;
      if (r && !r.same && !r.loading) { ver.current = r.version; setEntries(r.entries || []); }
      timer = setTimeout(tick, POLL_MS);
    }, () => { if (live) timer = setTimeout(tick, POLL_MS); });
    tick();
    return () => { live = false; clearTimeout(timer); };
  }, [sid, agentId]);
  return entries;
}

/** Asks the parent session (through its input box, like a typed message) to stop one subagent. */
async function requestStop(parent, row) {
  const text = L('서브에이전트 "%@"(%@)를 중단해 줘', row.description, row.agentId);
  const ok = await confirm(L('중단 요청'), L("'%@'의 입력창에 다음 메시지를 보냅니다. 서브에이전트를 직접 끄지는 않습니다.\n\n%@", parent.name, text),
    [{ label: L('취소'), role: 'cancel' }, { label: L('보내기'), value: 'send' }]);
  if (ok !== 'send') return;
  act('store.send', text, parent.sessionId);
}

function SubagentRow({ row, parent, onOpen }) {
  const tk = row.tokens || {};
  const canAsk = row.running && parent.canReceiveInput;
  return html`<div class="subagent-row" onClick=${() => onOpen(row.agentId)} title=${row.agentId}>
    <${StateDot} state=${row.running ? 'busy' : 'ended'} />
    <div class="subagent-main">
      <div class="hstack" style=${{ gap: '6px', minWidth: 0 }}>
        <span class="subagent-desc one-line">${row.description}</span>
        ${row.agentType ? html`<${Chip} text=${row.agentType} neutral=${true} />` : null}
        ${row.background ? html`<${Chip} text=${L('백그라운드')} neutral=${true} help=${L('부모 세션이 기다리지 않고 띄운 서브에이전트')} />` : null}
      </div>
      <div class="hstack subagent-meta t-caption fg-secondary">
        <span>${L('시작 %@', startedText(row.started))}</span>
        <span>·</span><span>${row.running ? L('%@째', duration(row.duration)) : duration(row.duration)}</span>
        <span>·</span><span title=${L('입력 %@ · 캐시 쓰기 %@ · 캐시 읽기 %@ · 출력 %@', Fmt.tokens(tk.input), Fmt.tokens(tk.cacheWrite), Fmt.tokens(tk.cacheRead), Fmt.tokens(tk.output))}>
          ${row.tokensLoading ? L('출력 %@ · 합 %@', '…', '…') : L('출력 %@ · 합 %@', Fmt.tokens(tk.output), Fmt.tokens(row.total))}</span>
        <span>·</span><span>${shortModel(row.model)}</span>
      </div>
    </div>
    <span class="spacer"></span>
    ${row.running ? html`<${Button} kind="raisedCompact" disabled=${!canAsk}
        help=${canAsk ? L('부모 세션에 이 서브에이전트를 멈춰 달라고 메시지를 보냅니다') : L('부모 세션에 입력할 수 없어 보낼 수 없습니다')}
        onClick=${(e) => { e.stopPropagation(); requestStop(parent, row); }}>${L('중단 요청')}<//>` : null}
    <span class="state-capsule" style=${{ '--tint': row.running ? Fmt.stateColor('busy') : Fmt.stateColor('ended') }}>${row.running ? L('실행 중') : L('완료')}</span>
  </div>`;
}

/** The tab's content. props: agent (the parent session). */
export function SubagentsPanel({ agent }) {
  const sid = agent.sessionId;
  const [open, setOpen] = useState(null);
  const data = useSubagents(sid, open == null);
  const [termChat] = useAppStorage('ui.termChat', true);
  const [chatFont] = useAppStorage('ui.chatFont', 15);
  useEffect(() => { setOpen(null); }, [sid]);
  if (open != null) return html`<${SubagentChat} agent=${agent} agentId=${open} row=${((data && data.items) || []).find((x) => x.agentId === open)}
      onBack=${() => setOpen(null)} termChat=${termChat} chatFont=${chatFont} />`;
  const items = (data && data.items) || [];
  if (data == null) return html`<div class="chat-scroll"><div class="fg-secondary chat-none">${L('불러오는 중…')}</div></div>`;
  if (!items.length) return html`<div class="chat-scroll subagent-empty"><${EmptyState} title=${L('서브에이전트가 없습니다')} icon="branch"
      description=${L('이 세션이 Agent 도구로 띄운 서브에이전트가 여기에 나옵니다. 팀원은 팀 화면에 나옵니다.')} /></div>`;
  return html`<div class="chat-scroll subagent-list">
    ${items.map((r) => html`<${SubagentRow} key=${r.agentId} row=${r} parent=${agent} onOpen=${setOpen} />`)}
  </div>`;
}

/** One subagent's conversation, read-only, with a bar to go back to the list. */
function SubagentChat({ agent, agentId, row, onBack, termChat, chatFont }) {
  const entries = useSubagentChat(agent.sessionId, agentId);
  const [showTools, setShowTools] = useState(false);
  return html`<div class="subagent-chat">
    <div class="term-tabbar subagent-bar">
      <${Button} kind="raisedCompact" onClick=${onBack} help=${L('서브에이전트 목록으로')}><${Icon} name="arrow.uturn.backward" /> ${L('목록')}<//>
      <${StateDot} state=${row && row.running ? 'busy' : 'ended'} />
      <span class="one-line" style=${{ fontWeight: 600, minWidth: 0 }}>${row ? row.description : agentId}</span>
      ${row && row.agentType ? html`<${Chip} text=${row.agentType} neutral=${true} />` : null}
      <span class="t-caption fg-secondary one-line">${L('보기 전용')}</span>
      <span class="spacer"></span>
      <label class="t-caption hstack" style=${{ gap: '4px' }}><input type="checkbox" checked=${showTools} onChange=${(e) => setShowTools(e.currentTarget.checked)} />${L('도구 펼침')}</label>
      ${row && row.running ? html`<${Button} kind="raisedCompact" disabled=${!agent.canReceiveInput} onClick=${() => requestStop(agent, row)}>${L('중단 요청')}<//>` : null}
    </div>
    <${ChatView} key=${agentId} entries=${entries || []} showThinking=${false} showTools=${showTools} agentName=${row ? row.description : agentId}
      userLabel=${L('부모 세션')} leadName=${agent.name} loading=${entries == null} sessionId=${'sub:' + agent.sessionId + ':' + agentId}
      termStyle=${termChat} fontSize=${chatFont} />
  </div>`;
}
