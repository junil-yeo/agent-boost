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
  console.log(failed === 0 ? 'ALL platform tests PASSED' : `${failed} platform tests FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})();
