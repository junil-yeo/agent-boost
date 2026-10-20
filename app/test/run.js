// Runs every test/*.test.js in its own node process (AB_READONLY on) and reports pass/fail.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
let failed = 0;
for (const f of fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort()) {
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { env: { ...process.env, AB_READONLY: '1' }, encoding: 'utf8', timeout: 180000 });
  const ok = r.status === 0;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${f}`);
  if (!ok) console.log((r.stdout || '').split('\n').slice(-15).join('\n') + (r.stderr || '').split('\n').slice(-15).join('\n'));
}
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exit(failed ? 1 : 0);
