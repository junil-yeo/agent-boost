// SlashPalette.swift port (catalog, custom command / skill scanning, filter, palette keys, router).
// Run: node test/slash.test.js
process.env.AB_READONLY = '1';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../main/slash');
const { L } = require('../main/l10n');

let failed = 0;
const test = async (name, f) => { try { await f(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e.stack || e).toString().split('\n').slice(0, 4).join('\n     ')); } };

(async () => {
  await test('built-in catalog: 26 commands, translated descriptions, flags', () => {
    const b = S.builtin();
    assert.strictEqual(b.length, 26);
    const model = b.find((c) => c.name === 'model');
    assert.deepStrictEqual(model, { name: 'model', desc: L('모델 변경'), argHint: L('<모델>'), needsArg: true, terminalOnly: false, source: 'builtin', id: 'builtin:model', text: '/model' });
    assert.ok(S.isTerminalOnly('/help')); assert.ok(S.isTerminalOnly('/export notes.md')); assert.ok(!S.isTerminalOnly('/clear')); assert.ok(!S.isTerminalOnly('help'));
  });
  await test('filter: exact, prefix, substring, subsequence (≥ 3), description; sorted by rank then name', () => {
    const b = S.builtin();
    assert.deepStrictEqual(S.filter(b, 'co').map((c) => c.name).slice(0, 4), ['compact', 'config', 'context', 'cost']);
    assert.strictEqual(S.filter(b, 'cmp')[0].name, 'compact');
    assert.strictEqual(S.filter(b, 'exit')[0].name, 'exit');
    assert.strictEqual(S.filter(b, '').length, 26);
  });
  await test('scan: user / project commands (nested → a:b), skills, front matter, dedupe, 30 s cache', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-slash-'));
    fs.mkdirSync(path.join(cwd, '.claude', 'commands', 'git'), { recursive: true });
    fs.mkdirSync(path.join(cwd, '.claude', 'skills', 'pdfy'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.claude', 'commands', 'git', 'ship.md'), '---\ndescription: "Ship it"\nargument-hint: [branch]\n---\nbody');
    fs.writeFileSync(path.join(cwd, '.claude', 'commands', 'plain.md'), 'no front matter');
    fs.writeFileSync(path.join(cwd, '.claude', 'commands', 'clear.md'), '---\ndescription: shadow\n---');   // a built-in name: dropped
    fs.writeFileSync(path.join(cwd, '.claude', 'skills', 'pdfy', 'SKILL.md'), '---\nname: pdf-maker\ndescription: >\n  folded\n---');
    fs.writeFileSync(path.join(cwd, '.claude', 'commands', 'long.md'), '---\ndescription: ' + '가'.repeat(2000) + '\n---');
    const items = S.load(cwd);
    const mine = items.filter((c) => c.source === 'project' || c.name === 'pdf-maker');
    assert.deepStrictEqual(mine.map((c) => [c.name, c.source, c.desc, c.argHint]), [
      ['git:ship', 'project', 'Ship it', '[branch]'],
      ['long', 'project', '가'.repeat(140) + '…', null],
      ['pdf-maker', 'skill', L('스킬'), null],
      ['plain', 'project', L('사용자 정의 명령'), null],
    ]);
    assert.ok(!items.some((c) => c.name === 'clear'));
    assert.strictEqual(S.cached(cwd), items);
    fs.writeFileSync(path.join(cwd, '.claude', 'commands', 'new.md'), 'x');
    assert.strictEqual(S.load(cwd), items);                                // cached for 30 s
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  await test('routeAction: /model, /effort, /rename', () => {
    assert.deepStrictEqual(S.routeAction('/model opus'), { action: 'setModel', model: 'claude-opus-5-5' });
    assert.deepStrictEqual(S.routeAction('/model Haiku 4.5'), { action: 'setModel', model: 'claude-haiku-4-5' });
    assert.deepStrictEqual(S.routeAction('/model claude-sonnet-5-5'), { action: 'setModel', model: 'claude-sonnet-5-5' });
    assert.strictEqual(S.routeAction('/model gpt'), null);
    assert.strictEqual(S.routeAction('/model'), null);
    assert.deepStrictEqual(S.routeAction('/effort MAX'), { action: 'setEffort', effort: 'max' });
    assert.strictEqual(S.routeAction('/effort huge'), null);
    assert.deepStrictEqual(S.routeAction('/rename  New name '), { action: 'rename', name: 'New name' });
    assert.strictEqual(S.routeAction('/rename'), null);
    assert.strictEqual(S.routeAction('/compact now'), null);
  });
  await test('SlashController (renderer module): query, keys, Enter only on a real prefix, pick', async () => {
    const { SlashController, setL } = await import('../renderer/logic/slash.mjs');
    setL(L);
    const c = new SlashController();
    assert.strictEqual(c.query('/usr/local'), null); assert.strictEqual(c.query('/mo'), 'mo'); assert.strictEqual(c.query('x'), null);
    assert.strictEqual(c.items('/mod')[0].name, 'model');
    assert.deepStrictEqual(c.handle('Tab', false, '/mod'), { consumed: true, draft: '/model ', send: false });
    assert.deepStrictEqual(c.handle('Enter', false, '/cle'), { consumed: true, draft: '/clear', send: true });
    assert.deepStrictEqual(c.handle('Enter', false, '/cmp'), { consumed: false, draft: '/cmp', send: false });   // not a prefix: dismissed
    assert.deepStrictEqual(c.items('/cmp'), []);
    c.handle('ArrowDown', false, '/co');
    assert.deepStrictEqual(c.handle('Enter', false, '/co'), { consumed: true, draft: '/config', send: true });
    assert.deepStrictEqual(c.handle('Tab', false, '/compa'), { consumed: true, draft: '/compact ', send: false });   // has an argument hint
    assert.deepStrictEqual(c.handle('Enter', true, '/compa'), { consumed: false, draft: '/compa', send: false });
  });
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
})();
