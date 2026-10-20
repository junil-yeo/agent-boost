import SwiftUI

/// First load of the org chart: a large rocket lifts off through the whole area, bottom to top, in 2 s. One flight
/// always plays to the end, even when the sessions arrive sooner; while they are still loading, it flies again.
struct RocketLaunch: View {
    var loaded: Bool
    var onDone: () -> Void
    static let flight: Double = 2
    @State private var start = Date()
    @State private var scheduled = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        ZStack(alignment: .topLeading) {
            if reduceMotion {
                RocketScene(p: 0.42, t: 0)          // still: the rocket mid-flight, no movement
            } else {
                TimelineView(.animation) { tl in
                    let t = tl.date.timeIntervalSince(start)
                    RocketScene(p: (t / Self.flight).truncatingRemainder(dividingBy: 1), t: t)
                        // also checked on every frame: a launch that began while this tab was hidden (the refresh
                        // button pressed on another tab) missed the change of `loaded` and flew forever
                        .onChange(of: loaded && t >= Self.flight * 0.5, initial: true) { _, ready in if ready { finish() } }
                }
            }
            Text("세션을 불러오는 중").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.textDim).padding(16)
        }
        .clipped()
        .accessibilityElement(children: .ignore).accessibilityLabel("세션을 불러오는 중")
        .onAppear { start = Date(); if loaded { finish() } }
        .onChange(of: loaded) { _, l in if l { finish() } }
    }
    /// Done at the end of the flight in progress (at least one whole flight).
    private func finish() {
        guard !scheduled else { return }
        scheduled = true
        let t = Date().timeIntervalSince(start)
        let end = max(1, (t / Self.flight).rounded(.up)) * Self.flight
        DispatchQueue.main.asyncAfter(deadline: .now() + max(0, end - t)) { onDone() }
    }
}

/// One frame of the flight. `p` 0…1 is the flight (nose just below the bottom edge → flame gone past the top), `t` the
/// clock for flicker. Flat layers in the app's colours: a long-nosed ship with a visor and the logo's dot, two strap-on
/// boosters with swept fins, a main flame with shock diamonds, ground smoke lit by the ignition, and reaction-control
/// puffs at the nose that keep it upright.
struct RocketScene: View {
    var p: Double
    var t: Double
    @Environment(\.colorScheme) private var scheme
    private static let orange = Color(red: 0.949, green: 0.380, blue: 0.200)
    private static let amber = Color(red: 0.99, green: 0.76, blue: 0.30)
    private static let core = Color(red: 1, green: 0.97, blue: 0.88)
    /// Hull length (nose tip to engine exits) in hull widths, and the flame below it.
    private static let hullLen = 6.6, flameLen = 3.0
    var body: some View {
        Canvas { ctx, size in
            let W = size.width, H = size.height
            let dark = scheme == .dark
            // a capital ship: the hull alone is about twice the height of the area, so it is never seen whole
            let w = min(W * 0.26, H * 0.30)
            let L = (Self.hullLen + Self.flameLen) * w
            func noseY(_ q: Double) -> Double { (H + 0.02 * H) - (H * 1.02 + L + 0.04 * H) * pow(q, 1.8) }   // slow, then faster
            let nose = noseY(p)
            let cx = W / 2

            Self.smoke(&ctx, W: W, H: H, cx: cx, w: w, p: p, dark: dark)

            var r = ctx
            r.translateBy(x: cx - w / 2, y: nose)
            r.scaleBy(x: w, y: w)
            Self.flames(&r, t: t)
            Self.ship(&r, dark: dark)
            // the thrusters fire from whichever station is near the middle of the view at that moment
            Self.rcs(&r, p: p, t: t, dark: dark) { at in (H * 0.5 - noseY(at)) / w }
        }
    }

    // MARK: ship
    private static func poly(_ pts: [(Double, Double)]) -> Path {
        var p = Path(); p.addLines(pts.map { CGPoint(x: $0.0, y: $0.1) }); p.closeSubpath(); return p
    }
    private static func ship(_ r: inout GraphicsContext, dark: Bool) {
        // stainless steel, drawn as flat bands round the cylinder: shade on the left, a bright stripe right of centre
        let steel = dark ? Color(red: 0.80, green: 0.81, blue: 0.83) : Color(red: 0.70, green: 0.71, blue: 0.74)
        let steelShade = dark ? Color(red: 0.62, green: 0.63, blue: 0.66) : Color(red: 0.55, green: 0.56, blue: 0.59)
        let steelHi = dark ? Color(red: 0.93, green: 0.94, blue: 0.95) : Color(red: 0.84, green: 0.85, blue: 0.87)
        // heat-shield tiles: charcoal, light enough to stand off the near-black page in Dark Mode
        let tile = dark ? Color(red: 0.27, green: 0.28, blue: 0.31) : Color(red: 0.16, green: 0.165, blue: 0.18)
        let tileLine = dark ? Color.black.opacity(0.28) : Color.white.opacity(0.08)
        let rim = dark ? Color.white.opacity(0.55) : Color.black.opacity(0.25)
        let body = 1.45, end = 6.2
        // aft flaps (behind the hull)
        r.fill(poly([(0.02, 4.85), (-0.34, 5.15), (-0.34, 6.0), (0.02, 6.1)]), with: .color(tile))
        r.fill(poly([(0.98, 4.85), (1.34, 5.15), (1.34, 6.0), (0.98, 6.1)]), with: .color(tile))
        // the hull
        var hull = Path()
        hull.move(to: CGPoint(x: 0, y: end))
        hull.addLine(to: CGPoint(x: 0, y: body))
        hull.addCurve(to: CGPoint(x: 0.5, y: 0), control1: CGPoint(x: 0, y: 0.62), control2: CGPoint(x: 0.28, y: 0))
        hull.addCurve(to: CGPoint(x: 1, y: body), control1: CGPoint(x: 0.72, y: 0), control2: CGPoint(x: 1, y: 0.62))
        hull.addLine(to: CGPoint(x: 1, y: end)); hull.closeSubpath()
        r.fill(hull, with: .color(steel))
        defer { r.stroke(hull, with: .color(rim), lineWidth: 0.018) }   // rim light: the outline reads on any page
        var cyl = r
        cyl.clip(to: hull)
        cyl.fill(Path(CGRect(x: 0.62, y: 0, width: 0.1, height: end)), with: .color(steelHi))
        cyl.fill(Path(CGRect(x: 0.86, y: 0, width: 0.14, height: end)), with: .color(steelShade))
        // heat shield: black tiles over the windward (left) side, with a staggered tile grid
        cyl.fill(Path(CGRect(x: 0, y: 0, width: 0.44, height: end)), with: .color(tile))
        var grid = Path()
        var row = 0
        for y in stride(from: 0.2, to: end, by: 0.11) {
            grid.move(to: CGPoint(x: 0, y: y)); grid.addLine(to: CGPoint(x: 0.44, y: y))
            for x in stride(from: row % 2 == 0 ? 0.07 : 0.12, to: 0.44, by: 0.1) {
                grid.move(to: CGPoint(x: x, y: y)); grid.addLine(to: CGPoint(x: x, y: y + 0.11))
            }
            row += 1
        }
        cyl.stroke(grid, with: .color(tileLine), lineWidth: 0.012)
        // ring welds on the steel
        var rings = Path()
        for y in stride(from: 1.7, to: end, by: 0.36) { rings.move(to: CGPoint(x: 0.44, y: y)); rings.addLine(to: CGPoint(x: 1, y: y)) }
        cyl.stroke(rings, with: .color(Color.black.opacity(0.13)), lineWidth: 0.012)
        // brand: an orange band and the logo's dot as the insignia, a row of ports
        cyl.fill(Path(CGRect(x: 0.44, y: 2.55, width: 0.56, height: 0.07)), with: .color(orange))
        cyl.fill(Path(ellipseIn: CGRect(x: 0.66, y: 2.78, width: 0.12, height: 0.12)), with: .color(orange))
        for i in 0..<4 {
            cyl.fill(Path(roundedRect: CGRect(x: 0.52 + Double(i) * 0.11, y: 1.62, width: 0.06, height: 0.09), cornerRadius: 0.02),
                     with: .color(Color(red: 0.06, green: 0.07, blue: 0.09)))
        }
        // forward flaps
        r.fill(poly([(0.02, 1.5), (-0.2, 1.72), (-0.2, 2.35), (0.02, 2.48)]), with: .color(tile))
        r.fill(poly([(0.98, 1.5), (1.2, 1.72), (1.2, 2.35), (0.98, 2.48)]), with: .color(tile))
        // running lights on the flap tips
        for (x, y) in [(-0.2, 1.74), (1.17, 1.74), (-0.34, 5.17), (1.31, 5.17)] {
            r.fill(Path(ellipseIn: CGRect(x: x, y: y, width: 0.03, height: 0.03)), with: .color(orange))
        }
        // engine skirt and the bells: a big centre engine between two outer ones
        r.fill(Path(CGRect(x: 0, y: end, width: 1, height: 0.14)), with: .color(Color(white: 0.22)))
        for (cx, half, h) in [(0.2, 0.13, 0.26), (0.8, 0.13, 0.26), (0.5, 0.18, 0.32)] {
            r.fill(poly([(cx - half * 0.6, end + 0.14), (cx + half * 0.6, end + 0.14), (cx + half, end + 0.14 + h), (cx - half, end + 0.14 + h)]),
                   with: .color(Color(white: 0.30)))
            r.fill(Path(CGRect(x: cx - half, y: end + 0.12 + h, width: half * 2, height: 0.035)), with: .color(amber))
        }
    }

    // MARK: flames
    private static func flames(_ r: inout GraphicsContext, t: Double) {
        func plume(_ cx: Double, top: Double, len: Double, half: Double, _ c: Color) {
            var f = Path()
            f.move(to: CGPoint(x: cx - half, y: top))
            f.addQuadCurve(to: CGPoint(x: cx, y: top + len), control: CGPoint(x: cx - half * 1.3, y: top + len * 0.55))
            f.addQuadCurve(to: CGPoint(x: cx + half, y: top), control: CGPoint(x: cx + half * 1.3, y: top + len * 0.55))
            f.closeSubpath()
            r.fill(f, with: .color(c))
        }
        let k = 1 + 0.06 * sin(t * 47) + 0.04 * sin(t * 83)
        let top = 6.62
        // one broad plume from the whole cluster, then each engine's own
        plume(0.5, top: top - 0.05, len: flameLen * k, half: 0.62, orange)
        for (cx, s) in [(0.2, 0.8), (0.8, 0.8), (0.5, 1.0)] {
            plume(cx, top: top, len: 2.1 * s * k, half: 0.15 * s + 0.04, amber)
            plume(cx, top: top, len: 1.1 * s * k, half: 0.07 * s + 0.02, core)
        }
        for i in 0..<5 {
            let y = top + 0.32 + Double(i) * 0.38 * k, h = 0.09 - Double(i) * 0.014
            var d = Path()
            d.move(to: CGPoint(x: 0.5, y: y - h * 1.7)); d.addLine(to: CGPoint(x: 0.5 + h, y: y))
            d.addLine(to: CGPoint(x: 0.5, y: y + h * 1.7)); d.addLine(to: CGPoint(x: 0.5 - h, y: y)); d.closeSubpath()
            r.fill(d, with: .color(Color.white.opacity(0.9 - Double(i) * 0.15)))
        }
    }

    // MARK: reaction control
    /// Hard side jets at the nose: a bright core and a cone of gas that blasts out and spreads, left and right in turn.
    private static func rcs(_ r: inout GraphicsContext, p: Double, t: Double, dark: Bool, focus: (Double) -> Double) {
        let gas = dark ? Color.white : Color(red: 0.55, green: 0.58, blue: 0.64)
        let stations = [1.95, 3.2, 4.3, 5.4]
        for (at, left) in [(0.2, true), (0.29, false), (0.39, true), (0.48, false), (0.58, true), (0.67, false)] {
            let k = (p - at) / 0.11
            guard k >= 0, k <= 1 else { continue }
            // the station nearest the middle of the view when this burst began (it stays put on the hull after that)
            let f = focus(at)
            let y0 = stations.min { abs($0 - f) < abs($1 - f) } ?? 1.95
            let s: Double = left ? -1 : 1
            let x0 = left ? -0.02 : 1.02
            let reach = 2.4 * pow(k, 0.45)                  // shoots out fast, then slows
            let strength = k < 0.6 ? 1 : (1 - k) / 0.4
            // the jet core
            var j = Path()
            j.move(to: CGPoint(x: x0, y: y0 - 0.05)); j.addLine(to: CGPoint(x: x0 + s * reach * 0.55, y: y0)); j.addLine(to: CGPoint(x: x0, y: y0 + 0.05)); j.closeSubpath()
            r.fill(j, with: .color(gas.opacity(0.95 * strength)))
            // the cone of gas
            for n in 0..<14 {
                let d = Double(n) / 13
                let wob = 0.04 * sin(t * 30 + Double(n))
                let rad = 0.05 + 0.32 * d * (0.4 + 0.6 * k)
                let x = x0 + s * reach * (0.15 + 0.85 * d), y = y0 + wob + 0.1 * d * k
                r.fill(Path(ellipseIn: CGRect(x: x - rad, y: y - rad, width: 2 * rad, height: 2 * rad)),
                       with: .color(gas.opacity(strength * (0.55 - 0.4 * d))))
            }
        }
    }

    // MARK: ground smoke
    private static func smoke(_ ctx: inout GraphicsContext, W: Double, H: Double, cx: Double, w: Double, p: Double, dark: Bool) {
        guard p < 0.78 else { return }
        let k = p / 0.78
        let fade = pow(1 - k, 1.3)
        // the glow of the ignition on the pad (flat rings, strongest at the start)
        let glow = (1 - min(1, p / 0.45))
        for (i, f) in [1.0, 0.7, 0.45].enumerated() {
            let rx = w * 2.4 * f, ry = w * 0.9 * f
            ctx.fill(Path(ellipseIn: CGRect(x: cx - rx, y: H - ry, width: 2 * rx, height: 2 * ry)),
                     with: .color(orange.opacity(glow * (dark ? 0.10 : 0.08) * Double(i + 1))))
        }
        let tones: [Color] = dark ? [Color(white: 0.24), Color(white: 0.32), Color(white: 0.42)]
                                  : [Color(white: 0.80), Color(white: 0.87), Color(white: 0.93)]
        for layer in 0..<3 {
            for i in 0..<9 {
                let a = rand(i + layer * 17, 1), b = rand(i + layer * 17, 2), c = rand(i + layer * 17, 3)
                let dir: Double = i % 2 == 0 ? -1 : 1
                let spread = W * (0.10 + 0.40 * a) * pow(k, 0.7)
                let rise = H * (0.03 + 0.14 * b) * k
                let rad = w * (0.35 + 0.55 * c) * (0.55 + 0.9 * k) * (1 - Double(layer) * 0.18)
                let x = cx + dir * (w * 0.3 * a + spread), y = H + rad * 0.25 - rise
                ctx.fill(Path(ellipseIn: CGRect(x: x - rad, y: y - rad, width: 2 * rad, height: 2 * rad)),
                         with: .color(tones[layer].opacity(fade * 0.95)))
                // lit from below by the flame
                let lit = rad * 0.55
                ctx.fill(Path(ellipseIn: CGRect(x: x - lit, y: y + rad * 0.35 - lit * 0.4, width: 2 * lit, height: lit * 0.8)),
                         with: .color(orange.opacity(fade * glow * 0.35)))
            }
        }
    }

    /// Fixed pseudo-random numbers, so the pattern holds from frame to frame.
    private static func rand(_ i: Int, _ k: Int) -> Double {
        let v = sin(Double(i * 127 + k * 311) * 12.9898) * 43758.5453
        return v - v.rounded(.down)
    }
}
