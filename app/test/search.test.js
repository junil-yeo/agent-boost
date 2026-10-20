// ConvoIndex port: synthetic index (filters, titles, incremental reads, rewrite, search order, context) and a
// read-only build over the real ~/.claude/projects with its time (target ≤ 1 s for ~150 MB).
// Run: node test/search.test.js
process.env.AB_READONLY = '1';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ConvoIndex } = require('../main/search');

let failed = 0;
const test = async (name, f) => { try { await f(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e.stack || e).toString().split('\n').slice(0, 4).join('\n     ')); } };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-search-'));
const ts = (s) => `2026-10-20T10:00:${String(s).padStart(2, '0')}.000Z`;
const rec = (o) => JSON.stringify(o) + '\n';

(async () => {
  fs.mkdirSync(path.join(root, '-home-me-proj'));
  const p = path.join(root, '-home-me-proj', 'sid-1.jsonl');
  fs.writeFileSync(p,
    rec({ type: 'user', timestamp: ts(1), message: { content: 'Fix the tmux bug' } })
    + rec({ type: 'assistant', timestamp: ts(2), message: { content: [{ type: 'thinking', thinking: 'tmux secret' }, { type: 'text', text: 'Looking at TMUX now' }, { type: 'text', text: 'second part' }] } })
    + rec({ type: 'user', timestamp: ts(3), message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'tmux output' }] } })
    + rec({ type: 'user', timestamp: ts(4), message: { content: '<command-name>/tmux</command-name>' } })
    + rec({ type: 'user', timestamp: ts(5), isMeta: true, message: { content: 'tmux meta' } })
    + rec({ type: 'user', timestamp: ts(6), isCompactSummary: true, message: { content: 'tmux summary' } })
    + rec({ type: 'ai-title', aiTitle: 'AI named' })
    + rec({ type: 'custom-title', customTitle: 'Custom named' })
    + rec({ type: 'user', timestamp: ts(7), message: { content: [{ type: 'text', text: 'pasted:\n<pasted_content id="1">\ntmux again\n</pasted_content id="1">' }] } }));

  const ix = new ConvoIndex(root);
  await test('index keeps my messages and answer text only', async () => {
    assert.strictEqual(await ix.refresh(), 1);
    const f = ix.snapshot()[0];
    assert.strictEqual(f.sid, 'sid-1'); assert.strictEqual(f.project, '-home-me-proj'); assert.strictEqual(f.title, 'Custom named');
    assert.deepStrictEqual(f.msgs.map((m) => [m.user, m.text]), [[true, 'Fix the tmux bug'], [false, 'Looking at TMUX now\n\nsecond part'], [true, 'pasted:\ntmux again']]);
  });
  await test('search: every word, case-insensitive, newest first, limit', () => {
    const h = ix.search('TMUX');
    assert.deepStrictEqual(h.map((x) => x.index), [2, 1, 0]);
    assert.deepStrictEqual(Object.keys(h[0]).sort(), ['id', 'index', 'path', 'project', 'sid', 'text', 'time', 'title', 'user']);
    assert.strictEqual(h[0].id, 'sid-1#2'); assert.strictEqual(h[0].time, Date.parse(ts(7)));
    assert.deepStrictEqual(ix.search('tmux  bug').map((x) => x.index), [0]);
    assert.deepStrictEqual(ix.search('   '), []);
    assert.strictEqual(ix.search('tmux', 2).length, 2);
  });
  await test('incremental: appended lines only; an unfinished line waits; a rewrite starts over', async () => {
    const line = rec({ type: 'user', timestamp: ts(9), message: { content: 'new tmux note' } });
    fs.appendFileSync(p, line.slice(0, 10));
    await ix.refresh();
    assert.strictEqual(ix.snapshot()[0].msgs.length, 3);
    fs.appendFileSync(p, line.slice(10));
    await ix.refresh();
    assert.strictEqual(ix.snapshot()[0].msgs.length, 4);
    fs.writeFileSync(p, rec({ type: 'user', timestamp: ts(1), message: { content: 'only' } }));
    ix.refreshSync();
    assert.deepStrictEqual(ix.snapshot()[0].msgs.map((m) => m.text), ['only']);
    assert.strictEqual(ix.snapshot()[0].title, null);
  });
  await test('context: the message with its neighbours', () => {
    fs.writeFileSync(p, Array.from({ length: 10 }, (_, i) => rec({ type: 'user', timestamp: ts(i), message: { content: 'm' + i } })).join(''));
    const ix2 = new ConvoIndex(root); ix2.refreshSync();   // (a rewrite that grew the file reads as an append, as in Swift)
    const c = ix2.context('sid-1', 1);
    assert.deepStrictEqual(c.msgs.map((m) => m.index), [0, 1, 2, 3, 4]);
    assert.deepStrictEqual(ix2.context('sid-1', 9, 3).msgs.map((m) => m.text), ['m6', 'm7', 'm8', 'm9']);
    assert.strictEqual(ix2.context('nope', 0), null);
  });
  await test('context: by the hit\'s file when the same sid exists under two projects', () => {
    fs.mkdirSync(path.join(root, '-home-me-other'), { recursive: true });
    const p2 = path.join(root, '-home-me-other', 'sid-1.jsonl');
    fs.writeFileSync(p2, rec({ type: 'user', timestamp: ts(1), message: { content: 'other zebra' } }) + rec({ type: 'user', timestamp: ts(2), message: { content: 'other two' } }));
    const ix3 = new ConvoIndex(root); ix3.refreshSync();
    const h = ix3.search('zebra');
    assert.strictEqual(h.length, 1); assert.strictEqual(h[0].path, p2);
    assert.deepStrictEqual(ix3.context(h[0].path, 0).msgs.map((m) => m.text), ['other zebra', 'other two']);
    assert.strictEqual(ix3.context(h[0].path, 0).path, p2);
    fs.rmSync(path.join(root, '-home-me-other'), { recursive: true });
  });
  await test('vanished files leave the index', async () => {
    fs.rmSync(p);
    assert.strictEqual(await ix.refresh(), 0);
  });
  await test('real ~/.claude/projects (read-only): build time', async () => {
    const real = new ConvoIndex();
    if (!fs.existsSync(real.root)) { console.log('     (none)'); return; }
    let bytes = 0;
    for (const d of fs.readdirSync(real.root)) { try { for (const f of fs.readdirSync(path.join(real.root, d))) if (f.endsWith('.jsonl')) bytes += fs.statSync(path.join(real.root, d, f)).size; } catch { } }
    const t0 = Date.now(); real.refreshSync(); const ms = Date.now() - t0;
    const t1 = Date.now(); await real.refresh(); const inc = Date.now() - t1;
    const t2 = Date.now(); const hits = real.search('the'); const sm = Date.now() - t2;
    console.log(`     ${(bytes / 1e6).toFixed(0)} MB in ${real.files.size} files: built in ${ms} ms, refresh ${inc} ms, search ${sm} ms (${hits.length} hits)`);
    assert.ok(ms < 1000 * Math.max(1, bytes / 150e6) * 1.5, 'build too slow');
  });
  await test('module API: the shared index answers from its worker thread', async () => {
    const api = require('../main/search');
    assert.ok(typeof (await api.refresh()) === 'number');
    assert.strictEqual(typeof (await api.sessions()), 'number');
    assert.ok(Array.isArray(await api.search('the', 2)));
  });
  fs.rmSync(root, { recursive: true, force: true });
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
})();
