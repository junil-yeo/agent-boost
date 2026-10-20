import SwiftUI

/// Visual language: flat panels in the manner of VS Code (one bar colour, one editor colour, 1 px seams, small radii)
/// and a cockpit's instruments. Dark and light ("White Mode") share every token; the instrument strip and the CLI screen
/// stay dark in both, the way a cockpit's displays do.
enum Theme {
    /// A colour that follows the window's appearance: `dark` in Dark Mode, `light` otherwise (0xRRGGBB).
    static func dyn(_ dark: UInt32, _ light: UInt32, alpha: CGFloat = 1) -> Color {
        Color(nsColor: NSColor(name: nil) { ap in
            let v = ap.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
            return NSColor(srgbRed: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255, blue: CGFloat(v & 0xFF) / 255, alpha: alpha)
        })
    }
    // Layout as in VS Code: a near-black base, and every area (banner, tab row, side bar, header, chat, input, each
    // section) a box of one shared colour with its own 1 px rounded edge. Areas are told apart by the gap between the
    // boxes, never by ruled lines; nothing inside an area takes a second background colour.
    static let base     = dyn(0x050506, 0xE9E9EC)   // behind everything, seen only in the gaps
    static let area     = dyn(0x101012, 0xFFFFFF)   // every area's box
    static let gap: CGFloat = 4
    static let areaRadius: CGFloat = 8
    static let bgTop    = area
    static let bgBottom = area
    static let strip    = area
    static let panel    = area
    static let cardTop  = area
    static let cardBot  = area
    static let bezel    = dyn(0x08080A, 0xF4F4F6)   // instrument glass, a shade off the box it sits in
    static let line     = dyn(0x232327, 0xDCDCE0)   // the 1 px edge of every box
    static let lineHi   = dyn(0x46464C, 0xBDBDC3)   // hover / focus edge
    static let surface1 = dyn(0x1A1A1D, 0xF3F3F5)   // hover
    static let surface2 = dyn(0x242428, 0xE9E9EC)   // selected / filled control
    static let surface3 = dyn(0x2E2E33, 0xDEDEE2)   // filled control, hover
    static let textDim  = dyn(0x9D9DA3, 0x5F5F66)
    static let userBubble = surface2
    static let peerBubble = ink.opacity(0.04)
    /// Ink for washes and hairlines drawn over any surface: white in Dark Mode, black in light.
    static let ink      = dyn(0xFFFFFF, 0x000000)
    static let screen   = area   // the CLI screen: the same box colour as every other area
    static let screenLight = area
    // signal colours: glass-cockpit meanings, darker in light mode so they read on white
    static let accent   = dyn(0xF26133, 0xE4521F)   // International Orange (brand)
    static let attention = dyn(0xFCC24D, 0xB45309)  // amber caution: "needs your answer", never error-red
    static let errorTone = dyn(0xF87171, 0xDC2626)  // warning
    static let busy     = dyn(0x5FD4F4, 0x0E7490)   // cyan: standby / lead
    static let normal   = dyn(0x4ADE80, 0x15803D)   // green: running
    static let bug      = dyn(0xE879F9, 0xA21CAF)   // magenta target bug
    static let modelTint  = dyn(0xCCADFF, 0x6D28D9)
    static let effortTint = dyn(0x73D1CC, 0x0F766E)
    static let accentHover = dyn(0xFA7347, 0xF26133)
    static let accentDown  = dyn(0xD65229, 0xC2410C)

    static var background: Color { base }
    static var card: Color { cardTop }
    static var accentGrad: Color { accent }   // flat: one solid colour
}

/// Window appearance: follows macOS, or forced dark / light from the View menu or the tab row.
enum AppearanceMode: String, CaseIterable {
    case system, dark, light
    var scheme: ColorScheme? { self == .dark ? .dark : self == .light ? .light : nil }
    var title: String { self == .dark ? "다크" : self == .light ? "화이트" : "시스템 설정 따르기" }
}

/// Raised, slightly glossy button. `prominent` = accent; `active` = selected tab.
struct RaisedButtonStyle: ButtonStyle {
    var active = false
    var prominent = false
    var compact = false
    var minHeight: CGFloat? = nil
    func makeBody(configuration: Configuration) -> some View {
        let pressed = configuration.isPressed
        let strong = prominent || active
        configuration.label
            .font(.system(size: 13, weight: strong ? .semibold : .medium))
            .foregroundStyle(strong ? Color.white : Color.primary.opacity(0.88))
            .padding(.horizontal, compact ? 10 : 14).frame(minHeight: minHeight ?? (compact ? 28 : 32))
            .background(
                RoundedRectangle(cornerRadius: 4, style: .continuous)
                    .fill(strong ? AnyShapeStyle(Theme.accent) : AnyShapeStyle(Theme.ink.opacity(pressed ? 0.12 : 0.07)))
            )
            .overlay(RoundedRectangle(cornerRadius: 4, style: .continuous).stroke(strong ? Color.clear : Theme.line, lineWidth: 1))
            .opacity(pressed && strong ? 0.85 : 1)
            .animation(.easeOut(duration: 0.08), value: pressed)
    }
}
extension ButtonStyle where Self == RaisedButtonStyle {
    static var raised: RaisedButtonStyle { RaisedButtonStyle() }
    static var raisedProminent: RaisedButtonStyle { RaisedButtonStyle(prominent: true) }
    static var raisedCompact: RaisedButtonStyle { RaisedButtonStyle(compact: true) }
}

/// Flat filled buttons for the tab row: `raised` = the open tab (a lighter solid face), `strong` = 새 세션 (an accent-
/// tinted chip), `small` = the GitHub link. Solid colour only: no gradient, shadow or glow.
struct TabFaceStyle: ButtonStyle {
    var raised = false
    var strong = false
    var small = false
    func makeBody(configuration: Configuration) -> some View { Inner(configuration: configuration, raised: raised, strong: strong, small: small) }
    private struct Inner: View {
        let configuration: Configuration
        var raised: Bool; var strong: Bool; var small: Bool
        @State private var hover = false
        var body: some View {
            let pressed = configuration.isPressed
            let shape = RoundedRectangle(cornerRadius: small ? 3 : 4, style: .continuous)
            // strong (새 세션): a quiet accent-tinted chip, not a solid orange block
            let face: Color = strong ? Theme.accent.opacity(pressed ? 0.28 : hover ? 0.22 : 0.16)
                : raised ? (pressed ? Theme.surface2 : hover ? Theme.surface3 : Theme.surface2)
                : (pressed ? Theme.surface2 : hover ? Theme.surface1 : .clear)
            configuration.label
                .font(.system(size: small ? 11 : 13, weight: strong || raised ? .semibold : .medium))
                .foregroundStyle(strong ? Theme.accent : raised ? Color.primary : Theme.textDim)
                .padding(.horizontal, small ? 8 : 12).frame(minHeight: small ? 20 : 30)
                .background(shape.fill(face))
                .overlay(shape.stroke(strong ? Theme.accent.opacity(0.35) : Color.clear, lineWidth: 1))
                .contentShape(shape)
                .onHover { hover = $0 }
                .animation(.easeOut(duration: 0.12), value: hover)
        }
    }
}

/// Utility actions next to the tabs (update, background, disk): text-weight, never competing with the tabs or 새 세션.
struct QuietButtonStyle: ButtonStyle {
    var active = false
    func makeBody(configuration: Configuration) -> some View { Inner(configuration: configuration, active: active) }
    private struct Inner: View {
        let configuration: Configuration
        var active: Bool
        @State private var hover = false
        var body: some View {
            configuration.label
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(active || hover || configuration.isPressed ? Color.primary : Theme.textDim)
                .padding(.horizontal, 8).frame(minHeight: 28)
                .background(RoundedRectangle(cornerRadius: 4, style: .continuous).fill(active ? Theme.surface2 : Theme.ink.opacity(configuration.isPressed ? 0.08 : hover ? 0.05 : 0)))
                .contentShape(Rectangle())
                .onHover { hover = $0 }
                .animation(.easeOut(duration: 0.15), value: hover)
        }
    }
}

/// Card surface: a solid fill one step above the page and a hairline edge.
struct CardSurface: ViewModifier {
    var stripe: Color? = nil
    var radius: CGFloat = 6
    var selected = false
    var hover = false
    func body(content: Content) -> some View {
        content
            // flat: the state is already shown by the dot and label, so no coloured edge stripe
            .background(RoundedRectangle(cornerRadius: radius, style: .continuous).fill(Theme.cardTop))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).stroke(selected ? Theme.accent : hover ? Theme.lineHi : Theme.line, lineWidth: selected ? 1.5 : 1))
            .animation(.easeOut(duration: 0.15), value: hover)
    }
}
extension View {
    func cardSurface(stripe: Color? = nil, radius: CGFloat = 6, selected: Bool = false, hover: Bool = false) -> some View {
        modifier(CardSurface(stripe: stripe, radius: radius, selected: selected, hover: hover))
    }
}

/// VS Code editor tab: square, flush with the bar; the open tab takes the page colour with a 2 px accent line on top.
struct EditorTabStyle: ButtonStyle {
    var active = false
    func makeBody(configuration: Configuration) -> some View { Inner(configuration: configuration, active: active) }
    private struct Inner: View {
        let configuration: Configuration
        var active: Bool
        @State private var hover = false
        var body: some View {
            configuration.label
                .font(.system(size: 13, weight: active ? .medium : .regular))
                .foregroundStyle(active || hover ? Color.primary : Theme.textDim)
                .padding(.horizontal, 14).frame(maxHeight: .infinity)
                .background(active ? Theme.bgTop : hover ? Theme.surface1 : Color.clear)
                .overlay(alignment: .top) { if active { Rectangle().fill(Theme.accent).frame(height: 2) } }
                .overlay(alignment: .trailing) { Rectangle().fill(Theme.line).frame(width: 1) }
                .contentShape(Rectangle())
                .onHover { hover = $0 }
        }
    }
}

/// An area's box: the shared area colour, its own 1 px rounded edge, contents clipped to it. Boxes sit `Theme.gap`
/// apart on the base colour; that gap is the boundary.
extension View {
    func areaBox(radius: CGFloat = Theme.areaRadius) -> some View {
        background(RoundedRectangle(cornerRadius: radius, style: .continuous).fill(Theme.area))
            .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(Theme.line, lineWidth: 1))
    }
    func panelBox(radius: CGFloat = Theme.areaRadius) -> some View { areaBox(radius: radius) }
}

/// Opaque, high-contrast count pill (readable on dark and light surfaces).
struct CountBadge: View {
    let count: Int
    var tint: Color = Theme.accent
    var fg: Color = .white
    var body: some View {
        Text("\(count)")
            .font(.system(size: 11, weight: .bold).monospacedDigit())
            .foregroundStyle(fg)
            .padding(.horizontal, 5).frame(minWidth: 18, minHeight: 18)
            .background(RoundedRectangle(cornerRadius: 4, style: .continuous).fill(tint))
    }
}

/// Quiet icon-only button: dim at rest, bright with a soft chip on hover/press.
struct IconButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { Inner(configuration: configuration) }
    private struct Inner: View {
        let configuration: Configuration
        @State private var hover = false
        @Environment(\.isEnabled) private var enabled
        var body: some View {
            configuration.label
                .foregroundStyle(Color.primary.opacity(configuration.isPressed || hover ? 1 : 0.65))
                .padding(3)
                .background(RoundedRectangle(cornerRadius: 5).fill(Theme.ink.opacity(configuration.isPressed ? 0.16 : hover ? 0.09 : 0)))
                .contentShape(Rectangle())
                .onHover { hover = $0 }
                .opacity(enabled ? 1 : 0.35)
        }
    }
}
extension ButtonStyle where Self == IconButtonStyle {
    static var icon: IconButtonStyle { IconButtonStyle() }
}

/// Round initial avatar for a speaker (agent, lead, teammate).
struct Avatar: View {
    let label: String
    var tint: Color = Theme.accent
    var body: some View {
        Text(String(label.trimmingCharacters(in: .whitespaces).prefix(1)).uppercased())
            .font(.system(size: 12, weight: .semibold)).foregroundStyle(.white)
            .frame(width: 26, height: 26)
            .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(tint.opacity(0.85)))
            .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).stroke(Theme.ink.opacity(0.12), lineWidth: 1))
    }
}

/// A plain button that builds its AppKit menu only when clicked. SwiftUI `Menu` builds every item (and a pop-up
/// button) each time the view is created, which made switching tabs slow; this costs one Button until it is used.
enum MenuEntry {
    case item(String, enabled: Bool = true, action: () -> Void)
    case header(String)
    case separator
}
struct LazyMenu<Label: View>: View {
    var entries: () -> [MenuEntry]
    @ViewBuilder var label: () -> Label
    var body: some View {
        Button { LazyMenuPresenter.show(entries()) } label: { label() }
    }
}
@MainActor enum LazyMenuPresenter {
    final class Item: NSMenuItem {
        var run: () -> Void = {}
        @objc func fire() { run() }
    }
    static func show(_ entries: [MenuEntry]) {
        let m = NSMenu(); m.autoenablesItems = false
        for e in entries {
            switch e {
            case .separator: m.addItem(.separator())
            case .header(let t):
                // a section title, not a greyed-out item: bold and in the accent colour
                let h = NSMenuItem(title: t, action: nil, keyEquivalent: ""); h.isEnabled = false
                h.attributedTitle = NSAttributedString(string: t, attributes: [.font: NSFont.systemFont(ofSize: 12, weight: .bold), .foregroundColor: NSColor(Theme.accent)])
                m.addItem(h)
            case .item(let t, let on, let act):
                let i = Item(title: t, action: #selector(Item.fire), keyEquivalent: ""); i.target = i; i.run = act; i.isEnabled = on; m.addItem(i)
            }
        }
        m.popUp(positioning: nil, at: NSEvent.mouseLocation, in: nil)
    }
}
