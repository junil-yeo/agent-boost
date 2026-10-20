import SwiftUI

/// App languages. The source texts are Korean; the others come from Resources/l10n/*.json, copied into the app bundle.
enum AppLang: String, CaseIterable, Identifiable {
    case en, ko, ja, zh, es
    var id: String { rawValue }
    /// Shown in the language menus, each in its own language.
    var native: String {
        switch self {
        case .en: "English"
        case .ko: "한국어"
        case .ja: "日本語"
        case .zh: "简体中文"
        case .es: "Español"
        }
    }
    static let key = "app.language"
    /// nil until the user has picked one (the first launch asks).
    static var chosen: AppLang? { UserDefaults.standard.string(forKey: key).flatMap(AppLang.init(rawValue:)) }
}

enum L10n {
    nonisolated(unsafe) private static var table: [String: [String: String]] = load()
    nonisolated(unsafe) private static var lang: AppLang = AppLang.chosen ?? .en
    nonisolated(unsafe) private static var missing = Set<String>()
    static var current: AppLang { lang }
    /// Called by the language menus: the root views are rebuilt for the new language (`.id(lang)`).
    static func set(_ l: AppLang) {
        lang = l
        UserDefaults.standard.set(l.rawValue, forKey: AppLang.key)
    }
    /// Every JSON file in the bundle's l10n folder: { "원문": { "en": "...", "ja": "...", "zh": "...", "es": "..." } }.
    private static func load() -> [String: [String: String]] {
        var t: [String: [String: String]] = [:]
        guard let dir = Bundle.main.resourceURL?.appendingPathComponent("l10n"),
              let files = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) else { return t }
        for f in files where f.pathExtension == "json" {
            guard let d = try? Data(contentsOf: f), let j = try? JSONSerialization.jsonObject(with: d) as? [String: [String: String]] else { continue }
            t.merge(j) { a, _ in a }
        }
        return t
    }
    static func text(_ k: String) -> String {
        guard lang != .ko else { return k }
        if let s = table[k]?[lang.rawValue], !s.isEmpty { return s }
        if !missing.contains(k) { missing.insert(k) }
        return table[k]?["en"] ?? k
    }
}

/// A user-facing text in the chosen language. `k` is the Korean source; "%@" marks each argument in order, and a
/// translation may reorder them as "%1$@", "%2$@" ….
func L(_ k: String, _ args: String...) -> String {
    var s = L10n.text(k)
    guard !args.isEmpty else { return s }
    for (i, a) in args.enumerated() { s = s.replacingOccurrences(of: "%\(i + 1)$@", with: a) }
    var i = 0
    while let r = s.range(of: "%@"), i < args.count { s.replaceSubrange(r, with: args[i]); i += 1 }
    return s
}

/// First launch: a black screen with the logo, the name and the five languages. Picking one starts the app (its
/// power-on self-test and the rocket loading screen run as the sessions are read).
struct LanguagePickerView: View {
    var onPick: (AppLang) -> Void
    @State private var shown = false
    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            VStack(spacing: 28) {
                BoostLogo().frame(width: 96, height: 96)
                HStack(spacing: 10) {
                    Text("Agent").foregroundStyle(.white)
                    Text("Boost").foregroundStyle(Theme.accent)
                }.font(.system(size: 40, weight: .bold, design: .rounded))
                VStack(spacing: 10) {
                    ForEach(AppLang.allCases) { l in
                        Button { onPick(l) } label: {
                            Text(l.native).font(.system(size: 16, weight: .semibold)).foregroundStyle(.white)
                                .frame(width: 220, height: 40)
                                .background(RoundedRectangle(cornerRadius: 10).fill(Color.white.opacity(0.08)))
                                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.white.opacity(0.18), lineWidth: 1))
                                .contentShape(Rectangle())
                        }.buttonStyle(.plain)
                    }
                }.padding(.top, 8)
            }
            .opacity(shown ? 1 : 0).scaleEffect(shown ? 1 : 0.97)
        }
        .onAppear { withAnimation(.easeOut(duration: 0.6)) { shown = true } }
    }
}

/// The language menu above the clock: switch at any time.
struct LanguageMenu: View {
    @AppStorage(AppLang.key) private var raw = AppLang.en.rawValue
    var body: some View {
        Menu {
            ForEach(AppLang.allCases) { l in
                Button { L10n.set(l); raw = l.rawValue } label: {
                    if l.rawValue == raw { Label(l.native, systemImage: "checkmark") } else { Text(l.native) }
                }
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "globe").font(.system(size: 11))
                Text(AppLang(rawValue: raw)?.native ?? "English").font(.system(size: 11, weight: .medium))
            }.foregroundStyle(.secondary)
        }
        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
    }
}
