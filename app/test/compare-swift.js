// Cross-check against the Swift implementation (development tool, not part of `npm test`):
//   SWIFT_HARNESS=/path/to/harness node test/compare-swift.js [files…]
// The harness is TranscriptReader.swift + ConvoIndex (from ConvoSearch.swift) compiled with small stubs; it prints the
// same data as JSON. Files still being written are skipped when their size changed between the two reads.
process.env.AB_READONLY = '1';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const T = require('../main/transcript');
const { ConvoIndex } = require('../main/search');
const { L } = require('../main/l10n');

const H = process.env.SWIFT_HARNESS;
if (!H) { console.log('SWIFT_HARNESS not set: skipped'); process.exit(0); }
const swift = (...a) => JSON.parse(execFileSync(H, a, { maxBuffer: 1 << 30 }).toString());
const root = path.join(os.homedir(), '.claude', 'projects');
const files = process.argv.slice(2).length ? process.argv.slice(2)
  : fs.readdirSync(root).flatMap((d) => { try { return fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(root, d, f)); } catch { return []; } });

let bad = 0;
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const eq = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
function cmpEntries(name, s, j) {
  if (s.length !== j.length) { console.log(`  ${name}: entry count swift ${s.length} js ${j.length}`); bad++; }
  const n = Math.min(s.length, j.length);
  let shown = 0;
  for (let i = 0; i < n; i++) {
    const a = { ...s[i] }, b = { ...j[i] };
    // the harness's L() returns the Korean key; this side translates into the chosen language
    if (a.toolName === 'auto') a.text = L(a.text);
    if (a.role === 'peer') a.text = a.text.replace('⏸ 대기 중', L('⏸ 대기 중'));
    if (a.id !== b.id && /^[0-9A-F-]{36}/.test(a.id) && /^[0-9A-F-]{36}/.test(b.id)) { delete a.id; delete b.id; }   // random ids (records without uuid)
    if (!eq(a, b)) { bad++; if (shown++ < 3) console.log(`  ${name} #${i}\n   swift ${JSON.stringify(a).slice(0, 300)}\n   js    ${JSON.stringify(b).slice(0, 300)}`); }
  }
}
for (const f of files) {
  const size0 = fs.statSync(f).size;
  const out = {};
  for (const mode of ['full', 'light', 'skip']) {
    const s = swift(mode, f);
    const r = new T.TranscriptReader();
    r.metaPath = path.join(os.tmpdir(), 'ab-meta-test.json');
    const j = r.snapshot(f, mode);
    out[mode] = [s, j];
  }
  const sa = swift('answers', f, '5'), ja = T.recentAnswers(f, 5);
  if (fs.statSync(f).size !== size0) { console.log(`~ ${path.basename(f)}: written meanwhile, skipped`); continue; }
  console.log(`${path.basename(f)} (${(size0 / 1e6).toFixed(1)} MB)`);
  const bad0 = bad;
  for (const mode of ['full', 'light', 'skip']) {
    const [s, j] = out[mode];
    for (const k of ['model', 'effort', 'last', 'customTitle', 'aiTitle', 'firstPrompt', 'lastTurnEnded', 'lastContext', 'offset', 'truncated']) {
      if (!eq(s[k], j[k])) { bad++; console.log(`  ${mode}.${k}: swift ${JSON.stringify(s[k])} js ${JSON.stringify(j[k])}`); }
    }
    const jt = [j.tokens.input, j.tokens.cacheWrite, j.tokens.cacheRead, j.tokens.output];
    if (!eq(s.tokens, jt)) { bad++; console.log(`  ${mode}.tokens: swift ${s.tokens} js ${jt}`); }
    cmpEntries(mode + '.entries', s.entries, j.entries);
  }
  if (!eq(sa, ja)) { bad++; console.log(`  recentAnswers differ: swift ${sa.length} js ${ja.length}`); sa.forEach((x, i) => { if (!eq(x, ja[i])) console.log(`   #${i} swift ${JSON.stringify(x).slice(0, 200)}\n      js    ${JSON.stringify(ja[i] || null).slice(0, 200)}`); }); }
  else if (bad === bad0) console.log(`  ok: snapshots (full/light/skip) and recentAnswers(5) identical; ${out.full[1].entries.length} entries`);
}
// search
const qs = ['tmux', 'session send', '에이전트', 'error fix', 'the', '검색'];
const t0 = Date.now();
const sres = swift('search', ...qs);
const ix = new ConvoIndex(root);
const t1 = Date.now(); ix.refreshSync(); const built = Date.now() - t1;
console.log(`search: js index built in ${built} ms (${ix.files.size} files)`);
for (const r of sres) {
  const j = ix.search(r.q).map((h) => ({ id: h.id, title: h.title, user: h.user, time: h.time, text: h.text }));
  const s = r.hits.map((h) => ({ id: h.id, title: h.title, user: h.user, time: h.time, text: h.text }));
  // the order of hits with equal times may differ (Swift's sort is not stable): compare as sets plus time order
  const key = (x) => x.id + '|' + x.text.length;
  const ss = new Set(s.map(key)), js = new Set(j.map(key));
  const same = s.length === j.length && [...ss].every((k) => js.has(k)) && eq(s.map((x) => x.time), j.map((x) => x.time));
  if (!same) { bad++; console.log(`  "${r.q}": swift ${s.length} hits, js ${j.length} hits (files may have grown in between)`); }
  else console.log(`  "${r.q}": ${s.length} hits identical`);
}
console.log(bad ? `${bad} differences` : 'all identical');
