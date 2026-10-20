// In-process teammates of an agent team (Claude Code 2.1.304, teammateMode "in-process" — the CLI's default outside
// tmux). Verified on a sandbox lead:
//
//  - ~/.claude/teams/<team>/config.json lists them with backendType "in-process" and tmuxPaneId "in-process" (the
//    lead: tmuxPaneId "leader"); no pid, no pane, no session id. They run inside the lead's process.
//  - Their conversation is in the LEAD's folder: <proj>/<leadSid>/subagents/agent-a<name>-<hash>.jsonl with a meta
//    {"taskKind":"in_process_teammate","teamName":…,"name":…,"model":…,"description":…}.
//  - The lead's footer lists them under its status line (Screen.teammateList): "⏺ main" / "◯ helper  says ok  idle";
//    ↓ enters the list, ↑/↓ move, Enter shows that teammate's conversation in the lead's pane, and what is typed then
//    goes to the teammate. The CLI hides the list ~30 s after every teammate went idle; ↓ then does nothing, so a
//    message can only be typed while the list is drawn.
//
// send() drives exactly those keys, re-reading the screen after every key, and always brings the pane back to the
// lead's own conversation ("main") afterwards. It never types a character unless the screen shows the teammate's
// conversation with the input box focused.
const fs = require('fs');
const path = require('path');
const Sub = require('./subagents');
const Screen = require('./screen');
const shell = require('./shell');
const { L } = require('./l10n');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

/** A config.json member that runs inside its lead's process. */
function isInProcessMember(m) {
  return !!m && typeof m === 'object' && (m.backendType === 'in-process' || m.tmuxPaneId === 'in-process') && m.tmuxPaneId !== 'leader';
}

/** The teammate's transcript in the lead's subagents folder, matched by meta teamName + name (newest when the same
 *  name was re-created). `leadTranscript`: the lead's <sid>.jsonl. Returns {path, meta, mtimeMs} or null. */
function teammateFile(leadTranscript, teamName, name) {
  if (!leadTranscript) return null;
  let best = null;
  for (const x of Sub.scanDir(Sub.dirOf(leadTranscript))) {
    const m = x.meta || {};
    if (!Sub.isTeammate(m) || m.teamName !== teamName || m.name !== name) continue;
    if (!best || x.mtimeMs > best.mtimeMs) best = { path: x.file, meta: m, mtimeMs: x.mtimeMs };
  }
  return best;
}

/** Busy / idle of a live in-process teammate: the lead footer's word when the list shows it, else the transcript (written
 *  in the last 15 s = busy). */
function stateOf(row, file, t = now()) {
  if (row && row.state) return row.state;
  if (file && t - file.mtimeMs < 15000) return 'busy';
  return 'idle';
}

// ── typing into a teammate through the lead's pane ─────────────────────────────────────────────────────────────────
async function capture(pane) {
  const r = await shell.tmux(['capture-pane', '-p', '-e', '-t', pane]);
  if (r.code !== 0) return null;
  return { raw: r.out, list: Screen.teammateList(Screen.stripANSI(r.out)) };
}
/** Presses `key` and waits (≤ 1.5 s) until the list changes as `want(list)` says. Returns the new capture or null. */
async function press(T, pane, key, want, what) {
  if (!(await T.keys(['-t', pane, key], what))) return null;
  const end = now() + 1500;
  let c = null;
  do {
    await sleep(120);
    c = await capture(pane);
    if (c && want(c.list)) return c;
  } while (now() < end);
  return null;
}
/** Moves the list cursor to row `name` and presses Enter so the pane shows that conversation (`enter` false: only the
 *  cursor, list mode on). Leaves list mode on (the CLI keeps it after Enter). Returns the capture showing it, or null. */
async function viewRow(T, pane, name, log, enter = true) {
  let c = await capture(pane);
  for (let step = 0; step < 24 && c && c.list; step++) {
    const f = c.list;
    const k = f.rows.findIndex((r) => r.name === name);
    if (k < 0) { log(`팀원 목록에 '${name}' 없음`); return null; }
    if (enter && f.viewing === name && (!f.listMode || f.cursor === k)) return c;
    if (!enter && f.listMode && f.cursor === k) return c;
    if (!f.listMode) {
      if (!f.manage) { log('팀원 목록에 들어갈 수 없음 (↓ to manage 없음)'); return null; }
      c = await press(T, pane, 'Down', (x) => !!x && x.listMode, L('팀원 목록 열기(↓)'));
      continue;
    }
    if (f.cursor < 0) { log('목록 커서를 찾지 못함'); return null; }
    if (f.cursor < k) c = await press(T, pane, 'Down', (x) => !!x && x.cursor === f.cursor + 1, L('팀원 선택(↓)'));
    else if (f.cursor > k) c = await press(T, pane, 'Up', (x) => !!x && x.cursor === f.cursor - 1, L('팀원 선택(↑)'));
    else if (enter) c = await press(T, pane, 'Enter', (x) => !!x && x.viewing === name, L('팀원 화면 보기(Enter)'));
    else return c;
  }
  return null;
}
/** Back to the lead's own conversation with the list left (the state the store's normal sends expect). */
async function backToMain(T, pane, log) {
  let c = await capture(pane);
  if (!c || !c.list) return !!c;                                   // no list drawn: nothing was switched
  if (c.list.viewing !== 'main') {
    c = await viewRow(T, pane, 'main', log);
    if (!c) { log('팀장 화면(main)으로 돌아가지 못함'); return false; }
  }
  // leave list mode: ↑ on the first row (only while the list has the keys — otherwise ↑ would recall prompt history)
  for (let i = 0; i < 6 && c && c.list && c.list.listMode; i++) {
    const cur = c.list.cursor;
    c = await press(T, pane, 'Up', (x) => !x || !x.listMode || x.cursor === cur - 1, L('팀원 목록 닫기(↑)'));
  }
  return !!c && (!c.list || (!c.list.listMode && c.list.viewing === 'main'));
}

/** Did the teammate get it? Its transcript gains a user record (or a queued one while it works) within `seconds`. */
async function acceptedBy(file, offset, text, seconds) {
  const head = [...String(text)].slice(0, 30).join('');
  const end = now() + seconds * 1000;
  do {
    let added = '';
    try {
      const fh = await fs.promises.open(file, 'r');
      try {
        const size = (await fh.stat()).size;
        if (size > offset) { const b = Buffer.alloc(size - offset); await fh.read(b, 0, b.length, offset); added = b.toString('utf8'); }
      } finally { await fh.close(); }
    } catch { }
    if (added.includes('"operation":"enqueue"')) return true;
    if (added.includes('"type":"user"') && (added.includes('"origin":{"kind":"human"}') || added.includes(JSON.stringify(head).slice(1, -1)))) return true;
    await sleep(250);
  } while (now() < end);
  return false;
}

/** Types `text` to teammate `name` through the lead's pane. Runs in the lead pane's serial queue (after any message
 *  already being typed there). Resolves {ok, typed, why}: typed = the text went into the box (a failure after that
 *  means the teammate did not record it). `file`: the teammate's transcript (acceptance check). */
function send(leadPane, name, text, file) {
  const T = require('./tmux');
  const log = (s) => T.SendLog.note(`tmux ${leadPane}: 팀원 '${name}' — ${s}`);
  if (!T.valid(leadPane)) return Promise.resolve({ ok: false, typed: false, why: 'pane' });
  return T.queue(leadPane, async () => {
    let typed = false;
    try {
      log('입력 시작 ' + T.SendLog.head(text));
      const c0 = await capture(leadPane);
      if (!c0 || !c0.list || !c0.list.rows.some((r) => r.name === name)) { log('팀장 화면에 팀원 목록이 없음 — 보내지 않음'); return { ok: false, typed, why: 'hidden' }; }
      if (Screen.typedInput(c0.raw)) { log('팀장 입력창에 글이 있음 — 보내지 않음'); return { ok: false, typed, why: 'typed' }; }
      const c = await viewRow(T, leadPane, name, log);
      if (!c) return { ok: false, typed, why: 'select' };
      // the box must be the teammate's ("Message @name…" placeholder or its border label) and empty
      const plain = Screen.stripANSI(c.raw);
      if (!(plain.includes(`@${name}`))) { log('팀원 입력창을 확인하지 못함'); return { ok: false, typed, why: 'select' }; }
      if (Screen.typedInput(c.raw)) { log('팀원 입력창에 글이 있음 — 보내지 않음'); return { ok: false, typed, why: 'typed' }; }
      // focus: "x to stop" under the status line means the list still takes letters (an "x" would stop the teammate)
      if (/Enter to view|x to stop/.test(plain.split('\n').slice(-12).join('\n'))) { log('목록이 키를 받는 상태 — 보내지 않음'); return { ok: false, typed, why: 'focus' }; }
      let off = 0;
      try { off = file ? (await fs.promises.stat(file)).size : 0; } catch { }
      typed = true;
      await T.sendNow(text, leadPane, '');
      const ok = file ? await acceptedBy(file, off, text, 6) : true;
      log(ok ? '팀원 기록에서 받은 것 확인 (전송됨)' : '팀원 기록에 나타나지 않음');
      return { ok, typed, why: ok ? null : 'lost' };
    } catch (e) {
      log('오류 ' + (e && e.message));
      return { ok: false, typed, why: 'error' };
    } finally {
      if (!(await backToMain(T, leadPane, log))) log('⚠ 팀장 화면 복귀 실패');
    }
  });
}

/** Stops teammate `name` the CLI's documented way: select it in the lead's agent panel and press x (verified: the CLI
 *  removes it from the team config). The cursor must sit on that row with "x to stop" on the status line before the
 *  key goes. Resolves {ok, why}. */
function stop(leadPane, name) {
  const T = require('./tmux');
  const log = (s) => T.SendLog.note(`tmux ${leadPane}: 팀원 '${name}' 종료 — ${s}`);
  if (!T.valid(leadPane)) return Promise.resolve({ ok: false, why: 'pane' });
  return T.queue(leadPane, async () => {
    try {
      const c0 = await capture(leadPane);
      if (!c0 || !c0.list || !c0.list.rows.some((r) => r.name === name)) { log('팀장 화면에 팀원 목록이 없음'); return { ok: false, why: 'hidden' }; }
      if (Screen.typedInput(c0.raw)) { log('팀장 입력창에 글이 있음'); return { ok: false, why: 'typed' }; }
      const c = await viewRow(T, leadPane, name, log, false);
      if (!c) return { ok: false, why: 'select' };
      const tail = Screen.stripANSI(c.raw).split('\n').slice(-12).join('\n');
      if (!tail.includes('x to stop') || c.list.rows[c.list.cursor].name !== name) { log('x to stop 이 보이지 않음 — 누르지 않음'); return { ok: false, why: 'select' }; }
      const after = await press(T, leadPane, 'x', (x) => !x || !x.rows.some((r) => r.name === name), L('팀원 종료(x)'));
      log(after !== null ? '목록에서 사라짐 (종료됨)' : '목록에 남아 있음');
      return { ok: after !== null, why: after !== null ? null : 'still' };
    } catch (e) { log('오류 ' + (e && e.message)); return { ok: false, why: 'error' }; }
    finally { if (!(await backToMain(T, leadPane, log))) log('⚠ 팀장 화면 복귀 실패'); }
  });
}

module.exports = { isInProcessMember, teammateFile, stateOf, send, stop, _viewRow: viewRow, _backToMain: backToMain };
