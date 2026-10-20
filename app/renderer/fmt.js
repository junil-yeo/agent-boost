// Display formatting shared by the views, ported from Format.swift (enum Fmt) and the display helpers of Models.swift,
// BoardStore.overlayName, UsageBanner's HostMemory text and TurnStatus.swift's Spinner frames.
// Names follow the Swift ones so the two versions can be read side by side. Dates are epoch milliseconds (as the store
// snapshot carries them) or Date objects; null/undefined gives "".
import { L } from './lib.js';

const ms = (d) => (d == null ? null : d instanceof Date ? d.getTime() : Number(d));
const pad2 = (n) => String(n).padStart(2, '0');

/** String(format: "%.1f", v) as Swift/C printf gives it. printf rounds the exact binary value and breaks an exact tie
 *  to even (1.25 → "1.2"); toFixed breaks it upward ("1.3"). A double is an exact tie at one decimal only when v·4 is
 *  an odd integer (x.25 / x.75), so only those are corrected. */
function fixed1(v) {
  const q = v * 4;                       // exact (power of two)
  if (Number.isInteger(q) && q % 2 !== 0) {
    const lo = Math.floor(v * 10);       // exact for the magnitudes shown here
    return ((lo % 2 === 0 ? lo : lo + 1) / 10).toFixed(1);
  }
  return v.toFixed(1);
}

export const Fmt = {
  /** 1234567 → "1.2M", 12345 → "12k", 1234 → "1.2k", 999 → "999". */
  tokens(n) {
    n = Math.trunc(Number(n) || 0);
    if (n >= 1_000_000) return `${fixed1(n / 1e6)}M`;
    if (n >= 10_000) return `${Math.trunc(n / 1000)}k`;
    if (n >= 1_000) return `${fixed1(n / 1e3)}k`;
    return `${n}`;
  },
  /** "방금" / "%@분 전" / "%@시간 전" / "%@일 전". */
  ago(d) {
    const t = ms(d);
    if (t == null || Number.isNaN(t)) return '';
    const s = Math.trunc((Date.now() - t) / 1000);
    if (s < 60) return L('방금');
    if (s < 3600) return L('%@분 전', String(Math.trunc(s / 60)));
    if (s < 86400) return L('%@시간 전', String(Math.trunc(s / 3600)));
    return L('%@일 전', String(Math.trunc(s / 86400)));
  },
  /** 24-hour "HH:mm" in local time. */
  time(d) {
    const t = ms(d);
    if (t == null || Number.isNaN(t)) return '';
    const x = new Date(t);
    return `${pad2(x.getHours())}:${pad2(x.getMinutes())}`;
  },
  /** AgentState raw value ('busy' | 'idle' | 'ended' | 'unknown' | 'needsInput') → label. */
  stateLabel(s) {
    switch (s) {
      case 'busy': return L('작업 중');
      case 'idle': return L('대기');
      case 'ended': return L('종료됨');
      case 'needsInput': return L('응답 필요');
      default: return L('알 수 없음');
    }
  },
  /** AgentState → CSS colour (busy = running green, idle = standby cyan, needsInput = amber). */
  stateColor(s) {
    switch (s) {
      case 'busy': return 'var(--normal)';
      case 'idle': return 'var(--busy)';
      case 'ended': return 'var(--secondary)';
      case 'needsInput': return 'var(--attention)';
      default: return 'var(--sys-gray)';
    }
  },
};

/** ModelChoice: raw value and menu label, in Swift's order (allCases). */
export const ModelChoice = [
  { raw: 'claude-fable-5-1', label: 'Fable 5.1' },
  { raw: 'claude-opus-5-5', label: 'Opus 5.5' },
  { raw: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { raw: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  { raw: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];
/** EffortChoice raw values (allCases). */
export const EffortChoice = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Display helpers of `struct Agent` (Models.swift). The snapshot already carries the computed values; these are for
 *  views that build text from raw fields (e.g. an ArchivedItem's model) or need the same rule locally. */
export const Agent = {
  /** "claude-opus-5-5" → "Opus 5.5"; "claude-sonnet-4-5-20250929" → "Sonnet 4.5"; anything else unchanged. */
  pretty(m) {
    const parts = String(m).split('-').filter((p) => p !== '');
    if (parts.length < 3 || parts[0] !== 'claude') return m;
    const fam = parts[1].charAt(0).toUpperCase() + parts[1].slice(1);
    let ver = parts[2];
    if (parts.length > 3 && parts[3].length <= 2) ver += '.' + parts[3];
    return `${fam} ${ver}`;
  },
  /** "모델 미확인" when unknown, " ?" after a model taken from the launch flag. */
  displayModel(a) {
    if (!a || !a.model) return L('모델 미확인');
    return a.modelIsGuess ? Agent.pretty(a.model) + ' ?' : Agent.pretty(a.model);
  },
  /** Any shown value that is a guess / stale (launch-flag model, cached tokens): render it dimmed. */
  isEstimated(a) { return !!(a && (a.modelIsGuess || a.tokensEstimated)); },
  /** Running a turn or stuck on a prompt: nothing may be typed into it. */
  working(a) { return !!a && (a.state === 'busy' || a.state === 'needsInput'); },
  canReceiveInput(a) { return !!a && a.tmuxPane != null && a.state !== 'ended' && a.overlay == null; },
  /** Context window of the model: 1M for "[1m]" variants, 200k otherwise. */
  contextWindow(model) { const m = model || ''; return m.includes('[1m]') || m.endsWith('-1m') ? 1_000_000 : 200_000; },
  /** Permission mode the CLI footer shows ("기본 모드" when the footer says nothing). Takes agent.screen?.mode. */
  modeLabel(mode) {
    switch (mode) {
      case 'auto mode': return L('자동 모드');
      case 'accept edits': return L('편집 자동 허용');
      case 'plan mode': return L('계획 모드');
      case 'bypass permissions': return L('권한 확인 없음');
      case null: case undefined: return L('기본 모드');
      default: return mode;
    }
  },
};

/** Teammate names: Claude's Agent tool only accepts ASCII letters, digits, '_' and '-' (Korean names are rejected). */
export function teammateNameIsValid(name) { return !!name && /^[A-Za-z0-9_-]+$/.test(name); }

/** BoardStore.overlayName: the CLI screen that covers the conversation ("agents" list, "resume" picker). */
export function overlayName(o) { return o === 'agents' ? L('세션 목록(← agents)') : o === 'resume' ? L('대화 선택(/resume)') : o; }

/** The banner's free-memory lines (UsageBanner.swift). Values come from the main process (GB; NaN = not read yet). */
export const HostMemory = {
  ramText(gb) { return `RAM ${(Number(gb) || 0).toFixed(1)}GB`; },
  diskText(gb) { return gb == null || Number.isNaN(Number(gb)) ? L('디스크 …') : L('디스크 %@GB', Number(gb).toFixed(1)); },
};

/** The CLI's spinner glyphs, in its order (· ✢ ✳ ✶ ✻ ✽ and back), 8 frames a second. */
export const Spinner = {
  frames: ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'],
  frame(at = Date.now()) { return Spinner.frames[Math.floor((ms(at) / 1000) * 8) % Spinner.frames.length]; },
  tint: 'var(--spinner)',
  verbTint: 'var(--spinner-verb)',
};
