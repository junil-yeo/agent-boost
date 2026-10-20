// Port of AgentActions.swift: rename + delete (archive), shared by the org-chart cards and the team detail header; the
// quit confirmation (QuitDialog); the archive sheet (DeleteSheet) with "also archive the teammates" for a lead.
//
// SwiftUI attached these as modifiers driven by bindings (`renaming`, `deleting`, `isPresented`). Here:
//   const acts = useAgentActions(agent);  …  onClick=${acts.rename} / ${acts.askDelete}  …  ${acts.sheets}
//   quitDialog(agent)            — the confirmation dialog, then store.quit
import { html, useState, useEffect, useRef, L } from '../lib.js';
import { Sheet, Button, Checkbox, Label, confirm, prompt } from './widgets.js';
import { overlayName } from '../fmt.js';
import { act, useAppStorage, ensureStyles } from './board.js';

ensureStyles();

const working = (a) => a.state === 'busy' || a.state === 'needsInput';

/** The rename alert's message (what the board will do with the new name in this state). */
export function renameMessage(agent) {
  let base;
  switch (agent.state) {
    case 'ended': base = L('종료된 세션입니다. 대화 기록에 이름을 저장하므로 나중에 이어서 열어도 유지됩니다.'); break;
    case 'needsInput': base = L('입력을 기다리는 중입니다. 응답 후 /rename을 보냅니다.'); break;
    case 'busy': base = L('작업 중입니다. 대기 상태가 되면 /rename을 보냅니다.'); break;
    default: base = agent.tmuxPane == null ? L('이 세션에는 입력할 수 없어 이름을 기록에 저장합니다. 다음에 다시 시작할 때부터 적용됩니다.') : L('에이전트에 /rename을 보냅니다.');
  }
  return base + (agent.teamAddress ? '\n' + L('팀 주소(%@)는 바뀌지 않습니다.', agent.teamAddress) : '');
}
export function deleteMessage(agent) {
  return (agent.state === 'ended' ? '' : L('먼저 /exit 으로 종료합니다.') + '\n')
    + L('보드에서 숨기고 보관함으로 옮깁니다. 파일은 그대로 두므로 보관함에서 복원하거나, 거기서 영구 삭제할 수 있습니다.');
}

/** The rename alert (text field prefilled with the current name), then store.rename. */
export async function renameAgent(agent) {
  const t = await prompt(L('이름 변경'), { message: renameMessage(agent), value: agent.name, placeholder: L('새 이름'), ok: L('변경'), cancel: L('취소') });
  if (t != null) act('store.rename', agent.sessionId, t);
}

/** rename / askDelete actions and the sheets they open (render `sheets` somewhere in the view). */
export function useAgentActions(agent) {
  const [deleting, setDeleting] = useState(false);
  return {
    rename: () => renameAgent(agent),
    askDelete: () => { const f = document.activeElement; if (f && f !== document.body && f.blur) f.blur(); setDeleting(true); },
    sheets: deleting ? html`<${DeleteSheet} agent=${agent} message=${deleteMessage(agent)} onClose=${() => setDeleting(false)} />` : null,
  };
}

// ── QuitDialog ─────────────────────────────────────────────────────────────────────────────────────────────────────

export function quitMessage(agent) {
  let s;
  if (agent.isBackgroundJob) {
    s = agent.tmuxPane != null ? L('CLI 백그라운드 작업입니다. claude stop %@(으)로 멈추고, 붙어 있는 CLI 화면은 ctrl+c 두 번으로 닫습니다.', agent.jobId || '')
      : L('CLI 백그라운드 작업입니다. claude stop %@(으)로 멈추고 목록(claude agents)에는 남습니다.', agent.jobId || '');
  } else if (agent.tmuxPane != null) {
    s = working(agent) ? L('작업 중입니다.') : (agent.overlay != null ? L('CLI가 %@ 화면이라 Esc로 돌아간 뒤 /exit 을 보냅니다.', overlayName(agent.overlay)) : L('/exit 을 입력해 실제로 종료합니다.'));
  } else {
    s = L('입력할 수 없는 세션이라 종료 신호(SIGTERM)로 프로세스를 실제로 끕니다.');
  }
  if (agent.entrypoint === 'claude-desktop') {
    s += '\n' + L('⚠️ Claude 데스크톱 앱의 대화입니다. 끄면 데스크톱 앱의 해당 대화가 끊기고, 데스크톱 앱이 다음 메시지 때 다시 띄울 수 있습니다.');
  }
  return s + '\n' + L('대화 기록은 남고, 나중에 다시 시작할 수 있습니다.');
}

/** Quit confirmation. Idle: one button. Busy: interrupt now, or exit when the turn ends. */
export async function quitDialog(agent) {
  const buttons = working(agent)
    ? [{ label: L('지금 종료 (작업 중단)'), role: 'destructive', value: 'now' }, { label: L('작업 끝나면 종료'), value: 'whenIdle' }]
    : [{ label: L('종료'), role: 'destructive', value: 'now' }];
  buttons.push({ label: L('취소'), role: 'cancel' });
  const v = await confirm(L("'%@' 종료", agent.name), quitMessage(agent), buttons);
  if (v === 'now' || v === 'whenIdle') act('store.quit', agent.sessionId, v);
}

// ── DeleteSheet ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Delete confirmation. For a lead with teammates: a checkbox to stop and archive them too (otherwise they keep running
 *  without a lead). props: agent, message, onClose. */
export function DeleteSheet({ agent, message, onClose }) {
  const [withTeammates, setWith] = useAppStorage('delete.withTeammates', true);
  const [mates, setMates] = useState([]);
  const matesP = useRef(null);       // the teammates' answer: Return before it arrives waits for it
  const box = useRef(null), done = useRef(false);
  if (!matesP.current) matesP.current = Promise.resolve(act('store.teammates', agent.sessionId)).then((m) => m || [], () => []);
  useEffect(() => { let live = true; matesP.current.then((m) => { if (live) setMates(m); }); return () => { live = false; }; }, []);
  // the sheet takes the keys (a modal window in Swift): typing and Return no longer reach the composer behind it
  useEffect(() => { if (box.current) box.current.focus({ preventScroll: true }); }, []);
  const withRef = useRef(withTeammates); withRef.current = withTeammates;
  const go = async () => {
    if (done.current) return;
    done.current = true;
    const m = await matesP.current;   // an archive must not leave the teammates out just because they were still loading
    act('store.archive', agent.sessionId, withRef.current && m.length > 0);
    onClose();
  };
  useEffect(() => {
    // Return = the default button (.defaultAction); not while a menu is open or when another handler took the key
    const key = (e) => { if (e.key === 'Enter' && !e.defaultPrevented && !e.isComposing && !document.querySelector('.menu-layer')) { e.preventDefault(); go(); } };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  return html`<${Sheet} width=${460} onClose=${onClose}>
    <div class="vstack" ref=${box} tabIndex="-1" style=${{ gap: '12px', outline: 'none' }}>
      <div class="t-title3 t-bold">${L("'%@' 세션을 보관할까요?", agent.name)}</div>
      <div class="t-callout fg-secondary" style=${{ whiteSpace: 'pre-wrap' }}>${message}</div>
      ${mates.length ? html`
        <${Checkbox} checked=${withTeammates} onChange=${setWith}>
          <span class="vstack" style=${{ gap: '2px' }}>
            <span class="t-callout t-bold">${L('팀원 %@명도 함께 보관', String(mates.length))}</span>
            <span class="t-caption fg-secondary">${mates.map((m) => m.name).join(', ')}</span>
          </span>
        <//>
        ${!withTeammates ? html`<${Label} class="t-caption fg-orange" icon="exclamationmark.triangle" title=${L('팀원은 팀장 없이 계속 실행됩니다.')} />` : null}` : null}
      <div class="hstack" style=${{ gap: '8px' }}>
        <span class="spacer"></span>
        <${Button} kind="raised" onClick=${onClose}>${L('취소')}<//>
        <${Button} kind="raisedProminent" onClick=${go}>${agent.state === 'ended' ? L('보관') : L('종료하고 보관')}<//>
      </div>
    </div>
  <//>`;
}
