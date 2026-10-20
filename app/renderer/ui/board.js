// The team detail screen's access to the store: the pushed state, chat entries on demand, store actions, and the
// @AppStorage values it reads. One place, so a dev fixture (renderer/dev/teamdetail.js) can stand in for the main
// process: with a fixture set, the views draw the fixture's state and actions only log ("[fixture] store.quit …").
import { useState, useEffect, useStore, getState, call } from '../lib.js';

let fixture = null;           // {state, chat: {sid: entries[]}, answers: {path: [{asked, answer}]}, notice?}
const fixtureSubs = new Set();

/** Installs (or with null removes) a fixture: its state replaces the store's, its actions are only logged. */
export function setFixture(f) { fixture = f; fixtureSubs.forEach((s) => s(f ? f.state : null)); }
export function isFixture() { return fixture != null; }
/** A fixture's option (dev only), e.g. 'transcriptChat': draw the rebuilt chat even for sessions with a live pane. */
export function fixtureOpt(name) { return fixture && fixture.options ? fixture.options[name] : undefined; }
/** Replaces the fixture's state (the views redraw). */
export function updateFixtureState(patch) {
  if (!fixture) return;
  fixture.state = { ...fixture.state, ...patch };
  fixtureSubs.forEach((s) => s(fixture.state));
}

/** The store's latest state (or the fixture's); redraws on every change. */
export function useBoard() {
  const real = useStore();
  const [fx, setFx] = useState(fixture ? fixture.state : null);
  useEffect(() => { fixtureSubs.add(setFx); return () => fixtureSubs.delete(setFx); }, []);
  return fixture ? fx || fixture.state : real;
}
/** The state now (for click handlers that must not subscribe). */
export function board() { return fixture ? fixture.state : getState(); }

/** An agent by session id. */
export function agentIn(s, sid) {
  if (!s || !sid) return null;
  for (const t of s.teams || []) for (const m of t.members || []) if (m.sessionId === sid) return m;
  return (s.loose || []).find((a) => a.sessionId === sid) || null;
}

// read-only calls a fixture answers itself
const fixtureReads = {
  'store.getDraft': (sid) => (fixture.drafts || {})[sid] || null,
  'store.takeLastSentDraft': () => null,
  'store.getState': () => fixture.state,
  'store.workingDirectory': (sid) => { const a = agentIn(fixture.state, sid); return a ? a.cwd : null; },
  'store.canSpawnTeammates': () => true,
  'store.send': () => true,
  'store.teammates': () => [],
  'suggest.prepare': () => ({ stamp: 'fixture', items: [], nav: fixture.history || [] }),
  'suggest.files': () => fixture.files || [],
  'slash.load': () => [],
  'slash.route': () => true,
  'attach.staged': (p) => p,
  'transcript.recentAnswers': (p, n) => ((fixture.answers || {})[p] || []).slice(0, n),
  'transcript.lastAnswer': (p) => { const r = (fixture.answers || {})[p] || []; return r.length ? r[0].answer : ''; },
  'shell.run': () => ({ code: 1, out: '', err: '' }),
};

/** call() with the fixture in mind: reads answered from the fixture, actions logged and not run. */
export async function act(method, ...args) {
  if (fixture) {
    const f = fixtureReads[method];
    if (f) return f(...args);
    console.log(`[fixture] ${method} ${JSON.stringify(args).slice(0, 200)}`);
    return undefined;
  }
  return call(method, ...args);
}

// ── chat entries (ChatEntry rows are not in the snapshot: asked for when chatVersion moves) ────────────────────────
const chatCache = new Map();    // sid -> {version, entries, loaded}
const chatWaiters = new Map();  // sid -> Promise
/** store.chat[sid]: {entries, loaded}; re-asked when the snapshot's chatVersion[sid] changes. `entries` is null while
 *  the store has none for this session (Swift: store.chat[sid] == nil). */
export function useChat(sid) {
  const s = useBoard();
  const version = s && s.chatVersion ? s.chatVersion[sid] || 0 : 0;
  const [, tick] = useState(0);
  useEffect(() => {
    if (!sid) return;
    if (fixture) return;
    const c = chatCache.get(sid);
    if (c && c.version === version) return;
    let live = true;
    let p = chatWaiters.get(sid + ':' + version);
    if (!p) {
      p = call('store.getChat', sid).then((r) => {
        const entries = r && r.loaded !== false ? r.entries || [] : null;
        chatCache.set(sid, { version: r ? r.version || version : version, entries });
        return r;
      }, () => null).finally(() => chatWaiters.delete(sid + ':' + version));
      chatWaiters.set(sid + ':' + version, p);
    }
    p.then(() => { if (live) tick((n) => n + 1); });
    return () => { live = false; };
  }, [sid, version]);
  if (!sid) return null;
  if (fixture) { const e = (fixture.chat || {})[sid]; return e === undefined ? null : e; }
  const c = chatCache.get(sid);
  return c ? c.entries : null;
}

// ── @AppStorage (renderer settings in localStorage under the Swift keys) ────────────────────────────────────────────
function readPref(key, def) {
  try {
    const v = localStorage.getItem(key);
    if (v == null) return def;
    if (typeof def === 'boolean') return v === 'true' || v === '1';
    if (typeof def === 'number') { const n = Number(v); return Number.isFinite(n) ? n : def; }
    return v;
  } catch { return def; }
}
/** Writes a setting and tells every useAppStorage(key) on the page. */
export function writePref(key, value) {
  try { localStorage.setItem(key, String(value)); } catch { /* storage unavailable */ }
  window.dispatchEvent(new CustomEvent('ab-appstorage', { detail: { key, value } }));
}
/** [value, set] for a localStorage key with a typed default (boolean / number / string), like @AppStorage. */
export function useAppStorage(key, def) {
  const [v, setV] = useState(() => readPref(key, def));
  useEffect(() => {
    const f = (e) => { if (!e.detail || e.detail.key === key) setV(readPref(key, def)); };
    const g = (e) => { if (e.key === key) setV(readPref(key, def)); };
    window.addEventListener('ab-appstorage', f); window.addEventListener('storage', g);
    return () => { window.removeEventListener('ab-appstorage', f); window.removeEventListener('storage', g); };
  }, [key]);
  return [v, (x) => writePref(key, x)];
}

/** The team detail screen's stylesheet, added once to <head> (theme.css stays shared and untouched). */
export function ensureStyles() {
  if (document.querySelector('link[data-ab-teamdetail]')) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet'; l.href = new URL('./teamdetail.css', import.meta.url).href; l.setAttribute('data-ab-teamdetail', '');
  document.head.appendChild(l);
}

// ── stray drops ────────────────────────────────────────────────────────────────────────────────────────────────────
/** A drop that no view takes does nothing (Swift ignores it). Chromium's own default would open a dropped file or link
 *  in the window, replacing the whole app (main.js also refuses that navigation). Bubble phase: the composer, the chats
 *  and the split-pane headers accept their drags first (they cancel dragover / drop themselves); text fields keep their
 *  own text drops. Installed once, by any view that uses this module (and callable from the app root). */
export function installDropGuard() {
  if (window.__abDropGuard) return;
  window.__abDropGuard = true;
  const editable = (t) => t instanceof Element && t.closest('textarea, input, [contenteditable=""], [contenteditable="true"]');
  const files = (e) => !!e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  window.addEventListener('dragover', (e) => {
    if (e.defaultPrevented || (editable(e.target) && !files(e))) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';     // the "not allowed" cursor, and no drop event
  });
  window.addEventListener('drop', (e) => {
    if (e.defaultPrevented || (editable(e.target) && !files(e))) return;
    e.preventDefault();
  });
}
installDropGuard();
