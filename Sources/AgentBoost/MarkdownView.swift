import SwiftUI

/// Small block-level Markdown renderer: headings, fenced code, tables, lists,
/// quotes, paragraphs. Inline styling (bold/italic/code/links) via AttributedString.
enum MDBlock: Identifiable, Equatable {
    case heading(Int, String), paragraph(String), code(String, String?), table([String], [[String]]),
         list([String], ordered: Bool), quote(String), rule
    var id: String { "\(self)".hashValue.description + "\(self)".prefix(40) }
}

enum MarkdownParser {
    static func parse(_ text: String) -> [MDBlock] {
        var blocks: [MDBlock] = []
        let lines = text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var i = 0, para: [String] = []
        func flush() { if !para.isEmpty { blocks.append(.paragraph(para.joined(separator: "\n"))); para = [] } }
        while i < lines.count {
            let line = lines[i], t = line.trimmingCharacters(in: .whitespaces)
            if t.hasPrefix("```") {
                flush(); let lang = String(t.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                var code: [String] = []; i += 1
                while i < lines.count, !lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("```") { code.append(lines[i]); i += 1 }
                blocks.append(.code(code.joined(separator: "\n"), lang.isEmpty ? nil : lang)); i += 1; continue
            }
            if t.hasPrefix("|"), i + 1 < lines.count, isSeparatorRow(lines[i + 1]) {
                flush(); let header = cells(t); i += 2; var rows: [[String]] = []
                while i < lines.count, lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("|") { rows.append(cells(lines[i])); i += 1 }
                blocks.append(.table(header, rows)); continue
            }
            if let m = t.range(of: #"^#{1,6} "#, options: .regularExpression) {
                flush(); let level = t[m].filter { $0 == "#" }.count
                blocks.append(.heading(level, String(t[m.upperBound...]))); i += 1; continue
            }
            if t == "---" || t == "***" { flush(); blocks.append(.rule); i += 1; continue }
            if t.hasPrefix("> ") || t == ">" {
                flush(); var q: [String] = []
                while i < lines.count, lines[i].trimmingCharacters(in: .whitespaces).hasPrefix(">") {
                    q.append(String(lines[i].trimmingCharacters(in: .whitespaces).dropFirst()).trimmingCharacters(in: .whitespaces)); i += 1 }
                blocks.append(.quote(q.joined(separator: "\n"))); continue
            }
            if isListItem(t) {
                flush(); var items: [String] = []; let ordered = t.first?.isNumber == true
                while i < lines.count, isListItem(lines[i].trimmingCharacters(in: .whitespaces)) {
                    var s = lines[i].trimmingCharacters(in: .whitespaces)
                    if let r = s.range(of: #"^(\d+[.)]|[-*+])\s+"#, options: .regularExpression) { s = String(s[r.upperBound...]) }
                    items.append(s); i += 1
                    // continuation lines (indented) join the item
                    while i < lines.count, lines[i].hasPrefix("  "), !isListItem(lines[i].trimmingCharacters(in: .whitespaces)), !lines[i].trimmingCharacters(in: .whitespaces).isEmpty {
                        items[items.count - 1] += " " + lines[i].trimmingCharacters(in: .whitespaces); i += 1 }
                }
                blocks.append(.list(items, ordered: ordered)); continue
            }
            if t.isEmpty { flush() } else { para.append(line) }
            i += 1
        }
        flush()
        return blocks
    }
    static func isListItem(_ t: String) -> Bool { t.range(of: #"^(\d+[.)]|[-*+])\s+"#, options: .regularExpression) != nil }
    static func isSeparatorRow(_ s: String) -> Bool {
        let t = s.trimmingCharacters(in: .whitespaces)
        return t.hasPrefix("|") && t.range(of: #"^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$"#, options: .regularExpression) != nil
    }
    static func cells(_ s: String) -> [String] {
        var t = s.trimmingCharacters(in: .whitespaces)
        if t.hasPrefix("|") { t.removeFirst() }
        if t.hasSuffix("|") { t.removeLast() }
        return t.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
    }
    static func inline(_ s: String) -> AttributedString {
        PathLinks.link((try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s))
    }
}

struct MarkdownView: View {
    var text: String
    var font: Font = .body
    var mono = false                         // terminal-style chat: the same blocks in the monospaced face
    private final class Box { let v: [MDBlock]; init(_ v: [MDBlock]) { self.v = v } }
    private static let cache = NSCache<NSString, Box>()
    /// Parsed once per text (rows are rebuilt on every chat update).
    static func blocks(_ text: String) -> [MDBlock] {
        if let b = cache.object(forKey: text as NSString) { return b.v }
        let v = MarkdownParser.parse(text); cache.setObject(Box(v), forKey: text as NSString); return v
    }
    var body: some View {
        let blocks = Self.blocks(text)
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, b in render(b) }
        }
    }
    @ViewBuilder private func render(_ b: MDBlock) -> some View {
        switch b {
        case .heading(let l, let s):
            Text(MarkdownParser.inline(s)).font(.system(size: l == 1 ? 18 : l == 2 ? 16 : 15, weight: .semibold, design: mono ? .monospaced : .default))
                .foregroundStyle(Color.primary.opacity(0.95)).padding(.top, l <= 2 ? 4 : 0)
        case .paragraph(let s):
            Text(MarkdownParser.inline(s)).font(font).lineSpacing(5).foregroundStyle(Color.primary.opacity(0.92)).textSelection(.enabled)
        case .code(let s, let lang):
            VStack(alignment: .leading, spacing: 2) {
                if let lang { Text(lang).font(.caption2.weight(.medium)).foregroundStyle(.secondary).padding(.horizontal, 10).padding(.top, 6) }
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(s).font(.system(size: 12.5, design: .monospaced)).lineSpacing(3).textSelection(.enabled).padding(12)
                }
            }.frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.dyn(0x101113, 0xF3F3F3)).clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 4, style: .continuous).stroke(Theme.line))
            .modifier(CopyOnHover(text: s))
        case .table(let header, let rows):
            Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
                GridRow { ForEach(Array(header.enumerated()), id: \.offset) { _, h in cell(h, bold: true) } }
                    .background(Theme.ink.opacity(0.08))
                Divider()
                ForEach(Array(rows.enumerated()), id: \.offset) { ri, r in
                    GridRow { ForEach(Array(header.indices), id: \.self) { ci in cell(ci < r.count ? r[ci] : "", bold: false) } }
                        .background(ri % 2 == 0 ? Color.clear : Color.primary.opacity(0.06))
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(Theme.lineHi))
        case .list(let items, let ordered):
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(items.enumerated()), id: \.offset) { i, it in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(ordered ? "\(i + 1)." : "•").font(font).foregroundStyle(.secondary).frame(minWidth: 16, alignment: .trailing)
                        Text(MarkdownParser.inline(it)).font(font).lineSpacing(5).foregroundStyle(Color.primary.opacity(0.92)).textSelection(.enabled)
                    }
                }
            }
        case .quote(let s):
            HStack(spacing: 8) {
                RoundedRectangle(cornerRadius: 1.5).fill(Theme.accent.opacity(0.6)).frame(width: 3)
                Text(MarkdownParser.inline(s)).font(font).lineSpacing(mono ? 3 : 0).foregroundStyle(Color.primary.opacity(0.8)).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.vertical, 6).padding(.trailing, 6).background(Theme.ink.opacity(0.035))
            .modifier(CopyOnHover(text: s))
        case .rule: Divider()
        }
    }
    private func cell(_ s: String, bold: Bool) -> some View {
        Text(MarkdownParser.inline(s)).font(mono ? (bold ? font.bold() : font) : (bold ? .callout.bold() : .callout)).textSelection(.enabled)
            .padding(.horizontal, 8).padding(.vertical, 4).frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A copy button in the top-right corner, shown while the pointer is over the block (nothing drawn otherwise).
struct CopyOnHover: ViewModifier {
    var text: String
    @State private var hover = false
    @State private var copied = false
    func body(content: Content) -> some View {
        content
            .overlay(alignment: .topTrailing) {
                if hover || copied {
                    Button {
                        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string)
                        copied = true; DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { copied = false }
                    } label: {
                        Label(copied ? "복사됨" : "복사", systemImage: copied ? "checkmark" : "doc.on.doc").font(.caption)
                            .padding(.horizontal, 7).padding(.vertical, 3)
                            .background(RoundedRectangle(cornerRadius: 5).fill(Theme.panel))
                            .overlay(RoundedRectangle(cornerRadius: 5).stroke(Theme.lineHi))
                    }.buttonStyle(.plain).padding(4).help("이 칸의 내용을 복사합니다")
                }
            }
            .onHover { hover = $0 }
    }
}

/// Composer: grows from 1 to 5 lines. Enter sends, Shift+Enter makes a new line.
/// Lists continue themselves: after "1. text", Shift+Enter starts "2. "; Shift+Enter on an
/// empty "2. " removes it and ends the list. Same for "- " / "* " bullets.
struct Composer: View {
    @Binding var text: String
    var placeholder: String
    var enabled: Bool
    var onSend: () -> Void
    var onPasteImage: (() -> Bool)? = nil   // ⌘V with an image on the clipboard → attachment
    var keyHook: ((NSEvent) -> Bool)? = nil // slash palette: ↑↓ Tab Esc Enter; return true to consume
    var ghost: String? = nil                // dimmed completion drawn after the text (Tab fills it); the whole suggested text
    var onDropFiles: (([URL]) -> Void)? = nil   // files / images dropped on the text: attachments, not a pasted path
    var onDragOver: ((Bool) -> Void)? = nil     // a file drag entered / left the text (the drop hint; SwiftUI's isTargeted never sees it)
    @State private var focused = false
    @State private var height: CGFloat = 42
    @AppStorage("ui.chatFont") private var chatFont: Double = 15
    var body: some View {
        let rest = ghostRemainder
        // An AppKit text view in its own scroll view (ComposerField): it follows the caret and the trackpad by itself, its
        // scroll bar sits outside the text, and SwiftUI only receives the height. The SwiftUI TextField re-measured the whole
        // text on every key (typing slowed as the text grew) and could not keep the caret in view past five lines.
        ComposerField(text: $text, focused: $focused, height: $height, fontSize: chatFont, enabled: enabled,
                      onSend: onSend, onPasteImage: onPasteImage, keyHook: keyHook, onDropFiles: onDropFiles, onDragOver: onDragOver)
            .frame(height: height)
            .overlay(alignment: .topLeading) {
                if !text.contains("\n") {     // the grey suggestion / placeholder: one-line text only (it does not scroll with the view)
                    GhostText(typed: rest == nil ? "" : text, rest: rest ?? (text.isEmpty ? placeholder : ""), fontSize: chatFont)
                }
            }
            .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Theme.panel))
            .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).stroke(focused ? Theme.lineHi : Theme.line, lineWidth: 1))
            .opacity(enabled ? 1 : 0.6)
    }

    /// The grey layer over the field: an invisible copy of the typed text, then the rest in grey, with the field's font and
    /// padding so it wraps the same way. Equatable: it is redrawn only when its strings change.
    private struct GhostText: View, Equatable {
        var typed: String, rest: String, fontSize: Double
        var body: some View {
            (Text(typed).foregroundColor(.clear) + Text(rest).foregroundColor(Color.primary.opacity(0.32)))
                .font(.system(size: fontSize)).lineLimit(5)
                .padding(.horizontal, 14).padding(.vertical, 10).frame(maxWidth: .infinity, alignment: .topLeading)
                .allowsHitTesting(false)
        }
    }

    /// What is left of the suggestion after the typed text (nil: nothing to show).
    private var ghostRemainder: String? {
        guard let g = ghost, enabled, !g.isEmpty else { return nil }
        if text.isEmpty { return g }
        guard g.count > text.count, g.lowercased().hasPrefix(text.lowercased()) else { return nil }
        return String(g.dropFirst(text.count))
    }

    static func newline(after text: String) -> String {
        var lines = text.components(separatedBy: "\n")
        let last = lines.last ?? ""
        if let m = last.range(of: #"^(\s*)(\d+)([.)])\s"#, options: .regularExpression) {
            let marker = String(last[m])
            if last[m.upperBound...].trimmingCharacters(in: .whitespaces).isEmpty {      // empty item: end the list
                lines[lines.count - 1] = ""; return lines.joined(separator: "\n")
            }
            let indent = String(marker.prefix { $0 == " " || $0 == "\t" })
            let n = Int(marker.filter(\.isNumber)) ?? 0
            let sep = marker.contains(")") ? ")" : "."
            return text + "\n\(indent)\(n + 1)\(sep) "
        }
        if let m = last.range(of: #"^(\s*)([-*•])\s"#, options: .regularExpression) {
            let marker = String(last[m])
            if last[m.upperBound...].trimmingCharacters(in: .whitespaces).isEmpty { lines[lines.count - 1] = ""; return lines.joined(separator: "\n") }
            return text + "\n" + marker
        }
        return text + "\n"
    }
}


/// The composer's text view: white block caret like a terminal, fixed line height (Hangul lines are no taller than Latin
/// ones, so the caret is never clipped), text-only drops (files go to the attachment strip), 1–5 lines then scrolls.
struct ComposerField: NSViewRepresentable {
    @Binding var text: String
    @Binding var focused: Bool
    @Binding var height: CGFloat
    var fontSize: Double
    var enabled: Bool
    var onSend: () -> Void
    var onPasteImage: (() -> Bool)?
    var keyHook: ((NSEvent) -> Bool)?
    var onDropFiles: (([URL]) -> Void)?
    var onDragOver: ((Bool) -> Void)?

    static let inset = NSSize(width: 14, height: 10)
    final class TV: NSTextView {
        var onFocus: (Bool) -> Void = { _ in }
        var onKey: (NSEvent) -> Bool = { _ in false }
        var onPaste: () -> Bool = { false }
        var onFiles: (([URL]) -> Void)?
        var onDragOver: (Bool) -> Void = { _ in }
        /// Files and images dropped on the text become attachments (a file drag also carries its path as text).
        private func files(_ pb: NSPasteboard) -> [URL] {
            if let u = pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !u.isEmpty { return u }
            if let img = NSImage(pasteboard: pb), let d = Attach.png(from: img), let u = Attach.save(d) { return [u] }
            return []
        }
        private func hasFiles(_ pb: NSPasteboard) -> Bool {
            pb.canReadObject(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) || pb.canReadObject(forClasses: [NSImage.self], options: nil)
        }
        override func draggingEntered(_ s: NSDraggingInfo) -> NSDragOperation {
            guard hasFiles(s.draggingPasteboard) else { return super.draggingEntered(s) }
            if onFiles != nil { onDragOver(true); return .copy }
            return []
        }
        override func draggingUpdated(_ s: NSDraggingInfo) -> NSDragOperation {
            hasFiles(s.draggingPasteboard) ? (onFiles == nil ? [] : .copy) : super.draggingUpdated(s)
        }
        override func draggingExited(_ s: NSDraggingInfo?) { onDragOver(false); super.draggingExited(s) }
        override func draggingEnded(_ s: NSDraggingInfo) { onDragOver(false); super.draggingEnded(s) }
        override func performDragOperation(_ s: NSDraggingInfo) -> Bool {
            onDragOver(false)
            guard hasFiles(s.draggingPasteboard) else { return super.performDragOperation(s) }
            let u = files(s.draggingPasteboard)
            if !u.isEmpty { onFiles?(u) }
            return !u.isEmpty
        }
        override func becomeFirstResponder() -> Bool { let r = super.becomeFirstResponder(); if r { onFocus(true) }; return r }
        override func resignFirstResponder() -> Bool { let r = super.resignFirstResponder(); if r { onFocus(false) }; return r }
        override func keyDown(with e: NSEvent) { if !hasMarkedText(), onKey(e) { return }; super.keyDown(with: e) }
        override func paste(_ sender: Any?) { if onPaste() { return }; super.paste(sender) }
        // terminal-style caret: a thick white bar
        override func drawInsertionPoint(in rect: NSRect, color: NSColor, turnedOn flag: Bool) {
            var r = rect; r.size.width = 2.5
            super.drawInsertionPoint(in: r, color: .labelColor, turnedOn: flag)
        }
        override func setNeedsDisplay(_ rect: NSRect, avoidAdditionalLayout flag: Bool) {
            var r = rect; r.size.width += 3                          // erase the wider caret too
            super.setNeedsDisplay(r, avoidAdditionalLayout: flag)
        }
    }
    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: ComposerField
        weak var tv: TV?
        init(_ p: ComposerField) { parent = p }
        func textDidChange(_ n: Notification) {
            guard let tv else { return }
            if parent.text != tv.string { parent.text = tv.string }
            fit()
        }
        /// Height for 1–5 lines; past that the scroll view scrolls (and keeps the caret in view by itself).
        func fit() {
            guard let tv, let lm = tv.layoutManager, let tc = tv.textContainer else { return }
            lm.ensureLayout(for: tc)
            let line = ceil(parent.fontSize * 1.32)
            let used = max(line, lm.usedRect(for: tc).height)
            let h = min(used, line * 5) + ComposerField.inset.height * 2
            if abs(parent.height - h) > 0.5 { DispatchQueue.main.async { self.parent.height = h } }
            tv.scrollRangeToVisible(tv.selectedRange())
        }
    }
    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let sv = NSScrollView()
        sv.drawsBackground = false; sv.hasVerticalScroller = true; sv.autohidesScrollers = true
        sv.scrollerStyle = .overlay; sv.borderType = .noBorder
        let tv = TV()
        tv.delegate = context.coordinator
        tv.isRichText = false; tv.allowsUndo = true; tv.drawsBackground = false
        tv.isAutomaticQuoteSubstitutionEnabled = false; tv.isAutomaticDashSubstitutionEnabled = false
        tv.isAutomaticTextReplacementEnabled = false; tv.isAutomaticSpellingCorrectionEnabled = false
        tv.textContainerInset = Self.inset
        tv.textContainer?.lineFragmentPadding = 0
        tv.textContainer?.widthTracksTextView = true
        tv.isVerticallyResizable = true; tv.isHorizontallyResizable = false
        tv.autoresizingMask = [.width]
        tv.insertionPointColor = .labelColor
        tv.unregisterDraggedTypes(); tv.registerForDraggedTypes([.string, .fileURL, .tiff, .png])
        sv.documentView = tv
        context.coordinator.tv = tv
        style(tv)
        tv.string = text
        return sv
    }
    func updateNSView(_ sv: NSScrollView, context: Context) {
        let c = context.coordinator
        c.parent = self
        guard let tv = c.tv else { return }
        tv.onFocus = { f in DispatchQueue.main.async { if c.parent.focused != f { c.parent.focused = f } } }
        tv.onPaste = { c.parent.onPasteImage?() ?? false }
        tv.onFiles = onDropFiles.map { f in { u in f(u) } }
        tv.onDragOver = onDragOver ?? { _ in }
        tv.onKey = { e in
            if let k = c.parent.keyHook, k(e) { return true }
            guard e.keyCode == 36 || e.keyCode == 76 else { return false }     // Return / keypad Enter
            if e.modifierFlags.contains(.shift) {
                // break at the caret (selection replaced), not at the end of the text
                let ns = tv.string as NSString, sel = tv.selectedRange()
                let head = Composer.newline(after: ns.substring(to: sel.location))
                let t = head + ns.substring(from: sel.location + sel.length)
                tv.string = t; c.parent.text = t
                tv.setSelectedRange(NSRange(location: (head as NSString).length, length: 0))
                tv.scrollRangeToVisible(tv.selectedRange())
                c.fit(); return true
            }
            c.parent.onSend(); return true
        }
        tv.isEditable = enabled; tv.isSelectable = true
        if tv.font?.pointSize != CGFloat(fontSize) { style(tv); c.fit() }
        // text changed from outside (sent → cleared, history, Tab fill): replace and put the caret at the end
        if tv.string != text && !tv.hasMarkedText() {
            tv.string = text
            tv.setSelectedRange(NSRange(location: (text as NSString).length, length: 0))
            c.fit()
        }
    }
    private func style(_ tv: NSTextView) {
        let f = NSFont.systemFont(ofSize: CGFloat(fontSize))
        let line = ceil(fontSize * 1.32)
        let p = NSMutableParagraphStyle(); p.minimumLineHeight = line; p.maximumLineHeight = line
        tv.font = f; tv.textColor = .labelColor; tv.defaultParagraphStyle = p
        tv.typingAttributes = [.font: f, .foregroundColor: NSColor.labelColor, .paragraphStyle: p]
        if let ts = tv.textStorage, ts.length > 0 {
            ts.addAttributes([.font: f, .foregroundColor: NSColor.labelColor, .paragraphStyle: p], range: NSRange(location: 0, length: ts.length))
        }
    }
}
