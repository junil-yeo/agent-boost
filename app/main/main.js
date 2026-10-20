// Agent Boost (macOS and Linux) — Electron main process.
// The renderer reaches the logic through one channel: api.call('<module>.<function>', ...args). Each module in this
// folder ports one Swift file of the macOS app (same function names, camelCase; an Agent argument becomes its sessionId).
// The store pushes its whole state to the window with send('state', snapshot) whenever it changes.
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');

const modules = {};
/** Registers a module's exported functions as callable from the renderer: register('tmux', require('./tmux')). */
function register(name, mod) { modules[name] = mod; }

let win = null;
/** Sends an event to the window (no-op before it exists). */
function send(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }

ipcMain.handle('call', async (_e, method, args) => {
  const dot = method.indexOf('.');
  // the page never runs commands directly: the shell module is for the main process only
  if (method.slice(0, dot) === 'shell') throw new Error(`not callable from the page: ${method}`);
  const mod = modules[method.slice(0, dot)];
  const fn = mod && mod[method.slice(dot + 1)];
  if (typeof fn !== 'function') throw new Error(`unknown method ${method}`);
  return await fn.apply(mod, args || []);
});

const isMac = process.platform === 'darwin';
const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');

const rendererDir = path.join(__dirname, '..', 'renderer') + path.sep;
/** True for a file:// URL of an HTML page inside the renderer folder (the app's pages, dev fixture pages included). */
function isOwnPage(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'file:') return false;
    const p = path.normalize(require('url').fileURLToPath(u));
    return p.startsWith(rendererDir) && /\.html$/i.test(p);
  } catch { return false; }
}
/** Opens a link outside the app. Local files, scripts and inline data never leave through here (a dropped file must
 *  not be opened either); every other scheme (https, mailto, an editor's own scheme …) goes to the system. */
function openOutside(url) {
  if (/^(file|javascript|data|blob|about|chrome|devtools):/i.test(url)) return;
  shell.openExternal(url).catch(() => { });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600,
    backgroundColor: '#000000',
    title: 'Agent Boost',
    // macOS: the Swift window's .windowStyle(.hiddenTitleBar): no title bar, the content runs to the top edge and the
    // close / minimise / zoom buttons sit at their standard place over the banner's top-left corner (the name block
    // starts below them). 'hidden' keeps that standard place, as SwiftUI does; the banner is the drag area (app.css).
    ...(isMac ? { titleBarStyle: 'hidden' } : { icon: iconPath, autoHideMenuBar: true }),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: !process.env.AB_SNAPSHOT },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // links open in the system browser
  win.webContents.setWindowOpenHandler(({ url }) => { openOutside(url); return { action: 'deny' }; });
  // The window never leaves the app's own pages. A file dropped where no handler takes it makes Chromium navigate the
  // window to file:///… (the whole UI replaced by the file); the Swift app simply ignores such a drop. Only the
  // renderer's own files (index.html and the AB_SNAPSHOT dev pages under renderer/dev) may be loaded; a web link that
  // tries to replace the page goes to the system browser instead.
  win.webContents.on('will-navigate', (e, url) => { if (!isOwnPage(url)) { e.preventDefault(); openOutside(url); } });
  win.webContents.on('will-redirect', (e, url) => { if (!isOwnPage(url)) e.preventDefault(); });
  win.on('closed', () => { win = null; });
  // AB_SNAPSHOT=/path/shot.png [AB_SNAPSHOT_JS="…"] [AB_SNAPSHOT_DELAY=ms]: run the JS in the page, save the window as
  // PNG and quit. For checking screens without a display session; the app's own windows are untouched.
  if (process.env.AB_DEBUG) {
    win.webContents.on('render-process-gone', (_e, d) => console.log('[main] renderer gone:', JSON.stringify(d)));
    win.webContents.on('did-navigate', (_e, url) => console.log('[main] navigated:', url));
    win.webContents.on('did-navigate-in-page', (_e, url) => console.log('[main] in-page:', url));
  }
  // page errors and console output reach the terminal (useful while developing; harmless otherwise)
  win.webContents.on('console-message', (_e, level, message, line, src) => { if (level >= 2 || process.env.AB_DEBUG) console.log(`[renderer] ${message} (${src}:${line})`); });
  if (process.env.AB_SNAPSHOT) {
    // AB_SNAPSHOT_STEPS='[[ms, "js"], …]': after load, wait ms then run js, step by step; then wait the delay and capture.
    // Armed once: a step that navigates to another page does not start a second capture.
    let armed = false;
    win.webContents.on('did-finish-load', async () => {
      if (armed) return;
      armed = true;
      const w = win;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      if (process.env.AB_SNAPSHOT_JS) { try { await w.webContents.executeJavaScript(process.env.AB_SNAPSHOT_JS); } catch (e) { console.error(e); } }
      for (const [ms, js] of JSON.parse(process.env.AB_SNAPSHOT_STEPS || '[]')) {
        await sleep(ms);
        try { await w.webContents.executeJavaScript(js); } catch (e) { console.error('step failed:', e.message); }
      }
      await sleep(Number(process.env.AB_SNAPSHOT_DELAY || 2500));
      if (!w || w.isDestroyed()) return app.exit(1);
      w.webContents.invalidate(); await sleep(300);       // a fresh frame, not the last one painted
      const img = await w.webContents.capturePage();
      require('fs').writeFileSync(process.env.AB_SNAPSHOT, img.toPNG());
      app.exit(0);
    });
  }
}

module.exports = { register, send, get window() { return win; } };

// snapshot runs: keep painting while the window is behind others (an occluded window stops drawing, and the capture
// then showed an old frame or black)
if (process.env.AB_SNAPSHOT) {
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
}
app.whenReady().then(() => {
  // macOS: the standard menu bar (Edit makes ⌘C ⌘V ⌘X ⌘A ⌘Z work in text fields; View has the Swift app's commands).
  // Linux: no menu bar.
  const appmenu = require('./appmenu');
  appmenu.install();
  register('appmenu', appmenu);
  if (isMac) {
    app.setAboutPanelOptions({ applicationName: 'Agent Boost', applicationVersion: app.getVersion() });
    if (app.dock) { try { app.dock.setIcon(iconPath); } catch { } }   // a development run would show Electron's icon
  }
  // modules register themselves on load; the store starts its refresh loop
  const l10n = require('./l10n'); register('l10n', l10n);
  for (const m of ['shell', 'tmux', 'screen', 'transcript', 'search', 'suggest', 'slash', 'attach', 'todo', 'clicheck', 'store', 'platform', 'panes', 'cloud', 'tray']) {
    try { register(m, require('./' + m)); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND' || !String(e.message).includes(`'./${m}'`)) console.error(m, e); }
  }
  // log.note(text): the page's SendLog lines (the composer's open / close / send trail, TeamDetailView.swift) go to the
  // same send log as the main process's (tmux.SendLog; with AB_READONLY it lives in the temp folder)
  register('log', { note: (s) => { try { require('./tmux').SendLog.note(String(s)); } catch { } return true; } });
  createWindow();
  if (modules.store && modules.store.start) modules.store.start();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
// a Dock icon click (or a second launch) brings the board back (AppDelegate.applicationShouldHandleReopen)
app.on('activate', () => {
  if (!win) { createWindow(); return; }
  const tray = modules.tray;
  if (tray && tray.showBoard) tray.showBoard();
  else { win.show(); win.focus(); }
});
