// The menu-bar extra of the macOS app (App.swift MenuBarExtra: MenuBarContent + MenuBarLabel) as an Electron Tray, and
// the parts of AppDelegate that are about the window: background mode (window hidden, sessions and monitoring keep
// running, the tray icon brings it back), one board at a time (a second launch brings the running one forward), and
// the window's ✕ asking what to do (CloseInterceptor; the renderer shows the question on 'close-request').
// The quit itself (AppDelegate.applicationShouldTerminate) is the store's 'quit-request' flow.
const { app, Tray, Menu, nativeImage, BrowserWindow } = require('electron');
const path = require('path');
const { L } = require('./l10n');

const snapshotRun = !!process.env.AB_SNAPSHOT || process.argv.includes('--snapshot');
const isMac = process.platform === 'darwin';
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
/** Back to the user: window shown and in front (macOS: the Dock icon back too — setActivationPolicy(.regular) — and
 *  the app activated over the others). */
function showBoard() {
  if (isMac && app.dock) { try { app.dock.show(); } catch { } }
  const w = mainWindow();
  if (!w) return;
  if (w.isMinimized()) w.restore();
  w.show(); w.focus();
  if (isMac) { try { app.focus({ steal: true }); } catch { } }
}
/** Background: window hidden; sessions, monitoring and the tray icon keep running (macOS: no Dock icon either —
 *  setActivationPolicy(.accessory)). */
function goBackground() {
  const w = mainWindow();
  if (w) w.hide();
  if (isMac && app.dock) { try { app.dock.hide(); } catch { } }
}

// ── one board at a time (AppDelegate.enforceSingleInstance) ─────────────────────────────────────────────────────
// Two boards would double-send commands and fight over sessions. A lock file decides, whatever the launch path, and it
// is the Swift app's own ~/.agent-boost/app.lock (flock + pid), so the macOS app and this one exclude each other too.
// The holder is brought forward and this launch exits — unless the holder is a stale build (running since before this
// build's files were written), which is replaced instead. Electron's own single-instance lock stays as well: a second
// launch of this app reaches the running one through it ('second-instance'). (Self-test snapshots run side by side.)
// AB_READONLY: ~/.agent-boost is not touched, so app.lock is left alone (the Swift app may be running beside a
// development run) unless BOARD_HOME points the app at a test home.
const showNote = 'local.junil.agentboost.show';   // the Swift app's DistributedNotification for "bring the board forward"
/** When this build was made: the app archive's time, or the newest of the app's own code files. */
function builtAt() {
  const fs = require('fs');
  try {
    const root = app.getAppPath(), st = fs.statSync(root);
    if (st.isFile()) return st.mtimeMs;                                 // app.asar
    const files = [path.join(root, 'package.json')].concat(fs.readdirSync(__dirname).filter((f) => f.endsWith('.js')).map((f) => path.join(__dirname, f)));
    return Math.max(0, ...files.map((f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }));
  } catch { return 0; }
}
/** The holder comes forward (Swift: the show notification plus holder.activate(); this app's own holder also hears
 *  'second-instance'). */
function bringForward(pid) {
  if (!isMac) return;
  // (the notification reaches every board on the Mac; a BOARD_HOME test run must not call the user's real one forward)
  if (!process.env.BOARD_HOME) { try { require('electron').systemPreferences.postNotification(showNote, {}, true); } catch { } }
  try {
    require('child_process').spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e',
      `ObjC.import('AppKit'); const a = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${Number(pid)}); if (a) a.activateWithOptions(2);`], { timeout: 3000, stdio: 'ignore' });
  } catch { }
}
/** true = this launch goes on; false = another board runs (it was brought forward) and this one must exit. */
function enforceSingleInstance() {
  // (with BOARD_HOME the lock lives in that test home, not in ~/.agent-boost, so it is taken even then)
  if (process.env.AB_READONLY && !process.env.BOARD_HOME) { console.log('[readonly] app.lock (one board at a time) not taken'); return true; }
  const platform = require('./platform');
  const built = builtAt();
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = platform.takeAppLock();
    if (r.ok !== false) return true;                 // taken (or no way to try it: Electron's lock below still applies)
    const pid = r.holder;
    if (!pid) return true;                           // Swift: no readable holder — go on
    const started = platform.processStarted(pid);
    if (started == null) return true;                // the holder is gone
    const stale = started < built;
    if (!stale || attempt === 1) { console.log(`[app] another board is running (pid ${pid}): brought forward, this launch exits`); bringForward(pid); return false; }
    console.log(`[app] replacing a board that runs an older build (pid ${pid})`);
    platform.terminateHolder(pid);
  }
  return true;
}
if (!snapshotRun) {
  if (!enforceSingleInstance()) { app.requestSingleInstanceLock(); app.exit(0); }
  else if (!app.requestSingleInstanceLock()) app.exit(0);
  else {
    app.on('second-instance', () => showBoard());
    // a Swift-app launch that found this board holding app.lock asks it to come forward this way
    if (isMac) { try { require('electron').systemPreferences.subscribeNotification(showNote, () => showBoard()); } catch { } }
  }
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

// ── MenuBarLabel.mark on macOS: the app's mark as a template image (macOS tints it for the menu bar, dark or light,
// like its own icons). BoostLogo drawn black in 16 pt with 1 pt padding at 2x: a 36×36 px bitmap, 18×18 pt. Drawn here
// (no canvas in the main process): coverage of the logo's shapes, 4×4 samples per pixel.
const LOGO = (() => {
  const pts = [[27, 100], [27, 56]];
  const quad = (p0, c, p1) => { for (let i = 1; i <= 24; i++) { const t = i / 24, u = 1 - t; pts.push([u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1]]); } };
  quad([27, 56], [27, 22], [50, 6]);
  quad([50, 6], [73, 22], [73, 56]);
  pts.push([73, 100]);
  // the miter at the top (lineJoin .miter): the outer corners of the two strokes and the tip where their edges meet
  const n = (dx, dy, sgn) => { const l = Math.hypot(dx, dy); return [sgn * dy / l * 7.5, -sgn * dx / l * 7.5]; };
  const a = n(23, -16, 1), b = n(23, 16, 1);
  const half = Math.acos(((-23) * 23 + 16 * 16) / (23 * 23 + 16 * 16)) / 2;
  const tip = [50, 6 - 7.5 / Math.sin(half)];
  const miter = [[50, 6], [50 + a[0], 6 + a[1]], tip, [50 + b[0], 6 + b[1]]];
  const fins = [[[27, 70], [6, 90], [6, 100], [27, 100]], [[73, 70], [94, 90], [94, 100], [73, 100]]];
  return { pts, miter, fins };
})();
function inPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function nearPolyline(x, y, pts, r) {
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    if (Math.hypot(x - (ax + t * dx), y - (ay + t * dy)) <= r) return true;
  }
  return false;
}
function inLogo(u, v) {
  if (u < -10 || u > 110 || v < -10 || v > 100) return false;               // v > 100: the legs' butt ends
  if (Math.hypot(u - 50, v - 56) <= 8.5) return true;
  if (LOGO.fins.some((f) => inPolygon(u, v, f))) return true;
  if (inPolygon(u, v, LOGO.miter)) return true;
  return nearPolyline(u, v, LOGO.pts, 7.5);
}
function templateMark() {
  const W = 36, pad = 2, scale = 32 / 100, ss = 4;
  const buf = Buffer.alloc(W * W * 4);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      let hit = 0;
      for (let j = 0; j < ss; j++) for (let i = 0; i < ss; i++) {
        if (inLogo((x + (i + 0.5) / ss - pad) / scale, (y + (j + 0.5) / ss - pad) / scale)) hit++;
      }
      buf[(y * W + x) * 4 + 3] = Math.round((hit / (ss * ss)) * 255);       // BGRA: black, the coverage as alpha
    }
  }
  const img = nativeImage.createFromBitmap(buf, { width: W, height: W, scaleFactor: 2 });
  img.setTemplateImage(true);
  return img;
}

/** MenuBarLabel: the app's mark (macOS: the template mark and the busy count as the item's title; Linux: until the
 *  window draws it with the busy count, the app icon). */
function createTray() {
  if (tray || snapshotRun) return;
  const icon = isMac ? templateMark() : nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png')).resize({ width: 22, height: 22 });
  tray = new Tray(icon);
  tray.setToolTip('Agent Boost');
  // where the desktop sends clicks (others open the menu); on macOS a click opens the menu, as a MenuBarExtra does
  if (!isMac) tray.on('click', showBoard);
  rebuild(currentState());
  const st = storeModule();
  if (st && st.onChange) st.onChange((s) => rebuild(s));
}
app.whenReady().then(createTray);

/** The window drew the mark with the busy count (a PNG data URL): the tray shows it. */
function setImage(dataURL, busy) {
  if (!tray) return;
  if (isMac) { tray.setTitle(busy > 0 ? String(busy) : ''); return; }   // the mark stays the template image
  const img = nativeImage.createFromDataURL(dataURL);
  if (!img.isEmpty()) tray.setImage(img.resize({ height: 22 }));
  tray.setToolTip(busy > 0 ? `Agent Boost (${busy})` : 'Agent Boost');
}
/** The language changed: the menu's texts again. */
function refresh() { lastMenuKey = ''; rebuild(currentState()); }

module.exports = { showBoard, goBackground, setImage, refresh, templateMark };
