// The menu-bar extra of the macOS app (App.swift MenuBarExtra: MenuBarContent + MenuBarLabel) as an Electron Tray, and
// the parts of AppDelegate that are about the window: background mode (window hidden, sessions and monitoring keep
// running, the tray icon brings it back), one board at a time (a second launch brings the running one forward), and
// the window's ✕ asking what to do (CloseInterceptor; the renderer shows the question on 'close-request').
// The quit itself (AppDelegate.applicationShouldTerminate) is the store's 'quit-request' flow.
const { app, Tray, Menu, nativeImage, BrowserWindow } = require('electron');
const path = require('path');
const { L } = require('./l10n');

const snapshotRun = !!process.env.AB_SNAPSHOT || process.argv.includes('--snapshot');
let tray = null;
let lastMenuKey = '';
let quitting = false;      // a quit is under way: the window may close without asking

const mainModule = () => { try { return require('./main'); } catch { return null; } };
const storeModule = () => { try { return require('./store'); } catch { return null; } };
function mainWindow() {
  const m = mainModule();
  const w = m && m.window;
  if (w && !w.isDestroyed()) return w;
  return BrowserWindow.getAllWindows().find((x) => !x.isDestroyed()) || null;
}

// ── AppDelegate.showBoard / goBackground ─────────────────────────────────────────────────────────────────────────
/** Back to the user: window shown and in front. */
function showBoard() {
  const w = mainWindow();
  if (!w) return;
  if (w.isMinimized()) w.restore();
  w.show(); w.focus();
}
/** Background: window hidden; sessions, monitoring and the tray icon keep running. */
function goBackground() {
  const w = mainWindow();
  if (w) w.hide();
}

// ── one board at a time ─────────────────────────────────────────────────────────────────────────────────────────
// Two boards would double-send commands and fight over sessions. The holder of the lock is brought forward and this
// launch exits. (Self-test snapshots run side by side.)
if (!snapshotRun) {
  if (!app.requestSingleInstanceLock()) app.exit(0);
  else app.on('second-instance', () => showBoard());
}

// ── the window's ✕ (CloseInterceptor) ───────────────────────────────────────────────────────────────────────────
app.on('before-quit', (e) => {
  quitting = true;
  // the store may hold the quit to ask first (its own before-quit handler); then the window still asks on ✕
  setImmediate(() => { if (e.defaultPrevented) quitting = false; });
});
function hookWindow(w) {
  if (snapshotRun) return;
  w.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    showBoard();
    w.webContents.send('close-request');
  });
}
app.on('browser-window-created', (_e, w) => hookWindow(w));

// ── MenuBarContent: live counts and the way back from background mode ───────────────────────────────────────────
function menuTemplate(s) {
  const all = [...(s.teams || []).flatMap((t) => t.members || []), ...(s.loose || [])];
  const live = all.filter((a) => a.state !== 'ended').length;
  const busy = all.filter((a) => a.state === 'busy').length;
  const items = [{ label: L('실행 중 %@ · 작업 중 %@', String(live), String(busy)), enabled: false }];
  const m = (s.meters || [])[0];
  if (m) items.push({ label: `${m.label.split('Current session').join(L('현재 세션'))} ${m.percent}%`, enabled: false });
  const store = storeModule();
  items.push(
    { type: 'separator' },
    { label: L('보드 열기'), accelerator: 'CmdOrCtrl+O', click: showBoard },
    { label: L('백그라운드로'), click: goBackground },
    { type: 'separator' },
    { label: L('앱만 종료 (세션 유지)'), click: () => (store && store.requestQuit ? store.requestQuit(false) : app.quit()) },
    { label: L('앱 + 세션 모두 종료'), click: () => (store && store.requestQuit ? store.requestQuit(true) : app.quit()) },
  );
  return items;
}
function rebuild(s) {
  if (!tray) return;
  const t = menuTemplate(s || {});
  const key = JSON.stringify(t.map((x) => x.label || '-'));
  if (key === lastMenuKey) return;   // the state is pushed often; the menu changes only with its texts
  lastMenuKey = key;
  tray.setContextMenu(Menu.buildFromTemplate(t));
}
function currentState() { const st = storeModule(); try { return st && st.getState ? st.getState() : {}; } catch { return {}; } }

/** MenuBarLabel: the app's mark (until the window draws it with the busy count, the app icon). */
function createTray() {
  if (tray || snapshotRun) return;
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png')).resize({ width: 22, height: 22 });
  tray = new Tray(icon);
  tray.setToolTip('Agent Boost');
  tray.on('click', showBoard);   // where the desktop sends clicks (others open the menu)
  rebuild(currentState());
  const st = storeModule();
  if (st && st.onChange) st.onChange((s) => rebuild(s));
}
app.whenReady().then(createTray);

/** The window drew the mark with the busy count (a PNG data URL): the tray shows it. */
function setImage(dataURL, busy) {
  if (!tray) return;
  const img = nativeImage.createFromDataURL(dataURL);
  if (!img.isEmpty()) tray.setImage(img.resize({ height: 22 }));
  tray.setToolTip(busy > 0 ? `Agent Boost (${busy})` : 'Agent Boost');
}
/** The language changed: the menu's texts again. */
function refresh() { lastMenuKey = ''; rebuild(currentState()); }

module.exports = { showBoard, goBackground, setImage, refresh };
