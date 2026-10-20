// Port of TmuxControl.swift: SendLog, TmuxControl (typing into agents' panes) and TmuxCache (background-collected tmux
// state), in one module.
//
// Swift runs each pane's work on a serial DispatchQueue and blocks (usleep) inside it. Here a pane's queue is a promise
// chain: work items run one after another, each may await (sleep, tmux), and the main process never blocks.
// Every TmuxControl entry point returns a promise (callers that do not care just ignore it).
//
// Hooks (set them from the store): tmux.onWarning = (text) => …, tmux.onDone = (sid) => …, tmux.onLost = (sid) => …,
// tmux.onAutoConfirm = (pane) => … (the same as tmux.cache.onAutoConfirm).
//
// Names: TmuxControl's functions keep their names (send, keys, pullQueue, …). TmuxCache lives in `tmux.cache` and its
// functions are also exported flat (state, prompt, overlay, foreignTyped, status, busy, setWanted, expectModelConfirm,
// markSent, isSettled, probe, update). TmuxCache.panes / .paneSessions (cached maps) are tmux.cachedPanes() /
// tmux.cachedPaneSessions() flat, because TmuxControl.panes() / paneSessions() (live) already own those names.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const shell = require('./shell');
const Screen = require('./screen');
const { L } = require('./l10n');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
function readonlyRefuse(action) {
  if (!process.env.AB_READONLY) return false;
  console.log(`[readonly] tmux.${action}`);
  return true;
}

// ───────────────────────────── SendLog ─────────────────────────────
/** Every step of sending a message, one line each, in ~/.agent-boost/send.log (kept under 512 KB): a message that never
 *  reached the CLI can be traced afterwards (refused, composer rebuilt, typed into the wrong pane, Enter swallowed).
 *  AB_SENDLOG overrides the file (tests); with AB_READONLY it goes to the temp folder so ~/.agent-boost stays untouched. */
const SendLog = (() => {
  const file = () => process.env.AB_SENDLOG
    || (process.env.AB_READONLY ? path.join(os.tmpdir(), 'agent-boost-send.log') : path.join(os.homedir(), '.agent-boost', 'send.log'));
  let chain = Promise.resolve();
  function note(s) {
    const line = new Date().toISOString() + ' ' + String(s).split('\n').join('⏎') + '\n';
    const p = file();
    chain = chain.then(async () => {
      try {
        await fs.promises.mkdir(path.dirname(p), { recursive: true });
        try {
          const st = await fs.promises.stat(p);
          if (st.size > 512000) { await fs.promises.rm(p + '.1', { force: true }); await fs.promises.rename(p, p + '.1'); }
        } catch { }
        await fs.promises.appendFile(p, line);
      } catch { }
    });
    return chain;
  }
  function head(t) { const cs = [...t]; return '"' + cs.slice(0, 40).join('') + (cs.length > 40 ? '…' : '') + '" (' + cs.length + '자)'; }
  /** Resolves when every line noted so far is written (tests). */
  function flush() { return chain; }
  return { note, head, file, flush };
})();

// ───────────────────────────── TmuxControl ─────────────────────────────
/** Sends input to agents through tmux. Every entry point validates the pane id. */
const T = {};

function valid(pane) { return typeof pane === 'string' && /^%[0-9]+$/.test(pane); }

// Every send-keys for a pane goes through one serial queue: text and Enter of one message can no longer interleave with
// the next message or a slash command, and the main process never waits on tmux.
const queues = new Map();
function enqueue(pane, work) {
  if (!valid(pane)) return Promise.resolve();
  return queue(pane, work);
}
/** The serial queue for a pane (or a tmux session name): anything that types into it goes through here.
 *  Resolves to the work's result (undefined when it threw; the error is logged). */
function queue(key, work) {
  const prev = queues.get(key) || Promise.resolve();
  const tail = prev.then(() => work()).catch((e) => { console.error('[tmux queue]', key, e); return undefined; });
  queues.set(key, tail);
  tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return tail;
}
/** Runs one tmux command on the key's queue and returns its result without blocking the caller. */
function exec(key, args) { return queue(key, () => shell.tmux(args)); }

/** send-keys that tells the user when tmux refused it (pane gone, server down) instead of losing the input silently. */
async function keys(args, what = L('키 입력')) {
  if (readonlyRefuse('keys ' + args.join(' ').slice(0, 60))) return false;
  const r = await shell.tmux(['send-keys'].concat(args));
  if (r.code !== 0 && T.onWarning) T.onWarning(L('%@을(를) tmux에 보내지 못했습니다: %@', what, r.err.trim().slice(0, 80)));
  return r.code === 0;
}

/** Text + Enter, as if typed into the agent's prompt. Multi-line text is pasted (bracketed paste) so its newlines are not
 *  taken for Enter. Resolves when the send has finished (Enter taken, or given up); onDone(sid) is called then. */
function send(text, pane, sid = '') {
  if (!valid(pane)) { SendLog.note(`tmux ${pane}: 잘못된 pane id — 보내지 않음`); return Promise.resolve(); }
  if (readonlyRefuse('send ' + pane)) { if (T.onDone) setImmediate(() => T.onDone(sid)); return Promise.resolve(); }
  return enqueue(pane, async () => {
    try { await sendNow(text, pane, sid); }
    finally { if (T.onDone) setImmediate(() => T.onDone(sid)); }
  });
}
/** Messages waiting in the CLI's queue come back into its box with ↑ (the CLI records "popAll"); the box is then
 *  emptied, so the queue is gone and the app holds the text. With no popAll the ↑ only walked the prompt history
 *  (the queue had already run): ↓ steps back to the empty box. Resolves true (and calls done(true)) when the queue was
 *  taken out. */
function pullQueue(pane, sid, done) {
  const finish = (ok) => { if (typeof done === 'function') setImmediate(() => done(ok)); return ok; };
  if (readonlyRefuse('pullQueue ' + pane)) return Promise.resolve(finish(false));
  if (!valid(pane)) return Promise.resolve();
  return enqueue(pane, async () => {
    const p = transcript(sid);
    if (!p) return finish(false);
    const mark = size(p);
    await keys(['-t', pane, 'Up'], L('대기열 꺼내기(↑)'));
    let ok = false;
    const end = now() + 2000;
    do {
      if (appended(p, mark).includes('"popAll"')) { ok = true; break; }
      await sleep(100);
    } while (now() < end);
    if (ok) {
      await sleep(150);
      for (let i = 0; i < 30; i++) { await keys(['-t', pane, 'C-u'], L('입력창 비우기')); await sleep(30); }
    } else {
      await keys(['-t', pane, 'Down'], L('↓ (기록 탐색 되돌리기)'));
    }
    SendLog.note(`tmux ${pane}: 대기열 꺼내기 ` + (ok ? '성공 — CLI 입력창 비움' : '실패 (대기열이 이미 처리됨)'));
    return finish(ok);
  });
}

/** The CLI turns pasted image paths into "[Image #n]" chips. While it reads them ("Pasting…" under the box, half a
 *  second or more for large screenshots) the box is empty and an Enter does nothing: the message then stayed unsent.
 *  Waits until "Pasting…" is gone and, with `needText`, the pasted text shows in the box (at most 20 s; 1.5 s when
 *  no "Pasting…" ever shows). Only the lines under the box count: the conversation above may quote the word. */
async function waitPasted(pane, needText) {
  const start = now();
  const pasting = (raw) => raw.split('\n').map((l) => l.trim()).filter((l) => l.length > 0).slice(-3)
    .some((l) => Screen.stripANSI(l).includes('Pasting…'));
  while (now() - start < 20000) {
    const raw = (await shell.tmux(['capture-pane', '-p', '-e', '-t', pane])).out;
    if (!pasting(raw) && (!needText || Screen.typedInput(raw) || now() - start > 1500)) {
      if (now() - start > 300) SendLog.note(`tmux ${pane}: 붙여넣기 처리 기다림 ${((now() - start) / 1000).toFixed(1)}초`);
      return;
    }
    await sleep(100);
  }
  SendLog.note(`tmux ${pane}: 20초가 지나도 붙여넣기 처리가 끝나지 않음`);
}

const historyPath = () => path.join(os.homedir(), '.claude', 'history.jsonl');
function size(p) { try { return fs.statSync(p).size; } catch { return 0; } }
/** The session's transcript (~/.claude/projects/<project>/<sid>.jsonl), if there is one. */
function transcript(sid) {
  if (!sid) return null;
  const root = path.join(os.homedir(), '.claude', 'projects');
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch { return null; }
  for (const d of dirs) {
    const p = path.join(root, d, sid + '.jsonl');
    if (fs.existsSync(p)) return p;
  }
  return null;
}
function appended(p, offset) {
  let fd;
  try {
    fd = fs.openSync(p, 'r');
    const end = fs.fstatSync(fd).size;
    if (end <= offset) return '';
    const buf = Buffer.alloc(end - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    return buf.toString('utf8');
  } catch { return ''; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { } }
}
/** Did the CLI take the message? A message it runs at once goes to ~/.claude/history.jsonl; one typed while a turn runs
 *  is queued first ("queue-operation" enqueue in the transcript) and reaches history only when it runs, which can be
 *  many seconds later. Either counts. An empty box alone does not prove it: a pasted message with image paths once
 *  vanished from the box while the CLI was still turning the paths into images, and was never submitted. */
async function accepted(sid, hOff, t, seconds) {
  const needle = `"sessionId":"${sid}"`;
  const end = now() + seconds * 1000;
  do {
    if (appended(historyPath(), hOff).includes(needle)) return true;
    if (t) {
      const added = appended(t.path, t.off);
      if (added.includes('"operation":"enqueue"') || added.includes('"type":"user"')) return true;
    }
    await sleep(250);
  } while (now() < end);
  return false;
}
async function sendNow(text, pane, sid = '') {
  if (!text) return;
  const Attach = require('./attach');
  const mark = size(historyPath());
  const tpath = transcript(sid), tmark = tpath ? { path: tpath, off: size(tpath) } : null;
  SendLog.note(`tmux ${pane}: 입력 시작 ` + SendLog.head(text));
  if (text.includes('\n')) {
    const file = path.join(os.tmpdir(), 'ab-paste-' + crypto.randomUUID());
    const buf = 'ab-' + pane.slice(1);
    let pasted = false;
    try {
      fs.writeFileSync(file, text, 'utf8');
      const l = await shell.tmux(['load-buffer', '-b', buf, file]);
      try { fs.rmSync(file, { force: true }); } catch { }
      // -r keeps LF as LF (tmux would turn it into CR, which the prompt takes for Enter)
      if (l.code === 0) pasted = (await shell.tmux(['paste-buffer', '-p', '-r', '-d', '-b', buf, '-t', pane])).code === 0;
    } catch { }
    if (!pasted) {
      if (T.onWarning) T.onWarning(L('여러 줄 붙여넣기에 실패해 줄바꿈이 Enter로 처리될 수 있습니다.'));
      await keys(['-t', pane, '-l', '--', text], L('메시지 입력'));
    }
  } else {
    if (!(await keys(['-t', pane, '-l', '--', text], L('메시지 입력')))) { SendLog.note(`tmux ${pane}: 글자 입력 실패`); return; }
  }
  await sleep(multilineSettle(text));
  await waitPasted(pane, true);
  await keys(['-t', pane, 'Enter'], 'Enter');
  // the CLI can swallow that Enter while it turns pasted image paths into "[Image #n]" chips: the text then stayed
  // in its box, and every later send was refused as "someone is typing there". Check the box emptied; if not, again.
  for (const wait of [350, 700, 1400]) {
    await sleep(wait);
    await waitPasted(pane, false);
    const raw = await shell.tmux(['capture-pane', '-p', '-e', '-t', pane, '-S', '-4']);
    if (!(raw.code === 0 && Screen.typedInput(raw.out))) {
      // a slash command the CLI runs itself is not always written to history: only messages are checked
      if (!sid || sid.startsWith('session-') || text.startsWith('/')) {
        SendLog.note(`tmux ${pane}: Enter 후 입력창 비었음 (전송됨)`); Attach.discard(text); return;
      }
      if (await accepted(sid, mark, tmark, 6)) {
        SendLog.note(`tmux ${pane}: CLI 기록에서 받은 것 확인 (전송됨)`); Attach.discard(text); return;
      }
      SendLog.note(`tmux ${pane}: 입력창은 비었지만 CLI가 받지 않음 — 입력창에 되돌림`);
      if (T.onLost) T.onLost(sid);
      return;
    }
    SendLog.note(`tmux ${pane}: Enter 후에도 입력창에 글이 남음 — Enter 다시`);
    await keys(['-t', pane, 'Enter'], L('Enter (다시)'));
  }
  SendLog.note(`tmux ${pane}: Enter를 3번 더 눌러도 입력창에 글이 남음`);
}
/** Empties the CLI's input box (Ctrl+U removes one line of it at a time). Never Esc: that would stop a running turn. */
function clearInput(pane) {
  if (readonlyRefuse('clearInput ' + pane)) return Promise.resolve();
  return enqueue(pane, async () => { for (let i = 0; i < 16; i++) { await keys(['-t', pane, 'C-u'], L('입력창 비우기')); await sleep(40); } });
}
function multilineSettle(t) { return t.includes('\n') ? 150 : 60; }

/** Slash command: clears any half-typed input first. */
function command(cmd, pane) {
  if (readonlyRefuse('command ' + cmd + ' ' + pane)) return Promise.resolve();
  return enqueue(pane, () => commandNow(cmd, pane));
}
async function commandNow(cmd, pane) {
  if (!(await keys(['-t', pane, 'C-u'], L('%@ 명령', cmd)))) return;
  await sleep(40);
  await sendNow(cmd, pane);
}

/** Esc; `settle` (seconds) keeps the pane's queue busy afterwards so a following command waits for it. */
function interrupt(pane, settle = 0) {
  if (readonlyRefuse('interrupt ' + pane)) return Promise.resolve();
  return enqueue(pane, async () => {
    await keys(['-t', pane, 'Escape'], L('중단(Esc)'));
    if (settle > 0) await sleep(settle * 1000);
  });
}

function rename(name, pane) {
  const clean = String(name).split('\n').join(' ').replace(/^[\t\p{Zs}]+|[\t\p{Zs}]+$/gu, '');
  if (!clean) return Promise.resolve();
  return command(`/rename ${clean}`, pane);
}

/** Returns {paneId: tmux session name}. */
async function paneSessions() { return (await paneSessionsChecked()) || {}; }
/** null when tmux timed out / could not be run (a missing server is a normal empty answer). */
async function paneSessionsChecked() {
  const r = await shell.tmux(['list-panes', '-a', '-F', '#{pane_id}\u001f#{session_name}']);
  if (r.code === -1) return null;
  const out = {};
  for (const line of r.out.split('\n')) {
    const f = line.split('\u001f').filter((x) => x.length > 0);
    if (f.length === 2) out[f[0]] = f[1];
  }
  return out;
}

/** Returns {paneId: pid} for every pane in every tmux session. */
async function panes() { return (await panesChecked()) || {}; }
async function panesChecked() {
  const r = await shell.tmux(['list-panes', '-a', '-F', '#{pane_id}\u001f#{pane_pid}']);
  if (r.code === -1) return null;
  const out = {};
  for (const line of r.out.split('\n')) {
    const f = line.split('\u001f').filter((x) => x.length > 0);
    if (f.length === 2 && /^[+-]?\d+$/.test(f[1])) out[f[0]] = parseInt(f[1], 10);
  }
  return out;
}

// ───────────────────────────── TmuxCache ─────────────────────────────
/** Background-collected tmux state. The store's refresh reads these maps; update() (async, never blocks) fills them:
 *  list-panes, plus one capture-pane per wanted pane. All times are epoch ms. */
const C = {
  _panes: {}, _sessions: {}, _busy: {}, _input: {}, _prompt: {},
  _status: {},      // spinner / done line / footer of the last capture
  _overlay: {},     // pane -> CLI screen covering the conversation ("agents" / "resume")
  _typed: {},       // pane -> text sits in the CLI's input box (someone is typing there)
  _modelSentAt: {}, // pane -> when the app sent /model (a "Switch model?" prompt may follow)
  _sentAt: {},
  _wanted: new Set(),
  _extra: new Set(), // panes probed by hand (known only from a session file)
  _startedAt: 0, _at: 0, running: false,
};
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
/** Assigns or (value undefined/null as in Swift's `dict[k] = nil`) removes. */
function put(o, k, v) { if (v === undefined || v === null) delete o[k]; else o[k] = v; }

const cache = {
  get panes() { return Object.assign({}, C._panes); },
  get paneSessions() { return Object.assign({}, C._sessions); },
  /** State the screen shows: 'needsInput' (a prompt waits for the user), 'busy' (a turn runs) or 'idle'; null = never captured. */
  state(pane) {
    if (has(C._overlay, pane)) return null;                  // the screen is not the conversation: the session file decides
    if (!has(C._busy, pane)) return null;
    const b = C._busy[pane];
    return C._input[pane] === true && !b ? 'needsInput' : (b ? 'busy' : 'idle');
  },
  prompt(pane) { return C._prompt[pane] || null; },
  overlay(pane) { return C._overlay[pane] || null; },
  /** Text in the CLI's input box that the board did not just type (someone else uses the same terminal). */
  foreignTyped(pane) {
    if (C._typed[pane] !== true) return false;
    const t = C._sentAt[pane];
    if (t !== undefined && now() - t < 3000) return false;
    return true;
  },
  status(pane) { return C._status[pane] || null; },
  busy(pane) { return has(C._busy, pane) ? C._busy[pane] : null; },
  /** Only these panes (Claude sessions) get a capture-pane; empty = all (first run). */
  setWanted(p) { C._wanted = new Set(p || []); },
  /** Called after the app answered the Switch-model window with Yes by itself (pane). */
  onAutoConfirm: null,
  /** The app just sent /model: a "Switch model?" confirmation in the next 20 s was caused by the user's own choice. */
  expectModelConfirm(pane) { C._modelSentAt[pane] = now(); },
  /** Text was just typed into the pane: it is busy now, whatever an older capture says. */
  markSent(pane, busy) { C._sentAt[pane] = now(); if (busy) C._busy[pane] = true; },
  /** True when the cached busy flag was captured after the last send settled: safe to type slash commands. */
  isSettled(pane) {
    if (!has(C._busy, pane)) return false;                    // never captured: busy is unknown
    if (has(C._overlay, pane)) return false;                  // a CLI list / picker covers the conversation
    const t = C._sentAt[pane];
    if (C._typed[pane] === true && (t === undefined || now() - t >= 3000)) return false;   // someone is typing there
    if (t === undefined) return true;
    return now() - t > 2000 && C._startedAt > t;
  },
  /** One-shot capture of a pane the periodic update never covers; keeps covering it afterwards. */
  async probe(pane) {
    const b = await shell.tmux(['capture-pane', '-p', '-t', pane, '-S', '-4']);
    if (b.code !== 0) return false;
    C._extra.add(pane);
    if (!has(C._busy, pane)) { C._busy[pane] = Screen.busy(b.out); C._input[pane] = Screen.needsInput(b.out); }
    return true;
  },
  /** Collects every wanted pane's state. Resolves false when an update was already running. */
  async update() {
    if (C.running) return false;
    C.running = true;
    try {
      const started = now(); C._startedAt = started;
      const wanted = new Set([...C._wanted, ...C._extra]);
      const wantAll = C._wanted.size === 0;
      const oldPanes = C._panes, oldSessions = C._sessions;
      const p = (await panesChecked()) || oldPanes, s = (await paneSessionsChecked()) || oldSessions;   // a timed-out list keeps the old map
      const b = {}, inp = {}, prm = {}, sts = {}, failed = new Set(), ov = {}, ty = {};
      for (const pane of Object.keys(p)) {
        if (!(wantAll || wanted.has(pane))) continue;
        // with colours (-e): the CLI's suggestion differs from typed text only by being dim; everything else reads plain text
        const raw = await shell.tmux(['capture-pane', '-p', '-e', '-t', pane, '-S', '-4']);
        if (raw.code === -1) { failed.add(pane); continue; }               // timed out: keep what we knew
        const out = Screen.stripANSI(raw.out);
        const stat = Screen.status(out); stat.suggestion = Screen.suggestion(raw.out);
        b[pane] = Screen.busy(out); inp[pane] = Screen.needsInput(out); put(prm, pane, Screen.prompt(out)); sts[pane] = stat;
        put(ov, pane, Screen.overlay(out)); ty[pane] = Screen.typedInput(raw.out);
        // auto-yes ONLY to the exact "Switch model?" window, within 20 s of a /model the app sent itself
        const sent = C._modelSentAt[pane];
        if (sent !== undefined && now() - sent < 20000 && Screen.isSwitchModelPrompt(out)) {
          delete C._modelSentAt[pane];
          if (!readonlyRefuse('autoConfirm ' + pane)) queue(pane, () => keys(['-t', pane, 'Enter'], L('모델 전환 확인(Enter)')));
          if (cache.onAutoConfirm) cache.onAutoConfirm(pane);
        } else if (sent !== undefined && now() - sent >= 20000) delete C._modelSentAt[pane];
      }
      for (const pane of failed) {
        put(b, pane, C._busy[pane]); put(inp, pane, C._input[pane]); put(prm, pane, C._prompt[pane]); put(sts, pane, C._status[pane]);
        put(ov, pane, C._overlay[pane]); put(ty, pane, C._typed[pane]);
      }
      for (const pane of Object.keys(C._sentAt)) {
        const t = C._sentAt[pane];
        if (t > started) put(b, pane, C._busy[pane]);                       // sent during this update: its capture predates the send
        else if (now() - t < 1500) b[pane] = true;                          // claude has not drawn its footer yet
      }
      C._panes = p; C._sessions = s; C._busy = b; C._input = inp; C._prompt = prm; C._status = sts; C._overlay = ov; C._typed = ty; C._at = now();
      return true;
    } finally { C.running = false; }
  },
};

Object.assign(T, {
  SendLog, valid, queue, exec, keys, send, pullQueue, clearInput, command, interrupt, rename,
  paneSessions, paneSessionsChecked, panes, panesChecked,
  // hooks (settable)
  onWarning: null, onDone: null, onLost: null,
  // TmuxCache
  cache,
  cachedPanes: () => cache.panes, cachedPaneSessions: () => cache.paneSessions,
  state: cache.state, prompt: cache.prompt, overlay: cache.overlay, foreignTyped: cache.foreignTyped, status: cache.status,
  busy: cache.busy, setWanted: cache.setWanted, expectModelConfirm: cache.expectModelConfirm, markSent: cache.markSent,
  isSettled: cache.isSettled, probe: cache.probe, update: cache.update,
});
Object.defineProperty(T, 'onAutoConfirm', { enumerable: true, get: () => cache.onAutoConfirm, set: (f) => { cache.onAutoConfirm = f; } });

module.exports = T;
