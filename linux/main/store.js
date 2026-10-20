// Port of BoardStore.swift (+ PromptNotifier.swift's logic and AppDelegate's shutdown-on-quit from App.swift).
//
// Single source of truth. Rebuilt from Claude's own files on every tick; the only thing the board persists is a memory of
// members it has seen, so an ended teammate keeps its card until the team itself is gone.
//
// Port notes:
//  - Swift @Published vars live in `S` and reach the window as one JSON snapshot (send('state', …), throttled to one push
//    per 150 ms, only when something changed). Dates are epoch ms; Sets are arrays.
//  - An `Agent` parameter of a Swift method is the agent's sessionId here (the exported wrappers look it up); the
//    internal functions keep the Swift names and take agent objects, so the two files can be read side by side.
//  - Swift's blocking calls on background queues are async functions here; calls Swift makes synchronously on the main
//    thread inside refresh() (ps for a new pid, tmux list-panes for a launch) use the sync helpers, read /proc first.
//  - AB_READONLY=1: every action that would change a session, tmux, or a file under ~/.claude or ~/.agent-boost logs
//    "[readonly] <action>" and does nothing; start-up routines that act are skipped. Reading and polling continue.
const fs = require('fs');
const path = require('path');
const os = require('os');
const Shell = require('./shell');
const { L } = require('./l10n');
const M = require('./models');
const { newAgent, copyAgent, working } = M;

// ── sibling modules (ported from their Swift files in parallel; loaded lazily: some require this one) ────────────────
function mod(n) {
  try { return require('./' + n); } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND' && String(e.message).includes(`'./${n}'`)) return null;
    throw e;
  }
}
const tmuxMod = () => mod('tmux') || {};
/** TmuxControl.* */
const TmuxControl = () => { const t = tmuxMod(); return t.TmuxControl || t; };
/** TmuxCache.* */
const TmuxCache = () => { const t = tmuxMod(); return t.TmuxCache || t.cache || t; };
const Screen = () => mod('screen') || {};
let readerInstance = null;
/** The one TranscriptReader the store keeps (Swift: `private let reader = TranscriptReader()`). */
function reader() {
  if (readerInstance) return readerInstance;
  const t = mod('transcript') || {};
  readerInstance = t.shared || (typeof t.TranscriptReader === 'function' ? new t.TranscriptReader() : t);
  return readerInstance;
}
/** TranscriptReader.Mode: skip / light / full. */
function Mode(name) { const t = mod('transcript') || {}; return t.Mode && t.Mode[name] !== undefined ? t.Mode[name] : name; }
const platform = () => mod('platform') || {};
/** SendLog.note (lives with TmuxControl). */
function sendLogNote(s) {
  const t = tmuxMod();
  try { if (t.SendLog && t.SendLog.note) t.SendLog.note(s); else if (t.note) t.note(s); } catch { }
}
let electron = null;
try { if (process.versions.electron) electron = require('electron'); } catch { }

const RO = !!process.env.AB_READONLY;
/** AB_READONLY guard: true = refuse (and say so on the console). */
function ro(action) { if (!RO) return false; console.log(`[readonly] ${action}`); return true; }

// ── small helpers ─────────────────────────────────────────────────────────────────────────────────────────────────
const home = Shell.home;
const ab = (f) => home + '/.agent-boost/' + f;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
const ms = (d) => (d == null ? null : d instanceof Date ? d.getTime() : typeof d === 'number' ? d : (Number.isNaN(Date.parse(d)) ? null : Date.parse(d)));
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isExecutable = (p) => { try { if (!fs.statSync(p).isFile()) return false; fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } };
const readdir = (p) => { try { return fs.readdirSync(p); } catch { return null; } };
const readJSON = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const stat = (p) => { try { return fs.statSync(p); } catch { return null; } };
const basenameNoExt = (p) => path.basename(p).replace(/\.[^.]*$/, '');
const prefixChars = (s, n) => Array.from(s).slice(0, n).join('');
const suffixChars = (s, n) => { const a = Array.from(s); return a.slice(Math.max(0, a.length - n)).join(''); };
const trimWS = (s) => s.replace(/^[\t\p{Zs}]+|[\t\p{Zs}]+$/gu, '');
const trimAll = (s) => s.trim();
const lines = (s) => s.split('\n').filter((l) => l.length > 0);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const isHex = (s) => /^[0-9a-fA-F]+$/.test(s);
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function signal(pid, sig) { try { process.kill(pid, sig); } catch { } }
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}
/** Head of a file (at most n bytes) as text. */
function readHead(p, n) {
  let fd; try { fd = fs.openSync(p, 'r'); const b = Buffer.alloc(n); const got = fs.readSync(fd, b, 0, n, 0); return b.subarray(0, got); } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { } }
}
/** Tail of a file from max(0, size - n). */
function readTail(p, n) {
  let fd; try {
    fd = fs.openSync(p, 'r'); const size = fs.fstatSync(fd).size; const from = size > n ? size - n : 0;
    const b = Buffer.alloc(size - from); const got = fs.readSync(fd, b, 0, size - from, from); return { size, data: b.subarray(0, got) };
  } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { } }
}
function writeFileSafe(p, data) { try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); return true; } catch { return false; } }
/** Moves a file or folder to the desktop Trash (recoverable). false when the Trash refused. */
async function trashItem(p) {
  try { const pl = platform(); if (pl.trash) { const r = await pl.trash(p); if (r !== false) return true; } } catch { }
  if (electron && electron.shell && electron.shell.trashItem) { try { await electron.shell.trashItem(p); return true; } catch { } }
  for (const argv of [['gio', 'trash', p], ['trash-put', p], ['kioclient5', 'move', p, 'trash:/']]) {
    const r = await Shell.run(argv, { timeout: 15 });
    if (r.code === 0 && !exists(p)) return true;
  }
  return false;
}
function removeItem(p) { try { fs.rmSync(p, { recursive: true, force: false }); return true; } catch { return false; } }

// ── @Published state ─────────────────────────────────────────────────────────────────────────────────────────────
const S = {
  teams: [],
  loose: [],                 // live sessions not in any team
  meters: [],
  usageUpdated: null,
  usageError: null,
  usageBusy: false,
  rebooting: false,          // the refresh button: gauges run their power-on sweep, the rocket flies
  rebootGen: 0,
  loggedOut: false,          // the CLI is installed but has no account signed in
  firstScanDone: false,      // UI only: the board shows its loading look until the first scan lands
  selectedTeam: null,
  selectedAgent: null,
  notice: null,
  noticeLog: [],
  launches: [],
  spawnChecks: [],
  navRequest: null,
  selection: new Set(),      // name cards checked on the board
  archive: {},
  archiveSelection: new Set(),
  promptSending: new Set(),  // sessionIds with an answer on its way
  sending: new Set(),        // sessions whose message is still being typed into the CLI (it may be reading pasted images)
  rcPending: new Set(),
  bounce: { sid: '', gen: 0 },
  pulled: { sid: '', gen: 0, texts: [] },   // queued messages taken back out of the CLI's queue
  lastSentAt: null,          // not @Published in Swift: only ChatView reads it, at scroll time
  launchTab: null,
};
const chat = {};             // sessionId -> [ChatEntry] (not in the snapshot: store.getChat)
const chatVersion = {};      // sessionId -> bumped whenever chat[sid] changes
function setChat(sid, entries) {
  if (entries == null) delete chat[sid]; else chat[sid] = entries;
  chatVersion[sid] = (chatVersion[sid] || 0) + 1;
  changed();
}

/** Every notice is also kept in a log the alert strip can scroll back through. */
function setNoticeValue(n) {
  const old = S.notice;
  S.notice = n == null ? null : n;
  if (n != null && n !== old) { S.noticeLog.unshift(M.noticeItem(n)); if (S.noticeLog.length > 300) S.noticeLog.length = 300; }
  changed();
}
/** selectedAgent didSet: the last few chosen sessions keep their chat current. */
function setSelectedAgentValue(v) {
  S.selectedAgent = v == null ? null : v;
  if (v != null) { recentFocus = recentFocus.filter((x) => x !== v); recentFocus.push(v); if (recentFocus.length > 5) recentFocus.shift(); }
  changed();
}

/** Chats kept current: the last few chosen sessions (other tabs keep theirs on screen) and every open split pane.
 *  Only the selected one used to be read, so a chat shown elsewhere froze (its sent message stuck as "전송 중"). */
let recentFocus = [];
const paneChats = {};
function liveChats() {
  // terminal-screen mode: chats with a pane are not rebuilt from the transcript at all
  const ids = new Set(recentFocus);
  for (const [k, v] of Object.entries(paneChats)) if (v > 0) ids.add(k);
  const all = allAgents();
  const out = new Set();
  for (const id of ids) {
    const a = all.find((x) => x.sessionId === id);
    if (!(a ? a.tmuxPane != null && a.state !== 'ended' : false)) out.add(id);
  }
  return out;
}
const allAgents = () => S.teams.flatMap((t) => t.members).concat(S.loose);

// ── private state ────────────────────────────────────────────────────────────────────────────────────────────────
const archiveURL = ab('archived.json');
const pendingRenames = {};    // sessionId -> name (sent when idle)
const pendingCommands = {};   // sessionId -> slash commands (sent when idle)
const deletedURL = ab('deleted-sessions.json');
let deleted = new Set();
let timer = null;
let tick = 0;
const transcriptIndex = {};   // sessionId -> path
let paneSessionMap = {};      // pane -> tmux session name
const memoryURL = ab('seen-members.json');
let seen = {};                // team -> sessionId -> SeenMember (dates in ms)
/** Human names for CLI background jobs (the CLI names a job by its id): the name of the interactive session whose
 *  conversation was moved into the job, kept so the card reads the same once that viewer is gone. */
const jobNamesURL = ab('job-names.json');
let jobNames = {};
let lastJobs = {};            // ~/.claude/jobs as of the last refresh
let started = false;
const prefs = { 'ui.cliSuggest': true, 'new.bypass': true, 'ui.showNotices': true };   // renderer @AppStorage values the store reads

function seenFromDisk(m) {
  const out = {};
  for (const [t, b] of Object.entries(m || {})) {
    out[t] = {};
    for (const [sid, sm] of Object.entries(b || {})) out[t][sid] = { ...sm, firstSeen: M.fromSwiftDate(sm.firstSeen) ?? now(), lastSeen: M.fromSwiftDate(sm.lastSeen) ?? now() };
  }
  return out;
}
function seenToDisk() {
  const out = {};
  for (const [t, b] of Object.entries(seen)) {
    out[t] = {};
    for (const [sid, sm] of Object.entries(b)) out[t][sid] = M.compact({ ...sm, firstSeen: M.toSwiftDate(sm.firstSeen), lastSeen: M.toSwiftDate(sm.lastSeen) });
  }
  return out;
}

function init() {
  const m = readJSON(memoryURL); if (m && typeof m === 'object') seen = seenFromDisk(m);
  const d = readJSON(deletedURL); if (Array.isArray(d)) deleted = new Set(d);
  const j = readJSON(jobNamesURL); if (j && typeof j === 'object') jobNames = j;
  // older boards kept a session list of their own; the CLI's files are the list now
  if (exists(ab('seen-sessions.json')) && !ro('remove ~/.agent-boost/seen-sessions.json')) { try { fs.unlinkSync(ab('seen-sessions.json')); } catch { } }
  const a = readJSON(archiveURL);
  if (a && typeof a === 'object') for (const [k, v] of Object.entries(a)) S.archive[k] = M.archivedFromDisk(v);
  // after init: the notice reaches the log
  setImmediate(() => {
    if (!isExecutable(Shell.tmuxPath)) {
      setNoticeValue(L('tmux를 찾을 수 없습니다 (%@). 세션 시작·입력·종료가 동작하지 않습니다. 설치: sudo apt install tmux (Fedora: dnf, Arch: pacman)', Shell.tmuxPath));
    } else if (!isExecutable(Shell.claude)) {
      setNoticeValue(L('Claude Code CLI를 찾을 수 없습니다 (%@). 설치: https://claude.ai/code 안내를 따르거나 터미널에서 npm install -g @anthropic-ai/claude-code', Shell.claude));
    }
  });
  const args = process.argv;
  let i = args.indexOf('--tab'); if (i >= 0 && i + 1 < args.length) { S.selectedTeam = args[i + 1]; S.launchTab = args[i + 1]; }
  i = args.indexOf('--agent'); if (i >= 0 && i + 1 < args.length) setSelectedAgentValue(args[i + 1]);
  registerTmuxHooks();
  if (!ro('tmux set-environment -g PATH')) Shell.tmux(['set-environment', '-g', 'PATH', Shell.path]);
  try { const c = mod('clicheck'); if (c && c.start) c.start(module.exports); } catch (e) { console.error('clicheck', e); }
  // conversation search reads every transcript once (~0.5 s); done ahead so the search window opens at once
  setTimeout(() => { try { const s = mod('search'); if (s && s.refresh) s.refresh(); } catch (e) { console.error('search', e); } }, 15000);
  // the tmux cache must exist before the first refresh: otherwise every pane is unknown ("view only" flicker) and
  // resumeSavedSessions would judge liveness from an empty cache
  afterFirstRefresh = () => {
    if (emptyTeams().length > 0) { if (!ro('pruneEmptyTeams')) pruneEmptyTeams(true); }
    if (!process.argv.includes('--snapshot') && !process.env.AB_SNAPSHOT) { if (!ro('resumeSavedSessions')) resumeSavedSessions(); }
  };
  refreshSoon();
  timer = setInterval(() => refreshSoon(), 2000);
  fetchUsage();
}

/** TmuxCache.onAutoConfirm / TmuxControl.onWarning / onLost / onDone, exactly as BoardStore.init sets them. */
function registerTmuxHooks() {
  const hooks = {
    onAutoConfirm: (pane) => {
      const a = allAgents().find((x) => x.tmuxPane === pane);
      if (!a) return;
      addEcho(L('모델 전환 확인창에 자동으로 Yes를 선택했습니다 (직접 고른 모델 변경)'), a.sessionId, 60, true);
    },
    onWarning: (m) => setNoticeValue(m),
    onLost: (sid) => {
      S.bounce = { sid, gen: S.bounce.gen + 1 };
      const a = agent(sid);
      setNoticeValue(L("'%@'이(가) 메시지를 받지 않았습니다. 입력창에 되돌려 놓았으니 다시 보내 주세요.", a ? a.name : L('세션')));
    },
    onDone: (sid) => { S.sending.delete(sid); changed(); },
  };
  const t = tmuxMod();
  for (const [name, fn] of Object.entries(hooks)) {
    const setter = 'set' + name[0].toUpperCase() + name.slice(1);
    let done = false;
    for (const target of [t, t.TmuxControl, t.TmuxCache, t.cache]) {
      if (!target) continue;
      if (typeof target[setter] === 'function') { target[setter](fn); done = true; break; }
    }
    if (done) continue;
    if (name === 'onAutoConfirm' && (t.TmuxCache || t.cache)) (t.TmuxCache || t.cache).onAutoConfirm = fn;
    else if (t.TmuxControl && name !== 'onAutoConfirm') t.TmuxControl[name] = fn;
    t[name] = fn;
  }
}

// ── TmuxCache / TmuxControl / reader adapters (one place, so the call sites read like the Swift) ───────────────────
const val = (o, k) => (o && typeof o[k] === 'function' ? o[k]() : o ? o[k] : undefined);
const Cache = {
  update: () => TmuxCache().update(),
  panes: () => val(TmuxCache(), 'panes') || {},
  paneSessions: () => val(TmuxCache(), 'paneSessions') || {},
  state: (p) => TmuxCache().state(p) ?? null,
  prompt: (p) => TmuxCache().prompt(p) ?? null,
  overlay: (p) => TmuxCache().overlay(p) ?? null,
  foreignTyped: (p) => !!TmuxCache().foreignTyped(p),
  status: (p) => TmuxCache().status(p) ?? null,
  busy: (p) => TmuxCache().busy(p) ?? null,
  setWanted: (s) => TmuxCache().setWanted(s),
  expectModelConfirm: (p) => TmuxCache().expectModelConfirm(p),
  markSent: (p, busy) => TmuxCache().markSent(p, busy),
  isSettled: (p) => !!TmuxCache().isSettled(p),
  probe: (p) => TmuxCache().probe(p),
};

// ── refresh ──────────────────────────────────────────────────────────────────────────────────────────────────────
/** Collects tmux state in the background, then refreshes (cheap: no process spawns). */
let refreshing = false, refreshDirty = false;
let afterFirstRefresh = null;
function refreshSoon() {
  if (refreshing) { refreshDirty = true; return; }     // coalesce: run once more when the current one ends
  refreshing = true;
  (async () => {
    try { await Cache.update(); } catch (e) { console.error('TmuxCache.update', e); }
    try { refresh(); } catch (e) { console.error('refresh', e); }
    if (!S.firstScanDone) S.firstScanDone = true;   // set once; never published again
    if (afterFirstRefresh) { const f = afterFirstRefresh; afterFirstRefresh = null; try { f(); } catch (e) { console.error(e); } }
    refreshing = false;
    changed();
    if (refreshDirty) { refreshDirty = false; refreshSoon(); }
  })();
}

function refresh() {
  tick += 1;
  const panes = Cache.panes();
  const paneSess = Cache.paneSessions();
  paneSessionMap = paneSess;
  const paneByPid = {};
  for (const [pane, pid] of Object.entries(panes)) if (!(pid in paneByPid)) paneByPid[pid] = pane;
  const jobs = loadJobs(); lastJobs = jobs;
  const sessions = loadSessions(paneByPid, jobs);
  const parkedOriginals = mergeViewers(sessions, panes);
  for (const a of Object.values(sessions)) {
    if (a.tmuxPane != null && (paneSess[a.tmuxPane] || '').startsWith('ab-')) a.origin = 'board';
  }
  const [teamsRaw, memberSessionIds] = loadTeams(sessions, panes, parkedOriginals);
  const focus = liveChats();
  const all = teamsRaw;
  let looseAgents = [];
  for (const s of Object.values(sessions)) {
    if (memberSessionIds.has(s.sessionId) || S.archive[s.sessionId]) continue;
    const a = copyAgent(s);
    enrich(a, focus.has(a.sessionId));
    looseAgents.push(a);
  }
  // a conversation the CLI still lists as a background job is drawn from the job record below, never twice
  const jobSids = new Set(Object.values(jobs).flatMap((j) => [j.sessionId, j.resumeSessionId].filter((x) => x != null)));
  // ended conversations = every transcript the CLI could resume (what its /resume picker lists) that is not running
  // anywhere. The board keeps no list of its own, so it cannot drift from the CLI's: a transcript removed elsewhere drops
  // its card, one made elsewhere (a terminal, the desktop app) gets one.
  // (a parked viewer's own transcript is the frozen pre-move copy of a conversation that now lives in the job: not a card
  // while the viewer is alive, just as `claude agents` does not list the viewer)
  const claimed = new Set([...Object.keys(sessions), ...memberSessionIds, ...jobSids, ...parkedOriginals]);
  const memberPaths = new Set([...memberSessionIds].map((s) => transcriptIndex[s]).filter((x) => x != null));   // teammates' transcripts belong to their team cards
  for (const { sid, path: p } of transcriptList()) {
    if (claimed.has(sid) || memberPaths.has(p) || S.archive[sid]) continue;
    if (transcriptIndex[sid] !== p) transcriptIndex[sid] = p;
    const a = newAgent(sid, null, '', 'ended');
    a.cwd = transcriptCwd(p);
    enrich(a, focus.has(sid));
    if (!a.name) a.name = prefixChars(sid, 8);
    looseAgents.push(a);
  }
  // CLI background jobs with no live process: the CLI's own list (`claude agents`, its ← screen) still shows them, so
  // the board does too. One card per job, matched by job id: a job's session id changes when the CLI resumes it.
  const liveJobs = new Set(Object.values(sessions).map((a) => a.jobId).filter((x) => x != null));
  for (const job of Object.values(jobs).sort((x, y) => cmp(x.id, y.id))) {
    if (liveJobs.has(job.id) || jobRemoving.has(job.id)) continue;
    const sid = job.sessionId;
    // the conversation already has a card (an ended team lead from memory, under the id it ran with last): mark that
    // card as the job rather than drawing a second one, so deleting it removes the CLI's record too
    const ids = [sid, job.resumeSessionId].filter((x) => x != null);
    const tm = all.flatMap((t) => t.members).find((m) => ids.includes(m.sessionId));
    if (tm) { if (tm.jobId == null) { tm.jobId = job.id; tm.isBackgroundJob = true; } continue; }
    const lm = looseAgents.find((m) => ids.includes(m.sessionId));
    if (lm) { if (lm.jobId == null) { lm.jobId = job.id; lm.isBackgroundJob = true; } continue; }
    if (deleted.has(sid) || S.archive[sid]) continue;
    const a = newAgent(sid, null, jobNames[job.id] ?? job.name, 'ended');
    a.jobId = job.id; a.isBackgroundJob = true; a.cwd = job.cwd;
    // the transcript the CLI links to the job; until it writes one, the conversation the job was resumed from
    if (job.transcript && exists(job.transcript)) { if (transcriptIndex[sid] !== job.transcript) transcriptIndex[sid] = job.transcript; }
    else if (transcript(sid) == null && job.resumeSessionId && job.resumeSessionId !== sid) { const t = transcript(job.resumeSessionId); if (t) transcriptIndex[sid] = t; }
    enrich(a, focus.has(sid));
    if (a.lastActivity == null) a.lastActivity = job.updatedAt;
    looseAgents = looseAgents.filter((x) => x.sessionId !== sid);
    looseAgents.push(a);
  }
  for (const t of all) {
    for (const m of t.members) enrich(m, focus.has(m.sessionId));
    t.members.sort((x, y) => cmp(x.isLead ? 0 : 1, y.isLead ? 0 : 1) || cmp(x.name, y.name));
  }
  // every session is the lead of an implicit team; until it has a teammate it is an individual session
  for (const t of all.filter(M.teamIsSolo)) {
    const a = copyAgent(t.members.find((m) => !m.isSubagent)); a.solo = true;
    if (a.state === 'ended' && a.transcriptPath == null) {
      const last = seen[t.name] && seen[t.name][a.sessionId] ? seen[t.name][a.sessionId].lastSeen : null;
      if (last != null && now() - last > 600 * 1000) delete seen[t.name];
      continue;
    }
    looseAgents = looseAgents.filter((x) => x.sessionId !== a.sessionId);
    looseAgents.push(a);
  }
  const teams = all.filter((t) => !M.teamIsSolo(t));
  teams.sort((x, y) => cmp(M.teamLiveCount(x) > 0 ? 0 : 1, M.teamLiveCount(y) > 0 ? 0 : 1) || cmp(x.createdAt ?? -Infinity, y.createdAt ?? -Infinity));
  looseAgents.sort((x, y) => cmp(x.state === 'ended' ? 1 : 0, y.state === 'ended' ? 1 : 0) || cmp(x.name, y.name));
  const everyone = teams.flatMap((t) => t.members).concat(looseAgents);
  Cache.setWanted(new Set(everyone.map((a) => a.tmuxPane).filter((x) => x != null)));
  trackLaunches(new Set(Object.values(sessions).map((a) => a.pid).filter((x) => x != null)), new Set(everyone.map((a) => a.tmuxPane).filter((x) => x != null)));
  if (S.spawnChecks.length > 0) verifySpawns(everyone, S.teams);   // (Swift reads self.teams here: the previous tick's)
  for (const [tmux, specs] of Object.entries(pendingRespawn)) {
    const paneKey = Object.keys(paneSess).find((k) => paneSess[k] === tmux);
    const panePid = paneKey != null ? panes[paneKey] : undefined;
    const lead = everyone.find((a) => a.pid === panePid && a.state === 'idle');
    if (lead) {
      delete pendingRespawn[tmux];
      addTeammates(specs, lead);
      setNoticeValue(L("'%@' 다시 시작 — 팀원 %@명을 같은 이름·모델로 다시 만드는 중입니다 (Claude는 재개 시 팀원을 복원하지 않음).", lead.name, String(specs.length)));
    }
  }
  S.teams = teams;
  const known = new Set(everyone.map((a) => a.sessionId));
  for (const s of [...S.selection]) if (!known.has(s)) S.selection.delete(s);
  S.loose = looseAgents;
  if (S.selectedTeam == null) S.selectedTeam = teams.length ? teams[0].name : null;
  if (tick % 150 === 0) fetchUsage();
  if (tick % 10 === 0) saveSeen();
  const busy = everyone.filter((a) => a.state === 'busy').length, waiting = everyone.filter((a) => a.state === 'needsInput').length;
  setBadge(waiting > 0 ? L('응답 %@', String(waiting)) : (busy > 0 ? String(busy) : null), waiting, busy);
  promptNotifierUpdate(everyone.filter((a) => a.state === 'needsInput' && a.prompt != null));
  for (const [sid, cmds] of Object.entries(pendingCommands)) {
    const a = agent(sid);
    if (!a || a.state === 'ended' || a.tmuxPane == null) { delete pendingCommands[sid]; continue; }
    const p = a.tmuxPane;
    if (pendingSince[sid] == null) pendingSince[sid] = now();
    if (a.state === 'needsInput') { if (!heldNotified.has(sid)) { heldNotified.add(sid); setNoticeValue(L("'%@' 에이전트가 질문에 답을 기다리는 중이라 %@ 을(를) 대기시킵니다. 화면이 잘못 인식된 경우 '그래도 보내기'를 누르세요.", a.name, cmds[0] ?? '')); } }
    else heldNotified.delete(sid);
    // the pane shows a CLI list / picker, or someone types there from a terminal: anything sent now would go astray
    if (a.overlay != null) {
      if (!heldNotified.has(sid + '|overlay')) { heldNotified.add(sid + '|overlay'); setNoticeValue(L("'%@'의 CLI가 %@ 화면이라 %@ 을(를) 보류합니다. CLI에서 Esc로 대화로 돌아오면 보냅니다.", a.name, overlayName(a.overlay), cmds[0] ?? '')); }
      continue;
    } else heldNotified.delete(sid + '|overlay');
    if (Cache.foreignTyped(p)) {
      if (!heldNotified.has(sid + '|typed')) { heldNotified.add(sid + '|typed'); setNoticeValue(L("'%@'의 CLI 입력창에 입력 중인 글이 있어 %@ 을(를) 보류합니다 (터미널에서 같이 쓰는 중). 그 글을 보내거나 지우면 이어서 보냅니다.", a.name, cmds[0] ?? '')); }
      continue;
    } else heldNotified.delete(sid + '|typed');
    const settled = Cache.isSettled(p);
    const t = pendingSince[sid];
    if (!settled && !working(a) && Cache.busy(p) == null && t != null && now() - t > 10000) {
      // never captured (pane known only from the session file): one background check
      if (!probing.has(p)) {
        probing.add(p);
        Promise.resolve(Cache.probe(p)).then((ok) => { probing.delete(p); if (!ok) unreachable.add(p); refreshSoon(); });
      }
    }
    if (unreachable.has(p)) {
      setNoticeValue(L("'%@' 은(는) 이 tmux 서버에 없는 pane이라 제어할 수 없습니다 — 대기 중이던 %@ 명령을 취소했습니다.", a.name, cmds[0] ?? ''));
      delete pendingCommands[sid]; delete pendingSince[sid]; continue;
    }
    if (!working(a) && settled && cmds.length > 0) {
      const first = cmds[0];
      delete pendingSince[sid];
      if (cmds.length > 1) pendingCommands[sid] = cmds.slice(1); else delete pendingCommands[sid];
      if (first === '/exit') { quit(a, 'now'); continue; }        // the right way out differs per kind of session
      sendSlash(first, p, sid);
    }
  }
  for (const [sid, name] of Object.entries(pendingRenames)) {
    const a = agent(sid);
    if (!a) { delete pendingRenames[sid]; continue; }
    if (!working(a) && a.tmuxPane != null && Cache.isSettled(a.tmuxPane)) {
      Cache.markSent(a.tmuxPane, false); TmuxControl().rename(name, a.tmuxPane); delete pendingRenames[sid];
    } else if (a.state === 'ended') { delete pendingRenames[sid]; writeTitle(name, a); }
  }
  changed();
}

// ── in-process subagents (Agent tool) — they never get a pane or a team config entry ────────────────────────────────
// (Ported as in Swift, where attachSubagents is defined but not called from refresh.)
const subScan = {};
/** For every live session: its subagents started since the process began (newest 8), read off
 *  <transcript dir>/<sessionId>/subagents/agent-*.jsonl + .meta.json. Re-scanned every 4 s per session. */
function subagents(p) {
  if (p.state === 'ended' || p.transcriptPath == null || p.pid == null) return [];
  const c = subScan[p.sessionId];
  if (c && now() - c.at < 4000) return c.items;
  const sid = basenameNoExt(p.transcriptPath);
  const dir = path.join(path.dirname(p.transcriptPath), sid + '/subagents');
  const since = processStart(p.pid) ?? now() - 6 * 3600 * 1000;
  const out = [];
  for (const f of readdir(dir) || []) {
    if (!f.endsWith('.jsonl')) continue;
    const full = dir + '/' + f;
    const st = stat(full);
    if (!st || st.mtimeMs < since) continue;
    const id = f.slice(0, -6);
    const meta = readJSON(dir + '/' + id + '.meta.json') || {};
    const key = 'sub:' + p.sessionId + ':' + id;
    const a = newAgent(key, null, typeof meta.description === 'string' ? meta.description : id);
    a.isSubagent = true; a.parentSid = p.sessionId;
    a.agentType = typeof meta.agentType === 'string' ? meta.agentType : null;
    a.state = now() - st.mtimeMs < 20000 ? 'busy' : 'ended';
    a.cwd = p.cwd;
    transcriptIndex[key] = full;
    out.push([st.mtimeMs, a]);
  }
  const items = out.sort((x, y) => y[0] - x[0]).slice(0, 8).map((x) => x[1]);
  subScan[p.sessionId] = { at: now(), items };
  return items;
}
function attachSubagents(teams, loose) {
  const focus = liveChats();
  const enriched = (list) => list.map((x) => { const a = copyAgent(x); enrich(a, focus.has(a.sessionId)); return a; });
  for (const t of teams) {
    const subs = enriched(t.members.filter((m) => !m.isSubagent).flatMap(subagents));
    if (subs.length) t.members.push(...subs);
  }
  const extra = [];
  for (const a of loose) if (!a.isSubagent) extra.push(...enriched(subagents(a)));
  loose.push(...extra);
}

// ── answering Claude Code's choice windows from inside the app ──────────────────────────────────────────────────────
/** Picks option `optionIndex` (0-based) of the prompt the agent waits on: re-reads the pane first, walks the cursor with
 *  Up/Down (number keys behave differently between versions) and presses Enter; then checks the prompt is gone. */
function answerPrompt(a, optionIndex) {
  const p = a.tmuxPane, expected = a.prompt;
  if (p == null || !expected || !(optionIndex >= 0 && optionIndex < expected.options.length) || S.promptSending.has(a.sessionId)) return;
  if (ro(`answerPrompt ${a.sessionId} ${optionIndex}`)) return;
  S.promptSending.add(a.sessionId); changed();
  const sid = a.sessionId;
  TmuxControl().queue(p, async () => {
    let msg = null;
    try { msg = await Screen().answer(p, expected, optionIndex); } catch (e) { msg = String(e.message || e); }
    S.promptSending.delete(sid); if (msg) setNoticeValue(msg); changed(); refreshSoon();
  });
}
/** Esc: cancels / declines whatever the window asks. */
function cancelPrompt(a) {
  if (a.tmuxPane == null || S.promptSending.has(a.sessionId)) return;
  if (ro(`cancelPrompt ${a.sessionId}`)) return;
  TmuxControl().interrupt(a.tmuxPane);
  setTimeout(refreshSoon, 800);
}
function holdOlderRows(hold, sid) {
  const p = transcriptIndex[sid];
  if (p) { try { reader().setHoldCap(hold, p); } catch { } }
  if (!hold) refreshSoon();
}
/** Sends the first queued command although the screen looks like it waits for an answer.
 *  `choice` is the person's answer to the confirmation (the renderer shows it): 'cancel' | 'esc' (Esc first) | 'asis'. */
function forceSendPending(a, choice) {
  const p = a.tmuxPane, cmds = pendingCommands[a.sessionId];
  if (p == null || !cmds || !cmds.length) return;
  if (choice !== 'esc' && choice !== 'asis') return;
  if (ro(`forceSendPending ${a.sessionId}`)) return;
  if (choice === 'esc') TmuxControl().interrupt(p, 0.6);
  sendSlash(cmds[0], p, a.sessionId);
  if (cmds.length > 1) pendingCommands[a.sessionId] = cmds.slice(1); else delete pendingCommands[a.sessionId];
  refresh();
}

function normEntry(e) {
  return { id: e.id, role: e.role, text: e.text, toolName: e.toolName ?? null, time: ms(e.time), isThinking: !!e.isThinking, isError: !!e.isError };
}
const squash = (s) => s.split(/\s+/).filter(Boolean).join(' ');

function enrich(a, wantEntries) {
  if (a.tmuxPane != null) a.tmuxSession = paneSessionMap[a.tmuxPane] ?? null;
  if (pendingRenames[a.sessionId] != null) a.pendingName = pendingRenames[a.sessionId];
  a.pendingCommands = [...(pendingCommands[a.sessionId] || [])];
  const p = transcript(a.sessionId);
  if (p == null) return;
  a.transcriptPath = p;
  if (a.tmuxPane != null && working(a)) a.queued = queuedCount(p);
  const R = reader();
  const mode = R.effective(p, wantEntries ? Mode('full') : (a.state === 'ended' ? Mode('skip') : Mode('light')));
  const loading = R.needsWarm(p, mode, () => refreshSoon());   // first / upgrade parse runs in the background
  const s = loading ? R.peek(p) : R.snapshot(p, mode);
  // model: transcript > what the user asked for / last known (cache) > launch flag (a guess)
  if (s.model) { a.model = s.model; a.modelIsGuess = false; }
  else if (a.model == null && a.state !== 'ended' && a.pid != null) {
    const m = flag('--model', cmdline(a.pid));
    if (m) { a.model = expandModelAlias(m); a.modelIsGuess = true; }
  }
  a.effort = s.effort ?? a.effort; a.tokens = M.tokenUsage(s.tokens); a.tokensEstimated = !!loading; a.lastActivity = ms(s.last);
  a.contextTokens = s.lastContext > 0 ? s.lastContext : null;
  if (a.state === 'ended') {
    // named like the CLI's /resume picker: a stored title, else what the user first asked
    const t = storedTitle(p) ?? s.customTitle ?? s.aiTitle;
    if (t != null) a.name = t;
    else if (!a.name && s.firstPrompt) a.name = prefixChars(s.firstPrompt, 48);
  }
  const r = requested[a.sessionId];
  if (r) {
    // show the user's choice right away; drop it once the transcript agrees, or after 10 min
    if (r.model != null) { if ((s.model || '').startsWith(r.model)) r.model = null; else { a.model = r.model; a.modelIsGuess = false; if (!confirmed.has(a.sessionId + '|/model')) a.requestedModel = r.model; } }
    if (r.effort != null) { if (s.effort === r.effort && a.pendingCommands.length === 0) r.effort = null; else { a.effort = r.effort; if (!confirmed.has(a.sessionId + '|/effort')) a.requestedEffort = r.effort; } }
    if (now() - r.at > 600 * 1000) delete requested[a.sessionId];
  }
  // sessions the board cannot type into (Claude desktop app etc.): their status file can lag;
  // if the transcript's last word is a finished assistant turn, they are idle
  if (a.tmuxPane == null && working(a) && s.lastTurnEnded) a.state = 'idle';
  if (wantEntries && !loading) {
    let entries = [...(s.entries || [])];
    const sid = a.sessionId;
    let pend = echoes[sid];
    if (pend) {
      // drop echoes the transcript now holds (same text, written after the echo was made) or that expired
      const tail = entries.slice(-40).filter((e) => e.role === 'user');
      let queue = null;                                       // read only when an echo is overdue
      pend = pend.filter((e) => {
        // the CLI rewrites what it records (attachments → "[Image #n]", long pastes → <pasted_content>): the
        // echo's opening words inside a newer user record count as "arrived"
        const head = prefixChars(squash(e.text), 30);
        if (tail.some((t) => (ms(t.time) ?? -Infinity) >= e.at - 2000 && (squash(t.text) === squash(e.text) || (head && squash(t.text).includes(head))))) return false;
        if (!(now() - e.at > e.ttl * 1000)) return true;
        if (e.auto) return false;
        // still waiting in the CLI's own queue behind a long turn: keep showing it as being sent (up to 30 min)
        if (queue == null) queue = queuedTexts(p);
        if (now() - e.at < 1800 * 1000 && queue.length > 0) return true;
        // never showed up: say so in the chat instead of letting it vanish
        (lostEchoes[sid] = lostEchoes[sid] || []).push(e);
        setNoticeValue(L("'%@'에 보낸 메시지가 CLI 기록에서 확인되지 않습니다. 세션 터미널(CLI 화면)에서 입력창에 남아 있는지 확인하세요.", a.name));
        return false;
      });
      if (pend.length) echoes[sid] = pend; else delete echoes[sid];
    }
    if (lostEchoes[sid]) {
      // a late arrival (or 30 minutes) clears the warning
      const lost = lostEchoes[sid].filter((e) => {
        const head = prefixChars(squash(e.text), 30);
        return !(now() - e.at > 1800 * 1000
          || entries.slice(-40).some((t) => t.role === 'user' && (ms(t.time) ?? -Infinity) >= e.at - 2000 && head && squash(t.text).includes(head)));
      });
      if (lost.length) lostEchoes[sid] = lost; else delete lostEchoes[sid];
    }
    if (boardSlashes[sid]) boardSlashes[sid] = boardSlashes[sid].filter((b) => now() - b.at <= 600 * 1000);
    // everything the chat is built from, as one signature: unchanged -> nothing to rebuild or compare
    const bsl = boardSlashes[sid] || [];
    const lastSlash = bsl.length ? bsl[bsl.length - 1].at / 1000 : 0;
    const sig = `${p}|${s.offset}|${s.version}|` + (echoes[sid] || []).map((e) => e.id).join(',') + '|' + (lostEchoes[sid] || []).map((e) => e.id).join(',') + `|${bsl.length}|${lastSlash}`;
    if (chatSig[sid] === sig && chat[sid] != null) return;
    chatSig[sid] = sig;
    if (boardSlashes[sid]) {
      const bs = boardSlashes[sid].filter((b) => now() - b.at <= 600 * 1000);
      if (bs.length) boardSlashes[sid] = bs; else delete boardSlashes[sid];
      entries = entries.map((e) => {
        if (e.role !== 'user' || !e.text.startsWith('/')) return e;
        const at = ms(e.time) ?? -Infinity;
        if (bs.some((b) => b.text === e.text && at >= b.at - 2000)) return { id: e.id, role: 'system', text: e.text, toolName: 'auto', time: e.time, isThinking: false, isError: false };
        return e;
      });
    }
    for (const e of lostEchoes[sid] || []) entries.push({ id: e.id + '-lost', role: 'system', text: L('⚠ 전달 확인 안 됨 — %@', e.text), toolName: 'stderr', time: e.at });
    for (const e of echoes[sid] || []) entries.push(echoEntry(e));
    setChat(sid, entries.map(normEntry));
  }
}
const echoEntry = (e) => (e.auto ? { id: e.id, role: 'system', text: e.text, toolName: 'auto', time: e.at, isThinking: false, isError: false }
  : { id: e.id, role: 'user', text: e.text, toolName: '전송 중', time: e.at, isThinking: false, isError: false });

function transcript(sid) {
  const known = transcriptIndex[sid];
  if (known && exists(known)) return known;
  if (sid.includes('/')) {                         // teammate key "team/name": look it up now
    const i = sid.indexOf('/');
    const p = teammateTranscript(sid.slice(0, i), sid.slice(i + 1), null);
    if (p) { transcriptIndex[sid] = p; return p; }
    return null;
  }
  const root = home + '/.claude/projects';
  const dirs = readdir(root);
  if (!dirs) return null;
  for (const d of dirs) {
    const p = `${root}/${d}/${sid}.jsonl`;
    if (exists(p)) { transcriptIndex[sid] = p; return p; }
  }
  return null;
}

// ── one card per conversation ───────────────────────────────────────────────────────────────────────────────────
/** The CLI's "← agents" screen moves an interactive session's conversation into a background job: from then on the
 *  interactive process is only a viewer (its session file carries `parkedJobId`; `claude agents` lists the job, not it),
 *  and `claude attach <job>` is the same kind of viewer without a session file. The job is the card. It borrows the
 *  viewer's pane (so the board can type into it) and the viewer's name; the viewer is never a card of its own. */
function mergeViewers(sessions, panes) {
  const viewers = {};                                   // job id -> viewer
  const hidden = new Set();                             // session ids of parked viewers
  for (const [k, a] of Object.entries(sessions)) {
    if (a.isBackgroundJob) continue;
    const j = a.parkedJobId;
    if (j == null) continue;
    viewers[j] = a; delete sessions[k]; hidden.add(k);
    if (a.nameSource === 'user' && a.name && jobNames[j] !== a.name) jobNames[j] = a.name;
  }
  for (const [pane, pid] of Object.entries(panes)) {
    const j = attachedJob(pid);
    if (j == null || viewers[j]) continue;
    const v = newAgent('attach:' + j, pid, ''); v.tmuxPane = pane;
    viewers[j] = v;
  }
  for (const b of Object.values(sessions)) {
    if (!b.isBackgroundJob || b.jobId == null) continue;
    const j = b.jobId;
    if ((b.name === j || !b.name) && jobNames[j]) b.name = jobNames[j];
    const v = viewers[j];
    if (v) {
      delete viewers[j];
      b.tmuxPane = v.tmuxPane; b.viewerPid = v.pid; b.parkedJobId = j;
      if (v.nameSource === 'user' && v.name) b.name = v.name;
      if (b.tmuxPane != null) {
        const p = b.tmuxPane;
        b.overlay = Cache.overlay(p);
        const st = b.overlay == null ? Cache.state(p) : null;
        if (st != null) {
          b.stateUnconfirmed = unconfirmed(b.sessionId, b.state, st);
          b.state = st; b.prompt = st === 'needsInput' ? Cache.prompt(p) : null; b.screen = Cache.status(p);
        }
      }
    }
  }
  // a viewer whose job is gone (stopped from the CLI): an interactive process with nothing behind it, shown as such
  for (const [j, v] of Object.entries(viewers)) {
    if (v.sessionId.startsWith('attach:')) continue;
    v.parkedJobId = j; sessions[v.sessionId] = v; hidden.delete(v.sessionId);
  }
  return hidden;
}
const attachScan = {};
/** `claude attach <job>` as a pane's process (or its child): the job id. Found by command line, re-checked every 30 s. */
function attachedJob(pid) {
  const c = attachScan[pid];
  if (c && (c.job != null || tick - c.tick < 15)) return c.job;
  let found = null;
  for (const p of [pid, ...childPids(pid)]) {
    const parts = cmdline(p).split(' ').filter(Boolean);
    const i = parts.indexOf('attach');
    if (!parts.length || !parts[0].toLowerCase().includes('claude') || i < 0 || i + 1 >= parts.length) continue;
    if (parts[i + 1].length !== 8 || !isHex(parts[i + 1])) continue;
    found = parts[i + 1]; break;
  }
  attachScan[pid] = { job: found, tick };
  return found;
}
function overlayName(o) { return o === 'agents' ? L('세션 목록(← agents)') : o === 'resume' ? L('대화 선택(/resume)') : o; }

let transcriptScan = { tick: -100, list: [] };
const probeDir = home + '/.agent-boost/usage-probe';
const probeProject = probeDir.replace(/\//g, '-').replace(/\./g, '-');
/** Every <id>.jsonl under ~/.claude/projects: the conversations `claude --resume` offers. Rescanned every other tick. */
function transcriptList() {
  if (tick - transcriptScan.tick < 2) return transcriptScan.list;
  const root = home + '/.claude/projects';
  const out = [];
  for (const d of readdir(root) || []) {
    if (d === probeProject || d.startsWith('.')) continue;
    for (const f of readdir(`${root}/${d}`) || []) {
      if (f.endsWith('.jsonl') && !f.startsWith('agent-')) out.push({ sid: f.slice(0, -6), path: `${root}/${d}/${f}` });
    }
  }
  transcriptScan = { tick, list: out };
  return out;
}
const cwdCache = {};
/** "cwd" of a transcript's first records, read once per file. */
function transcriptCwd(p) {
  if (cwdCache[p] != null) return cwdCache[p];
  const head = readHead(p, 65536);
  if (!head) return null;
  for (const line of head.toString('utf8').split('\n')) {
    try { const d = JSON.parse(line); if (d && typeof d.cwd === 'string') { cwdCache[p] = d.cwd; return d.cwd; } } catch { }
  }
  return null;
}

// ── CLI background jobs — ~/.claude/jobs/<id>/state.json, the list behind `claude agents` and the CLI's ← screen ──────
let jobCache = {};                // parsed once per file version (size|mtime)
const jobRemoving = new Set();    // `claude stop/rm` in flight
function loadJobs() {
  const root = home + '/.claude/jobs';
  const ids = readdir(root);
  if (!ids) { jobCache = {}; return {}; }
  const out = {}, present = new Set();
  for (const id of ids) {
    const p = `${root}/${id}/state.json`;
    // no state.json: a process the CLI keeps warm for later (`claude bg-spare`) or a job not yet written; not a session
    const st = stat(p);
    if (!st) continue;
    present.add(id);
    const stamp = `${st.size}|${st.mtimeMs}`;
    const c = jobCache[id];
    if (c && c.stamp === stamp) { if (c.info) out[id] = c.info; continue; }
    let info = null;
    const j = readJSON(p);
    if (j && typeof j === 'object' && !Array.isArray(j)) {
      const name = typeof j.name === 'string' && j.name ? j.name : id;
      info = { id, name, state: typeof j.state === 'string' ? j.state : '', sessionId: typeof j.sessionId === 'string' ? j.sessionId : id,
        resumeSessionId: typeof j.resumeSessionId === 'string' ? j.resumeSessionId : null, cwd: typeof j.cwd === 'string' ? j.cwd : null,
        transcript: typeof j.linkScanPath === 'string' ? j.linkScanPath : null, updatedAt: typeof j.updatedAt === 'string' ? ms(j.updatedAt) : null };
    }
    jobCache[id] = { stamp, info };
    if (info) out[id] = info;
  }
  for (const k of Object.keys(jobCache)) if (!present.has(k)) delete jobCache[k];
  return out;
}

function loadSessions(paneByPid, jobs) {
  const out = {};
  const dir = home + '/.claude/sessions';
  const names = readdir(dir);
  if (!names) return out;
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const j = readJSON(dir + '/' + n);
    if (!j || !Number.isInteger(j.pid) || typeof j.sessionId !== 'string') continue;
    const pid = j.pid, sid = j.sessionId;
    if (!alive(pid)) continue;                                      // process gone -> stale file
    if (!isClaude(pid, typeof j.procStart === 'string' ? j.procStart : null)) continue;   // pid reused by another program
    if (typeof j.cwd === 'string' && (j.cwd === probeDir || j.cwd.startsWith(probeDir))) continue;   // our own usage probe
    const a = newAgent(sid, pid, typeof j.name === 'string' ? j.name : prefixChars(sid, 8));
    a.nameSource = typeof j.nameSource === 'string' ? j.nameSource : null;
    a.entrypoint = typeof j.entrypoint === 'string' ? j.entrypoint : null;
    // the CLI derives a name on --resume even when the conversation has a stored title: show the stored one
    if (a.nameSource === 'derived') { const tp = transcript(sid); const t = tp ? storedTitle(tp) : null; if (t != null) a.name = t; }
    a.isBackgroundJob = j.kind === 'bg';
    a.jobId = typeof j.jobId === 'string' ? j.jobId : null;
    if (a.isBackgroundJob && a.jobId != null) {
      // a background process the CLI does not list as a job is a spare it keeps warm: not a session of the user's
      const job = jobs[a.jobId];
      if (!job) continue;
      if (!a.name || a.name === prefixChars(sid, 8) || a.name === a.jobId) a.name = job.name;
    }
    a.remoteControl = j.bridgeSessionId != null;   // Claude records the bridge while Remote Control is connected
    a.cwd = typeof j.cwd === 'string' ? j.cwd : null;
    a.state = M.AgentStates.includes(j.status) ? j.status : 'unknown';
    a.tmuxPane = paneByPid[pid] ?? paneViaParent(pid, paneByPid);
    // Claude's status file can lag or stick at "busy"; the footer shows "esc to interrupt"
    // only while a turn runs, so for a session in a pane the screen decides.
    // the screen decides when it can be read; only when it is unknown (not captured / timed out) the session file's status stands in.
    // The file can stick at "busy", so it never overrides a readable screen.
    a.parkedJobId = typeof j.parkedJobId === 'string' ? j.parkedJobId : null;
    if (a.tmuxPane != null) {
      const p = a.tmuxPane;
      a.overlay = Cache.overlay(p);                       // a list / picker on screen: the file's status stands
      const st = a.overlay == null ? Cache.state(p) : null;
      if (st != null) {
        const file = a.state;
        a.state = st;
        a.stateUnconfirmed = unconfirmed(sid, file, st);
        a.prompt = st === 'needsInput' ? Cache.prompt(p) : null;
        a.screen = Cache.status(p);
      }
    }
    if (typeof j.tmux === 'string' && a.tmuxPane == null) {
      const pct = j.tmux.split('.').filter(Boolean).pop();
      if (pct && pct.startsWith('%')) a.tmuxPane = pct;
    }
    if (a.effort == null) a.effort = effortFromCommandLine(pid);
    out[sid] = a;
  }
  return out;
}

// ── processes: /proc on Linux, ps elsewhere ────────────────────────────────────────────────────────────────────────
// a process's parent and command line never change: look them up once per pid
const ppidCache = {}, cmdCache = {}, startCache = {};
const hasProc = exists('/proc/self/stat');
function readProcStat(pid) {
  // /proc/<pid>/stat: "pid (comm) state ppid … starttime(22nd field)"; comm may hold spaces / parentheses
  try { const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return s.slice(s.lastIndexOf(')') + 2).split(' '); } catch { return null; }
}
/** A pane's pid is usually the shell; the agent is its child. */
function paneViaParent(pid, paneByPid) {
  if (ppidCache[pid] != null) return paneByPid[ppidCache[pid]] ?? null;
  let pp = null;
  if (hasProc) { const f = readProcStat(pid); if (f) pp = Number(f[1]); }
  else { const r = Shell.runSync(['ps', '-o', 'ppid=', '-p', String(pid)], { timeout: 2 }); pp = Number.parseInt(r.out.trim(), 10); }
  if (!Number.isInteger(pp)) return null;
  ppidCache[pid] = pp;
  return paneByPid[pp] ?? null;
}
/** Child pids of a process (pgrep -P). */
function childPids(pid) {
  if (hasProc) {
    const out = [];
    for (const t of readdir(`/proc/${pid}/task`) || []) {
      try { for (const c of fs.readFileSync(`/proc/${pid}/task/${t}/children`, 'utf8').split(' ')) if (c.trim()) out.push(Number(c)); } catch { }
    }
    return out;
  }
  return Shell.runSync(['pgrep', '-P', String(pid)], { timeout: 2 }).out.split('\n').map((x) => Number.parseInt(x.trim(), 10)).filter(Number.isInteger);
}
function effortFromCommandLine(pid) {
  const out = cmdline(pid);
  const i = out.indexOf('--effort ');
  if (i < 0) return null;
  // ps output ends with a newline: without trimming, "low\n" rendered as a truncated chip
  return out.slice(i + 9).split(/[ \n]/).filter(Boolean)[0] ?? null;
}
/** When a process started, cached per pid (epoch ms). */
function processStart(pid) {
  if (startCache[pid] != null) return startCache[pid];
  let d = null;
  if (hasProc) {
    const f = readProcStat(pid);
    try {
      const btime = Number(/btime (\d+)/.exec(fs.readFileSync('/proc/stat', 'utf8'))[1]);
      const hz = 100;   // USER_HZ: 100 on every Linux the CLI runs on
      if (f) d = Math.round((btime + Number(f[19]) / hz) * 1000);
    } catch { }
  } else {
    const out = Shell.runSync(['ps', '-o', 'lstart=', '-p', String(pid)], { timeout: 2 }).out.trim().split(/\s+/).join(' ');
    const t = Date.parse(out);
    if (out && !Number.isNaN(t)) d = t;
  }
  if (d == null) return null;
  startCache[pid] = d; return d;
}
function cmdline(pid) {
  if (cmdCache[pid] != null) return cmdCache[pid];
  let c = '';
  if (hasProc) { try { c = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ').trim(); } catch { } }
  else c = Shell.runSync(['ps', '-o', 'command=', '-p', String(pid)], { timeout: 2 }).out.trim();
  if (c) cmdCache[pid] = c;
  return c;
}
function flag(f, cl) {
  const parts = cl.split(' ').filter(Boolean);
  const i = parts.indexOf(f);
  return i >= 0 && i + 1 < parts.length ? parts[i + 1] : null;
}
function expandModelAlias(m) {
  switch (m) { case 'haiku': return 'claude-haiku-5-5'; case 'sonnet': return 'claude-sonnet-5-5'; case 'opus': return 'claude-opus-5-5'; case 'fable': return 'claude-fable-5-1'; default: return m; }
}
/** Claude Code's footer reads "esc to interrupt" only while a turn is running. */
function paneIsBusy(pane) {
  const b = Cache.busy(pane);
  return b != null ? b : false;                        // not captured yet (new pane): the next background update fills it
}
const claudePids = {};
function isClaude(pid, startedAt) {
  const key = `${pid}|${startedAt ?? ''}`;
  if (claudePids[key] != null) return claudePids[key];
  const cl = cmdline(pid).toLowerCase();
  if (!cl) return true;                                // ps failed / timed out: unknown counts as "yes", and is not remembered
  const v = cl.includes('claude');
  claudePids[key] = v;
  return v;
}
/** Sessions launched before the PATH fix cannot spawn teammates (no tmux on their PATH). */
const spawnable = {};
const spawnProbing = new Set();
function canSpawnTeammates(a) {
  const pid = a.pid;
  if (pid == null) return false;
  if (spawnable[pid] != null) return spawnable[pid];
  // called from view bodies: never block here. Answer "yes" for now, look it up in the background.
  if (!spawnProbing.has(pid)) {
    spawnProbing.add(pid);
    (async () => {
      let env = '';
      if (hasProc) { try { env = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').join(' '); } catch { } }
      if (!env) env = (await Shell.run(['ps', 'eww', '-p', String(pid)], { timeout: 2 })).out;
      if (!env) { spawnProbing.delete(pid); return; }     // failed: try again later, do not cache
      const tmuxDir = path.dirname(Shell.tmuxPath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      spawnable[pid] = env.includes('TMUX=') && (new RegExp('PATH=[^ ]*' + tmuxDir).test(env) || isExecutable('/usr/bin/tmux'));
      changed();
    })();
  }
  return true;
}
const identityCache = {};
function teamIdentity(pid) {
  if (pid in identityCache) return identityCache[pid];
  let addr = null, team = null;
  const parts = cmdline(pid).split(' ').filter(Boolean);
  parts.forEach((p, i) => {
    if (i + 1 >= parts.length) return;
    if (p === '--agent-id') addr = parts[i + 1];
    if (p === '--team-name') team = parts[i + 1];
  });
  const v = addr != null && team != null ? [addr, team] : null;
  identityCache[pid] = v;
  return v;
}

function loadTeams(sessions, panes, hidden = new Set()) {
  const teams = [];
  const claimed = new Set();
  const root = home + '/.claude/teams';
  const dirs = new Set(readdir(root) || []);
  const t0 = now();
  // Claude removes a team's config folder when its lead exits; the board keeps
  // the team (all members ended) from its own memory so it stays resumable.
  for (const d of new Set([...dirs, ...Object.keys(seen)])) {
    let data = null;
    try { data = fs.readFileSync(`${root}/${d}/config.json`, 'utf8'); } catch { }
    let j = null;
    if (data != null) { try { j = JSON.parse(data); } catch { } }
    if (!j || typeof j !== 'object' || Array.isArray(j)) j = { name: d };
    if (data == null && (!seen[d] || Object.keys(seen[d]).length === 0)) continue;
    const name = typeof j.name === 'string' ? j.name : d;
    const leadSid = typeof j.leadSessionId === 'string' ? j.leadSessionId : null;
    const firsts = seen[d] ? Object.values(seen[d]).map((x) => x.firstSeen) : [];
    const team = M.newTeam(name, typeof j.createdAt === 'number' ? j.createdAt : (firsts.length ? Math.min(...firsts) : null), leadSid, []);
    const bucket = seen[name] || {};
    const liveMates = {};
    for (const m of Array.isArray(j.members) ? j.members : []) {
      if (!m || typeof m !== 'object') continue;
      const aid = typeof m.agentId === 'string' ? m.agentId : '';
      const isLead = m.agentType === 'team-lead' || aid === j.leadAgentId;
      let sid = isLead ? leadSid : (typeof m.sessionId === 'string' ? m.sessionId : null);
      if (!isLead && sid == null && typeof m.name === 'string') {
        const mname = m.name;
        // teammates never register in ~/.claude/sessions; their transcript
        // carries teamName/agentName, and the config carries their pane
        sid = `${name}/${mname}`;
        let procStart = null;
        const lp = typeof m.tmuxPaneId === 'string' ? panes[m.tmuxPaneId] : undefined;
        if (lp != null) {
          // same name, new process (teammate re-created): forget the old conversation's file
          if (matePids[sid] != null && matePids[sid] !== lp) { delete mateTranscripts[sid]; delete mateMisses[sid]; delete transcriptIndex[sid]; }
          matePids[sid] = lp;
          procStart = processStart(lp);
        }
        // a live process: only files born after it started (a re-created teammate must not get the old file)
        const tpath = teammateTranscript(name, mname, procStart ?? team.createdAt, procStart != null);
        // sid is stable: it survives the transcript appearing, and a same-name replacement
        const pane = typeof m.tmuxPaneId === 'string' ? m.tmuxPaneId : null;
        const pid = pane != null ? panes[pane] : undefined;
        if (pane && pane.startsWith('%') && pid != null && alive(pid) && cmdline(pid).includes(`--agent-name ${mname}`)) {
          const a = newAgent(sid, pid, mname);
          a.tmuxPane = pane;
          a.state = Cache.state(pane) ?? 'idle';
          if (a.state === 'needsInput') a.prompt = Cache.prompt(pane);
          a.screen = Cache.status(pane);
          const cl = cmdline(pid);
          a.effort = flag('--effort', cl);
          const fm = flag('--model', cl); a.model = fm != null ? expandModelAlias(fm) : null;
          if (tpath) transcriptIndex[sid] = tpath;
          liveMates[sid] = a;
        } else if (tpath) transcriptIndex[sid] = tpath;
      }
      if (sid == null) continue;
      const sm = bucket[sid] || { sessionId: sid, name: typeof m.name === 'string' ? m.name : aid, agentType: typeof m.agentType === 'string' ? m.agentType : null,
        teamAddress: aid, isLead, firstSeen: t0, lastSeen: t0 };
      sm.lastSeen = t0; sm.teamAddress = aid; sm.isLead = isLead;
      const live = sessions[sid];
      if (live) { if (live.name && live.name !== prefixChars(sid, 8)) sm.name = live.name; sm.origin = live.origin ?? sm.origin; }
      bucket[sid] = sm;
    }
    // live teammates that identify themselves on the command line but are missing from config
    for (const a of Object.values(sessions)) {
      if (a.pid == null) continue;
      const id = teamIdentity(a.pid);
      if (id && id[1] === name && bucket[a.sessionId] == null) {
        bucket[a.sessionId] = { sessionId: a.sessionId, name: id[0].split('@').filter(Boolean)[0] ?? a.name, agentType: null, teamAddress: id[0], isLead: false, firstSeen: t0, lastSeen: t0 };
      }
    }
    seen[name] = bucket;
    for (const [sid, sm] of Object.entries(bucket)) {
      if (deleted.has(sid) || S.archive[sid] || hidden.has(sid)) continue;   // hidden: a parked viewer (its job is the card)
      const src = sessions[sid] ?? liveMates[sid];
      const a = src ? copyAgent(src) : newAgent(sid, null, sm.name, 'ended');
      if (!sessions[sid] && !liveMates[sid]) a.state = 'ended';
      a.teamAddress = sm.teamAddress ?? null; a.teamName = name; a.agentType = sm.agentType ?? null; a.isLead = !!sm.isLead; a.origin = a.origin ?? sm.origin ?? null;
      if (a.nameSource !== 'user' && (a.name === prefixChars(sid, 8) || !a.name)) a.name = sm.name;
      team.members.push(a); claimed.add(sid);
    }
    // every member deleted: nothing left to show — forget the team instead of drawing an empty box
    if (team.members.length === 0) { delete seen[name]; continue; }
    teams.push(team);
  }
  return [teams, claimed];
}

const mateTranscripts = {}, matePids = {}, mateMisses = {};
/** Finds a teammate's transcript: a .jsonl whose records carry this teamName/agentName. */
function teammateTranscript(team, agentName, since, strict = false) {
  const key = `${team}/${agentName}`;
  if (mateTranscripts[key] && exists(mateTranscripts[key])) return mateTranscripts[key];
  if (mateMisses[key] != null && tick - mateMisses[key] < 30) return null;     // re-scan every ~60 s
  mateMisses[key] = tick;
  // the scan reads every project folder: do it in the background; the answer lands in the cache for the next tick
  setImmediate(() => {
    const best = scanTeammateTranscript(team, agentName, since, strict);
    if (!best) return;
    mateTranscripts[key] = best; delete mateMisses[key];
    refreshSoon();
  });
  return null;
}
function scanTeammateTranscript(team, agentName, since, strict) {
  const root = home + '/.claude/projects';
  const needleA = Buffer.from(`"teamName":"${team}"`), needleB = Buffer.from(`"agentName":"${agentName}"`);
  const floor = (since ?? -Infinity) + (strict ? -2000 : -120000);
  let best = null;
  for (const d of readdir(root) || []) {
    const dir = `${root}/${d}`;
    for (const f of readdir(dir) || []) {
      if (!f.endsWith('.jsonl')) continue;
      const p = `${dir}/${f}`;
      const st = stat(p);
      if (!st || st.mtimeMs < floor) continue;
      const head = readHead(p, 16384);
      if (head && head.includes(needleA) && head.includes(needleB) && st.mtimeMs > (best ? best[1] : -Infinity)) best = [p, st.mtimeMs];
    }
  }
  return best ? best[0] : null;
}

let saveSeenLogged = false;
function saveSeen() {
  if (RO) { if (!saveSeenLogged) { saveSeenLogged = true; ro('saveSeen (seen-members.json, job-names.json) — logged once'); } return; }
  writeFileSafe(memoryURL, JSON.stringify(seenToDisk()));
  writeFileSafe(jobNamesURL, JSON.stringify(jobNames));
}

// ── actions ──────────────────────────────────────────────────────────────────────────────────────────────────────
/** Messages shown at once, before Claude writes them to the transcript. */
const chatSig = {};
const pendingSince = {};
const probing = new Set();
const mismatchSince = {};
/** File status and screen disagree (busy vs idle) for 10 s or more: the card shows "확인 중" while the screen's word is used. */
function unconfirmed(sid, file, screen) {
  const differ = (file === 'busy' && screen === 'idle') || (file === 'idle' && screen === 'busy');
  if (!differ) { delete mismatchSince[sid]; return false; }
  const t = mismatchSince[sid] ?? now(); mismatchSince[sid] = t;
  return now() - t >= 10000;
}
const heldNotified = new Set();
const unreachable = new Set();
const echoes = {};        // sid -> [{id, text, at, ttl (s), auto}]
const lostEchoes = {};    // sent, never recorded
/** Slash commands the board itself sent (/model, /effort, /rename, /exit): shown as small status lines, not user bubbles. */
const boardSlashes = {};
function addEcho(text, sid, ttl, auto = false) {
  const e = { id: 'echo-' + M.uuid(), text, at: now(), ttl, auto };
  (echoes[sid] = echoes[sid] || []).push(e);
  if (auto) (boardSlashes[sid] = boardSlashes[sid] || []).push({ text, at: e.at });
  else if (text.startsWith('/')) S.lastSentAt = now();
  if (chat[sid]) setChat(sid, [...chat[sid], normEntry(echoEntry(e))]);   // optimistic row, immediately (same id the refresh uses)
  changed();
}
/** What each composer sent last (text as typed, attachments), so a message the CLI did not take can be put back. */
const lastSentDraft = {};
function pullQueue(a) {
  const p = a.tmuxPane, tp = a.transcriptPath;
  if (p == null || tp == null) return;
  if (Cache.foreignTyped(p)) { setNoticeValue(L("'%@'의 CLI 입력창에 글이 있어 대기 메시지를 꺼내지 않았습니다. 그 글을 보내거나 지운 뒤 다시 시도하세요.", a.name)); return; }
  const texts = queuedTexts(tp);
  if (!texts.length) return;
  if (ro(`pullQueue ${a.sessionId}`)) return;
  const done = (ok) => {
    if (!ok) { setNoticeValue(L('대기 메시지를 꺼내지 못했습니다. 이미 처리됐을 수 있습니다.')); return; }
    if (echoes[a.sessionId]) echoes[a.sessionId] = echoes[a.sessionId].filter((e) => !texts.includes(e.text));
    if (chat[a.sessionId]) setChat(a.sessionId, chat[a.sessionId].filter((e) => !(e.toolName === '전송 중' && texts.includes(e.text))));
    S.pulled = { sid: a.sessionId, gen: S.pulled.gen + 1, texts };
    changed();
    refreshSoon();
  };
  const r = TmuxControl().pullQueue(p, a.sessionId, done);
  if (r && typeof r.then === 'function') r.then((ok) => { if (typeof ok === 'boolean') done(ok); });
}
const drafts = {};           // half-typed text per agent; survives tab changes (not @Published)
let userInitiated = false;   // set by SlashRouter while it forwards a command the user typed
function send(text, a) {
  const r = sendChecked(text, a);
  sendLogNote(`store '${a.name}' sid=${prefixChars(a.sessionId, 8)} pane=${a.tmuxPane ?? '없음'} state=${a.state} ` + (r ? '→ tmux로 보냄' : `→ 거절: ${S.notice ?? '-'}`));
  return r;
}
function sendChecked(text, a) {
  const p = a.tmuxPane;
  if (p == null || a.state === 'ended') { setNoticeValue(L("'%@'은(는) 종료됐거나 tmux 화면이 없는 세션이라 보낼 수 없습니다.", a.name)); return false; }
  if (a.overlay != null) { setNoticeValue(L("'%@'의 CLI가 %@ 화면이라 보낼 수 없습니다. CLI에서 Esc를 눌러 대화로 돌아온 뒤 다시 보내세요.", a.name, overlayName(a.overlay))); return false; }
  if (a.state === 'needsInput' && a.prompt != null) {
    setNoticeValue(L("'%@'의 CLI가 질문에 대한 답을 기다리는 중이라 보내지 않았습니다. 질문 카드에서 먼저 답하거나 Esc로 취소한 뒤 다시 보내세요.", a.name)); return false;
  }
  if (Cache.foreignTyped(p)) { setNoticeValue(L("'%@'의 CLI 입력창에 입력 중인 글이 있어 보내지 않았습니다 (터미널에서 같이 쓰는 중). 그 글을 보내거나 지운 뒤 다시 시도하세요.", a.name)); return false; }
  if (ro(`send ${a.sessionId} ${JSON.stringify(prefixChars(text, 40))}`)) return false;
  S.lastSentAt = now();
  if (text.startsWith('/model')) Cache.expectModelConfirm(p);     // typed by the user: a "Switch model?" window is theirs too
  addEcho(text, a.sessionId, 90);
  Cache.markSent(p, true);
  S.sending.add(a.sessionId);
  TmuxControl().send(text, p, a.sessionId);     // queued per pane, off the main thread
  for (const d of [0.5]) setTimeout(refreshSoon, d * 1000);   // pick up the new state without waiting for the 2 s tick (coalesced)
  changed();
  return true;
}
function clearCLIInput(a) {
  if (a.tmuxPane == null) return;
  if (ro(`clearCLIInput ${a.sessionId}`)) return;
  TmuxControl().clearInput(a.tmuxPane);
  setTimeout(refreshSoon, 1200);
}
function interrupt(a) { if (a.tmuxPane != null && !ro(`interrupt ${a.sessionId}`)) TmuxControl().interrupt(a.tmuxPane); }
/** Messages typed while a turn runs wait in the CLI's queue. Esc stops the turn and the CLI puts the queued text back
 *  into its input box; Enter then submits it right away. */
function pushQueue(a) {
  const p = a.tmuxPane;
  if (p == null) return;
  if (ro(`pushQueue ${a.sessionId}`)) return;
  const C = TmuxControl();
  C.queue(p, async () => {
    await C.keys(['-t', p, 'Escape'], L('중단(Esc)'));
    await sleep(900);
    const box = (await Shell.tmux(['capture-pane', '-p', '-t', p, '-S', '-6'])).out;
    // only press Enter when the box holds text (a "❯ " row with something after it)
    if (box.split('\n').some((l) => { const t = trimWS(l); return t.startsWith('❯') && Array.from(t).length > 2; })) {
      await C.keys(['-t', p, 'Enter'], L('대기열 전송(Enter)'));
    }
  });
  setTimeout(refreshSoon, 1500);
}
/** Shift+Tab in the CLI: default → accept edits → plan → … The footer shows the new mode on the next capture. */
function cycleMode(a) {
  const p = a.tmuxPane;
  if (p == null || a.state === 'ended') return;
  if (ro(`cycleMode ${a.sessionId}`)) return;
  const C = TmuxControl();
  C.queue(p, async () => { await C.keys(['-t', p, 'BTab'], L('모드 전환(Shift+Tab)')); });
  setTimeout(refreshSoon, 600);
}
/** Live + idle: /rename now. Live + busy: queued until idle. Ended: written to
 *  the transcript as a custom-title record, exactly as Claude stores it. */
function rename(a, raw) {
  const name = trimWS(String(raw).replace(/\n/g, ' '));
  if (!name || name === a.name) return;
  const host = externalHost(a);
  if (host != null && (a.state === 'ended' || a.tmuxPane == null)) {
    setNoticeValue(L("'%@'은(는) %@에서 만든 대화라 이름은 %@에서 바꿔 주세요. 앱이 기록 파일에 쓰면 %@가 이 세션을 거부합니다.", a.name, host, host, host)); return;
  }
  if (ro(`rename ${a.sessionId} ${JSON.stringify(name)}`)) return;
  if (a.state === 'ended') {
    writeTitle(name, a);
  } else if (a.tmuxPane == null) {
    // running, but no way to type into it: store the title in its transcript;
    // Claude picks it up the next time the session is opened
    writeTitle(name, a);
    setNoticeValue(L("'%@'은(는) 입력할 수 없는 세션이라 이름을 기록에 저장했습니다. 다음에 다시 시작할 때부터 '%@'(으)로 표시됩니다.", a.name, name));
  } else if (working(a)) {
    pendingRenames[a.sessionId] = name;
    setNoticeValue(L("'%@' 작업 중 — 대기 상태가 되면 이름을 바꿉니다.", a.name));
  } else {
    TmuxControl().rename(name, a.tmuxPane);
  }
  if (a.teamName != null && seen[a.teamName] && seen[a.teamName][a.sessionId]) { seen[a.teamName][a.sessionId].name = name; saveSeen(); }
  refresh();
}
function writeTitle(name, a) {
  if (ro(`writeTitle ${a.sessionId}`)) return;
  const p = a.transcriptPath ?? transcript(a.sessionId);
  if (p == null || !exists(p)) { setNoticeValue(L('대화 기록 파일을 찾지 못해 이름을 저장하지 못했습니다.')); return; }
  const rec = { type: 'custom-title', customTitle: name, sessionId: a.sessionId };
  try { fs.appendFileSync(p, JSON.stringify(rec) + '\n'); } catch { setNoticeValue(L('대화 기록 파일을 찾지 못해 이름을 저장하지 못했습니다.')); return; }
  // Claude restores the title on --resume from <transcript dir>/<sessionId>/custom-title.json,
  // not from the transcript records (verified) — write that file too.
  const dir = path.join(path.dirname(p), basenameNoExt(p));
  try {
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'custom-title.json'), tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ customTitle: name })); fs.renameSync(tmp, f);
  } catch { }
}
/** The program that created a conversation, when it is not the terminal CLI (the transcript's first "entrypoint"). */
const hostCache = {};
function externalHost(a) {
  const p = a.transcriptPath ?? transcript(a.sessionId);
  if (p == null) return null;
  if (p in hostCache) return hostCache[p];
  let h = null;
  const head = readHead(p, 256 * 1024);
  if (head) {
    const m = /"entrypoint":"([^"]+)"/.exec(head.toString('utf8'));
    if (m) {
      switch (m[1]) {
        case 'cli': case 'sdk-cli': h = null; break;
        case 'claude-vscode': h = 'VS Code'; break;
        case 'claude-desktop': h = L('Claude 데스크톱 앱'); break;
        default: h = m[1];
      }
    }
  }
  hostCache[p] = h; return h;
}
/** The CLI records its message queue in the transcript (enqueue / dequeue / remove / popAll): replay the tail.
 *  Task notifications the CLI queues itself are not counted. */
const queueCache = {};   // the tail is re-read only when the file grew
const queuedCount = (p) => queuedTexts(p).length;
function queuedTexts(p) {
  const st = stat(p);
  if (!st) return [];
  const c = queueCache[p];
  if (c && c.size === st.size) return c.texts;
  const t = readTail(p, 400000);
  if (!t) return [];
  const q = [];
  for (const line of t.data.toString('utf8').split('\n')) {
    if (!line || !line.includes('"queue-operation"')) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (!j || typeof j.operation !== 'string') continue;
    const content = typeof j.content === 'string' ? j.content : '';
    switch (j.operation) {
      case 'enqueue': q.push(content); break;
      case 'dequeue': if (q.length) q.shift(); break;
      case 'remove': { const i = q.indexOf(content); if (i >= 0) q.splice(i, 1); else if (q.length) q.shift(); break; }
      case 'popAll': q.length = 0; break;
      default: break;
    }
  }
  const n = q.filter((x) => !x.startsWith('<task-notification'));
  queueCache[p] = { size: t.size, texts: n };
  return n;
}
/** The title Claude will use on resume, if one is stored. */
function storedTitle(p) {
  const j = readJSON(path.join(path.dirname(p), `${basenameNoExt(p)}/custom-title.json`));
  return j && typeof j.customTitle === 'string' ? j.customTitle : null;
}

// ── model / effort / teammates / new sessions ────────────────────────────────────────────────────────────────────
/** Slash command now if idle, otherwise queued until the agent is idle. */
function command(cmd, a) {
  if (a.state === 'ended' || a.tmuxPane == null) { setNoticeValue(L('tmux pane이 없거나 종료된 세션이라 변경할 수 없습니다.')); return; }
  if (ro(`command ${a.sessionId} ${cmd}`)) return;
  const p = a.tmuxPane;
  if (!working(a) && Cache.isSettled(p) && (pendingCommands[a.sessionId] || []).length === 0) sendSlash(cmd, p, a.sessionId);
  else { (pendingCommands[a.sessionId] = pendingCommands[a.sessionId] || []).push(cmd); setNoticeValue(L("'%@' 작업 중 — 대기 상태가 되면 %@ 을(를) 보냅니다.", a.name, cmd)); }
  refresh();
}
/** `/model` and `/effort` also overwrite the user's defaults for new sessions
 *  in ~/.claude/settings.json. Snapshot those keys, send, then put them back:
 *  the running session keeps its new setting, the defaults stay the user's. */
const defaultKeys = ['model', 'effortLevel', 'modelSettings'];
const settingsPath = () => home + '/.claude/settings.json';
/** Remote Control on/off for one session. Off goes through /remote-control's menu ("Disconnect this session"). */
function toggleRemote(a) {
  const pane = a.tmuxPane, on = a.remoteControl;
  if (pane == null || on == null || S.rcPending.has(a.sessionId)) {
    setNoticeValue(L("'%@'는 앱이 조작할 수 있는 터미널(tmux) 세션이 아니라 Remote Control을 바꿀 수 없습니다.", a.name)); return; }
  if (working(a)) { setNoticeValue(L("'%@'가 작업 중입니다. 끝난 뒤 다시 눌러 주세요.", a.name)); return; }
  if (ro(`toggleRemote ${a.sessionId}`)) return;
  S.rcPending.add(a.sessionId); changed();
  const C = TmuxControl();
  C.command('/remote-control', pane);
  (async () => {
    try {
      if (on) {
        let picked = false;
        for (let i = 0; i < 15; i++) {                                    // wait for the menu, then walk up to "Disconnect"
          await sleep(200);
          const scr = (await C.exec(pane, ['capture-pane', '-p', '-t', pane])).out;
          if (!scr.includes('Disconnect this session')) continue;
          if (scr.split('\n').some((l) => l.includes('❯') && l.includes('Disconnect this session'))) {
            if ((await C.exec(pane, ['send-keys', '-t', pane, 'Enter'])).code !== 0) setNoticeValue(L('원격 제어 메뉴에 Enter를 보내지 못했습니다.'));
            picked = true; break;
          }
          await C.exec(pane, ['send-keys', '-t', pane, 'Up']);
        }
        if (!picked) await C.exec(pane, ['send-keys', '-t', pane, 'Escape']);
      }
      for (let i = 0; i < 12; i++) {                                        // confirmed by the session file
        await sleep(500);
        refresh();
        const cur = agent(a.sessionId);
        if (cur && cur.remoteControl != null && cur.remoteControl !== on) {
          setNoticeValue(cur.remoteControl ? L("'%@' Remote Control 켜짐 — 휴대폰·claude.ai/code에서 이어서 볼 수 있습니다.", a.name) : L("'%@' Remote Control 꺼짐 — 웹 목록에 더 이상 나타나지 않습니다.", a.name)); return;
        }
      }
      setNoticeValue(L("'%@' Remote Control 전환을 확인하지 못했습니다. 세션 터미널을 확인해 주세요.", a.name));
    } finally { S.rcPending.delete(a.sessionId); changed(); }
  })();
}

function sendSlash(cmd, pane, sid = null) {
  if (ro(`sendSlash ${pane} ${cmd}`)) return;
  const touchesDefaults = cmd.startsWith('/model') || cmd.startsWith('/effort');
  const before = touchesDefaults ? readDefaults() : null;
  let rawBefore = null;
  if (touchesDefaults) { try { rawBefore = fs.readFileSync(settingsPath()); } catch { } }
  Cache.markSent(pane, false);
  if (cmd.startsWith('/model')) Cache.expectModelConfirm(pane);
  if (sid != null) addEcho(cmd, sid, 20, !userInitiated);
  const C = TmuxControl();
  C.command(cmd, pane);
  if (touchesDefaults && sid != null) {
    // the pane answers at once ("Set model to …" / "Set effort level to …"): that is the real confirmation
    const key = sid + '|' + (cmd.startsWith('/model') ? '/model' : '/effort');
    confirmed.delete(key);
    (async () => {
      for (let i = 0; i < 10; i++) {
        await sleep(400);
        const screen = (await C.exec(pane, ['capture-pane', '-p', '-t', pane, '-S', '-15'])).out;
        if (screen.includes('Set model to') || screen.includes('Set effort level to') || screen.includes('Kept model as')) {
          confirmed.add(key); refresh(); break;
        }
      }
    })();
  }
  if (before == null) return;
  (async () => {
    for (const delay of [2.5, 6.0]) {                       // Claude writes shortly after the command
      await sleep(delay * 1000);
      // Only the default keys changed? Put the original bytes back, so the
      // file keeps the user's exact formatting. Otherwise patch just those keys.
      if (rawBefore != null && onlyDefaultsChanged(rawBefore)) {
        let cur = null; try { cur = fs.readFileSync(settingsPath()); } catch { }
        if (!cur || !cur.equals(rawBefore)) { try { const tmp = settingsPath() + '.agentboost.tmp'; fs.writeFileSync(tmp, rawBefore); fs.renameSync(tmp, settingsPath()); } catch { } }
      } else {
        restoreDefaults(before);
      }
    }
  })();
}
function onlyDefaultsChanged(raw) {
  let a, b;
  try { a = JSON.parse(raw.toString('utf8')); b = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); } catch { return false; }
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  for (const k of defaultKeys) { delete a[k]; delete b[k]; }
  return deepEqual(a, b);
}
function readDefaults() {
  const j = readJSON(settingsPath());
  if (!j || typeof j !== 'object') return {};
  const out = {};
  for (const k of defaultKeys) out[k] = k in j ? j[k] : null;
  return out;
}
function restoreDefaults(before) {
  if (!before || Object.keys(before).length === 0) return;
  const j = readJSON(settingsPath());
  if (!j || typeof j !== 'object') return;
  let changedAny = false;
  for (const k of defaultKeys) {
    const old = before[k];
    if (old == null) { if (k in j) { delete j[k]; changedAny = true; } }
    else if (!deepEqual(j[k], old)) { j[k] = old; changedAny = true; }
  }
  if (!changedAny) return;
  const tmp = settingsPath() + '.agentboost.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(j, null, 2)); fs.renameSync(tmp, settingsPath()); } catch { }
}

// ── quit (the same for leads, teammates and single sessions) ────────────────────────────────────────────────────────
/** Only sessions the board can type into can be quit or deleted from the board.
 *  Sessions without a pane (Claude desktop app, plain terminals) are left alone:
 *  signalling them could kill the very conversation the user is in. */
const canControl = (a) => a.state !== 'ended' && a.tmuxPane != null;
/** Anything with a live process can be really stopped: /exit if the board can
 *  type into it, otherwise SIGTERM. Nothing is ever only hidden. */
const canQuit = (a) => a.state !== 'ended' && a.pid != null;

/** Types /exit into the session. Busy + now: Esc first. Busy + whenIdle: queued.
 *  If the process is still alive 30 s after /exit, SIGTERM as a last resort. */
function quit(a, mode = 'now') {
  const pid = a.pid;
  if (pid == null || a.state === 'ended') return;
  if (ro(`quit ${a.sessionId} ${mode}`)) return;
  if (working(a) && mode === 'whenIdle') {
    (pendingCommands[a.sessionId] = pendingCommands[a.sessionId] || []).push('/exit');
    setNoticeValue(L("'%@' 작업이 끝나면 종료합니다.", a.name));  // queued /exit
    refresh(); return;
  }
  if (a.isBackgroundJob && a.jobId != null) {
    // a CLI background job: the CLI's own `claude stop` ends it for real. Its viewer (the interactive session whose
    // conversation was moved there, or `claude attach`) is closed with ctrl+c twice first: its /exit only returns to
    // the agents screen.
    if (a.tmuxPane != null) closeViewer(a.tmuxPane, a.viewerPid);
    stopJob(a.jobId, a.name, pid);
    setNoticeValue(L("'%@' 백그라운드 작업을 멈춥니다 (claude stop %@).", a.name, a.jobId) + (a.tmuxPane != null ? L(' CLI 화면은 닫습니다.') : ''));
    return;
  }
  const pane = a.tmuxPane;
  if (pane == null) {
    // no terminal to type /exit into: stop the process for real
    signal(pid, 'SIGTERM');
    exitWatchdog(pid, a.name, true);
    setNoticeValue(L("'%@'에 종료 신호(SIGTERM)를 보냈습니다.", a.name) + (a.entrypoint === 'claude-desktop' ? L(' 데스크톱 앱의 해당 대화가 끊깁니다.') : ''));
    return;
  }
  if (a.parkedJobId != null) {                              // a viewer whose job is gone: /exit only returns to the agents screen
    closeViewer(pane, pid);
    setNoticeValue(L("'%@' CLI 화면을 닫습니다 (대화는 백그라운드 작업으로 옮겨져 있었습니다).", a.name));
    return;
  }
  const C = TmuxControl();
  if (a.overlay != null || working(a)) C.interrupt(pane, 0.6);   // leave the list / picker, or stop the turn, before /exit
  C.command('/exit', pane);
  exitWatchdog(pid, a.name);
  setNoticeValue(L("'%@'에 /exit 을 보냈습니다.", a.name));
}
/** ctrl+c twice: how the CLI quits an interactive viewer of a background job (its /exit only returns to the agents screen). */
function closeViewer(pane, pid) {
  if (ro(`closeViewer ${pane}`)) return;
  // The CLI's own way first (ctrl+c twice); it is unreliable from the conversation view of a parked session (verified:
  // the presses switch screens instead), so the viewer process is then ended by signal. It holds no conversation
  // state — that lives in the job daemon, which is untouched.
  const C = TmuxControl();
  C.queue(pane, async () => {
    await C.keys(['-t', pane, 'C-c'], L('CLI 화면 닫기(ctrl+c)')); await sleep(600);
    await C.keys(['-t', pane, 'C-c'], L('CLI 화면 닫기(ctrl+c)'));
    if (pid == null) return;
    for (let i = 0; i < 12 && alive(pid); i++) await sleep(250);
    if (alive(pid)) signal(pid, 'SIGTERM');
    for (let i = 0; i < 20 && alive(pid); i++) await sleep(250);
    if (alive(pid)) signal(pid, 'SIGKILL');
  });
}
/** `claude stop <job>` in the background; SIGTERM only if the process outlives it. */
function stopJob(job, name, pid) {
  if (ro(`claude stop ${job}`)) return;
  (async () => {
    const r = await Shell.run([Shell.claude, 'stop', job], { timeout: 60 });
    for (let i = 0; i < 50 && alive(pid); i++) await sleep(200);
    const still = alive(pid);
    if (still) signal(pid, 'SIGTERM');
    if (r.code !== 0) setNoticeValue(L("'%@' claude stop %@ 실패: %@", name, job, prefixChars((r.err ? r.err : r.out).trim(), 200)));
    else if (still) setNoticeValue(L("'%@' claude stop 후에도 프로세스가 남아 SIGTERM을 보냈습니다.", name));
    refreshSoon();
  })();
}
function exitWatchdog(pid, name, escalate = false) {
  (async () => {
    await sleep(30000);
    if (alive(pid)) {
      signal(pid, escalate ? 'SIGKILL' : 'SIGTERM');
      setNoticeValue(L("'%@'이(가) 30초 안에 끝나지 않아 강제 종료(%@)했습니다.", name, escalate ? 'SIGKILL' : 'SIGTERM'));
    }
    refresh();
  })();
}

// ── teammate creation check ──────────────────────────────────────────────────────────────────────────────────────
function modelMatches(want, got) {
  if (got == null) return false;
  return expandModelAlias(got).startsWith(want);
}
function verifySpawns(agents, teams) {
  const next = [];
  for (const c0 of S.spawnChecks) {
    const c = { ...c0, results: { ...c0.results } };
    if (M.spawnDone(c) && now() - c.started > 30000) continue;        // keep finished results briefly
    const lead = agents.find((a) => a.tmuxPane === c.leadPane && a.state !== 'ended');
    const team = lead && lead.teamName != null ? teams.find((t) => t.name === lead.teamName) : null;
    const mates = team ? M.teamWorkers(team) : [];
    for (const spec of c.specs) {
      if ((c.results[spec.name] ?? 'waiting') !== 'waiting') continue;
      const m = mates.find((x) => x.name === spec.name && x.state !== 'ended');
      let why = null;
      if (m) {
        const diff = [];
        if (!modelMatches(spec.model, m.model)) diff.push(L('모델 %@', m.model ?? '?'));
        if (m.effort != null && m.effort !== spec.effort) diff.push(`effort ${m.effort}`);
        c.results[spec.name] = diff.length === 0 ? 'ok' : { mismatch: diff.join(', ') };
      } else if (lead && (why = leadReportedFailure(lead, c.started)) != null) {
        c.results[spec.name] = 'failed'; c.reason = why;
      } else if (now() - c.started > 120000) {
        c.results[spec.name] = 'failed';
        c.leadScreen = Shell.tmuxSync(['capture-pane', '-p', '-t', c.leadPane]).out
          .split('\n').map(trimWS).filter(Boolean).slice(-8).join('\n');
      }
    }
    next.push(c);
  }
  S.spawnChecks = next;
}
/** The lead's newest reply after `since`, when it reads like a failure report. */
function leadReportedFailure(lead, since) {
  if (lead.transcriptPath == null) return null;
  const t = readTail(lead.transcriptPath, 300000);
  if (!t) return null;
  let latest = null;
  for (const line of t.data.toString('utf8').split('\n')) {
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (!d || d.type !== 'assistant' || typeof d.timestamp !== 'string') continue;
    const ts = ms(d.timestamp);
    const blocks = d.message && Array.isArray(d.message.content) ? d.message.content : null;
    if (ts == null || !(ts > since) || !blocks) continue;
    const text = blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
    if (text) latest = text;
  }
  if (latest == null) return null;
  const low = latest.toLowerCase();
  const failed = ['실패', 'failed', 'could not', "couldn't", 'unable', '거부', 'rejected', 'error'].some((w) => low.includes(w));
  return failed ? prefixChars(latest, 400) : null;
}
function startSpawnCheck(leadPane, specs) { S.spawnChecks.push(M.newSpawnCheck(leadPane, specs)); changed(); }

const requested = {};        // sid -> {model, effort, at}
const confirmed = new Set(); // "sid|/model" once the pane printed the confirmation
function setModel(m, a) {
  const r = requested[a.sessionId] || { model: null, effort: null, at: now() }; r.model = m; r.at = now(); requested[a.sessionId] = r;
  command(`/model ${m}`, a); setNoticeValue(null);
}
function setEffort(e, a) {
  const r = requested[a.sessionId] || { model: null, effort: null, at: now() }; r.effort = e; r.at = now(); requested[a.sessionId] = r;
  command(`/effort ${e}`, a); setNoticeValue(null);
}

/** Teammates are created by the session itself, through Claude Code's own
 *  agent-team tooling: the board sends an explicit instruction naming each
 *  teammate's name, role, model and effort. */
function teammateInstruction(specs) {
  // Tested wording: names the tool and forbids researching first (Haiku leads
  // otherwise launch a guide agent instead of spawning the teammate).
  let s = 'Spawn the following teammates right now using your Agent tool, one call per teammate. Do not research how teams work and do not launch any other agent first. Use exactly the given name, model and effort.\n';
  for (const t of specs) {
    if (!trimWS(t.name)) continue;
    const role = trimWS(t.role);
    s += `- name "${t.name}", model ${t.model}, effort ${t.effort}. Task: ${role ? role : 'reply "ready" once, then stay idle and wait for instructions from the team lead.'}\n`;
  }
  s += 'After spawning, report in one line per teammate whether it succeeded.';
  return s;
}
function addTeammates(specs0, a) {
  const specs = (specs0 || []).map(M.teammateSpec);
  const valid = specs.filter(M.nameIsValid);
  if (valid.length < specs.filter((s) => trimWS(s.name)).length) setNoticeValue(L('팀원 이름은 영문·숫자·_·- 만 쓸 수 있습니다 (Claude의 Agent 도구 제한). 잘못된 이름은 건너뛰었습니다.'));
  if (!valid.length) return;
  if (a.state === 'ended' || a.tmuxPane == null) { setNoticeValue(L('tmux pane에서 실행 중인 세션에만 팀원을 추가할 수 있습니다.')); return; }
  if (ro(`addTeammates ${a.sessionId}`)) return;
  send(teammateInstruction(valid), a);
  startSpawnCheck(a.tmuxPane, valid);
  setNoticeValue(null);
}

/** Starts `claude -n NAME --model M --effort E [PROMPT]` in a new tmux session. */
async function createSession(name, cwd, model, effort, teammates, task, bypass = false) {
  const clean = String(name || '').trim();
  if (!clean) { setNoticeValue(L('이름을 입력하세요.')); return null; }
  if (!isDir(cwd)) { setNoticeValue(L('작업 폴더가 없습니다: %@', cwd)); return null; }
  let prompt = '';
  const team = (teammates || []).map(M.teammateSpec).filter((t) => trimWS(t.name));
  if (team.length) prompt += teammateInstruction(team);
  if (String(task || '').trim()) prompt += (prompt ? '\n' : '') + L('작업: %@', task);
  const argv = [Shell.claude, '-n', clean, '--model', model, '--effort', effort];
  if (bypass) argv.push('--dangerously-skip-permissions');
  if (prompt) argv.push(prompt);
  const tmuxName = await launchInTmux(clean, cwd, argv);
  if (tmuxName == null) return null;
  if (team.length) {
    const pane = (await Shell.tmux(['list-panes', '-t', tmuxName, '-F', '#{pane_id}'])).out.split('\n').filter(Boolean)[0];
    if (pane) startSpawnCheck(pane, team);
  }
  setNoticeValue(L("새 세션 '%@' 시작 (tmux: %@)", clean, tmuxName) + (team.length ? L(' — 팀원 %@명 생성 지시 포함', String(team.length)) : ''));
  refresh(); refreshSoon();
  return tmuxName;
}
/** `claude update` in the background; running sessions keep their version until restarted. */
function updateClaude() {
  if (ro('claude update')) return;
  setNoticeValue(L('Claude Code 업데이트 확인 중…'));
  (async () => {
    const r = await Shell.run([Shell.claude, 'update'], { timeout: 300 });
    const ls = r.out.split('\n').map(trimWS).filter(Boolean);
    const last = ls.length ? ls[ls.length - 1] : '';
    setNoticeValue(r.code === 0 ? L('Claude Code 업데이트: %@ — 실행 중인 세션은 다시 시작해야 새 버전을 씁니다.', last) : L('Claude Code 업데이트 실패: %@', last));
  })();
}
/** One click: a home-folder session that analyses disk use and proposes a clean-up (nothing is removed before approval). */
function createDiskManager() {
  const bypass = prefs['new.bypass'] ?? true;
  return createSession('Memory Manager', home, 'claude-sonnet-5-5', 'low', [], diskManagerPrompt(), bypass);
}
/** The macOS prompt names macOS places (~/Library, Time Machine); this is the same instruction for a Linux home. */
function diskManagerPrompt() {
  return L(`너는 이 Linux 컴퓨터의 디스크 관리자다. 지금은 분석하고 정리 방법을 제안만 한다. 내가 승인하기 전에는 아무것도 지우거나 옮기지 마라.
아래를 조사해라. 오래 걸리는 du는 깊이를 제한하고, 권한 오류는 건너뛴다.
1. 디스크 전체 용량과 여유 공간 (df -h / ~).
2. 홈 폴더 아래 가장 큰 폴더 상위 20개.
3. 개발·앱 캐시: ~/.cache, ~/.npm, ~/.cargo, pip·conda·micromamba 캐시, ~/.local/share/Trash, Flatpak·Snap 데이터(~/.var/app, ~/snap), Docker·Podman 이미지와 볼륨, 패키지 관리자 캐시(apt/dnf/pacman).
4. 오래 쓰지 않은(90일 이상) 캐시와 임시 파일: /tmp, /var/tmp, ~/Downloads 안의 오래되고 큰 파일, journalctl 로그 크기.
5. 최근 30일 안에 설치되었고 크기가 큰 패키지와 앱.
6. 휴지통 크기와 스냅샷(Timeshift, btrfs/LVM 스냅샷)이 있으면 그 크기.
결과는 "항목 · 크기 · 마지막 사용 · 판단(안전/확인 필요/위험) · 정리 방법(명령)" 표로 정리하고, 확보 가능한 용량 합계와 추천 순서를 제안해라.
클라우드 동기화 폴더, 문서·사진 원본, 연구 자료는 정리 대상으로 제안하지 마라.`);
}
function trackLaunches(knownPids, usedPanes) {
  if (!S.launches.length) return;
  const next = [];
  for (const l0 of S.launches) {
    const l = { ...l0 };
    const r = Shell.tmuxSync(['list-panes', '-t', l.tmuxName, '-F', '#{pane_pid}\u001f#{pane_dead}\u001f#{pane_id}']);
    const f = (r.out.split('\n').filter(Boolean)[0] || '').split('\u001f').filter((x) => x.length > 0);
    const pid = Number.parseInt(f[0], 10);
    if (r.code !== 0 || f.length !== 3 || !Number.isInteger(pid)) {
      setNoticeValue(L("'%@' 세션이 시작 전에 종료되었습니다.", l.name));
      continue;                                   // gone: drop it
    }
    if (f[1] === '1') {                           // ended before registering: its last words are still on the pane (remain-on-exit)
      const screen = Screen().stripANSI(Shell.tmuxSync(['capture-pane', '-p', '-t', f[2], '-S', '-40']).out);
      Shell.tmuxSync(['kill-session', '-t', l.tmuxName]);
      launchFailed(l, screen);
      continue;
    }
    // registered: a session file for the process; for `claude attach` (none), the pane drawn on a job's card
    const registered = l.attachJob != null ? usedPanes.has(f[2]) : (knownPids.has(pid) || exists(home + `/.claude/sessions/${pid}.json`));
    if (registered) { Shell.tmuxSync(['set-option', '-w', '-t', l.tmuxName, 'remain-on-exit', 'off']); continue; }
    const screen = Shell.tmuxSync(['capture-pane', '-p', '-t', l.tmuxName]).out;
    l.screenTail = screen.split('\n').map(trimWS).filter(Boolean).slice(-6).join('\n');
    if (screen.includes('trust this folder') || screen.includes('Yes, I trust')) l.phase = 'needsTrust';
    else if (isFirstRunScreen(screen)) l.phase = 'needsSetup';
    else if (now() - l.created > 90000) l.phase = 'stuck';
    else l.phase = 'starting';
    next.push(l);
  }
  S.launches = next;
}
/** The CLI's own first-run flow (Claude Code 2.1.302): text style, login method, OAuth code. Not ours to answer. */
function isFirstRunScreen(screen) {
  return ['Choose the text style', 'Select login method', 'Paste code here if prompted', "Let's get started"].some((s) => screen.includes(s));
}
/** A launch stuck on the CLI's first-run flow: hand its tmux window to a terminal so the person can finish there. */
async function openLaunchTerminal(l) {
  const pane = (await Shell.tmux(['list-panes', '-t', l.tmuxName, '-F', '#{pane_id}'])).out.split('\n').filter(Boolean)[0];
  if (!pane) { setNoticeValue(L("'%@' 세션 창을 찾지 못했습니다.", l.name)); return; }
  const r = await attachTerminal(l.tmuxName, pane);
  setNoticeValue(r.code === 0 ? L("터미널에서 '%@'을(를) 열었습니다. 설정과 로그인을 마치면 여기에 나타납니다.", l.name) : L('터미널을 열지 못했습니다: %@', prefixChars(r.err, 120)));
}
/** The CLI quit before registering: act on the refusals it is known to print, show any other. */
function launchFailed(l, screen) {
  const tail = screen.split('\n').map(trimWS).filter(Boolean).slice(-8).join(' ');
  if (l.resume) {
    const m = /running in the background \(([0-9a-f]{8})\)/.exec(tail);
    if (m) {
      const id = m[1];
      setNoticeValue(L("'%@'은(는) 이미 CLI 백그라운드 작업 %@(으)로 실행 중입니다. 새로 띄우지 않고 그 화면을 붙입니다 (claude attach).", l.name, id));
      attach(id, l.name, l.cwd); return;
    }
    if (tail.includes('No deferred tool marker')) {
      setNoticeValue(L("'%@'은(는) CLI 백그라운드 작업의 대화라 --resume으로 열리지 않습니다. CLI 방식대로 --bg --resume으로 이어서 엽니다.", l.name));
      resumeAsJob(l.resume.sid, null, l.name, l.cwd, l.resume.model, l.resume.effort, l.resume.bypass); return;
    }
  }
  setNoticeValue(L("'%@' 세션이 시작 전에 종료되었습니다: %@", l.name, prefixChars(tail, 240)));
}
/** The person's answer to Claude Code's own folder-trust prompt. */
function trustFolder(l) {
  if (ro(`trustFolder ${l.tmuxName}`)) return;
  const n = l.tmuxName;
  const C = TmuxControl();
  C.queue(n, async () => {
    if (!(await C.keys(['-t', n, 'Down'], L('폴더 신뢰 선택(↓)')))) return;
    await sleep(150);
    await C.keys(['-t', n, 'Enter'], L('폴더 신뢰 확인(Enter)'));
  });
  setNoticeValue(L("'%@' 폴더를 신뢰하고 '%@'을(를) 시작합니다.", l.cwd, l.name));
}
function cancelLaunch(l) {
  if (ro(`cancelLaunch ${l.tmuxName}`)) return;
  Shell.tmux(['kill-session', '-t', l.tmuxName]);
  S.launches = S.launches.filter((x) => x.id !== l.id);
  setNoticeValue(L("'%@' 시작을 취소했습니다.", l.name));
}
async function launchInTmux(label, cwd, argv, attachJob = null, resume = null) {
  if (ro(`launchInTmux ${label} ${argv.slice(1).join(' ').slice(0, 80)}`)) return null;
  let slug = Array.from(label).map((ch) => (/^[A-Za-z0-9]$/.test(ch) ? ch : '-')).slice(0, 24).join('').replace(/^-+|-+$/g, '');
  if (!slug) slug = 'session';
  const tmuxName = `ab-${slug}-` + String(Math.trunc(now() / 1000) % 100000);
  let cmd = argv.map(shellQuote).join(' ');
  // the CLI's own next-prompt prediction (dim text in its box) is off unless this is set; only the session itself
  // gets it (an `env` prefix, not the tmux session environment), so teammates it spawns do not pay for it
  if (prefs['ui.cliSuggest'] ?? true) cmd = 'env CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=1 ' + cmd;
  const r = await Shell.tmux(['new-session', '-d', '-s', tmuxName, '-x', '220', '-y', '60', '-c', cwd, '-e', `PATH=${Shell.path}`, cmd]);
  Shell.tmux(['set-environment', '-g', 'PATH', Shell.path]);
  if (r.code !== 0) { setNoticeValue(L('세션 시작 실패: %@', prefixChars(r.err, 160))); return null; }
  await Shell.tmux(['set-option', '-w', '-t', tmuxName, 'remain-on-exit', 'on']);   // a refusal printed before the CLI registers stays readable (trackLaunches)
  const l = M.newLaunch(tmuxName, label, cwd); l.attachJob = attachJob; l.resume = resume;
  S.launches.push(l);
  refresh(); refreshSoon();
  return tmuxName;
}

/** The folder a session ran in, from its transcript (records carry "cwd"). */
function workingDirectory(a) {
  if (a.cwd != null) return a.cwd;
  const p = a.transcriptPath ?? transcript(a.sessionId);
  return p == null ? null : transcriptCwd(p);
}
const canResume = (a) => a.state === 'ended' && (a.transcriptPath ?? transcript(a.sessionId)) != null;
/** Reopens an ended conversation the CLI's way: `claude --resume <id>` in a background tmux session; `--bg --resume` and
 *  `claude attach` for a conversation that belongs to a CLI background job. Model/effort are launch flags, so the user's
 *  defaults are untouched. Never a copy unless asked (`fork`): one conversation is one session id, in the CLI and here. */
async function resume(a, model, effort, bypass = false, fork = false) {
  if (!canResume(a)) { setNoticeValue(L('대화 기록이 없어 다시 시작할 수 없습니다.')); return null; }
  const cwd = workingDirectory(a);
  if (cwd == null || !exists(cwd)) { setNoticeValue(L('원래 작업 폴더를 찾을 수 없습니다.')); return null; }
  const sid = conversationId(a);
  // one conversation, one process: a second `claude --resume` of a running one is refused by the CLI (or, with
  // --fork-session, becomes a copy under a new id) — so it is never started from here by itself
  const live = agent(sid);
  if (live && live.state !== 'ended') { setNoticeValue(L("'%@'은(는) 이미 실행 중입니다. 그 세션을 엽니다.", live.name)); open(live); return null; }
  const rj = runningJob(sid);
  if (rj) {
    setNoticeValue(L("'%@'은(는) CLI 백그라운드 작업 %@(으)로 실행 중입니다. 새로 띄우지 않고 그 화면을 붙입니다 (claude attach).", a.name, rj.id));
    return attach(rj.id, a.name, cwd);
  }
  const job = jobRecord(sid);
  if (job) return resumeAsJob(sid, job.id, a.name, cwd, model, effort, bypass);
  const argv = [Shell.claude, '--resume', sid, ...(fork ? ['--fork-session'] : []), '--model', model, '--effort', effort, ...(bypass ? ['--dangerously-skip-permissions'] : [])];
  const t = await launchInTmux(a.name, cwd, argv, null, { sid, model, effort, bypass });
  if (t == null) return null;
  deleted.delete(sid);
  setNoticeValue(L("'%@' 다시 시작 (tmux: %@)", a.name, t) + (fork ? L(' — 복사본(새 세션 ID)으로 분기합니다. 원본 대화는 그대로 남습니다.') : '') + (a.teamName != null && !a.isLead ? L(' — 팀원 세션은 팀과 분리된 개별 세션으로 열립니다.') : ''));
  return t;
}
/** The id of the conversation behind a card: its transcript's name, else the card's own id. */
function conversationId(a) { const p = a.transcriptPath ?? transcript(a.sessionId); return p != null ? basenameNoExt(p) : a.sessionId; }
/** The CLI's job record for a conversation (also a stopped one: the record outlives the process until `claude rm`). */
function jobRecord(sid) { return Object.values(lastJobs).find((j) => j.sessionId === sid || j.resumeSessionId === sid) || null; }
/** The CLI background job that runs this conversation right now (a live process behind the record). */
function runningJob(sid) {
  const j = jobRecord(sid);
  if (!j) return null;
  return allAgents().some((a) => a.jobId === j.id && a.state !== 'ended' && a.pid != null) ? j : null;
}
/** The CLI's own viewer for a background job, in a tmux session the board can type into. */
function attach(job, label, cwd) { return launchInTmux(label, cwd, [Shell.claude, 'attach', job], job); }
/** A conversation that belongs to a CLI background job: `--resume` cannot reopen it (the CLI answers "No deferred tool
 *  marker…", with or without --fork-session). The CLI's own way is `--bg --resume <id>` (same job, same session id),
 *  then `claude attach`. */
function resumeAsJob(sid, jobId, label, cwd, model, effort, bypass) {
  if (ro(`resumeAsJob ${sid}`)) return null;
  setNoticeValue(L("'%@' 백그라운드 작업으로 다시 시작하는 중 (claude --bg --resume)…", label));
  (async () => {
    // a stopped job's record left in place makes the CLI start a COPY under a new id (verified); without the record
    // it continues under the same id. The record is only the CLI's list entry: the transcript stays.
    if (jobId != null) await Shell.run([Shell.claude, 'rm', jobId], { timeout: 30 });
    const argv = [Shell.claude, '--bg', '--resume', sid, '--model', model, '--effort', effort];
    if (bypass) argv.push('--dangerously-skip-permissions');
    const r = await Shell.run(argv, { timeout: 60, cwd });
    const text = r.out + '\n' + r.err;
    const m = /attach [0-9a-f]{8}/.exec(text);
    const id = m ? m[0].slice(-8) : null;
    // what the CLI actually continued: the same conversation, or a copy it chose to make
    const st = id ? readJSON(home + `/.claude/jobs/${id}/state.json`) : null;
    const got = st && typeof st.sessionId === 'string' ? st.sessionId : null;
    if (r.code !== 0 || id == null) {
      setNoticeValue(L("'%@' 다시 시작 실패 — claude --bg --resume: %@", label, suffixChars(text.trim(), 220))); return;
    }
    await attach(id, label, cwd);
    setNoticeValue(L("'%@' CLI 백그라운드 작업 %@(으)로 이어서 열었습니다 (claude --bg --resume + attach).", label, id)
      + ((got != null && got !== sid) ? L(' ⚠️ CLI가 같은 ID로 잇지 않고 복사본(%@)을 만들었습니다. 원본 기록은 그대로 남아 있습니다.', prefixChars(got, 8)) : ''));
    if (got != null && got !== sid && jobNames[id] == null) jobNames[id] = label;
    refreshSoon();
  })();
  return 'bg:' + sid;
}

const shellQuote = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

/** The live or ended teammates of a lead (not the lead itself). */
function teammates(a) {
  if (!a.isLead || a.teamName == null) return [];
  const team = S.teams.find((t) => t.name === a.teamName);
  return team ? M.teamWorkers(team) : [];
}
/** Stops the session if it is running, then moves its transcript to the Trash
 *  (recoverable). For an ended team's lead, the team folder goes too. */
async function deleteWithTeammates(a, withTeammates) {
  if (withTeammates) for (const w of teammates(a)) await deleteAgent(w);
  await deleteAgent(a);
}
async function deleteAgent(a) {
  if (ro(`delete ${a.sessionId}`)) return;
  // a CLI background job lives on in the CLI's own list (`claude agents`, its ← screen) until the CLI removes it:
  // stop, wait for the process, rm, and only then drop the board's records. In that order and in the background;
  // fired together, rm raced a still-running stop and the record stayed behind in one list but not the other.
  if (a.jobId != null) {
    const job = a.jobId;
    if (jobRemoving.has(job)) return;
    jobRemoving.add(job);
    const pid = a.state !== 'ended' ? a.pid : null;
    setNoticeValue(L("'%@' 백그라운드 작업을 CLI 목록에서 지우는 중…", a.name));
    if (pid != null) {
      await Shell.run([Shell.claude, 'stop', job], { timeout: 60 });
      for (let i = 0; i < 75 && alive(pid); i++) await sleep(200);        // up to 15 s for the process to leave
      if (alive(pid)) signal(pid, 'SIGTERM');
    }
    const r = await Shell.run([Shell.claude, 'rm', job], { timeout: 60 });
    jobRemoving.delete(job);
    if (r.code !== 0) {
      // the job stays in both lists, and the CLI's reason is shown (an unpushed worktree, for example)
      const why = (r.err ? r.err : r.out).trim();
      setNoticeValue(L("'%@' 삭제 실패 — claude rm %@: %@", a.name, job, prefixChars(why, 220)));
      refresh(); return;
    }
    const e = copyAgent(a); e.state = 'ended'; e.jobId = null; e.pid = null;
    return deleteAgent(e);
  }
  if (a.state !== 'ended') {
    if (!canQuit(a) || a.pid == null) return;
    const pid = a.pid;
    quit(a, 'now');
    for (let i = 0; i < 120 && alive(pid); i++) await sleep(100);
    if (alive(pid)) signal(pid, 'SIGKILL');
    const ended = copyAgent(a); ended.state = 'ended';
    return deleteAgent(ended);
  }
  const trashed = [];
  const p = a.transcriptPath ?? transcript(a.sessionId);
  if (p != null) {
    // to the Trash (recoverable); plain removal only when the Trash refuses
    if ((await trashItem(p)) || removeItem(p)) trashed.push(L('대화 기록'));
    const sub = p.replace(/\.[^./]*$/, '');   // subagent folder, if any
    if (exists(sub) && !(await trashItem(sub))) removeItem(sub);
  }
  if (a.teamName != null) {
    const t = a.teamName;
    if (seen[t]) delete seen[t][a.sessionId];
    const others = Object.keys(seen[t] || {}).filter((k) => k !== a.sessionId);
    const othersEnded = others.every((k) => (agent(k) ? agent(k).state : 'ended') === 'ended');
    if (a.isLead && othersEnded) {
      for (const dir of ['teams', 'tasks']) {
        const tp = home + `/.claude/${dir}/${t}`;
        if (exists(tp) && removeItem(tp)) trashed.push(L('팀 %@ 폴더', dir));
      }
      delete seen[t];
    }
    saveSeen();
  }
  deleted.add(a.sessionId);
  writeFileSafe(deletedURL, JSON.stringify([...deleted]));
  delete transcriptIndex[a.sessionId];
  transcriptScan.tick = -100;                          // the file list changed: rescan now
  setChat(a.sessionId, null);
  if (S.selectedAgent === a.sessionId) setSelectedAgentValue(null);
  setNoticeValue(L("'%@' 삭제: %@", a.name, trashed.length === 0 ? L('옮길 파일 없음') : L('%@을 휴지통으로 이동', trashed.join(', '))));
  refresh();
}
function forget(a) {
  if (a.state !== 'ended' || a.teamName == null) return;
  if (ro(`forget ${a.sessionId}`)) return;
  if (seen[a.teamName]) delete seen[a.teamName][a.sessionId];
  saveSeen(); refresh();
}
/** Opens a session's detail screen: its team tab, or 개별 세션 for a standalone session. */
function open(a) {
  setSelectedAgentValue(a.sessionId);
  const tab = (a.teamName == null || a.solo) ? '__loose' : a.teamName;
  if (tab !== '__loose') S.selectedTeam = tab;
  S.navRequest = M.navRequest(tab);
  changed();
  refreshSoon();
}
// ── batch actions on selected cards ─────────────────────────────────────────────────────────────────────────────
const selectedAgents = () => [...S.selection].map(agent).filter(Boolean);
async function wakeSelected() {
  if (ro('wakeSelected')) return;
  let n = 0;
  for (const a of selectedAgents()) {
    if (!canResume(a)) continue;
    const m = M.modelChoiceFor(a.model, 'claude-opus-5-5');
    const e = M.effortChoiceFor(a.effort, 'low');
    if ((await resume(a, m, e)) != null) n += 1;
  }
  setNoticeValue(L('%@개 세션을 다시 시작했습니다.', String(n)));
  S.selection.clear(); changed();
}
function quitSelected(mode) {
  if (ro('quitSelected')) return;
  const targets = selectedAgents().filter(canQuit);
  for (const a of targets) quit(a, mode);
  setNoticeValue(mode === 'whenIdle' ? L('%@개 세션에 종료를 보냈습니다 (작업 중인 세션은 끝난 뒤 종료).', String(targets.length)) : L('%@개 세션에 종료를 보냈습니다.', String(targets.length)));
  S.selection.clear(); changed();
}
function archiveSelected() {
  if (ro('archiveSelected')) return;
  const targets = selectedAgents();
  for (const a of targets) archive(a, false);
  setNoticeValue(L('%@개 세션을 보관함으로 옮겼습니다.', String(targets.length)));
  S.selection.clear(); changed();
}

// ── app lifecycle: quit = sessions off, launch = sessions back on ──────────────────────────────────────────────────
const pendingRespawn = {};   // tmux session of a resumed lead -> teammates to re-create
const savedURL = ab('resume-on-launch.json');
const skipShutdownFlag = ab('skip-shutdown-once');   // a relaunch by the build script
const controllableLive = () => allAgents().filter((a) => a.tmuxPane != null && a.state !== 'ended' && a.pid != null);

/** Switches every session the board controls off the way the CLI does (/exit; ctrl+c twice and `claude stop` for a
 *  background job and its viewer), remembers leads and standalone sessions for the next launch. Returns what did not
 *  end cleanly, for the person to see before the app is gone. */
async function shutdownAll() {
  if (ro('shutdownAll')) return [];
  if (timer) { clearInterval(timer); timer = null; }   // no more refreshes while quitting
  refresh();
  const live = controllableLive();
  const toSave = live.filter((a) => a.isLead || a.teamName == null || a.solo);
  const saved = toSave.map((a) => M.compact({
    sessionId: a.sessionId, name: a.name, model: a.model, effort: a.effort,
    cwd: a.cwd ?? workingDirectory(a), transcriptPath: a.transcriptPath ?? transcript(a.sessionId),
    teammates: teammates(a).filter((m) => m.state !== 'ended').map((m) => M.compact({ name: m.name, model: m.model, effort: m.effort })),
  }));
  writeFileSafe(savedURL, JSON.stringify(saved));
  const jobsToStop = [];
  const C = TmuxControl();
  for (const a of live) {
    const pane = a.tmuxPane;
    if (pane == null) continue;
    if (a.overlay != null) C.interrupt(pane, 0.5);          // back from the agents list / picker first
    if (a.isBackgroundJob && a.jobId != null) { closeViewer(pane, a.viewerPid); jobsToStop.push({ job: a.jobId, name: a.name }); continue; }
    if (a.parkedJobId != null) { closeViewer(pane, a.pid); continue; }
    if (working(a)) C.interrupt(pane, 0.3);
    C.command('/exit', pane);
  }
  const problems = [];
  for (const j of jobsToStop) {
    const r = await Shell.run([Shell.claude, 'stop', j.job], { timeout: 60 });
    if (r.code !== 0) problems.push(L("'%@': claude stop %@ 실패 — %@", j.name, j.job, prefixChars((r.err ? r.err : r.out).trim(), 160)));
  }
  const pids = live.map((a) => a.pid).concat(live.map((a) => a.viewerPid)).filter((x) => x != null);
  for (let i = 0; i < 60; i++) {                          // up to 30 s
    if (pids.every((p) => !alive(p))) break;
    await sleep(500);
  }
  for (const a of live) {
    for (const p of [a.pid, a.viewerPid].filter((x) => x != null)) {
      if (!alive(p)) continue;
      signal(p, 'SIGTERM');
      problems.push(L("'%@' (pid %@): 30초 안에 끝나지 않아 SIGTERM으로 강제 종료했습니다.", a.name, String(p)));
    }
  }
  return problems;
}
/** Resume what the last quit switched off. */
async function resumeSavedSessions() {
  const list = readJSON(savedURL);
  if (!Array.isArray(list) || list.length === 0) return;
  try { fs.unlinkSync(savedURL); } catch { }
  let n = 0;
  const liveNow = allAgents().filter((a) => a.state !== 'ended');
  const liveIds = new Set(liveNow.map((a) => a.sessionId)), livePids = liveNow.map((a) => a.pid).filter((x) => x != null);
  for (const it of list) {
    if (!it || typeof it.sessionId !== 'string') continue;
    if (liveIds.has(it.sessionId) || S.archive[it.sessionId] || runningJob(it.sessionId)) continue;
    // the CLI may have carried the conversation on by itself (its terminal closed → a background job that resumed
    // it under a new session id): a live process whose command line names this conversation is not switched off
    if (livePids.some((p) => cmdline(p).includes(it.sessionId))) continue;
    const a = newAgent(it.sessionId, null, it.name || '', 'ended');
    a.cwd = it.cwd ?? null; a.transcriptPath = it.transcriptPath ?? transcript(it.sessionId);
    a.model = it.model ?? null; a.effort = it.effort ?? null;
    const m = M.modelChoiceFor(it.model, 'claude-opus-5-5');
    const e = M.effortChoiceFor(it.effort, 'low');
    const tmux = await resume(a, m, e);
    if (tmux != null) {
      n += 1;
      // Official limitation: a resumed lead does not get its teammates back
      // ("tell the lead to spawn new teammates"). Queue exactly that, same names/models/effort.
      const mates = Array.isArray(it.teammates) ? it.teammates : [];
      if (mates.length) {
        pendingRespawn[tmux] = mates.map((mt) => M.teammateSpec({
          name: mt.name,
          role: `You are ${mt.name}, re-created after the team was restarted. Read any shared task list, then wait for the lead's instructions.`,
          model: M.modelChoiceFor(mt.model, 'claude-sonnet-5-5'),
          effort: M.effortChoiceFor(mt.effort, 'low'),
        }));
      }
    }
  }
  setNoticeValue(L('지난번 종료 때 끈 세션 %@개를 다시 시작했습니다.', String(n)));
}

// ── archive ───────────────────────────────────────────────────────────────────────────────────────────────────────
/** Stops the session if running and hides it in the archive. Files stay; restorable. */
function archive(a, withTeammates) {
  if (ro(`archive ${a.sessionId}`)) return;
  if (withTeammates) for (const w of teammates(a)) archive(w, false);
  if (a.jobId != null) cliJob(['stop', a.jobId]);        // stopped in the CLI too, or its agent view brings it back
  else if (canQuit(a)) quit(a, 'now');
  S.archive[a.sessionId] = M.archivedItem({
    sessionId: a.sessionId, name: a.name, teamName: a.teamName, isLead: a.isLead, model: a.model, effort: a.effort,
    cwd: a.cwd ?? workingDirectory(a), transcriptPath: a.transcriptPath ?? transcript(a.sessionId),
    tokensOut: a.tokens.output, tokensTotal: M.tokensTotal(a.tokens), archivedAt: now(),
  });
  S.selection.delete(a.sessionId);
  if (S.selectedAgent === a.sessionId) setSelectedAgentValue(null);
  saveArchive(); refresh();
}
function restore(ids) {
  if (ro('restore')) return;
  // the card comes back from the CLI's own files (the transcript, or the live process)
  for (const id of ids) if (S.archive[id]) { deleted.delete(id); delete S.archive[id]; }
  for (const id of ids) S.archiveSelection.delete(id);
  saveArchive(); saveSeen(); refresh();
  setNoticeValue(L('%@개 세션을 보관함에서 복원했습니다.', String(new Set(ids).size)));
}
/** Permanent: the transcript and its folders are removed from disk. */
async function purge(ids) {
  if (ro('purge')) return;
  for (const id of ids) {
    const it = S.archive[id];
    if (!it) continue;
    const a = newAgent(it.sessionId, null, it.name, 'ended');
    a.teamName = it.teamName; a.isLead = it.isLead; a.transcriptPath = it.transcriptPath;
    await deleteAgent(a);
    delete S.archive[id];
  }
  for (const id of ids) S.archiveSelection.delete(id);
  saveArchive(); refresh();
  setNoticeValue(L('%@개 세션을 영구 삭제했습니다.', String(new Set(ids).size)));
}
function saveArchive() {
  if (RO) return;
  const out = {};
  for (const [k, v] of Object.entries(S.archive)) out[k] = M.archivedToDisk(v);
  writeFileSafe(archiveURL, JSON.stringify(out));
  changed();
}

function agent(sid) {
  if (sid == null) return null;
  return allAgents().find((a) => a.sessionId === sid) || null;
}

// ── terminal ──────────────────────────────────────────────────────────────────────────────────────────────────────
/** A fresh login shell in its own background tmux session, shown inside the app. */
async function newTerminal(cwd) {
  if (ro('newTerminal')) return null;
  const dir = cwd && exists(cwd) ? cwd : home;
  const name = 'ab-term-' + String(Math.trunc(now() / 1000) % 100000);
  const sh = process.env.SHELL && exists(process.env.SHELL) ? process.env.SHELL : '/bin/bash';
  const r = await Shell.tmux(['new-session', '-d', '-s', name, '-x', '120', '-y', '40', '-c', dir, '-e', `PATH=${Shell.path}`, `${sh} -l`]);
  if (r.code !== 0) { setNoticeValue(L('새 터미널을 열지 못했습니다: %@', prefixChars(r.err, 120))); return null; }
  return (await Shell.tmux(['list-panes', '-t', name, '-F', '#{pane_id}'])).out.split('\n').filter(Boolean)[0] ?? null;
}
async function closeTerminal(pane) {
  const s = (await Shell.tmux(['display-message', '-p', '-t', pane, '#{session_name}'])).out.trim();
  if (s.startsWith('ab-term-') && !ro(`closeTerminal ${pane}`)) Shell.tmux(['kill-session', '-t', s]);
}
/** `claude stop|rm <job>`: the CLI's own background-job management. */
function cliJob(args) { if (!ro(`claude ${args.join(' ')}`)) Shell.run([Shell.claude, ...args], { timeout: 30 }); }
/** Opens a terminal window attached to the session's tmux session, with its pane selected. */
async function openTerminal(a) {
  if (a.tmuxSession == null || a.tmuxPane == null) { setNoticeValue(L('이 세션은 tmux 안에서 실행되고 있지 않아 터미널로 열 수 없습니다.')); return; }
  const r = await attachTerminal(a.tmuxSession, a.tmuxPane);
  setNoticeValue(r.code === 0 ? L("터미널에서 '%@'의 tmux 세션을 열었습니다. 닫을 때는 창만 닫으면 되고(세션은 계속 실행), 터미널에서 입력한 것도 여기에 반영됩니다.", a.name) : L('터미널을 열지 못했습니다: %@', prefixChars(r.err, 120)));
}
/** The desktop's terminal attached to a tmux session, on `pane`'s window. No `resize-window` here (it would pin the
 *  window to `manual` size): with `window-size latest` the window follows the terminal while it is attached, and the
 *  app's own views stop resizing it for as long as a client is attached (TmuxResize / #{session_attached}). */
async function attachTerminal(sess, pane) {
  if (ro(`attachTerminal ${sess}`)) return { code: 1, err: 'readonly' };
  return terminalResult(() => platform().attachTerminal(sess, pane));
}
/** platform's terminal openers answer {code, out, err} (like shell.run). */
async function terminalResult(f) {
  try {
    const r = await f();
    if (r === undefined || r === true) return { code: 0, err: '' };
    if (r === false || r === null) return { code: 1, err: '' };
    if (typeof r === 'object') return { code: r.code ?? (r.ok === false ? 1 : 0), err: r.err || r.error || '' };
    return { code: 0, err: '' };
  } catch (e) { return { code: 1, err: String(e.message || e) }; }
}
/** Any tmux pane (in-app shell tab or CLI screen) in the desktop's terminal. */
async function openExternal(pane, title) {
  const sess = (await Shell.tmux(['display-message', '-p', '-t', pane, '#{session_name}'])).out.trim();
  if (!sess) { setNoticeValue(L("터미널 '%@'을(를) 찾지 못했습니다.", title)); return false; }
  const r = await attachTerminal(sess, pane);
  setNoticeValue(r.code === 0 ? L("'%@'을(를) 터미널 앱으로 내보냈습니다.", title) + (sess.startsWith('ab-term-') ? L(' 셸을 끝내려면 그 창에서 exit 하세요.') : '') : L('터미널을 열지 못했습니다: %@', prefixChars(r.err, 120)));
  return r.code === 0;
}
/** A plain shell in the desktop's terminal, outside tmux and outside the app. */
async function openExternalShell(cwd) {
  const d = cwd && exists(cwd) ? cwd : home;
  const r = await terminalResult(() => platform().openShell(d));
  if (r.code !== 0) setNoticeValue(L('터미널을 열지 못했습니다: %@', prefixChars(r.err, 120)));
}

// ── housekeeping ──────────────────────────────────────────────────────────────────────────────────────────────────
/** Teams whose members are all ended and none has a transcript: nothing to show or resume. */
const emptyTeams = () => S.teams.filter((t) => t.members.length > 0 && t.members.every((m) => m.state === 'ended' && m.transcriptPath == null));
async function pruneEmptyTeams(silent = false) {
  if (ro('pruneEmptyTeams')) return;
  let n = 0;
  for (const t of emptyTeams()) {
    for (const dir of ['teams', 'tasks']) {
      const p = home + `/.claude/${dir}/${t.name}`;
      if (exists(p)) await trashItem(p);
    }
    delete seen[t.name]; n += 1;
  }
  saveSeen(); refresh();
  if (!silent) setNoticeValue(L('기록 없는 팀 %@개를 정리했습니다. 팀 폴더는 휴지통으로 옮겼습니다.', String(n)));
}

// ── usage ─────────────────────────────────────────────────────────────────────────────────────────────────────────
function parseUsage(text) {
  const out = [];
  const re = /^[ \t]*(Current [^:\n]+):[ \t]*(\d+)% used(?:[ \t]*·[ \t]*resets ([^\n]+))?/gm;
  let m;
  while ((m = re.exec(text)) !== null) out.push({ label: m[1], percent: Number.parseInt(m[2], 10) || 0, resets: m[3] || '' });
  return out;
}
async function fetchUsage() {
  if (S.usageBusy) return;
  S.usageBusy = true; changed();
  try {
    const probe = probeDir;
    if (!exists(probe) && !ro('mkdir ~/.agent-boost/usage-probe')) { try { fs.mkdirSync(probe, { recursive: true }); } catch { } }
    // --no-session-persistence: the usage probe must not leave a session behind (it used to,
    // once every 5 minutes, which is where the tmp-xx cards came from)
    const r = await Shell.run([Shell.claude, '-p', '--no-session-persistence', '/usage'], { timeout: 120, cwd: exists(probe) ? probe : os.tmpdir() });
    const parsed = parseUsage(r.out);
    if (!parsed.length) {
      // no usage lines: a CLI that is not logged in prints only a cost summary (exit 0, empty stderr), so ask it
      const login = await loginStatus();
      S.loggedOut = login === false;
      S.usageError = login === false ? loginHint() : (!r.err ? L('사용량 출력을 읽지 못함') : prefixChars(r.err, 160));
      if (login === false && !loginNoticed) { loginNoticed = true; setNoticeValue(loginHint()); }
    } else { S.meters = parsed; S.usageUpdated = now(); S.usageError = null; S.loggedOut = false; }
  } finally { S.usageBusy = false; changed(); }
}
const loginHint = () => L('Claude Code에 로그인되어 있지 않습니다. 터미널에서 claude 를 한 번 실행해 로그인하면 사용량과 세션이 동작합니다.');
let loginNoticed = false;
/** `claude auth status` → {"loggedIn": true|false, …}. null: the CLI did not answer (missing, old version, timeout). */
async function loginStatus() {
  const r = await Shell.run([Shell.claude, 'auth', 'status'], { timeout: 30 });
  try { const j = JSON.parse(r.out); return typeof j.loggedIn === 'boolean' ? j.loggedIn : null; } catch { return null; }
}
/** The refresh button: usage and sessions again, shown with the start-up look (gauge sweep + rocket) for at least one pass. */
function manualRefresh() {
  if (S.rebooting) return;
  S.rebooting = true; S.rebootGen += 1;
  refresh();
  (async () => {
    const t0 = now();
    // an automatic read already under way: wait for it instead of skipping, so the sweep ends with fresh numbers
    while (S.usageBusy) await sleep(200);
    await fetchUsage();
    const left = 2600 - (now() - t0);   // one full needle sweep
    if (left > 0) await sleep(left);
    refresh();
    S.rebooting = false; changed();
  })();
}

// ── dock badge → launcher badge + window title ─────────────────────────────────────────────────────────────────────
let lastBadge;
function setBadge(label, waiting, busy) {
  if (label === lastBadge) return;
  lastBadge = label;
  if (!electron) return;
  try { platform().dockBadge(waiting, busy); } catch (e) { console.error('dockBadge', e); }
}

// ── PromptNotifier: a desktop notification when an agent starts waiting for an answer while the app is in the background ─
let notifierInstalled = false;
/** PromptNotifier.update(waiting:enabled:) — platform.notifierUpdate keeps the announced set and shows the notification;
 *  clicking it calls store.open(sid). */
function promptNotifierUpdate(waiting) {
  if (!electron) return;
  const pl = platform();
  if (!pl.notifierUpdate) return;
  if (!notifierInstalled && pl.notifierInstall) { notifierInstalled = true; pl.notifierInstall(module.exports); }
  try { pl.notifierUpdate(waiting.map(M.agentJSON), prefs['ui.showNotices'] ?? true); } catch (e) { console.error('notifier', e); }
}
function showBoard() {
  const pl = platform();
  if (pl.showBoard) { try { pl.showBoard(); return; } catch { } }
  const w = mainModule() && mainModule().window;
  if (w && !w.isDestroyed()) { if (w.isMinimized()) w.restore(); w.show(); w.focus(); }
}

// ── quit: AppDelegate.applicationShouldTerminate ─────────────────────────────────────────────────────────────────────
// Quitting the board switches its sessions off (explicit /exit); the next launch resumes them. The dialogs are the
// renderer's: the store sends 'quit-request' {stops, live, waiting, busy, overlays} and the renderer answers with
// confirmQuit(stops) or cancels; an explicit quit button calls requestQuit(stopSessions).
let quitStops = null;        // set by an explicit quit button: true = also /exit every session, false = app only
let quitAllowed = false;
function describe(waiting) {
  return waiting.map((a) => {
    let s = `• ${a.name}`;
    if (a.prompt) { s += `: ${prefixChars(a.prompt.title, 80)}`; if (a.prompt.options.length) s += `  [${a.prompt.options.map((o) => prefixChars(o, 24)).join(' / ')}]`; }
    return s;
  }).join('\n');
}
function installQuitHandler() {
  if (!electron || !electron.app) return;
  electron.app.on('before-quit', (e) => {
    if (quitAllowed) return;
    if (exists(skipShutdownFlag)) { if (!ro('remove skip-shutdown-once')) { try { fs.unlinkSync(skipShutdownFlag); } catch { } } return; }
    if (process.argv.includes('--snapshot') || process.env.AB_SNAPSHOT) return;
    const live = controllableLive();
    if (!live.length) { quitStops = null; return; }
    // no window left to ask in (closed): quit the app only; the sessions keep running in tmux
    const m = mainModule(), w = m && m.window;
    if (!w || w.isDestroyed()) {
      if (quitStops !== true) { quitStops = null; return; }
      // an explicit "quit sessions too" (the tray) with no window: switch them off without the confirmations
      e.preventDefault(); quitStops = null;
      shutdownAll().then((problems) => { for (const p of problems) console.error(p); finishQuit(); });
      return;
    }
    e.preventDefault();
    const stops = quitStops; quitStops = null;
    showBoard();
    const waiting = live.filter((a) => a.state === 'needsInput');
    emit('quit-request', {
      stops, live: live.length,
      waiting: waiting.map((a) => a.name), waitingText: describe(waiting),
      busy: live.filter((a) => a.state === 'busy').map((a) => a.name),
      overlays: live.filter((a) => a.overlay != null).map((a) => a.name),
    });
  });
}
/** AppDelegate.quit(stopSessions:): an explicit quit with the choice already made (the tray / quit buttons). */
function requestQuit(stopSessions) { quitStops = stopSessions == null ? null : !!stopSessions; if (electron) electron.app.quit(); }
/** The renderer's answer to 'quit-request': false = app only, true = sessions too. Returns the problems shutdownAll
 *  reported (the renderer shows them, then calls finishQuit); quits at once when there are none. */
async function confirmQuit(stops) {
  let problems = [];
  if (stops) problems = await shutdownAll();
  if (!problems.length) finishQuit();
  return problems;
}
function finishQuit() { quitAllowed = true; if (electron) electron.app.quit(); }

// ── state push ────────────────────────────────────────────────────────────────────────────────────────────────────
let sink = null;
const listeners = new Set();
function mainModule() { if (!electron) return null; try { return require('./main'); } catch { return null; } }
function emit(channel, payload) {
  if (sink) { sink(channel, payload); return; }
  const m = mainModule();
  if (m && m.send) m.send(channel, payload);
}
function snapshot() {
  return {
    teams: S.teams.map(M.teamJSON),
    loose: S.loose.map(M.agentJSON),
    meters: S.meters.map(M.meterJSON),
    usageUpdated: S.usageUpdated, usageError: S.usageError, usageBusy: S.usageBusy,
    rebooting: S.rebooting, rebootGen: S.rebootGen, firstScanDone: S.firstScanDone, loggedOut: S.loggedOut,
    selectedTeam: S.selectedTeam, selectedAgent: S.selectedAgent,
    notice: S.notice, noticeLog: S.noticeLog,
    launches: S.launches, spawnChecks: S.spawnChecks.map(M.spawnCheckJSON),
    selection: [...S.selection], archive: S.archive, archiveSelection: [...S.archiveSelection],
    promptSending: [...S.promptSending], sending: [...S.sending], rcPending: [...S.rcPending],
    bounce: S.bounce, pulled: S.pulled, lastSentAt: S.lastSentAt, navRequest: S.navRequest, launchTab: S.launchTab,
    chatVersion: { ...chatVersion },
    emptyTeams: emptyTeams().map((t) => t.name),
    spawnable: { ...spawnable },
    readonly: RO,
  };
}
let pushTimer = null, lastPush = 0, lastJSON = '';
/** Something changed: push the state, at most once per 150 ms, only when it differs from the last push. */
function changed() {
  if (pushTimer) return;
  const wait = Math.max(0, lastPush + 150 - now());
  pushTimer = setTimeout(push, wait);
}
function push() {
  pushTimer = null; lastPush = now();
  const snap = snapshot();
  const j = JSON.stringify(snap);
  if (j === lastJSON) return;
  lastJSON = j;
  emit('state', snap);
  for (const f of listeners) { try { f(snap); } catch (e) { console.error(e); } }
}

// ── exported API (renderer: call('store.<name>', …)) ───────────────────────────────────────────────────────────────
/** Swift `func x(_ a: Agent, …)` → `x(sid, …)`: looks the agent up; unknown ids do nothing. */
const byId = (f) => (sid, ...rest) => { const a = agent(sid); return a ? f(a, ...rest) : undefined; };
const launchById = (f) => (id) => { const l = S.launches.find((x) => x.id === id || x.tmuxName === id); return l ? f(l) : undefined; };

function start() {
  if (started) return;
  started = true;
  init();
  installQuitHandler();
}

module.exports = {
  // lifecycle
  start, refresh: () => refresh(), refreshSoon, manualRefresh, shutdownAll, resumeSavedSessions, requestQuit, confirmQuit, finishQuit,
  fetchUsage, updateClaude, createDiskManager, pruneEmptyTeams: (silent) => pruneEmptyTeams(!!silent),
  // state access
  getState: () => snapshot(),
  onChange: (f) => { listeners.add(f); return () => listeners.delete(f); },
  setSink: (f) => { sink = f; },
  getChat: (sid) => ({ entries: chat[sid] || [], loaded: chat[sid] != null, version: chatVersion[sid] || 0 }),
  agent: (sid) => { const a = agent(sid); return a ? M.agentJSON(a) : null; },
  get teams() { return S.teams; },
  get loose() { return S.loose; },
  get notice() { return S.notice; },
  set notice(v) { setNoticeValue(v); },
  controllableLive: () => controllableLive().map(M.agentJSON),
  // setters for what SwiftUI views set directly on the store
  setSelectedAgent: (sid) => { setSelectedAgentValue(sid); refreshSoon(); },
  setSelectedTeam: (name) => { S.selectedTeam = name == null ? null : name; changed(); },
  setNotice: (text) => setNoticeValue(text),
  // AlertStrip's "지우기": the log and the current notice; SpawnCheckRow's ✕
  clearNoticeLog: () => { S.noticeLog = []; setNoticeValue(null); changed(); },
  removeSpawnCheck: (id) => { S.spawnChecks = S.spawnChecks.filter((c) => c.id !== id); changed(); },
  setSelection: (ids) => { S.selection = new Set(ids || []); changed(); },
  setArchiveSelection: (ids) => { S.archiveSelection = new Set(ids || []); changed(); },
  setDraft: (sid, text, paths) => { if (text == null && !(paths || []).length) delete drafts[sid]; else drafts[sid] = { text: text || '', paths: paths || [] }; },
  getDraft: (sid) => drafts[sid] || null,
  setLastSentDraft: (sid, text, paths) => { lastSentDraft[sid] = { text: text || '', paths: paths || [] }; },
  getLastSentDraft: (sid) => lastSentDraft[sid] || null,
  /** lastSentDraft.removeValue(forKey:) */
  takeLastSentDraft: (sid) => { const d = lastSentDraft[sid] || null; delete lastSentDraft[sid]; return d; },
  setUserInitiated: (v) => { userInitiated = !!v; },
  /** paneChats[sid] += delta (a split pane showing that chat opened (+1) or closed (-1)). */
  paneChat: (sid, delta) => { paneChats[sid] = (paneChats[sid] || 0) + delta; if (paneChats[sid] <= 0) delete paneChats[sid]; if (delta > 0) refreshSoon(); },
  /** Renderer @AppStorage values the store reads: 'ui.cliSuggest', 'new.bypass', 'ui.showNotices'. */
  setPref: (key, value) => { prefs[key] = value; },
  setLaunchTab: (t) => { S.launchTab = t; changed(); },
  // per-agent actions (first argument: sessionId)
  send: (text, sid) => { const a = agent(sid); return a ? send(text, a) : false; },
  answerPrompt: byId(answerPrompt), cancelPrompt: byId(cancelPrompt), forceSendPending: byId(forceSendPending),
  holdOlderRows: (hold, sid) => holdOlderRows(hold, sid),
  pullQueue: byId(pullQueue), clearCLIInput: byId(clearCLIInput), interrupt: byId(interrupt), pushQueue: byId(pushQueue),
  cycleMode: byId(cycleMode), rename: byId((a, raw) => rename(a, raw)), externalHost: byId(externalHost),
  command: (cmd, sid) => { const a = agent(sid); if (a) command(cmd, a); },
  toggleRemote: byId(toggleRemote),
  canControl: byId(canControl), canQuit: byId(canQuit), canResume: byId(canResume), canSpawnTeammates: byId(canSpawnTeammates),
  quit: byId((a, mode) => quit(a, mode === 'whenIdle' ? 'whenIdle' : 'now')),
  setModel: (m, sid) => { const a = agent(sid); if (a) setModel(m, a); },
  setEffort: (e, sid) => { const a = agent(sid); if (a) setEffort(e, a); },
  addTeammates: (specs, sid) => { const a = agent(sid); if (a) addTeammates(specs, a); },
  teammateInstruction: (specs) => teammateInstruction((specs || []).map(M.teammateSpec)),
  createSession,
  workingDirectory: byId(workingDirectory),
  resume: byId((a, model, effort, bypass, fork) => resume(a, model, effort, !!bypass, !!fork)),
  conversationId: byId(conversationId),
  jobRecord: (sid) => jobRecord(sid),
  runningJob: (sid) => runningJob(sid),
  attach: (job, label, cwd) => attach(job, label, cwd),
  teammates: byId((a) => teammates(a).map(M.agentJSON)),
  delete: byId((a, withTeammates) => deleteWithTeammates(a, !!withTeammates)),
  forget: byId(forget),
  open: byId(open),
  wakeSelected, quitSelected: (mode) => quitSelected(mode === 'whenIdle' ? 'whenIdle' : 'now'), archiveSelected,
  archive: byId((a, withTeammates) => archive(a, !!withTeammates)),
  restore: (ids) => restore(ids || []), purge: (ids) => purge(ids || []),
  // launches (argument: the launch id = its tmux session name)
  trustFolder: launchById(trustFolder), cancelLaunch: launchById(cancelLaunch), openLaunchTerminal: launchById(openLaunchTerminal),
  // terminals
  newTerminal, closeTerminal, openTerminal: byId(openTerminal), openExternal, openExternalShell,
  // static helpers other modules use
  overlayName, storedTitle, queuedTexts, queuedCount, cmdline, flag, expandModelAlias, processStart, paneIsBusy, shellQuote,
  isFirstRunScreen, diskManagerPrompt, teammateInstructionRaw: teammateInstruction, parseUsage, loginStatus, skipShutdownFlag,
  // unused in Swift too (defined, not called): kept for side-by-side reading
  _attachSubagents: attachSubagents,
};
