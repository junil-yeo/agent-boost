// TranscriptReader port: synthetic transcripts covering each record kind, incremental reads, modes, caps, background
// warming, recentAnswers / unwrapPaste; plus a read-only pass over the real ~/.claude/projects transcripts.
// Run: node test/transcript.test.js   (exit code 0 = all pass)
process.env.AB_READONLY = '1';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('../main/transcript');
const { L } = require('../main/l10n');

let failed = 0;
const test = async (name, f) => { try { await f(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e.stack || e).toString().split('\n').slice(0, 4).join('\n     ')); } };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-transcript-'));
const ts = (s) => `2026-10-20T10:00:${String(s).padStart(2, '0')}.000Z`;
const rec = (o) => JSON.stringify(o) + '\n';
const user = (uuid, content, s, extra = {}) => rec({ type: 'user', uuid, timestamp: ts(s), message: { role: 'user', content }, ...extra });
const asst = (uuid, content, s, extra = {}, msg = {}) => rec({ type: 'assistant', uuid, timestamp: ts(s), message: { role: 'assistant', model: 'claude-opus-5-5', content, ...msg }, ...extra });
const reader = () => { const r = new T.TranscriptReader(); r.metaPath = path.join(dir, 'meta.json'); return r; };

(async () => {
  await test('entries: user, assistant text, thinking, tool use and result, error result', () => {
    const p = path.join(dir, 'a.jsonl');
    fs.writeFileSync(p,
      user('u1', 'hello there\nsecond line', 1)
      + asst('a1', [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Hi!' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls -la', description: 'list' } }], 2, {}, { id: 'm1', usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 7 } })
      + user('u2', [{ type: 'tool_result', tool_use_id: 't', content: 'Error: nope', is_error: false }], 3)
      + user('u3', [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'Permission denied' }] }], 4)
      + asst('a2', [{ type: 'text', text: 'done' }], 5, {}, { id: 'm1', stop_reason: 'end_turn', usage: { input_tokens: 999 } }));
    const s = reader().snapshot(p, 'full');
    assert.deepStrictEqual(s.entries.map((e) => [e.role, e.text, e.toolName, e.isThinking, e.isError]), [
      ['user', 'hello there\nsecond line', null, false, false],
      ['assistant', 'hmm', null, true, false],
      ['assistant', 'Hi!', null, false, false],
      ['tool', 'ls -la', 'Bash', false, false],
      ['tool', 'Error: nope', '결과', false, true],
      ['tool', 'Permission denied', '결과', false, true],
      ['assistant', 'done', null, false, false],
    ]);
    assert.deepStrictEqual(s.tokens, { input: 10, cacheWrite: 5, cacheRead: 100, output: 7 });   // m1 counted once
    assert.strictEqual(s.lastContext, 115);
    assert.strictEqual(s.model, 'claude-opus-5-5');
    assert.strictEqual(s.firstPrompt, 'hello there');
    assert.strictEqual(s.lastTurnEnded, true);
    assert.strictEqual(s.last, Date.parse(ts(5)));
    assert.strictEqual(s.entries[0].time, Date.parse(ts(1)));
  });

  await test('incremental: only appended lines are parsed; an unfinished line waits; version bumps', () => {
    const p = path.join(dir, 'b.jsonl');
    fs.writeFileSync(p, user('u1', 'one', 1));
    const r = reader();
    const s1 = r.snapshot(p, 'full');
    assert.strictEqual(s1.entries.length, 1);
    const v1 = s1.version;
    const half = asst('a1', [{ type: 'text', text: 'two' }], 2);
    fs.appendFileSync(p, half.slice(0, 20));
    const s2 = r.snapshot(p, 'full');
    assert.strictEqual(s2.entries.length, 1);
    assert.strictEqual(s2.version, v1);
    fs.appendFileSync(p, half.slice(20));
    const s3 = r.snapshot(p, 'full');
    assert.deepStrictEqual(s3.entries.map((e) => e.text), ['one', 'two']);
    assert.strictEqual(s3.version, v1 + 1);
    assert.strictEqual(s3.offset, fs.statSync(p).size);
    fs.writeFileSync(p, user('x', 'rewritten', 1));                    // shorter: start over
    assert.deepStrictEqual(r.snapshot(p, 'full').entries.map((e) => e.text), ['rewritten']);
  });

  await test('modes: skip keeps no entries, light cuts long text, full re-parses a truncated file', () => {
    const p = path.join(dir, 'c.jsonl');
    const long = 'x'.repeat(5000);
    fs.writeFileSync(p, user('u1', 'q', 1) + asst('a1', [{ type: 'text', text: long }], 2));
    const r = reader();
    const sk = r.snapshot(p, 'skip');
    assert.strictEqual(sk.entries.length, 0); assert.strictEqual(sk.entriesLoaded, false); assert.strictEqual(sk.model, 'claude-opus-5-5');
    const li = r.snapshot(p, 'light');
    assert.strictEqual(li.entries[1].text, 'x'.repeat(4096) + '…'); assert.strictEqual(li.truncated, true);
    const fu = r.snapshot(p, 'full');
    assert.strictEqual(fu.entries[1].text, long); assert.strictEqual(fu.truncated, false);
    assert.strictEqual(r.effective(p, 'light'), T.Mode.light);
    assert.strictEqual(r.effective(p, 'full'), T.Mode.full);
    assert.strictEqual(r.effective(p, 'light'), T.Mode.full);           // recently focused stays full
  });

  await test('slash commands, local output, settings, interrupts, queued commands, peers, titles', () => {
    const p = path.join(dir, 'd.jsonl');
    fs.writeFileSync(p,
      user('u0', '<local-command-caveat>Caveat</local-command-caveat>', 0, { isMeta: true })
      + user('u1', '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>sonnet</command-args>', 1)
      + user('u2', '<local-command-stdout>Set model to \u001b[1mSonnet 5.5\u001b[22m (claude-sonnet-5-5)</local-command-stdout>', 2)
      + rec({ type: 'system', subtype: 'local_command', uuid: 's1', timestamp: ts(3), content: '<local-command-stdout>Set effort level to high (this session)</local-command-stdout>' })
      + rec({ type: 'system', subtype: 'local_command', uuid: 's2', timestamp: ts(3), content: '<local-command-stdout>Set effort level to high (this session)</local-command-stdout>' })
      + user('u3', [{ type: 'text', text: '[Request interrupted by user for tool use]' }], 4)
      + user('u4', '[Request interrupted by user]', 5)
      + rec({ type: 'attachment', uuid: 'q1', timestamp: ts(6), attachment: { type: 'queued_command', prompt: [{ type: 'text', text: 'also do X' }] } })
      + rec({ type: 'attachment', uuid: 'q2', timestamp: ts(6), attachment: { type: 'queued_command', commandMode: 'bash', prompt: 'ls' } })
      + user('u5', 'also do X', 7)
      + user('u6', '<teammate-message teammate_id="alice" color="blue">\n{"type":"idle_notification","result":"finished"}\n</teammate-message>\n<teammate-message teammate_id="bob">hi lead</teammate-message>', 8)
      + rec({ type: 'custom-title', customTitle: 'My title' }) + rec({ type: 'ai-title', aiTitle: 'AI title' }));
    const s = reader().snapshot(p, 'full');
    assert.strictEqual(s.model, 'claude-sonnet-5-5');
    assert.strictEqual(s.effort, 'high');
    assert.strictEqual(s.customTitle, 'My title'); assert.strictEqual(s.aiTitle, 'AI title');
    assert.strictEqual(s.firstPrompt, '[Request interrupted by user for tool use]');   // slash commands do not name the conversation (as in Swift, a notice can)
    assert.deepStrictEqual(s.entries.map((e) => [e.id, e.role, e.text, e.toolName]), [
      ['u1', 'user', '/model sonnet', null],
      ['u2-stdout', 'system', 'Set model to Sonnet 5.5 (claude-sonnet-5-5)', 'stdout'],
      ['s1-stdout', 'system', 'Set effort level to high (this session)', 'stdout'],   // s2: same record seen twice
      ['u3-0', 'system', L('중단됨 — 도구 실행을 멈췄습니다'), 'auto'],
      ['u4', 'system', L('중단됨'), 'auto'],
      ['u5', 'user', 'also do X', null],                               // the queued copy (q1) gave way to the later one
      ['u6-tm0', 'peer', L('⏸ 대기 중') + ' — finished', 'alice'],
      ['u6-tm1', 'peer', 'hi lead', 'bob'],
    ]);
  });

  await test('model from a display name; timestamps without fractional seconds are not dates (as in Swift)', () => {
    const p = path.join(dir, 'e.jsonl');
    fs.writeFileSync(p, rec({ type: 'system', subtype: 'local_command', uuid: 's', content: 'Kept model as `Haiku 4.5`' })
      + rec({ type: 'user', uuid: 'u', timestamp: '2026-10-20T10:00:00Z', message: { content: 'hi' } }));
    const s = reader().snapshot(p, 'full');
    assert.strictEqual(s.model, 'claude-haiku-4-5');
    assert.strictEqual(s.entries[s.entries.length - 1].time, null);
  });

  await test('cap: 600 entries, 3000 while the reader holds older rows', () => {
    const p = path.join(dir, 'f.jsonl');
    let txt = '';
    for (let i = 0; i < 1000; i++) txt += asst('a' + i, [{ type: 'text', text: 't' + i }], i % 60);
    fs.writeFileSync(p, txt);
    const r = reader();
    assert.strictEqual(r.snapshot(p, 'full').entries.length, 600);
    assert.strictEqual(r.snapshot(p, 'full').entries[0].text, 't400');
    const r2 = reader(); r2.setHoldCap(true, p);
    assert.strictEqual(r2.snapshot(p, 'full').entries.length, 1000);
  });

  await test('needsWarm parses in the background, peek serves meanwhile', async () => {
    const p = path.join(dir, 'g.jsonl');
    fs.writeFileSync(p, user('u1', 'q', 1) + asst('a1', [{ type: 'text', text: 'a' }], 2, {}, { model: 'claude-haiku-5-5' }));
    const r = reader();
    let done;
    const doneP = new Promise((res) => { done = res; });
    assert.strictEqual(r.needsWarm(p, 'light', done), true);
    assert.strictEqual(r.needsWarm(p, 'light', () => {}), true);       // still warming
    assert.strictEqual(r.peek(p).model, 'claude-haiku-5-5');            // from the file tail
    await doneP;
    assert.strictEqual(r.needsWarm(p, 'light', () => {}), false);
    assert.strictEqual(r.snapshot(p, 'light').entries.length, 2);
    assert.strictEqual(r.needsWarm(p, 'full', () => {}), false);       // nothing was cut: light already equals full
  });

  await test('unwrapPaste: paste marks and attachment lists', () => {
    assert.strictEqual(T.unwrapPaste('<pasted_content id="1">\nabc\n</pasted_content id="1">'), 'abc');
    assert.strictEqual(T.unwrapPaste('look\n\n[첨부 파일]\n- /tmp/a/b.png\n-\n- /x/y.txt\nthanks'), 'look\n📎 b.png\n📎 y.txt\nthanks');
    assert.strictEqual(T.unwrapPaste('[첨부 파일]\n-\n'), '');
  });

  await test('recentAnswers: newest first, slash records and compaction summaries passed over, mid-answer window', () => {
    const p = path.join(dir, 'h.jsonl');
    fs.writeFileSync(p,
      asst('a0', [{ type: 'text', text: 'orphan' }], 0)
      + user('u1', 'first q', 1) + asst('a1', [{ type: 'text', text: 'A1a' }, { type: 'tool_use', name: 'x', input: {} }], 2) + asst('a1b', [{ type: 'text', text: 'A1b' }], 3)
      + user('u2', [{ type: 'text', text: 'second q' }, { type: 'image' }], 4) + asst('a2', [{ type: 'text', text: 'A2' }], 5)
      + user('c', 'summary', 6, { isCompactSummary: true })
      + user('u3', '<command-name>/model</command-name>', 7));
    assert.deepStrictEqual(T.recentAnswers(p, 5), [{ asked: 'second q', answer: 'A2' }, { asked: 'first q', answer: 'A1a\n\nA1b' }, { asked: '', answer: 'orphan' }]);
    assert.strictEqual(T.lastAnswer(p), 'A2');
    assert.deepStrictEqual(T.recentAnswers(p, 1).length, 1);
  });

  await test('real transcripts (read-only): every file parses in every mode; recentAnswers returns answers', () => {
    const root = path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(root)) { console.log('     (no ~/.claude/projects)'); return; }
    let n = 0, answers = 0;
    for (const d of fs.readdirSync(root)) {
      let names = []; try { names = fs.readdirSync(path.join(root, d)); } catch { continue; }
      for (const f of names.filter((x) => x.endsWith('.jsonl'))) {
        const p = path.join(root, d, f);
        const r = reader();
        const t0 = Date.now();
        const s = r.snapshot(p, 'full');
        assert.ok(s.entries.length <= 600);
        r.snapshot(p, 'skip'); r.snapshot(p, 'light');
        const a = T.recentAnswers(p, 5);
        answers += a.length; n++;
        console.log(`     ${f.slice(0, 8)} ${(fs.statSync(p).size / 1e6).toFixed(1)} MB: ${s.entries.length} entries, ${a.length} answers, ${Date.now() - t0} ms, model ${s.model}`);
      }
    }
    assert.ok(n === 0 || answers > 0);
  });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
})();
