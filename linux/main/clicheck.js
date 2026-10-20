// Port of CLICheck.swift.
//
// The app reads the Claude Code CLI's screen and records, so a CLI update can quietly break sending, status or the
// queue. When the installed CLI version changes, this checks once (no tokens, nothing typed into any session):
//  1. the screen texts the app looks for are still in the new CLI program (compared with the previous version's);
//  2. on every idle session the app can still find the input box.
// A problem shows as a notice; a clean result is only logged.
// The last checked version is kept in ~/.agent-boost/linux-settings.json ("cli.checkedVersion"; macOS: UserDefaults).
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
async function readMaybe(p) { try { return await fs.promises.readFile(p); } catch { return null; } }

/** null when nothing changed or all is well; otherwise the warning to show. */
async function check(live) {
  // the CLI's own answer ("2.1.304 (Claude Code)")
  const v = await shell.run([shell.claude, '--version'], { timeout: 10 });
  if (v.code !== 0) return null;
  const nowV = v.out.trim().split(' ').filter(Boolean)[0];
  if (!nowV || !/^[0-9]/.test(nowV)) return null;
  const settings = l10n.readSettings();
  const before = settings[key] || null;
  if (before === nowV) return null;
  const bin = realpath(shell.claude);                     // the program the texts are looked up in
  const fresh = await readMaybe(bin);
  if (!fresh) return null;
  // the previous version's program, when the installer kept it: a text missing from both was never a CLI text
  const old = before ? await readMaybe(path.join(versions, before)) : null;
  const gone = markers.filter((m) => {
    const d = Buffer.from(m, 'utf8');
    return fresh.indexOf(d) < 0 && (old ? old.indexOf(d) >= 0 : true);
  });
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

module.exports = { markers, start, stop, check, liveScreens };
