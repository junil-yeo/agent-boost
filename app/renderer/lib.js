// Shared renderer helpers: html`` templates (Preact + htm), the store state, calls into the main process, L().
import { h, render, Fragment, Component, createContext } from 'preact';
import { useState, useEffect, useRef, useMemo, useCallback, useLayoutEffect, useContext } from 'preact/hooks';
import htm from 'htm';

export const html = htm.bind(h);
export { h, render, Fragment, Component, createContext, useState, useEffect, useRef, useMemo, useCallback, useLayoutEffect, useContext };

/** Calls a main-process function: call('store.send', text, sid). */
export const call = (method, ...args) => window.api.call(method, ...args);
/** Subscribes to an event pushed by the main process. Returns the unsubscribe function. */
export const on = (channel, cb) => window.api.on(channel, cb);

// ── platform: the Mac uses ⌘ (as the Swift app), Linux uses Ctrl ─────────────────────────────────
export const isMac = window.api.platform === 'darwin';
if (isMac) document.documentElement.classList.add('mac');
/** The app's shortcut modifier is down: ⌘ alone on the Mac (Ctrl there is the terminal's / text field's), Ctrl (or the
 *  Super key) on Linux. */
export function modKey(e) { return isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey || e.metaKey; }
/** A shortcut text as the platform writes it. The Swift texts say ⌘; on Linux ⌘ is Ctrl (⌘⇧F → Ctrl+Shift+F,
 *  ⌘↩ → Ctrl+Enter, ⌘V → Ctrl+V). */
export function keys(s) {
  if (isMac) return s;
  return String(s).replace(/⌘(⇧)?(↩|[^\s)])/g, (_m, sh, k) => 'Ctrl+' + (sh ? 'Shift+' : '') + (k === '↩' ? 'Enter' : k));
}

// ── translations (same keys and files as the macOS app) ─────────────────────────────────
let table = {}, lang = null;
export async function loadL10n() { table = await call('l10n.table'); lang = await call('l10n.chosen'); }
export function setLang(l) { lang = l; }
export function currentLang() { return lang; }
export function L(k, ...args) {
  let s = k;
  if (lang && lang !== 'ko') { const row = table[k]; s = (row && (row[lang] || row.en)) || k; }
  args.forEach((a, i) => { s = s.split(`%${i + 1}$@`).join(String(a)); });
  let i = 0;
  return s.replace(/%@/g, (m) => (i < args.length ? String(args[i++]) : m));
}

// ── store state pushed by the main process (`state` events) ─────────────────────────────
let state = null;
const subs = new Set();
on('state', (s) => { state = s; subs.forEach((f) => f(s)); });
// the store pushes only on change: a page that (re)loads asks once so it does not wait for the next change
call('store.getState').then((s) => { if (s && !state) { state = s; subs.forEach((f) => f(s)); } }).catch(() => {});
export function getState() { return state; }
/** The latest store state; the component redraws on every update. */
export function useStore() {
  const frozen = useContext(Frozen);
  const fr = useRef(frozen); fr.current = frozen;
  const [s, set] = useState(state);
  useEffect(() => { const f = (st) => { if (!fr.current) set(st); }; subs.add(f); if (state && state !== s) set(state); return () => subs.delete(f); }, []);
  useEffect(() => { if (!frozen && state && state !== s) set(state); }, [frozen]);
  return s;
}
/** true inside a tab that is built but not on screen: useStore() there skips the store's pushes until the tab shows
 *  again (every hidden tab used to redraw on each push). Click handlers read getState() and stay current. */
export const Frozen = createContext(false);
/** Wraps a tab layer: hidden, it neither redraws from its parent nor from the store; shown, it catches up at once. */
export class Freeze extends Component {
  shouldComponentUpdate(next) { return !next.frozen || next.frozen !== this.props.frozen; }
  render({ frozen, children }) { return html`<${Frozen.Provider} value=${!!frozen}>${children}<//>`; }
}

// a main-process call that throws rejects here; nothing used to catch most of them, so the failure was invisible
window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason && (e.reason.message || String(e.reason));
  console.error('unhandled', e.reason);
  if (!msg || /setNotice/.test(msg)) return;
  call('store.setNotice', L('오류 — %@', msg.replace(/^Error invoking remote method 'call': Error: /, ''))).catch(() => {});
});
/** An agent by session id from the current state. */
export function agentOf(s, sid) {
  if (!s || !sid) return null;
  for (const t of s.teams || []) for (const m of t.members) if (m.sessionId === sid) return m;
  return (s.loose || []).find((a) => a.sessionId === sid) || null;
}
