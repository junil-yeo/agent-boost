import SwiftUI
import AppKit

/// The question Claude Code is asking in the terminal (permission, trust, model switch …), answered from here.
/// Pure display: the caller supplies the texts and what happens on choose / cancel.
struct PromptCard: View {
    var title: String
    var detail: String?
    var preview: String?
    var options: [String]
    var cursor: Int
    var sending: Bool
    var onChoose: (Int) -> Void
    var onCancel: () -> Void
    @State private var previewOpen = true

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "hand.raised.fill").foregroundStyle(Theme.attention)
                Text(title).font(.headline).lineLimit(2).textSelection(.enabled)
                Spacer(minLength: 0)
                if sending { ProgressView().controlSize(.small); Text(L("전송 중…")).font(.caption).foregroundStyle(.secondary) }
            }
            if let detail, !detail.isEmpty {
                Text(detail).font(.callout).foregroundStyle(Color.primary.opacity(0.75)).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let preview, !preview.isEmpty { previewBox(preview) }
            VStack(spacing: 5) {
                ForEach(Array(options.enumerated()), id: \.offset) { i, label in
                    Button { onChoose(i) } label: {
                        HStack(spacing: 8) {
                            Text("\(i + 1)").font(.system(.caption, design: .monospaced).weight(.bold))
                                .frame(width: 18, height: 18).background(Circle().fill(Theme.ink.opacity(i == 0 ? 0.28 : 0.12)))
                            Text(label).lineLimit(2).multilineTextAlignment(.leading)
                            Spacer(minLength: 0)
                            if i == cursor && !sending { Text(L("기본")).font(.caption2).foregroundStyle(.secondary) }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .buttonStyle(RaisedButtonStyle(prominent: i == 0, minHeight: 30))
                    .disabled(sending)
                }
            }
            HStack {
                Text(L("숫자 키 1–%@로 선택 · Esc로 취소", String(max(1, min(options.count, 9))))).font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button(L("취소 (Esc)")) { onCancel() }.buttonStyle(.raisedCompact).disabled(sending)
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 6).fill(Theme.panel))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Theme.attention.opacity(0.7), lineWidth: 1.5))
    }

    private func previewBox(_ text: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Button { withAnimation(.easeOut(duration: 0.12)) { previewOpen.toggle() } } label: {
                HStack(spacing: 5) {
                    Image(systemName: "chevron.right").font(.system(size: 9, weight: .bold)).rotationEffect(.degrees(previewOpen ? 90 : 0))
                    Text(L("미리보기")).font(.caption)
                }.foregroundStyle(.secondary)
            }.buttonStyle(.plain)
            if previewOpen {
                let box = Text(text).font(.system(.callout, design: .monospaced)).textSelection(.enabled)
                    .padding(8).frame(maxWidth: .infinity, alignment: .leading)
                Group {
                    if text.split(separator: "\n", omittingEmptySubsequences: false).count > 7 { ScrollView([.vertical, .horizontal]) { box }.frame(height: 150) }
                    else { box }   // a short command needs no scroll view (which would collapse in this layout)
                }
                .background(RoundedRectangle(cornerRadius: 8).fill(Theme.dyn(0x0D0E10, 0xF3F3F3)))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.line))
            }
        }
    }

    /// 1–9 chooses, Esc cancels. Returns true when the key was used. `composerEmpty`: numbers are text while typing.
    static func handleKey(_ ev: NSEvent, optionCount: Int, sending: Bool, composerEmpty: Bool,
                          onChoose: (Int) -> Void, onCancel: () -> Void) -> Bool {
        if sending { return false }
        if ev.keyCode == 53 { onCancel(); return true }
        guard composerEmpty, ev.modifierFlags.intersection([.command, .control, .option]).isEmpty,
              let c = ev.charactersIgnoringModifiers?.first, let n = c.wholeNumberValue, n >= 1, n <= min(optionCount, 9) else { return false }
        onChoose(n - 1); return true
    }
}
