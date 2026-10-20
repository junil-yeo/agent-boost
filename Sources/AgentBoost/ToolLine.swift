import SwiftUI

/// One tool call as a quiet single line (summary + chevron); the details unfold underneath.
struct ToolLine<Detail: View>: View {
    var summary: String
    var icon: String = "wrench.and.screwdriver"
    var isError = false
    var hasDetail = true            // false: the summary is the whole story (no arrow, not clickable)
    @Binding var expanded: Bool
    @ViewBuilder var detail: () -> Detail
    @State private var hover = false
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button { if hasDetail { withAnimation(.easeOut(duration: 0.12)) { expanded.toggle() } } } label: {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.right").font(.system(size: 9, weight: .bold)).rotationEffect(.degrees(expanded ? 90 : 0))
                        .opacity(hasDetail ? 1 : 0)
                    Image(systemName: isError ? "exclamationmark.triangle.fill" : icon).font(.caption)
                    Text(summary).font(.system(.caption, design: .monospaced)).lineLimit(1).truncationMode(.middle)
                    Spacer(minLength: 0)
                }
                .foregroundStyle(isError ? Theme.errorTone.opacity(hover || expanded ? 1 : 0.85) : Color.primary.opacity(hover || expanded ? 0.8 : 0.55))
                .padding(.horizontal, 8).padding(.vertical, 3).contentShape(Rectangle())
            }
            .buttonStyle(.plain).onHover { hover = hasDetail && $0 }.allowsHitTesting(hasDetail)
            if expanded && hasDetail {
                detail().font(.system(.caption, design: .monospaced)).foregroundStyle(Color.primary.opacity(0.75))
                    .textSelection(.enabled).padding(.horizontal, 10).padding(.vertical, 6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 6).fill(isError ? Theme.errorTone.opacity(0.10) : Theme.ink.opacity(0.05)))
            }
        }
    }
}
