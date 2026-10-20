// Shared renderer helpers: html`` templates (Preact + htm), the store state, calls into the main process, L().
import { h, render, Fragment } from 'preact';
import { useState, useEffect, useRef, useMemo, useCallback, useLayoutEffect } from 'preact/hooks';
import htm from 'htm';

export const html = htm.bind(h);
export { h, render, Fragment, useState, useEffect, useRef, useMemo, useCallback, useLayoutEffect };

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
  const [s, set] = useState(state);
  useEffect(() => { subs.add(set); if (state && state !== s) set(state); return () => subs.delete(set); }, []);
  return s;
}
/** An agent by session id from the current state. */
export function agentOf(s, sid) {
  if (!s || !sid) return null;
  for (const t of s.teams || []) for (const m of t.members) if (m.sessionId === sid) return m;
  return (s.loose || []).find((a) => a.sessionId === sid) || null;
}
