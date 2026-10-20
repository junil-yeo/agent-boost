// The application menu. On the Mac it is the menu bar the Swift app has (AgentBoostApp.commands on top of SwiftUI's
// standard menus): the app menu (About, Services, Hide, Hide Others, Show All, Quit ⌘Q through the store's quit flow),
// Edit (so ⌘C ⌘V ⌘X ⌘A ⌘Z work in text fields), View (CommandGroup(after: .toolbar): chat text bigger / smaller /
// default ⌘= ⌘- ⌘0, appearance, notices, terminal-style chat, CLI suggestions, Claude Code update) and Window.
// The View items act in the window (the settings are the page's localStorage, as @AppStorage): the menu sends
// 'menu' {action, value} and the page runs the same code its ≡ menu runs; the page reports the current values back
// (setViewState) so the check marks are right.
// On Linux there is no menu bar (the ≡ button in the tab row carries the View items), as before.
const { app, Menu, nativeTheme } = require('electron');
const { L } = require('./l10n');

const isMac = process.platform === 'darwin';
let view = { appearance: 'dark', showNotices: true, termChat: true, cliSuggest: true };

function mainModule() { try { return require('./main'); } catch { return null; } }
function storeModule() { try { return require('./store'); } catch { return null; } }
/** A View item was picked: the page does it (its settings live there). */
function toPage(action, value) {
  const m = mainModule();
  if (!m) return;
  const tray = (() => { try { return require('./tray'); } catch { return null; } })();
  if (tray && tray.showBoard && m.window && !m.window.isVisible()) tray.showBoard();
  m.send('menu', { action, value });
}

const APPEARANCE_TITLES = { system: '시스템 설정 따르기', dark: '다크', light: '화이트' };

function template() {
  const name = 'Agent Boost';
  return [
    {
      label: name,
      submenu: [
        { label: L('Agent Boost에 관하여'), role: 'about' },
        { type: 'separator' },
        { label: L('서비스'), role: 'services' },
        { type: 'separator' },
        { label: L('Agent Boost 가리기'), role: 'hide' },
        { label: L('기타 가리기'), role: 'hideOthers' },
        { label: L('모두 보기'), role: 'unhide' },
        { type: 'separator' },
        // ⌘Q as AppDelegate.applicationShouldTerminate: no choice made yet, so the store asks (sessions too / app only)
        { label: L('Agent Boost 종료'), accelerator: 'Command+Q', click: () => { const s = storeModule(); if (s && s.requestQuit) s.requestQuit(null); else app.quit(); } },
      ],
    },
    {
      label: L('편집'),
      submenu: [
        { label: L('실행 취소'), role: 'undo' },
        { label: L('실행 복귀'), role: 'redo' },
        { type: 'separator' },
        { label: L('오려두기'), role: 'cut' },
        { label: L('복사하기'), role: 'copy' },
        { label: L('붙여넣기'), role: 'paste' },
        { label: L('모두 선택'), role: 'selectAll' },
      ],
    },
    {
      label: L('보기'),
      submenu: [
        { label: L('대화 글자 크게'), accelerator: 'Command+=', click: () => toPage('fontBigger') },
        { label: L('대화 글자 작게'), accelerator: 'Command+-', click: () => toPage('fontSmaller') },
        { label: L('대화 글자 기본'), accelerator: 'Command+0', click: () => toPage('fontReset') },
        { type: 'separator' },
        {
          label: L('화면 모드'),
          submenu: ['system', 'dark', 'light'].map((m) => ({
            label: L(APPEARANCE_TITLES[m]), type: 'radio', checked: view.appearance === m, click: () => toPage('appearance', m),
          })),
        },
        { label: L('알림 표시'), type: 'checkbox', checked: !!view.showNotices, click: () => toPage('showNotices', !view.showNotices) },
        { label: L('터미널식 대화 표시 (가벼움)'), type: 'checkbox', checked: !!view.termChat, click: () => toPage('termChat', !view.termChat) },
        { label: L('CLI 다음 입력 제안 켜기 (새로 시작하는 세션부터)'), type: 'checkbox', checked: !!view.cliSuggest, click: () => toPage('cliSuggest', !view.cliSuggest) },
        { type: 'separator' },
        { label: L('Claude Code 업데이트'), click: () => { const s = storeModule(); if (s && s.updateClaude) s.updateClaude(); } },
        { type: 'separator' },
        { label: L('전체 화면 시작/종료'), role: 'togglefullscreen' },
      ],
    },
    {
      label: L('윈도우'),
      role: 'windowMenu',
      submenu: [
        { label: L('최소화'), role: 'minimize' },
        { label: L('확대/축소'), role: 'zoom' },
        { type: 'separator' },
        { label: L('모두 앞으로 가져오기'), role: 'front' },
        { type: 'separator' },
        // ⌘W: the window's close, which asks first (CloseInterceptor; main/tray.js holds the close)
        { label: L('닫기'), role: 'close' },
      ],
    },
  ];
}

/** Builds (or rebuilds) the application menu. Linux: none. */
function install() {
  if (!isMac) { Menu.setApplicationMenu(null); return; }
  Menu.setApplicationMenu(Menu.buildFromTemplate(template()));
}
/** The page's View settings changed (or were read at start): new check marks; the window's appearance follows the
 *  chosen mode like NSApp.appearance (native menus, dialogs and the title-bar buttons too). */
function setViewState(v) {
  if (!v || typeof v !== 'object') return;
  view = { ...view, ...v };
  if (isMac && ['system', 'dark', 'light'].includes(view.appearance)) nativeTheme.themeSource = view.appearance;
  install();
}
/** The language changed: the menu's texts again. */
function refresh() { install(); }

module.exports = { install, setViewState, refresh };
