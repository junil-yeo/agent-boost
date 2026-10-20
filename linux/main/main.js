// Agent Boost for Linux — Electron main process.
// The renderer reaches the logic through one channel: api.call('<module>.<function>', ...args). Each module in this
// folder ports one Swift file of the macOS app (same function names, camelCase; an Agent argument becomes its sessionId).
// The store pushes its whole state to the window with send('state', snapshot) whenever it changes.
const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
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

function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600,
    backgroundColor: '#000000',
    title: 'Agent Boost',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: !process.env.AB_SNAPSHOT },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // links open in the system browser
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
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
  Menu.setApplicationMenu(null);
  // modules register themselves on load; the store starts its refresh loop
  const l10n = require('./l10n'); register('l10n', l10n);
  for (const m of ['shell', 'tmux', 'screen', 'transcript', 'search', 'suggest', 'slash', 'attach', 'todo', 'clicheck', 'store', 'platform', 'panes', 'cloud', 'tray']) {
    try { register(m, require('./' + m)); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND' || !String(e.message).includes(`'./${m}'`)) console.error(m, e); }
  }
  createWindow();
  if (modules.store && modules.store.start) modules.store.start();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!win) createWindow(); });
