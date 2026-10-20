// Port of TurnStatus.swift: the line the CLI draws above its input box (TurnStatusBar), the CLI's footer under the box
// (ComposerFooter: permission mode, context use, background jobs, answer actions, the Tab suggestion, the shortcut
// list), the shortcut sheet and BackgroundJobs (what the CLI footer's "← N agents" counts).
import { html, useState, useEffect, useRef, L } from '../lib.js';
import { Icon, Label, Button, Popover, SpinnerGlyph } from './widgets.js';
import { Fmt, Spinner } from '../fmt.js';
import { act, ensureStyles } from './board.js';
import { AnswerActions } from './teamdetail.js';

ensureStyles();

/** 150 s → "2m 30s", 3700 s → "1h 1m", 42 s → "42s". */
export function clock(s) {
  const n = Math.trunc(s);
  if (n >= 3600) return `${Math.trunc(n / 3600)}h ${Math.trunc((n % 3600) / 60)}m`;
  if (n >= 60) return `${Math.trunc(n / 60)}m ${n % 60}s`;
  return `${n}s`;
}

/**
 * The CLI's status line above the box: a turning glyph with the verb, elapsed time and token count while a turn runs;
 * the raised hand while a question waits; the dim "done" line afterwards. Reads the real CLI screen (`agent.screen`)
 * and falls back to its own clock and token delta when the pane cannot be read.
 * props: agent, lastTool (newest tool call of this turn, "Bash · ls -la"), queued (messages typed while the turn runs —
 * the CLI keeps them until it is free), onInterrupt, onPushQueue, onPullQueue.
 */
export function TurnStatusBar({ agent, lastTool, queued, onInterrupt, onPushQueue = () => {}, onPullQueue = () => {} }) {
  const turn = useRef({ start: null, tokens: 0, state: null });
  const out = (agent.tokens && agent.tokens.output) || 0;
  // onAppear / onChange(of: state)
  if (turn.current.state === null) {
    if (agent.state === 'busy') { turn.current.start = Date.now(); turn.current.tokens = out; }
  } else if (turn.current.state !== agent.state) {
    if (agent.state === 'busy' && turn.current.state !== 'busy') { turn.current.start = Date.now(); turn.current.tokens = out; }
    if (agent.state !== 'busy' && agent.state !== 'needsInput') turn.current.start = null;
  }
  turn.current.state = agent.state;

  let body = null;
  if (agent.state === 'busy') body = html`<${Working} agent=${agent} turn=${turn.current} queued=${queued} onPushQueue=${onPushQueue} onPullQueue=${onPullQueue} />`;
  else if (agent.state === 'needsInput') body = waiting();
  else if (agent.screen && agent.screen.done && agent.state === 'idle') body = doneLine(agent.screen.done);
  return html`<div class="turn-status">${body}</div>`;
}

function Working({ agent, turn, queued, onPushQueue, onPullQueue }) {
  const [, tick] = useState(0);
  useEffect(() => { const id = setInterval(() => tick((n) => n + 1), 125); return () => clearInterval(id); }, []);
  return html`<div class="hstack turn-working">
    <${SpinnerGlyph} />
    <span class="spinner-verb one-line" style=${{ flex: '0 1 auto' }}>${((agent.screen && agent.screen.verb) || L('작업 중')) + '…'}</span>
    <span class="t-mono fg-secondary one-line turn-details">${details(agent, turn, Date.now())}</span>
    <span class="spacer" style=${{ minWidth: '8px' }}></span>
    ${queued > 0 ? html`
      <${Label} class="t-caption fg-secondary" icon="tray.full" title=${L('대기열 %@', String(queued))} help=${L('작업이 끝나면 Claude가 차례로 처리하는 메시지 수')} />
      <${Button} kind="raisedCompact" class="t-caption" onClick=${onPullQueue} help=${L('대기 중인 메시지를 보내기 전에 입력창으로 되돌립니다 (CLI의 ↑와 같음). 고치거나 지울 수 있습니다.')}>
        <${Label} icon="arrow.uturn.down" title=${L('꺼내기')} /><//>
      <${Button} kind="raisedCompact" class="t-caption" onClick=${onPushQueue} help=${L('하던 작업을 멈추고(Esc) 대기 중인 메시지를 바로 처리하게 합니다')}>
        <${Label} icon="paperplane.fill" title=${L('지금 보내기')} /><//>` : null}
  </div>`;
}

/** "(2m 30s · ↓ 9.8k tokens · 생각 중 · Running 1 shell command…)" — screen values first, own counters otherwise. */
function details(agent, turn, now) {
  const segs = [];
  const sc = agent.screen || {};
  if (sc.elapsed) segs.push(sc.elapsed);
  else if (turn.start != null) segs.push(clock((now - turn.start) / 1000));
  const out = (agent.tokens && agent.tokens.output) || 0;
  if (sc.tokens) segs.push(`↓ ${sc.tokens} tokens`);
  else if (out > turn.tokens) segs.push(`↓ ${Fmt.tokens(out - turn.tokens)} tokens`);
  if (sc.thinking === true) segs.push(L('생각 중'));
  if (sc.activity) segs.push(sc.activity);
  return segs.length ? '(' + segs.join(' · ') + ')' : '';
}

function waiting() {
  return html`<div class="hstack" style=${{ gap: '8px' }}>
    <${Icon} name="hand.raised.fill" color="var(--attention)" class="pulse-wait" />
    <span class="turn-waiting">${L('답을 기다리는 중')}</span>
    <span class="t-caption fg-secondary one-line">${L('아래 선택지를 고르거나 숫자 키 · Esc로 취소')}</span>
    <span class="spacer"></span>
  </div>`;
}

/** "Cogitated for 2m 47s · done 2:16 AM" → "✻ 지난 작업 2m 47s · 2:16 AM 완료" */
function doneLine(d) {
  const parts = d.split('·').map((s) => s.trim());
  let took = parts[0] || d;
  const r = took.indexOf(' for ');
  if (r >= 0) took = took.slice(r + 5);
  const done = parts.length > 1 ? parts[1].split('done ').join('') : null;
  return html`<div class="hstack" style=${{ gap: '6px' }}>
    <span class="fg-tertiary">✻</span>
    <span class="t-caption fg-tertiary one-line">${done != null ? L('지난 작업 %@ · %@ 완료', took, done) : L('지난 작업 %@', took)}</span>
    <span class="spacer"></span>
  </div>`;
}

// ── ComposerFooter ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The CLI's footer under the box: permission mode (Shift+Tab cycles), context use, background jobs, pending commands,
 *  the answer actions, what Tab would fill, and the shortcut list. props: agent, ghost, pendingCommands. */
export function ComposerFooter({ agent, ghost, pendingCommands }) {
  const [showKeys, setShowKeys] = useState(false);
  const [narrow, setNarrow] = useState(false);     // a split pane: buttons as icons, so the footer stays one line in every pane
  const box = useRef(null), keysBtn = useRef(null);
  useEffect(() => {
    const el = box.current; if (!el) return;
    const ro = new ResizeObserver(() => setNarrow(el.getBoundingClientRect().width < 620));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const live = agent.tmuxPane != null && agent.state !== 'ended';
  const sc = agent.screen || {};
  const g = ghost || '';
  let ctxView = null;
  if (agent.contextTokens != null) {
    const win = agent.contextWindow || 200000;
    const pct = Math.min(100, Math.trunc((agent.contextTokens / win) * 100));
    const tint = pct >= 85 ? 'var(--error)' : pct >= 65 ? 'var(--attention)' : 'var(--secondary)';
    const help = pct >= 65 ? L('마지막 요청이 실은 컨텍스트: %@ / %@ 토큰 — /compact 로 줄일 수 있습니다', Fmt.tokens(agent.contextTokens), Fmt.tokens(win))
      : L('마지막 요청이 실은 컨텍스트: %@ / %@ 토큰', Fmt.tokens(agent.contextTokens), Fmt.tokens(win));
    ctxView = html`<span class="hstack ctx-meter" title=${help}>
      <span class="ctx-track"><i style=${{ width: `${Math.max(2, (48 * pct) / 100)}px`, background: tint }}></i></span>
      <span class="t-caption one-line" style=${{ color: tint, flex: '0 0 auto' }}>${L('컨텍스트 %@%', String(pct))}</span>
    </span>`;
  }
  return html`<div class="composer-footer" ref=${box}>
    ${live ? html`<button type="button" class="btn btn-plain footer-mode" onClick=${() => act('store.cycleMode', agent.sessionId)}
        style=${{ color: sc.mode == null ? 'var(--secondary)' : 'color-mix(in srgb, var(--mode-gold) 95%, transparent)' }}
        title=${L('권한 모드: %@ — 누르거나 Shift+Tab으로 다음 모드로 바꿉니다 (CLI의 shift+tab과 같음)', agent.modeLabel)}>
      <span class="footer-mode-glyph">⏵⏵</span><span class="t-caption one-line">${agent.modeLabel}</span>
    </button>` : null}
    ${ctxView}
    ${sc.agents > 0 ? html`<${JobsLabel} count=${sc.agents} />` : null}
    ${pendingCommands > 0 ? html`<${Label} class="t-caption fg-orange" icon="clock" title=${L('대기 명령 %@', String(pendingCommands))} help=${L('작업이 끝나면 보내는 명령')} style=${{ flex: '0 0 auto' }} />` : null}
    ${agent.transcriptPath ? html`<${AnswerActions} compact=${true} iconOnly=${narrow} from=${agent.name} fromId=${agent.sessionId}
        text=${() => act('transcript.lastAnswer', agent.transcriptPath)}
        recent=${() => act('transcript.recentAnswers', agent.transcriptPath, 5)} />` : null}
    <span class="spacer" style=${{ minWidth: '4px' }}></span>
    <span class="hstack footer-ghost" style=${{ opacity: g ? 1 : 0 }} title=${L('Tab을 누르면 입력창에 채웁니다')}>
      <span class="footer-key">Tab</span>
      <span class="t-caption one-line">“${Array.from(g).length > 40 ? Array.from(g).slice(0, 40).join('') + '…' : g}”</span>
    </span>
    <span ref=${keysBtn} style=${{ flex: '0 0 auto' }}>
      <button type="button" class="btn btn-plain footer-keys" onClick=${() => setShowKeys(!showKeys)} title=${L('입력창 단축키 보기')}>
        <${Label} icon="keyboard" title=${L('단축키')} iconOnly=${narrow} />
      </button>
    </span>
    ${showKeys ? html`<${Popover} anchor=${keysBtn} edge="top" width=${360} padding=${14} onClose=${() => setShowKeys(false)}><${ShortcutSheet} /><//>` : null}
  </div>`;
}

/** "백그라운드 작업 N": the tooltip lists the jobs, read when the pointer comes over it. */
function JobsLabel({ count }) {
  const [help, setHelp] = useState('');
  return html`<span onMouseEnter=${() => BackgroundJobs.summary(count).then(setHelp)} style=${{ flex: '0 0 auto' }}>
    <${Label} class="t-caption fg-secondary" icon="tray.2" title=${L('백그라운드 작업 %@', String(count))} help=${help || undefined} />
  </span>`;
}

const rows = () => [
  ['Enter', L('보내기 (작업 중이면 CLI가 대기열에 넣음)')], ['⇧ Enter', L('줄바꿈 (목록은 번호·글머리 자동 이어짐)')], ['Ctrl Enter', L('보내기')],
  ['Tab', L('회색 제안 채우기 / 팔레트 선택')], ['⇧ Tab', L('권한 모드 순환 (기본 → 편집 허용 → 계획 …)')],
  ['↑ ↓', L('입력 이력 (비어 있을 때) / 팔레트 이동')], ['Esc', L('작업 중단 · 질문 취소 · 팔레트 닫기 · 이력 취소')],
  ['/', L('슬래시 명령 팔레트')], ['@', L('파일 멘션 (작업 폴더 검색)')], [L('!명령'), L('셸 명령 실행 (에이전트 폴더에서)')],
  ['1–9', L('질문 선택지 고르기')], ['Ctrl V', L('스크린샷·이미지 첨부')], ['Ctrl + / −', L('글자 크기')],
];
/** The composer's keys (⌘ shortcuts are Ctrl on Linux). */
export function ShortcutSheet() {
  return html`<div class="vstack" style=${{ gap: '6px' }}>
    <div class="t-headline" style=${{ paddingBottom: '2px' }}>${L('입력창 단축키')}</div>
    ${rows().map(([k, v], i) => html`<div key=${i} class="hstack" style=${{ gap: '10px', alignItems: 'flex-start' }}>
      <span class="t-mono t-semibold t-caption" style=${{ width: '64px', textAlign: 'right', flex: '0 0 64px' }}>${k}</span>
      <span class="t-caption fg-secondary">${v}</span>
    </div>`)}
  </div>`;
}

/** Claude Code's background agent jobs (~/.claude/jobs/<id>/state.json): what the CLI footer's "← N agents" counts
 *  (the jobs not finished; ← in the CLI lists them). Read on hover only. */
export const BackgroundJobs = {
  async summary(cliCount) {
    // the main process reads each job's state.json with its modification time
    let list = [];
    try { list = (await act('platform.backgroundJobs')) || []; } catch { /* nothing read */ }
    const jobs = [];
    for (const { id, mtime, state: j } of list) {
      if (!j || typeof j.state !== 'string' || j.state === 'done') continue;
      jobs.push({ id, j, when: mtime || null });
    }
    jobs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const lines = jobs.map(({ id, j, when }) => {
      const label = j.state === 'blocked' ? L('멈춤') : j.state === 'running' ? L('실행 중') : j.state;
      return `· ${id} — ${label}${when ? ' (' + Fmt.ago(when) + ')' : ''}\n   ${Array.from(typeof j.detail === 'string' ? j.detail : '').slice(0, 80).join('')}`;
    });
    return L('CLI 하단의 "← %@ agents": 끝나지 않은 Claude Code 백그라운드 작업 (~/.claude/jobs). 서브에이전트나 다른 세션이 아닙니다. CLI에서 ←로 목록을 열어 정리할 수 있습니다.', String(cliCount)) + '\n\n'
      + (lines.length ? lines.join('\n') : L('(작업 폴더에서 끝나지 않은 작업을 찾지 못함)'));
  },
};
export { Spinner };
