#!/usr/bin/env node
// Summarises a trace saved by AB_PERF_TRACE: the renderer main thread's long tasks (≥ N ms, default 30) and, for each,
// where its time went (script by function, style, layout, paint, parse). node test/perf/trace-tasks.js trace.json [ms]
const fs = require('fs');
const [file, minMs = '30'] = process.argv.slice(2);
const ev = JSON.parse(fs.readFileSync(file, 'utf8')).traceEvents;
const names = {};
for (const e of ev) if (e.ph === 'M' && e.name === 'thread_name') names[e.pid + ':' + e.tid] = e.args.name;
const main = Object.keys(names).filter((k) => names[k] === 'CrRendererMain');
const onMain = (e) => main.includes(e.pid + ':' + e.tid);
const X = ev.filter((e) => e.ph === 'X' && onMain(e)).sort((a, b) => a.ts - b.ts);
const tasks = X.filter((e) => e.name === 'RunTask' || e.name === 'ThreadControllerImpl::RunTask');
const long = tasks.filter((t) => t.dur / 1000 >= Number(minMs));
const total = tasks.reduce((s, t) => s + t.dur, 0) / 1000;
console.log(`tasks ${tasks.length}, busy ${total.toFixed(0)} ms, long (≥${minMs} ms) ${long.length}`);
const agg = {};
for (const t of long) {
  const inside = X.filter((e) => e.ts >= t.ts && e.ts + e.dur <= t.ts + t.dur && e !== t);
  const by = {};
  for (const e of inside) {
    let k = e.name;
    if (e.name === 'FunctionCall' || e.name === 'EvaluateScript' || e.name === 'TimerFire' || e.name === 'FireAnimationFrame' || e.name === 'EventDispatch') {
      const d = (e.args && e.args.data) || {};
      k = `${e.name} ${d.functionName || d.type || ''} ${(d.url || '').split('/').pop()}:${d.lineNumber || ''}`;
    }
    by[k] = (by[k] || 0) + e.dur / 1000;
  }
  const top = Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} ${v.toFixed(1)}`);
  console.log(`\n${(t.dur / 1000).toFixed(1)} ms @${((t.ts - X[0].ts) / 1000).toFixed(0)}:\n  ` + top.join('\n  '));
  for (const [k, v] of Object.entries(by)) agg[k] = (agg[k] || 0) + v;
}
console.log('\nall long tasks:\n  ' + Object.entries(agg).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, v]) => `${k} ${v.toFixed(1)}`).join('\n  '));
// every task: time by event (self time of each event name / function, nested events subtracted)
{
  const self = {};
  const stack = [];
  const keyOf = (e) => {
    if (['FunctionCall', 'EvaluateScript', 'TimerFire', 'FireAnimationFrame', 'EventDispatch', 'v8.callFunction'].includes(e.name)) {
      const d = (e.args && e.args.data) || {};
      return `${e.name} ${d.functionName || d.type || ''} ${(d.url || '').split('/').pop()}:${d.lineNumber || ''}`;
    }
    return e.name;
  };
  for (const e of X) {
    while (stack.length && stack[stack.length - 1].ts + stack[stack.length - 1].dur <= e.ts) stack.pop();
    const k = keyOf(e);
    self[k] = (self[k] || 0) + e.dur / 1000;
    if (stack.length) { const p = keyOf(stack[stack.length - 1]); self[p] -= e.dur / 1000; }
    stack.push(e);
  }
  console.log('\nall tasks, self time:\n  ' + Object.entries(self).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, v]) => `${k} ${v.toFixed(1)}`).join('\n  '));
}
