// AB_ONLY sandbox guard (main/only.js, shell.tmux, store's ro()): writes to a pane outside the sandbox are refused and
// leave it untouched; the same writes to an `abtest-*` pane go through.
// Two throwaway tmux sessions running `cat` are made with tmux directly (the guard would refuse the second one): the
// sandbox one `abtest-guard-<pid>` and a non-matching one `guardnm-<pid>`. Both are killed at the end. No real session
// is ever a target. Run: node test/only-guard.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

delete process.env.AB_READONLY;
process.env.AB_ONLY = 'abtest';
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'abtest-only-'));
process.env.AB_ONLY_DIR = SANDBOX;
process.env.AB_ONLY_DATA = path.join(SANDBOX, 'data');
process.env.AB_SENDLOG = path.join(SANDBOX, 'send.log');
const shell = require('../main/shell');
const only = require('../main/only');
const tmux = require('../main/tmux');

const OK_S = `abtest-guard-${process.pid}`, BAD_S = `guardnm-${process.pid}`;
const raw = (args) => spawnSync(shell.tmuxPath, ['-u', ...args], { encoding: 'utf8' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`PASS ${name}`); } catch (e) { failed += 1; console.log(`FAIL ${name}: ${e.stack || e.message}`); }
}
const capture = (p) => raw(['capture-pane', '-p', '-t', p, '-S', '-50']).stdout;
const exists = (s) => raw(['has-session', '-t', `=${s}`]).status === 0;
// console.log is watched so a refusal's "[only] refused …" line can be asserted
const logged = [];
const origLog = console.log;
console.log = (...a) => { logged.push(a.join(' ')); if (!String(a[0]).startsWith('[only]')) origLog(...a); };

(async () => {
  for (const s of [OK_S, BAD_S]) assert.strictEqual(raw(['new-session', '-d', '-s', s, '-x', '80', '-y', '20', 'cat']).status, 0);
  const okPane = raw(['list-panes', '-t', `=${OK_S}`, '-F', '#{pane_id}']).stdout.trim();
  const badPane = raw(['list-panes', '-t', `=${BAD_S}`, '-F', '#{pane_id}']).stdout.trim();
  try {
    await test('session of a pane is resolved read-only', async () => {
      assert.strictEqual(only.sessionOf(okPane), OK_S);
      assert.strictEqual(only.sessionOf(badPane), BAD_S);
      assert.strictEqual(only.sessionOf('%9999999'), null);
    });
    await test('send-keys to a non-matching pane is refused and types nothing', async () => {
      const r = shell.tmuxSync(['send-keys', '-t', badPane, '-l', 'GUARDBAD']);
      assert.strictEqual(r.code, 1);
      assert.ok(logged.some((l) => l.startsWith('[only] refused tmux send-keys')));
      const r2 = await shell.tmux(['send-keys', '-t', badPane, 'Enter']);
      assert.strictEqual(r2.code, 1);
      await sleep(200);
      assert.ok(!capture(badPane).includes('GUARDBAD'));
    });
    await test('send-keys to an abtest pane goes through', async () => {
      const r = await shell.tmux(['send-keys', '-t', okPane, '-l', 'GUARDOK']);
      assert.strictEqual(r.code, 0, r.err);
      await sleep(200);
      assert.ok(capture(okPane).includes('GUARDOK'));
    });
    await test('TmuxControl.keys / interrupt: refused outside, allowed inside', async () => {
      assert.strictEqual(await tmux.keys(['-t', badPane, '-l', 'KEYSBAD']), false);
      assert.strictEqual(await tmux.keys(['-t', okPane, '-l', 'KEYSOK']), true);
      await tmux.interrupt(badPane);
      await sleep(200);
      assert.ok(!capture(badPane).includes('KEYSBAD'));
      assert.ok(capture(okPane).includes('KEYSOK'));
    });
    await test('a fake pane id is refused', async () => {
      assert.strictEqual(shell.tmuxSync(['send-keys', '-t', '%9999999', 'Enter']).code, 1);
    });
    await test('kill / rename / resize / set-option of a non-matching session are refused', async () => {
      for (const args of [['kill-session', '-t', BAD_S], ['kill-pane', '-t', badPane], ['rename-session', '-t', BAD_S, 'x'],
        ['resize-window', '-t', badPane, '-x', '50', '-y', '10'], ['set-option', '-w', '-t', BAD_S, 'remain-on-exit', 'on']]) {
        assert.strictEqual(shell.tmuxSync(args).code, 1, args.join(' '));
      }
      assert.ok(exists(BAD_S));
    });
    await test('a chain with one non-matching target is refused as a whole', async () => {
      const r = shell.tmuxSync(['send-keys', '-t', okPane, '-l', 'CHAIN', ';', 'send-keys', '-t', badPane, '-l', 'CHAIN']);
      assert.strictEqual(r.code, 1);
      await sleep(200);
      assert.ok(!capture(okPane).includes('CHAIN') && !capture(badPane).includes('CHAIN'));
    });
    await test('server-wide writes and kill-server are refused; reads are allowed', async () => {
      assert.strictEqual(shell.tmuxSync(['set-environment', '-g', 'ABTEST_GUARD', '1']).code, 1);
      assert.strictEqual(shell.tmuxSync(['kill-server']).code, 1);
      assert.strictEqual(shell.tmuxSync(['list-sessions']).code, 0);
      assert.strictEqual(shell.tmuxSync(['capture-pane', '-p', '-t', badPane]).code, 0);
    });
    await test('new-session only with a sandbox name', async () => {
      const bad = `nottest-${process.pid}`, good = `abtest-guard2-${process.pid}`;
      assert.strictEqual(shell.tmuxSync(['new-session', '-d', '-s', bad, 'cat']).code, 1);
      assert.ok(!exists(bad));
      assert.strictEqual(shell.tmuxSync(['new-session', '-d', '-s', good, 'cat']).code, 0);
      assert.ok(exists(good));
      assert.strictEqual(shell.tmuxSync(['kill-session', '-t', good]).code, 0);
      assert.ok(!exists(good));
    });
    await test('only.allows: name prefix, sandbox cwd, sandbox pane', async () => {
      assert.ok(only.allows({ name: 'abtest-x' }));
      assert.ok(only.allows({ name: 'Paper Editor', cwd: path.join(SANDBOX, 'sub') }));
      assert.ok(only.allows({ name: 'Paper Editor', tmuxPane: okPane }));
      assert.ok(!only.allows({ name: 'Paper Editor', cwd: os.homedir() }));
      assert.ok(!only.allows({ name: 'Paper Editor', tmuxPane: badPane }));
      assert.ok(!only.allows({ name: 'Paper Editor', cwd: SANDBOX + '-other' }));
      assert.ok(!only.allows([{ name: 'abtest-a' }, { name: 'other' }]));
      assert.ok(!only.allows([]));
      assert.ok(!only.allows(null));
    });
    await test('store: start-up routines and actions without a sandbox target are refused', async () => {
      const store = require('../main/store');
      logged.length = 0;
      assert.strictEqual(await store.createSession('notsandbox', os.homedir(), 'claude-haiku-4-5', 'low', [], '', false), null);
      assert.ok(logged.some((l) => l.startsWith('[only] refused launchInTmux notsandbox')), logged.join('\n'));
      assert.strictEqual(await store.newTerminal(os.homedir()), null);
      assert.ok(logged.some((l) => l.startsWith('[only] refused newTerminal')));
      await store.resumeSavedSessions();
      assert.ok(logged.some((l) => l.startsWith('[only] refused resumeSavedSessions')));
      await store.pruneEmptyTeams(true);
      assert.ok(logged.some((l) => l.startsWith('[only] refused pruneEmptyTeams')));
      assert.deepStrictEqual(await store.shutdownAll(), []);
      assert.ok(logged.some((l) => l.startsWith('[only] refused shutdownAll')));
    });
  } finally {
    for (const s of [OK_S, BAD_S]) raw(['kill-session', '-t', `=${s}`]);
    fs.rmSync(SANDBOX, { recursive: true, force: true });
  }
  console.log = origLog;
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
  process.exit(failed ? 1 : 0);
})();
