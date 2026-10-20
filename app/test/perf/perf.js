#!/usr/bin/env node
// Perf harness launcher: starts the Electron app read-only with AB_PERF and prints the driver's JSON result.
//
//   node test/perf/perf.js <scenario[,scenario…]> [--out file.json] [--minutes N] [--termchat 0|1] [--pane %N]
//                          [--idle-view home|pane] [--screen-sec N]
//
// Scenarios: inventory, startup, typing, switch, screen, idle, soak (see driver.js). The app always runs with
// AB_READONLY=1 and its own userData folder (the daily app's settings and single-instance lock are left alone).
// For `screen --pane`, make a throwaway pane first (never a real session), e.g. test/perf/abtest-pane.sh.
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const args = process.argv.slice(2);
const scen = args[0];
if (!scen) { console.error('usage: node test/perf/perf.js <scenario,…> [--out f] [--minutes N] [--termchat 0|1] [--pane %N]'); process.exit(2); }
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const appDir = path.join(__dirname, '..', '..');
const out = opt('--out') || path.join(os.tmpdir(), `ab-perf-${scen.replace(/,/g, '-')}-${Date.now()}.json`);
const userData = path.join(os.tmpdir(), 'ab-perf-userdata');
fs.mkdirSync(userData, { recursive: true });
const env = {
  ...process.env, AB_READONLY: '1', AB_PERF: scen, AB_PERF_OUT: out, AB_PERF_USERDATA: userData, AB_PERF_SPAWNED: String(Date.now()),
};
if (opt('--minutes')) env.AB_PERF_MINUTES = opt('--minutes');
if (opt('--termchat')) env.AB_PERF_TERMCHAT = opt('--termchat');
if (opt('--pane')) env.AB_PERF_PANE = opt('--pane');
if (opt('--idle-view')) env.AB_PERF_IDLE_VIEW = opt('--idle-view');
if (opt('--screen-sec')) env.AB_PERF_SCREEN_SEC = opt('--screen-sec');
delete env.ELECTRON_RUN_AS_NODE;
const electron = require(path.join(appDir, 'node_modules', 'electron'));
const child = spawn(electron, ['.'], { cwd: appDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
const log = (d) => { for (const l of String(d).split('\n')) if (l.trim() && (/\[perf\]|\[renderer\]|rror/.test(l) || process.env.AB_PERF_VERBOSE)) console.error(l); };
child.stdout.on('data', log); child.stderr.on('data', log);
child.on('exit', (code) => {
  if (!fs.existsSync(out)) { console.error(`no result (exit ${code})`); process.exit(1); }
  if (!process.env.AB_PERF_QUIET) process.stdout.write(fs.readFileSync(out, 'utf8') + '\n');
  console.error(`result: ${out}`);
  process.exit(code || 0);
});
