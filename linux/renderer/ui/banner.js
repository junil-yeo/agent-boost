// The usage banner at the top of the window, ported from UsageBanner.swift and Instruments.swift: the name block with
// the GitHub link, the three usage instruments (240° dials with the time-elapsed bug and the projected-use arc), their
// power-on self-test while the numbers load, the radar scope (compact mode), the weekly pace light (annunciator lamps
// with the refresh key and its chase ring), the task cards, the language menu, the clock, free RAM/disk and the
// notices bell. Also the @AppStorage helpers the root view shares (useAppStorage).
import { html, useState, useEffect, useRef, useLayoutEffect, call, L, currentLang } from '../lib.js';
import { Icon, Button, Menu, BoostLogo, BootClock, ChaseRing, cssColor, withAlpha, useAppearance } from './widgets.js';
import { Fmt, HostMemory } from '../fmt.js';
import { TodoCard } from './todo.js';

// ── @AppStorage (renderer settings in localStorage under the Swift keys) ───────────────────────────────────────────

/** Reads a stored setting. Values are stored as String(value) (ui/board.js does the same): 'true', '15', 'dark'. */
export function getAppStorage(key, def) {
  let raw = null;
  try { raw = localStorage.getItem(key); } catch { /* storage unavailable */ }
  if (raw == null) return def;
  if (typeof def === 'boolean') return raw === 'true' || raw === '1';
  if (typeof def === 'number') { const n = Number(raw); return Number.isFinite(n) ? n : def; }
  return raw;
}
/** Stores a setting and tells every view that reads it ('ab-appstorage', the event ui/board.js's hook listens to). */
export function setAppStorage(key, value) {
  try { localStorage.setItem(key, String(value)); } catch { /* storage unavailable */ }
  window.dispatchEvent(new CustomEvent('ab-appstorage', { detail: { key, value } }));
}
/** [value, set] for one @AppStorage key; redraws when any view changes it. */
export function useAppStorage(key, def) {
  const [v, setV] = useState(() => getAppStorage(key, def));
  useEffect(() => {
    const f = (e) => { if (!e.detail || e.detail.key === key) setV(getAppStorage(key, def)); };
    const g = (e) => { if (e.key === key) setV(getAppStorage(key, def)); };
    window.addEventListener('ab-appstorage', f); window.addEventListener('storage', g);
    return () => { window.removeEventListener('ab-appstorage', f); window.removeEventListener('storage', g); };
  }, [key]);
  return [v, (x) => setAppStorage(key, typeof x === 'function' ? x(getAppStorage(key, def)) : x)];
}

// ── canvas helper ────────────────────────────────────────────────────────────────────────────────────────────────

/** A w×h canvas redrawn on every render by draw(ctx, w, h, colour(cssValue, alpha)). */
function CanvasView({ w, h, draw, style }) {
  const ref = useRef(null);
  const isDark = useAppearance()[2];   // a theme switch redraws with the new colours
  useLayoutEffect(() => {
    const cv = ref.current; if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const col = (c, a = 1) => withAlpha(cssColor(cv, c), a);
    draw(ctx, w, h, col);
  });
  return html`<canvas ref=${ref} class="boot-canvas" data-dark=${isDark} style=${{ width: `${w}px`, height: `${h}px`, ...style }}></canvas>`;
}

// ── Instruments.swift ────────────────────────────────────────────────────────────────────────────────────────────

/** InstrumentDial.angle: 240° scale from lower left (150°) over the top to lower right (390°). Radians. */
const dialAngle = (v) => ((150 + 240 * Math.max(0, Math.min(1, v))) * Math.PI) / 180;

/**
 * 240° dial: scale ticks every 10 %, a red band over 85 %, the value arc, a magenta bug outside the scale.
 * value 0…1, tint (CSS colour) + tintAlpha, bug (elapsed 0…1 | null), projected (0…n | null), dim (self-test: the
 * scale drawn fainter, ticks lit as the sweep passes), children = the centre.
 */
export function InstrumentDial({ value, tint, tintAlpha = 1, bug, projected, dim = false, size = 62, children }) {
  const draw = (ctx, W, H, col) => {
    const c = { x: W / 2, y: H / 2 };
    const r = Math.min(W, H) / 2 - 6;
    const arc = (from, to, radius) => { ctx.beginPath(); ctx.arc(c.x, c.y, radius, dialAngle(from), dialAngle(to), false); };
    const pt = (v, radius) => { const a = dialAngle(v); return [c.x + Math.cos(a) * radius, c.y + Math.sin(a) * radius]; };
    ctx.lineCap = 'butt';
    arc(0, 1, r); ctx.strokeStyle = col('var(--ink)', 0.10); ctx.lineWidth = 5; ctx.stroke();
    arc(0.85, 1, r + 4); ctx.strokeStyle = col('var(--error)', dim ? 0.35 : 0.75); ctx.lineWidth = 1.5; ctx.stroke();
    for (let i = 0; i <= 10; i++) {
      const major = i % 5 === 0;
      // during the self-test the ticks light up as the sweep passes them
      const passed = i / 10 <= value + 0.001;
      const o = dim ? (passed ? 0.9 : 0.25) : (major ? 0.85 : 0.45);
      ctx.beginPath(); ctx.moveTo(...pt(i / 10, r - 4)); ctx.lineTo(...pt(i / 10, r - (major ? 9 : 6.5)));
      ctx.strokeStyle = col('var(--busy)', o); ctx.lineWidth = major ? 1.2 : 0.8; ctx.stroke();
    }
    if (projected != null && projected > 0) {
      const pc = projected > 1.2 ? 'var(--error)' : projected > 1.0 ? 'var(--attention)' : 'var(--text-dim)';
      ctx.lineCap = 'round';
      arc(0, Math.min(1, projected), r - 11.5); ctx.strokeStyle = col(pc, 0.55); ctx.lineWidth = 1.5; ctx.stroke();
      ctx.lineCap = 'butt';
    }
    if (value > 0) { arc(0, value, r); ctx.strokeStyle = col(tint, tintAlpha); ctx.lineWidth = 5; ctx.stroke(); }
    if (bug != null) {   // speed-bug: a small magenta wedge pointing at the scale
      const a = dialAngle(bug);
      const tip = pt(bug, r + 2.5), back = r + 7.5;
      ctx.beginPath(); ctx.moveTo(...tip);
      ctx.lineTo(c.x + Math.cos(a - 0.11) * back, c.y + Math.sin(a - 0.11) * back);
      ctx.lineTo(c.x + Math.cos(a + 0.11) * back, c.y + Math.sin(a + 0.11) * back);
      ctx.closePath(); ctx.fillStyle = col('var(--bug)'); ctx.fill();
    }
  };
  return html`<div class="dial" style=${{ width: `${size}px`, height: `${size}px` }}>
    <${CanvasView} w=${size} h=${size} draw=${draw} />
    <div class="dial-center">${children}</div>
  </div>`;
}

/** Three annunciator lamps. on: 0 정상, 1 주의, 2 경고, -1 none. test: lamp-test position (0…3, 3 = all lit). */
export function AnnunciatorPanel({ on, test = null, tip = '', children }) {
  const colours = ['var(--error)', 'var(--attention)', 'var(--normal)'];
  const words = [L('경고'), L('주의'), L('정상')];
  return html`<div class="annunciator">
    ${[0, 1, 2].map((i) => {
      const level = 2 - i, c = colours[i];
      const lit = test != null ? (test === 3 || test === i) : on === level;
      return html`<div key=${i} class=${'lamp' + (lit ? ' lit' : '')} style=${{ '--c': c }} title=${tip}><${FitText} text=${words[i]} width=${36} /></div>`;
    })}
    ${children}
  </div>`;
}
/** Lamp test: each lamp in turn, then all three together, then a pause. One cycle = 2.4 s. */
AnnunciatorPanel.testStep = (t) => {
  const x = ((t % 2.4) + 2.4) % 2.4;
  return x < 0.3 ? 0 : x < 0.6 ? 1 : x < 0.9 ? 2 : x < 1.6 ? 3 : null;
};

/** One line of text that shrinks to fit `width` (lineLimit(1).minimumScaleFactor(0.4)): CAUTION, PRECAUCIÓN … */
export function FitText({ text, width, min = 0.4, left = false }) {
  const ref = useRef(null);
  const [k, setK] = useState(1);
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const w = el.scrollWidth;
    const nk = w > width ? Math.max(min, width / w) : 1;
    if (Math.abs(nk - k) > 0.01) setK(nk);
  }, [text, width]);
  return html`<span ref=${ref} class="fit-text" style=${{ transform: `scale(${k})`, transformOrigin: left ? 'left center' : 'center' }}>${text}</span>`;
}

/**
 * A usage instrument before its numbers arrive: the needle runs its power-on sweep. On failure it stops at zero
 * behind a red OFF flag, the way a gauge without a valid signal shows it.
 */
export function MeterSelfTest({ t, status, failed = false, title = null }) {
  const v = failed ? 0 : BootClock.sweep(t);
  return html`<div class="meter-card" style=${failed ? { borderColor: 'color-mix(in srgb, var(--error) 50%, transparent)' } : null}>
    <div class="hstack" style=${{ gap: '10px' }}>
      <${InstrumentDial} value=${v} tint="var(--busy)" tintAlpha=${0.75} dim=${true}>
        ${failed
          ? html`<span class="off-flag">OFF</span>`
          : html`<span class="dial-value" style=${{ color: `color-mix(in srgb, var(--busy) ${Math.round((0.35 + 0.5 * v) * 100)}%, transparent)` }}>--</span>`}
      <//>
      <div class="vstack" style=${{ gap: '5px', width: '92px' }}>
        <span style=${{ fontSize: '11px', fontWeight: 600, color: failed ? 'var(--error)' : 'var(--busy)' }}>${title || (failed ? L('신호 없음') : L('계기 점검 중'))}</span>
        <span class="clamp2" style=${{ fontSize: '10px', fontWeight: 500, color: 'var(--text-dim)' }}>${status}</span>
        ${failed ? null : [0, 1].map((i) => html`<div key=${i} class="selftest-row" style=${{ width: `${i === 0 ? 70 : 52}px` }}>
          <i style=${{ width: `${100 * Math.max(0, Math.min(1, v * 1.15 - i * 0.15))}%` }}></i></div>`)}
      </div>
    </div>
    <div class="meter-foot" style=${{ color: 'color-mix(in srgb, var(--text-dim) 60%, transparent)' }}>${failed ? ' ' : L('소모 추세에 따른 최종 예상 사용량 --')}</div>
  </div>`;
}

/** Small radar scope: a sweeping beam over range rings. */
export function RadarScope({ t, size = 14 }) {
  const draw = (ctx, W, H, col) => {
    const c = { x: W / 2, y: H / 2 }, r = Math.min(W, H) / 2 - 1;
    for (const k of [1.0, 0.55]) {
      ctx.beginPath(); ctx.arc(c.x, c.y, r * k, 0, 2 * Math.PI);
      ctx.strokeStyle = col('var(--busy)', 0.45); ctx.lineWidth = 1; ctx.stroke();
    }
    const a = (((t % 1.8) + 1.8) % 1.8 / 1.8) * 2 * Math.PI;
    for (let j = 0; j < 10; j++) {   // beam with a fading trail
      const aj = a - j * 0.09;
      ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(c.x + Math.cos(aj) * r, c.y + Math.sin(aj) * r);
      ctx.strokeStyle = col('var(--busy)', 0.9 * (1 - j / 10)); ctx.lineWidth = j === 0 ? 1.5 : 2; ctx.stroke();
    }
  };
  return html`<${CanvasView} w=${size} h=${size} draw=${draw} />`;
}

// ── UsageBanner.swift ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A capsule bar of a fixed height. The optional dashed tick marks how much of the window has elapsed: usage right of
 * the tick = spending faster than time. props: value 0…1, tint (CSS colour), height, marker (0…1 | null).
 */
export function Bar({ value, tint, height, marker = null, style }) {
  const v = Math.max(0, Math.min(1, value));
  return html`<div class="usage-bar" style=${{ height: `${height}px`, ...style }}>
    <i class="usage-bar-track"></i>
    <i class="usage-bar-fill" style=${{ width: `${v * 100}%`, background: tint }}></i>
    ${marker != null ? html`<svg class="usage-bar-marker" style=${{ left: `calc(${Math.max(0, Math.min(1, marker)) * 100}% - 1px)`, top: '-3px', height: `${height + 6}px` }} width="2" height=${height + 6}>
      <line x1="1" y1="0" x2="1" y2=${height + 6} stroke="var(--fg-solid)" stroke-opacity="0.85" stroke-width="1.5" stroke-dasharray="2 2" /></svg>` : null}
  </div>`;
}

/** The instrument's short name: 현재 / 주간 / 페이블, or another per-model limit's model name. */
function meterLabel(m) {
  const l = m.label.toLowerCase();
  if (l.includes('session')) return L('현재');
  if (l.includes('all models')) return L('주간');
  if (l.includes('fable')) return L('페이블');
  return m.label.replaceAll('Current week (', '').replaceAll(')', '');
}
const meterTint = (m) => (m.percent >= 85 ? 'var(--error)' : m.percent >= 60 ? 'var(--attention)' : 'var(--normal)');
/** Use at reset if the current pace holds. Nothing used yet = 0 %; only the first moments of a period (too little time
 *  to extrapolate) have no number. */
function projectionText(m) {
  if (m.projected != null) return L('소모 추세에 따른 최종 예상 사용량 %@%', String(m.projected));
  return m.percent === 0 ? L('소모 추세에 따른 최종 예상 사용량 %@%', '0') : L('소모 추세에 따른 최종 예상 사용량 계산 중');
}
function projectionColor(m) {
  const p = m.projected;
  if (p == null) return 'var(--text-dim)';
  return p > 120 ? 'var(--error)' : p > 100 ? 'var(--attention)' : 'var(--text-dim)';
}

/** One usage instrument: a round dial (full) or a slim bar (compact). */
export function Meter({ m, compact }) {
  const tint = meterTint(m), label = meterLabel(m);
  if (compact) {
    return html`<div class="meter-slim" title=${m.remainingText ? L('초기화: %@ · %@', m.resets, m.remainingText) : m.resets}>
      <span class="t-caption fg-secondary one-line">${label}</span>
      <${Bar} value=${m.percent / 100} tint=${tint} height=${5} marker=${m.elapsed} style=${{ minWidth: '40px', maxWidth: '90px', flex: '1 1 90px' }} />
      <span class="t-caption t-bold t-digits">${m.percent}%</span>
    </div>`;
  }
  // A round instrument: the arc is usage, the magenta bug is time elapsed, the thin inner arc is the projected use at
  // reset. Numbers sit beside the dial, so nothing is told by colour alone.
  let help = m.resets;
  if (m.elapsed != null) {
    const pace = m.percent / 100 - m.elapsed;
    help = L('초기화: %@', m.resets) + '\n' + (pace > 0.05 ? L('시간보다 빠르게 쓰는 중 (+%@%p)', String(Math.trunc(pace * 100)))
      : pace < -0.05 ? L('여유 있음 (%@%p)', String(Math.trunc(-pace * 100))) : L('시간과 비슷한 속도'));
  }
  const projHelp = m.projected != null ? L('지금 속도대로면 초기화 때 %@%를 씁니다', String(m.projected))
    : (m.percent === 0 ? L('이번 기간에 아직 쓴 양이 없습니다') : L('기간이 막 시작돼 아직 추세를 계산하지 않습니다'));
  return html`<div class="meter-card" title=${help}>
    <div class="hstack" style=${{ gap: '10px' }}>
      <${InstrumentDial} value=${m.percent / 100} tint=${tint} bug=${m.elapsed} projected=${m.projected != null ? m.projected / 100 : null}>
        <span class="dial-value" style=${{ color: m.percent >= 60 ? tint : 'var(--fg)' }}>${m.percent}<small>%</small></span>
      <//>
      <div class="vstack" style=${{ gap: '3px', width: '92px' }}>
        <span class="one-line" style=${{ fontSize: '12px', fontWeight: 600, color: 'var(--busy)' }}>${label}</span>
        ${m.elapsed != null ? html`
          <span class="t-digits fit-line" style=${{ fontSize: '10px', fontWeight: 500, color: 'var(--bug)' }}><${FitText} text=${L('시간 %@% 경과', String(Math.trunc(m.elapsed * 100)))} width=${92} min=${0.8} left=${true} /></span>
          <span class="fit-line" style=${{ fontSize: '10px', fontWeight: 500, color: 'var(--text-dim)' }}><${FitText} text=${m.remainingText} width=${92} min=${0.7} left=${true} /></span>`
        : html`<span class="clamp2" style=${{ fontSize: '10px', fontWeight: 500, color: 'var(--text-dim)' }}>${m.resets ? L('초기화 %@', m.resets) : L('사용 시작 전')}</span>`}
      </div>
    </div>
    <div class="meter-foot t-digits" style=${{ color: projectionColor(m) }} title=${projHelp}>${projectionText(m)}</div>
  </div>`;
}

/** Refresh: a key the size of a lamp, under the three lamps. A chase ring turns while usage and sessions are read again. */
export function RefreshButton({ spinning, onClick, help }) {
  return html`<${Button} kind="key" disabled=${spinning} onClick=${onClick} help=${help}>
    ${spinning ? html`<${ChaseRing} size=${11} />` : html`<${Icon} name="arrow.clockwise" size=${10} strokeWidth=${3} />`}
  <//>`;
}

/** Weekly pace light: green ≤ 100 %, yellow ≤ 120 %, red above (projected use of the weekly all-models limit). */
export function TrafficLight({ meter, testing, children }) {
  const p = meter ? meter.projected : null;
  const on = p == null ? -1 : p <= 100 ? 0 : p <= 120 ? 1 : 2;
  const tip = p != null ? L('주간 전체 추세: 초기화 때 %@% 예상', String(p)) : L('주간 사용량 추세 계산 전');
  if (testing) return html`<${BootClock}>${(t) => html`<${AnnunciatorPanel} on=${on} test=${AnnunciatorPanel.testStep(t)} tip=${tip}>${children}<//>`}<//>`;
  return html`<${AnnunciatorPanel} on=${on} tip=${tip}>${children}<//>`;
}

/** 24-hour HH:mm, redrawn every second. */
function Clock({ compact }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  return html`<span class="banner-clock" style=${{ fontSize: `${compact ? 15 : 20}px` }} title=${L('현재 시각')}>${Fmt.time(now)}</span>`;
}

/** Free RAM and disk, read every 5 s from the main process (MemAvailable, statfs of the home volume). */
function HostMemoryView() {
  const [mem, setMem] = useState(null);
  useEffect(() => {
    let live = true;
    const read = () => call('platform.hostMemory').then((m) => { if (live) setMem(m); }).catch(() => { });
    read();
    const id = setInterval(read, 5000);
    return () => { live = false; clearInterval(id); };
  }, []);
  return html`<div class="vstack t-digits" style=${{ alignItems: 'flex-end', fontSize: '11px', fontWeight: 500, color: 'var(--secondary)', whiteSpace: 'nowrap' }}
      title=${L('여유 공간 (5초마다)\nRAM: 작업용 시스템 메모리 중 지금 쓸 수 있는 양 (비어 있음 + 비활성 + 회수 가능)\n디스크: 저장 공간 중 남은 용량')}>
    <span>${HostMemory.ramText(mem ? mem.availableGB : 0)}</span>
    <span>${HostMemory.diskText(mem && mem.diskFreeGB != null ? mem.diskFreeGB : NaN)}</span>
  </div>`;
}

const LANGS = [['en', 'English'], ['ko', '한국어'], ['ja', '日本語'], ['zh', '简体中文'], ['es', 'Español']];
/** Switches the app language: main's l10n, then the whole window redraws (App listens for 'ab-language'). */
export async function chooseLanguage(l) {
  await call('l10n.setLanguage', l);
  window.dispatchEvent(new CustomEvent('ab-language', { detail: l }));
  call('tray.refresh').catch(() => { });
}
/** The language menu above the clock: switch at any time. */
function LanguageMenu() {
  const cur = currentLang() || 'en';
  const native = (LANGS.find((x) => x[0] === cur) || LANGS[0])[1];
  return html`<${Menu} borderless=${true} entries=${() => LANGS.map(([id, name]) => ({ item: name, checked: id === cur, action: () => chooseLanguage(id) }))}
      label=${html`<span class="hstack" style=${{ gap: '4px', fontSize: '11px', fontWeight: 500 }}><${Icon} name="globe" size=${11} />${native}</span>`} />`;
}

/** The banner. s: the store state (null while it has not arrived: the self-test look). compact: window under 700 px. */
export function UsageBanner({ s, compact }) {
  const [showNotices, setShowNotices] = useAppStorage('ui.showNotices', true);
  const meters = (s && s.meters) || [];
  const rebooting = !!(s && s.rebooting);
  const usageBusy = s ? !!s.usageBusy : true;
  const usageError = s ? s.usageError : null;
  const loggedOut = !!(s && s.loggedOut);
  let instruments;
  if (meters.length === 0 || rebooting) {
    // power-on self-test while the numbers are on their way; a red OFF flag if they could not be read
    const failed = !usageBusy && usageError != null;
    const status = usageBusy ? L('사용량 불러오는 중') : (loggedOut ? L('터미널에서 claude 실행 후 로그인') : failed ? L('사용량을 불러오지 못했습니다') : L('사용량 대기 중'));
    instruments = compact
      ? html`<${BootClock}>${(t) => html`<div class="selftest-slim" title=${usageError || ''}>
          ${failed ? html`<span class="off-flag small">OFF</span>` : html`<${RadarScope} t=${t} />`}
          <span class="t-caption one-line" style=${{ color: failed ? 'var(--error)' : 'var(--text-dim)' }}>${status}</span>
        </div>`}<//>`
      : [0, 1, 2].map((i) => html`<div key=${i} title=${usageError || ''}><${BootClock}>${(t) => html`<${MeterSelfTest} t=${t + i * 0.35} status=${status} failed=${failed} title=${loggedOut ? L('로그인 필요') : null} />`}<//></div>`);
  } else {
    instruments = meters.map((m) => html`<${Meter} key=${m.id || m.label} m=${m} compact=${compact} />`);
  }
  const weekly = meters.find((m) => m.label.toLowerCase().includes('all models'));
  const refreshHelp = L('사용량·세션 새로고침 — 5분마다 자동 갱신') + (s && s.usageUpdated ? L(' · 마지막 %@', Fmt.time(s.usageUpdated)) : '');
  return html`<div class="usage-banner" style=${{ padding: compact ? '6px 16px' : '10px 16px' }}>
    <div class="name-block">
      <div class="hstack" style=${{ gap: '9px' }}>
        <${BoostLogo} size=${34} />
        <div class="vstack name-words"><span>Agent</span><span class="accent">Boost</span></div>
      </div>
      <${Button} kind="tab" raised=${true} small=${true} help=${L('github.com/junil-yeo/agent-boost — 브라우저에서 엽니다')}
          onClick=${() => call('platform.openExternal', 'https://github.com/junil-yeo/agent-boost')}>
        <span class="hstack" style=${{ alignItems: 'flex-start', gap: '1px' }}>
          <span style=${{ fontSize: '11px', fontWeight: 600 }}>GitHub Page</span>
          <${Icon} name="arrow.up.right" size=${7} strokeWidth=${3.5} style=${{ marginTop: '1px' }} />
        </span>
      <//>
    </div>
    ${instruments}
    <${TrafficLight} meter=${weekly} testing=${meters.length === 0 && usageError == null}>
      <${RefreshButton} spinning=${rebooting} help=${refreshHelp} onClick=${() => call('store.manualRefresh')} />
    <//>
    <div class="banner-todo"><${TodoCard} forceIcon=${compact} /></div>
    <div class=${compact ? 'hstack' : 'vstack'} style=${compact ? { gap: '8px' } : { gap: '4px', alignItems: 'flex-end' }}>
      <${LanguageMenu} />
      <${Clock} compact=${compact} />
      <div class="hstack" style=${{ gap: '8px' }}>
        <${HostMemoryView} />
        <${Button} kind="icon" onClick=${() => { const v = !showNotices; setShowNotices(v); call('store.setPref', 'ui.showNotices', v).catch(() => { }); }}
            help=${showNotices ? L('알림 막대 켜짐 — 누르면 숨깁니다 (기록은 계속 쌓입니다)') : L('알림 막대 꺼짐 — 누르면 알림과 지난 기록을 보여줍니다')}>
          <${Icon} name=${showNotices ? 'bell.fill' : 'bell.slash'} size=${14} color=${showNotices ? 'var(--accent)' : 'var(--secondary)'} />
        <//>
      </div>
    </div>
  </div>`;
}
