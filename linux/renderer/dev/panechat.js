// Dev fixture: PaneChatView and TerminalPanel over a throwaway tmux pane (never a real session).
// Open with AB_SNAPSHOT_JS="if(!location.pathname.includes('/dev/'))location.href='dev/panechat.html#pane=%81&theme=dark&lang=ko'"
// hash: pane (tmux pane id of an abtest-* session), theme (dark|light), lang (ko|en|…), view (both|chat|term), scroll (px from the top of the CLI screen).
import { html, render, loadL10n, setLang } from '../lib.js';
import { applyAppearance } from '../ui/widgets.js';
import { PaneChatView, TerminalPanel } from '../ui/panechat.js';

const p = new URLSearchParams(location.hash.slice(1));
const pane = p.get('pane') || '';
applyAppearance(p.get('theme') || 'dark', true);
if (!/^%[0-9]+$/.test(pane)) throw new Error('dev/panechat: pane=%N required');

loadL10n().then(() => {
  if (p.get('lang')) setLang(p.get('lang'));
  const view = p.get('view') || 'both';
  render(html`<div style=${{ display: 'flex', gap: 'var(--gap)', padding: 'var(--gap)', height: '100vh', boxSizing: 'border-box', background: 'var(--base)' }}>
    ${view !== 'term' ? html`<div class="area-box" style=${{ flex: '1 1 0', display: 'flex', minWidth: 0, overflow: 'hidden' }}><${PaneChatView} pane=${pane} sid="abtest" /></div>` : null}
    ${view !== 'chat' ? html`<div class="area-box" style=${{ flex: '1 1 0', display: 'flex', minWidth: 0, overflow: 'hidden' }}><${TerminalPanel} pane=${pane} title="abtest-pane" onClose=${() => console.log('close')} /></div>` : null}
  </div>`, document.getElementById('root'));
  if (p.get('select')) {                       // select one line of the screen (selection-hold check)
    const t = setInterval(() => {
      const n = document.querySelectorAll('.pane-text .pt-ln')[7];
      if (!n) return;
      clearInterval(t);
      const r = document.createRange(); r.selectNodeContents(n); getSelection().removeAllRanges(); getSelection().addRange(r);
      console.log('[dev] selected:', String(getSelection()));
    }, 200);
  }
});
