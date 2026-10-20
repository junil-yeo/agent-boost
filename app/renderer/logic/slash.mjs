// Pure logic of the "/" palette (port of SlashPalette.swift without the views): the built-in catalog, filtering, the
// palette's key handling, and SlashRouter's matching. No Node or DOM APIs: the renderer imports it as an ES module and
// main/slash.js loads the very same file (one source for both sides).
// The texts go through L(), which each side installs with setL() (renderer: lib.js's L, main: l10n.js's L).

let tr = (k, ...args) => { let i = 0; return k.replace(/%@/g, (m) => (i < args.length ? String(args[i++]) : m)); };
/** Installs the translation function used by the catalog's descriptions. */
export function setL(fn) { tr = fn; }

/** Models the app offers (ModelChoice in Models.swift): raw value and display label. */
export const MODEL_CHOICES = [
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];
/** EffortChoice raw values. */
export const EFFORT_CHOICES = ['low', 'medium', 'high', 'xhigh', 'max'];

/** One entry of the "/" palette (SlashCommand). source: builtin | user | project | skill. */
export function command(name, desc, o = {}) {
  const source = o.source || 'builtin';
  return {
    name,                                   // without the leading "/"
    desc,
    argHint: o.argHint ?? null,             // e.g. "<모델>"
    needsArg: !!o.needsArg,                 // Tab/Enter fills "/name " instead of sending
    terminalOnly: !!o.terminalOnly,         // opens a TUI menu: the terminal panel is shown after sending
    source,
    id: source + ':' + name,
    text: '/' + name,
  };
}

/** The CLI's built-in commands. A function: the descriptions follow the chosen language. */
export function builtin() {
  const L = tr;
  return [
    command('help', L('도움말과 사용 가능한 명령 보기'), { terminalOnly: true }),
    command('clear', L('대화 기록을 비우고 새로 시작')),
    command('compact', L('대화를 요약해 컨텍스트 확보'), { argHint: L('[요약 지침]') }),
    command('model', L('모델 변경'), { argHint: L('<모델>'), needsArg: true }),
    command('effort', L('추론 effort 변경'), { argHint: '<low|medium|high|xhigh|max>', needsArg: true }),
    command('rename', L('세션 이름 변경'), { argHint: L('<이름>'), needsArg: true }),
    command('resume', L('이전 대화 이어서 하기'), { terminalOnly: true }),
    command('cost', L('토큰 사용량과 비용 확인')),
    command('context', L('컨텍스트 사용 현황 보기')),
    command('usage', L('플랜 사용량 한도 보기')),
    command('status', L('버전·모델·계정 상태 보기'), { terminalOnly: true }),
    command('config', L('설정 열기'), { terminalOnly: true }),
    command('memory', L('CLAUDE.md 메모리 편집'), { terminalOnly: true }),
    command('init', L('프로젝트용 CLAUDE.md 생성')),
    command('review', L('풀 리퀘스트 리뷰'), { argHint: '[PR]' }),
    command('agents', L('서브에이전트 관리'), { terminalOnly: true }),
    command('mcp', L('MCP 서버 연결 관리'), { terminalOnly: true }),
    command('permissions', L('도구 권한 규칙 관리'), { terminalOnly: true }),
    command('hooks', L('훅 설정 보기'), { terminalOnly: true }),
    command('export', L('대화를 파일이나 클립보드로 내보내기'), { argHint: L('[파일명]'), terminalOnly: true }),
    command('add-dir', L('작업 폴더 추가'), { argHint: L('<경로>'), needsArg: true }),
    command('doctor', L('설치 상태 진단'), { terminalOnly: true }),
    command('release-notes', L('릴리스 노트 보기'), { terminalOnly: true }),
    command('todos', L('현재 할 일 목록 보기')),
    command('rewind', L('이전 시점으로 대화·코드 되돌리기'), { terminalOnly: true }),
    command('exit', L('세션 종료')),
  ];
}

/** True for a built-in command that opens a TUI menu (the terminal panel is shown after sending it). */
export function isTerminalOnly(text) {
  if (!text.startsWith('/')) return false;
  const n = text.slice(1).match(/^\S*/)[0];
  const c = builtin().find((x) => x.name === n);
  return c ? c.terminalOnly : false;
}

/** Loose subsequence match: every character of q appears in n in order ("cmp" → compact). */
function subsequence(q, n) {
  const a = Array.from(n);
  let k = 0;
  for (const ch of q) {
    while (k < a.length && a[k] !== ch) k++;
    if (k >= a.length) return false;
    k++;
  }
  return true;
}
function chars(s) { return Array.from(s).length; }

/** Prefix matches first, then substring, then loose subsequence ("cmp" → compact). */
export function filter(all, query) {
  const q = query.toLowerCase();
  if (!q) return all;
  const score = (c) => {
    const n = c.name.toLowerCase();
    if (n === q) return 0;
    if (n.startsWith(q)) return 1;
    if (n.includes(q)) return 2;
    if (chars(q) < 3) return c.desc.toLowerCase().includes(q) ? 4 : null;   // short queries: no loose matches
    if (subsequence(q, n)) return 3;
    if (c.desc.toLowerCase().includes(q)) return 4;
    return null;
  };
  const out = [];
  for (const c of all) { const s = score(c); if (s !== null) out.push([c, s]); }
  out.sort((a, b) => (a[1] !== b[1] ? a[1] - b[1] : (a[0].name < b[0].name ? -1 : a[0].name > b[0].name ? 1 : 0)));
  return out.map((x) => x[0]);
}

// ── SlashRouter: typed slash commands the app already implements itself ─────────────────

/** What SlashRouter.route would do with a typed command, without doing it:
 *  {action:'setModel', model} | {action:'setEffort', effort} | {action:'rename', name} | null (the CLI runs it). */
export function routeAction(text) {
  const t = text.replace(/^ +/, '');
  const sp = t.indexOf(' ');
  const head = sp < 0 ? t : t.slice(0, sp);
  if (!head.startsWith('/')) return null;
  const arg = sp < 0 ? '' : t.slice(sp + 1).trim();
  switch (head) {
    case '/model': {
      const a = arg.toLowerCase();
      const m = MODEL_CHOICES.find((c) => a && (c.id === a || c.label.toLowerCase() === a || c.id.includes(a.split(' ').join('-'))));
      return m ? { action: 'setModel', model: m.id } : null;
    }
    case '/effort': {
      const e = EFFORT_CHOICES.find((x) => x === arg.toLowerCase());
      return e ? { action: 'setEffort', effort: e } : null;
    }
    case '/rename':
      return arg ? { action: 'rename', name: arg } : null;
    default: return null;
  }
}

// ── SlashController: state and key handling of the palette (one per composer) ───────────

export class SlashController {
  constructor() {
    this.index = 0;
    this.navigated = false;     // the user picked a row with ↑↓
    this.dismissedFor = null;
    this.custom = [];           // custom commands and skills for the composer's folder (main: slash.load(cwd))
  }
  setCustom(items) { this.custom = items || []; }
  /** The typed command name, or null when the draft is not a command being typed. */
  query(draft) {
    if (!draft.startsWith('/')) return null;
    if (/[ \n/]/.test(draft.slice(1))) return null;   // a second "/" means a path
    return draft.slice(1);
  }
  items(draft) {
    const q = this.query(draft);
    if (q === null || this.dismissedFor === draft) return [];
    return filter(builtin().concat(this.custom), q);
  }
  dismiss(draft) { this.dismissedFor = draft; }
  clamp(n) { if (this.index >= n) this.index = Math.max(0, n - 1); }
  /** The draft changed (SlashPaletteView's onChange(of: draft)). */
  draftChanged() { this.index = 0; this.navigated = false; }
  /** Key handling. key: 'ArrowDown' | 'ArrowUp' | 'Escape' | 'Tab' | 'Enter'. Returns
   *  {consumed, draft, send}: `draft` is the new text (unchanged when not picked), `send` asks the composer to send it. */
  handle(key, shift, draft) {
    const list = this.items(draft);
    const no = { consumed: false, draft, send: false };
    if (!list.length) return no;
    const i = Math.min(this.index, list.length - 1);
    switch (key) {
      case 'ArrowDown': this.navigated = true; this.index = (i + 1) % list.length; return { consumed: true, draft, send: false };
      case 'ArrowUp': this.navigated = true; this.index = (i - 1 + list.length) % list.length; return { consumed: true, draft, send: false };
      case 'Escape': this.dismiss(draft); return { consumed: true, draft, send: false };
      case 'Tab': return { consumed: true, ...this.pick(list[i], false) };
      case 'Enter': {
        if (shift) return no;
        // only replace what was typed when the user chose a row or typed a real prefix; "/usr/local" stays as typed
        const q = (this.query(draft) || '').toLowerCase();
        if (this.navigated || list[i].name.toLowerCase().startsWith(q)) return { consumed: true, ...this.pick(list[i], true) };
        this.dismiss(draft);
        return no;
      }
      default: return no;
    }
  }
  /** Picking a row: {draft, send}. withSend: Enter / a click (sends commands without arguments at once). */
  pick(c, withSend) {
    this.index = 0; this.navigated = false;
    if (c.needsArg) return { draft: c.text + ' ', send: false };
    if (withSend) return { draft: c.text, send: true };
    return { draft: c.text + (c.argHint != null ? ' ' : ''), send: false };
  }
}
