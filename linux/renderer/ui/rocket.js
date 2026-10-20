// The org chart's loading screen, ported from RocketLaunch.swift: a large rocket lifts off through the whole area,
// bottom to top, in 2 s, drawn on a canvas frame by frame (RocketScene) with the same geometry and colours.
import { html, useState, useEffect, useRef, useLayoutEffect, L } from '../lib.js';
import { isDarkNow } from './widgets.js';

const FLIGHT = 2;   // RocketLaunch.flight, seconds
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

/**
 * First load of the org chart. One flight always plays to the end, even when the sessions arrive sooner; while they
 * are still loading, it flies again. props: loaded, onDone().
 */
export function RocketLaunch({ loaded, onDone }) {
  const cv = useRef(null);
  const start = useRef(performance.now());
  const scheduled = useRef(false);
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  /** Done at the end of the flight in progress (at least one whole flight). */
  const finish = () => {
    if (scheduled.current) return;
    scheduled.current = true;
    const t = (performance.now() - start.current) / 1000;
    const end = Math.max(1, Math.ceil(t / FLIGHT)) * FLIGHT;
    setTimeout(() => doneRef.current && doneRef.current(), Math.max(0, end - t) * 1000);
  };
  useEffect(() => {
    start.current = performance.now();
    if (loadedRef.current) finish();
    let raf = 0;
    const frame = () => {
      const c = cv.current;
      if (c) {
        const t = reduceMotion.matches ? 0 : (performance.now() - start.current) / 1000;
        const p = reduceMotion.matches ? 0.42 : (t / FLIGHT) % 1;   // still under Reduce Motion: the rocket mid-flight
        drawRocket(c, p, t);
        // also checked on every frame: a launch that began while this tab was hidden (the refresh button pressed on
        // another tab) missed the change of `loaded` and flew forever
        if (loadedRef.current && t >= FLIGHT * 0.5) finish();
      }
      if (!reduceMotion.matches) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);
  useEffect(() => { if (loaded) finish(); }, [loaded]);
  return html`<div class="rocket-launch" aria-label=${L('세션을 불러오는 중')}>
    <canvas ref=${cv}></canvas>
    <span class="rocket-caption">${L('세션을 불러오는 중')}</span>
  </div>`;
}

/** Sizes the canvas to its box (device pixels) and draws one frame. */
function drawRocket(c, p, t) {
  const W = c.clientWidth, H = c.clientHeight;
  if (!W || !H) return;
  const dpr = window.devicePixelRatio || 1;
  if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  RocketScene.draw(ctx, W, H, p, t, isDarkNow());
}

// ── RocketScene ───────────────────────────────────────────────────────────────────────────────────────────────────
// One frame of the flight. `p` 0…1 is the flight (nose just below the bottom edge → flame gone past the top), `t` the
// clock for flicker. Flat layers in the app's colours: a long-nosed ship with a visor and the logo's dot, two strap-on
// boosters with swept fins, a main flame with shock diamonds, ground smoke lit by the ignition, and reaction-control
// puffs at the nose that keep it upright.

const rgb = (r, g, b, a = 1) => `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${a})`;
const white = (w, a = 1) => rgb(w, w, w, a);
const ORANGE = [0.949, 0.380, 0.200], AMBER = [0.99, 0.76, 0.30], CORE = [1, 0.97, 0.88];
const orange = (a = 1) => rgb(...ORANGE, a);
/** Hull length (nose tip to engine exits) in hull widths, and the flame below it. */
const HULL_LEN = 6.6, FLAME_LEN = 3.0;

export const RocketScene = {
  draw(ctx, W, H, p, t, dark) {
    // a capital ship: the hull alone is about twice the height of the area, so it is never seen whole
    const w = Math.min(W * 0.26, H * 0.30);
    const Ltot = (HULL_LEN + FLAME_LEN) * w;
    const noseY = (q) => (H + 0.02 * H) - (H * 1.02 + Ltot + 0.04 * H) * Math.pow(q, 1.8);   // slow, then faster
    const nose = noseY(p);
    const cx = W / 2;

    RocketScene.smoke(ctx, W, H, cx, w, p, dark);

    ctx.save();
    ctx.translate(cx - w / 2, nose);
    ctx.scale(w, w);
    RocketScene.flames(ctx, t);
    RocketScene.ship(ctx, dark);
    // the thrusters fire from whichever station is near the middle of the view at that moment
    RocketScene.rcs(ctx, p, t, dark, (at) => (H * 0.5 - noseY(at)) / w);
    ctx.restore();
  },

  // MARK: ship
  poly(pts) { const p = new Path2D(); pts.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y))); p.closePath(); return p; },
  rect(x, y, w, h) { const p = new Path2D(); p.rect(x, y, w, h); return p; },
  ellipse(x, y, w, h) { const p = new Path2D(); p.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, 2 * Math.PI); return p; },
  ship(r, dark) {
    const { poly, rect, ellipse } = RocketScene;
    const fill = (path, c) => { r.fillStyle = c; r.fill(path); };
    // stainless steel, drawn as flat bands round the cylinder: shade on the left, a bright stripe right of centre
    const steel = dark ? rgb(0.80, 0.81, 0.83) : rgb(0.70, 0.71, 0.74);
    const steelShade = dark ? rgb(0.62, 0.63, 0.66) : rgb(0.55, 0.56, 0.59);
    const steelHi = dark ? rgb(0.93, 0.94, 0.95) : rgb(0.84, 0.85, 0.87);
    // heat-shield tiles: charcoal, light enough to stand off the near-black page in Dark Mode
    const tile = dark ? rgb(0.27, 0.28, 0.31) : rgb(0.16, 0.165, 0.18);
    const tileLine = dark ? 'rgba(0,0,0,0.28)' : 'rgba(255,255,255,0.08)';
    const rim = dark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.25)';
    const body = 1.45, end = 6.2;
    // aft flaps (behind the hull)
    fill(poly([[0.02, 4.85], [-0.34, 5.15], [-0.34, 6.0], [0.02, 6.1]]), tile);
    fill(poly([[0.98, 4.85], [1.34, 5.15], [1.34, 6.0], [0.98, 6.1]]), tile);
    // the hull
    const hull = new Path2D();
    hull.moveTo(0, end);
    hull.lineTo(0, body);
    hull.bezierCurveTo(0, 0.62, 0.28, 0, 0.5, 0);
    hull.bezierCurveTo(0.72, 0, 1, 0.62, 1, body);
    hull.lineTo(1, end); hull.closePath();
    fill(hull, steel);
    r.save();
    r.clip(hull);
    fill(rect(0.62, 0, 0.1, end), steelHi);
    fill(rect(0.86, 0, 0.14, end), steelShade);
    // heat shield: black tiles over the windward (left) side, with a staggered tile grid
    fill(rect(0, 0, 0.44, end), tile);
    const grid = new Path2D();
    let row = 0;
    // stride(from:to:by:) steps as start + n·by
    for (let n = 0, y = 0.2; y < end; n++, y = 0.2 + n * 0.11) {
      grid.moveTo(0, y); grid.lineTo(0.44, y);
      const x0 = row % 2 === 0 ? 0.07 : 0.12;
      for (let m = 0, x = x0; x < 0.44; m++, x = x0 + m * 0.1) { grid.moveTo(x, y); grid.lineTo(x, y + 0.11); }
      row += 1;
    }
    r.strokeStyle = tileLine; r.lineWidth = 0.012; r.stroke(grid);
    // ring welds on the steel
    const rings = new Path2D();
    for (let n = 0, y = 1.7; y < end; n++, y = 1.7 + n * 0.36) { rings.moveTo(0.44, y); rings.lineTo(1, y); }
    r.strokeStyle = 'rgba(0,0,0,0.13)'; r.lineWidth = 0.012; r.stroke(rings);
    // brand: an orange band and the logo's dot as the insignia, a row of ports
    fill(rect(0.44, 2.55, 0.56, 0.07), orange());
    fill(ellipse(0.66, 2.78, 0.12, 0.12), orange());
    for (let i = 0; i < 4; i++) {
      const port = new Path2D(); port.roundRect(0.52 + i * 0.11, 1.62, 0.06, 0.09, 0.02);
      fill(port, rgb(0.06, 0.07, 0.09));
    }
    r.restore();
    // forward flaps
    fill(poly([[0.02, 1.5], [-0.2, 1.72], [-0.2, 2.35], [0.02, 2.48]]), tile);
    fill(poly([[0.98, 1.5], [1.2, 1.72], [1.2, 2.35], [0.98, 2.48]]), tile);
    // running lights on the flap tips
    for (const [x, y] of [[-0.2, 1.74], [1.17, 1.74], [-0.34, 5.17], [1.31, 5.17]]) fill(ellipse(x, y, 0.03, 0.03), orange());
    // engine skirt and the bells: a big centre engine between two outer ones
    fill(rect(0, end, 1, 0.14), white(0.22));
    for (const [cx, half, h] of [[0.2, 0.13, 0.26], [0.8, 0.13, 0.26], [0.5, 0.18, 0.32]]) {
      fill(poly([[cx - half * 0.6, end + 0.14], [cx + half * 0.6, end + 0.14], [cx + half, end + 0.14 + h], [cx - half, end + 0.14 + h]]), white(0.30));
      fill(rect(cx - half, end + 0.12 + h, half * 2, 0.035), rgb(...AMBER));
    }
    // rim light: the outline reads on any page (Swift strokes it last, in a defer)
    r.strokeStyle = rim; r.lineWidth = 0.018; r.stroke(hull);
  },

  // MARK: flames
  flames(r, t) {
    const plume = (cx, top, len, half, c) => {
      const f = new Path2D();
      f.moveTo(cx - half, top);
      f.quadraticCurveTo(cx - half * 1.3, top + len * 0.55, cx, top + len);
      f.quadraticCurveTo(cx + half * 1.3, top + len * 0.55, cx + half, top);
      f.closePath();
      r.fillStyle = c; r.fill(f);
    };
    const k = 1 + 0.06 * Math.sin(t * 47) + 0.04 * Math.sin(t * 83);
    const top = 6.62;
    // one broad plume from the whole cluster, then each engine's own
    plume(0.5, top - 0.05, FLAME_LEN * k, 0.62, orange());
    for (const [cx, s] of [[0.2, 0.8], [0.8, 0.8], [0.5, 1.0]]) {
      plume(cx, top, 2.1 * s * k, 0.15 * s + 0.04, rgb(...AMBER));
      plume(cx, top, 1.1 * s * k, 0.07 * s + 0.02, rgb(...CORE));
    }
    for (let i = 0; i < 5; i++) {
      const y = top + 0.32 + i * 0.38 * k, h = 0.09 - i * 0.014;
      const d = new Path2D();
      d.moveTo(0.5, y - h * 1.7); d.lineTo(0.5 + h, y);
      d.lineTo(0.5, y + h * 1.7); d.lineTo(0.5 - h, y); d.closePath();
      r.fillStyle = `rgba(255,255,255,${0.9 - i * 0.15})`; r.fill(d);
    }
  },

  // MARK: reaction control
  /** Hard side jets at the nose: a bright core and a cone of gas that blasts out and spreads, left and right in turn. */
  rcs(r, p, t, dark, focus) {
    const gas = dark ? [1, 1, 1] : [0.55, 0.58, 0.64];
    const stations = [1.95, 3.2, 4.3, 5.4];
    for (const [at, left] of [[0.2, true], [0.29, false], [0.39, true], [0.48, false], [0.58, true], [0.67, false]]) {
      const k = (p - at) / 0.11;
      if (!(k >= 0 && k <= 1)) continue;
      // the station nearest the middle of the view when this burst began (it stays put on the hull after that)
      const f = focus(at);
      const y0 = stations.reduce((best, s) => (Math.abs(s - f) < Math.abs(best - f) ? s : best), stations[0]);
      const s = left ? -1 : 1;
      const x0 = left ? -0.02 : 1.02;
      const reach = 2.4 * Math.pow(k, 0.45);                  // shoots out fast, then slows
      const strength = k < 0.6 ? 1 : (1 - k) / 0.4;
      // the jet core
      const j = new Path2D();
      j.moveTo(x0, y0 - 0.05); j.lineTo(x0 + s * reach * 0.55, y0); j.lineTo(x0, y0 + 0.05); j.closePath();
      r.fillStyle = rgb(...gas, 0.95 * strength); r.fill(j);
      // the cone of gas
      for (let n = 0; n < 14; n++) {
        const d = n / 13;
        const wob = 0.04 * Math.sin(t * 30 + n);
        const rad = 0.05 + 0.32 * d * (0.4 + 0.6 * k);
        const x = x0 + s * reach * (0.15 + 0.85 * d), y = y0 + wob + 0.1 * d * k;
        r.fillStyle = rgb(...gas, Math.max(0, strength * (0.55 - 0.4 * d)));
        r.beginPath(); r.arc(x, y, rad, 0, 2 * Math.PI); r.fill();
      }
    }
  },

  // MARK: ground smoke
  smoke(ctx, W, H, cx, w, p, dark) {
    if (!(p < 0.78)) return;
    const k = p / 0.78;
    const fade = Math.pow(1 - k, 1.3);
    // the glow of the ignition on the pad (flat rings, strongest at the start)
    const glow = 1 - Math.min(1, p / 0.45);
    [1.0, 0.7, 0.45].forEach((f, i) => {
      const rx = w * 2.4 * f, ry = w * 0.9 * f;
      ctx.fillStyle = orange(glow * (dark ? 0.10 : 0.08) * (i + 1));
      ctx.beginPath(); ctx.ellipse(cx, H, rx, ry, 0, 0, 2 * Math.PI); ctx.fill();
    });
    const tones = dark ? [0.24, 0.32, 0.42] : [0.80, 0.87, 0.93];
    for (let layer = 0; layer < 3; layer++) {
      for (let i = 0; i < 9; i++) {
        const a = rand(i + layer * 17, 1), b = rand(i + layer * 17, 2), c = rand(i + layer * 17, 3);
        const dir = i % 2 === 0 ? -1 : 1;
        const spread = W * (0.10 + 0.40 * a) * Math.pow(k, 0.7);
        const rise = H * (0.03 + 0.14 * b) * k;
        const rad = w * (0.35 + 0.55 * c) * (0.55 + 0.9 * k) * (1 - layer * 0.18);
        const x = cx + dir * (w * 0.3 * a + spread), y = H + rad * 0.25 - rise;
        ctx.fillStyle = white(tones[layer], fade * 0.95);
        ctx.beginPath(); ctx.arc(x, y, rad, 0, 2 * Math.PI); ctx.fill();
        // lit from below by the flame
        const lit = rad * 0.55;
        ctx.fillStyle = orange(fade * glow * 0.35);
        ctx.beginPath(); ctx.ellipse(x, y + rad * 0.35, lit, lit * 0.4, 0, 0, 2 * Math.PI); ctx.fill();
      }
    }
  },
};

/** Fixed pseudo-random numbers, so the pattern holds from frame to frame. */
function rand(i, k) {
  const v = Math.sin((i * 127 + k * 311) * 12.9898) * 43758.5453;
  return v - Math.floor(v);
}
