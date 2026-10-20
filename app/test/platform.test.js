// platform.js (the parts that need no Electron) and clicheck.js. clicheck.check runs `claude --version` (no tokens) under
// AB_READONLY, so the checked version is not written. Run: node test/platform.test.js
const assert = require('assert');
process.env.AB_READONLY = '1';
const platform = require('../main/platform');
const clicheck = require('../main/clicheck');

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('PASS ' + name); } catch (e) { failed += 1; console.log('FAIL ' + name + ': ' + (e.stack || e.message)); }
}
(async () => {
  await test('hostMemory gives positive numbers', () => {
    const m = platform.hostMemory();
    assert.ok(m.availableGB > 0 && m.availableGB < 4096, JSON.stringify(m));
    assert.ok(m.diskFreeGB === null || m.diskFreeGB > 0, JSON.stringify(m));
  });
  await test('clicheck.liveScreens picks idle sessions with a pane and no overlay', () => {
    const store = {
      teams: [{ members: [
        { name: 'a', state: 'idle', overlay: null, tmuxPane: '%1' },
        { name: 'b', state: 'busy', overlay: null, tmuxPane: '%2' },
        { name: 'c', state: 'idle', overlay: 'agents', tmuxPane: '%3' },
      ] }],
      loose: [{ name: 'd', state: 'idle', overlay: null, tmuxPane: null }, { name: 'e', state: 'idle', tmuxPane: '%5' }],
    };
    assert.deepStrictEqual(clicheck.liveScreens(store), [{ name: 'a', pane: '%1' }, { name: 'e', pane: '%5' }]);
    assert.deepStrictEqual(clicheck.liveScreens({ snapshot: () => store }).length, 2);
  });
  await test('clicheck.check returns null or a notice, never throws', async () => {
    const r = await clicheck.check([]);
    assert.ok(r === null || typeof r === 'string');
    console.log('   check →', r);
  });
  await test('clicheck.presentIn: finds texts across 8 MB chunk borders without reading the file whole', async () => {
    const fs = require('fs'), os = require('os'), path = require('path');
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ab-cli-')), 'bin');
    const chunk = 64;   // small chunks: the border cases with a tiny file
    const body = Buffer.alloc(200, 0x20);
    body.write('Set model to', chunk - 5);                 // across the first border
    body.write('popAll', 190);                             // at the very end
    fs.writeFileSync(f, body);
    const found = await clicheck.presentIn(f, ['Set model to', 'popAll', 'Kept model as'], chunk);
    assert.deepStrictEqual([...found].sort(), ['Set model to', 'popAll']);
    assert.strictEqual(await clicheck.presentIn(f + '-missing', ['x']), null);
    fs.rmSync(path.dirname(f), { recursive: true, force: true });
  });
  await test('clicheck.swiftCheckedVersion: a version string or null', async () => {
    const v = await clicheck.swiftCheckedVersion();
    assert.ok(v === null || /^[0-9]/.test(v), String(v));
    console.log('   Swift app checked →', v);
  });
  await test('app.lock: flock shared with the Swift app; a second taker sees the holder; freed when the holder exits', async () => {
    const fs = require('fs'), os = require('os'), path = require('path'), { spawnSync } = require('child_process');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-lock-'));
    const other = (pid) => JSON.parse(spawnSync(process.execPath, ['-e', `console.log(JSON.stringify(require(${JSON.stringify(require.resolve('../main/platform'))}).takeAppLock(${JSON.stringify(home)}, ${pid})))`], { encoding: 'utf8' }).stdout);
    assert.deepStrictEqual(platform.takeAppLock(home, 4242), { ok: true });
    assert.strictEqual(fs.readFileSync(path.join(home, '.agent-boost', 'app.lock'), 'utf8'), '4242');
    assert.deepStrictEqual(other(5151), { ok: false, holder: 4242 });
    platform.releaseAppLock();
    await new Promise((r) => setTimeout(r, 300));
    assert.deepStrictEqual(other(6161), { ok: true });       // that process exited: its lock went with it
    assert.deepStrictEqual(other(7171), { ok: true });
    assert.ok(platform.processStarted(process.pid) <= Date.now());
    fs.rmSync(home, { recursive: true, force: true });
  });
  await test('attach.plistStrings: NSFilenamesPboardType paths with XML entities', () => {
    const attach = require('../main/attach');
    const xml = '<?xml version="1.0"?><plist version="1.0"><array><string>/tmp/b&amp;c.txt</string><string>/tmp/&#xD55C;.png</string></array></plist>';
    assert.deepStrictEqual(attach.plistStrings(xml), ['/tmp/b&c.txt', '/tmp/한.png']);
  });
  console.log(failed === 0 ? 'ALL platform tests PASSED' : `${failed} platform tests FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})();
