// Smoke test of main/store.js against the real ~/.claude data, read-only: starts the store, waits for a few refreshes
// and the usage probe, and prints teams / individual sessions / meters (compare with what the macOS app shows).
// Run: AB_READONLY=1 node test/store-smoke.js        (AB_READONLY is forced on here anyway)
process.env.AB_READONLY = '1';
const store = require('../main/store');

let pushes = 0, last = null;
store.setSink((channel, payload) => { if (channel === 'state') { pushes++; last = payload; } });
store.start();

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtAgent = (a) => {
  const bits = [a.state, a.tmuxPane ? `pane ${a.tmuxPane}` : 'no pane', a.displayModel];
  if (a.effort) bits.push(a.effort);
  if (a.isBackgroundJob) bits.push(`job ${a.jobId}`);
  if (a.overlay) bits.push(`overlay ${a.overlay}`);
  if (a.screen && a.screen.verb) bits.push(`"${a.screen.verb}"`);
  bits.push(`tokens ${a.tokens.input + a.tokens.cacheWrite + a.tokens.cacheRead + a.tokens.output}`);
  return `${a.isLead ? '★ ' : '  '}${a.name}  [${bits.join(' · ')}]  ${a.sessionId.slice(0, 13)}`;
};

(async () => {
  const t0 = Date.now();
  await wait(7000);                                              // first scan + a few 2 s ticks
  for (let i = 0; i < 60 && !(last && (last.meters.length || last.usageError)); i++) await wait(1000);   // the usage probe
  const s = store.getState();
  console.log(`after ${((Date.now() - t0) / 1000).toFixed(1)} s · ${pushes} state pushes · firstScanDone=${s.firstScanDone} readonly=${s.readonly}`);
  console.log(`\nTEAMS (${s.teams.length})`);
  for (const t of s.teams) {
    console.log(`■ ${t.displayName}  (${t.name}) live ${t.liveCount}/${t.members.length}`);
    for (const m of t.members) console.log('   ' + fmtAgent(m));
  }
  const live = s.loose.filter((a) => a.state !== 'ended'), ended = s.loose.filter((a) => a.state === 'ended');
  console.log(`\nINDIVIDUAL SESSIONS — live ${live.length}`);
  for (const a of live) console.log(fmtAgent(a));
  console.log(`\nENDED (${ended.length}), newest 10:`);
  for (const a of [...ended].sort((x, y) => (y.lastActivity || 0) - (x.lastActivity || 0)).slice(0, 10)) console.log(fmtAgent(a));
  console.log(`\nMETERS${s.usageError ? ' — error: ' + s.usageError : ''}`);
  for (const m of s.meters) console.log(`  ${m.label}: ${m.percent}%  resets ${m.resets}  (${m.remainingText}; elapsed ${m.elapsed == null ? '-' : m.elapsed.toFixed(2)}, projected ${m.projected ?? '-'})`);
  console.log(`\narchive ${Object.keys(s.archive).length} · launches ${s.launches.length} · notice: ${s.notice ?? '-'}`);
  if (s.selectedAgent) { const c = store.getChat(s.selectedAgent); console.log(`chat(${s.selectedAgent.slice(0, 8)}): ${c.entries.length} entries`); }
  process.exit(0);
})();
