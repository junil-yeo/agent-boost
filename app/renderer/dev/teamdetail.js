// Dev fixture for the team detail screen: renders TeamDetailView with realistic data and no store behind it (actions
// are only logged). Open renderer/dev/teamdetail.html; options in the hash, e.g.
//   #td-fixture&view=split&lang=en&theme=light&width=900
// view: single (lead, rebuilt chat) | split (lead + two teammates) | prompt (a question waiting, "/" palette, files)
//       | pane (live CLI screen view) | loose (individual sessions) | empty (team without teammates)
// Snapshot: AB_SNAPSHOT_JS="if(!location.pathname.includes('/dev/'))location.href='dev/teamdetail.html#td-fixture&view=split'"
import { html, render, loadL10n, setLang } from '../lib.js';
import { Agent } from '../fmt.js';
import { applyAppearance } from '../ui/widgets.js';
import { setFixture } from '../ui/board.js';
import { PathLinks } from '../ui/pathlinks.js';

await loadL10n();
const opts0 = Object.fromEntries(location.hash.replace(/^#/, '').split('&').filter((x) => x.includes('=')).map((x) => x.split('=').map(decodeURIComponent)));
setLang(opts0.lang || 'ko');
const opts = Object.fromEntries(location.hash.replace(/^#/, '').split('&').filter((x) => x.includes('=')).map((x) => x.split('=').map(decodeURIComponent)));
const view = opts.view || 'single';
const now = Date.now();
const min = 60000;

// ── fixture data ──────────────────────────────────────────────────────────────────────────────────────────────────
const HOME = '/home/junil';
const CWD = `${HOME}/projects/telemetry`;
function agent(o) {
  const a = {
    sessionId: o.sessionId, pid: 4000 + Math.floor(Math.random() * 1000), name: o.name, nameSource: null, teamAddress: null, teamName: null,
    agentType: null, isLead: false, state: 'idle', tmuxPane: '%91', tmuxSession: 'ab-fixture', cwd: CWD, model: 'claude-opus-5-5',
    effort: 'high', prompt: null, screen: null, contextTokens: 61000, stateUnconfirmed: false, modelIsGuess: false,
    tokens: { input: 1200, cacheWrite: 30000, cacheRead: 410000, output: 18400 }, tokensEstimated: false, lastActivity: now - 2 * min,
    transcriptPath: `${HOME}/.claude/projects/-home-junil-projects-telemetry/${o.sessionId}.jsonl`, pendingName: null, entrypoint: 'cli',
    jobId: null, isBackgroundJob: false, remoteControl: false, origin: 'board', isSubagent: false, parentSid: null, solo: false,
    pendingCommands: [], queued: 0, parkedJobId: null, overlay: null, viewerPid: null, requestedModel: null, requestedEffort: null,
    ...o,
  };
  a.displayModel = Agent.displayModel(a);
  a.isEstimated = Agent.isEstimated(a);
  a.working = Agent.working(a);
  a.canReceiveInput = Agent.canReceiveInput(a);
  a.contextWindow = Agent.contextWindow(a.model);
  a.modeLabel = Agent.modeLabel(a.screen ? a.screen.mode : null);
  return a;
}
const TEAM = 'session-039ac1c1';
const lead = agent({
  sessionId: '1a2b3c4d-1111-4c1d-9a7e-000000000001', name: 'telemetry-lead', isLead: true, teamName: TEAM, state: 'busy',
  teamAddress: `team-lead@${TEAM}`, remoteControl: true, queued: 2, contextTokens: 142000,
  screen: { verb: 'Refactoring', elapsed: '2m 31s', tokens: '9.8k', thinking: false, activity: 'Running 1 shell command…', mode: 'accept edits', agents: 1 },
});
const reviewer = agent({
  sessionId: '1a2b3c4d-2222-4c1d-9a7e-000000000002', name: 'reviewer', teamName: TEAM, state: 'needsInput', model: 'claude-sonnet-5-5', effort: 'medium',
  teamAddress: `reviewer@${TEAM}`, remoteControl: null, contextTokens: 31000,
  prompt: { title: 'Bash command', detail: 'Do you want to run this command?', preview: 'cargo test --workspace -- --nocapture 2>&1 | tail -40', options: ['Yes', "Yes, and don't ask again for cargo test commands", 'No, and tell Claude what to do differently (esc)'], cursor: 0 },
});
const tester = agent({
  sessionId: '1a2b3c4d-3333-4c1d-9a7e-000000000003', name: 'tester', teamName: TEAM, state: 'idle', model: 'claude-haiku-5-5', effort: 'low',
  teamAddress: `tester@${TEAM}`, remoteControl: null, contextTokens: 176000, requestedEffort: 'medium',
  screen: { done: 'Cogitated for 1m 12s · done 14:02', suggestion: 'run the flaky test 20 times and report the failures', mode: null },
});
const archivist = agent({
  sessionId: '1a2b3c4d-4444-4c1d-9a7e-000000000004', name: 'archivist', teamName: TEAM, state: 'ended', tmuxPane: null, pid: null,
  model: 'claude-sonnet-5-5', effort: 'medium', remoteControl: null, contextTokens: null,
});
const team = { name: TEAM, id: TEAM, createdAt: now - 90 * min, leadSessionId: lead.sessionId, members: [lead, reviewer, tester, archivist],
  lead: lead.sessionId, liveCount: 3, isSolo: false, displayName: 'telemetry-lead', tokens: lead.tokens };
const solo = agent({ sessionId: '9f9f9f9f-5555-4c1d-9a7e-000000000005', name: 'notes-cleanup', state: 'idle', solo: true, isLead: true, teamName: 'session-77aa', model: 'claude-fable-5-1', effort: 'xhigh' });
const desktop = agent({ sessionId: '9f9f9f9f-6666-4c1d-9a7e-000000000006', name: 'Research summary', state: 'idle', tmuxPane: null, entrypoint: 'claude-desktop', remoteControl: true, cwd: HOME });
const old = agent({ sessionId: '9f9f9f9f-7777-4c1d-9a7e-000000000007', name: 'migrate-db', state: 'ended', tmuxPane: null, pid: null, remoteControl: null });
const loose = [solo, desktop, old];

let t = now - 40 * min;
const at = () => (t += 37000);
const chat = [
  { role: 'user', text: 'Profile the ingest path and fix whatever makes `flush()` stall under load.' },
  { role: 'assistant', text: 'I will start by reading the ingest pipeline and the flush logic.', isThinking: false },
  { role: 'assistant', text: 'The batcher holds the lock while it waits on disk; that would explain the stalls.', isThinking: true },
  { role: 'tool', toolName: 'Read', text: `${CWD}/src/ingest/batcher.rs` },
  { role: 'tool', toolName: '결과', text: '   1 use std::sync::Mutex;\n   2 use crate::sink::Sink;\n   …(212 lines)' },
  { role: 'tool', toolName: 'Bash', text: 'cargo bench --bench ingest -- --save-baseline before' },
  { role: 'tool', toolName: '결과', text: 'error: could not compile `telemetry` (bin "ingest") due to 2 previous errors', isError: true },
  { role: 'assistant', text: `## Findings\n\nThe stall comes from **holding the batch lock across \`fsync\`**. Two fixes:\n\n1. Swap the buffer under the lock, write *outside* it.\n2. Replace the \`Mutex<Vec<_>>\` with a double buffer.\n\n| Path | p50 | p99 |\n|---|---|---|\n| before | 1.8 ms | 412 ms |\n| after | 1.7 ms | 9.6 ms |\n\n\`\`\`rust\nlet batch = std::mem::take(&mut *guard);\ndrop(guard);\nsink.write_all(&batch)?;\n\`\`\`\n\n> The change is in ${CWD}/src/ingest/batcher.rs, the benchmark in ${CWD}/benches/ingest.rs.\n\nShould I also add a regression test?` },
  { role: 'peer', toolName: `tester@${TEAM}`, text: 'Flaky test `ingest::flush_under_load` failed 3/20 runs before the fix, 0/20 after.' },
  { role: 'user', text: '/compact' },
  { role: 'system', toolName: null, text: 'Compacted. ctrl+o to see full summary' },
  { role: 'user', text: 'Yes, add the regression test and run the whole suite.' },
  { role: 'tool', toolName: 'Edit', text: `${CWD}/tests/flush_regression.rs` },
  { role: 'assistant', text: 'Writing the regression test now; the suite runs next.' },
  { role: 'user', text: 'Also check the docs mention the new buffer size knob.', toolName: '전송 중' },
].map((e, i) => ({ id: 'e' + i, toolName: null, isThinking: false, isError: false, time: at(), ...e }));
const peerChat = [
  { role: 'peer', toolName: `team-lead@${TEAM}`, text: 'Review the batcher change for lock ordering issues.' },
  { role: 'assistant', text: 'Reviewed. Lock ordering is fine; one nit: `drop(guard)` could be a scope.' },
].map((e, i) => ({ id: 'p' + i, toolName: null, isThinking: false, isError: false, time: at(), ...e }));

const answers = {
  [lead.transcriptPath]: [
    { asked: 'Profile the ingest path and fix whatever makes flush() stall under load.', answer: 'The stall comes from holding the batch lock across fsync…' },
    { asked: 'What is the p99 now?', answer: 'p99 dropped from 412 ms to 9.6 ms.' },
  ],
};
const existing = [`${CWD}/src/ingest/batcher.rs`, `${CWD}/src/ingest`, `${CWD}/src`, `${CWD}/benches/ingest.rs`, `${CWD}/benches`, `${CWD}/tests`, CWD, `${HOME}/projects`, HOME];

const states = {
  teams: [team], loose, selectedTeam: TEAM, selectedAgent: lead.sessionId, notice: null, noticeLog: [], sending: [], promptSending: [],
  rcPending: [], bounce: { sid: '', gen: 0 }, pulled: { sid: '', gen: 0, texts: [] }, lastSentAt: null, chatVersion: {},
};
const fixture = {
  state: states,
  chat: { [lead.sessionId]: chat, [reviewer.sessionId]: peerChat, [tester.sessionId]: peerChat.slice(0, 1), [archivist.sessionId]: peerChat, [old.sessionId]: chat.slice(0, 9), [desktop.sessionId]: chat.slice(7, 9) },
  answers,
  options: { transcriptChat: view !== 'pane' },
  drafts: {},
  history: ['run the benchmarks again', 'commit this'],
  files: ['src/', 'src/ingest/', 'src/ingest/batcher.rs', 'benches/ingest.rs', 'Cargo.toml', 'README.md'],
};
let teamProp = team, isLoose = false;
if (view === 'single') states.selectedAgent = lead.sessionId;
if (view === 'pane') states.selectedAgent = lead.sessionId;
if (view === 'prompt') {
  states.selectedAgent = reviewer.sessionId;
  fixture.drafts[reviewer.sessionId] = { text: '/co', paths: [`${CWD}/benches/ingest.rs`, `${HOME}/Pictures/flame graph.png`] };
}
if (view === 'loose') { teamProp = { name: '', members: loose }; isLoose = true; states.selectedAgent = desktop.sessionId; }
if (view === 'empty') {
  const l2 = agent({ ...lead, sessionId: 'e1', name: 'solo-planner', teamName: 'session-e', state: 'idle', screen: null, queued: 0 });
  teamProp = { name: 'session-e', members: [l2], lead: 'e1' };
  states.teams = [teamProp]; states.selectedAgent = 'e1';
}
if (view === 'sending') { states.selectedAgent = tester.sessionId; states.sending = [tester.sessionId]; fixture.drafts[tester.sessionId] = { text: 'run it again', paths: [] }; }
setFixture(fixture);
PathLinks.setResolver(async (paths) => new Map(paths.filter((p) => existing.includes(p)).map((p) => [p, { dir: !/\.\w+$/.test(p) }])));

// ── page ──────────────────────────────────────────────────────────────────────────────────────────────────────────
applyAppearance(opts.theme === 'light' ? 'light' : 'dark');
const { TeamDetailView } = await import('../ui/teamdetail.js');

function Page() {
  return html`<div class="gap-layout" style=${{ width: opts.width ? `${opts.width}px` : '100%', height: '100vh', boxSizing: 'border-box' }}>
    <${TeamDetailView} team=${teamProp} isLoose=${isLoose} active=${true} />
  </div>`;
}
render(html`<${Page} />`, document.getElementById('root'));

// split: open both teammates beside the lead (a click on each row, as a user would)
if (view === 'split') {
  setTimeout(() => {
    const rows = [...document.querySelectorAll('.member-row')];
    rows.filter((r) => /reviewer|tester/.test(r.textContent)).forEach((r) => r.click());
  }, 300);
}
// prompt: focus the composer so the "/" palette shows
if (view === 'prompt') setTimeout(() => { const f = document.querySelectorAll('.composer-field'); if (f.length) f[f.length - 1].focus(); }, 400);
