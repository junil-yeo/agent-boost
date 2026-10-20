// Shared UI pieces, ported from the SwiftUI helpers every view uses: Theme.swift (button styles, CountBadge, Avatar,
// LazyMenu, areaBox, cardSurface), Format.swift (Chip, StateDot), App.swift (TabButton), UsageBanner.swift /
// Instruments.swift (ChaseRing, BootClock, BoostLogo), TurnStatus.swift (Spinner line), plus the macOS controls the
// views take from AppKit (Menu, Picker, Toggle, sheet, confirmationDialog, alert with a text field, popover,
// ProgressView, ContentUnavailableView).
//
// All components are Preact function components; use them with html`` from ../lib.js:
//   html`<${Button} kind="raisedCompact" help=${L('…')} onClick=${f}><${Label} icon="power" title=${L('깨우기')} /><//>`
// Colours are CSS colour strings; pass theme tokens as 'var(--accent)' etc. (theme.css lists them). `help` = the
// SwiftUI .help() tooltip (the title attribute). The full API is listed at the end of this file's header comment in
// the report and in each component's doc comment.
import { html, render, h, Fragment, useState, useEffect, useRef, useLayoutEffect, useMemo, L } from '../lib.js';
import { iconMarkup, iconStroke, nextMaskId } from './icons.js';
import { Fmt, Spinner } from '../fmt.js';

const cx = (...a) => a.filter(Boolean).join(' ');

// ── appearance (AppearanceMode, App.applyAppearance) ───────────────────────────────────────────────────────────────

/** Window appearance: follows the system, or forced dark / light. Stored in localStorage 'ui.appearance' (default dark). */
export const AppearanceMode = {
  all: ['system', 'dark', 'light'],
  title(m) { return m === 'dark' ? L('다크') : m === 'light' ? L('화이트') : L('시스템 설정 따르기'); },
  get() { try { const v = localStorage.getItem('ui.appearance'); return AppearanceMode.all.includes(v) ? v : 'dark'; } catch { return 'dark'; } },
};
const appearanceSubs = new Set();
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
/** Applies a mode to <html data-theme> ('system' removes it so the CSS follows prefers-color-scheme). Stores it when
 *  `store` is true. Every useAppearance() hook redraws. */
export function applyAppearance(mode = AppearanceMode.get(), store = false) {
  if (!AppearanceMode.all.includes(mode)) mode = 'dark';
  if (store) { try { localStorage.setItem('ui.appearance', mode); } catch { /* storage unavailable */ } }
  if (mode === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', mode);
  appearanceSubs.forEach((f) => f());
}
/** True when the window is drawn dark now (forced dark, or system mode on a dark system). */
export function isDarkNow() { const m = AppearanceMode.get(); return m === 'dark' || (m === 'system' && darkQuery.matches); }
darkQuery.addEventListener('change', () => appearanceSubs.forEach((f) => f()));
/** [mode, setMode(m), isDark] — setMode stores and applies. */
export function useAppearance() {
  const [, tick] = useState(0);
  useEffect(() => { const f = () => tick((n) => n + 1); appearanceSubs.add(f); return () => appearanceSubs.delete(f); }, []);
  return [AppearanceMode.get(), (m) => applyAppearance(m, true), isDarkNow()];
}

// ── portal (renders children into a container on <body>, so fixed layers escape every clip and transform) ───────────

/** Renders its children into a fresh <div> appended to <body>. */
export function Portal({ children }) {
  const box = useMemo(() => { const d = document.createElement('div'); d.className = 'portal'; document.body.appendChild(d); return d; }, []);
  useLayoutEffect(() => { render(h(Fragment, null, children), box); });
  useEffect(() => () => { render(null, box); box.remove(); }, []);
  return null;
}

// ── icons and labels ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * An SF Symbol by its Swift name, drawn as an inline SVG (icons.js maps it to a Lucide shape).
 * props: name (SF name), size (px; default 1.05em, i.e. follows the font size like an SF Symbol), color (CSS colour;
 * default currentColor), strokeWidth (default 2; 'bold' look: 2.5), class, style, help (tooltip).
 */
export function Icon({ name, size, color, strokeWidth, class: cls, style, help }) {
  const mask = useRef(null);
  if (!mask.current) mask.current = nextMaskId();
  const st = { ...(size ? { width: `${size}px`, height: `${size}px` } : null), ...(color ? { color } : null), ...style };
  return h('svg', {
    class: cx('icon', cls), style: st, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': strokeWidth || iconStroke(name), 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    'aria-hidden': help ? undefined : 'true', dangerouslySetInnerHTML: { __html: (help ? `<title>${escapeHTML(help)}</title>` : '') + iconMarkup(name, mask.current) },
  });
}
const escapeHTML = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/**
 * SwiftUI Label(title, systemImage:): icon then text. props: icon (SF name), title (or children), iconOnly
 * (.labelStyle(.iconOnly): the title becomes the tooltip), iconColor, iconSize, gap (px, default 5), class, style, help.
 */
export function Label({ icon, title, children, iconOnly, iconColor, iconSize, gap, class: cls, style, help }) {
  const text = title != null ? title : children;
  return html`<span class=${cx('label', cls)} style=${{ ...(gap != null ? { gap: `${gap}px` } : null), ...style }} title=${help || (iconOnly && typeof text === 'string' ? text : undefined)}>
    ${icon ? html`<${Icon} name=${icon} color=${iconColor} size=${iconSize} />` : null}
    ${iconOnly ? null : html`<span class="label-text">${text}</span>`}
  </span>`;
}

// ── buttons ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A button in one of the Swift styles.
 * kind:
 *   'raised' | 'raisedCompact' | 'raisedProminent'   RaisedButtonStyle (.raised / .raisedCompact / .raisedProminent);
 *                                                     `active` = selected (accent face), `minHeight` overrides
 *   'tab'          TabFaceStyle — `raised` (the open tab), `strong` (새 세션, accent-tinted chip), `small` (GitHub link)
 *   'quiet'        QuietButtonStyle — `active`
 *   'icon'         IconButtonStyle (.icon)
 *   'editorTab'    EditorTabStyle — `active`
 *   'key'          RefreshButton's lamp-sized key
 *   'plain'        .plain (no chrome; default)
 * Other props: onClick, disabled, help (tooltip), destructive (red text, raised kinds), class, style, type, children.
 * Any further props (onContextMenu, onMouseDown, ref …) pass through to the <button>.
 */
export function Button({ kind = 'plain', active, prominent, compact, raised, strong, small, destructive, minHeight, help, disabled, class: cls, style, children, type = 'button', ...rest }) {
  const k = {
    raised: 'btn-raised', raisedCompact: 'btn-raised compact', raisedProminent: 'btn-raised prominent', tab: 'btn-tab',
    quiet: 'btn-quiet', icon: 'btn-icon', editorTab: 'btn-editor-tab', key: 'btn-key', plain: 'btn-plain',
  }[kind] || 'btn-plain';
  return html`<button type=${type} class=${cx('btn', k, active && 'active', prominent && 'prominent', compact && 'compact', raised && 'raised', strong && 'strong', small && 'small', destructive && 'destructive', cls)}
    style=${{ ...(minHeight ? { minHeight: `${minHeight}px` } : null), ...style }} title=${help} disabled=${disabled} ...${rest}>${children}</button>`;
}

/**
 * The tab row's button (App.swift TabButton): icon, title, a raised hand when a session waits for an answer, and the
 * count badge beside the label. `quiet` = QuietButtonStyle look (보관함), otherwise TabFaceStyle(raised: active).
 * props: title, icon, active, count (0 = none), attention, quiet, onClick, help.
 */
export function TabButton({ title, icon, active, count = 0, attention, quiet, onClick, help }) {
  return html`<${Button} kind=${quiet ? 'quiet' : 'tab'} active=${quiet && active} raised=${!quiet && active} onClick=${onClick} help=${help} style=${{ gap: '6px' }}>
    <${Icon} name=${icon} />
    <span class="one-line">${title}</span>
    ${attention ? html`<${Icon} name="hand.raised.fill" class="t-caption" color="var(--attention)" help=${L('응답을 기다리는 세션이 있습니다')} style=${{ width: '11px', height: '11px' }} />` : null}
    ${count > 0 ? html`<${CountBadge} count=${count} tint=${active ? 'var(--accent)' : 'var(--surface2)'} fg=${active ? '#fff' : 'var(--fg)'} />` : null}
  <//>`;
}

// ── chips, badges, dots, avatar ────────────────────────────────────────────────────────────────────────────────────

/**
 * Chip(text:tint:) — a one-line tag with a 14 % wash of its tint and a 35 % edge. tint: CSS colour (default
 * 'var(--secondary)'); tint 'white' (or `neutral`) = a plain grey chip like the buttons. props: text (or children),
 * tint, neutral, icon (SF name before the text), help, onClick (renders a <button>), class, style.
 */
export function Chip({ text, children, tint, neutral, icon, help, onClick, class: cls, style }) {
  const plain = neutral || tint === 'white' || tint === '#fff' || tint === '#FFFFFF';
  const st = { ...(!plain && tint ? { '--tint': tint } : null), ...style };
  const body = html`${icon ? html`<${Icon} name=${icon} />` : null}${text != null ? text : children}`;
  return onClick
    ? html`<button type="button" class=${cx('chip', plain && 'neutral', cls)} style=${st} title=${help} onClick=${onClick}>${body}</button>`
    : html`<span class=${cx('chip', plain && 'neutral', cls)} style=${st} title=${help}>${body}</span>`;
}

/** CountBadge — opaque count pill. props: count, tint (background, default accent), fg (text, default white), help. */
export function CountBadge({ count, tint, fg, help }) {
  return html`<span class="count-badge" style=${{ ...(tint ? { background: tint } : null), ...(fg ? { color: fg } : null) }} title=${help}>${count}</span>`;
}

/** StateDot — a 9 px dot in Fmt.stateColor(state) in a 16 px frame; needsInput: the raised hand, pulsing (1.2 s). */
export function StateDot({ state, help }) {
  if (state === 'needsInput') return html`<span class="state-dot needs-input" title=${help}><${Icon} name="hand.raised.fill" size=${11} /></span>`;
  return html`<span class="state-dot" style=${{ color: Fmt.stateColor(state) }} title=${help}><i></i></span>`;
}

/** Avatar — rounded initial for a speaker. props: label (first letter, upper-cased), tint (default accent). */
export function Avatar({ label, tint }) {
  const ch = String(label || '').trim().slice(0, 1).toUpperCase();
  return html`<span class="avatar" style=${tint ? { '--tint': tint } : null}>${ch}</span>`;
}

// ── spinners and instruments' clock ────────────────────────────────────────────────────────────────────────────────

/** ProgressView() (.controlSize(.small) by default; `large` for the regular size): the macOS spoke spinner. */
export function ProgressSpinner({ large, style }) {
  const spokes = Array.from({ length: 8 }, (_, i) => html`<i style=${{ transform: `rotate(${i * 45}deg)`, animationDelay: `${(i - 8) / 8}s` }}></i>`);
  return html`<span class=${cx('progress-small', large && 'large')} style=${style} role="progressbar">${spokes}</span>`;
}

// One shared ~30 fps clock for every BootClock / ChaseRing on screen; nothing ticks when none is shown.
const REFERENCE_DATE = 978307200;   // 2001-01-01: Swift's timeIntervalSinceReferenceDate, so phases match the Mac app
const clockSubs = new Set();
let clockRAF = 0, clockLast = 0;
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
function clockLoop(now) {
  clockRAF = clockSubs.size ? requestAnimationFrame(clockLoop) : 0;
  if (now - clockLast < 1000 / 30 - 2) return;
  clockLast = now;
  const t = Date.now() / 1000 - REFERENCE_DATE;
  clockSubs.forEach((f) => f(t));
}
/** Seconds since 2001-01-01, redrawing the component ~30×/s; a still 0.9 under Reduce Motion (BootClock). */
export function useBootClock() {
  const [t, set] = useState(() => (reduceMotion.matches ? 0.9 : Date.now() / 1000 - REFERENCE_DATE));
  useEffect(() => {
    if (reduceMotion.matches) return undefined;
    clockSubs.add(set);
    if (!clockRAF) clockRAF = requestAnimationFrame(clockLoop);
    return () => { clockSubs.delete(set); };
  }, []);
  return t;
}
/**
 * BootClock — shared clock for the self-test looks: html`<${BootClock}>${(t) => html`…`}<//>` calls its child
 * function with the time in seconds ~30×/s (still at 0.9 under Reduce Motion).
 */
export function BootClock({ children }) {
  const t = useBootClock();
  const f = Array.isArray(children) ? children[0] : children;
  return typeof f === 'function' ? f(t) : null;
}
/** 0 → 1 → 0, eased, one sweep every `period` seconds. */
BootClock.sweep = (t, period = 2.6) => 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / period);

/** Resolves a CSS colour (also 'var(--x)') to a value a canvas accepts, read from the element's computed style. */
export function cssColor(el, c) {
  const m = /^var\((--[\w-]+)\)$/.exec(String(c).trim());
  return m ? getComputedStyle(el).getPropertyValue(m[1]).trim() || '#888' : c;
}

/**
 * ChaseRing — busy ring: a gradient arc, faint tail to solid head, that turns while its length breathes, so the head
 * runs ahead and the tail catches up. props: size (px, default 11), t (seconds; omit to run on its own BootClock),
 * color (default accent), lineWidth (default 2).
 */
export function ChaseRing({ size = 11, t, color = 'var(--accent)', lineWidth = 2 }) {
  const own = t == null;
  return own ? html`<${ChaseRingClocked} size=${size} color=${color} lineWidth=${lineWidth} />` : html`<${ChaseRingDraw} size=${size} t=${t} color=${color} lineWidth=${lineWidth} />`;
}
function ChaseRingClocked(p) { const t = useBootClock(); return html`<${ChaseRingDraw} ...${p} t=${t} />`; }
function ChaseRingDraw({ size, t, color, lineWidth }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const cv = ref.current; if (!cv) return;
    const dpr = window.devicePixelRatio || 1, pad = lineWidth;   // the stroke straddles the circle: room for it
    const px = Math.round((size + 2 * pad) * dpr);
    if (cv.width !== px) { cv.width = px; cv.height = px; }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size + 2 * pad, size + 2 * pad);
    const p = (t % 1.3) / 1.3;
    const len = 0.18 + 0.55 * (0.5 - 0.5 * Math.cos(2 * Math.PI * p));
    const rot = ((((t * 320 - 360 * len) % 360) + 360) % 360) * Math.PI / 180;   // rotationEffect, clockwise from 3 o'clock like the trim (reduced: t is ~8e8 s)
    const c = size / 2 + pad, r = size / 2;
    const col = cssColor(cv, color);
    const g = ctx.createConicGradient(rot, c, c);
    g.addColorStop(0, withAlpha(col, 0)); g.addColorStop(len, col); g.addColorStop(Math.min(0.999, (1 + len) / 2), col); g.addColorStop(1, withAlpha(col, 0));
    ctx.strokeStyle = g; ctx.lineWidth = lineWidth; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(c, c, r, rot, rot + len * 2 * Math.PI); ctx.stroke();
  });
  const box = size + 2 * lineWidth;
  return html`<canvas ref=${ref} class="chase-ring" style=${{ width: `${box}px`, height: `${box}px`, margin: `${-lineWidth}px` }}></canvas>`;
}
/** A CSS colour with alpha a (0…1), for canvas gradients. Handles #rgb, #rrggbb and rgb()/rgba(). */
export function withAlpha(c, a) {
  c = String(c).trim();
  let m = /^#([0-9a-f]{3})$/i.exec(c);
  if (m) c = '#' + m[1].split('').map((x) => x + x).join('');
  m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(c);
  if (m) return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
  m = /^rgba?\(([^,]+),([^,]+),([^,)]+)/.exec(c);
  if (m) return `rgba(${m[1]},${m[2]},${m[3]},${a})`;
  return c;
}

/** The CLI spinner glyph (· ✢ ✳ ✶ ✻ ✽ …), turning 8 frames a second, in the CLI's spinner colour. */
export function SpinnerGlyph({ style }) {
  const [, tick] = useState(0);
  useEffect(() => { const id = setInterval(() => tick((n) => n + 1), 125); return () => clearInterval(id); }, []);
  return html`<span class="spinner-glyph" style=${style}>${Spinner.frame()}</span>`;
}
/**
 * The CLI's working line (TurnStatusBar.working): turning glyph, "verb…" in the verb colour, details in monospace
 * secondary ("(2m 30s · ↓ 9.8k tokens)"), then `children` pushed to the right. props: verb (default L('작업 중')),
 * details, children.
 */
export function SpinnerLine({ verb, details, children }) {
  return html`<div class="hstack" style=${{ gap: '8px', minWidth: 0 }}>
    <${SpinnerGlyph} />
    <span class="spinner-verb">${(verb || L('작업 중')) + '…'}</span>
    ${details ? html`<span class="t-mono fg-secondary one-line" style=${{ fontSize: '12px' }}>${details}</span>` : null}
    <span class="spacer" style=${{ minWidth: '8px' }}></span>
    ${children}
  </div>`;
}

/**
 * BoostLogo — the mark: a rocket's nose drawn as one pointed arch (also an A, for Agent), fins kicking out at its feet,
 * and the porthole dot inside. One colour, readable down to 16 px. props: size (px, default 34), tint (default accent).
 * Geometry is the Swift Canvas path in a 100-unit square (stroke 15 % of the size, butt caps, miter joins, limit 6).
 */
export function BoostLogo({ size = 34, tint = 'var(--accent)', style }) {
  return html`<svg class="boost-logo" width=${size} height=${size} viewBox="0 0 100 100" style=${{ color: tint, ...style }} aria-hidden="true">
    <path d="M27 100 L27 56 Q27 22 50 6 Q73 22 73 56 L73 100" fill="none" stroke="currentColor" stroke-width="15" stroke-linecap="butt" stroke-linejoin="miter" stroke-miterlimit="6" />
    <path d="M27 70 L6 90 L6 100 L27 100 Z M73 70 L94 90 L94 100 L73 100 Z" fill="currentColor" />
    <circle cx="50" cy="56" r="8.5" fill="currentColor" />
  </svg>`;
}

// ── menus ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// Entries (MenuEntry): { item: 'Title', enabled?: true, action: () => {}, checked?: bool, icon?: SF name }
//                      | { header: 'Section title' } | { separator: true }   (also the string '-' for a separator)

/** The menu's panel (presentational). props: entries, onPick(entry), hot (index), setHot. `inline` = static (gallery). */
export function MenuPanel({ entries, onPick, inline, style, panelRef }) {
  const [hot, setHot] = useState(-1);
  const anyCheck = entries.some((e) => e && e.checked != null);
  return html`<div class="menu" ref=${panelRef} style=${{ ...(inline ? { position: 'static', animation: 'none' } : null), ...style }} role="menu"
      onMouseLeave=${() => setHot(-1)} data-hot=${hot}>
    ${entries.map((e, i) => {
      if (!e || e === '-' || e.separator) return html`<div class="menu-separator" key=${i}></div>`;
      if (e.header != null) return html`<div class="menu-header" key=${i}>${e.header}</div>`;
      const on = e.enabled !== false;
      return html`<button key=${i} type="button" class=${cx('menu-item', i === hot && 'hot')} disabled=${!on} role="menuitem"
          onMouseEnter=${() => setHot(on ? i : -1)} onClick=${() => on && onPick && onPick(e)}>
        ${anyCheck ? html`<span class="menu-check">${e.checked ? '✓' : ''}</span>` : null}
        ${e.icon ? html`<${Icon} name=${e.icon} />` : null}
        <span>${e.item}</span>
      </button>`;
    })}
  </div>`;
}

function MenuLayer({ entries, at, anchor, onClose }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: -9999, top: -9999 });
  useLayoutEffect(() => {
    const m = ref.current; if (!m) return;
    const w = m.offsetWidth, hgt = m.offsetHeight, W = window.innerWidth, H = window.innerHeight;
    let left, top;
    if (anchor) {   // a Menu's drop-down: under its button, left edges aligned; above it when there is no room below
      const r = anchor.getBoundingClientRect();
      left = r.left; top = r.bottom + 4;
      if (top + hgt > H - 8 && r.top - hgt - 4 > 8) top = r.top - hgt - 4;
    } else {        // LazyMenu / context menu: at the pointer (NSEvent.mouseLocation)
      left = at.x; top = at.y;
      if (top + hgt > H - 8) top = Math.max(8, at.y - hgt);
    }
    if (left + w > W - 8) left = Math.max(8, W - 8 - w);
    if (top + hgt > H - 8) top = Math.max(8, H - 8 - hgt);
    setPos({ left, top });
  }, []);
  useEffect(() => {
    const key = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter') return;
      e.preventDefault(); e.stopPropagation();
      const items = [...ref.current.querySelectorAll('.menu-item:not(:disabled)')];
      if (!items.length) return;
      const cur = items.findIndex((b) => b.classList.contains('hot') || b === document.activeElement);
      if (e.key === 'Enter') { if (cur >= 0) items[cur].click(); return; }
      const next = e.key === 'ArrowDown' ? (cur + 1) % items.length : (cur <= 0 ? items.length - 1 : cur - 1);
      items.forEach((b) => b.classList.remove('hot')); items[next].classList.add('hot'); items[next].focus({ preventScroll: false });
    };
    const blur = () => onClose();
    window.addEventListener('keydown', key, true); window.addEventListener('blur', blur); window.addEventListener('resize', blur);
    return () => { window.removeEventListener('keydown', key, true); window.removeEventListener('blur', blur); window.removeEventListener('resize', blur); };
  }, []);
  // a click outside closes the menu and is swallowed (the way an AppKit menu ends its tracking)
  return html`<div class="menu-layer" onMouseDown=${(e) => { if (e.target === e.currentTarget) { e.preventDefault(); onClose(); } }} onContextMenu=${(e) => { e.preventDefault(); onClose(); }}>
    <${MenuPanel} entries=${entries} panelRef=${ref} style=${pos} onPick=${(e) => { onClose(); setTimeout(() => e.action && e.action(), 0); }} />
  </div>`;
}

let openMenuClose = null;
/**
 * Shows a popup menu now (LazyMenuPresenter.show / .contextMenu). `at`: a MouseEvent or {x, y} (opens at that point),
 * or an Element (drops down under it). Returns a function that closes it. One menu at a time.
 *   onContextMenu=${(e) => { e.preventDefault(); showMenu([{ item: L('닫기'), action: close }], e); }}
 */
export function showMenu(entries, at) {
  if (openMenuClose) openMenuClose();
  const box = document.createElement('div'); document.body.appendChild(box);
  let closed = false;
  const close = () => { if (closed) return; closed = true; render(null, box); box.remove(); if (openMenuClose === close) openMenuClose = null; };
  const anchor = at instanceof Element ? at : null;
  const pt = anchor ? null : at && at.clientX != null ? { x: at.clientX, y: at.clientY } : at || { x: 100, y: 100 };
  render(html`<${MenuLayer} entries=${entries} at=${pt} anchor=${anchor} onClose=${close} />`, box);
  openMenuClose = close;
  return close;
}

/**
 * LazyMenu — a plain button that builds its menu only when clicked, and opens it at the click point.
 * props: entries (a function returning MenuEntry[]), kind / button props as for Button (default 'plain'), help,
 * disabled, class, style, children (the label).
 */
export function LazyMenu({ entries, children, kind = 'plain', ...rest }) {
  return html`<${Button} kind=${kind} ...${rest} onClick=${(e) => showMenu(typeof entries === 'function' ? entries() : entries, e)}>${children}<//>`;
}

/**
 * Menu — a drop-down under its button (SwiftUI Menu with .menuStyle(.button) / .borderlessButton, indicator hidden).
 * props: entries (MenuEntry[] or a function), label (vnode; or children), kind (Button kind, default 'plain'),
 * borderless (secondary-coloured text trigger, as LanguageMenu), indicator (show a chevron.down), help, disabled.
 */
export function Menu({ entries, label, children, kind = 'plain', borderless, indicator, class: cls, ...rest }) {
  return html`<${Button} kind=${kind} class=${cx(borderless && 'menu-trigger-borderless', cls)} ...${rest}
      onClick=${(e) => showMenu(typeof entries === 'function' ? entries() : entries, e.currentTarget)}>
    ${label != null ? label : children}${indicator ? html`<${Icon} name="chevron.down" size=${9} />` : null}
  <//>`;
}

/**
 * Picker (menu style): a pop-up button showing the current choice. props: value, options [{value, label, icon?}],
 * onChange(value), width (px), disabled, help.
 */
export function Picker({ value, options, onChange, width, disabled, help }) {
  const cur = options.find((o) => o.value === value);
  return html`<button type="button" class="popup-button" style=${width ? { width: `${width}px` } : null} disabled=${disabled} title=${help}
      onClick=${(e) => showMenu(options.map((o) => ({ item: o.label, icon: o.icon, checked: o.value === value, action: () => onChange && onChange(o.value) })), e.currentTarget)}>
    <span class="label one-line">${cur && cur.icon ? html`<${Icon} name=${cur.icon} />` : null}${cur ? cur.label : ''}</span>
    <span class="popup-arrows"><span>▲</span><span>▼</span></span>
  </button>`;
}

/** Picker .segmented. props: value, options [{value, label, icon?}], onChange(value), help. */
export function Segmented({ value, options, onChange, help }) {
  return html`<div class="segmented" title=${help} role="tablist">
    ${options.map((o) => html`<button type="button" key=${String(o.value)} class=${o.value === value ? 'on' : ''} onClick=${() => onChange && onChange(o.value)}>
      ${o.icon ? html`<${Icon} name=${o.icon} />` : null}${o.label}</button>`)}
  </div>`;
}

/** Toggle with .checkbox (the macOS default). props: checked, onChange(bool), label (or children), disabled, help, class. */
export function Checkbox({ checked, onChange, label, children, disabled, help, class: cls, style }) {
  return html`<label class=${cx('checkbox', cls)} title=${help} style=${style}>
    <input type="checkbox" checked=${!!checked} disabled=${disabled} onChange=${(e) => onChange && onChange(e.currentTarget.checked)} />
    ${label != null ? html`<span>${label}</span>` : children}
  </label>`;
}
/** Toggle as a switch (a Toggle inside a grouped Form). Same props as Checkbox; the label sits left of the switch. */
export function Switch({ checked, onChange, label, children, disabled, help, class: cls, style }) {
  return html`<label class=${cx('switch', cls)} title=${help} style=${style}>
    ${label != null ? html`<span>${label}</span>` : children}
    <input type="checkbox" role="switch" checked=${!!checked} disabled=${disabled} onChange=${(e) => onChange && onChange(e.currentTarget.checked)} />
  </label>`;
}

/** One row of a grouped Form: label left, control(s) right. props: label, children, help. Wrap rows in .form-grouped. */
export function FormRow({ label, children, help }) {
  return html`<div class="form-row" title=${help}><span class="form-label">${label}</span><span class="form-control">${children}</span></div>`;
}

// ── sheets, dialogs, popovers ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Sheet / Modal — a centred panel over a dimmed window (SwiftUI .sheet). Render it while it should show:
 *   ${creating && html`<${Sheet} width=${720} onClose=${() => setCreating(false)}>…<//>`}
 * props: width (px), height (px), padding (px, default 20), onClose (Esc calls it; the scrim does not, as on macOS),
 * class, style, children.
 */
export function Sheet({ width, height, padding = 20, onClose, class: cls, style, children }) {
  useEffect(() => {
    const key = (e) => { if (e.key === 'Escape' && onClose && !document.querySelector('.menu-layer')) { e.preventDefault(); onClose(); } };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  return html`<${Portal}>
    <div class="scrim">
      <div class=${cx('sheet', cls)} role="dialog" style=${{ ...(width ? { width: `${width}px` } : null), ...(height ? { height: `${height}px` } : null), padding: `${padding}px`, ...style }}>${children}</div>
    </div>
  <//>`;
}
export const Modal = Sheet;

function AlertBox({ title, message, buttons, field, onDone }) {
  const input = useRef(null);
  const [text, setText] = useState(field ? field.value || '' : '');
  const cancelIdx = buttons.findIndex((b) => b.role === 'cancel');
  const defIdx = buttons.findIndex((b) => b.role !== 'cancel');
  const pick = (i) => onDone(i, text);
  useEffect(() => {
    if (input.current) { input.current.focus(); input.current.select(); }
    const key = (e) => {
      if (document.querySelector('.menu-layer')) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); pick(cancelIdx); }
      else if (e.key === 'Enter' && defIdx >= 0 && !e.isComposing) { e.preventDefault(); e.stopPropagation(); pick(defIdx); }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  });
  // two buttons sit side by side (cancel first, as macOS lays them out); more stack, cancel last
  const row = buttons.length === 2;
  const order = row ? [...buttons.keys()].sort((a, b) => (buttons[b].role === 'cancel') - (buttons[a].role === 'cancel')) : [...buttons.keys()];
  return html`<div class="scrim" style=${{ zIndex: 950 }}>
    <div class="alert" role="alertdialog" style=${{ boxShadow: 'var(--shadow)' }}>
      <${BoostLogo} size=${44} />
      <div class="alert-title">${title}</div>
      ${message ? html`<div class="alert-message">${message}</div>` : null}
      ${field ? html`<input ref=${input} class="textfield" value=${text} placeholder=${field.placeholder || ''} onInput=${(e) => setText(e.currentTarget.value)} />` : null}
      <div class=${cx('alert-buttons', row && 'row')}>
        ${order.map((i) => { const b = buttons[i]; return html`<${Button} key=${i} kind=${i === defIdx && b.role !== 'destructive' ? 'raisedProminent' : 'raised'} destructive=${b.role === 'destructive'} onClick=${() => pick(i)}>${b.label}<//>`; })}
      </div>
    </div>
  </div>`;
}
function openAlert(props) {
  return new Promise((resolve) => {
    const box = document.createElement('div'); document.body.appendChild(box);
    const done = (i, text) => {
      render(null, box); box.remove();
      const b = props.buttons[i];
      if (b && b.action) setTimeout(() => b.action(text), 0);
      resolve({ index: i, button: b, text });
    };
    render(html`<${AlertBox} ...${props} onDone=${done} />`, box);
  });
}

/**
 * confirmationDialog / alert — resolves with the chosen button's `value` (its index when it has none), or null for
 * Esc / a cancel-role button without a value. Runs the button's `action` too.
 *   const v = await confirm(L("'%@' 종료", a.name), msg, [
 *     { label: L('지금 종료 (작업 중단)'), role: 'destructive', value: 'now' },
 *     { label: L('작업 끝나면 종료'), value: 'whenIdle' },
 *     { label: L('취소'), role: 'cancel' }]);
 * buttons: [{label, role?: 'destructive' | 'cancel', value?, action?}]; default [{label: L('확인')}, {label: L('취소'), role: 'cancel'}].
 * Enter picks the first non-cancel button.
 */
export function confirm(title, message, buttons) {
  const bs = buttons && buttons.length ? buttons : [{ label: L('확인'), value: true }, { label: L('취소'), role: 'cancel' }];
  return openAlert({ title, message, buttons: bs }).then(({ index, button }) => {
    if (!button) return null;
    if (button.value !== undefined) return button.value;
    return button.role === 'cancel' ? null : index;
  });
}

/**
 * alert with a text field (rename …). Resolves with the text (OK) or null (cancel / Esc).
 * opts: {message, value, placeholder, ok (label, default L('확인')), cancel (label, default L('취소'))}.
 */
export function prompt(title, opts = {}) {
  const buttons = [{ label: opts.ok || L('확인'), value: 'ok' }, { label: opts.cancel || L('취소'), role: 'cancel' }];
  return openAlert({ title, message: opts.message, buttons, field: { value: opts.value, placeholder: opts.placeholder } })
    .then(({ button, text }) => (button && button.value === 'ok' ? text : null));
}

/**
 * Popover — a floating panel with an arrow, attached to an element (SwiftUI .popover(arrowEdge:)). Render it while open.
 * props: anchor (a ref object or Element), edge ('bottom' = below the anchor, default; 'top'), onClose (outside click /
 * Esc), width (px), padding (px, default 12), children.
 */
export function Popover({ anchor, edge = 'bottom', onClose, width, padding = 12, children }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: -9999, top: -9999, arrow: 0 });
  const el = () => (anchor && anchor.current !== undefined ? anchor.current : anchor);
  useLayoutEffect(() => {
    const a = el(), p = ref.current; if (!a || !p) return;
    const r = a.getBoundingClientRect(), w = p.offsetWidth, hgt = p.offsetHeight;
    let left = Math.max(8, Math.min(window.innerWidth - 8 - w, r.left + r.width / 2 - w / 2));
    const top = edge === 'top' ? r.top - hgt - 10 : r.bottom + 10;
    const arrow = r.left + r.width / 2 - left - 6;
    if (pos.left !== left || pos.top !== top) setPos({ left, top, arrow });
  });
  useEffect(() => {
    const down = (e) => { const a = el(); if (ref.current && !ref.current.contains(e.target) && !(a && a.contains(e.target)) && !e.target.closest('.menu-layer, .scrim')) onClose && onClose(); };
    const key = (e) => { if (e.key === 'Escape' && !document.querySelector('.menu-layer')) onClose && onClose(); };
    window.addEventListener('mousedown', down, true); window.addEventListener('keydown', key);
    return () => { window.removeEventListener('mousedown', down, true); window.removeEventListener('keydown', key); };
  }, [onClose]);
  const arrowSt = edge === 'top' ? { bottom: '-7px', borderTop: 0, borderLeft: 0 } : { top: '-7px', borderBottom: 0, borderRight: 0 };
  return html`<${Portal}>
    <div class="popover" ref=${ref} style=${{ left: `${pos.left}px`, top: `${pos.top}px`, ...(width ? { width: `${width}px` } : null) }}>
      <div class="popover-arrow" style=${{ left: `${pos.arrow}px`, ...arrowSt }}></div>
      <div style=${{ position: 'relative', padding: `${padding}px` }}>${children}</div>
    </div>
  <//>`;
}

/** ContentUnavailableView(title, systemImage:, description:). */
export function EmptyState({ title, icon, description }) {
  return html`<div class="empty-state">
    ${icon ? html`<${Icon} name=${icon} />` : null}
    <div class="empty-title">${title}</div>
    ${description ? html`<div class="t-callout">${description}</div>` : null}
  </div>`;
}
