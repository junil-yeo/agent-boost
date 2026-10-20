import SwiftUI

struct TodoItem: Identifiable, Codable, Equatable {
    var id = UUID()
    var text: String
    var done = false
}

/// One task card: a title and its checklist.
struct TodoBoard: Identifiable, Codable, Equatable {
    var id = UUID()
    var title = ""
    var items: [TodoItem] = []
    var remaining: Int { items.filter { !$0.done }.count }
}

/// Three task cards in the banner, saved in ~/.agent-boost/todos.json.
@MainActor final class TodoStore: ObservableObject {
    static let shared = TodoStore()
    static let count = 3
    @Published var boards: [TodoBoard] = [] { didSet { if loaded { save() } } }
    private var loaded = false
    private let queue = DispatchQueue(label: "agentboost.todos", qos: .utility)
    private static var url: URL { URL(fileURLWithPath: Shell.home + "/.agent-boost/todos.json") }

    private init() {
        var b: [TodoBoard] = []
        if let d = try? Data(contentsOf: Self.url) {
            if let v = try? JSONDecoder().decode([TodoBoard].self, from: d) { b = v }
            else if let old = try? JSONDecoder().decode([TodoItem].self, from: d) { b = [TodoBoard(items: old)] }   // the single list moves into card 1
            else { try? FileManager.default.removeItem(atPath: Self.url.path + ".bak"); try? FileManager.default.moveItem(atPath: Self.url.path, toPath: Self.url.path + ".bak") }   // keep the unreadable file
        }
        while b.count < Self.count { b.append(TodoBoard()) }   // at least three; more with the + button
        boards = b
        loaded = true
    }

    private func with(_ bid: UUID, _ f: (inout TodoBoard) -> Void) {
        guard let i = boards.firstIndex(where: { $0.id == bid }) else { return }
        f(&boards[i])
    }
    func addBoard() { boards.append(TodoBoard()) }
    func removeBoard(_ bid: UUID) { boards.removeAll { $0.id == bid } }
    func setTitle(_ bid: UUID, _ t: String) { with(bid) { $0.title = t.trimmingCharacters(in: .whitespacesAndNewlines) } }
    func add(_ bid: UUID, _ text: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        with(bid) { $0.items.append(TodoItem(text: t)) }
    }
    func toggle(_ bid: UUID, _ id: UUID) { with(bid) { b in if let i = b.items.firstIndex(where: { $0.id == id }) { b.items[i].done.toggle() } } }
    func remove(_ bid: UUID, _ id: UUID) { with(bid) { $0.items.removeAll { $0.id == id } } }
    func edit(_ bid: UUID, _ id: UUID, to text: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        with(bid) { b in
            guard let i = b.items.firstIndex(where: { $0.id == id }) else { return }
            if t.isEmpty { b.items.remove(at: i) } else { b.items[i].text = t }
        }
    }
    func clearDone(_ bid: UUID) { with(bid) { $0.items.removeAll { $0.done } } }
    func move(_ bid: UUID, _ id: UUID, before target: UUID) {
        with(bid) { b in
            guard id != target, let from = b.items.firstIndex(where: { $0.id == id }) else { return }
            let it = b.items.remove(at: from)
            let to = b.items.firstIndex(where: { $0.id == target }) ?? b.items.count
            b.items.insert(it, at: to)
        }
    }
    private func save() {
        let snapshot = boards
        queue.async {
            let dir = Self.url.deletingLastPathComponent()
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            if let d = try? JSONEncoder().encode(snapshot) { try? d.write(to: Self.url, options: .atomic) }
        }
    }
}

/// The banner's task area: three cards the size of the usage cards; clicking one unfolds its full checklist.
struct TodoCard: View {
    var forceIcon = false
    @ObservedObject private var store = TodoStore.shared
    @State private var showPopover = false
    var body: some View {
        if forceIcon { icon }
        else {
            // cards in a row that scrolls sideways; + adds one (the banner never pushes the window wider)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(store.boards) { TaskCardView(board: $0, store: store) }
                    Button { store.addBoard() } label: {
                        Image(systemName: "plus").font(.system(size: 14, weight: .semibold)).frame(width: 34, height: TaskCardView.height)
                            .background(RoundedRectangle(cornerRadius: 10).fill(Theme.card.opacity(0.6)))
                            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.line))
                    }.buttonStyle(.plain).foregroundStyle(.secondary).help(L("과제 카드 추가"))
                }
            }
            .frame(minWidth: 120, maxWidth: .infinity, alignment: .leading)
        }
    }
    private var icon: some View {
            Button { showPopover.toggle() } label: {
                HStack(spacing: 4) {
                    Image(systemName: "checklist").font(.system(size: 14))
                    let r = store.boards.reduce(0) { $0 + $1.remaining }
                    if r > 0 { Text("\(r)").font(.caption.monospacedDigit().weight(.semibold)) }
                }.foregroundStyle(.secondary)
            }
            .buttonStyle(.icon).help(L("과제"))
            .popover(isPresented: $showPopover, arrowEdge: .bottom) {
                VStack(spacing: 10) { ForEach(store.boards) { TaskPanel(board: $0, store: store) } }
                    .padding(12).frame(width: 300).background(Theme.bgTop)
            }
    }
}

/// Folded card (usage-card size). Hover → the full panel floats below it without moving anything.
private struct TaskCardView: View {
    static let width: CGFloat = 180, height: CGFloat = 90      // the usage cards' height
    var board: TodoBoard
    @ObservedObject var store: TodoStore
    @State private var open = false
    @State private var typing = false
    private var index: Int { (store.boards.firstIndex(where: { $0.id == board.id }) ?? 0) + 1 }
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                Text(board.title.isEmpty ? L("과제 %@", String(index)) : board.title)
                    .font(.caption.weight(.semibold)).foregroundStyle(board.title.isEmpty ? Color.secondary : Color.primary.opacity(0.9)).lineLimit(1)
                Spacer(minLength: 4)
                if !board.items.isEmpty {
                    Text("\(board.items.count - board.remaining)/\(board.items.count)").font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                }
            }
            UsageBanner.Bar(value: board.items.isEmpty ? 0 : Double(board.items.count - board.remaining) / Double(board.items.count),
                            tint: Theme.accent.opacity(0.85), height: 4, marker: nil)
            // the first two items as they stand in the list; done ones struck through
            if board.items.isEmpty {
                Text(L("클릭해서 할 일 추가")).font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
            } else {
                ForEach(board.items.prefix(2)) { it in
                    Text(it.text).font(.caption2).strikethrough(it.done).foregroundStyle(.tertiary).lineLimit(1)
                }
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .frame(width: Self.width, height: Self.height, alignment: .topLeading)
        .background(RoundedRectangle(cornerRadius: 10).fill(Theme.card))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(open ? Theme.lineHi : Theme.line))
        .contentShape(Rectangle())
        .onTapGesture { open.toggle() }
        // a popover (its own window): an overlay would be clipped by the sideways-scrolling row; a click outside closes it
        .popover(isPresented: $open, arrowEdge: .bottom) {
            TaskPanel(board: board, store: store, typing: $typing)
                .frame(width: 280).padding(12)
        }
        .zIndex(open ? 10 : 0)
    }
}

/// The unfolded card: editable title, every item with a checkbox, an add field.
private struct TaskPanel: View {
    var board: TodoBoard
    @ObservedObject var store: TodoStore
    var typing: Binding<Bool> = .constant(false)
    @State private var title = ""
    @State private var draft = ""
    @State private var editing: UUID?
    @State private var editText = ""
    @FocusState private var focus: Field?
    private enum Field: Hashable { case title, add, edit }
    private var index: Int { (store.boards.firstIndex(where: { $0.id == board.id }) ?? 0) + 1 }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                TextField(L("과제 %@ 제목", String(index)), text: $title)
                    .textFieldStyle(.plain).font(.system(size: 14, weight: .semibold)).focused($focus, equals: .title)
                    .onSubmit { store.setTitle(board.id, title) }
                if board.items.contains(where: \.done) {
                    Button(L("완료 지우기")) { store.clearDone(board.id) }.buttonStyle(.plain).font(.caption).foregroundStyle(.secondary)
                }
                if store.boards.count > TodoStore.count {
                    Button { store.removeBoard(board.id) } label: { Image(systemName: "trash") }.buttonStyle(.icon).help(L("이 과제 카드 삭제"))
                }
            }
            Divider().opacity(0.5)
            ScrollView {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(board.items) { row($0) }
                    if board.items.isEmpty { Text(L("아직 항목이 없습니다")).font(.callout).foregroundStyle(.tertiary).padding(.vertical, 6) }
                }
            }
            .frame(maxHeight: 320).fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 6) {
                Image(systemName: "plus").font(.caption).foregroundStyle(.tertiary)
                TextField(L("항목 추가 후 Enter"), text: $draft)
                    .textFieldStyle(.plain).font(.callout).focused($focus, equals: .add)
                    .onSubmit {
                        store.add(board.id, draft)
                        DispatchQueue.main.async { draft = ""; focus = .add }   // after the IME commits its last syllable
                    }
            }
            .padding(.horizontal, 8).padding(.vertical, 6)
            .background(RoundedRectangle(cornerRadius: 7).fill(Theme.ink.opacity(0.05)))
        }
        .background(PopoverKeyMaker())
        .onAppear { title = board.title }
        .onChange(of: focus) { old, new in
            if old == .title, new != .title { store.setTitle(board.id, title) }
        }
        // only real typing keeps the panel open (the popover focuses its first field on its own, which used to pin it)
        .onChange(of: draft) { _, d in typing.wrappedValue = !d.isEmpty || editing != nil }
        .onChange(of: editing) { _, e in typing.wrappedValue = !draft.isEmpty || e != nil }
    }
    private func row(_ it: TodoItem) -> some View {
        HStack(spacing: 8) {
            Button { store.toggle(board.id, it.id) } label: {
                Image(systemName: it.done ? "checkmark.circle.fill" : "circle").font(.system(size: 14))
                    .foregroundStyle(it.done ? Theme.accent : Color.secondary)
            }.buttonStyle(.plain)
            if editing == it.id {
                TextField("", text: $editText).textFieldStyle(.plain).font(.callout).focused($focus, equals: .edit)
                    .onSubmit { store.edit(board.id, it.id, to: editText); editing = nil }
                    .onExitCommand { editing = nil }
            } else {
                Text(it.text).font(.callout).strikethrough(it.done).foregroundStyle(it.done ? Color.secondary : Color.primary.opacity(0.9))
                    .lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                    .onTapGesture(count: 2) { editText = it.text; editing = it.id; focus = .edit }
            }
            Button { store.remove(board.id, it.id) } label: { Image(systemName: "xmark").font(.caption2) }
                .buttonStyle(.icon).help(L("삭제"))
        }
        .padding(.vertical, 4).padding(.horizontal, 4)
        .draggable(it.id.uuidString)
        .dropDestination(for: String.self) { ids, _ in
            if let s = ids.first, let id = UUID(uuidString: s) { store.move(board.id, id, before: it.id) }
            return true
        }
    }
}

/// A popover is not always the key window, so keys typed after clicking one of its fields went to the main
/// window's input box. A click inside the popover makes its window key first.
private struct PopoverKeyMaker: NSViewRepresentable {
    final class V: NSView {
        private var monitor: Any?
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let m = monitor { NSEvent.removeMonitor(m); monitor = nil }
            guard window != nil else { return }
            monitor = NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { [weak self] e in
                if let w = self?.window, e.window === w, !w.isKeyWindow { w.makeKey() }
                return e
            }
        }
        deinit { if let m = monitor { NSEvent.removeMonitor(m) } }
    }
    func makeNSView(context: Context) -> V { V() }
    func updateNSView(_ v: V, context: Context) {}
}
