// shell.js + tmux.js against a throwaway tmux session `abtest-tmux-<pid>` running `cat` (never a real session; it is
// killed at the end). SendLog goes to a temp file (AB_SENDLOG). Run: node test/tmux.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

delete process.env.AB_READONLY;
const logFile = path.join(os.tmpdir(), `abtest-sendlog-${process.pid}.log`);
process.env.AB_SENDLOG = logFile;
const shell = require('../main/shell');
const tmux = require('../main/tmux');

const SESSION = `abtest-tmux-${process.pid}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
async function test(name, fn) {
  const t0 = Date.now();
  try { await fn(); console.log(`PASS ${name} (${Date.now() - t0} ms)`); } catch (e) { failed += 1; console.log(`FAIL ${name}: ${e.stack || e.message}`); }
}
async function capture(pane) { return (await shell.tmux(['capture-pane', '-p', '-t', pane, '-S', '-50'])).out; }
/** A pane of our own session running `cmd`; returns its pane id. */
async function newPane(cmd, name) {
  const r = await shell.tmux(['new-window', '-d', '-t', `=${SESSION}:`, '-n', name, '-P', '-F', '#{pane_id}', cmd]);
  assert.strictEqual(r.code, 0, r.err);
  return r.out.trim();
}

(async () => {
  await test('shell.run: output, exit code, cwd', async () => {
    const r = await shell.run(['/bin/sh', '-c', 'pwd; echo err >&2; exit 3'], { cwd: os.tmpdir() });
    assert.strictEqual(r.code, 3);
    assert.strictEqual(fs.realpathSync(r.out.trim()), fs.realpathSync(os.tmpdir()));
    assert.strictEqual(r.err.trim(), 'err');
  });
  await test('shell.run: timeout reports -1 "timeout"', async () => {
    const t0 = Date.now();
    const r = await shell.run(['/bin/sleep', '5'], { timeout: 0.4 });
    assert.deepStrictEqual([r.code, r.out, r.err], [-1, '', 'timeout']);
    assert.ok(Date.now() - t0 < 2000);
  });
  await test('shell.run: missing program', async () => {
    const r = await shell.run(['/nonexistent/prog']);
    assert.strictEqual(r.code, -1);
  });
  await test('shell.runSync + PATH has tmux dir', async () => {
    const r = shell.runSync(['/bin/sh', '-c', 'printf %s "$PATH"; exit 2']);
    assert.strictEqual(r.code, 2);
    assert.ok(r.out.split(':').includes(path.dirname(shell.tmuxPath)), r.out);
  });
  await test('AB_READONLY refuses tmux commands that change something', async () => {
    process.env.AB_READONLY = '1';
    try {
      const r = await shell.tmux(['kill-session', '-t', '=nonexistent-abtest']);
      assert.strictEqual(r.err, 'readonly');
      const l = await shell.tmux(['list-sessions', '-F', '#{session_name}']);
      assert.notStrictEqual(l.err, 'readonly');
      assert.strictEqual(await tmux.keys(['-t', '%0', 'Enter']), false);
    } finally { delete process.env.AB_READONLY; }
  });

  const mk = await shell.tmux(['new-session', '-d', '-s', SESSION, '-x', '100', '-y', '30', '-P', '-F', '#{pane_id}', 'cat']);
  if (mk.code !== 0) { console.log('cannot create test session: ' + mk.err); process.exit(1); }
  const pane = mk.out.trim();
  const warnings = [], done = [], lost = [];
  tmux.onWarning = (w) => warnings.push(w);
  tmux.onDone = (sid) => done.push(sid);
  tmux.onLost = (sid) => lost.push(sid);
  try {
    await test('panes / paneSessions list our pane', async () => {
      const p = await tmux.panes(), s = await tmux.paneSessions();
      assert.ok(Number.isInteger(p[pane]) && p[pane] > 0, JSON.stringify(p[pane]));
      assert.strictEqual(s[pane], SESSION);
    });
    await test('valid() pane ids', async () => {
      assert.deepStrictEqual(['%1', '%123', '%', '1', '%1a', '%-1', ''].map(tmux.valid), [true, true, false, false, false, false, false]);
    });
    await test('send: one line reaches cat; onDone fires', async () => {
      await tmux.send('hello abtest', pane, '');
      await sleep(100);
      const c = await capture(pane);
      assert.ok((c.match(/hello abtest/g) || []).length >= 2, c);   // tty echo + cat's copy
      assert.deepStrictEqual(done, ['']);
    });
    await test('send: multi-line text is pasted with LF kept (paste-buffer -p -r)', async () => {
      await tmux.send('first line\nsecond line', pane, '');
      await sleep(100);
      // the tty echoes the paste and cat copies each line; both lines arrive as separate lines (LF kept, no early Enter)
      const c = await capture(pane);
      assert.ok((c.match(/first line/g) || []).length >= 2 && (c.match(/second line/g) || []).length >= 2, c);
      assert.deepStrictEqual(warnings, []);
      assert.strictEqual((await shell.tmux(['show-buffer', '-b', 'ab-' + pane.slice(1)])).code === 0, false, 'buffer deleted (-d)');
    });
    await test('send: a message the CLI never took calls onLost(sid)', async () => {
      await tmux.send('no cli here', pane, 'abtest-nonexistent-sid');
      assert.deepStrictEqual(lost, ['abtest-nonexistent-sid']);
      await tmux.SendLog.flush();
      assert.ok(fs.readFileSync(logFile, 'utf8').includes('입력창은 비었지만 CLI가 받지 않음'));
    });
    await test('send: invalid pane id is refused and logged', async () => {
      const n = done.length;
      await tmux.send('x', '%abc', '');
      assert.strictEqual(done.length, n);
      await tmux.SendLog.flush();
      assert.ok(fs.readFileSync(logFile, 'utf8').includes('tmux %abc: 잘못된 pane id'));
    });
    await test('keys: refused send-keys returns false and warns', async () => {
      const n = warnings.length;
      assert.strictEqual(await tmux.keys(['-t', '%999999', 'Enter'], 'X'), false);
      assert.strictEqual(warnings.length, n + 1);
      assert.ok(warnings[n].includes('X'), warnings[n]);
    });
    await test('send: text left in an input box gets Enter again, then gives up', async () => {
      // a fake CLI box with typed text that never empties
      const box = await newPane(`printf '%s\\n' 'conversation' '────────────────' '❯ still typed' '────────────────' '  ? for shortcuts'; exec cat >/dev/null`, 'box');
      await sleep(300);
      await tmux.send('/help', box, '');
      await tmux.SendLog.flush();
      const log = fs.readFileSync(logFile, 'utf8');
      assert.ok(log.includes(`tmux ${box}: Enter 후에도 입력창에 글이 남음 — Enter 다시`), log.slice(-600));
      assert.ok(log.includes(`tmux ${box}: Enter를 3번 더 눌러도 입력창에 글이 남음`));
    });
    await test('queue: work for one key runs in order, exec returns the result', async () => {
      const seen = [];
      tmux.queue('abtest-q', async () => { await sleep(60); seen.push(1); });
      tmux.queue('abtest-q', () => { seen.push(2); });
      const r = await tmux.exec('abtest-q', ['display-message', '-p', '-t', pane, '#{session_name}']);
      assert.deepStrictEqual(seen, [1, 2]);
      assert.strictEqual(r.out.trim(), SESSION);
    });
    await test('command / clearInput / interrupt / rename go through the queue', async () => {
      await tmux.clearInput(pane);
      await tmux.interrupt(pane, 0.05);
      await tmux.rename('  my\nname ', pane);
      await sleep(100);
      const c = await capture(pane);
      assert.ok(c.includes('/rename my name'), c);
    });
    await test('pullQueue without a transcript resolves false', async () => {
      let cb = null;
      const ok = await tmux.pullQueue(pane, 'abtest-nonexistent-sid', (v) => { cb = v; });
      await sleep(10);
      assert.strictEqual(ok, false); assert.strictEqual(cb, false);
    });
    await test('cache: update / state / markSent / isSettled / probe', async () => {
      tmux.setWanted([pane]);
      assert.strictEqual(await tmux.update(), true);
      assert.strictEqual(tmux.state(pane), 'idle');
      assert.strictEqual(tmux.busy(pane), false);
      assert.strictEqual(tmux.cachedPaneSessions()[pane], SESSION);
      assert.strictEqual(tmux.isSettled(pane), true);
      tmux.markSent(pane, true);
      assert.strictEqual(tmux.state(pane), 'busy');
      assert.strictEqual(tmux.isSettled(pane), false);
      await tmux.update();
      assert.strictEqual(tmux.busy(pane), true, 'a capture right after a send keeps busy (1.5 s)');
      assert.strictEqual(tmux.foreignTyped(pane), false);
      assert.strictEqual(await tmux.probe('%999999'), false);
      // two updates at once: the second one returns false
      const [a, b] = await Promise.all([tmux.update(), tmux.update()]);
      assert.deepStrictEqual([a, b], [true, false]);
      tmux.setWanted([]);
    });
  } finally {
    await shell.tmux(['kill-session', '-t', `=${SESSION}`]);
    fs.rmSync(logFile, { force: true });
  }
  const left = (await shell.tmux(['list-sessions', '-F', '#{session_name}'])).out.split('\n').filter((s) => s === SESSION);
  if (left.length) { failed += 1; console.log('FAIL test session still exists'); }
  console.log(failed === 0 ? 'ALL tmux tests PASSED' : `${failed} tmux tests FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})();
