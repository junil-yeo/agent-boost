// Page-side probes for perf runs (test/perf/driver.js installs this before the app's own scripts run, through CDP's
// Page.addScriptToEvaluateOnNewDocument). Everything lives on window.__perf; the driver reads it with
// executeJavaScript. Nothing here changes what the app does: it only observes (long tasks, event timing, frames,
// timers, console errors, state pushes, Preact renders).
(() => {
  if (window.__perf) return;
  const P = window.__perf = {
    longtasks: [], events: [], errors: 0, errorSamples: [],
    intervals: new Map(), pendingTimeouts: new Set(),
    pushes: [], renders: 0, domDiffs: 0, byName: Object.create(null), trackNames: false,
    frames: null, marks: {},
  };
  const now = () => performance.now();
  const epoch = (t) => performance.timeOrigin + t;

  // ── long tasks and slow events (Event Timing: input → next paint, 8 ms granularity, ≥ 16 ms only) ──────────────
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) P.longtasks.push({ start: e.startTime, dur: e.duration }); }).observe({ type: 'longtask', buffered: true }); } catch { }
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) P.events.push({ name: e.name, start: e.startTime, dur: e.duration, delay: e.processingStart - e.startTime, proc: e.processingEnd - e.processingStart });
    }).observe({ type: 'event', durationThreshold: 16, buffered: true });
  } catch { }

  // ── the time after the next frame: rAF, then a message (runs after the frame's commit) ────────────────────────────
  P.nextPaint = () => new Promise((r) => requestAnimationFrame(() => { const ch = new MessageChannel(); ch.port1.onmessage = () => r(now()); ch.port2.postMessage(0); }));

  // ── input → next paint, per keystroke: the first input-ish event of a keystroke starts it ────────────────────────
  P.keys = []; let keyOpen = null;
  const keyEvent = (e) => {
    if (!P.measureKeys || keyOpen) return;
    keyOpen = { type: e.type, start: e.timeStamp || now(), seen: now() };
    const k = keyOpen;
    P.nextPaint().then((t) => { P.keys.push({ type: k.type, at: k.start, lat: t - k.start, handlerToPaint: t - k.seen }); keyOpen = null; });
  };
  for (const ev of ['keydown', 'compositionstart', 'compositionupdate', 'beforeinput']) document.addEventListener(ev, keyEvent, true);

  // ── frames: a rAF loop while on (scroll smoothness) ─────────────────────────────────────────────────────────────
  P.startFrames = () => {
    const f = P.frames = { times: [], on: true };
    const loop = (t) => { if (!f.on) return; f.times.push(t); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  };
  P.stopFrames = () => { if (!P.frames) return null; P.frames.on = false; const t = P.frames.times; P.frames = null; return t; };

  // ── timers: intervals alive and timeouts pending (installed before the app runs, so all are seen) ─────────────────
  const si = window.setInterval, ci = window.clearInterval, st = window.setTimeout, ct = window.clearTimeout;
  window.setInterval = function (f, ms, ...a) { const id = si.call(window, f, ms, ...a); P.intervals.set(id, ms); return id; };
  window.clearInterval = function (id) { P.intervals.delete(id); return ci.call(window, id); };
  window.setTimeout = function (f, ms, ...a) {
    let id;
    const g = typeof f === 'function' ? function () { P.pendingTimeouts.delete(id); return f.apply(this, arguments); } : f;
    id = st.call(window, g, ms, ...a); P.pendingTimeouts.add(id); return id;
  };
  window.clearTimeout = function (id) { P.pendingTimeouts.delete(id); return ct.call(window, id); };

  // ── console errors ─────────────────────────────────────────────────────────────────────────────────────────────
  const note = (s) => { P.errors++; if (P.errorSamples.length < 30) P.errorSamples.push(String(s).slice(0, 300)); };
  const ce = console.error;
  console.error = function (...a) { note(a.map((x) => (x && x.stack) || x).join(' ')); return ce.apply(console, a); };
  window.addEventListener('error', (e) => note('error: ' + (e.message || e)));
  window.addEventListener('unhandledrejection', (e) => note('rejection: ' + ((e.reason && e.reason.stack) || e.reason)));

  // ── milestones for start-up ─────────────────────────────────────────────────────────────────────────────────────
  const watch = new MutationObserver(() => {
    if (!P.marks.board && document.querySelector('.org-scroll')) P.marks.board = epoch(now());
    if (!P.marks.rocket && document.querySelector('.rocket, .rocket-launch, canvas')) P.marks.rocket = epoch(now());
    if (P.marks.board) watch.disconnect();
  });
  // DOM rebuilds of the live CLI screen (one innerHTML per new capture)
  P.screenApplies = [];
  const screenWatch = new MutationObserver((ms) => { for (const m of ms) if (m.target.classList && m.target.classList.contains('pt-body')) { P.screenApplies.push(now()); if (P.screenApplies.length > 5000) P.screenApplies.splice(0, 1000); break; } });
  document.addEventListener('DOMContentLoaded', () => {
    screenWatch.observe(document.body, { childList: true, subtree: true });
    P.marks.dcl = epoch(now());
    watch.observe(document.body, { childList: true, subtree: true });
    // Preact render counting (the same module instance as the app's: same URL through the page's import map)
    import('preact').then(({ options }) => {
      const prev = options.diffed;
      options.diffed = (v) => {
        if (typeof v.type === 'function') {
          P.renders++;
          if (P.trackNames) { const n = v.type.displayName || v.type.name || '?'; P.byName[n] = (P.byName[n] || 0) + 1; }
        } else P.domDiffs++;
        if (prev) prev(v);
      };
    }).catch((e) => note('perf preact hook: ' + e));
    // state pushes: when, how many renders each one caused, how long until the render finished
    if (window.api && window.api.on) {
      window.api.on('state', (s) => {
        const t0 = now(), r0 = P.renders, d0 = P.domDiffs;
        if (!P.marks.firstState) P.marks.firstState = epoch(t0);
        if (!P.marks.firstScanDone && s && s.firstScanDone) P.marks.firstScanDone = epoch(t0);
        const rec = { t: t0 };
        P.pushes.push(rec);
        if (P.pushes.length > 5000) P.pushes.splice(0, 1000);
        // Preact renders in a microtask queued by the app's own listener (registered first): this one runs after it
        Promise.resolve().then(() => { rec.renderMs = now() - t0; });
        P.nextPaint().then((t) => { rec.paint = t - t0; rec.renders = P.renders - r0; rec.dom = P.domDiffs - d0; });
      });
    }
  });
})();
