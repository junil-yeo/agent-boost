// store prefs ('ui.cliSuggest', 'new.bypass', 'ui.showNotices'): persisted in ~/.agent-boost/linux-settings.json and
// loaded at start-up, so a restart keeps the user's choice before the window says anything. Runs the store in child
// processes with HOME set to a temp folder (nothing of the real home is touched; the store is only required, never
// started). Run: node test/store-prefs.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let failed = 0;
const test = async (name, f) => { try { await f(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e.stack || e).toString().split('\n').slice(0, 4).join('\n     ')); } };
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-prefs-'));
const storePath = require.resolve('../main/store');
/** Runs js in a fresh node with the store loaded as `st`; returns what it printed (JSON). */
function inStore(js, env = {}) {
  const r = spawnSync(process.execPath, ['-e', `const st = require(${JSON.stringify(storePath)}); ${js}`],
    { encoding: 'utf8', env: Object.assign({}, process.env, { HOME: home, AB_READONLY: '' }, env), timeout: 30000 });
  if (r.status !== 0) throw new Error(r.stderr || 'exit ' + r.status);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

(async () => {
  await test('defaults are on when nothing is saved (or the Swift app has the default)', () => {
    const p = inStore('console.log(JSON.stringify(st.getPref()))');
    assert.deepStrictEqual(Object.keys(p).sort(), ['new.bypass', 'ui.cliSuggest', 'ui.showNotices']);
    assert.ok(Object.values(p).every((v) => typeof v === 'boolean'));
  });
  await test('setPref writes; the next start loads it', () => {
    inStore("st.setPref('new.bypass', false); st.setPref('ui.cliSuggest', false); console.log('1')");
    const saved = JSON.parse(fs.readFileSync(path.join(home, '.agent-boost', 'linux-settings.json'), 'utf8'));
    assert.deepStrictEqual(saved.prefs, { 'new.bypass': false, 'ui.cliSuggest': false });
    assert.deepStrictEqual(inStore("console.log(JSON.stringify([st.getPref('new.bypass'), st.getPref('ui.cliSuggest')]))"), [false, false]);
  });
  await test('other settings in the file are kept; unknown keys ignored', () => {
    const f = path.join(home, '.agent-boost', 'linux-settings.json');
    const s = JSON.parse(fs.readFileSync(f, 'utf8')); s.language = 'ko'; fs.writeFileSync(f, JSON.stringify(s));
    inStore("st.setPref('new.bypass', true); st.setPref('bogus', 1); console.log('1')");
    const after = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.strictEqual(after.language, 'ko');
    assert.deepStrictEqual(after.prefs, { 'new.bypass': true, 'ui.cliSuggest': false });
  });
  await test('AB_READONLY: kept in memory, file untouched', () => {
    const f = path.join(home, '.agent-boost', 'linux-settings.json');
    const before = fs.readFileSync(f, 'utf8');
    assert.strictEqual(inStore("st.setPref('ui.cliSuggest', true); console.log(JSON.stringify(st.getPref('ui.cliSuggest')))", { AB_READONLY: '1' }), true);
    assert.strictEqual(fs.readFileSync(f, 'utf8'), before);
  });
  fs.rmSync(home, { recursive: true, force: true });
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
})();
