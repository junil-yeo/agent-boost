// Perf driver: loaded by main/main.js when AB_PERF is set (always together with AB_READONLY; test/perf/perf.js starts
// it). It installs page probes (page.js) before the app's scripts run, waits for the board, runs the named scenarios
// and writes one JSON result to AB_PERF_OUT (or stdout), then quits the app.
//
// Scenarios (AB_PERF=a,b,…): startup, typing, switch, screen, idle, soak, inventory. Options through env:
//   AB_PERF_MINUTES (idle: 5, soak: 60), AB_PERF_TERMCHAT (typing: 1 = live CLI screen, 0 = rebuilt chat),
//   AB_PERF_PANE (screen: the %N of an abtest-* pane whose content changes), AB_PERF_SWIFT_PID (ps comparison).
//
// Read-only by construction: it clicks tabs and rows, types into the composer (never Enter), scrolls; every store
// action stays refused by AB_READONLY. Monkey-patches below only wrap functions to time them.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const v8 = require('v8');
const vm = require('vm');
const { execFileSync } = require('child_process');
const inspector = require('inspector');

const appDir = path.join(__dirname, '..', '..');
const scenarios = (process.env.AB_PERF || '').split(',').map((s) => s.trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procStart = Date.now() - process.uptime() * 1000;
v8.setFlagsFromString('--expose_gc');
const mainGC = vm.runInNewContext('gc');

let win = null, modules = null, dbg = null, mainSend = null;
const result = { scenarios, startedAt: new Date().toISOString(), loadavgAtStart: require('os').loadavg().map((x) => +x.toFixed(1)), marks: { procStart } };

// ── main-side probes ──────────────────────────────────────────────────────────────────────────────────────────────
const probe = {
  pushes: [], sizes: false, mainErrors: 0, mainErrorSamples: [],
  updates: [], spawns: 0, spawnByCmd: {}, captures: [],
};
function installMainProbes() {
  // state pushes: when (and, while `sizes` is on, how big) — the store's sink replaces its emit; forward to the window
  mainSend = require(path.join(appDir, 'main', 'main.js')).send;
  modules.store.setSink((ch, p) => {
    if (ch === 'state') {
      const rec = { t: Date.now() };
      if (probe.sizes) rec.bytes = Buffer.byteLength(JSON.stringify(p));
      if (!result.marks.firstPush) result.marks.firstPush = rec.t;
      if (!result.marks.firstScanPush && p && p.firstScanDone) result.marks.firstScanPush = rec.t;
      probe.pushes.push(rec);
      if (probe.pushes.length > 20000) probe.pushes.splice(0, 5000);
    }
    mainSend(ch, p);
  });
  // TmuxCache.update: wall time of the tmux part of each 2 s refresh
  const tmux = require(path.join(appDir, 'main', 'tmux.js'));
  const upd = tmux.cache.update;
  tmux.cache.update = async function () {
    const t0 = performance.now();
    try { return await upd.apply(this, arguments); } finally { probe.updates.push({ t: Date.now(), ms: performance.now() - t0 }); if (probe.updates.length > 20000) probe.updates.splice(0, 5000); }
  };
  // every child process (tmux, ps, …) the main process starts through shell.js
  const shell = require(path.join(appDir, 'main', 'shell.js'));
  for (const fn of ['run', 'tmux']) {
    const orig = shell[fn];
    if (typeof orig !== 'function') continue;
    shell[fn] = function (a) {
      probe.spawns++;
      const k = fn === 'tmux' ? 'tmux ' + (Array.isArray(a) ? a[0] : '') : String(Array.isArray(a) ? path.basename(String(a[0])) : a);
      probe.spawnByCmd[k] = (probe.spawnByCmd[k] || 0) + 1;
      return orig.apply(this, arguments);
    };
  }
  // the live CLI screen's one tmux call per second (registered module object: main.js looks the function up per call)
  const cap = modules.panes.capture;
  modules.panes.capture = async function (pane) {
    const t0 = performance.now();
    const r = await cap.apply(this, arguments);
    probe.captures.push({ t: Date.now(), ms: performance.now() - t0, bytes: r && r.screen ? r.screen.length : 0 });
    if (probe.captures.length > 20000) probe.captures.splice(0, 5000);
    return r;
  };
  const ce = console.error;
  console.error = function (...a) { probe.mainErrors++; if (probe.mainErrorSamples.length < 30) probe.mainErrorSamples.push(a.map(String).join(' ').slice(0, 300)); return ce.apply(console, a); };
}

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────
const page = (js) => win.webContents.executeJavaScript(js, true);
const cdp = (m, p) => dbg.sendCommand(m, p || {});
const stats = (xs) => {
  const a = xs.filter((x) => Number.isFinite(x)).sort((p, q) => p - q);
  if (!a.length) return { n: 0 };
  const q = (f) => a[Math.min(a.length - 1, Math.floor(f * (a.length - 1) + 0.5))];
  return { n: a.length, median: +q(0.5).toFixed(2), p90: +q(0.9).toFixed(2), p99: +q(0.99).toFixed(2), max: +a[a.length - 1].toFixed(2), mean: +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(2) };
};
async function perfMetrics() {
  const r = await cdp('Performance.getMetrics');
  const o = {}; for (const m of r.metrics) o[m.name] = m.value; return o;
}
function metricDelta(a, b, keys) { const o = {}; for (const k of keys) o[k] = +(b[k] - a[k]).toFixed(4); return o; }
/** Every Electron process: pid, type, CPU % since the last call, working set (KB). */
function appMetrics() { return app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, cpu: m.cpu.percentCPUUsage, ws: m.memory.workingSetSize, priv: m.memory.privateBytes })); }
/** ps: rss (KB) and cumulative CPU seconds per pid. */
function ps(pids) {
  pids = pids.filter(Boolean);
  if (!pids.length) return {};
  let out = '';
  try { out = execFileSync('/bin/ps', ['-o', 'pid=,rss=,time=', '-p', pids.join(',')], { encoding: 'utf8' }); } catch (e) { out = e.stdout || ''; }
  const r = {};
  for (const l of out.trim().split('\n')) {
    const f = l.trim().split(/\s+/); if (f.length < 3) continue;
    const parts = f[2].split(':').map(Number);
    const secs = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
    r[f[0]] = { rss: Number(f[1]), cpuSec: secs };
  }
  return r;
}
function swiftPid() {
  if (process.env.AB_PERF_SWIFT_PID) return Number(process.env.AB_PERF_SWIFT_PID);
  try { return Number(execFileSync('/usr/bin/pgrep', ['-f', 'AgentBoost.app/Contents/MacOS/AgentBoost'], { encoding: 'utf8' }).trim().split('\n')[0]) || null; } catch { return null; }
}
async function waitFor(js, ms = 30000, step = 100) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await page(js)) return true; } catch { } await sleep(step); }
  return false;
}
/** Main-process CPU profile over fn(); → the profile. */
async function profileMain(fn, interval = 250) {
  const s = new inspector.Session(); s.connect();
  const post = (m, p) => new Promise((res, rej) => s.post(m, p || {}, (e, r) => (e ? rej(e) : res(r))));
  await post('Profiler.enable'); await post('Profiler.setSamplingInterval', { interval }); await post('Profiler.start');
  try { await fn(); } finally { /* stop below */ }
  const { profile } = await post('Profiler.stop');
  s.disconnect();
  return profile;
}
/** Per-invocation durations (ms) of the functions matching `match(callFrame)` (consecutive samples with one on the stack). */
function invocations(profile, match) {
  const parent = new Map(), byId = new Map();
  for (const n of profile.nodes) { byId.set(n.id, n); for (const c of n.children || []) parent.set(c, n.id); }
  const memo = new Map();
  const inside = (id) => {
    if (memo.has(id)) return memo.get(id);
    let r = false;
    for (let x = id; x != null; x = parent.get(x)) { if (match(byId.get(x).callFrame)) { r = true; break; } }
    memo.set(id, r); return r;
  };
  const out = []; let t = profile.startTime, cur = null;
  for (let i = 0; i < profile.samples.length; i++) {
    t += profile.timeDeltas[i];
    if (inside(profile.samples[i])) { if (!cur) cur = { a: t, b: t }; else cur.b = t; }
    else if (cur) { out.push((cur.b - cur.a) / 1000 + (profile.timeDeltas[i] || 250) / 1000); cur = null; }
  }
  if (cur) out.push((cur.b - cur.a) / 1000);
  return out;
}
/** Self time per function (top n), ms. */
function topSelf(profile, n = 15) {
  const self = new Map(), byId = new Map();
  for (const nd of profile.nodes) byId.set(nd.id, nd);
  for (let i = 0; i < profile.samples.length; i++) {
    const nd = byId.get(profile.samples[i]); const cf = nd.callFrame;
    const k = `${cf.functionName || '(anon)'} ${path.basename(cf.url || '')}:${cf.lineNumber + 1}`;
    self.set(k, (self.get(k) || 0) + (profile.timeDeltas[i] || 0) / 1000);
  }
  return [...self.entries()].filter(([k]) => !/^\(idle\)|^\(program\)|^\(garbage/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => [k, +v.toFixed(1)]);
}
/** Inclusive time per function (top n), ms: every sample counts once for each distinct function on its stack. */
function topTotal(profile, n = 25) {
  const parent = new Map(), byId = new Map();
  for (const nd of profile.nodes) { byId.set(nd.id, nd); for (const c of nd.children || []) parent.set(c, nd.id); }
  const tot = new Map();
  for (let i = 0; i < profile.samples.length; i++) {
    const seen = new Set();
    for (let x = profile.samples[i]; x != null; x = parent.get(x)) {
      const cf = byId.get(x).callFrame;
      if (!cf.url && !cf.functionName) continue;
      const k = `${cf.functionName || '(anon)'} ${path.basename(cf.url || '')}:${cf.lineNumber + 1}`;
      if (seen.has(k)) continue; seen.add(k);
      tot.set(k, (tot.get(k) || 0) + (profile.timeDeltas[i] || 0) / 1000);
    }
  }
  return [...tot.entries()].filter(([k]) => !/^\((idle|program|root|garbage)/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => [k, +v.toFixed(1)]);
}
/** Renderer CPU profile over fn() (AB_PERF_RPROF=1); with AB_PERF_TRACE=<file> a Chromium trace of fn() is saved
 *  instead (open it in chrome://tracing or DevTools, or summarise it with trace-tasks.js); else just fn(). */
async function profileRenderer(fn) {
  if (process.env.AB_PERF_TRACE) {
    const events = [];
    let done;
    const complete = new Promise((r) => { done = r; });
    const onMsg = (_e, method, params) => {
      if (method === 'Tracing.dataCollected') events.push(...params.value);
      else if (method === 'Tracing.tracingComplete') done();
    };
    dbg.on('message', onMsg);
    await cdp('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: ['toplevel', 'devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8.execute', 'blink', 'blink.user_timing', 'disabled-by-default-devtools.timeline.frame'] } });
    await fn();
    await cdp('Tracing.end');
    await complete;
    dbg.removeListener('message', onMsg);
    fs.writeFileSync(process.env.AB_PERF_TRACE, JSON.stringify({ traceEvents: events }));
    return { trace: process.env.AB_PERF_TRACE, events: events.length };
  }
  if (!process.env.AB_PERF_RPROF) { await fn(); return null; }
  await cdp('Profiler.enable'); await cdp('Profiler.setSamplingInterval', { interval: 200 }); await cdp('Profiler.start');
  await fn();
  const { profile } = await cdp('Profiler.stop');
  return { self: topSelf(profile, 25), total: topTotal(profile, 40) };
}
const isStoreFn = (name) => (cf) => cf.functionName === name && /main[\\/]store\.js$/.test(cf.url || '');

// ── page navigation (clicks the app's own buttons; times click → next paint → settled) ─────────────────────────
const PAGE_LIB = `
window.__perfLib = window.__perfLib || (async () => {
  const lib = await import('./lib.js');
  const P = window.__perf;
  P.L = lib.L;
  P.find = (sel, text) => [...document.querySelectorAll(sel)].find((e) => e.offsetParent !== null && (!text || e.textContent.trim().includes(text)));
  P.timeClick = async (el, quietMs = 300, capMs = 4000) => {
    if (!el) return null;
    const t0 = performance.now(), lt0 = P.longtasks.length, r0 = P.renders;
    let last = t0; const muts = [];
    // (the usage banner's gauges animate on their own: not part of the switch)
    const mo = new MutationObserver((all) => { const ms = all.filter((m) => !(m.target.closest ? m.target : m.target.parentElement).closest('.top-box')); if (!ms.length) return; last = performance.now(); if (muts.length < 40) muts.push(Math.round(last - t0) + ':' + ms.length + ':' + ((ms[0].target.className || ms[0].target.nodeName) + '').slice(0, 30)); });
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    el.click();
    const sync = performance.now() - t0;
    const paint = (await P.nextPaint()) - t0;
    while (performance.now() - last < quietMs && performance.now() - t0 < capMs) await new Promise((r) => setTimeout(r, 50));
    mo.disconnect();
    const lts = P.longtasks.slice(lt0);
    return { sync: +sync.toFixed(2), paint: +paint.toFixed(2), settled: +(last - t0).toFixed(1), renders: P.renders - r0,
      longtasks: lts.length, longest: lts.length ? Math.max(...lts.map((x) => x.dur)) : 0, nodes: document.getElementsByTagName('*').length, muts };
  };
  return true;
})();`;
async function ensureLib() { await page(PAGE_LIB); await page('window.__perfLib'); }
const J = JSON.stringify;
async function clickTab(title) { return page(`window.__perf.timeClick(window.__perf.find('.tab-row button', ${J(title)}))`); }
async function clickRow(name) { return page(`window.__perf.timeClick([...document.querySelectorAll('.tab-layer.current .member-row')].find((r) => r.querySelector('.member-name').textContent.trim() === ${J(name)}))`); }
async function Lp(k) { return page(`window.__perf.L(${J(k)})`); }

function state() { return modules.store.getState(); }
/** Every agent on the board except other test runs' sessions (abtest-*: another tool's throwaway sessions). */
function allAgents(s) { return [...(s.teams || []).flatMap((t) => t.members), ...(s.loose || [])].filter((a) => !/^abtest/.test(a.name || '')); }
const transcriptBytes = (a) => { try { return fs.statSync(a.transcriptPath).size; } catch { return 0; } };
async function waitBoard() {
  const ok = await waitFor(`!!document.querySelector('.org-scroll')`, 60000, 100);
  await ensureLib();
  return ok;
}
/** Opens the tab and row of a session: the team's tab (or the individual sessions tab) and its member row. */
async function openAgent(a) {
  const s = state();
  const t = (s.teams || []).find((x) => x.members.some((m) => m.sessionId === a.sessionId));
  const tab = t ? t.displayName : await Lp('개별 세션');
  const r1 = await clickTab(tab);
  await sleep(300);
  const r2 = await clickRow(a.name);
  return { tab, r1, r2 };
}

// ── scenarios ─────────────────────────────────────────────────────────────────────────────────────────────────────
const S = {};

S.inventory = async () => {
  const s = state();
  const ag = allAgents(s).map((a) => ({ name: a.name, sid: a.sessionId.slice(0, 8), team: a.teamName, solo: a.solo, state: a.state, pane: a.tmuxPane, input: a.canReceiveInput, chat: (modules.store.getChat(a.sessionId).entries || []).length }));
  return { teams: (s.teams || []).map((t) => ({ name: t.name, display: t.displayName, live: t.liveCount, members: t.members.length })), agents: ag, snapshotBytes: Buffer.byteLength(JSON.stringify(s)) };
};

S.startup = async () => {
  const ok = await waitBoard();
  const pm = await page(`(() => { const P = window.__perf; const paint = {}; for (const e of performance.getEntriesByType('paint')) paint[e.name] = performance.timeOrigin + e.startTime;
    const nav = performance.getEntriesByType('navigation')[0];
    return { timeOrigin: performance.timeOrigin, paint, marks: P.marks, domInteractive: nav ? performance.timeOrigin + nav.domInteractive : null, longtasks: P.longtasks.length, longest: Math.max(0, ...P.longtasks.map((x) => x.dur)) }; })()`);
  const m = result.marks;
  const rel = (t) => (t ? Math.round(t - m.procStart) : null);
  return {
    boardShown: ok,
    ms_from_main_start: {
      windowLoad: rel(m.loadAt), domContentLoaded: rel(pm.marks.dcl), firstPaint: rel(pm.paint['first-paint']), firstContentfulPaint: rel(pm.paint['first-contentful-paint']),
      firstStatePush: rel(m.firstPush), firstScanDonePush: rel(m.firstScanPush), firstScanDoneInPage: rel(pm.marks.firstScanDone), usableBoard: rel(pm.marks.board),
    },
    launcherSpawnToMainStart: process.env.AB_PERF_SPAWNED ? Math.round(m.procStart - Number(process.env.AB_PERF_SPAWNED)) : null,
    startupLongTasks: pm.longtasks, startupLongestTask: Math.round(pm.longest),
  };
};

/** Keystrokes: ASCII through the input pipeline (keyDown/char/keyUp), Korean through CDP's IME composition. */
function keyPlan(n) {
  // deterministic: an English sentence, a Korean sentence (each syllable typed as its jamo steps), some backspaces
  const en = 'please check the failing tests in the store module and report back with a summary ';
  const ko = [['ㅇ', '아', '안'], ['ㄴ', '녀', '녕'], ['ㅎ', '하'], ['ㅅ', '세'], ['ㅇ', '요'], [' '], ['ㅌ', '테'], ['ㅅ', '스'], ['ㅌ', '트'], ['ㄹ', '르'], ['ㄹ', '를'], [' '], ['ㄷ', '다'], ['ㅅ', '시'], [' '], ['ㄷ', '돌'], ['ㄹ', '려'], [' '], ['ㅈ', '주'], ['ㅅ', '세'], ['ㅇ', '요'], [' ']];
  const plan = []; let i = 0, k = 0;
  while (plan.length < n) {
    const block = plan.length % 100;
    if (block < 60) { plan.push({ ch: en[i++ % en.length] }); }
    else if (block < 92) { const syl = ko[k++ % ko.length]; if (syl[0] === ' ') plan.push({ ch: ' ' }); else syl.forEach((c, j) => plan.push({ ime: c, commit: j === syl.length - 1 ? syl[syl.length - 1] : null })); }
    else plan.push({ key: 'Backspace' });
  }
  return plan.slice(0, n);
}
async function typeKeys(plan) {
  let composing = false;
  for (const p of plan) {
    if (p.ch != null) {
      if (composing) { composing = false; }
      const kc = p.ch === ' ' ? 'Space' : p.ch;
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: kc });
      win.webContents.sendInputEvent({ type: 'char', keyCode: p.ch });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: kc });
    } else if (p.key) {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: p.key });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: p.key });
    } else if (p.ime) {
      await cdp('Input.imeSetComposition', { text: p.ime, selectionStart: p.ime.length, selectionEnd: p.ime.length });
      composing = true;
      if (p.commit) { await sleep(25); await cdp('Input.insertText', { text: p.commit }); composing = false; }
    }
    await sleep(45 + Math.round(40 * Math.abs(Math.sin(plan.indexOf(p) * 12.9898))));   // 45–85 ms between keys
  }
}

S.typing = async () => {
  await waitBoard();
  const termChat = process.env.AB_PERF_TERMCHAT !== '0';
  await page(`localStorage.setItem('ui.termChat', ${J(String(termChat))}); window.dispatchEvent(new CustomEvent('ab-appstorage', { detail: { key: 'ui.termChat', value: ${termChat} } })); true`);
  const s = state();
  const cands = allAgents(s).filter((a) => a.canReceiveInput && a.tmuxPane && !a.isSubagent)
    .map((a) => ({ a, n: transcriptBytes(a) }));
  // the longest conversation (the chat is loaded on demand, so its transcript's size decides)
  cands.sort((x, y) => y.n - x.n);
  const target = cands[0] && cands[0].a;
  if (!target) return { error: 'no live session that takes input' };
  const nav = await openAgent(target);
  await sleep(2500);                                  // its chat / screen loaded
  const chatLen = (modules.store.getChat(target.sessionId).entries || []).length;
  const focused = await page(`(() => { const t = document.querySelector('.tab-layer.current .composer-bar textarea'); if (!t) return false; t.focus(); return document.activeElement === t; })()`);
  win.webContents.focus();
  const before = await page(`(() => ({ nodes: document.getElementsByTagName('*').length, lt: window.__perf.longtasks.length, ev: window.__perf.events.length }))()`);
  await page(`window.__perf.keys = []; window.__perf.measureKeys = true; true`);
  const plan = keyPlan(300);
  const m0 = await perfMetrics(); const t0 = Date.now();
  const rprof = await profileRenderer(async () => { await typeKeys(plan); await sleep(500); });
  const m1 = await perfMetrics(); const wall = Date.now() - t0;
  const r = await page(`(() => { const P = window.__perf; P.measureKeys = false; const t = document.querySelector('.tab-layer.current .composer-bar textarea');
    const near = (arr, at) => arr.filter((x) => x >= at - 60 && x <= at + 40).length;
    const slow = P.keys.filter((k) => k.lat > 16).map((k) => ({ lat: +k.lat.toFixed(1), type: k.type, push: near(P.pushes.map((p) => p.t), k.at), screen: near(P.screenApplies, k.at),
      longtask: P.longtasks.filter((l) => l.start <= k.at + k.lat && l.start + l.dur >= k.at - 50).map((l) => Math.round(l.dur)) }));
    return { slow, keys: P.keys, value: t ? t.value : null, lts: P.longtasks.slice(${before.lt}), evs: P.events.slice(${before.ev}).filter((e) => /key|input|composition/.test(e.name)) }; })()`);
  // leave the box as it was (the draft is the store's memory only; it never reaches the session)
  await page(`(() => { const t = document.querySelector('.tab-layer.current .composer-bar textarea'); if (t) { t.select(); document.execCommand('delete'); } return true; })()`);
  const lat = r.keys.map((k) => k.lat);
  const d = metricDelta(m0, m1, ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'LayoutCount', 'RecalcStyleCount']);
  return {
    termChat, target: { name: target.name, chatEntries: chatLen, pane: target.tmuxPane }, navigation: nav, focused, domNodes: before.nodes,
    keystrokes: plan.length, measured: r.keys.length, typedChars: r.value ? [...r.value].length : null, typedTail: r.value ? r.value.slice(-40) : null,
    inputToNextPaint: stats(lat), handlerToPaint: stats(r.keys.map((k) => k.handlerToPaint)),
    byKind: { ascii: stats(r.keys.filter((k) => k.type === 'keydown').map((k) => k.lat)), ime: stats(r.keys.filter((k) => k.type !== 'keydown').map((k) => k.lat)) },
    over16ms: lat.filter((x) => x > 16).length, slowKeys: r.slow, over33ms: lat.filter((x) => x > 33).length,
    longtasks: { n: r.lts.length, max: Math.max(0, ...r.lts.map((x) => x.dur)), total: Math.round(r.lts.reduce((s2, x) => s2 + x.dur, 0)) },
    eventTimingOver16: { n: r.evs.length, max: Math.max(0, ...r.evs.map((e) => e.dur)) },
    rendererPerKey_ms: { task: +(d.TaskDuration * 1000 / plan.length).toFixed(2), script: +(d.ScriptDuration * 1000 / plan.length).toFixed(2), layout: +(d.LayoutDuration * 1000 / plan.length).toFixed(2), style: +(d.RecalcStyleDuration * 1000 / plan.length).toFixed(2) },
    layoutsPerKey: +(d.LayoutCount / plan.length).toFixed(2), styleRecalcsPerKey: +(d.RecalcStyleCount / plan.length).toFixed(2), wallSec: wall / 1000,
    eventTiming: { keydown: stats(r.evs.filter((e) => e.name === 'keydown').map((e) => e.dur)), input: stats(r.evs.filter((e) => e.name === 'input' || e.name === 'beforeinput').map((e) => e.dur)) },
    rendererProfile: rprof,
  };
};

/** Development aid: opens the typing target (as `typing` does), then evaluates AB_PERF_JS in the page. */
S.eval = async () => {
  await waitBoard();
  const termChat = process.env.AB_PERF_TERMCHAT !== '0';
  await page(`localStorage.setItem('ui.termChat', ${J(String(termChat))}); window.dispatchEvent(new CustomEvent('ab-appstorage', { detail: { key: 'ui.termChat', value: ${termChat} } })); true`);
  const target = allAgents(state()).filter((a) => a.canReceiveInput && a.tmuxPane && !a.isSubagent).sort((x, y) => transcriptBytes(y) - transcriptBytes(x))[0];
  if (target) await openAgent(target);
  await sleep(3000);
  return page(process.env.AB_PERF_JS || 'null');
};

S.switch = async () => {
  await waitBoard();
  const s = state();
  const team = (s.teams || []).filter((t) => t.liveCount > 0).sort((a, b) => b.members.length - a.members.length)[0];
  const loose = (s.loose || []).filter((a) => !a.isSubagent && !/^abtest/.test(a.name || ''));
  const home = await Lp('조직도'), looseTab = await Lp('개별 세션');
  const rounds = [];
  for (let round = 0; round < 3; round++) {
    const r = {};
    if (team) {
      r.teamTab = await clickTab(team.displayName); await sleep(600);
      const mates = team.members.filter((m) => !m.isLead);
      if (mates[0]) { r.splitOpen = await clickRow(mates[0].name); await sleep(600); }
      if (mates[1]) { r.splitAddSecond = await clickRow(mates[1].name); await sleep(600); r.splitRemoveSecond = await clickRow(mates[1].name); await sleep(600); }
      if (mates[0]) { r.splitClose = await clickRow(mates[0].name); await sleep(600); }
    }
    if (loose.length > 1) {
      r.looseTab = await clickTab(looseTab); await sleep(600);
      r.otherSession = await clickRow(loose[round % loose.length].name); await sleep(600);
      r.otherSession2 = await clickRow(loose[(round + 1) % loose.length].name); await sleep(600);
    }
    r.home = await clickTab(home); await sleep(800);
    rounds.push(r);
  }
  const keys = [...new Set(rounds.flatMap((r) => Object.keys(r)))];
  const summary = {};
  for (const k of keys) {
    const xs = rounds.map((r) => r[k]).filter(Boolean);
    summary[k] = { firstVisit: xs[0] && { paint: xs[0].paint, settled: xs[0].settled, sync: xs[0].sync, renders: xs[0].renders, longest: Math.round(xs[0].longest) },
      revisit: stats(xs.slice(1).map((x) => x.paint)), revisitSettled: stats(xs.slice(1).map((x) => x.settled)) };
  }
  return { team: team && team.displayName, teamMembers: team && team.members.length, looseCount: loose.length, summary, rounds };
};

/** Scroll the CLI screen up then down with wheel events and count dropped frames. */
async function scrollTest(sel) {
  const rect = await page(`(() => { const e = document.querySelector(${J(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), sh: e.scrollHeight, ch: e.clientHeight }; })()`);
  if (!rect) return null;
  await page(`window.__perf.startFrames(); window.__perf.__lt0 = window.__perf.longtasks.length; true`);
  for (const dir of [1, -1]) {
    for (let i = 0; i < 90; i++) { win.webContents.sendInputEvent({ type: 'mouseWheel', x: rect.x, y: rect.y, deltaX: 0, deltaY: dir * 120, canScroll: true }); await sleep(16); }
    await sleep(200);
  }
  const r = await page(`(() => { const t = window.__perf.stopFrames(); const lt = window.__perf.longtasks.slice(window.__perf.__lt0); return { t, lt }; })()`);
  const iv = []; for (let i = 1; i < r.t.length; i++) iv.push(r.t[i] - r.t[i - 1]);
  const frame = 1000 / 60;
  const dropped = iv.reduce((s2, x) => s2 + Math.max(0, Math.round(x / frame) - 1), 0);
  return { contentPx: rect.sh, viewPx: rect.ch, frames: r.t.length, expectedFrames: r.t.length + dropped, dropped, frameInterval: stats(iv), longtasks: r.lt.length, longest: Math.max(0, ...r.lt.map((x) => x.dur)) };
}
/** Captures, screen rebuilds and CPU over `sec` seconds while the live CLI screen is on. */
async function screenWindow(sec) {
  await page(`(() => { const P = window.__perf; P.__applies = 0; const b = document.querySelector('.pane-text .pt-body'); if (P.__mo) P.__mo.disconnect(); if (b) { P.__mo = new MutationObserver(() => { P.__applies++; }); P.__mo.observe(b, { childList: true }); } return !!b; })()`);
  const c0 = probe.captures.length; appMetrics();
  const cpu0 = process.cpuUsage(); const m0 = await perfMetrics(); const t0 = Date.now();
  const lt0 = await page('window.__perf.longtasks.length');
  const rprof = await profileRenderer(() => sleep(sec * 1000));
  const m1 = await perfMetrics(); const cpu1 = process.cpuUsage(cpu0); const wall = (Date.now() - t0) / 1000;
  const am = appMetrics();
  const caps = probe.captures.slice(c0);
  const r = await page(`({ applies: window.__perf.__applies, rows: document.querySelectorAll('.pane-text .pt-ln').length, nodes: document.getElementsByTagName('*').length, lt: window.__perf.longtasks.slice(${lt0}) })`);
  const d = metricDelta(m0, m1, ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration']);
  const n = Math.max(1, Math.round(wall));
  return {
    seconds: +wall.toFixed(1), captures: caps.length, captureWall: stats(caps.map((x) => x.ms)), screenBytes: caps.length ? caps[caps.length - 1].bytes : 0,
    screenRebuilds: r.applies, rows: r.rows, domNodes: r.nodes,
    perSecond_ms: { mainCPU: +((cpu1.user + cpu1.system) / 1000 / n).toFixed(2), rendererTask: +(d.TaskDuration * 1000 / n).toFixed(2), rendererScript: +(d.ScriptDuration * 1000 / n).toFixed(2), rendererLayout: +(d.LayoutDuration * 1000 / n).toFixed(2), rendererStyle: +(d.RecalcStyleDuration * 1000 / n).toFixed(2) },
    perRebuild_ms: r.applies ? +((d.TaskDuration * 1000) / r.applies).toFixed(2) : null,
    cpuPercent: Object.fromEntries(['Browser', 'Tab', 'GPU'].map((t) => [t, +am.filter((x) => x.type === t).reduce((s2, x) => s2 + x.cpu, 0).toFixed(1)])),
    longtasks: { n: r.lt.length, max: Math.max(0, ...r.lt.map((x) => x.dur)) },
    rendererProfile: rprof,
  };
}

S.screen = async () => {
  await waitBoard();
  const out = {};
  // A: a real live session's screen (read only), while its pane is idle
  await page(`localStorage.setItem('ui.termChat', 'true'); window.dispatchEvent(new CustomEvent('ab-appstorage', { detail: { key: 'ui.termChat', value: true } })); true`);
  const s = state();
  const live = allAgents(s).filter((a) => a.tmuxPane && a.state !== 'ended' && !a.isSubagent).sort((a, b) => (a.state === 'idle' ? 0 : 1) - (b.state === 'idle' ? 0 : 1))[0];
  if (live) {
    out.realPane = { name: live.name, pane: live.tmuxPane, state: live.state };
    out.realPane.nav = await openAgent(live);
    await waitFor(`!!document.querySelector('.tab-layer.current .pane-text .pt-ln')`, 10000);
    await sleep(2000);
    out.realPane.window = await screenWindow(Number(process.env.AB_PERF_SCREEN_SEC || 20));
    out.realPane.scroll = await scrollTest('.tab-layer.current .pane-text');
  }
  // B: a throwaway abtest pane whose content changes (dev page: PaneChatView alone over that pane)
  const pane = process.env.AB_PERF_PANE;
  if (pane) {
    await page(`location.href = 'dev/panechat.html#pane=' + encodeURIComponent(${J(pane)}) + '&view=chat&theme=dark'; true`).catch(() => { });
    await sleep(1500);
    await waitFor(`!!document.querySelector('.pane-text .pt-ln')`, 10000);
    await sleep(2500);
    out.changingPane = { pane, window: await screenWindow(Number(process.env.AB_PERF_SCREEN_SEC || 20)) };
    out.changingPane.scroll = await scrollTest('.pane-text');
  }
  return out;
};

S.idle = async () => {
  await waitBoard();
  const view = process.env.AB_PERF_IDLE_VIEW || 'home';
  if (view === 'pane') {
    const live = allAgents(state()).filter((a) => a.tmuxPane && a.state !== 'ended' && !a.isSubagent)[0];
    if (live) await openAgent(live);
  }
  await sleep(5000);
  const minutes = Number(process.env.AB_PERF_MINUTES || 5);
  probe.sizes = true;
  const p0 = probe.pushes.length, u0 = probe.updates.length, sp0 = probe.spawns, byCmd0 = { ...probe.spawnByCmd };
  const pp0 = await page('window.__perf.pushes.length');
  await page(`window.__perf.trackNames = true; window.__perf.byName = Object.create(null); true`);
  appMetrics();
  const cpu0 = process.cpuUsage(); const m0 = await perfMetrics(); const t0 = Date.now();
  const swift = swiftPid(); const ps0 = ps([swift, process.pid]);
  const samples = [];
  const prof = await profileMain(async () => {
    const end = t0 + minutes * 60000;
    while (Date.now() < end) {
      await sleep(10000);
      const am = appMetrics();
      samples.push({ t: Math.round((Date.now() - t0) / 1000), browser: +am.filter((x) => x.type === 'Browser').reduce((s, x) => s + x.cpu, 0).toFixed(2), tab: +am.filter((x) => x.type === 'Tab').reduce((s, x) => s + x.cpu, 0).toFixed(2), gpu: +am.filter((x) => x.type === 'GPU').reduce((s, x) => s + x.cpu, 0).toFixed(2), other: +am.filter((x) => !['Browser', 'Tab', 'GPU'].includes(x.type)).reduce((s, x) => s + x.cpu, 0).toFixed(2) });
    }
  });
  const wall = (Date.now() - t0) / 1000;
  const cpu1 = process.cpuUsage(cpu0); const m1 = await perfMetrics(); const ps1 = ps([swift, process.pid]);
  probe.sizes = false;
  const pushes = probe.pushes.slice(p0), ups = probe.updates.slice(u0);
  const pp = await page(`window.__perf.pushes.slice(${pp0})`);
  const byName = await page(`(() => { const o = window.__perf.byName; window.__perf.trackNames = false; return Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 25); })()`);
  const refreshSync = invocations(prof, isStoreFn('refresh'));
  const d = metricDelta(m0, m1, ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'LayoutCount']);
  const spawnByCmd = {}; for (const [k, v] of Object.entries(probe.spawnByCmd)) if (v - (byCmd0[k] || 0)) spawnByCmd[k] = v - (byCmd0[k] || 0);
  const swiftCPU = swift && ps0[swift] && ps1[swift] ? +(100 * (ps1[swift].cpuSec - ps0[swift].cpuSec) / wall).toFixed(2) : null;
  const avg = (k) => +(samples.reduce((s, x) => s + x[k], 0) / Math.max(1, samples.length)).toFixed(2);
  return {
    view, seconds: Math.round(wall),
    mainCPUpercent: +(100 * (cpu1.user + cpu1.system) / 1e6 / wall).toFixed(2),
    processCPUpercent: { browser: avg('browser'), renderer: avg('tab'), gpu: avg('gpu'), other: avg('other') },
    rendererBusyPercent: +(100 * d.TaskDuration / wall).toFixed(2),
    swift: swift ? { pid: swift, cpuPercent: swiftCPU, rssMB: ps1[swift] ? +(ps1[swift].rss / 1024).toFixed(1) : null } : null,
    refresh: {
      tmuxUpdateWall_ms: stats(ups.map((x) => x.ms)), updatesPerMin: +(ups.length / (wall / 60)).toFixed(1),
      refreshSync_ms: stats(refreshSync), spawnsPerMin: +((probe.spawns - sp0) / (wall / 60)).toFixed(1), spawnByCmd,
    },
    pushes: {
      count: pushes.length, perMin: +(pushes.length / (wall / 60)).toFixed(1), bytes: stats(pushes.map((x) => x.bytes)),
      bytesPerMin: Math.round(pushes.reduce((s, x) => s + (x.bytes || 0), 0) / (wall / 60)),
      rendersPerPush: stats(pp.map((x) => x.renders)), domDiffsPerPush: stats(pp.map((x) => x.dom)), renderMsPerPush: stats(pp.map((x) => x.renderMs)), pushToPaint_ms: stats(pp.map((x) => x.paint)),
      componentRenders: byName,
    },
    mainTopSelf_ms: topSelf(prof, 20), cpuSamples: samples,
  };
};

S.soak = async () => {
  await waitBoard();
  const minutes = Number(process.env.AB_PERF_MINUTES || 60);
  const swift = swiftPid();
  const s = state();
  const team = (s.teams || []).filter((t) => t.liveCount > 0).sort((a, b) => b.members.length - a.members.length)[0];
  const loose = (s.loose || []).filter((a) => !a.isSubagent && !/^abtest/.test(a.name || ''));
  const home = await Lp('조직도'), looseTab = await Lp('개별 세션');
  const partial = process.env.AB_PERF_OUT ? process.env.AB_PERF_OUT + '.partial' : null;
  const samples = [];
  let lastPs = null; const t0 = Date.now();
  /** One minute of use: the tabs and rows a person would click, then idle on the org chart. */
  const exercise = async (i) => {
    try {
      if (team) {
        await clickTab(team.displayName); await sleep(1500);
        const mates = team.members.filter((m) => !m.isLead);
        if (mates[0]) { await clickRow(mates[0].name); await sleep(3000); await clickRow(mates[0].name); await sleep(1000); }
      }
      if (loose.length) { await clickTab(looseTab); await sleep(1000); await clickRow(loose[i % loose.length].name); await sleep(3000); }
      await clickTab(home);
    } catch (e) { console.log('[perf] exercise:', e.message); }
  };
  for (let i = 0; i <= minutes; i++) {
    const tick = Date.now();
    // sample (after a GC in both JS heaps: what stays is what is held)
    try { await cdp('HeapProfiler.collectGarbage'); } catch { }
    mainGC();
    const heap = await cdp('Runtime.getHeapUsage');
    const dom = await cdp('Memory.getDOMCounters');
    const pg = await page(`(() => { const P = window.__perf; return { intervals: P.intervals.size, intervalMs: [...P.intervals.values()], timeouts: P.pendingTimeouts.size, errors: P.errors, errorSamples: P.errorSamples.slice(-5), nodesInDoc: document.getElementsByTagName('*').length, pushes: P.pushes.length }; })()`);
    const am = appMetrics();
    const pss = ps([...am.map((x) => x.pid), swift]);
    const res = {}; for (const r of process.getActiveResourcesInfo()) res[r] = (res[r] || 0) + 1;
    const mu = process.memoryUsage();
    const elecRss = am.reduce((sum, x) => sum + (pss[x.pid] ? pss[x.pid].rss : 0), 0);
    const elecCpu = am.reduce((sum, x) => sum + (pss[x.pid] ? pss[x.pid].cpuSec : 0), 0);
    const sample = {
      min: +((tick - t0) / 60000).toFixed(2),
      electronRssMB: +(elecRss / 1024).toFixed(1),
      byType: Object.fromEntries(['Browser', 'Tab', 'GPU', 'Utility'].map((t) => [t, +(am.filter((x) => x.type === t).reduce((sum, x) => sum + (pss[x.pid] ? pss[x.pid].rss : 0), 0) / 1024).toFixed(1)])),
      electronCpuSec: +elecCpu.toFixed(2), procs: am.length,
      swiftRssMB: swift && pss[swift] ? +(pss[swift].rss / 1024).toFixed(1) : null, swiftCpuSec: swift && pss[swift] ? pss[swift].cpuSec : null,
      rendererHeapMB: +(heap.usedSize / 1048576).toFixed(2), mainHeapMB: +(mu.heapUsed / 1048576).toFixed(2), mainExternalMB: +(mu.external / 1048576).toFixed(2),
      domNodes: dom.nodes, jsListeners: dom.jsEventListeners, documents: dom.documents, nodesInDoc: pg.nodesInDoc,
      pageIntervals: pg.intervals, pageTimeouts: pg.timeouts, mainResources: res,
      pageErrors: pg.errors, mainErrors: probe.mainErrors, pushes: probe.pushes.length,
    };
    if (lastPs) {
      const dt = (tick - lastPs.t) / 1000;
      sample.electronCpuPct = +(100 * (elecCpu - lastPs.e) / dt).toFixed(2);
      if (sample.swiftCpuSec != null && lastPs.s != null) sample.swiftCpuPct = +(100 * (sample.swiftCpuSec - lastPs.s) / dt).toFixed(2);
    }
    lastPs = { t: tick, e: elecCpu, s: sample.swiftCpuSec };
    samples.push(sample);
    console.log('[perf] soak', JSON.stringify(sample));
    if (partial) fs.writeFileSync(partial, JSON.stringify({ samples, pageErrorSamples: pg.errorSamples, mainErrorSamples: probe.mainErrorSamples }, null, 1));
    if (i === minutes) break;
    await exercise(i);
    const left = 60000 - (Date.now() - tick);
    if (left > 0) await sleep(left);
  }
  // trend after a 5-minute warm-up: slope per hour (least squares)
  const warm = samples.filter((x) => x.min >= 5);
  const slope = (k) => {
    const xs = warm.map((x) => x.min / 60), ys = warm.map((x) => x[k]);
    if (xs.length < 3 || ys.some((y) => typeof y !== 'number')) return null;
    const mx = xs.reduce((a, b) => a + b) / xs.length, my = ys.reduce((a, b) => a + b) / ys.length;
    let nu = 0, de = 0; for (let j = 0; j < xs.length; j++) { nu += (xs[j] - mx) * (ys[j] - my); de += (xs[j] - mx) ** 2; }
    return de ? +(nu / de).toFixed(3) : null;
  };
  const trend = {};
  for (const k of ['electronRssMB', 'swiftRssMB', 'rendererHeapMB', 'mainHeapMB', 'domNodes', 'jsListeners', 'pageIntervals', 'pageTimeouts', 'nodesInDoc']) trend[k] = slope(k);
  const pageErr = await page('window.__perf.errorSamples');
  return { minutes, team: team && team.displayName, trendPerHour: trend, samples, pageErrorSamples: pageErr, mainErrorSamples: probe.mainErrorSamples };
};

// ── run ───────────────────────────────────────────────────────────────────────────────────────────────────────────
async function prepare(w, mods) {
  win = w; modules = mods;
  installMainProbes();
  dbg = w.webContents.debugger;
  // CDP needs a live page: a blank one first; the probes then run in every page loaded after it
  await w.loadURL('about:blank');
  dbg.attach('1.3');
  await cdp('Page.enable');
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: fs.readFileSync(path.join(__dirname, 'page.js'), 'utf8') });
  await cdp('Performance.enable', { timeDomain: 'timeTicks' });
  result.marks.loadAt = Date.now();
  w.showInactive();
  w.webContents.once('did-finish-load', () => { run().catch((e) => finish({ error: String((e && e.stack) || e) })); });
}

async function run() {
  for (const sc of scenarios) {
    const f = S[sc];
    if (!f) { result[sc] = { error: 'unknown scenario' }; continue; }
    console.log(`[perf] ${sc} …`);
    try { result[sc] = await f(); } catch (e) { result[sc] = { error: String((e && e.stack) || e) }; }
    if (sc === 'screen' && process.env.AB_PERF_PANE) break;     // the page left the board
  }
  result.loadavgAtEnd = require('os').loadavg().map((x) => +x.toFixed(1));
  result.errors = { page: await page('window.__perf ? { n: window.__perf.errors, samples: window.__perf.errorSamples } : null').catch(() => null), main: { n: probe.mainErrors, samples: probe.mainErrorSamples } };
  finish(result);
}
function finish(r) {
  const s = JSON.stringify(r, null, 1);
  if (process.env.AB_PERF_OUT) fs.writeFileSync(process.env.AB_PERF_OUT, s); else process.stdout.write(s + '\n');
  console.log('[perf] done');
  setTimeout(() => app.exit(0), 200);
}

module.exports = { prepare };
