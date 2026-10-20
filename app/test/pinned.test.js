// Org chart pins (main/pins.js + the store's use of them): the rules, the first-launch migration, teams following their
// lead, pins following a conversation to a new id, and the background parse order (pinned files first). The store runs
// in child processes against a synthetic home (BOARD_HOME in a temp folder): the real ~/.claude and ~/.agent-boost are
// never read or written. Run: node test/pinned.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Pins = require('../main/pins');
const { writeTranscript } = require('./fake-history');

let failed = 0;
const test = async (name, f) => { try { await f(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e.stack || e).toString().split('\n').slice(0, 6).join('\n     ')); } };
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const D = (o) => Object.assign(Pins.fresh(1000), o);

/** Runs js in a fresh node with BOARD_HOME = home, the store as `st` and pins as `Pins`; returns the last JSON line. */
const storePath = require.resolve('../main/store'), pinsPath = require.resolve('../main/pins');
function inStore(home, js, env = {}) {
  const r = spawnSync(process.execPath, ['-e', `const st = require(${JSON.stringify(storePath)}); const Pins = require(${JSON.stringify(pinsPath)}); (async () => { ${js} })().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });`],
    { encoding: 'utf8', env: Object.assign({}, process.env, { BOARD_HOME: home, HOME: home, AB_READONLY: '', AB_ONLY: '', AB_PINNED_FILE: '', AB_NO_WORKERS: '1' }, env), timeout: 60000 });
  if (r.status !== 0) throw new Error((r.stderr || '') + (r.stdout || '') || 'exit ' + r.status);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}
const readPins = (home) => JSON.parse(fs.readFileSync(path.join(home, '.agent-boost', 'pinned.json'), 'utf8'));
const writePins = (home, d) => { fs.mkdirSync(path.join(home, '.agent-boost'), { recursive: true }); fs.writeFileSync(path.join(home, '.agent-boost', 'pinned.json'), JSON.stringify(d)); };
const sidOf = (p) => path.basename(p, '.jsonl');
const DAY = 86400000;

(async () => {
  // ── the rules ─────────────────────────────────────────────────────────────────────────────────────────────────
  await test('pinned = explicit pin, else not explicitly unpinned and created after installedAt', () => {
    const d = D({ pinned: ['a'], unpinned: ['b', 'c'] });
    assert.strictEqual(Pins.isPinned(d, 'a', 10), true);         // explicit beats an old creation time
    assert.strictEqual(Pins.isPinned(d, 'b', 5000), false);      // explicit unpin beats a new creation time
    assert.strictEqual(Pins.isPinned(d, 'x', 5000), true);       // created after install
    assert.strictEqual(Pins.isPinned(d, 'y', 999), false);       // created before install
    assert.strictEqual(Pins.isPinned(d, 'z', 1000), false);      // "after" is strict
    assert.strictEqual(Pins.isPinned(d, 'w', null), false);      // creation unknown: not pinned by the rule
  });
  await test('pin / unpin move an id between the lists (no duplicates); report changes', () => {
    const d = D({ unpinned: ['a'] });
    assert.strictEqual(Pins.pin(d, ['a', 'b']), true);
    assert.deepStrictEqual([d.pinned, d.unpinned], [['a', 'b'], []]);
    assert.strictEqual(Pins.pin(d, ['a']), false);
    assert.strictEqual(Pins.unpin(d, ['b']), true);
    assert.deepStrictEqual([d.pinned, d.unpinned], [['a'], ['b']]);
  });
  await test('team: shown when the lead is pinned; with no lead card, when any member is', () => {
    const created = { lead: 2000, m1: 2000, m2: 500 };
    const c = (sid) => created[sid] ?? null;
    const team = [{ sessionId: 'lead', isLead: true }, { sessionId: 'm1', isLead: false }, { sessionId: 'm2', isLead: false }];
    assert.strictEqual(Pins.teamPinned(D(), team, c), true);                                // lead created after install
    assert.strictEqual(Pins.teamPinned(D({ unpinned: ['lead'] }), team, c), false);         // members' own pins do not count
    const leaderless = team.slice(1);
    assert.strictEqual(Pins.teamPinned(D(), leaderless, c), true);                          // m1 is new
    assert.strictEqual(Pins.teamPinned(D({ unpinned: ['m1'] }), leaderless, c), false);
    assert.strictEqual(Pins.teamPinned(D({ unpinned: ['m1'], pinned: ['m2'] }), leaderless, c), true);
  });
  await test('inherit: the new id takes the old one\'s answer once; an id with its own choice keeps it', () => {
    const d = D({ pinned: ['old'] });
    assert.strictEqual(Pins.inherit(d, 'old', 'new', true), true);
    assert.ok(d.pinned.includes('new'));
    assert.strictEqual(Pins.inherit(d, 'old', 'new', true), false);
    assert.strictEqual(Pins.inherit(d, 'x', 'copy', false), true);
    assert.ok(d.unpinned.includes('copy'));                 // a copy made today of an unpinned conversation stays off
    const e = D({ unpinned: ['new'] });
    assert.strictEqual(Pins.inherit(e, 'old', 'new', true), false);
    assert.ok(e.unpinned.includes('new'));
  });
  await test('normalize: a broken or foreign file is not trusted', () => {
    assert.strictEqual(Pins.normalize(null), null);
    assert.strictEqual(Pins.normalize([]), null);
    assert.strictEqual(Pins.normalize({ pinned: [] }), null);
    assert.deepStrictEqual(Pins.normalize({ installedAt: 5, initialized: 1, pinned: ['a', 'a', 3], unpinned: 'x' }),
      { version: 1, installedAt: 5, initialized: false, pinned: ['a'], unpinned: [] });
  });

  // ── migration: the first launch of this version ──────────────────────────────────────────────────────────────
  await test('first launch: no file → installedAt = now, not initialized, written at once; the next start reads it', () => {
    const home = tmp('ab-pins-');
    const t0 = Date.now();
    const s = inStore(home, 'st.refresh(); console.log(JSON.stringify(st.getState().pins))');
    assert.strictEqual(s.initialized, false);
    assert.ok(s.installedAt >= t0 && s.installedAt <= Date.now());
    const f = readPins(home);
    assert.deepStrictEqual([f.installedAt, f.initialized, f.pinned, f.unpinned], [s.installedAt, false, [], []]);
    const again = inStore(home, 'st.refresh(); console.log(JSON.stringify(st.getState().pins))');
    assert.strictEqual(again.installedAt, s.installedAt);
  });
  await test('first launch: old conversations are not pinned; the picker\'s "나중에" pins the live ones and finishes', () => {
    const home = tmp('ab-pins-');
    const old = writeTranscript(home, { created: Date.now() - 3 * DAY });
    const r = inStore(home, `st.refresh(); const a = st.getState(); st.finishPinSetup(null); const b = st.getState();
      console.log(JSON.stringify({ before: a.pinned, loose: a.loose.map((x) => x.sessionId), after: b.pinned, init: b.pins.initialized }))`);
    assert.deepStrictEqual(r.loose, [sidOf(old)]);           // the list still has it
    assert.deepStrictEqual(r.before, []);
    assert.deepStrictEqual(r.after, []);                     // ended, so "나중에" leaves it off
    assert.strictEqual(r.init, true);
    assert.strictEqual(readPins(home).initialized, true);
  });
  await test('first launch picker: the chosen ones are pinned, the others (even new ones) taken off', () => {
    const home = tmp('ab-pins-');
    writePins(home, Pins.fresh(Date.now() - 2 * DAY));
    const a = writeTranscript(home, { created: Date.now() - 5 * DAY });     // before install
    const b = writeTranscript(home, { created: Date.now() - DAY });         // after install: pinned by the rule
    const r = inStore(home, `st.refresh(); const before = st.getState().pinned; st.finishPinSetup([${JSON.stringify(sidOf(a))}]);
      console.log(JSON.stringify({ before, after: st.getState().pinned }))`);
    assert.deepStrictEqual(r.before, [sidOf(b)]);
    assert.deepStrictEqual(r.after, [sidOf(a)]);
    const f = readPins(home);
    assert.deepStrictEqual([f.pinned, f.unpinned], [[sidOf(a)], [sidOf(b)]]);
  });
  await test('setPinned: unpinning only takes the card off the chart; the session stays in the list', () => {
    const home = tmp('ab-pins-');
    writePins(home, Object.assign(Pins.fresh(Date.now() - 2 * DAY), { initialized: true }));
    const b = writeTranscript(home, { created: Date.now() - DAY });
    const r = inStore(home, `st.refresh(); const sid = ${JSON.stringify(sidOf(b))}; const on = st.getState().pinned;
      st.setPinned(sid, false); const s = st.getState();
      console.log(JSON.stringify({ on, off: s.pinned, inList: s.loose.some((x) => x.sessionId === sid), archived: Object.keys(s.archive) }))`);
    assert.deepStrictEqual(r.on, [sidOf(b)]);
    assert.deepStrictEqual(r.off, []);
    assert.strictEqual(r.inList, true);
    assert.deepStrictEqual(r.archived, []);
  });

  // ── teams ────────────────────────────────────────────────────────────────────────────────────────────────────
  /** A team folder whose lead is an ended conversation (`leadSid`) plus one teammate. */
  const writeTeam = (home, name, leadSid) => {
    const dir = path.join(home, '.claude', 'teams', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ name, leadSessionId: leadSid, leadAgentId: 'team-lead@' + name, createdAt: Date.now() - DAY,
      members: [{ agentId: 'team-lead@' + name, name: 'team-lead', agentType: 'team-lead' }, { agentId: 'worker@' + name, name: 'worker', agentType: 'general-purpose' }] }));
  };
  await test('team: pinning the lead pins the team; teammates follow; unpinning takes the whole team off', () => {
    const home = tmp('ab-pins-');
    writePins(home, Object.assign(Pins.fresh(Date.now() - 2 * DAY), { initialized: true }));
    const lead = writeTranscript(home, { created: Date.now() - 5 * DAY });   // older than the install: not pinned by the rule
    writeTeam(home, 'crew', sidOf(lead));
    const r = inStore(home, `st.refresh(); const s0 = st.getState(); const t = s0.teams.find((x) => x.name === 'crew');
      const worker = t.members.find((m) => !m.isLead).sessionId;
      st.setPinned(worker, true); const s1 = st.getState();
      const on = { teams: s1.pinnedTeams, members: s1.teams[0].members.map((m) => m.pinned) };
      st.setPinned(worker, false); const s2 = st.getState();
      console.log(JSON.stringify({ before: s0.pinnedTeams, on, after: s2.pinnedTeams, file: Pins.load().data }))`);
    assert.deepStrictEqual(r.before, []);
    assert.deepStrictEqual(r.on.teams, ['crew']);                    // a teammate's toggle pins its lead (the team)
    assert.deepStrictEqual(r.on.members, [true, true]);
    assert.deepStrictEqual(r.after, []);
    assert.deepStrictEqual(r.file.unpinned, [sidOf(lead)]);          // only the lead's pin is recorded
  });

  // ── a conversation under a new id ───────────────────────────────────────────────────────────────────────────
  await test('resume under a new id: a CLI job that resumed a pinned conversation is pinned; an unpinned one stays off', () => {
    const home = tmp('ab-pins-');
    const old = writeTranscript(home, { created: Date.now() - 5 * DAY });
    const old2 = writeTranscript(home, { created: Date.now() - 6 * DAY });
    writePins(home, Object.assign(Pins.fresh(Date.now() - 2 * DAY), { initialized: true, pinned: [sidOf(old)] }));
    const job = (id, sid, from) => {
      const d = path.join(home, '.claude', 'jobs', id); fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify({ name: 'job ' + id, state: 'stopped', sessionId: sid, resumeSessionId: from, cwd: '/tmp', updatedAt: new Date().toISOString() }));
    };
    const n1 = '11111111-1111-4111-8111-111111111111', n2 = '22222222-2222-4222-8222-222222222222';
    job('aaaaaaaa', n1, sidOf(old));
    job('bbbbbbbb', n2, sidOf(old2));
    const r = inStore(home, `st.refresh(); const s = st.getState(); console.log(JSON.stringify({ pinned: s.pinned, file: Pins.load().data }))`);
    assert.ok(r.pinned.includes(n1), 'the job carrying a pinned conversation is pinned');
    assert.ok(!r.pinned.includes(n2), 'the job carrying an unpinned one is not');
    assert.ok(r.file.pinned.includes(n1));
    assert.ok(r.file.unpinned.includes(n2));      // recorded, so the job's new transcript (created now) does not pin it
  });

  // ── where the file lives ────────────────────────────────────────────────────────────────────────────────────
  await test('AB_READONLY: the file goes to the temp folder; the real one is read as the starting point, never written', () => {
    const home = tmp('ab-pins-'), t = tmp('ab-pins-tmp-');
    const real = Object.assign(Pins.fresh(12345), { initialized: true, pinned: ['keep'] });
    writePins(home, real);
    const r = inStore(home, `const before = Pins.load().data; st.setPinned('xyz', true); console.log(JSON.stringify({ path: Pins.filePath(), before }))`,
      { AB_READONLY: '1', TMPDIR: t });
    assert.ok(r.path.startsWith(fs.realpathSync(t)) || r.path.startsWith(t), r.path);
    assert.deepStrictEqual(r.before.pinned, ['keep']);
    assert.deepStrictEqual(readPins(home), real);                         // untouched
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(r.path, 'utf8')).pinned, ['keep', 'xyz']);
  });
  await test('AB_ONLY: the file goes to the sandbox data folder', () => {
    const home = tmp('ab-pins-'), data = tmp('ab-pins-only-');
    const r = inStore(home, `st.refresh(); console.log(JSON.stringify(Pins.filePath()))`, { AB_ONLY: 'abtest', AB_ONLY_DATA: data });
    assert.strictEqual(r, path.join(data, 'pinned.json'));
    assert.ok(fs.existsSync(path.join(data, 'pinned.json')));
    assert.ok(!fs.existsSync(path.join(home, '.agent-boost', 'pinned.json')));
  });

  // ── parse order ─────────────────────────────────────────────────────────────────────────────────────────────
  await test('background parse order: focused at once, then pinned live > pinned ended > the rest; a queued file moves up', () => {
    const { TranscriptReader, PRIO, Mode } = require('../main/transcript');
    const r = new TranscriptReader();
    const order = [];
    r.runWarm = (job) => order.push(job.p);
    r.running = 2;                                         // both workers busy: everything queues
    for (const [p, prio] of [['other1', PRIO.other], ['endedPinned', PRIO.pinnedEnded], ['livePinned', PRIO.pinnedLive], ['other2', PRIO.other], ['late', PRIO.other]]) {
      assert.strictEqual(r.needsWarm('/nonexistent/' + p, Mode.skip, null, prio), true);
    }
    r.needsWarm('/nonexistent/late', Mode.skip, null, PRIO.pinnedLive);   // pinned while waiting
    r.running = 0; r.pump();
    assert.deepStrictEqual(order.map((p) => path.basename(p)), ['livePinned', 'late', 'endedPinned', 'other1', 'other2']);
    const r2 = new TranscriptReader(); const imm = []; r2.runWarm = (job, immediate) => imm.push(immediate);
    r2.needsWarm('/nonexistent/focused', Mode.full, null, PRIO.focused);
    assert.deepStrictEqual(imm, [true]);
  });
  await test('a file with nothing read yet is unknown (the list shows "…"); a previous run\'s numbers count as known', () => {
    const { TranscriptReader } = require('../main/transcript');
    const r = new TranscriptReader();
    r.metaLoaded = true; r.meta = { '/x/seen.jsonl': { out: 5 } };
    assert.strictEqual(r.known('/x/new.jsonl'), false);
    assert.strictEqual(r.known('/x/seen.jsonl'), true);
  });
  await test('store: an unread transcript\'s card says tokensUnread until it is parsed', () => {
    const home = tmp('ab-pins-');
    writeTranscript(home, { created: Date.now() - DAY, outPerTurn: 1000, turns: 3 });
    const r = inStore(home, `st.refresh(); const a = st.getState().loose[0];
      const first = { unread: a.tokensUnread, out: a.tokens.output };
      for (let i = 0; i < 50 && st.getState().loose[0].tokensUnread; i++) { await new Promise((r) => setTimeout(r, 50)); st.refresh(); }
      const b = st.getState().loose[0]; console.log(JSON.stringify({ first, unread: b.tokensUnread, out: b.tokens.output }))`);
    assert.deepStrictEqual(r.first, { unread: true, out: 0 });
    assert.deepStrictEqual([r.unread, r.out], [false, 3000]);
  });

  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
})();
