// Dev fixture: each sheet of CreateViews.swift and ConvoSearch.swift.
// hash: sheet (new|cloud|add|resume|search), theme (dark|light), lang (ko|en|…), team (1: the teammate block open in "new").
// "add" / "resume" draw against a fixture agent (board.js setFixture: store actions are only logged). "new", "cloud" and
// "search" use the real main process (gh repo list, the conversation index) — read only.
import { html, render, loadL10n, setLang } from '../lib.js';
import { applyAppearance } from '../ui/widgets.js';
import { setFixture } from '../ui/board.js';
import { NewSessionSheet, AddTeammateSheet, ResumeSheet } from '../ui/sheets.js';
import { ConvoSearchSheet } from '../ui/search.js';

const p = new URLSearchParams(location.hash.slice(1));
const sheet = p.get('sheet') || 'new';
applyAppearance(p.get('theme') || 'dark', true);
const close = () => console.log('[dev] sheet closed');
const agent = {
  sessionId: 'fixture-0001', name: '논문 그림 리뷰', model: 'claude-haiku-4-5', effort: 'high', state: 'busy', isLead: true,
  teamName: 'paper', cwd: '/Users/Junil/Desktop/agent_bridge', tmuxPane: '%999',
};
if (sheet === 'add' || sheet === 'resume') setFixture({ state: { teams: [{ name: 'paper', members: [agent] }], loose: [] } });
try {
  localStorage.setItem('new.cloud', sheet === 'cloud' ? 'true' : 'false');
  if (p.get('query') != null) localStorage.setItem('search.query', p.get('query'));
} catch { }

loadL10n().then(() => {
  if (p.get('lang')) setLang(p.get('lang'));
  const body = sheet === 'add' ? html`<${AddTeammateSheet} sid=${agent.sessionId} onClose=${close} />`
    : sheet === 'resume' ? html`<${ResumeSheet} sid=${agent.sessionId} onClose=${close} />`
      : sheet === 'search' ? html`<${ConvoSearchSheet} onClose=${close} />`
        : html`<${NewSessionSheet} onClose=${close} />`;
  render(html`<div style=${{ height: '100vh', background: 'var(--base)' }}>${body}</div>`, document.getElementById('root'));
  if (p.get('team')) setTimeout(() => { const s = [...document.querySelectorAll('.switch input')][0]; if (s) s.click(); }, 300);
});
