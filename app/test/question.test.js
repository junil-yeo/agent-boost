// The AskUserQuestion window (Claude Code 2.1.316): real capture-pane dumps of one question, two questions (single and
// multiSelect) and the review page. The window has a rule between its options and "Chat about this", which the general
// prompt reader took for the input box, so the question never reached the app.
// Run: node test/question.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const screen = require('../main/screen');
const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', 'question', n + '.txt'), 'utf8');

let failed = 0;
const test = (name, f) => { try { f(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e.stack || e).toString().split('\n').slice(0, 4).join('\n     ')); } };

test('one question: options, descriptions, free-text row, Chat about this', () => {
  const t = fx('one-question');
  assert.strictEqual(screen.busy(t), false);
  assert.strictEqual(screen.needsInput(t), true);
  const p = screen.prompt(t);
  assert.strictEqual(p.kind, 'question');
  assert.strictEqual(p.title, 'Which database should we use for the new caching layer in this project?');
  assert.deepStrictEqual(p.options, ['Postgres', 'SQLite', 'Type something.', 'Chat about this']);
  assert.deepStrictEqual(p.descs, ['Server-based relational database', 'Embedded file-based database', null, null]);
  assert.strictEqual(p.cursor, 0);
  assert.strictEqual(p.textOption, 2);
  assert.strictEqual(p.checked, null);
});
test('first of two questions: the tabs are the detail', () => {
  const p = screen.prompt(fx('two-questions-color'));
  assert.strictEqual(p.title, 'What is your favorite color?');
  assert.strictEqual(p.detail, '☐ Color  ☐ Pets  ✔ Submit');
  assert.deepStrictEqual(p.options, ['Red', 'Green', 'Blue', 'Type something.', 'Chat about this']);
  assert.strictEqual(p.textOption, 3);
});
test('multiSelect: checkboxes, the Submit row, free text on the last checkbox', () => {
  const p = screen.prompt(fx('two-questions-pets-multi'));
  assert.deepStrictEqual(p.options, ['Cat', 'Dog', 'Fish', 'Type something', 'Submit', 'Chat about this']);
  assert.deepStrictEqual(p.checked, [false, false, false, false, null, null]);
  assert.strictEqual(p.textOption, 3);
});
test('review page: the answers are the detail, no free text', () => {
  const p = screen.prompt(fx('two-questions-review'));
  assert.strictEqual(p.title, 'Ready to submit your answers?');
  assert.deepStrictEqual(p.options, ['Submit answers', 'Cancel']);
  assert.ok(p.detail.includes('→ Red'));
  assert.strictEqual(p.textOption, -1);
});
test('the cursor follows ❯, a checked box reads as checked', () => {
  const t = fx('two-questions-pets-multi').replace('❯ 1. [ ] Cat', '  1. [✔] Cat').replace('  2. [ ] Dog', '❯ 2. [ ] Dog');
  const p = screen.prompt(t);
  assert.strictEqual(p.cursor, 1);
  assert.deepStrictEqual(p.checked.slice(0, 2), [true, false]);
});
test('no question once the window is gone (input box back)', () => {
  const t = fx('one-question').replace(/ ☐ DB[\s\S]*$/u, '❯ \n' + '─'.repeat(60) + '\n  ⏸ manual mode on · ? for shortcuts\n');
  assert.strictEqual(screen.question(t), null);
  assert.strictEqual(screen.needsInput(t), false);
});
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
