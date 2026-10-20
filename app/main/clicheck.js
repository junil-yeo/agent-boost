// Port of CLICheck.swift.
//
// The app reads the Claude Code CLI's screen and records, so a CLI update can quietly break sending, status or the
// queue. When the installed CLI version changes, this checks once (no tokens, nothing typed into any session):
//  1. the screen texts the app looks for are still in the new CLI program (compared with the previous version's);
//  2. on every idle session the app can still find the input box.
// A problem shows as a notice; a clean result is only logged.
// The last checked version is kept in ~/.agent-boost/linux-settings.json ("cli.checkedVersion"). On macOS the Swift app's
// UserDefaults value is taken over once when none is saved here.
const fs = require('fs');
const path = require('path');
const shell = require('./shell');
const screen = require('./screen');
const l10n = require('./l10n');
const { L } = l10n;

/** Texts the screen readers depend on (screen.js, tmux.js, the queue reader). All present in 2.1.304. */
const markers = [
  'esc to interrupt', 'esc to cancel', 'Esc to cancel', 'accept edits', 'auto mode', 'bypass permissions', 'plan mode',
  'Kept model as', 'Set model to', 'Set effort level to', 'Do you want to proceed?', 'Press up to edit queued messages',
  'queue-operation', 'popAll', 'Resume session', 'isPasting', 'for shortcuts', 'Disconnect this session',
  'Choose the text style', "Let's get started", 'Paste code here if prompted', 'Pasted text #', '[Image #',
];
const key = 'cli.checkedVersion';
const versions = path.join(shell.home, '.local', 'share', 'claude', 'versions');   // where the installer keeps earlier versions

let timers = [];
/** At launch (after 20 s) and every 30 minutes (the CLI updates itself while sessions run). The notice goes through
 *  store.setNotice. */
function start(store) {
  const tick = async () => {
    try {
      const msg = await check(liveScreens(store));
      if (msg && store && typeof store.setNotice === 'function') store.setNotice(msg);
    } catch (e) { console.error('[clicheck]', e); }
  };
  stop();
  timers.push(setTimeout(tick, 20 * 1000));
  timers.push(setInterval(tick, 1800 * 1000));
}
function stop() { for (const t of timers) { clearTimeout(t); clearInterval(t); } timers = []; }

/** The store's teams / loose agents: its own fields, or its snapshot. */
function agentsOf(store) {
  if (!store) return [];
  let st = store;
  if (!Array.isArray(store.teams) && typeof store.snapshot === 'function') st = store.snapshot();
  else if (!Array.isArray(store.teams) && typeof store.getState === 'function') st = store.getState();
  const teams = (st && st.teams) || [], loose = (st && st.loose) || [];
  return teams.flatMap((t) => t.members || []).concat(loose);
}
/** Screens of idle sessions (their input box must be found), captured later. */
function liveScreens(store) {
  return agentsOf(store).filter((a) => a.state === 'idle' && a.overlay == null && a.tmuxPane).map((a) => ({ name: a.name, pane: a.tmuxPane }));
}

function realpath(p) { try { return fs.realpathSync(p); } catch { return p; } }

/** Which of the texts occur in the file, or null when it cannot be read. Swift memory-maps the program (paged on
 *  demand); the CLI binary is 100+ MB, so here it is read in 8 MB chunks (each overlapping the previous one by the
 *  longest text, so a text across a chunk border is still found) and the main process yields between chunks. */
async function presentIn(file, texts, chunk = 8 * 1024 * 1024) {
  const needles = texts.map((t) => Buffer.from(t, 'utf8'));
  const overlap = Math.max(0, ...needles.map((n) => n.length)) - 1;
  const found = new Set();
  let fh;
  try { fh = await fs.promises.open(file, 'r'); } catch { return null; }
  try {
    const buf = Buffer.alloc(chunk + overlap);
    let carry = 0, pos = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, carry, chunk, pos);
      if (bytesRead === 0) break;
      pos += bytesRead;
      const view = buf.subarray(0, carry + bytesRead);
      needles.forEach((n, i) => { if (!found.has(texts[i]) && view.indexOf(n) >= 0) found.add(texts[i]); });
      if (found.size === texts.length) break;
      carry = Math.min(overlap, view.length);
      view.copy(buf, 0, view.length - carry);
      await new Promise((r) => setImmediate(r));   // let IPC and state pushes through between chunks
    }
  } catch { return null; } finally { await fh.close().catch(() => { }); }
  return found;
}

/** macOS: the version the Swift app last checked (UserDefaults "cli.checkedVersion"), read once when this app has none
 *  saved yet, so a CLI update that happened since the Swift app's last check is still reported. */
function swiftCheckedVersion() {
  if (process.platform !== 'darwin') return Promise.resolve(null);
  return new Promise((resolve) => {
    require('child_process').execFile('/usr/bin/defaults', ['read', 'local.junil.agentboost', key], { encoding: 'utf8', timeout: 2000 },
      (e, out) => { const v = e ? '' : String(out).trim(); resolve(/^[0-9]/.test(v) ? v : null); });
  });
}

/** null when nothing changed or all is well; otherwise the warning to show. */
async function check(live) {
  // the CLI's own answer ("2.1.304 (Claude Code)")
  const v = await shell.run([shell.claude, '--version'], { timeout: 10 });
  if (v.code !== 0) return null;
  const nowV = v.out.trim().split(' ').filter(Boolean)[0];
  if (!nowV || !/^[0-9]/.test(nowV)) return null;
  const settings = l10n.readSettings();
  const before = settings[key] || await swiftCheckedVersion();
  if (before === nowV) return null;
  const bin = realpath(shell.claude);                     // the program the texts are looked up in
  const fresh = await presentIn(bin, markers);
  if (!fresh) return null;
  // the previous version's program, when the installer kept it: a text missing from both was never a CLI text
  const old = before ? await presentIn(path.join(versions, before), markers) : null;
  const gone = markers.filter((m) => !fresh.has(m) && (old ? old.has(m) : true));
  const noBox = [];
  for (const s of live || []) {
    const raw = (await shell.tmux(['capture-pane', '-p', '-e', '-t', s.pane])).out;
    if (raw !== '' && !screen.hasInputBox(raw)) noBox.push(s.name);
  }
  if (process.env.AB_READONLY) console.log(`[readonly] clicheck: remember CLI version ${nowV}`);
  else { const s2 = l10n.readSettings(); s2[key] = nowV; l10n.writeSettings(s2); }
  const from = before ? `${before} → ` : '';
  require('./tmux').SendLog.note(`CLI 점검 ${from}${nowV}: 사라진 문구 ${gone.length}개 [${gone.join(', ')}], 입력창 못 찾음 [${noBox.join(', ')}]`);
  if (!(before && (gone.length > 0 || noBox.length > 0))) return null;   // first run: just remember the version
  const parts = [];
  if (gone.length > 0) parts.push(L('앱이 읽는 CLI 화면 문구 %@개가 사라졌습니다 (%@)', String(gone.length), gone.slice(0, 4).join(', ') + (gone.length > 4 ? ' …' : '')));
  if (noBox.length > 0) parts.push(L('입력창을 찾지 못한 세션: %@', noBox.join(', ')));
  return L('Claude Code CLI가 %@%@로 업데이트됐습니다. %@. 전송·상태 표시·대기열이 틀어질 수 있으니 App Developer 세션에 알려 주세요.', from, nowV, parts.join('. '));
}

module.exports = { markers, start, stop, check, liveScreens, presentIn, swiftCheckedVersion };
