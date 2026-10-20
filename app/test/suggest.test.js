// Suggest.swift port: history parsing / ↑↓ list / completion, HistoryNav, Suggest.next rules, the "@" file filter,
// MentionController and the folder scan; the renderer's ES module and main's copy are the same file.
// Run: node test/suggest.test.js
process.env.AB_READONLY = '1';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../main/suggest');
const { L } = require('../main/l10n');

let failed = 0;
const test = async (name, f) => { try { await f(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e.stack || e).toString().split('\n').slice(0, 4).join('\n     ')); } };

(async () => {
  const items = [
    { text: 'fix the build', at: 1, sessionId: 'a', project: '/p1' },
    { text: 'fix the tests please', at: 2, sessionId: 'b', project: '/p2' },
    { text: 'multi\nline', at: 3, sessionId: 'a', project: '/p1' },
    { text: 'fix the build', at: 4, sessionId: 'c', project: '/p3' },
    { text: 'run it', at: 5, sessionId: 'a', project: '/p1' },
  ];
  await test('navigation: this session, then folder, then everything; newest first; no repeats', () => {
    assert.deepStrictEqual(S.navigation(items, 'b', '/p1'), ['fix the tests please', 'run it', 'multi\nline', 'fix the build']);
    assert.deepStrictEqual(S.navigation(items, 'zzz', null), ['run it', 'fix the build', 'multi\nline', 'fix the tests please']);
  });
  await test('HistoryCompleter: ≥ 2 chars, one line, longer than typed, same folder wins, narrowing cache', () => {
    const c = new S.HistoryCompleter(); c.set(items);
    assert.strictEqual(c.complete('f', '/p1'), null);
    assert.strictEqual(c.complete('fi', '/p2'), 'fix the tests please');
    assert.strictEqual(c.complete('FIX THE B', '/p2'), 'fix the build');
    assert.strictEqual(c.complete('fix the build', null), null);           // not longer
    assert.strictEqual(c.complete('mu', null), null);                      // multi-line candidates are left out
    assert.strictEqual(c.complete('fix the', '/p1'), 'fix the build');      // the same folder wins over newer
    assert.strictEqual(c.complete('fix the', null), 'fix the build');       // newest
    assert.strictEqual(c.complete('a\nb', null), null);
  });
  await test('HistoryNav: up / down / past the newest restores the typed text / edit stops / cancel', () => {
    const n = new S.HistoryNav(['c', 'b', 'a']);
    let r = n.up('typed'); assert.deepStrictEqual(r, { handled: true, draft: 'c' }); assert.ok(n.active);
    r = n.up(r.draft); r = n.up(r.draft); assert.strictEqual(r.draft, 'a');
    assert.deepStrictEqual(n.up('a'), { handled: true, draft: 'a' });     // the oldest: stays (key consumed)
    r = n.down('a'); assert.strictEqual(r.draft, 'b');
    r = n.down(r.draft); r = n.down(r.draft); assert.deepStrictEqual(r, { handled: true, draft: 'typed' }); assert.ok(!n.active);
    assert.deepStrictEqual(n.down('typed'), { handled: false, draft: 'typed' });
    n.up('x'); n.noteEdit('changed'); assert.ok(!n.active);
    n.up('y'); assert.deepStrictEqual(n.cancel('c'), { handled: true, draft: 'y' });
    assert.deepStrictEqual(new S.HistoryNav([]).up('q'), { handled: false, draft: 'q' });
  });
  const agent = { sessionId: 's', state: 'idle', canReceiveInput: true };
  const e = (id, role, text, o = {}) => ({ id, role, text, toolName: null, isThinking: false, isError: false, ...o });
  await test('Suggest.next: questions, numbered options, commit/test/delete, long reports, failed tools', () => {
    assert.strictEqual(S.next([e('1', 'user', 'go'), e('2', 'assistant', 'Shall I commit this?')], agent), L('네, 커밋해 주세요'));
    assert.strictEqual(S.next([e('1', 'user', 'go'), e('3', 'assistant', 'Options:\n1. a\n2) b\nWhich one?')], agent), L('1번으로 진행해 주세요'));
    assert.strictEqual(S.next([e('4', 'assistant', '테스트도 돌릴까요?')], agent), L('네, 테스트까지 돌려 주세요'));
    assert.strictEqual(S.next([e('5', 'assistant', 'Want me to remove it')], agent), L('네, 지워 주세요'));
    assert.strictEqual(S.next([e('6', 'assistant', '이대로 진행할까요')], agent), L('네, 그렇게 진행해 주세요'));
    const long = Array.from({ length: 8 }, (_, i) => 'line ' + i).join('\n');
    assert.strictEqual(S.next([e('7', 'tool', 'ls', { toolName: 'Bash' }), e('8', 'assistant', long)], agent), L('변경한 내용을 한 번 더 점검하고 문제 없으면 마무리해 주세요'));
    assert.strictEqual(S.next([e('9', 'assistant', 'ok'), e('10', 'tool', 'boom', { toolName: '결과', isError: true })], agent), L('오류 원인을 찾아 고쳐 주세요'));
    assert.strictEqual(S.next([e('11', 'assistant', 'Done?'), e('12', 'user', 'yes')], agent), null);   // my turn was last
    assert.strictEqual(S.next([e('13', 'assistant', 'Done?'), e('14', 'user', 'x', { toolName: '전송 중' })], agent), null);
    assert.strictEqual(S.next([e('15', 'assistant', 'Done?')], { ...agent, state: 'busy' }), null);
  });
  await test('FileIndex.filter: basename prefix, substring, path, loose subsequence (≥ 3), shorter first', () => {
    const all = ['src/', 'src/main.js', 'src/lib/maintenance.js', 'docs/readme.md', 'test/main.test.js', 'a/b/c/mxaxixn.txt'];
    assert.deepStrictEqual(S.filter(all, 'main'), ['src/main.js', 'test/main.test.js', 'src/lib/maintenance.js', 'a/b/c/mxaxixn.txt']);
    assert.deepStrictEqual(S.filter(all, 'SRC'), ['src/', 'src/main.js', 'src/lib/maintenance.js']);
    assert.deepStrictEqual(S.filter(all, 'mxn'), ['a/b/c/mxaxixn.txt']);
    assert.deepStrictEqual(S.filter(all, 'mn'), []);
    assert.strictEqual(S.filter(all, '', 2).length, 2);
  });
  await test('MentionController: token, lazy load, items, pick, keys, dismiss', async () => {
    let loads = 0;
    const m = new S.MentionController(async (cwd) => { loads++; return cwd === '/w' ? ['src/', 'src/a.js', 'b.txt'] : []; });
    m.reload('/w');
    assert.strictEqual(m.token('hi @sr'), 3); assert.strictEqual(m.token('hi@sr'), -1); assert.strictEqual(m.token('@a b'), -1);
    assert.deepStrictEqual(m.items('look @'), []);                         // the first "@" starts the scan
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(loads, 1);
    assert.deepStrictEqual(m.items('look @'), ['src/', 'src/a.js', 'b.txt']);   // an empty query keeps the list's order
    let r = m.handle('ArrowDown', false, 'look @'); assert.ok(r.consumed); assert.strictEqual(m.index, 1);
    r = m.handle('Tab', false, 'look @'); assert.strictEqual(r.draft, 'look @src/a.js ');
    assert.strictEqual(m.pick('src/', 'x @s'), 'x @src/');
    assert.deepStrictEqual(m.handle('Enter', true, 'look @'), { consumed: false, draft: 'look @' });
    m.handle('Escape', false, 'look @'); assert.deepStrictEqual(m.items('look @'), []);
    assert.deepStrictEqual(m.items('look @s'), ['src/', 'src/a.js']);
  });
  await test('scan: hidden and junk folders skipped, depth limit, folders end with "/", too-broad folders refused', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-files-'));
    for (const d of ['node_modules/x', '.git/y', 'a/b/c/d/e/f/g/h', 'src']) fs.mkdirSync(path.join(root, d), { recursive: true });
    for (const f of ['src/index.js', '.hidden', 'node_modules/x/i.js', 'a/b/c/d/e/f/g/h/deep.txt', 'a/b/c/d/e/f/g/seven.txt', 'top.md']) fs.writeFileSync(path.join(root, f), '');
    const list = await S.scan(root);
    assert.ok(list.includes('src/') && list.includes('src/index.js') && list.includes('top.md'));
    assert.ok(!list.some((p) => p.includes('node_modules') || p.includes('.git') || p.includes('.hidden')));
    assert.ok(list.includes('a/b/c/d/e/f/g/'));                            // level 7 listed …
    assert.ok(!list.includes('a/b/c/d/e/f/g/seven.txt'));                 // … but not entered
    assert.deepStrictEqual(list, list.slice().sort((x, y) => x.length - y.length || (x < y ? -1 : 1)));
    assert.deepStrictEqual(await S.files(os.homedir()), []); assert.deepStrictEqual(await S.files('/'), []);
    fs.rmSync(root, { recursive: true, force: true });
  });
  await test('scan: macOS packages listed but not entered; files() caches 30 s and shares a running scan', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-files-'));
    for (const d of ['My.app/Contents/MacOS', 'Proj.xcodeproj/xcuserdata', 'plain.dir/sub']) fs.mkdirSync(path.join(root, d), { recursive: true });
    fs.writeFileSync(path.join(root, 'My.app/Contents/MacOS/bin'), ''); fs.writeFileSync(path.join(root, 'plain.dir/sub/f.txt'), '');
    const list = await S.scan(root);
    assert.ok(list.includes('My.app/') && list.includes('Proj.xcodeproj/') && list.includes('plain.dir/sub/f.txt'));
    if (process.platform === 'darwin') assert.ok(!list.some((p) => p.startsWith('My.app/C') || p.startsWith('Proj.xcodeproj/x')), JSON.stringify(list));
    else assert.ok(list.includes('My.app/Contents/'));                      // Linux has no packages: a folder is a folder
    assert.strictEqual(S.cachedFiles(root), null);
    const [a, b] = [S.files(root), S.files(root)];
    assert.ok(a instanceof Promise);
    assert.deepStrictEqual(await a, await b);
    assert.deepStrictEqual(S.cachedFiles(root), await a);
    fs.writeFileSync(path.join(root, 'new.txt'), '');
    assert.ok(!(await S.files(root)).includes('new.txt'));                  // within 30 s: the cached list
    fs.rmSync(root, { recursive: true, force: true });
  });
  await test('real ~/.claude/history.jsonl (read-only): parse and prepare', () => {
    const t0 = Date.now();
    const p = S.prepare('none', process.cwd(), null);
    console.log(`     ${p.items.length} prompts, ${p.nav.length} in the ↑/↓ list, ${Date.now() - t0} ms`);
    assert.ok(p.items.length <= 3000 && p.nav.length <= 500);
    assert.strictEqual(S.prepare('none', null, p.stamp).items, null);       // unchanged file: nothing resent
  });
  await test('renderer module: the ES module exports the same functions', async () => {
    const mod = await import('../renderer/logic/suggest.mjs');
    for (const k of ['navigation', 'HistoryCompleter', 'HistoryNav', 'next', 'filterFiles', 'MentionController', 'setL', 'charCount']) assert.ok(mod[k], k);
    assert.deepStrictEqual(mod.navigation(items, 'b', '/p1'), S.navigation(items, 'b', '/p1'));
  });
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
})();
