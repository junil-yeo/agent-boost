// Main-process side of TerminalPanel.swift: what the in-app CLI screen (PaneChatView) and the terminal panel
// (TerminalPanel) ask tmux for. The views themselves are renderer/ui/panechat.js.
//
//   capture(pane)              PaneChatView.poll's one tmux call: the screen + "<attached clients> <panes in the window>"
//   captureTerm(pane)          TerminalPanel.poll's one tmux call: the screen + "<cursor x> <cursor y> <attached clients>"
//   resize(pane, cols, rows)   TmuxResize.apply (on the pane's queue): the one way the app sizes a tmux window
//   want(pane, cols|null)      PaneChatView.want: the columns an on-screen pane view wants (shared by a window's panes)
//   fit(pane, cols, panes)     PaneChatView.fit's background part: size the (possibly split) window for its views
//   sendHex(pane, hex[])       TerminalPanel.send: key bytes (send-keys -H)
//   sendLine(pane, text)       TerminalPanel.sendLine: literal text + Enter
//   home()                     Shell.home (the new-session sheet's default folder)
//
// Every command that types into or resizes a pane goes through that pane's serial queue in tmux.js (TmuxControl.queue).
// With AB_READONLY set, the acting functions log "[readonly] panes.<action>" and do nothing.
const shell = require('./shell');
const tmux = require('./tmux');

function valid(pane) { return typeof pane === 'string' && /^%[0-9]+$/.test(pane); }
function readonlyRefuse(action) {
  if (!process.env.AB_READONLY) return false;
  console.log(`[readonly] panes.${action}`);
  return true;
}

/** Splits "screen…\n<status line>\n" into the screen text (ending in "\n") and the status line's integers. */
function splitStatus(out) {
  const lines = String(out || '').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const status = (lines.pop() || '').split(' ').map((x) => parseInt(x, 10)).filter((n) => !Number.isNaN(n));
  return { screen: lines.join('\n') + '\n', status };
}

/** PaneChatView.poll: one tmux call, the screen, then "<attached clients> <panes in the window>" as the last line.
 *  → {screen, attached, panes}, or null when tmux failed (pane gone). */
async function capture(pane) {
  if (!valid(pane)) return null;
  const r = await shell.tmux(['capture-pane', '-p', '-e', '-t', pane, ';', 'display-message', '-p', '-t', pane, '#{session_attached} #{window_panes}']);
  if (r.code !== 0 && !r.out) return null;
  const { screen, status } = splitStatus(r.out);
  return { screen, attached: (status[0] || 0) > 0, panes: status.length > 1 ? Math.max(1, status[1]) : 1 };
}

/** TerminalPanel.poll: one tmux call, the screen, then cursor position and attached-client count as the last line.
 *  → {screen, cursor: [x, y] | null, attached, key} — `key` tells the view whether anything changed. */
async function captureTerm(pane) {
  if (!valid(pane)) return null;
  const r = await shell.tmux(['capture-pane', '-p', '-e', '-t', pane, ';', 'display-message', '-p', '-t', pane, '#{cursor_x} #{cursor_y} #{session_attached}']);
  if (r.code !== 0 && !r.out) return null;
  const { screen, status } = splitStatus(r.out);
  return { screen, cursor: status.length >= 2 ? [status[0], status[1]] : null, attached: status.length === 3 && status[2] > 0, key: screen + '|' + JSON.stringify(status) };
}

/** TmuxResize.apply — the one way the app sizes a tmux window. `resize-window` silently switches the window to
 *  `window-size manual`, which then ignores any terminal that attaches later (it saw a 400-row window cropped to its
 *  height, or dots around a small one). Setting `window-size latest` again right after keeps the app's size while nobody
 *  is attached and hands the size to a terminal the moment one attaches (verified against tmux 3.8 with a pty client). */
function apply(pane, cols, rows) {
  if (!valid(pane)) return Promise.resolve(null);
  if (readonlyRefuse(`resize ${pane} ${cols}x${rows}`)) return Promise.resolve(null);
  return shell.tmux(['resize-window', '-t', pane, '-x', String(cols), '-y', String(rows), ';',
    'set-window-option', '-t', pane, 'window-size', 'latest']);
}
/** TerminalPanel.fit's work item: TmuxResize.apply on the pane's queue. */
function resize(pane, cols, rows) { return valid(pane) ? tmux.queue(pane, () => apply(pane, cols, rows)) : Promise.resolve(null); }

/** Columns each on-screen pane wants. Panes of one tmux window (a lead and its teammates, shown side by side in the
 *  split view) share the window: each view used to size the window for itself alone, and the last one to resize won. */
const wanted = new Map();
function want(pane, cols) { if (cols == null) wanted.delete(pane); else wanted.set(pane, cols); }

/** PaneChatView: width of the view, height fixed and tall: the CLI fills it with its conversation (changing the height
 *  made the CLI clear its screen). */
const tallRows = 400;

/** PaneChatView.fit's work item (the view debounces it and skips it while a terminal is attached). */
function fit(pane, cols, panes = 1) {
  if (!valid(pane)) return Promise.resolve();
  want(pane, cols);
  if (readonlyRefuse(`fit ${pane} ${cols} cols`)) return Promise.resolve();
  return tmux.queue(pane, async () => {
    if (panes <= 1) { await apply(pane, cols, tallRows); return; }
    // several panes (teammates split the lead's window). Panes stacked in one column share its width, so count
    // columns, not panes: a column is as wide as the widest pane in it that a view shows (40 if none), the window
    // is the columns plus one separator each, and every column but the last is set by resizing one of its panes.
    // (Counting stacked teammates as side by side made the window too wide, and the lead's pane took the extra:
    // the CLI wrapped wider than the view and long lines ran off its right edge.)
    const r = await shell.tmux(['list-panes', '-t', pane, '-F', '#{pane_left} #{pane_id}']);
    const rows = r.out.split('\n').map((l) => l.split(' ')).filter((f) => f.length === 2 && !Number.isNaN(parseInt(f[0], 10)))
      .map((f) => [parseInt(f[0], 10), f[1]]);
    const groups = new Map();
    for (const [left, id] of rows) { if (!groups.has(left)) groups.set(left, []); groups.get(left).push(id); }
    const columns = [...groups.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
    const widths = columns.map((col) => { const w = col.map((p) => wanted.get(p)).filter((x) => x != null); return w.length ? Math.max(...w) : 40; });
    await apply(pane, widths.reduce((a, b) => a + b, 0) + Math.max(0, columns.length - 1), tallRows);
    for (let i = 0; i < columns.length - 1; i++) await shell.tmux(['resize-pane', '-t', columns[i][0], '-x', String(widths[i])]);
  });
}

/** TerminalPanel.send: key bytes as hex (send-keys -H), on the pane's queue. */
function sendHex(pane, hex) {
  if (!valid(pane) || !Array.isArray(hex) || !hex.length) return Promise.resolve(false);
  if (!hex.every((h) => /^[0-9a-f]{2}$/i.test(h))) return Promise.resolve(false);
  if (readonlyRefuse(`sendHex ${pane} (${hex.length} bytes)`)) return Promise.resolve(false);
  return tmux.queue(pane, async () => (await shell.tmux(['send-keys', '-t', pane, '-H'].concat(hex))).code === 0);
}

/** TerminalPanel.sendLine: the text literally, then Enter (Korean and other IME text goes this way). */
function sendLine(pane, text) {
  if (!valid(pane) || !text) return Promise.resolve(false);
  if (readonlyRefuse(`sendLine ${pane}`)) return Promise.resolve(false);
  return tmux.queue(pane, async () => {
    const a = await shell.tmux(['send-keys', '-t', pane, '-l', '--', String(text)]);
    const b = await shell.tmux(['send-keys', '-t', pane, 'Enter']);
    return a.code === 0 && b.code === 0;
  });
}

function home() { return shell.home; }

module.exports = { capture, captureTerm, resize, want, fit, tallRows, sendHex, sendLine, home };
