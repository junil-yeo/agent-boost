// A realistic store snapshot for checking the screens without a store or live sessions (app.js uses it when
// location.hash contains 'fixture'). Field names follow the store's snapshot (main/store.js snapshot(), models.js
// agentJSON / teamJSON / meterJSON). Times are relative to now, so "3분 전" etc. read the same on every run.
const now = Date.now();
const min = 60_000, hour = 60 * min, day = 24 * hour;

let seq = 0;
const pretty = (m) => ({ 'claude-opus-5-5': 'Opus 5.5', 'claude-sonnet-5-5': 'Sonnet 5.5', 'claude-haiku-5-5': 'Haiku 5.5', 'claude-fable-5-1': 'Fable 5.1' })[m] || m;
/** One Agent with every field of struct Agent plus the computed values the snapshot carries. */
function agent(o) {
  seq += 1;
  const a = {
    sessionId: o.sessionId || `fx-${String(seq).padStart(4, '0')}-4c1e-9a2b-${String(seq * 7919).padStart(12, '0')}`,
    pid: o.state === 'ended' ? null : 40000 + seq, name: 'agent', nameSource: 'rename', teamAddress: null, teamName: null, agentType: null,
    isLead: false, state: 'idle', tmuxPane: o.state === 'ended' ? null : `%${seq}`, tmuxSession: o.state === 'ended' ? null : `ab-${seq}`,
    cwd: '/home/user/projects/agent-boost', model: 'claude-sonnet-5-5', effort: 'low', prompt: null, screen: null, contextTokens: 42_000,
    stateUnconfirmed: false, modelIsGuess: false, tokens: { input: 1200, cacheWrite: 30_000, cacheRead: 410_000, output: 18_400 },
    tokensEstimated: false, lastActivity: now - 3 * min, transcriptPath: `/home/user/.claude/projects/-home-user-projects/fx-${seq}.jsonl`,
    pendingName: null, entrypoint: 'cli', jobId: null, isBackgroundJob: false, remoteControl: false, origin: null, isSubagent: false,
    parentSid: null, solo: false, pendingCommands: [], queued: 0, parkedJobId: null, overlay: null, viewerPid: null,
    requestedModel: null, requestedEffort: null,
    ...o,
  };
  a.displayModel = a.model ? pretty(a.model) + (a.modelIsGuess ? ' ?' : '') : '모델 미확인';
  a.isEstimated = !!(a.modelIsGuess || a.tokensEstimated);
  a.working = a.state === 'busy' || a.state === 'needsInput';
  a.canReceiveInput = a.tmuxPane != null && a.state !== 'ended' && a.overlay == null;
  a.contextWindow = (a.model || '').includes('[1m]') ? 1_000_000 : 200_000;
  a.modeLabel = '기본 모드';
  return a;
}
const total = (t) => t.input + t.cacheWrite + t.cacheRead + t.output;
function team(name, createdAt, members) {
  const lead = members.find((m) => m.isLead) || null;
  const tokens = members.reduce((s, m) => ({ input: s.input + m.tokens.input, cacheWrite: s.cacheWrite + m.tokens.cacheWrite, cacheRead: s.cacheRead + m.tokens.cacheRead, output: s.output + m.tokens.output }), { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });
  return {
    name, id: name, createdAt, leadSessionId: lead ? lead.sessionId : null, members, lead: lead ? lead.sessionId : null,
    liveCount: members.filter((m) => m.state === 'busy' || m.state === 'idle' || m.state === 'needsInput').length,
    isSolo: false, displayName: lead && lead.name !== 'team-lead' ? lead.name : name, tokens: { ...tokens, total: total(tokens) },
  };
}

export function fixtureState() {
  seq = 0;
  const t1 = 'session-039ac1c1';
  const lead1 = agent({ name: 'linux-port', teamName: t1, isLead: true, agentType: 'team-lead', state: 'busy', model: 'claude-opus-5-5', effort: 'high',
    origin: 'board', remoteControl: true, lastActivity: now - 20_000, tokens: { input: 8200, cacheWrite: 120_000, cacheRead: 2_400_000, output: 96_000 },
    screen: { verb: 'Porting', elapsed: '4m 12s', mode: null } });
  const w1 = agent({ name: 'renderer', teamName: t1, teamAddress: `renderer@${t1}`, state: 'busy', model: 'claude-opus-5-5', effort: 'medium', lastActivity: now - 45_000 });
  const w2 = agent({ name: 'store', teamName: t1, teamAddress: `store@${t1}`, state: 'needsInput', model: 'claude-sonnet-5-5', effort: 'low', lastActivity: now - 2 * min,
    prompt: { title: 'Do you want to make this edit to store.js?', options: ['Yes', 'Yes, allow all edits during this session', 'No'] } });
  const w3 = agent({ name: 'tests', teamName: t1, teamAddress: `tests@${t1}`, state: 'idle', model: 'claude-haiku-5-5', effort: 'low', lastActivity: now - 9 * min, pendingName: 'test-runner' });
  const w4 = agent({ name: 'docs', teamName: t1, teamAddress: `docs@${t1}`, state: 'ended', model: 'claude-sonnet-5-5', effort: 'low', lastActivity: now - 3 * hour, remoteControl: null });

  const t2 = 'session-7f20be44';
  const lead2 = agent({ name: 'paper-review', teamName: t2, isLead: true, agentType: 'team-lead', state: 'idle', model: 'claude-fable-5-1', effort: 'xhigh',
    cwd: '/home/user/research/vmlog', lastActivity: now - 14 * min, stateUnconfirmed: true });
  const w5 = agent({ name: 'related-work', teamName: t2, teamAddress: `related-work@${t2}`, state: 'busy', model: 'claude-sonnet-5-5', effort: 'medium',
    cwd: '/home/user/research/vmlog', lastActivity: now - 30_000, overlay: 'agents' });

  const loose = [
    agent({ name: 'Memory Manager', state: 'idle', model: 'claude-sonnet-5-5', effort: 'low', cwd: '/home/user', origin: 'board', lastActivity: now - 26 * min, solo: true }),
    agent({ name: 'blerp-fuzz', state: 'busy', model: 'claude-opus-5-5', effort: 'max', cwd: '/home/user/projects/blerp', lastActivity: now - 5_000, isBackgroundJob: true, jobId: 'bg-4411', remoteControl: true }),
    agent({ name: 'lab-website', state: 'ended', model: 'claude-haiku-5-5', modelIsGuess: true, effort: null, cwd: '/home/user/projects/lab-site', lastActivity: now - 2 * day, tokensEstimated: true }),
  ];

  const archive = {
    'fx-arch-1': { id: 'fx-arch-1', sessionId: 'fx-arch-1', name: 'old-experiment', teamName: null, isLead: false, model: 'claude-sonnet-5-5', effort: 'low',
      cwd: '/home/user/projects/scratch', transcriptPath: '/home/user/.claude/projects/x/fx-arch-1.jsonl', tokensOut: 12_300, tokensTotal: 512_000, archivedAt: now - 5 * hour },
    'fx-arch-2': { id: 'fx-arch-2', sessionId: 'fx-arch-2', name: 'livebox-lead', teamName: 'session-11aa22bb', isLead: true, model: 'claude-opus-5-5', effort: 'high',
      cwd: '/home/user/projects/livebox', transcriptPath: null, tokensOut: 88_000, tokensTotal: 3_100_000, archivedAt: now - 3 * day },
  };

  return {
    teams: [team(t1, now - 2 * hour, [lead1, w1, w2, w3, w4]), team(t2, now - 6 * hour, [lead2, w5])],
    loose,
    meters: [
      { id: 'Current session', label: 'Current session', percent: 42, resets: '3:40pm (America/New_York)', window: 5 * hour, resetDate: now + 2 * hour + 10 * min,
        elapsed: 0.57, projected: 74, remainingText: '2시간 10분 남음' },
      { id: 'Current week (all models)', label: 'Current week (all models)', percent: 68, resets: 'Oct 23, 9am (America/New_York)', window: 7 * day, resetDate: now + 2 * day + 20 * hour,
        elapsed: 0.59, projected: 112, remainingText: '2일 20시간 남음' },
      { id: 'Current week (Fable)', label: 'Current week (Fable)', percent: 91, resets: 'Oct 23, 9am (America/New_York)', window: 7 * day, resetDate: now + 2 * day + 20 * hour,
        elapsed: 0.59, projected: 148, remainingText: '2일 20시간 남음' },
    ],
    usageUpdated: now - 2 * min, usageError: null, usageBusy: false,
    rebooting: false, rebootGen: 1, firstScanDone: true, loggedOut: false,
    selectedTeam: null, selectedAgent: null,
    notice: "'store' 세션이 응답을 기다립니다",
    noticeLog: [
      { id: 'n3', at: now - 40_000, text: "'store' 세션이 응답을 기다립니다" },
      { id: 'n2', at: now - 6 * min, text: "'renderer'에 메시지를 보냈습니다" },
      { id: 'n1', at: now - 18 * min, text: '사용량을 새로 읽었습니다' },
    ],
    launches: [{ id: 'ab-new-1', tmuxName: 'ab-new-1', name: 'thesis-figs', cwd: '/home/user/research/thesis/figures/chapter-3', created: now - 20_000, phase: 'needsTrust', screenTail: '', attachJob: null, resume: null }],
    spawnChecks: [{ id: 'sc1', leadPane: lead1.tmuxPane, specs: [{ id: 's1', name: 'renderer', role: 'UI', model: 'claude-opus-5-5', effort: 'medium' }, { id: 's2', name: 'packager', role: 'deb/rpm', model: 'claude-sonnet-5-5', effort: 'low' }],
      started: now - 37_000, results: { renderer: 'ok', packager: 'waiting' }, leadScreen: '', reason: '', done: false }],
    selection: [w1.sessionId, w3.sessionId],
    archive, archiveSelection: [],
    promptSending: [], sending: [], rcPending: [], bounce: {}, pulled: {}, lastSentAt: {}, navRequest: null, launchTab: null,
    chatVersion: {}, emptyTeams: [], spawnable: {}, readonly: true,
  };
}

/** Chat rows for the team detail views (store.getChat), keyed by session id: none in this fixture. */
export function fixtureChat() { return {}; }
