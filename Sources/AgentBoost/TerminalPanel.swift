import SwiftUI
import AppKit

/// In-app terminal view over a tmux pane: polls `capture-pane -e`, renders ANSI colours,
/// and forwards keystrokes with `send-keys -H`. Korean text goes through the input line
/// below (raw key events cannot carry IME composition).
struct TerminalPanel: View {
    let pane: String
    let title: String
    var fitWindow = false          // resize the tmux window to the panel (only for terminals the app owns)
    var onClose: () -> Void
    @AppStorage("ui.termFont") private var fontSize: Double = 13
    @Environment(\.colorScheme) private var scheme
    @State private var screen = AttributedString("")
    @State private var raw = ""
    @State private var focused = false
    @State private var line = ""
    @State private var timer: Timer?
    @State private var inFlight = false
    @State private var quiet = 0              // consecutive polls with no change: poll less often
    @State private var tickN = 0
    @State private var lastSize = CGSize.zero
    @State private var attached = false       // a real terminal (Terminal.app) is attached to the tmux session: it owns the size
    @State private var fitWork: DispatchWorkItem?

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "terminal")
                Text(title).font(.callout.bold()).lineLimit(1).help("tmux 패널 ID \(pane)")
                Spacer()
                Text(focused ? "키 입력 중 — 바깥 클릭하면 해제" : "클릭하면 키 입력").font(.caption).foregroundStyle(focused ? Theme.accent : .secondary)
                Button { onClose() } label: { Image(systemName: "xmark") }.buttonStyle(.icon).help("터미널 패널 닫기")
            }
            .padding(.horizontal, 10).padding(.vertical, 6).background(.bar)
            GeometryReader { geo in
                ScrollView([.vertical, .horizontal]) {
                    Text(scheme == .light ? Self.forLight(screen) : screen).font(.system(size: fontSize, design: .monospaced)).textSelection(.enabled)
                        .fixedSize().padding(8)
                        .frame(minWidth: geo.size.width, minHeight: geo.size.height, alignment: .topLeading)   // fill the view so short screens hug the left, like a real terminal
                }
                .defaultScrollAnchor(.bottomLeading)
                .background(Theme.screen)
                .overlay(KeyCatcher(focused: $focused) { bytes in send(bytes) })
                .overlay(RoundedRectangle(cornerRadius: 2).stroke(focused ? Theme.accent : .clear, lineWidth: 1.5))
                .onAppear { lastSize = geo.size; fit(geo.size) }
                .onChange(of: geo.size) { _, s in lastSize = s; fit(s) }
            }
            HStack(spacing: 6) {
                TextField("한글 등 텍스트 입력 후 Enter (명령 줄로 전송)", text: $line).textFieldStyle(.roundedBorder)
                    .onSubmit { sendLine() }
                Button("보내기") { sendLine() }.disabled(line.isEmpty)
            }.padding(6).background(.bar)
        }
        .onAppear { start() }
        .onDisappear { timer?.invalidate(); timer = nil }
        .onChange(of: pane) { _, _ in raw = ""; quiet = 0; poll() }
    }

    private func start() {
        poll()
        timer = Timer.scheduledTimer(withTimeInterval: 0.35, repeats: true) { _ in Task { @MainActor in
            tickN += 1
            if !NSApp.isActive && tickN % 6 != 0 { return }              // in the background: every ~2 s
            if quiet > 12 && tickN % 3 != 0 { return }                   // a still screen: ~1 poll/s instead of ~3
            poll()
        } }
    }
    private func poll() {
        guard !inFlight else { return }
        inFlight = true
        let p = pane
        DispatchQueue.global(qos: .userInitiated).async {
            // one tmux call: the screen, then cursor position and attached-client count as the last line
            let out = Shell.tmux(["capture-pane", "-p", "-e", "-t", p, ";", "display-message", "-p", "-t", p, "#{cursor_x} #{cursor_y} #{session_attached}"]).out
            var lines = out.components(separatedBy: "\n")
            if lines.last == "" { lines.removeLast() }
            let curLine = lines.popLast() ?? ""
            let cap = lines.joined(separator: "\n") + "\n"
            let cur = curLine.split(separator: " ").compactMap { Int($0) }
            let key = cap + "|\(cur)"
            DispatchQueue.main.async {
                inFlight = false
                let nowAttached = cur.count == 3 && cur[2] > 0
                if attached != nowAttached {
                    attached = nowAttached
                    if !nowAttached { fit(lastSize) }                    // the terminal went away: take the size back
                }
                guard key != raw else { quiet += 1; return }
                quiet = 0
                raw = key
                screen = ANSI.render(cap, cursor: cur.count >= 2 ? (cur[0], cur[1]) : nil)
            }
        }
    }
    /// White Mode: the same recolouring as the chat screen (PaneChatView.forLight)
    static func forLight(_ a: AttributedString) -> AttributedString {
        var out = a
        for run in a.runs {
            if let f = run.foregroundColor { out[run.range].foregroundColor = Color(nsColor: PaneChatView.forLight(NSColor(f), background: false)) }
            if let b = run.backgroundColor { out[run.range].backgroundColor = Color(nsColor: PaneChatView.forLight(NSColor(b), background: true)) }
        }
        return out
    }
    private func send(_ bytes: [UInt8]) {
        guard !bytes.isEmpty else { return }
        let hex = bytes.map { String(format: "%02x", $0) }
        let p = pane
        TmuxControl.queue(p) { Shell.tmux(["send-keys", "-t", p, "-H"] + hex) }
        quiet = 0
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { poll() }
    }
    private func sendLine() {
        guard !line.isEmpty else { return }
        let p = pane, l = line
        TmuxControl.queue(p) { Shell.tmux(["send-keys", "-t", p, "-l", "--", l]); Shell.tmux(["send-keys", "-t", p, "Enter"]) }
        line = ""; quiet = 0
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { poll() }
    }
    /// Sizes the tmux window to this panel, debounced (a window drag fires many layout passes). While a real terminal is
    /// attached, that terminal owns the size and the app stays out of it.
    private func fit(_ size: CGSize) {
        guard fitWindow, !attached, size.width > 100, size.height > 60 else { return }
        let cw = fontSize * 0.602, lh = fontSize * 1.18
        let cols = max(40, Int((size.width - 16) / cw)), rows = max(10, Int((size.height - 16) / lh))
        let p = pane
        fitWork?.cancel()
        let w = DispatchWorkItem { TmuxControl.queue(p) { TmuxResize.apply(pane: p, cols: cols, rows: rows) } }
        fitWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: w)
    }
}

/// The one way the app sizes a tmux window. `resize-window` silently switches the window to `window-size manual`, which
/// then ignores any terminal that attaches later (it saw a 400-row window cropped to its height, or dots around a small
/// one). Setting `window-size latest` again right after keeps the app's size while nobody is attached and hands the size
/// to a terminal the moment one attaches (verified against tmux 3.8 with a pty client).
enum TmuxResize {
    @discardableResult
    static func apply(pane: String, cols: Int, rows: Int) -> Shell.Result {
        Shell.tmux(["resize-window", "-t", pane, "-x", String(cols), "-y", String(rows), ";",
                    "set-window-option", "-t", pane, "window-size", "latest"])
    }
}

/// Captures key presses while focused and turns them into terminal bytes.
struct KeyCatcher: NSViewRepresentable {
    @Binding var focused: Bool
    var onBytes: ([UInt8]) -> Void
    func makeNSView(context: Context) -> KeyView { let v = KeyView(); v.onBytes = onBytes; v.onFocus = { f in DispatchQueue.main.async { focused = f } }; return v }
    func updateNSView(_ v: KeyView, context: Context) { v.onBytes = onBytes }

    final class KeyView: NSView {
        var onBytes: (([UInt8]) -> Void)?
        var onFocus: ((Bool) -> Void)?
        override var acceptsFirstResponder: Bool { true }
        override func becomeFirstResponder() -> Bool { onFocus?(true); return true }
        override func resignFirstResponder() -> Bool { onFocus?(false); return true }
        override func mouseDown(with event: NSEvent) { window?.makeFirstResponder(self) }
        // let scroll and text selection reach the view underneath
        override func hitTest(_ point: NSPoint) -> NSView? {
            guard let e = NSApp.currentEvent, e.type == .leftMouseDown else { return nil }
            return super.hitTest(point)
        }
        override func performKeyEquivalent(with event: NSEvent) -> Bool {
            guard window?.firstResponder === self else { return false }
            if event.modifierFlags.contains(.command), event.charactersIgnoringModifiers == "v",
               let s = NSPasteboard.general.string(forType: .string) { onBytes?(Array(s.utf8)); return true }
            return false
        }
        override func keyDown(with e: NSEvent) {
            if e.modifierFlags.contains(.command) { super.keyDown(with: e); return }
            let map: [UInt16: String] = [36: "\r", 76: "\r", 51: "\u{7f}", 48: "\t", 53: "\u{1b}",
                123: "\u{1b}[D", 124: "\u{1b}[C", 125: "\u{1b}[B", 126: "\u{1b}[A",
                117: "\u{1b}[3~", 115: "\u{1b}[H", 119: "\u{1b}[F", 116: "\u{1b}[5~", 121: "\u{1b}[6~"]
            if e.keyCode == 48, e.modifierFlags.contains(.shift) { onBytes?(Array("\u{1b}[Z".utf8)); return }
            if let s = map[e.keyCode] { onBytes?(Array(s.utf8)); return }
            if e.modifierFlags.contains(.control), let c = e.charactersIgnoringModifiers?.lowercased().unicodeScalars.first, c.isASCII {
                let v = UInt8(c.value)
                if v >= 0x61 && v <= 0x7a { onBytes?([v & 0x1f]); return }
            }
            if let s = e.characters, !s.isEmpty { onBytes?(Array(s.utf8)) }
        }
    }
}

/// Minimal SGR (colour/bold/underline/reverse) renderer for tmux `capture-pane -e` output.
enum ANSI {
    static let base16: [Color] = [
        .init(red: 0.10, green: 0.11, blue: 0.13), .init(red: 0.89, green: 0.36, blue: 0.33), .init(red: 0.45, green: 0.79, blue: 0.47), .init(red: 0.90, green: 0.75, blue: 0.40),
        .init(red: 0.42, green: 0.62, blue: 0.95), .init(red: 0.78, green: 0.50, blue: 0.86), .init(red: 0.40, green: 0.80, blue: 0.85), .init(red: 0.85, green: 0.86, blue: 0.88),
        .init(red: 0.45, green: 0.47, blue: 0.52), .init(red: 1.00, green: 0.48, blue: 0.45), .init(red: 0.56, green: 0.90, blue: 0.58), .init(red: 1.00, green: 0.86, blue: 0.50),
        .init(red: 0.55, green: 0.73, blue: 1.00), .init(red: 0.88, green: 0.62, blue: 0.96), .init(red: 0.52, green: 0.90, blue: 0.95), .init(red: 0.97, green: 0.97, blue: 0.98)]
    static func xterm(_ n: Int) -> Color {
        if n < 16 { return base16[n] }
        if n < 232 { let i = n - 16; let f = { (v: Int) in Double(v == 0 ? 0 : 55 + v * 40) / 255 }; return Color(red: f(i / 36), green: f((i / 6) % 6), blue: f(i % 6)) }
        let g = Double(8 + (n - 232) * 10) / 255; return Color(red: g, green: g, blue: g)
    }
    struct Style { var fg: Color?; var bg: Color?; var bold = false; var dim = false; var italic = false; var under = false; var reverse = false }

    static func render(_ text: String, cursor: (Int, Int)?) -> AttributedString {
        var out = AttributedString()
        var st = Style()
        let lines = text.components(separatedBy: "\n")
        for (li, line) in lines.enumerated() {
            var col = 0
            var i = line.startIndex
            var run = ""
            func flush() {
                guard !run.isEmpty else { return }
                var a = AttributedString(run); apply(st, to: &a); out += a; run = ""
            }
            while i < line.endIndex {
                let ch = line[i]
                if ch == "\u{1b}", line.index(after: i) < line.endIndex, line[line.index(after: i)] == "[" {
                    var j = line.index(i, offsetBy: 2); var params = ""
                    while j < line.endIndex, !(line[j].isLetter) { params.append(line[j]); j = line.index(after: j) }
                    if j < line.endIndex {
                        if line[j] == "m" { flush(); sgr(params, &st) }
                        i = line.index(after: j); continue
                    }
                }
                if let c = cursor, c.1 == li, c.0 == col {
                    flush(); var cs = st; cs.reverse.toggle(); var a = AttributedString(String(ch)); apply(cs, to: &a); out += a
                } else { run.append(ch) }
                col += ch.unicodeScalars.first.map { $0.value > 0x1100 && ($0.properties.isEmojiPresentation || (0x1100...0x115F).contains($0.value) || (0x2E80...0xA4CF).contains($0.value) || (0xAC00...0xD7A3).contains($0.value) || (0xF900...0xFAFF).contains($0.value) || (0xFF00...0xFF60).contains($0.value)) ? 2 : 1 } ?? 1
                i = line.index(after: i)
            }
            flush()
            if let c = cursor, c.1 == li, c.0 >= col { var a = AttributedString(String(repeating: " ", count: c.0 - col) ); apply(st, to: &a); out += a; var cs = st; cs.reverse = true; var b = AttributedString(" "); apply(cs, to: &b); out += b }
            if li < lines.count - 1 { out += AttributedString("\n") }
        }
        return out
    }
    static func apply(_ s: Style, to a: inout AttributedString) {
        var fg = s.fg ?? Color(red: 0.86, green: 0.87, blue: 0.89), bg = s.bg
        if s.reverse { let t = fg; fg = bg ?? Color(red: 0.051, green: 0.055, blue: 0.063); bg = t }
        a.foregroundColor = s.dim ? fg.opacity(0.6) : fg
        if let bg { a.backgroundColor = bg }
        if s.under { a.underlineStyle = .single }
        if s.bold { a.inlinePresentationIntent = .stronglyEmphasized }
        if s.italic { a.inlinePresentationIntent = (a.inlinePresentationIntent ?? []).union(.emphasized) }
    }
    static func sgr(_ p: String, _ s: inout Style) {
        var codes = p.split(separator: ";", omittingEmptySubsequences: false).map { Int($0) ?? 0 }
        if codes.isEmpty { codes = [0] }
        var k = 0
        while k < codes.count {
            let c = codes[k]
            switch c {
            case 0: s = Style()
            case 1: s.bold = true
            case 2: s.dim = true
            case 3: s.italic = true
            case 4: s.under = true
            case 7: s.reverse = true
            case 22: s.bold = false; s.dim = false
            case 23: s.italic = false
            case 24: s.under = false
            case 27: s.reverse = false
            case 30...37: s.fg = base16[c - 30]
            case 90...97: s.fg = base16[c - 90 + 8]
            case 40...47: s.bg = base16[c - 40]
            case 100...107: s.bg = base16[c - 100 + 8]
            case 39: s.fg = nil
            case 49: s.bg = nil
            case 38, 48:
                var col: Color?
                if k + 2 < codes.count, codes[k + 1] == 5 { col = xterm(codes[k + 2]); k += 2 }
                else if k + 4 < codes.count, codes[k + 1] == 2 { col = Color(red: Double(codes[k + 2]) / 255, green: Double(codes[k + 3]) / 255, blue: Double(codes[k + 4]) / 255); k += 4 }
                if c == 38 { s.fg = col } else { s.bg = col }
            default: break
            }
            k += 1
        }
    }
}

/// The conversation part of a session's real CLI screen, in place of the rebuilt chat: the pane's scrollback with the
/// CLI's own input box and footer cut off (the board's input box below replaces them). Nothing is parsed or rebuilt; the
/// pane is read only while this view is on screen.
struct PaneChatView: View {
    let pane: String
    var sid = ""
    @AppStorage("ui.termFont") private var fontSize: Double = 13
    @Environment(\.colorScheme) private var scheme
    /// The appearance for the 1 s poll. The timer's closure holds a copy of this view made at onAppear, and an
    /// @Environment read through that copy kept the old scheme: in White Mode, new output came back drawn for dark (pale
    /// text on white). @State storage is shared, so the poll reads the current value.
    @State private var light = false
    @State private var text = NSAttributedString()
    @State private var raw = ""
    @State private var timer: Timer?
    @State private var inFlight = false
    @State private var fitWork: DispatchWorkItem?
    @State private var cols = 120
    @State private var rows = 40
    @State private var attached = false        // Terminal.app is attached to this tmux session: it owns the window size
    @State private var panes = 1               // teammates open as side-by-side panes in the lead's window
    /// Columns each on-screen pane wants. Panes of one tmux window (a lead and its teammates, shown side by side in the
    /// split view) share the window: each view used to size the window for itself alone, and the last one to resize won.
    nonisolated(unsafe) private static var wanted: [String: Int] = [:]
    private static let wantedLock = NSLock()
    private static func want(_ p: String, _ c: Int?) { wantedLock.lock(); wanted[p] = c; wantedLock.unlock() }
    private static func wanted(_ p: String) -> Int? { wantedLock.lock(); defer { wantedLock.unlock() }; return wanted[p] }
    var body: some View {
        // an AppKit text view: replacing its text is cheap, where a SwiftUI Text re-laid out hundreds of lines on every poll
        // the CLI draws full-screen (tmux keeps no scrollback): the window is tall, so the CLI itself draws as much of
        // its conversation as it holds; the view only scrolls that, it never pages the CLI
        PaneText(text: text)
            .background(scheme == .light ? Theme.screenLight : Theme.screen)
            // the CLI wraps at the tmux width (220 columns at launch): make that the visible width, or every long line
            // wrapped twice and jutted out
            .onGeometryChange(for: [Int].self) { g in
                let f = NSFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)
                let cw = ("M" as NSString).size(withAttributes: [.font: f]).width
                let lh = NSLayoutManager().defaultLineHeight(for: f)
                return [max(50, Int((g.size.width - 28 - 24) / max(cw, 1)) - 2), max(15, Int((g.size.height - 20) / max(lh, 1)))]
            } action: { size in
                cols = size[0]; rows = size[1]
                fit()
            }
            .onAppear { poll(); timer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { _ in Task { @MainActor in poll() } } }
            .onDisappear { timer?.invalidate(); timer = nil; Self.want(pane, nil) }
            .onChange(of: pane) { old, _ in Self.want(old, nil); raw = ""; attached = false; poll() }
            .onAppear { light = scheme == .light }
            .onChange(of: scheme) { _, s in light = s == .light; raw = ""; poll(force: true) }   // recolour the screen for the new appearance
    }
    static let tallRows = 400
    /// Width of this view, height fixed and tall: the CLI fills it with its conversation (changing the height made the
    /// CLI clear its screen). Debounced; never while a terminal is attached (the terminal's size stands until it leaves).
    private func fit() {
        fitWork?.cancel()
        guard !attached else { return }
        let p = pane, c = cols, n = panes
        Self.want(p, c)
        let w = DispatchWorkItem { DispatchQueue.global(qos: .utility).async {
            if n <= 1 { TmuxResize.apply(pane: p, cols: c, rows: Self.tallRows); return }
            // several panes (teammates split the lead's window). Panes stacked in one column share its width, so count
            // columns, not panes: a column is as wide as the widest pane in it that a view shows (40 if none), the window
            // is the columns plus one separator each, and every column but the last is set by resizing one of its panes.
            // (Counting stacked teammates as side by side made the window too wide, and the lead's pane took the extra:
            // the CLI wrapped wider than the view and long lines ran off its right edge.)
            let rows = Shell.tmux(["list-panes", "-t", p, "-F", "#{pane_left} #{pane_id}"]).out.split(separator: "\n")
                .compactMap { r -> (Int, String)? in let f = r.split(separator: " "); return f.count == 2 ? Int(f[0]).map { ($0, String(f[1])) } : nil }
            let columns = Dictionary(grouping: rows, by: { $0.0 }).sorted { $0.key < $1.key }.map { $0.value.map(\.1) }
            let widths = columns.map { col in col.compactMap { Self.wanted($0) }.max() ?? 40 }
            TmuxResize.apply(pane: p, cols: widths.reduce(0, +) + max(0, columns.count - 1), rows: Self.tallRows)
            for (col, wd) in zip(columns, widths).dropLast() { Shell.tmux(["resize-pane", "-t", col[0], "-x", String(wd)]) }
        } }
        fitWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: w)
    }
    private func poll(force: Bool = false) {
        guard !inFlight else { return }
        inFlight = true
        let p = pane, size = fontSize, last = force ? "" : raw, lt = light
        DispatchQueue.global(qos: .userInitiated).async {
            // one tmux call: the screen, then "<attached clients> <panes in the window>" as the last line
            let out = Shell.tmux(["capture-pane", "-p", "-e", "-t", p, ";", "display-message", "-p", "-t", p, "#{session_attached} #{window_panes}"]).out
            var lines = out.components(separatedBy: "\n")
            if lines.last == "" { lines.removeLast() }
            let status = (lines.popLast() ?? "").split(separator: " ").compactMap { Int($0) }
            let nowAttached = (status.first ?? 0) > 0, nowPanes = status.count > 1 ? max(1, status[1]) : 1
            let cut = Self.conversation(lines.joined(separator: "\n") + "\n")
            let ns = cut == last ? nil : Self.appKit(ANSI.render(cut, cursor: nil), size: size, light: lt)
            DispatchQueue.main.async {
                inFlight = false
                if attached != nowAttached {
                    attached = nowAttached
                    if !nowAttached { fit() }                            // the terminal closed: back to the tall window
                }
                if panes != nowPanes { panes = nowPanes; fit() }        // a teammate pane came or went: re-share the width
                if let ns { raw = lt == light ? cut : ""; text = ns }   // built for another appearance: redraw next tick
            }
        }
    }
    /// SwiftUI colour runs → AppKit attributes (built off the main thread).
    /// White Mode: the CLI draws for a dark terminal. Greys swap lightness (its text, rules and highlighted rows), and
    /// light hues are darkened until they read on white; saturated mid colours stay as they are.
    static func forLight(_ c: NSColor, background: Bool) -> NSColor {
        guard let s = c.usingColorSpace(.sRGB) else { return c }
        let r = s.redComponent, g = s.greenComponent, b = s.blueComponent, a = s.alphaComponent
        if max(r, g, b) - min(r, g, b) < 0.08 {
            let l = (r + g + b) / 3, n = background ? 1 - l * 0.4 : 1 - l
            return NSColor(srgbRed: n, green: n, blue: n, alpha: a)
        }
        let lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
        if background { return NSColor(srgbRed: r, green: g, blue: b, alpha: a * 0.25) }
        guard lum > 0.45 else { return c }
        let k = 0.45 / lum
        return NSColor(srgbRed: r * k, green: g * k, blue: b * k, alpha: a)
    }
    static func appKit(_ a: AttributedString, size: Double, light: Bool = false) -> NSAttributedString {
        let out = NSMutableAttributedString()
        let font = NSFont.monospacedSystemFont(ofSize: size, weight: .regular), bold = NSFont.monospacedSystemFont(ofSize: size, weight: .bold)
        for run in a.runs {
            var at: [NSAttributedString.Key: Any] = [.font: (run.inlinePresentationIntent?.contains(.stronglyEmphasized) ?? false) ? bold : font,
                                                     .foregroundColor: { let c = run.foregroundColor.map { NSColor($0) } ?? NSColor.white; return light ? forLight(c, background: false) : c }()]
            if let bg = run.backgroundColor { at[.backgroundColor] = light ? forLight(NSColor(bg), background: true) : NSColor(bg) }
            if run.underlineStyle != nil { at[.underlineStyle] = NSUnderlineStyle.single.rawValue }
            out.append(NSAttributedString(string: String(a[run.range].characters), attributes: at))
        }
        // terminal columns: a wide character (Hangul, CJK, full-width) takes exactly two cells. Fallback fonts draw Hangul
        // a little narrower or wider than two Latin cells, so every "│" after Korean text drifted: kern each to its cells.
        let cell = ("M" as NSString).size(withAttributes: [.font: font]).width
        // table lines only (box-drawing characters): Korean there takes exactly two columns so the borders line up;
        // elsewhere the text keeps its natural width
        let ns = out.string as NSString
        var tableLines: [NSRange] = []
        ns.enumerateSubstrings(in: NSRange(location: 0, length: ns.length), options: [.byLines, .substringNotRequired]) { _, r, _, _ in
            if ns.substring(with: r).unicodeScalars.contains(where: { (0x2500...0x257F).contains($0.value) }) { tableLines.append(r) }
        }
        for line in tableLines {
        var i = line.location
        while i < line.location + line.length {
            let r = ns.rangeOfComposedCharacterSequence(at: i)
            let ch = ns.substring(with: r)
            if let u = ch.unicodeScalars.first, u.value >= 0x1100, isWide(u.value) {
                out.addAttribute(.kern, value: cell * 2 - width(ch, size: size), range: r)
            }
            i = r.location + r.length
        }
        }
        for (r, u) in PathLinks.find(out.string) { out.addAttribute(.link, value: u, range: r) }   // click: open the folder
        // one fixed line height (the enlarged Hangul must not make its lines taller): rows match the view's row count
        let lh = NSLayoutManager().defaultLineHeight(for: font)
        let ps = NSMutableParagraphStyle(); ps.minimumLineHeight = lh; ps.maximumLineHeight = lh
        out.addAttribute(.paragraphStyle, value: ps, range: NSRange(location: 0, length: out.length))
        // lines that end inside a background (my messages): one text block per run of such lines, so the colour is a
        // single band across the full width with no gaps between rows, instead of a ragged box behind each line's letters
        var paras: [(r: NSRange, bg: NSColor?, blank: Bool)] = []
        ns.enumerateSubstrings(in: NSRange(location: 0, length: ns.length), options: [.byParagraphs, .substringNotRequired]) { _, r, enclosing, _ in
            let bg = r.length > 0 ? out.attribute(.backgroundColor, at: r.location + r.length - 1, effectiveRange: nil) as? NSColor : nil
            paras.append((enclosing, bg, ns.substring(with: r).trimmingCharacters(in: .whitespaces).isEmpty))
        }
        // blank lines inside one message (between two lines of the same background) join the band
        for i in paras.indices where paras[i].bg == nil && paras[i].blank {
            guard let a = paras[..<i].last(where: { !$0.blank }), let b = paras[(i + 1)...].first(where: { !$0.blank }),
                  let ca = a.bg, ca == b.bg else { continue }
            paras[i].bg = ca
        }
        var block: NSTextBlock?, blockColor: NSColor?
        for p in paras {
            guard let bg = p.bg else { block = nil; blockColor = nil; continue }
            if block == nil || blockColor != bg {
                let b = NSTextBlock(); b.backgroundColor = bg; b.setContentWidth(100, type: .percentageValueType)
                block = b; blockColor = bg
            }
            let st = ps.mutableCopy() as! NSMutableParagraphStyle; st.textBlocks = [block!]
            out.addAttribute(.paragraphStyle, value: st, range: p.r)
            out.removeAttribute(.backgroundColor, range: p.r)
        }
        return out
    }
    private static func wideFont(_ size: Double) -> NSFont {
        NSFont(name: "AppleSDGothicNeo-Regular", size: CGFloat(size) * 1.12) ?? NSFont.systemFont(ofSize: CGFloat(size) * 1.12)
    }
    nonisolated(unsafe) private static var widths: [String: CGFloat] = [:]
    private static let widthLock = NSLock()
    private static func width(_ ch: String, size: Double) -> CGFloat {
        let key = ch + "|\(size)"
        widthLock.lock(); defer { widthLock.unlock() }
        if let w = widths[key] { return w }
        let w = (ch as NSString).size(withAttributes: [.font: NSFont.monospacedSystemFont(ofSize: size, weight: .regular)]).width
        widths[key] = w; return w
    }
    /// East Asian wide ranges (enough for Korean, CJK, full-width forms).
    static func isWide(_ v: UInt32) -> Bool {
        (0x1100...0x115F).contains(v) || (0x2E80...0x303E).contains(v) || (0x3041...0x33FF).contains(v) || (0x3400...0x4DBF).contains(v)
            || (0x4E00...0x9FFF).contains(v) || (0xA960...0xA97F).contains(v) || (0xAC00...0xD7A3).contains(v) || (0xD7B0...0xD7FF).contains(v)
            || (0xF900...0xFAFF).contains(v) || (0xFE30...0xFE4F).contains(v) || (0xFF00...0xFF60).contains(v) || (0xFFE0...0xFFE6).contains(v)
            || (0x1F300...0x1FAFF).contains(v) || (0x20000...0x3FFFD).contains(v) || (0x3130...0x318F).contains(v)
    }
    /// Everything above the CLI's input box: the box's top border is the last rule line before the "❯" prompt.
    static func conversation(_ s: String) -> String {
        // OSC sequences (hyperlinks "ESC ] 8 ; … ESC \\") are not drawn by the colour renderer: drop them; "⏺" falls back to an emoji box
        let s = s.replacingOccurrences(of: "\u{1B}\\][^\u{07}\u{1B}]*(\u{07}|\u{1B}\\\\)", with: "", options: .regularExpression)
            .replacingOccurrences(of: "⏺", with: "●")
        var lines = s.components(separatedBy: "\n")
        while let l = lines.last, plain(l).trimmingCharacters(in: .whitespaces).isEmpty { lines.removeLast() }
        if let prompt = lines.lastIndex(where: { plain($0).hasPrefix("❯") }),
           let border = lines[..<prompt].lastIndex(where: { plain($0).trimmingCharacters(in: .whitespaces).hasPrefix("──") }) {
            lines.removeSubrange(border...)
        }
        // then the CLI's status lines just above the box (the board shows its own): the spinner line ("✻ Working… (12s …)"),
        // update notices, blanks
        let glyphs: Set<Character> = ["·", "✢", "✳", "✶", "✻", "✽", "*", "✔", "✘", "✗"]
        while let l = lines.last {
            let t = plain(l).trimmingCharacters(in: .whitespaces)
            if t.isEmpty || (t.hasPrefix("⎿") && t.contains("Tip:")) || t.contains("Auto-update") || t.contains("Update installed") || t.contains("esc to interrupt")
                || (t.first.map(glyphs.contains) == true && t.contains("…")) { lines.removeLast() } else { break }
        }
        return lines.joined(separator: "\n")
    }
    /// A line that ends inside a background colour (my messages): fill it to the full width with that colour, so the
    /// highlight is a band across the view, not a box behind the letters.
    static func padBackgrounds(_ s: String, cols: Int) -> String {
        s.components(separatedBy: "\n").map { line -> String in
            guard let last = line.range(of: "\u{1B}\\[[0-9;]*m", options: [.regularExpression, .backwards]) else { return line }
            let code = String(line[last])
            // still inside a background: a bg code (48;… / 40–47 / 100–107) not reset before the end
            let bgOpen = line.range(of: "\u{1B}\\[[0-9;]*(48;|4[0-7]m|10[0-7]m)[0-9;]*m?", options: [.regularExpression, .backwards])
            guard let b = bgOpen, b.lowerBound >= (line.range(of: "\u{1B}\\[(0|49)?m", options: [.regularExpression, .backwards])?.upperBound ?? line.startIndex) else { return line }
            _ = code
            let w = width(of: plain(line))
            return w < cols ? line + String(repeating: " ", count: cols - w) : line
        }.joined(separator: "\n")
    }
    /// Terminal columns of plain text (wide characters count 2).
    static func width(of s: String) -> Int {
        s.unicodeScalars.reduce(0) { $0 + (($1.value >= 0x1100 && isWide($1.value)) ? 2 : 1) }
    }
    static func plain(_ s: String) -> String { s.replacingOccurrences(of: "\u{1B}\\[[0-9;]*m", with: "", options: .regularExpression) }
}

/// Read-only text view for PaneChatView: it shows exactly the CLI's screen (the tmux window is sized to it), and the
/// wheel / trackpad pages the CLI itself.
struct PaneText: NSViewRepresentable {
    var text: NSAttributedString
    var onWheel: (Bool) -> Void = { _ in }
    /// The read-only text view: holds a new screen back while the user is selecting (files are dropped on the input box only).
    final class DropTV: NSTextView {
        /// A screen that arrived while the user was selecting text: replacing the text would drop the selection, so it
        /// waits here until the selection is let go (cleared, or focus moves elsewhere such as the composer).
        var pending: NSAttributedString?
        var misses = 0          // screens in a row that lost the line being read (see apply)
        var holding: Bool { window?.firstResponder === self && selectedRange().length > 0 }
        override func clicked(onLink link: Any, at charIndex: Int) {
            if let u = link as? URL, u.isFileURL { PathLinks.open(u) } else { super.clicked(onLink: link, at: charIndex) }
        }
        func flushPending() {
            guard let p = pending, !holding, let sv = enclosingScrollView else { return }
            if let w = sv as? WheelScroll, !w.stick, w.paged == 0 { return }       // still reading further up
            pending = nil
            PaneText.apply(p, to: self, in: sv)
        }
        override func resignFirstResponder() -> Bool {
            let ok = super.resignFirstResponder()
            if ok { DispatchQueue.main.async { [weak self] in self?.flushPending() } }
            return ok
        }
        override func setSelectedRanges(_ ranges: [NSValue], affinity: NSSelectionAffinity, stillSelecting: Bool) {
            super.setSelectedRanges(ranges, affinity: affinity, stillSelecting: stillSelecting)
            if !stillSelecting, pending != nil, selectedRange().length == 0 { DispatchQueue.main.async { [weak self] in self?.flushPending() } }
        }
    }
    final class WheelScroll: NSScrollView {
        var onWheel: (Bool) -> Void = { _ in }

        private var acc: CGFloat = 0
        private var last = Date.distantPast
        override func scrollWheel(with e: NSEvent) {
            // normal scrolling inside the screen; only a push past the top (older) or the bottom (back) pages the CLI
            super.scrollWheel(with: e)
            guard let doc = documentView else { return }
            let b = contentView.bounds
            let atTop = b.minY <= 1, atBottom = b.maxY >= doc.frame.height - 1
            noteUserScroll()
            let dy = e.scrollingDeltaY * (e.hasPreciseScrollingDeltas ? 1 : 12)
            if (dy > 0 && atTop) || (dy < 0 && atBottom && paged > 0) { acc += dy } else { acc = 0 }
            if abs(acc) >= 160, Date().timeIntervalSince(last) > 0.4 {
                let up = acc > 0
                if up { paged += 1 } else { paged -= 1 }
                onWheel(up); acc = 0; last = Date()
            }
        }
        var paged = 0                              // pages the CLI is scrolled back
        /// Follow new output (and open at the latest line) until the user scrolls up; back at the bottom, follow again.
        var stick = true
        func noteUserScroll() {
            guard let doc = documentView else { return }
            let was = stick
            stick = contentView.bounds.maxY >= doc.frame.height - 40
            // back at the bottom: show the screens held while reading further up
            if stick, !was { (doc as? DropTV)?.flushPending() }
        }
        override func layout() {
            super.layout()
            // a tab shown for the first time, or a resize: keep the latest line in view
            if stick { documentView?.scrollToEndOfDocument(nil) }
        }
    }
    /// Scroller drags count as the user's scroll too (mouseDown runs the whole drag before returning).
    final class UserScroller: NSScroller {
        override func mouseDown(with e: NSEvent) {
            super.mouseDown(with: e)
            (superview as? WheelScroll)?.noteUserScroll()
        }
    }
    func makeNSView(context: Context) -> NSScrollView {
        let sv = WheelScroll()
        sv.drawsBackground = false; sv.verticalScroller = UserScroller(); sv.hasVerticalScroller = true; sv.autohidesScrollers = true; sv.hasHorizontalScroller = false
        let tv = DropTV()
        tv.isEditable = false; tv.isSelectable = true; tv.drawsBackground = false
        tv.linkTextAttributes = [.underlineStyle: NSUnderlineStyle.single.rawValue, .cursor: NSCursor.pointingHand]   // keep the screen's colours
        tv.textContainerInset = NSSize(width: 14, height: 10)
        // no wrapping here: tmux has already wrapped at its width (set to this view's)
        tv.isHorizontallyResizable = false; tv.isVerticallyResizable = true; tv.autoresizingMask = [.width]
        tv.textContainer?.widthTracksTextView = false
        tv.textContainer?.containerSize = NSSize(width: 100_000, height: CGFloat.greatestFiniteMagnitude)
        tv.unregisterDraggedTypes()      // no drop target here: files go to the input box below
        sv.documentView = tv
        return sv
    }
    func updateNSView(_ sv: NSScrollView, context: Context) {
        (sv as? WheelScroll)?.onWheel = onWheel
        guard let tv = sv.documentView as? DropTV, let ts = tv.textStorage else { return }
        guard !ts.isEqual(to: text) else { tv.pending = nil; return }
        // the user is selecting in here: keep their selection, show the new screen once they let go
        if tv.holding { tv.pending = text; return }
        // reading further up (not paged back in the CLI): hold new screens until they scroll back to the bottom. The CLI
        // redraws its whole screen while it answers, older lines included (tool summaries fold, half-drawn rows), so
        // replacing the text under the reader every second made the part being read flicker.
        if let w = sv as? WheelScroll, !w.stick, w.paged == 0, ts.length > 0 { tv.pending = text; return }
        tv.pending = nil
        Self.apply(text, to: tv, in: sv)
    }
    static func apply(_ text: NSAttributedString, to tv: NSTextView, in sv: NSScrollView) {
        guard let ts = tv.textStorage else { return }
        let b = sv.contentView.bounds
        let follow = (sv as? WheelScroll)?.stick ?? (b.maxY >= tv.frame.height - 40) || ts.length == 0      // at the bottom: follow new output
        // reading further up: the CLI draws on a fixed-height screen, so new output moves every earlier line up. Keeping
        // the pixel offset would slide newer text under the reader; keep the line they were reading in place instead.
        let anchor = follow ? nil : readingAnchor(tv, top: b.minY)
        // the CLI redraws its whole screen on new output; a capture taken mid-redraw lacks the line being read, and
        // showing it made the view flash to another place and back a second later. Keep the current screen for up to
        // three such captures (the next complete one has the line again); after that, take the new screen anyway.
        if let a = anchor, let dv = tv as? DropTV {
            let ns = text.string as NSString
            if ns.range(of: a.snippet).location == NSNotFound, dv.misses < 3 { dv.misses += 1; return }
            dv.misses = 0
        }
        ts.setAttributedString(text)
        if follow { tv.scrollToEndOfDocument(nil); return }
        var y = b.minY
        if let a = anchor, let at = locate(a, in: tv), let ly = lineY(tv, at) { y = max(0, ly - a.dy) }
        sv.contentView.scroll(to: NSPoint(x: 0, y: y)); sv.reflectScrolledClipView(sv.contentView)
    }
    /// The first non-blank line at the top of the view, the two lines after it (to tell repeated lines apart), and how
    /// far below the view's top edge it sits.
    private struct Anchor { var snippet: String; var location: Int; var dy: CGFloat }
    private static func readingAnchor(_ tv: NSTextView, top: CGFloat) -> Anchor? {
        guard let lm = tv.layoutManager, let tc = tv.textContainer, let ts = tv.textStorage, ts.length > 0 else { return nil }
        let ns = ts.string as NSString
        let gi = lm.glyphIndex(for: NSPoint(x: 0, y: max(0, top - tv.textContainerOrigin.y)), in: tc)
        var line = ns.lineRange(for: NSRange(location: min(lm.characterIndexForGlyph(at: gi), ns.length - 1), length: 0))
        for _ in 0..<40 where ns.substring(with: line).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let next = NSMaxRange(line)
            guard next < ns.length else { return nil }
            line = ns.lineRange(for: NSRange(location: next, length: 0))
        }
        var end = NSMaxRange(line)
        for _ in 0..<2 where end < ns.length { end = NSMaxRange(ns.lineRange(for: NSRange(location: end, length: 0))) }
        guard let ly = lineY(tv, line.location) else { return nil }
        return Anchor(snippet: ns.substring(with: NSRange(location: line.location, length: end - line.location)), location: line.location, dy: ly - top)
    }
    /// Where the anchor's text is now: the nearest copy at or before its old place (output only moves text up), else anywhere.
    private static func locate(_ a: Anchor, in tv: NSTextView) -> Int? {
        let ns = tv.string as NSString
        let upto = min(ns.length, a.location + (a.snippet as NSString).length)
        var r = ns.range(of: a.snippet, options: .backwards, range: NSRange(location: 0, length: upto))
        if r.location == NSNotFound { r = ns.range(of: a.snippet) }
        return r.location == NSNotFound ? nil : r.location
    }
    /// Top of the line holding character `i`, in the text view's coordinates.
    private static func lineY(_ tv: NSTextView, _ i: Int) -> CGFloat? {
        guard let lm = tv.layoutManager, i <= (tv.string as NSString).length else { return nil }
        lm.ensureLayout(forCharacterRange: NSRange(location: 0, length: min(i + 1, (tv.string as NSString).length)))
        let g = lm.glyphIndexForCharacter(at: i)
        return lm.lineFragmentRect(forGlyphAt: g, effectiveRange: nil).minY + tv.textContainerOrigin.y
    }

}
