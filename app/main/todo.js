// The data side of TodoCard.swift (TodoStore): task cards in the banner, each a title and its checklist, saved in
// ~/.agent-boost/todos.json in the macOS app's exact format, so both apps read the same to-dos:
//   [{"id": "<UUID>", "title": "…", "items": [{"id": "<UUID>", "text": "…", "done": false}, …]}, …]
// Every function returns the boards after the change; the window also gets send('todos', boards).
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const COUNT = 3;   // at least three cards; more with the + button
// AB_TODOS_FILE: tests point the store at a scratch file
const file = process.env.AB_TODOS_FILE || path.join(os.homedir(), '.agent-boost', 'todos.json');
let boards = null;

const readonly = () => !!process.env.AB_READONLY;
const newId = () => crypto.randomUUID().toUpperCase();     // Foundation's UUID encodes upper-case
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const trimAll = (s) => String(s).replace(/^[\s\u0085]+|[\s\u0085]+$/g, '');

/** Swift's synthesized Decodable: every key present with the right type (ids must be UUIDs). */
function decodeItem(x) {
  if (!x || typeof x !== 'object' || typeof x.id !== 'string' || !UUID_RE.test(x.id) || typeof x.text !== 'string' || typeof x.done !== 'boolean') throw new Error('item');
  return { id: x.id.toUpperCase(), text: x.text, done: x.done };
}
function decodeBoard(x) {
  if (!x || typeof x !== 'object' || typeof x.id !== 'string' || !UUID_RE.test(x.id) || typeof x.title !== 'string' || !Array.isArray(x.items)) throw new Error('board');
  return { id: x.id.toUpperCase(), title: x.title, items: x.items.map(decodeItem) };
}

function load() {
  if (boards) return boards;
  let b = [];
  let raw = null;
  try { raw = fs.readFileSync(file); } catch { }
  if (raw) {
    let j;
    try { j = JSON.parse(raw.toString('utf8')); } catch { j = undefined; }
    let ok = false;
    if (Array.isArray(j)) {
      try { b = j.map(decodeBoard); ok = true; } catch { }
      if (!ok) { try { b = [{ id: newId(), title: '', items: j.map(decodeItem) }]; ok = true; } catch { } }   // the single list moves into card 1
    }
    if (!ok) {
      // keep the unreadable file
      if (readonly()) console.log('[readonly] todo.backupUnreadable');
      else { try { fs.rmSync(file + '.bak', { force: true }); fs.renameSync(file, file + '.bak'); } catch { } }
      b = [];
    }
  }
  while (b.length < COUNT) b.push({ id: newId(), title: '', items: [] });
  boards = b;
  return boards;
}

/** Atomic write, like Data.write(options: .atomic). */
function save() {
  if (readonly()) { console.log('[readonly] todo.save'); return; }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(boards));
    fs.renameSync(tmp, file);
  } catch (e) { console.error('todos', e.message); }
}
function notify() {
  if (!process.versions.electron) return;
  try { require('./main').send('todos', boards); } catch { }
}
/** Applies a change; with AB_READONLY nothing changes (the action is logged by save()). */
function change(name, f) {
  load();
  if (readonly()) { console.log(`[readonly] todo.${name}`); return boards; }
  const before = JSON.stringify(boards);
  f();
  if (JSON.stringify(boards) !== before) { save(); notify(); }
  return boards;
}
function withBoard(bid, f) {
  const b = boards.find((x) => x.id === bid);
  if (b) f(b);
}

// ── TodoStore API ─────────────────────────────────────────────────────────────────────────
function getBoards() { return load(); }
function remaining(board) { return board.items.filter((i) => !i.done).length; }
function addBoard() { return change('addBoard', () => { boards.push({ id: newId(), title: '', items: [] }); }); }
function removeBoard(bid) { return change('removeBoard', () => { boards = boards.filter((b) => b.id !== bid); }); }
function setTitle(bid, t) { return change('setTitle', () => withBoard(bid, (b) => { b.title = trimAll(t); })); }
function add(bid, text) {
  const t = trimAll(text);
  if (!t) return load();
  return change('add', () => withBoard(bid, (b) => { b.items.push({ id: newId(), text: t, done: false }); }));
}
function toggle(bid, id) {
  return change('toggle', () => withBoard(bid, (b) => { const it = b.items.find((x) => x.id === id); if (it) it.done = !it.done; }));
}
function remove(bid, id) { return change('remove', () => withBoard(bid, (b) => { b.items = b.items.filter((x) => x.id !== id); })); }
function edit(bid, id, text) {
  const t = trimAll(text);
  return change('edit', () => withBoard(bid, (b) => {
    const i = b.items.findIndex((x) => x.id === id);
    if (i < 0) return;
    if (!t) b.items.splice(i, 1); else b.items[i].text = t;
  }));
}
function clearDone(bid) { return change('clearDone', () => withBoard(bid, (b) => { b.items = b.items.filter((x) => !x.done); })); }
/** Drag and drop: the item moves in front of `target` (to the end when the target is gone). */
function move(bid, id, target) {
  return change('move', () => withBoard(bid, (b) => {
    const from = b.items.findIndex((x) => x.id === id);
    if (id === target || from < 0) return;
    const [it] = b.items.splice(from, 1);
    let to = b.items.findIndex((x) => x.id === target);
    if (to < 0) to = b.items.length;
    b.items.splice(to, 0, it);
  }));
}
/** Re-reads the file (e.g. after the macOS app or another copy changed it). */
function reload() { boards = null; return load(); }

module.exports = {
  count: () => COUNT,
  boards: getBoards, remaining, addBoard, removeBoard, setTitle, add, toggle, remove, edit, clearDone, move, reload,
};
