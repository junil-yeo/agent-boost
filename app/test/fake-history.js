// Writes a synthetic Claude Code history into a throwaway home (for BOARD_HOME runs): ~/.claude/projects/<proj>/<sid>.jsonl
// transcripts with user / assistant records the way the CLI writes them. Used by the pin tests and, from the command line,
// to check the session list with a long history:
//   node test/fake-history.js <home> [count=400] [turns=20]
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const iso = (ms) => new Date(ms).toISOString();
/** One transcript. opts: {sid, cwd, created (ms), turns, model, branch, title, prompt, outPerTurn} → its path. */
function writeTranscript(home, opts) {
  const sid = opts.sid || crypto.randomUUID();
  const cwd = opts.cwd || '/tmp/fake-project';
  const dir = path.join(home, '.claude', 'projects', cwd.replace(/[/.]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const lines = [];
  if (opts.title) lines.push({ type: 'custom-title', customTitle: opts.title, sessionId: sid });
  let t = opts.created ?? Date.now() - 86400000, parent = null;
  const turns = opts.turns ?? 4;
  for (let i = 0; i < turns; i++) {
    const u = crypto.randomUUID(), a = crypto.randomUUID();
    lines.push({ parentUuid: parent, isSidechain: false, type: 'user', message: { role: 'user', content: i === 0 ? (opts.prompt || `Task ${sid.slice(0, 4)}: please look at the build`) : `follow-up ${i}` },
      uuid: u, timestamp: iso(t), cwd, gitBranch: opts.branch || 'main', sessionId: sid, version: '2.1.304' });
    t += 15000;
    lines.push({ parentUuid: u, isSidechain: false, type: 'assistant', message: { model: opts.model || 'claude-opus-5-5', id: 'msg_' + a.slice(0, 12), type: 'message', role: 'assistant',
      content: [{ type: 'text', text: `Answer ${i}: done.` }], stop_reason: 'end_turn',
      usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: opts.outPerTurn ?? 250 } },
      uuid: a, timestamp: iso(t), cwd, gitBranch: opts.branch || 'main', sessionId: sid });
    parent = a; t += 30000;
  }
  const p = path.join(dir, sid + '.jsonl');
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const mt = new Date(t); fs.utimesSync(p, mt, mt);
  return p;
}
/** `count` transcripts spread over 8 project folders and the last ~200 days. */
function makeHistory(home, count = 400, turns = 20) {
  const out = [];
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    out.push(writeTranscript(home, { cwd: `/tmp/fake-proj-${i % 8}`, created: now - (count - i) * 12 * 3600 * 1000, turns, branch: i % 3 ? 'main' : `feat-${i}`,
      title: i % 5 === 0 ? `Titled session ${i}` : null, prompt: `Session ${i}: refactor module ${i % 17}` }));
  }
  return out;
}
module.exports = { writeTranscript, makeHistory };

if (require.main === module) {
  const home = process.argv[2];
  if (!home) { console.error('usage: node test/fake-history.js <home> [count] [turns]'); process.exit(2); }
  const n = Number(process.argv[3] || 400), turns = Number(process.argv[4] || 20);
  makeHistory(home, n, turns);
  console.log(`wrote ${n} transcripts under ${home}/.claude/projects`);
}
