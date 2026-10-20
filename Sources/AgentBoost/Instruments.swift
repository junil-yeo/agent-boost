import SwiftUI

// Cockpit instruments shared by the banner and the board, plus their power-on self-test looks used while data loads.
// Only Theme is needed here, so the pieces can be rendered on their own.

/// 240° dial: scale ticks every 10 %, a red band over 85 %, the value arc, a magenta bug outside the scale.
struct InstrumentDial<Center: View>: View {
    var value: Double; var tint: Color; var bug: Double?; var projected: Double?
    var dim = false            // self-test: scale drawn fainter
    @ViewBuilder var center: () -> Center
    static func angle(_ v: Double) -> Angle { .degrees(150 + 240 * max(0, min(1, v))) }
    var body: some View {
        Canvas { ctx, size in
            let c = CGPoint(x: size.width / 2, y: size.height / 2)
            let r = min(size.width, size.height) / 2 - 6
            func arc(_ from: Double, _ to: Double, _ radius: CGFloat) -> Path {
                var p = Path(); p.addArc(center: c, radius: radius, startAngle: Self.angle(from), endAngle: Self.angle(to), clockwise: false); return p
            }
            func pt(_ v: Double, _ radius: CGFloat) -> CGPoint {
                let a = Self.angle(v).radians; return CGPoint(x: c.x + CGFloat(Foundation.cos(a)) * radius, y: c.y + CGFloat(Foundation.sin(a)) * radius)
            }
            ctx.stroke(arc(0, 1, r), with: .color(Theme.ink.opacity(0.10)), style: StrokeStyle(lineWidth: 5, lineCap: .butt))
            ctx.stroke(arc(0.85, 1, r + 4), with: .color(Theme.errorTone.opacity(dim ? 0.35 : 0.75)), style: StrokeStyle(lineWidth: 1.5))
            for i in 0...10 {
                var t = Path(); let major = i % 5 == 0
                // during the self-test the ticks light up as the sweep passes them
                let passed = Double(i) / 10 <= value + 0.001
                t.move(to: pt(Double(i) / 10, r - 4)); t.addLine(to: pt(Double(i) / 10, r - (major ? 9 : 6.5)))
                let o = dim ? (passed ? 0.9 : 0.25) : (major ? 0.85 : 0.45)
                ctx.stroke(t, with: .color(Theme.busy.opacity(o)), lineWidth: major ? 1.2 : 0.8)
            }
            if let p = projected, p > 0 {
                let pc: Color = p > 1.2 ? Theme.errorTone : p > 1.0 ? Theme.attention : Theme.textDim
                ctx.stroke(arc(0, min(1, p), r - 11.5), with: .color(pc.opacity(0.55)), style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
            }
            if value > 0 { ctx.stroke(arc(0, value, r), with: .color(tint), style: StrokeStyle(lineWidth: 5, lineCap: .butt)) }
            if let b = bug {   // speed-bug: a small magenta wedge pointing at the scale
                let a = Self.angle(b).radians
                let tip = pt(b, r + 2.5), back = r + 7.5
                let l = CGPoint(x: c.x + CGFloat(Foundation.cos(a - 0.11)) * back, y: c.y + CGFloat(Foundation.sin(a - 0.11)) * back)
                let rr = CGPoint(x: c.x + CGFloat(Foundation.cos(a + 0.11)) * back, y: c.y + CGFloat(Foundation.sin(a + 0.11)) * back)
                var w = Path(); w.move(to: tip); w.addLine(to: l); w.addLine(to: rr); w.closeSubpath()
                ctx.fill(w, with: .color(Theme.bug))
            }
        }
        .overlay(center().offset(y: 2))
    }
}

/// Three annunciator lamps. `on`: 0 정상, 1 주의, 2 경고, -1 none. `test`: lamp-test position (0…3, 3 = all lit).
struct AnnunciatorPanel<Key: View>: View {
    var on: Int
    var test: Int? = nil
    var tip = ""
    var key: Key
    var body: some View {
        VStack(spacing: 5) {
            ForEach(0..<3, id: \.self) { i in
                let level = 2 - i
                let c: Color = [Theme.errorTone, Theme.attention, Theme.normal][i]
                let lit = test.map { $0 == 3 || $0 == i } ?? (on == level)
                Text([L("경고"), L("주의"), L("정상")][i])
                    .font(.system(size: 10, weight: .bold))
                    .lineLimit(1).minimumScaleFactor(0.4).padding(.horizontal, 2)   // longer words (CAUTION, PRECAUCIÓN) shrink to fit
                    .foregroundStyle(lit ? Theme.dyn(0x000000, 0xFFFFFF).opacity(0.85) : c.opacity(0.35))
                    .frame(width: 40, height: 17)
                    .background(RoundedRectangle(cornerRadius: 3).fill(lit ? c : c.opacity(0.07)))
                    .overlay(RoundedRectangle(cornerRadius: 3).stroke(c.opacity(lit ? 0 : 0.25), lineWidth: 1))
                    .help(tip)
            }
            key
        }
        .padding(.horizontal, 6).frame(height: 89)
        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.bezel))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.line, lineWidth: 1))
    }
    /// Lamp test: each lamp in turn, then all three together, then a pause. One cycle = 2.4 s.
    static func testStep(_ t: Double) -> Int? {
        let x = t.truncatingRemainder(dividingBy: 2.4)
        return x < 0.3 ? 0 : x < 0.6 ? 1 : x < 0.9 ? 2 : x < 1.6 ? 3 : nil
    }
}

/// Shared clock for the self-test looks: ~30 fps while shown, still under Reduce Motion. Nothing ticks once loading ends.
struct BootClock<Content: View>: View {
    @Environment(\.accessibilityReduceMotion) private var still
    @ViewBuilder var content: (Double) -> Content
    var body: some View {
        if still { content(0.9) }
        else { TimelineView(.animation(minimumInterval: 1.0 / 30)) { ctx in content(ctx.date.timeIntervalSinceReferenceDate) } }
    }
    /// 0 → 1 → 0, eased, one sweep every `period` seconds.
    static func sweep(_ t: Double, period: Double = 2.6) -> Double { 0.5 - 0.5 * cos(2 * .pi * t / period) }
}

/// A usage instrument before its numbers arrive: the needle runs its power-on sweep. On failure it stops at zero
/// behind a red OFF flag, the way a gauge without a valid signal shows it.
struct MeterSelfTest: View {
    var t: Double
    var status: String
    var failed = false
    var title: String? = nil   // replaces "신호 없음" / "계기 점검 중"
    var body: some View {
        let v = failed ? 0 : BootClock<EmptyView>.sweep(t)
        VStack(alignment: .leading, spacing: 2) {
        HStack(spacing: 10) {
            InstrumentDial(value: v, tint: Theme.busy.opacity(0.75), bug: nil, projected: nil, dim: true) {
                if failed {
                    Text("OFF").font(.system(size: 10, weight: .heavy, design: .monospaced)).foregroundStyle(.white)
                        .padding(.horizontal, 4).padding(.vertical, 1)
                        .background(RoundedRectangle(cornerRadius: 2).fill(Theme.errorTone))
                } else {
                    Text("--").font(.system(size: 17, weight: .semibold, design: .monospaced))
                        .foregroundStyle(Theme.busy.opacity(0.35 + 0.5 * v))
                }
            }
            .frame(width: 62, height: 62)
            VStack(alignment: .leading, spacing: 5) {
                Text(title ?? (failed ? L("신호 없음") : L("계기 점검 중"))).font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(failed ? Theme.errorTone : Theme.busy)
                Text(status).font(.system(size: 10, weight: .medium)).foregroundStyle(Theme.textDim).lineLimit(2)
                if !failed {   // the two value rows, still empty, filling as the needle sweeps
                    ForEach(0..<2, id: \.self) { i in
                        GeometryReader { g in
                            ZStack(alignment: .leading) {
                                Capsule().fill(Theme.ink.opacity(0.06))
                                Capsule().fill(Theme.busy.opacity(0.35)).frame(width: g.size.width * max(0, min(1, v * 1.15 - Double(i) * 0.15)))
                            }
                        }.frame(width: i == 0 ? 70 : 52, height: 3)
                    }
                }
            }
            .frame(width: 92, alignment: .leading)
        }
        Text(failed ? " " : L("소모 추세에 따른 최종 예상 사용량 --")).font(.system(size: 10, weight: .medium)).foregroundStyle(Theme.textDim.opacity(0.6))
            .lineLimit(1).fixedSize().frame(width: 168, alignment: .leading)
        }
        .padding(.horizontal, 8).padding(.vertical, 6)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Theme.bezel))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(failed ? Theme.errorTone.opacity(0.5) : Theme.line, lineWidth: 1))
    }
}

/// Small radar scope: a sweeping beam over range rings.
struct RadarScope: View {
    var t: Double
    var body: some View {
        Canvas { ctx, size in
            let c = CGPoint(x: size.width / 2, y: size.height / 2), r = min(size.width, size.height) / 2 - 1
            for k in [1.0, 0.55] {
                ctx.stroke(Path(ellipseIn: CGRect(x: c.x - r * k, y: c.y - r * k, width: 2 * r * k, height: 2 * r * k)),
                           with: .color(Theme.busy.opacity(0.45)), lineWidth: 1)
            }
            let a = (t.truncatingRemainder(dividingBy: 1.8) / 1.8) * 2 * .pi
            for j in 0..<10 {   // beam with a fading trail
                let aj = a - Double(j) * 0.09
                var p = Path(); p.move(to: c); p.addLine(to: CGPoint(x: c.x + CGFloat(Foundation.cos(aj)) * r, y: c.y + CGFloat(Foundation.sin(aj)) * r))
                ctx.stroke(p, with: .color(Theme.busy.opacity(0.9 * (1 - Double(j) / 10))), lineWidth: j == 0 ? 1.5 : 2)
            }
        }
    }
}

/// The mark: a rocket's nose drawn as one pointed arch (also an A, for Agent), fins kicking out at its feet, and the
/// porthole dot inside: Agent Boost. One colour, readable down to 16 px; the menu bar uses it as a template image.
struct BoostLogo: View {
    var tint: Color = Theme.accent
    var body: some View {
        Canvas { ctx, size in
            let s = min(size.width, size.height)
            let ox = (size.width - s) / 2, oy = (size.height - s) / 2
            func P(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: ox + x * s, y: oy + y * s) }
            let t = s * 0.15                                   // stroke weight
            let l: CGFloat = 0.27, r: CGFloat = 0.73           // leg centrelines
            var arch = Path()
            arch.move(to: P(l, 1))
            arch.addLine(to: P(l, 0.56))
            arch.addQuadCurve(to: P(0.5, 0.06), control: P(l, 0.22))
            arch.addQuadCurve(to: P(r, 0.56), control: P(r, 0.22))
            arch.addLine(to: P(r, 1))
            ctx.stroke(arch, with: .color(tint), style: StrokeStyle(lineWidth: t, lineCap: .butt, lineJoin: .miter, miterLimit: 6))
            var fins = Path()
            fins.move(to: P(l, 0.70)); fins.addLine(to: P(0.06, 0.90)); fins.addLine(to: P(0.06, 1)); fins.addLine(to: P(l, 1)); fins.closeSubpath()
            fins.move(to: P(r, 0.70)); fins.addLine(to: P(0.94, 0.90)); fins.addLine(to: P(0.94, 1)); fins.addLine(to: P(r, 1)); fins.closeSubpath()
            ctx.fill(fins, with: .color(tint))
            let d = s * 0.085
            ctx.fill(Path(ellipseIn: CGRect(x: ox + 0.5 * s - d, y: oy + 0.56 * s - d, width: 2 * d, height: 2 * d)), with: .color(tint))
        }
    }
}

/// The app icon artwork: the mark on a flat graphite tile (macOS icon grid, 824 of 1024 with rounded corners). Fixed
/// colours: the icon is the same whatever the appearance.
struct AppIconArt: View {
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 185, style: .continuous).fill(Color(red: 0.094, green: 0.094, blue: 0.102)).frame(width: 824, height: 824)
            RoundedRectangle(cornerRadius: 185, style: .continuous).strokeBorder(Color.white.opacity(0.08), lineWidth: 4).frame(width: 824, height: 824)
            BoostLogo(tint: Color(red: 0.949, green: 0.380, blue: 0.200)).frame(width: 440, height: 440)
        }
        .frame(width: 1024, height: 1024)
    }
}
