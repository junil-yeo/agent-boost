// The session list's cheap metadata (main/listmeta.js): head/tail fields, the message count by byte scan (continued as
// the file grows), the cache by size + mtime. Files live in a temp folder; the cache file too (AB_LISTMETA_FILE).
// Run: node test/listmeta.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-listmeta-'));
process.env.AB_LISTMETA_FILE = path.join(dir, 'cache.json');
const LM = require('../main/listmeta');
const { writeTranscript } = require('./fake-history');

let failed = 0;
const test = async (name, f) => { try { await f(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e.stack || e).toString().split('\n').slice(0, 6).join('\n     ')); } };

(async () => {
  await test('countLines: complete lines with a user / assistant record; a partial last line waits', () => {
    const b = Buffer.from('{"type":"user","x":"a"}\n{"type":"system"}\n{"a":1,"type":"assistant","m":{"type":"user"}}\n{"type":"user"');
    const r = LM.countLines(b);
    assert.strictEqual(r.n, 2);                                    // one count per line, nested "type" ignored
    assert.strictEqual(r.end, b.lastIndexOf(10) + 1);
    assert.strictEqual(LM.countLines(Buffer.from('{"type":"user"')).end, 0);
  });
  await test('quoted text inside a message never counts (it is escaped in JSON)', () => {
    const line = JSON.stringify({ type: 'system', content: 'he wrote "type":"user" here' }) + '\n';
    assert.strictEqual(LM.countLines(Buffer.from(line)).n, 0);
  });
  await test('createdFromHead: the first timestamp; firstPromptFromHead skips commands and meta records', () => {
    const head = [
      JSON.stringify({ type: 'custom-title', customTitle: 'x' }),
      JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: 'caveat' }, timestamp: '2026-01-02T03:04:05.000Z' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: '/model opus' }, timestamp: '2026-01-02T03:04:06.000Z' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '\n  Fix the build\nplease' }] }, timestamp: '2026-01-02T03:04:07.000Z' }),
    ].join('\n');
    assert.strictEqual(LM.createdFromHead(head), Date.parse('2026-01-02T03:04:05.000Z'));
    assert.strictEqual(LM.firstPromptFromHead(head), 'Fix the build');
  });
  await test('meta: unknown first, read in the background; title, branch, cwd, created, count', async () => {
    const created = Date.parse('2026-03-01T10:00:00.000Z');
    const p = writeTranscript(dir, { created, turns: 6, title: 'My title', branch: 'feat-x', cwd: '/tmp/proj-a', prompt: 'Hello there' });
    assert.strictEqual(LM.meta(p), null);
    await LM.idle();
    const e = LM.meta(p);
    assert.strictEqual(e.created, created);
    assert.deepStrictEqual([e.customTitle, e.branch, e.cwd, e.firstPrompt, e.count], ['My title', 'feat-x', '/tmp/proj-a', 'Hello there', 12]);
    assert.strictEqual(LM.created(p), created);
  });
  await test('meta: an appended file is counted from where it stopped; the version moves', async () => {
    const p = writeTranscript(dir, { created: Date.now() - 1000, turns: 2 });
    LM.meta(p); await LM.idle();
    const e1 = LM.meta(p); const off1 = e1.countOffset; const v1 = LM.version();
    assert.strictEqual(e1.count, 4);
    fs.appendFileSync(p, JSON.stringify({ type: 'user', message: { role: 'user', content: 'more' }, timestamp: new Date().toISOString() }) + '\n'
      + JSON.stringify({ type: 'custom-title', customTitle: 'Renamed' }) + '\n');
    fs.utimesSync(p, new Date(), new Date(Date.now() + 5000));
    LM.meta(p); await LM.idle();
    const e2 = LM.meta(p);
    assert.strictEqual(e2.count, 5);
    assert.ok(e2.countOffset > off1);
    assert.strictEqual(e2.customTitle, 'Renamed');
    assert.ok(LM.version() > v1);
  });
  await test('the cache is saved by path and read by the next run', async () => {
    LM.flush();
    const j = JSON.parse(fs.readFileSync(process.env.AB_LISTMETA_FILE, 'utf8'));
    assert.ok(Object.keys(j).length >= 2);
    assert.ok(Object.values(j).every((e) => typeof e.created === 'number'));
  });
  await test('400 files: the first pass (head/tail + counts) is quick and cached', async () => {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-listmeta-many-'));
    const files = require('./fake-history').makeHistory(h, 400, 20);
    const t0 = Date.now();
    for (const p of files) LM.meta(p);
    const sync = Date.now() - t0;
    await LM.idle();
    const all = Date.now() - t0;
    const t1 = Date.now();
    for (const p of files) assert.strictEqual(LM.meta(p).count, 40);
    const again = Date.now() - t1;
    console.log(`     (400 files: ${sync} ms to ask, ${all} ms until every count is in, ${again} ms to ask again)`);
    assert.ok(sync < 500 && again < 500, `asking must not block: ${sync} / ${again} ms`);
  });
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
})();
