import SwiftUI

struct UsageBanner: View {
    @EnvironmentObject var store: BoardStore
    var compact = false
    @AppStorage("ui.showNotices") private var showNotices = true
    var body: some View {
        HStack(spacing: 14) {
            // name block under the window's close/minimise buttons (no reserved gap to their right)
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 9) {
                    BoostLogo().frame(width: 34, height: 34)
                    VStack(alignment: .leading, spacing: -3) {
                        Text("Agent").font(.system(size: 18, weight: .bold, design: .rounded))
                        Text("Boost").font(.system(size: 18, weight: .bold, design: .rounded)).foregroundStyle(Theme.accent)
                    }
                }
                Link(destination: URL(string: "https://github.com/junil-yeo/agent-boost")!) {
                    HStack(alignment: .top, spacing: 1) {
                        Text("GitHub Page").font(.system(size: 11, weight: .semibold))
                        Image(systemName: "arrow.up.right").font(.system(size: 7, weight: .bold)).offset(y: -1)   // "opens a page"
                    }
                }
                .buttonStyle(TabFaceStyle(raised: true, small: true))
                .help(L("github.com/junil-yeo/agent-boost — 브라우저에서 엽니다"))
            }
            .padding(.top, 12).fixedSize()
            if store.meters.isEmpty || store.rebooting {
                // power-on self-test while the numbers are on their way; a red OFF flag if they could not be read
                let failed = !store.usageBusy && store.usageError != nil
                let status = store.usageBusy ? L("사용량 불러오는 중") : (store.loggedOut ? L("터미널에서 claude 실행 후 로그인") : failed ? L("사용량을 불러오지 못했습니다") : L("사용량 대기 중"))
                if compact {
                    BootClock { t in
                        HStack(spacing: 6) {
                            if failed { Text("OFF").font(.system(size: 9, weight: .heavy, design: .monospaced)).foregroundStyle(.white).padding(.horizontal, 3).background(RoundedRectangle(cornerRadius: 2).fill(Theme.errorTone)) }
                            else { RadarScope(t: t).frame(width: 14, height: 14) }
                            Text(status).font(.caption).foregroundStyle(failed ? Theme.errorTone : Theme.textDim).lineLimit(1)
                        }
                        .padding(.horizontal, 8).padding(.vertical, 4)
                        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.bezel))
                    }.help(store.usageError ?? "")
                } else {
                    ForEach(0..<3, id: \.self) { i in
                        BootClock { t in MeterSelfTest(t: t + Double(i) * 0.35, status: status, failed: failed, title: store.loggedOut ? L("로그인 필요") : nil) }
                            .help(store.usageError ?? "")
                    }
                }
            } else {
                ForEach(store.meters) { m in Meter(m: m, compact: compact) }
            }
            TrafficLight(meter: store.meters.first { $0.label.lowercased().contains("all models") }, testing: store.meters.isEmpty && store.usageError == nil,
                         refresh: RefreshButton(spinning: store.rebooting) { store.manualRefresh() }
                            .help(L("사용량·세션 새로고침 — 5분마다 자동 갱신") + (store.usageUpdated.map { L(" · 마지막 %@", Fmt.time($0)) } ?? "")))
            // logo and usage hug the left (fixed widths); the task row takes all the space that is left
            TodoCard(forceIcon: compact).frame(maxWidth: .infinity, alignment: .leading)
            (compact ? AnyLayout(HStackLayout(spacing: 8)) : AnyLayout(VStackLayout(alignment: .trailing, spacing: 4))) {
                LanguageMenu()
                TimelineView(.periodic(from: .now, by: 1)) { ctx in
                    Text(UsageBanner.clock.string(from: ctx.date))   // 24-hour HH:mm
                        .font(.system(size: compact ? 15 : 20, weight: .medium, design: .monospaced)).monospacedDigit().fixedSize()
                        .foregroundStyle(Theme.normal)
                        .padding(.horizontal, 8).padding(.vertical, 2)
                        .background(RoundedRectangle(cornerRadius: 6).fill(Theme.bezel))
                        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Theme.line, lineWidth: 1))
                }
                .help(L("현재 시각"))
                HStack(spacing: 8) {
                TimelineView(.periodic(from: .now, by: 5)) { _ in
                    VStack(alignment: .trailing, spacing: 0) {
                        Text(String(format: "RAM %.1fGB", HostMemory.availableGB()))
                        Text({ let g = HostMemory.diskFreeGB(); return g.isNaN ? L("디스크 …") : L("디스크 %@GB", String(format: "%.1f", g)) }())
                    }.font(.system(size: 11, weight: .medium)).monospacedDigit().foregroundStyle(.secondary).fixedSize()
                }
                .help(L("여유 공간 (5초마다)\nRAM: 작업용 시스템 메모리 중 지금 쓸 수 있는 양 (비어 있음 + 비활성 + 회수 가능)\n디스크: 저장 공간 중 남은 용량"))
Button { showNotices.toggle() } label: {
                    Image(systemName: showNotices ? "bell.fill" : "bell.slash").font(.system(size: 14))
                        .foregroundStyle(showNotices ? Theme.accent : Color.secondary)
                }
                .buttonStyle(.icon)
                .help(showNotices ? L("알림 막대 켜짐 — 누르면 숨깁니다 (기록은 계속 쌓입니다)") : L("알림 막대 꺼짐 — 누르면 알림과 지난 기록을 보여줍니다"))
                }
            }
        }
        .padding(.horizontal, 16).padding(.vertical, compact ? 6 : 10)
        .background(Theme.strip.gesture(WindowDragGesture()))   // drag the window by the banner
    }
    struct Meter: View {
        var m: UsageMeter
        var compact = false
        var label: String {
            let l = m.label.lowercased()
            if l.contains("session") { return L("현재") }
            if l.contains("all models") { return L("주간") }
            if l.contains("fable") { return L("페이블") }
            return m.label.replacingOccurrences(of: "Current week (", with: "").replacingOccurrences(of: ")", with: "")   // another per-model limit: its model name
        }
        /// Use at reset if the current pace holds. Nothing used yet = 0 %; only the first moments of a period (too
        /// little time to extrapolate) have no number.
        var projectionText: String {
            if let p = m.projected { return L("소모 추세에 따른 최종 예상 사용량 %@%", String(p)) }
            return m.percent == 0 ? L("소모 추세에 따른 최종 예상 사용량 %@%", "0") : L("소모 추세에 따른 최종 예상 사용량 계산 중")
        }
        var projectionColor: Color {
            guard let p = m.projected else { return Theme.textDim }
            return p > 120 ? Theme.errorTone : p > 100 ? Theme.attention : Theme.textDim
        }
        var tint: Color { m.percent >= 85 ? Theme.errorTone : m.percent >= 60 ? Theme.attention : Theme.normal }
        var body: some View {
            if compact { slim } else { full }
        }
        private var slim: some View {
            HStack(spacing: 6) {
                Text(label).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                Bar(value: Double(m.percent) / 100, tint: tint, height: 5, marker: m.elapsed).frame(minWidth: 40, maxWidth: 90)
                Text("\(m.percent)%").font(.caption.bold().monospacedDigit())
            }
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background(RoundedRectangle(cornerRadius: 8).fill(Theme.card))
            .help(m.remainingText.isEmpty ? m.resets : L("초기화: %@ · %@", m.resets, m.remainingText))
        }
        /// A round instrument: the arc is usage, the magenta bug is time elapsed, the thin inner arc is the projected
        /// use at reset. Numbers sit beside the dial, so nothing is told by colour alone.
        private var full: some View {
            VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 10) {
                InstrumentDial(value: Double(m.percent) / 100, tint: tint, bug: m.elapsed, projected: m.projected.map { Double($0) / 100 }) {
                    HStack(alignment: .firstTextBaseline, spacing: 0) {
                        Text("\(m.percent)").font(.system(size: 17, weight: .semibold, design: .monospaced))
                        Text("%").font(.system(size: 9, weight: .semibold, design: .monospaced)).foregroundStyle(Theme.textDim)
                    }.foregroundStyle(m.percent >= 60 ? tint : Color.primary)
                }
                .frame(width: 62, height: 62)
                VStack(alignment: .leading, spacing: 3) {
                    Text(label).font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.busy).lineLimit(1)
                    if let e = m.elapsed {
                        Text(L("시간 %@% 경과", String(Int(e * 100)))).font(.system(size: 10, weight: .medium).monospacedDigit()).foregroundStyle(Theme.bug).lineLimit(1).minimumScaleFactor(0.8)
                        Text(m.remainingText).font(.system(size: 10, weight: .medium)).foregroundStyle(Theme.textDim).lineLimit(1).minimumScaleFactor(0.7)
                    } else {
                        Text(m.resets.isEmpty ? L("사용 시작 전") : L("초기화 %@", m.resets)).font(.system(size: 10, weight: .medium)).foregroundStyle(Theme.textDim).lineLimit(2)
                    }
                }
                .frame(width: 92, alignment: .leading)
            }
            // bottom line, the full card width: where this pace ends by the reset
            Text(projectionText).font(.system(size: 10, weight: .medium).monospacedDigit()).foregroundStyle(projectionColor)
                .lineLimit(1).fixedSize().frame(width: 168, alignment: .leading)
                .help(m.projected.map { L("지금 속도대로면 초기화 때 %@%를 씁니다", String($0)) } ?? (m.percent == 0 ? L("이번 기간에 아직 쓴 양이 없습니다") : L("기간이 막 시작돼 아직 추세를 계산하지 않습니다")))
            }
            .padding(.horizontal, 8).padding(.vertical, 6)
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Theme.bezel))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(Theme.line, lineWidth: 1))
            .help(m.elapsed.map { e in
                let pace = Double(m.percent) / 100 - e
                return L("초기화: %@", m.resets) + "\n" + (pace > 0.05 ? L("시간보다 빠르게 쓰는 중 (+%@%p)", String(Int(pace * 100))) : pace < -0.05 ? L("여유 있음 (%@%p)", String(Int(-pace * 100))) : L("시간과 비슷한 속도"))
            } ?? m.resets)
        }
    }
    /// Weekly pace light: green ≤ 100 %, yellow ≤ 120 %, red above (projected use of the weekly all-models limit).
    struct TrafficLight<Key: View>: View {
        var meter: UsageMeter?
        var testing = false      // usage not in yet: run the lamp test
        var refresh: Key         // the refresh key, a fourth row under the lamps
        var body: some View {
            let p = meter?.projected
            let on: Int = p.map { $0 <= 100 ? 0 : $0 <= 120 ? 1 : 2 } ?? -1
            let tip = p.map { L("주간 전체 추세: 초기화 때 %@% 예상", String($0)) } ?? L("주간 사용량 추세 계산 전")
            Group {
                if testing { BootClock { t in AnnunciatorPanel(on: on, test: AnnunciatorPanel<EmptyView>.testStep(t), tip: tip, key: refresh) } }
                else { AnnunciatorPanel(on: on, tip: tip, key: refresh) }
            }
        }
    }
    /// Usage bar; the white tick marks how much of the window has elapsed, so
    /// usage to the right of the tick means spending faster than time passes.
    static let clock: DateFormatter = { let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = "HH:mm"; return f }()
    static let timeBlue = Theme.bug

    /// A capsule bar of a fixed height. The optional dashed tick marks how much
    /// of the window has elapsed: usage right of the tick = spending faster than time.
    struct Bar: View {
        var value: Double; var tint: Color; var height: CGFloat; var marker: Double?
        var body: some View {
            GeometryReader { g in
                ZStack(alignment: .leading) {
                    Capsule().fill(.quaternary)
                    Capsule().fill(tint).frame(width: max(0, min(1, value)) * g.size.width)
                }
                .overlay(alignment: .leading) {
                    if let m = marker {
                        let x = max(0, min(1, m)) * g.size.width
                        Path { p in p.move(to: CGPoint(x: x, y: -3)); p.addLine(to: CGPoint(x: x, y: height + 3)) }
                            .stroke(Color.primary.opacity(0.85), style: StrokeStyle(lineWidth: 1.5, dash: [2, 2]))
                    }
                }
            }
            .frame(height: height)
        }
    }
}

/// Memory the host can hand out now, roughly as Activity Monitor counts it: free + inactive + speculative + purgeable pages.
enum HostMemory {
    static func availableGB() -> Double {
        var st = vm_statistics64_data_t()
        var n = mach_msg_type_number_t(MemoryLayout<vm_statistics64_data_t>.size / MemoryLayout<integer_t>.size)
        let r = withUnsafeMutablePointer(to: &st) { $0.withMemoryRebound(to: integer_t.self, capacity: Int(n)) { host_statistics64(mach_host_self(), HOST_VM_INFO64, $0, &n) } }
        guard r == KERN_SUCCESS else { return 0 }
        let pages = UInt64(st.free_count) + UInt64(st.inactive_count) + UInt64(st.speculative_count) + UInt64(st.purgeable_count)
        return Double(pages * UInt64(vm_kernel_page_size)) / 1_073_741_824
    }
    /// Free space on the startup volume as Finder shows it (includes purgeable space macOS can clear). Asking for it takes
    /// ~0.1 s, so it is read in the background at most every 30 s and the last value is shown.
    nonisolated(unsafe) private static var disk: (at: Date, gb: Double)?
    nonisolated(unsafe) private static var diskBusy = false
    static func diskFreeGB() -> Double {
        if !diskBusy, Date().timeIntervalSince(disk?.at ?? .distantPast) > 30 {
            diskBusy = true
            DispatchQueue.global(qos: .utility).async {
                let v = try? URL(fileURLWithPath: "/").resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
                let gb = Double(v?.volumeAvailableCapacityForImportantUsage ?? 0) / 1_000_000_000
                DispatchQueue.main.async { disk = (Date(), gb); diskBusy = false }
            }
        }
        return disk?.gb ?? .nan
    }
}

/// Busy ring: a gradient arc, faint tail to solid head, that turns while its length breathes,
/// so the head runs ahead and the tail catches up.
struct ChaseRing: View {
    var t: Double
    var body: some View {
        let p = t.truncatingRemainder(dividingBy: 1.3) / 1.3
        let len = 0.18 + 0.55 * (0.5 - 0.5 * cos(2 * .pi * p))
        Circle().trim(from: 0, to: len)
            .stroke(AngularGradient(stops: [.init(color: Theme.accent.opacity(0), location: 0), .init(color: Theme.accent, location: len)],
                                    center: .center),
                    style: StrokeStyle(lineWidth: 2, lineCap: .round))
            .rotationEffect(.degrees(t * 320 - 360 * len))
    }
}

/// Refresh: a key the size of a lamp, under the three lamps. The arrow turns (SF Symbols rotate) while usage and sessions are read again.
struct RefreshButton: View {
    var spinning: Bool
    var action: () -> Void
    @State private var hover = false
    var body: some View {
        Button(action: action) {
            Group {
                if spinning { BootClock { t in ChaseRing(t: t) }.frame(width: 11, height: 11) }
                else { Image(systemName: "arrow.clockwise").font(.system(size: 10, weight: .bold)).foregroundStyle(hover ? Theme.accent : Theme.textDim) }
            }
                .frame(width: 40, height: 17)
                .background(RoundedRectangle(cornerRadius: 3).fill(hover && !spinning ? Theme.accent.opacity(0.12) : Theme.ink.opacity(0.05)))
                .overlay(RoundedRectangle(cornerRadius: 3).stroke(hover && !spinning ? Theme.accent.opacity(0.5) : Theme.line, lineWidth: 1))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(spinning)
        .onHover { hover = $0 }
        .animation(.easeOut(duration: 0.15), value: hover)
    }
}
