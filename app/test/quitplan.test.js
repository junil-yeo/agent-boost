// Which quit confirmation a team member gets (renderer/logic/quitplan.mjs) and the in-process flag on app launches.
// Run: node test/quitplan.test.js
process.env.AB_READONLY = '1';
const assert = require('assert');

let failed = 0;
const test = async (name, f) => { try { await f(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e.stack || e).toString().split('\n').slice(0, 5).join('\n     ')); } };

(async () => {
  const Q = await import('../renderer/logic/quitplan.mjs');
  const { L } = require('../main/l10n');
  Q.setL(L);
  const lead = { sessionId: 'L', name: 'lead', isLead: true, teamName: 't', state: 'idle', tmuxPane: '%1', pid: 1 };
  const mateIn = { sessionId: 't/a', name: 'a', teamName: 't', state: 'idle', inProcess: true, leadSid: 'L', tmuxPane: null };
  const mateTmux = { sessionId: 't/b', name: 'b', teamName: 't', state: 'busy', tmuxPane: '%2', pid: 2 };
  const snap = (members) => ({ teams: [{ name: 't', members }] });
  const values = (p) => p.buttons.filter((b) => b.value).map((b) => b.value);

  await test('in-process teammate, live lead: light confirmation, stop only', () => {
    const p = Q.quitPlan(mateIn, snap([lead, mateIn]));
    assert.strictEqual(p.kind, 'light');
    assert.deepStrictEqual(values(p), ['stop']);
    assert.strictEqual(p.message, L('팀장이 다시 메시지를 보내면 대화를 이어서 돌아옵니다.'));
  });
  await test('tmux teammate, live lead: heavy, report first or just stop', () => {
    const p = Q.quitPlan(mateTmux, snap([lead, mateTmux]));
    assert.strictEqual(p.kind, 'heavy');
    assert.deepStrictEqual(values(p), ['report', 'stop']);
  });
  await test('tmux teammate, lead ended: heavy, report goes to the teammate itself', () => {
    const p = Q.quitPlan(mateTmux, snap([{ ...lead, state: 'ended', tmuxPane: null, pid: null }, mateTmux]));
    assert.strictEqual(p.kind, 'heavy');
    assert.deepStrictEqual(values(p), ['report', 'stop']);
  });
  await test('in-process teammate whose lead has no pane: heavy without report (nobody to type it to)', () => {
    const p = Q.quitPlan(mateIn, snap([{ ...lead, tmuxPane: null }, mateIn]));
    assert.strictEqual(p.kind, 'heavy');
    assert.deepStrictEqual(values(p), ['stop']);
  });
  await test('lead with live teammates: says how many vanish; report / now', () => {
    const p = Q.quitPlan(lead, snap([lead, mateIn, mateTmux, { ...mateTmux, sessionId: 't/c', state: 'ended' }]));
    assert.strictEqual(p.kind, 'lead');
    assert.strictEqual(p.message, L('팀장을 종료하면 팀원 %@명도 함께 종료되며, 다시 시작해도 팀원은 돌아오지 않습니다.', '2'));
    assert.deepStrictEqual(values(p), ['report', 'now']);
  });
  await test('no team plan: lead alone, solo session, ended member, subagent', () => {
    assert.strictEqual(Q.quitPlan(lead, snap([lead])), null);
    assert.strictEqual(Q.quitPlan({ ...lead, solo: true }, snap([lead, mateIn])), null);
    assert.strictEqual(Q.quitPlan({ ...mateTmux, state: 'ended' }, snap([lead, mateTmux])), null);
    assert.strictEqual(Q.quitPlan({ sessionId: 'x', name: 'x', state: 'idle', teamName: null }, snap([])), null);
    assert.strictEqual(Q.quitPlan({ ...mateTmux, isSubagent: true }, snap([lead])), null);
  });
  await test('launches get teammateMode in-process for that session only (not attach, not twice)', () => {
    const store = require('../main/store');
    const Shell = require('../main/shell');
    const a = store.withInProcessTeams([Shell.claude, '-n', 'x', '--model', 'm']);
    assert.deepStrictEqual(a.slice(0, 3), [Shell.claude, '--settings', '{"teammateMode":"in-process"}']);
    assert.deepStrictEqual(store.withInProcessTeams([Shell.claude, 'attach', 'abc']), [Shell.claude, 'attach', 'abc']);
    assert.deepStrictEqual(store.withInProcessTeams(a), a);
  });

  console.log(failed ? `${failed} failed` : 'all ok');
  process.exit(failed ? 1 : 0);
})();
