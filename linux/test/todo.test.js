// TodoCard.swift's TodoStore port: the macOS app's file format, migration of the old single list, unreadable files,
// and every edit. Runs against a scratch file (AB_TODOS_FILE); never touches ~/.agent-boost/todos.json.
// Run: node test/todo.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-todo-'));
const file = path.join(dir, 'todos.json');
process.env.AB_TODOS_FILE = file;
delete process.env.AB_READONLY;

let failed = 0;
const test = (name, f) => { try { f(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e.stack || e).toString().split('\n').slice(0, 4).join('\n     ')); } };
const fresh = () => { delete require.cache[require.resolve('../main/todo')]; return require('../main/todo'); };
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('reads the macOS format; at least three cards', () => {
  fs.writeFileSync(file, JSON.stringify([{ title: 'A', items: [{ id: U(1), text: 'x', done: true }], id: U(9) }]));
  const T = fresh();
  const b = T.boards();
  assert.strictEqual(b.length, 3); assert.strictEqual(b[0].title, 'A'); assert.strictEqual(b[0].items[0].done, true);
  assert.ok(/^[0-9A-F-]{36}$/.test(b[1].id));
});
test('migrates the old single list into card 1', () => {
  fs.writeFileSync(file, JSON.stringify([{ id: U(1), text: 'old', done: false }]));
  const b = fresh().boards();
  assert.strictEqual(b[0].items[0].text, 'old'); assert.strictEqual(b.length, 3);
});
test('an unreadable file is kept as .bak', () => {
  fs.writeFileSync(file, '{broken');
  const b = fresh().boards();
  assert.strictEqual(b.length, 3);
  assert.strictEqual(fs.readFileSync(file + '.bak', 'utf8'), '{broken');
  assert.ok(!fs.existsSync(file));
});
test('edits: add, toggle, edit, move, clearDone, remove, titles, cards; saved in the same format', () => {
  fs.rmSync(file, { force: true });
  const T = fresh();
  const bid = T.boards()[0].id;
  T.add(bid, '  one  '); T.add(bid, 'two'); T.add(bid, '   '); T.add(bid, 'three');
  const items = T.boards()[0].items.slice();      // [one, two, three] (a copy: the store edits its own array)
  assert.deepStrictEqual(items.map((i) => i.text), ['one', 'two', 'three']);
  T.move(bid, items[2].id, items[0].id);
  assert.deepStrictEqual(T.boards()[0].items.map((i) => i.text), ['three', 'one', 'two']);
  T.move(bid, items[2].id, 'gone');
  assert.deepStrictEqual(T.boards()[0].items.map((i) => i.text), ['one', 'two', 'three']);
  T.toggle(bid, items[0].id); T.edit(bid, items[1].id, ' deux '); T.edit(bid, items[2].id, '');
  assert.deepStrictEqual(T.boards()[0].items.map((i) => [i.text, i.done]), [['one', true], ['deux', false]]);
  assert.strictEqual(T.remaining(T.boards()[0]), 1);
  T.clearDone(bid);
  assert.deepStrictEqual(T.boards()[0].items.map((i) => i.text), ['deux']);
  T.remove(bid, T.boards()[0].items[0].id);
  T.setTitle(bid, '  Paper  ');
  T.addBoard(); assert.strictEqual(T.boards().length, 4);
  T.removeBoard(T.boards()[3].id); assert.strictEqual(T.boards().length, 3);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(saved, T.boards());
  assert.deepStrictEqual(Object.keys(saved[0]).sort(), ['id', 'items', 'title']);
  assert.strictEqual(saved[0].title, 'Paper');
});
test('AB_READONLY: nothing changes and nothing is written', () => {
  const T = fresh();
  const before = fs.readFileSync(file, 'utf8');
  process.env.AB_READONLY = '1';
  const log = console.log; console.log = () => {};
  try { T.add(T.boards()[0].id, 'nope'); T.addBoard(); } finally { console.log = log; delete process.env.AB_READONLY; }
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
  assert.strictEqual(T.boards()[0].items.length, 0);
});
fs.rmSync(dir, { recursive: true, force: true });
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
