import Foundation
import SwiftUI

enum Fmt {
    static func tokens(_ n: Int) -> String {
        if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1e6) }
        if n >= 10_000 { return "\(n / 1000)k" }
        if n >= 1_000 { return String(format: "%.1fk", Double(n) / 1e3) }
        return "\(n)"
    }
    static func ago(_ d: Date?) -> String {
        guard let d else { return "" }
        let s = Int(-d.timeIntervalSinceNow)
        if s < 60 { return "방금" }
        if s < 3600 { return "\(s / 60)분 전" }
        if s < 86400 { return "\(s / 3600)시간 전" }
        return "\(s / 86400)일 전"
    }
    static func time(_ d: Date?) -> String {
        guard let d else { return "" }
        let f = DateFormatter(); f.dateFormat = "HH:mm"; return f.string(from: d)
    }
    static func stateLabel(_ s: AgentState) -> String {
        switch s { case .busy: "작업 중"; case .idle: "대기"; case .ended: "종료됨"; case .unknown: "알 수 없음"; case .needsInput: "응답 필요" }
    }
    static func stateColor(_ s: AgentState) -> Color {
        switch s { case .busy: Theme.normal; case .idle: Theme.busy; case .ended: .secondary; case .unknown: .gray; case .needsInput: Theme.attention }
    }
}

struct Chip: View {
    var text: String; var tint: Color = .secondary
    var body: some View {
        let neutral = tint == .white, t = neutral ? Theme.ink : tint
        Text(text).font(.callout.weight(.medium)).lineLimit(1).fixedSize(horizontal: true, vertical: false).layoutPriority(1).padding(.horizontal, 8).padding(.vertical, 3)
            .background(Theme.panel.overlay(t.opacity(neutral ? 0.05 : 0.14)))   // white: a plain grey chip like the buttons
            .foregroundStyle(neutral ? Color.primary : t).clipShape(RoundedRectangle(cornerRadius: 4))
            .overlay(RoundedRectangle(cornerRadius: 4).stroke(neutral ? Theme.line : t.opacity(0.35), lineWidth: 1))
    }
}
struct StateDot: View {
    var state: AgentState
    var body: some View {
        if state == .needsInput { attention } else { dot }
    }
    /// "Needs your answer": a raised hand (shape, not only colour) with a slow pulse.
    private var attention: some View {
        Image(systemName: "hand.raised.fill").font(.system(size: 11)).foregroundStyle(Theme.attention)
            .phaseAnimator([0.5, 1.0]) { v, o in v.opacity(o) } animation: { _ in .easeInOut(duration: 1.2) }
            .frame(width: 16, height: 16)
    }
    private var dot: some View {
        // one look for every state, only the colour differs (busy used to add a bright ring)
        Circle().fill(Fmt.stateColor(state)).frame(width: 9, height: 9)
            .frame(width: 16, height: 16)
    }
}

/// Remote Control status + toggle. Teammates (no session file) show nothing.
struct RemoteChip: View {
    @EnvironmentObject var store: BoardStore
    var agent: Agent
    var body: some View {
        if let on = agent.remoteControl, agent.state != .ended {
            let pending = store.rcPending.contains(agent.sessionId)
            let tint: Color = on ? Theme.dyn(0x5CCC9E, 0x1F8A5E) : .secondary
            LazyMenu(entries: { [
                .header("Remote Control (휴대폰·claude.ai/code에서 보기)"),
                .item((on ? "✓ " : "   ") + "켜기", enabled: !on) { store.toggleRemote(agent) },
                .item((!on ? "✓ " : "   ") + "끄기", enabled: on) { store.toggleRemote(agent) },
            ] }) {
                HStack(spacing: 4) {
                    Image(systemName: on ? "antenna.radiowaves.left.and.right" : "antenna.radiowaves.left.and.right.slash")
                    Text(pending ? "RC 전환 중…" : (on ? "RC 켜짐" : "RC 꺼짐"))
                }
                .font(.callout.weight(.medium)).lineLimit(1).fixedSize()
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(tint.opacity(on ? 0.20 : 0.10))
                .foregroundStyle(tint).clipShape(RoundedRectangle(cornerRadius: 6))
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(tint.opacity(0.35), lineWidth: 0.8))
            }
            .buttonStyle(.plain).disabled(pending || agent.tmuxPane == nil)
            .help(agent.tmuxPane == nil ? "Remote Control \(on ? "켜짐" : "꺼짐") — 데스크톱 앱 세션은 여기서 바꿀 수 없습니다"
                  : on ? "Remote Control 켜짐: 휴대폰·claude.ai/code에서 보입니다. 누르면 끕니다." : "Remote Control 꺼짐. 누르면 켭니다.")
        }
    }
}

import UniformTypeIdentifiers

/// Files for the chat box: dropped files, dropped/pasted images (saved under ~/.agent-boost/attachments).
enum Attach {
    static let dir = URL(fileURLWithPath: Shell.home + "/.agent-boost/attachments")
    static func save(_ png: Data) -> URL? {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let f = DateFormatter(); f.dateFormat = "yyyyMMdd-HHmmss"
        let u = dir.appendingPathComponent("screenshot-\(f.string(from: Date()))-\(Int.random(in: 100...999)).png")
        return (try? png.write(to: u)) != nil ? u : nil
    }
    /// Images as the CLI takes them: two or more quoted paths ("a b.png" "c d.png") stayed plain text instead of becoming
    /// "[Image #n]", and a screenshot dragged from its thumbnail lives in a temporary folder macOS soon empties. Such
    /// images are copied here under a name without spaces; other files are left where they are.
    static func staged(_ urls: [URL]) -> [URL] {
        let images: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "heic", "tiff", "bmp"]
        return urls.map { u in
            let p = u.path
            guard images.contains(u.pathExtension.lowercased()), !p.hasPrefix(dir.path),
                  p.contains(" ") || p.contains("/var/folders/"), FileManager.default.fileExists(atPath: p) else { return u }
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let f = DateFormatter(); f.dateFormat = "yyyyMMdd-HHmmss"
            let to = dir.appendingPathComponent("image-\(f.string(from: Date()))-\(Int.random(in: 100...999)).\(u.pathExtension.lowercased())")
            return (try? FileManager.default.copyItem(at: u, to: to)) != nil ? to : u
        }
    }
    static func png(from img: NSImage) -> Data? {
        guard let t = img.tiffRepresentation, let r = NSBitmapImageRep(data: t) else { return nil }
        return r.representation(using: .png, properties: [:])
    }
    /// Clipboard image (e.g. ⌘⇧⌃4 screenshot). Text on the clipboard wins, so normal pasting is untouched.
    static func pastedImage() -> URL? {
        let pb = NSPasteboard.general
        if let urls = pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], let u = urls.first { return u }
        if pb.string(forType: .string) != nil { return nil }
        guard let img = NSImage(pasteboard: pb), let d = png(from: img) else { return nil }
        return save(d)
    }
    static func load(_ providers: [NSItemProvider], done: @escaping ([URL]) -> Void) {
        for p in providers {
            if p.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                _ = p.loadObject(ofClass: URL.self) { u, _ in if let u { DispatchQueue.main.async { done([u]) } } }
            } else if p.canLoadObject(ofClass: NSImage.self) {
                _ = p.loadObject(ofClass: NSImage.self) { img, _ in
                    if let img = img as? NSImage, let d = png(from: img), let u = save(d) { DispatchQueue.main.async { done([u]) } }
                }
            }
        }
    }
}

struct AttachmentStrip: View {
    @Binding var urls: [URL]
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(urls, id: \.self) { u in
                    HStack(spacing: 6) {
                        if let img = NSImage(contentsOf: u), ["png","jpg","jpeg","gif","heic","webp","tiff"].contains(u.pathExtension.lowercased()) {
                            Image(nsImage: img).resizable().scaledToFill().frame(width: 28, height: 28).clipShape(RoundedRectangle(cornerRadius: 4))
                        } else {
                            Image(nsImage: NSWorkspace.shared.icon(forFile: u.path)).resizable().frame(width: 22, height: 22)
                        }
                        Text(u.lastPathComponent).font(.caption).lineLimit(1).frame(maxWidth: 180)
                        Button { urls.removeAll { $0 == u } } label: { Image(systemName: "xmark.circle.fill") }.buttonStyle(.plain).foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, 6).padding(.vertical, 4)
                    .background(Theme.ink.opacity(0.07)).clipShape(RoundedRectangle(cornerRadius: 6))
                    .help(u.path)
                }
            }
        }
    }
}

/// File paths in chat text ("/Users/…/a.png", "~/x/y"): links that open the folder in Finder (a file: its folder, the
/// file selected). A path with a space ends at the space; the link then opens the deepest part of it that exists.
enum PathLinks {
    private static let rx = try! NSRegularExpression(pattern: #"(?<![\p{L}\p{N}._/~-])~?/(?:[\p{L}\p{N}._@%+~#=-]+/)+[\p{L}\p{N}._@%+~#=-]*"#)
    nonisolated(unsafe) private static var cache: [String: URL?] = [:]
    private static let lock = NSLock()
    /// Ranges (UTF-16) of the paths in `s` and what each opens. Only paths whose folder exists on this Mac.
    static func find(_ s: String) -> [(NSRange, URL)] {
        guard s.contains("/") else { return [] }
        let ns = s as NSString
        var out: [(NSRange, URL)] = []
        for m in rx.matches(in: s, range: NSRange(location: 0, length: ns.length)) {
            var r = m.range
            while r.length > 0, ".,-:".contains(ns.substring(with: NSRange(location: r.location + r.length - 1, length: 1))) { r.length -= 1 }
            if let u = target(ns.substring(with: r)) { out.append((r, u)) }
        }
        return out
    }
    /// The deepest existing part of the path (at least two levels: "/Users/x"), or nil.
    private static func target(_ p: String) -> URL? {
        lock.lock(); defer { lock.unlock() }
        if let c = cache[p] { return c }
        if cache.count > 4000 { cache.removeAll() }
        var u = URL(fileURLWithPath: (p as NSString).expandingTildeInPath)
        var found: URL?
        while u.pathComponents.count >= 3 {
            if FileManager.default.fileExists(atPath: u.path) { found = u; break }
            u.deleteLastPathComponent()
        }
        cache[p] = found
        return found
    }
    /// A folder opens in Finder; a file shows in its folder, selected.
    @MainActor static func open(_ u: URL) {
        var dir: ObjCBool = false
        if FileManager.default.fileExists(atPath: u.path, isDirectory: &dir), dir.boolValue { NSWorkspace.shared.open(u) }
        else { NSWorkspace.shared.activateFileViewerSelecting([u]) }
    }
    /// The same links on SwiftUI text.
    static func link(_ a: AttributedString) -> AttributedString {
        let s = String(a.characters)
        let found = find(s)
        guard !found.isEmpty else { return a }
        var a = a
        for (r, u) in found {
            guard let sr = Range(r, in: s) else { continue }
            let lo = a.characters.index(a.startIndex, offsetBy: s.distance(from: s.startIndex, to: sr.lowerBound))
            let hi = a.characters.index(lo, offsetBy: s.distance(from: sr.lowerBound, to: sr.upperBound))
            a[lo..<hi].link = u
        }
        return a
    }
}
