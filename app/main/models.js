// Port of Models.swift: the plain data the board works with (Agent, Team, UsageMeter, Launch, SpawnCheck, ArchivedItem …)
// and their computed values. Objects are plain JS objects with the Swift field names; Dates are epoch milliseconds.
const crypto = require('crypto');
const { L } = require('./l10n');

const uuid = () => crypto.randomUUID().toUpperCase();

// ── TokenUsage ───────────────────────────────────────────────────────────────────────────
function tokenUsage(t = {}) { return { input: t.input || 0, cacheWrite: t.cacheWrite || 0, cacheRead: t.cacheRead || 0, output: t.output || 0 }; }
function tokensTotal(t) { return (t.input || 0) + (t.cacheWrite || 0) + (t.cacheRead || 0) + (t.output || 0); }
function tokensAdd(a, b) {
  return { input: a.input + b.input, cacheWrite: a.cacheWrite + b.cacheWrite, cacheRead: a.cacheRead + b.cacheRead, output: a.output + b.output };
}

// AgentState: 'busy' | 'idle' | 'ended' | 'unknown' | 'needsInput' (needsInput: a permission / choice prompt waits for the user)
const AgentStates = ['busy', 'idle', 'ended', 'unknown', 'needsInput'];

// ── Agent: one Claude session, living or ended, as the board understands it ──────────────────
/** Agent(sessionId:pid:name:state:) with every other field at its Swift default. */
function newAgent(sessionId, pid = null, name = '', state = 'unknown') {
  return {
    sessionId, pid, name,
    nameSource: null,
    teamAddress: null,       // e.g. verifier@session-039ac1c1
    teamName: null,
    agentType: null,         // team-lead / general-purpose / ...
    isLead: false,
    state,
    tmuxPane: null,          // "%4"
    tmuxSession: null,       // tmux session that holds the pane
    cwd: null,
    model: null,
    effort: null,
    prompt: null,            // the choice window the agent waits on (state == needsInput)
    screen: null,            // what the CLI shows around its input box (spinner verb / elapsed / mode …)
    contextTokens: null,     // size of the context the last request carried (input + cache), for the usage bar
    stateUnconfirmed: false, // status file and screen disagree for 10 s+ (display hint: "확인 중")
    modelIsGuess: false,     // taken from the launch flag, not seen in the transcript
    tokens: tokenUsage(),
    tokensEstimated: false,  // last run's numbers shown while the transcript is still being parsed
    lastActivity: null,
    transcriptPath: null,
    pendingName: null,
    entrypoint: null,        // cli / claude-desktop / ...
    jobId: null,             // the CLI's background-job id (`claude agents` / ~/.claude/jobs)
    isBackgroundJob: false,  // session file kind "bg": a background job (often a fork of another session's conversation)
    remoteControl: null,     // null = unknown (teammates have no session file)
    origin: null,            // "board" when this app started it
    isSubagent: false,       // an in-process helper the session spawned with its Agent tool (no pane: view only)
    parentSid: null,
    solo: false,             // lead of an implicit one-person team: shown as an individual session
    pendingCommands: [],
    queued: 0,               // messages waiting in the CLI's own queue (transcript queue-operation records)
    parkedJobId: null,       // an interactive CLI whose conversation moved to a background job (its "← agents" screen): the job is the session
    overlay: null,           // the pane shows a CLI screen instead of the conversation ("agents" list, "resume" picker): typing there never reaches the agent
    viewerPid: null,         // for a background job: the interactive / `claude attach` process that shows it in tmuxPane
    requestedModel: null,    // chosen in the app, shown at once
    requestedEffort: null,
  };
}
const copyAgent = (a) => ({ ...a, tokens: { ...a.tokens }, pendingCommands: [...a.pendingCommands] });

function pretty(m) {
  const parts = m.split('-').filter((p) => p.length > 0);
  if (parts.length < 3 || parts[0] !== 'claude') return m;
  const fam = parts[1].slice(0, 1).toUpperCase() + parts[1].slice(1);
  let ver = parts[2];
  if (parts.length > 3 && [...parts[3]].length <= 2) ver += '.' + parts[3];
  return `${fam} ${ver}`;
}
function displayModel(a) {
  if (a.model == null) return L('모델 미확인');
  if (a.modelIsGuess) return pretty(a.model) + ' ?';
  return pretty(a.model);
}
/** Any shown value that is a guess / stale (launch-flag model, cached tokens): render it dimmed. */
const isEstimated = (a) => a.modelIsGuess || a.tokensEstimated;
/** Running a turn or stuck on a prompt: nothing may be typed into it. */
const working = (a) => a.state === 'busy' || a.state === 'needsInput';
const canReceiveInput = (a) => a.tmuxPane != null && a.state !== 'ended' && a.overlay == null;
/** Context window of the model: 1M for "[1m]" variants, 200k otherwise. */
const contextWindow = (a) => ((a.model || '').includes('[1m]') || (a.model || '').endsWith('-1m') ? 1000000 : 200000);
/** Permission mode the CLI footer shows, in Korean ("기본" when the footer says nothing). */
function modeLabel(a) {
  const m = a.screen ? a.screen.mode : null;
  switch (m) {
    case 'auto mode': return L('자동 모드');
    case 'accept edits': return L('편집 자동 허용');
    case 'plan mode': return L('계획 모드');
    case 'bypass permissions': return L('권한 확인 없음');
    case null: case undefined: return L('기본 모드');
    default: return m;
  }
}
/** The agent as the renderer gets it: every field plus the computed values. */
function agentJSON(a) {
  return { ...a, displayModel: displayModel(a), isEstimated: isEstimated(a), working: working(a), canReceiveInput: canReceiveInput(a),
    contextWindow: contextWindow(a), modeLabel: modeLabel(a) };
}

// ── Team ─────────────────────────────────────────────────────────────────────────────────
function newTeam(name, createdAt = null, leadSessionId = null, members = []) { return { name, createdAt, leadSessionId, members }; }
const teamLead = (t) => t.members.find((m) => m.isLead) || null;
const teamWorkers = (t) => t.members.filter((m) => !m.isLead);
const teamLiveCount = (t) => t.members.filter((m) => m.state === 'busy' || m.state === 'idle' || m.state === 'needsInput').length;
const teamTokens = (t) => t.members.map((m) => m.tokens).reduce(tokensAdd, tokenUsage());
/** A team that is only its own lead (every session is one, implicitly). */
function teamIsSolo(t) { const m = t.members.filter((x) => !x.isSubagent); return m.length === 1 && m[0].isLead; }
/** Lead's conversation name when it has one; the raw team id otherwise. */
function teamDisplayName(t) {
  const l = teamLead(t);
  if (l && l.name && l.name !== 'team-lead' && !l.name.startsWith(t.name)) return l.name;
  return t.name;
}
function teamJSON(t) {
  const l = teamLead(t);
  return { name: t.name, id: t.name, createdAt: t.createdAt, leadSessionId: t.leadSessionId, members: t.members.map(agentJSON),
    lead: l ? l.sessionId : null, liveCount: teamLiveCount(t), isSolo: teamIsSolo(t), displayName: teamDisplayName(t), tokens: teamTokens(t) };
}

// ── ModelChoice / EffortChoice ───────────────────────────────────────────────────────────
// The plain aliases (haiku/sonnet/opus) resolve to the newest of each family in this CLI build.
const ModelChoice = [
  { id: 'claude-fable-5-1', key: 'fable', label: 'Fable 5.1' },
  { id: 'claude-opus-5-5', key: 'opus', label: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', key: 'sonnet', label: 'Sonnet 5.5' },
  { id: 'claude-haiku-5-5', key: 'haiku', label: 'Haiku 5.5' },
  { id: 'claude-haiku-4-5', key: 'haiku45', label: 'Haiku 4.5' },
];
const EffortChoice = ['low', 'medium', 'high', 'xhigh', 'max'];
const isModelChoice = (m) => ModelChoice.some((c) => c.id === m);
const isEffortChoice = (e) => EffortChoice.includes(e);
/** ModelChoice.allCases.first { (m ?? "").hasPrefix($0.rawValue) } ?? fallback */
const modelChoiceFor = (m, fallback) => (ModelChoice.find((c) => (m || '').startsWith(c.id)) || { id: fallback }).id;
const effortChoiceFor = (e, fallback) => (isEffortChoice(e || '') ? e : fallback);

// ── TeammateSpec ─────────────────────────────────────────────────────────────────────────
/** A teammate requested in the new-session sheet or the add-teammate sheet: {id, name, role, model, effort}. */
function teammateSpec(s = {}) {
  return { id: s.id || uuid(), name: s.name || '', role: s.role || '', model: isModelChoice(s.model) ? s.model : 'claude-sonnet-5-5',
    effort: isEffortChoice(s.effort) ? s.effort : 'low' };
}
/** Claude's Agent tool only accepts ASCII letters, digits, '_' and '-' as a teammate name (Korean names are rejected). */
const nameIsValid = (s) => !!s.name && /^[A-Za-z0-9_-]+$/.test(s.name);

// ── Launch: a session the board started that has not registered with Claude yet ─────────────
// phase: 'starting' | 'needsTrust' | 'needsSetup' | 'exited' | 'stuck'
function newLaunch(tmuxName, name, cwd) {
  return { id: tmuxName, tmuxName, name, cwd, created: Date.now(), phase: 'starting', screenTail: '',
    attachJob: null,          // `claude attach <job>`: has no session file of its own
    resume: null };           // `claude --resume`: what to retry with when the CLI refuses ({sid, model, effort, bypass})
}

// ── SpawnCheck: verifies that teammates the board asked for were actually created ─────────────
// results[name]: 'waiting' | 'ok' | 'failed' | {mismatch: "<what differs>"}
function newSpawnCheck(leadPane, specs) {
  return { id: uuid(), leadPane, specs, started: Date.now(), results: {}, leadScreen: '', reason: '' };
}
const spawnDone = (c) => c.specs.every((s) => c.results[s.name] != null && c.results[s.name] !== 'waiting');
const spawnCheckJSON = (c) => ({ ...c, done: spawnDone(c) });

// ── UsageMeter ───────────────────────────────────────────────────────────────────────────
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** Offset (ms) of a time zone from UTC at instant t. Throws for an unknown zone. */
function tzOffset(t, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
  const p = {}; for (const x of f.formatToParts(new Date(t))) p[x.type] = Number(x.value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Math.floor(t / 1000) * 1000;
}
/** Wall-clock time in a zone (null = local) -> epoch ms. */
function zoned(y, mo, d, h, mi, tz) {
  if (!tz) return new Date(y, mo, d, h, mi).getTime();
  const guess = Date.UTC(y, mo, d, h, mi);
  const off = tzOffset(guess, tz);
  let t = guess - off;
  const off2 = tzOffset(t, tz);
  if (off2 !== off) t = guess - off2;
  return t;
}
function validZone(z) { try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return true; } catch { return false; } }
/** Length of the limit window: 5 h for the session limit, 7 days for weekly ones (seconds). */
const meterWindow = (m) => (m.label.toLowerCase().includes('session') ? 5 * 3600 : 7 * 86400);
/** "Oct 14 at 3:59pm (America/New_York)" -> epoch ms. Same formats as the Swift DateFormatter list:
 *  "MMM d 'at' h:mma", "MMM d 'at' ha", "MMM d, h:mma", "MMM d, ha". */
function resetDate(m) {
  let s = m.resets, tz = null;
  const o = s.indexOf('('), c = s.indexOf(')');
  if (o >= 0 && c >= 0 && o < c) {
    const z = s.slice(o + 1, c);
    if (validZone(z)) tz = z;
    s = s.slice(0, o);
  }
  s = s.trim();
  const r = /^([A-Za-z]{3})\s+(\d{1,2})(?:\s+at|,)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(s);
  if (!r) return null;
  const mo = MONTHS.indexOf(r[1].toLowerCase());
  const h12 = Number(r[3]);
  if (mo < 0 || h12 < 1 || h12 > 12) return null;
  const h = (h12 % 12) + (r[5].toLowerCase() === 'pm' ? 12 : 0);
  const year = new Date().getFullYear();
  let d = zoned(year, mo, Number(r[2]), h, Number(r[4] || 0), tz);
  if (d < Date.now() - 86400 * 1000) d = zoned(year + 1, mo, Number(r[2]), h, Number(r[4] || 0), tz);
  return d;
}
/** Fraction of the current window already elapsed (0…1). */
function meterElapsed(m) {
  const r = resetDate(m);
  if (r == null) return null;
  return Math.min(1, Math.max(0, 1 - ((r - Date.now()) / 1000) / meterWindow(m)));
}
/** Where usage ends at the current pace (percent of the limit; can pass 100). */
function meterProjected(m) {
  const e = meterElapsed(m);
  if (e == null || !(e > 0.02)) return null;
  return Math.round(m.percent / e);
}
function remainingText(m) {
  const r = resetDate(m);
  if (r == null) return '';
  const s = Math.max(0, Math.trunc((r - Date.now()) / 1000));
  if (s >= 86400) return L('%@일 %@시간 남음', String(Math.trunc(s / 86400)), String(Math.trunc((s % 86400) / 3600)));
  return L('%@시간 %@분 남음', String(Math.trunc(s / 3600)), String(Math.trunc((s % 3600) / 60)));
}
function meterJSON(m) {
  return { id: m.label, label: m.label, percent: m.percent, resets: m.resets, window: meterWindow(m), resetDate: resetDate(m),
    elapsed: meterElapsed(m), projected: meterProjected(m), remainingText: remainingText(m) };
}

// ── NoticeItem / NavRequest ──────────────────────────────────────────────────────────────
const noticeItem = (text) => ({ id: uuid(), at: Date.now(), text });
const navRequest = (tab) => ({ tab, token: uuid() });

// ── Swift Codable dates: the macOS app's files store Date as seconds since 2001-01-01 ─────────
const REF = 978307200;
const toSwiftDate = (ms) => ms / 1000 - REF;
const fromSwiftDate = (s) => (typeof s === 'number' ? Math.round((s + REF) * 1000) : null);
/** JSONEncoder leaves nil optionals out: drop null / undefined keys before writing. */
function compact(o) { const r = {}; for (const k in o) if (o[k] != null) r[k] = o[k]; return r; }

// ── ArchivedItem: a session moved to the archive (hidden from the board, files untouched, restorable) ─
function archivedItem(a) {
  return { id: a.sessionId, sessionId: a.sessionId, name: a.name, teamName: a.teamName ?? null, isLead: !!a.isLead, model: a.model ?? null,
    effort: a.effort ?? null, cwd: a.cwd ?? null, transcriptPath: a.transcriptPath ?? null, tokensOut: a.tokensOut || 0,
    tokensTotal: a.tokensTotal || 0, archivedAt: a.archivedAt ?? Date.now() };
}
const archivedFromDisk = (j) => archivedItem({ ...j, archivedAt: fromSwiftDate(j.archivedAt) ?? Date.now() });
function archivedToDisk(it) {
  const { id, ...rest } = it;
  return compact({ ...rest, archivedAt: toSwiftDate(it.archivedAt) });
}

module.exports = {
  uuid, tokenUsage, tokensTotal, tokensAdd, AgentStates,
  newAgent, copyAgent, pretty, displayModel, isEstimated, working, canReceiveInput, contextWindow, modeLabel, agentJSON,
  newTeam, teamLead, teamWorkers, teamLiveCount, teamTokens, teamIsSolo, teamDisplayName, teamJSON,
  ModelChoice, EffortChoice, isModelChoice, isEffortChoice, modelChoiceFor, effortChoiceFor,
  teammateSpec, nameIsValid,
  newLaunch, newSpawnCheck, spawnDone, spawnCheckJSON,
  meterWindow, resetDate, meterElapsed, meterProjected, remainingText, meterJSON,
  noticeItem, navRequest,
  toSwiftDate, fromSwiftDate, compact, archivedItem, archivedFromDisk, archivedToDisk,
};
