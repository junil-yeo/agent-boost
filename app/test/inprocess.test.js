// In-process teammates (main/inprocess.js, Screen.teammateList) and the session view's subagents tab (main/subagents.js).
// Fixtures: test/fixtures/inprocess/footer-*.txt are real lead screens captured from Claude Code 2.1.304 (teammateMode
// in-process, one teammate "helper"); project/ is a small transcript folder (a lead, its Agent / Task subagents and two
// in-process teammate files). The folder is copied to a temp HOME so mtimes can be set per case.
// Run: node test/inprocess.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FIX = path.join(__dirname, 'fixtures', 'inprocess');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-inproc-'));
process.env.HOME = home;                                   // subagents.js looks under ~/.claude/projects
const proj = path.join(home, '.claude', 'projects', '-tmp-proj');
fs.mkdirSync(proj, { recursive: true });
fs.cpSync(path.join(FIX, 'project'), proj, { recursive: true });

const Screen = require('../main/screen');
const Sub = require('../main/subagents');
const InProc = require('../main/inprocess');
const read = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const lead = path.join(proj, 'lead-0001.jsonl');
const subdir = path.join(proj, 'lead-0001', 'subagents');
const touch = (f, msAgo) => { const t = (Date.now() - msAgo) / 1000; fs.utimesSync(path.join(subdir, f), t, t); };

let failed = 0;
const test = async (name, f) => { try { await f(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e.stack || e).toString().split('\n').slice(0, 6).join('\n     ')); } };

(async () => {
  // ── A: the lead's footer ──────────────────────────────────────────────────────────────────────────────────────────
  await test('footer, lead idle: main is viewed, helper idle with its description, ↓ to manage', () => {
    const f = Screen.teammateList(read('footer-main-idle.txt'));
    assert.ok(f);
    assert.deepStrictEqual(f.rows.map((r) => r.name), ['main', 'helper']);
    assert.strictEqual(f.rows[1].description, 'says ok');
    assert.strictEqual(f.rows[1].state, 'idle');
    assert.strictEqual(f.viewing, 'main');
    assert.strictEqual(f.manage, true);
    assert.strictEqual(f.listMode, false);
    assert.strictEqual(f.cursor, -1);
  });
  await test('footer, teammate working: elapsed time and tokens instead of "idle" read as busy', () => {
    const f = Screen.teammateList(read('footer-main-busy.txt'));
    assert.strictEqual(f.rows[1].state, 'busy');
    assert.ok(/tokens$/.test(f.rows[1].word));
  });
  await test('footer, list entered: cursor rows and list mode', () => {
    const a = Screen.teammateList(read('footer-list-main.txt'));
    assert.strictEqual(a.listMode, true); assert.strictEqual(a.cursor, 0); assert.strictEqual(a.viewing, 'main');
    const b = Screen.teammateList(read('footer-list-helper.txt'));
    assert.strictEqual(b.listMode, true); assert.strictEqual(b.cursor, 1); assert.strictEqual(b.viewing, 'main');
  });
  await test('footer, viewing the teammate: ⏺ moves to helper', () => {
    const f = Screen.teammateList(read('footer-viewing-helper.txt'));
    assert.strictEqual(f.viewing, 'helper');
    const g = Screen.teammateList(Screen.stripANSI(read('footer-viewing-helper.ansi')));
    assert.strictEqual(g.viewing, 'helper');
    const back = Screen.teammateList(read('footer-back-main.txt'));
    assert.strictEqual(back.cursor, 0); assert.strictEqual(back.viewing, 'helper');
  });
  await test('footer hidden (the CLI hides it ~30 s after its teammates went idle): null', () => {
    assert.strictEqual(Screen.teammateList(read('footer-hidden.txt')), null);
  });
  await test('footer parser ignores a screen without a "main" row and the conversation above the box', () => {
    const t = '⏺ helper  something  idle\n────────────\n❯ \n────────────\n  ⏸ manual mode on · ? for shortcuts\n';
    assert.strictEqual(Screen.teammateList(t), null);
    assert.strictEqual(Screen.teammateList(''), null);
  });
  await test('the footer list lines do not make the lead look busy (esc to interrupt is read on the status line only)', () => {
    assert.strictEqual(Screen.busy(read('footer-main-idle.txt')), false);
    assert.strictEqual(Screen.busy(read('footer-main-busy.txt')), true);    // the lead's own status line said esc to interrupt
  });

  // ── A: config members and the teammate's transcript ─────────────────────────────────────────────────────────────
  await test('isInProcessMember: backendType / tmuxPaneId "in-process"; the lead ("leader") and tmux teammates are not', () => {
    assert.strictEqual(InProc.isInProcessMember({ name: 'helper', tmuxPaneId: 'in-process', backendType: 'in-process' }), true);
    assert.strictEqual(InProc.isInProcessMember({ name: 'team-lead', tmuxPaneId: 'leader', backendType: 'in-process' }), false);
    assert.strictEqual(InProc.isInProcessMember({ name: 'x', tmuxPaneId: '%54', backendType: 'tmux' }), false);
  });
  await test('teammateFile: matched by meta teamName + name in the lead folder, newest of several', () => {
    touch('agent-ahelper-old0.jsonl', 600000); touch('agent-ahelper-new1.jsonl', 5000); touch('agent-ahelper-other.jsonl', 1000);
    const f = InProc.teammateFile(lead, 'session-lead0001', 'helper');
    assert.ok(f);
    assert.strictEqual(path.basename(f.path), 'agent-ahelper-new1.jsonl');
    assert.strictEqual(f.meta.model, 'claude-haiku-4-5');
    assert.strictEqual(InProc.teammateFile(lead, 'session-lead0001', 'nobody'), null);
    assert.strictEqual(InProc.teammateFile(null, 'session-lead0001', 'helper'), null);
  });
  await test('stateOf: the footer word first, else a transcript written in the last 15 s', () => {
    assert.strictEqual(InProc.stateOf({ state: 'busy' }, null), 'busy');
    assert.strictEqual(InProc.stateOf({ state: 'idle' }, { mtimeMs: Date.now() }), 'idle');
    assert.strictEqual(InProc.stateOf(null, { mtimeMs: Date.now() - 2000 }), 'busy');
    assert.strictEqual(InProc.stateOf(null, { mtimeMs: Date.now() - 60000 }), 'idle');
    assert.strictEqual(InProc.stateOf(null, null), 'idle');
  });

  // ── C: subagents ────────────────────────────────────────────────────────────────────────────────────────────────
  await test('scanDir + isTeammate: teammates are told apart from Agent / Task subagents', () => {
    const all = Sub.scanDir(subdir);
    const subs = all.filter((x) => !Sub.isTeammate(x.meta)).map((x) => x.agentId).sort();
    assert.deepStrictEqual(subs, ['abg3', 'adone2', 'async1']);
  });
  await test('parentCalls: an Agent call without a tool_result is open; answered ones are closed', () => {
    const c = Sub.parentCalls(lead);
    assert.ok(c.open.has('toolu_SYNC'));
    assert.ok(!c.open.has('toolu_DONE') && c.closed.has('toolu_DONE'));
    assert.ok(!c.open.has('toolu_BG'));
    // the result arrives later: read from where the last read ended
    fs.appendFileSync(lead, JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_SYNC', content: 'done' }] } }) + '\n');
    const d = Sub.parentCalls(lead);
    assert.ok(!d.open.has('toolu_SYNC'));
  });
  await test('isRunning: finished / pending tool_use / growing / background / parent ended / older run', () => {
    const now = Date.now();
    const live = { live: true, startedAt: now - 3600000 };
    const calls = { open: new Set(['toolu_SYNC']), closed: new Set() };
    const it = (meta, ago) => ({ meta, mtimeMs: now - ago });
    assert.strictEqual(Sub.isRunning(it({ toolUseId: 'toolu_SYNC' }, 600000), live, calls, true, now), true);          // pending call
    assert.strictEqual(Sub.isRunning(it({ toolUseId: 'toolu_SYNC', finished: true }, 1000), live, calls, true, now), false);   // marked finished
    assert.strictEqual(Sub.isRunning(it({ toolUseId: 'toolu_X' }, 5000), live, calls, true, now), true);               // still growing
    assert.strictEqual(Sub.isRunning(it({ toolUseId: 'toolu_X' }, 600000), live, calls, true, now), false);            // quiet, answered
    assert.strictEqual(Sub.isRunning(it({ requestShape: 'background' }, 600000), live, calls, true, now), true);       // bg, not finished
    assert.strictEqual(Sub.isRunning(it({ requestShape: 'background' }, 600000), live, calls, false, now), false);     // CLI never marks: quiet = done
    assert.strictEqual(Sub.isRunning(it({ requestShape: 'background' }, 60000), live, calls, false, now), true);
    assert.strictEqual(Sub.isRunning(it({ toolUseId: 'toolu_SYNC' }, 1000), { live: false }, calls, true, now), false); // parent ended
    assert.strictEqual(Sub.isRunning(it({ requestShape: 'background' }, 7200000), live, calls, true, now), false);     // before this process
  });
  await test('list(sid): rows without teammates, with description, type, model, tokens, start and duration', async () => {
    touch('agent-async1.jsonl', 600000); touch('agent-adone2.jsonl', 600000); touch('agent-abg3.jsonl', 600000);
    let r = Sub.list('lead-0001');
    // tokens / model come from the shared transcript reader, parsed in the background the first time
    for (let i = 0; i < 40 && r.items.some((x) => x.parsing); i++) { await new Promise((ok) => setTimeout(ok, 50)); r = Sub.list('lead-0001'); }
    const by = Object.fromEntries(r.items.map((x) => [x.agentId, x]));
    assert.deepStrictEqual(Object.keys(by).sort(), ['abg3', 'adone2', 'async1']);
    assert.strictEqual(by.adone2.description, 'Count files');
    assert.strictEqual(by.adone2.agentType, 'general-purpose');
    assert.strictEqual(by.adone2.model, 'claude-sonnet-5-5');
    assert.strictEqual(by.adone2.tokens.output, 70);
    assert.strictEqual(by.adone2.total, 100 + 20 + 300 + 70);
    assert.strictEqual(by.adone2.started, Date.parse('2026-10-20T10:00:02.500Z'));
    assert.strictEqual(by.adone2.duration, Date.parse('2026-10-20T10:00:08.000Z') - Date.parse('2026-10-20T10:00:02.500Z'));
    assert.strictEqual(by.abg3.background, true);
    // the session is not live in a store here: every subagent is done
    assert.ok(r.items.every((x) => x.running === false));
    assert.strictEqual(Sub.fileOf('lead-0001', 'ahelper-new1'), null);       // a teammate's file is not a subagent's
    assert.strictEqual(Sub.fileOf('lead-0001', '../x'), null);
  });
  await test('chat(sid, agentId): the subagent conversation; unchanged version → same', async () => {
    let c = Sub.chat('lead-0001', 'adone2');
    for (let i = 0; i < 40 && c.loading; i++) { await new Promise((ok) => setTimeout(ok, 50)); c = Sub.chat('lead-0001', 'adone2'); }
    assert.ok(c.entries.some((e) => e.role === 'assistant' && e.text.includes('working on Count files')));
    assert.strictEqual(Sub.chat('lead-0001', 'adone2', c.version).same, true);
    assert.strictEqual(Sub.chat('lead-0001', 'ahelper-new1').missing, true);
  });

  fs.rmSync(home, { recursive: true, force: true });
  console.log(failed ? `${failed} failed` : 'all ok');
  process.exit(failed ? 1 : 0);
})();
