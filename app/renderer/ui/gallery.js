// #gallery: every shared widget, token and icon on one page, so the look can be checked in a snapshot:
//   AB_SNAPSHOT_JS="localStorage.setItem('ui.appearance','light'); location.hash='#gallery'"
// window.__ab exposes showMenu / confirm / prompt for snapshot scripts that want a menu or dialog open.
import { html, useState, useRef, L } from '../lib.js';
import {
  Icon, Label, Button, TabButton, Chip, CountBadge, StateDot, Avatar, ProgressSpinner, BootClock, ChaseRing,
  SpinnerGlyph, SpinnerLine, BoostLogo, MenuPanel, LazyMenu, Menu, Picker, Segmented, Checkbox, Switch, FormRow,
  Sheet, confirm, prompt, Popover, EmptyState, showMenu, useAppearance, AppearanceMode,
} from './widgets.js';
import { iconNames } from './icons.js';
import { Fmt, Agent, overlayName, HostMemory, ModelChoice, EffortChoice } from '../fmt.js';

window.__ab = { showMenu, confirm, prompt };

const TOKENS = ['base', 'area', 'bezel', 'line', 'line-hi', 'surface1', 'surface2', 'surface3', 'text-dim', 'ink', 'accent',
  'attention', 'error', 'busy', 'normal', 'bug', 'model-tint', 'effort-tint', 'accent-hover', 'accent-down', 'spinner',
  'spinner-verb', 'rc-on', 'fg', 'secondary', 'tertiary'];

const sampleMenu = [
  { header: L('앱 안에서 (탭으로 추가)') },
  { item: L('새 터미널 — 이 세션 폴더에서 깨끗한 셸'), action: () => {} },
  { item: L('세션 터미널 — 이 세션의 실제 CLI 화면'), enabled: false, action: () => {} },
  { separator: true },
  { item: 'Opus 5.5 ✓', action: () => {} },
];

export function Gallery() {
  const [mode, setMode, dark] = useAppearance();
  const [sheet, setSheet] = useState(false);
  const [pop, setPop] = useState(false);
  const [model, setModel] = useState('claude-opus-5-5');
  const [seg, setSeg] = useState(false);
  const [chk, setChk] = useState(true);
  const [sw, setSw] = useState(true);
  const popRef = useRef(null);
  const now = Date.now();
  return html`<div class="gallery">
    <section class="area-box">
      <h3>Appearance · BoostLogo</h3>
      <div class="row">
        <${BoostLogo} size=${16} /><${BoostLogo} size=${34} /><${BoostLogo} size=${64} />
        <div class="vstack" style=${{ gap: '0' }}><span class="t-rounded" style=${{ fontSize: '18px', fontWeight: 700, lineHeight: '19px' }}>Agent</span><span class="t-rounded accent" style=${{ fontSize: '18px', fontWeight: 700, lineHeight: '19px' }}>Boost</span></div>
        <${Segmented} value=${mode} onChange=${setMode} options=${AppearanceMode.all.map((m) => ({ value: m, label: AppearanceMode.title(m) }))} />
        <${Button} kind="quiet" onClick=${() => setMode(dark ? 'light' : 'dark')}><${Icon} name=${dark ? 'sun.max' : 'moon'} /><//>
        <span class="fg-dim t-callout">mode=${mode} dark=${String(dark)}</span>
      </div>
    </section>

    <section class="area-box">
      <h3>Colour tokens</h3>
      <div class="row">${TOKENS.map((t) => html`<div class="swatch"><i style=${{ background: `var(--${t})` }}></i>--${t}</div>`)}</div>
    </section>

    <section class="area-box">
      <h3>Buttons</h3>
      <div class="row">
        <${Button} kind="raised">raised<//>
        <${Button} kind="raisedCompact"><${Label} icon="power" title=${L('깨우기 %@', '2')} /><//>
        <${Button} kind="raisedProminent">raisedProminent<//>
        <${Button} kind="raised" active=${true}>raised active<//>
        <${Button} kind="raisedCompact" disabled=${true}><${Label} icon="archivebox" title="disabled" /><//>
        <${Button} kind="raised" destructive=${true}>destructive<//>
        <${Button} kind="raised" prominent=${true} minHeight=${30}>minHeight 30<//>
      </div>
      <div class="row" style=${{ background: 'var(--area)' }}>
        <${TabButton} title=${L('조직도')} icon="rectangle.3.group" active=${true} />
        <${TabButton} title=${L('개별 세션')} icon="person" count=${3} />
        <${TabButton} title="team-alpha" icon="person.3" active=${true} count=${4} attention=${true} />
        <${TabButton} title="team-beta" icon="person.3" count=${2} attention=${true} />
        <${TabButton} title=${L('보관함')} icon="archivebox" count=${7} quiet=${true} />
        <${Button} kind="quiet"><${Label} icon="arrow.down.circle" title=${L('업데이트')} /><//>
        <${Button} kind="quiet" active=${true}><${Label} icon="moon.zzz" title="quiet active" /><//>
        <${Button} kind="tab" strong=${true}><${Label} icon="plus" title=${L('새 세션')} /><//>
        <${Button} kind="tab" raised=${true} small=${true}>GitHub Page <${Icon} name="arrow.up.right" size=${8} /><//>
      </div>
      <div class="row">
        ${['power', 'pencil', 'archivebox', 'xmark', 'trash', 'paperclip'].map((n) => html`<${Button} kind="icon" help=${n}><${Icon} name=${n} /><//>`)}
        <${Button} kind="icon" disabled=${true}><${Icon} name="paperclip" /><//>
        <${Button} kind="icon"><${Label} icon="person.badge.plus" title=${L('팀원 추가…')} iconColor="var(--accent)" style=${{ color: 'var(--accent)' }} /><//>
        <${Button} kind="key"><${Icon} name="arrow.clockwise" size=${10} strokeWidth=${3} /><//>
        <${Button} kind="key" disabled=${true}><${ChaseRing} size=${11} /><//>
        <div class="hstack" style=${{ height: '34px', border: '1px solid var(--line)' }}>
          <${Button} kind="editorTab" active=${true}>zsh<//><${Button} kind="editorTab">CLI<//>
        </div>
      </div>
    </section>

    <section class="area-box">
      <h3>Chips · badges · dots · avatars</h3>
      <div class="row">
        <${Chip} text="Opus 5.5" tint="var(--model-tint)" /><${Chip} text="high" tint="var(--effort-tint)" />
        <${Chip} text=${L('자동 모드')} /><${Chip} text="neutral" tint="white" /><${Chip} text=${'CLI: ' + overlayName('agents')} tint="var(--sys-orange)" />
        <${Chip} class="rc on" icon="antenna.radiowaves.left.and.right" text=${L('RC 켜짐')} tint="var(--rc-on)" />
        <${Chip} class="rc" icon="antenna.radiowaves.left.and.right.slash" text=${L('RC 꺼짐')} />
        <${CountBadge} count=${3} /><${CountBadge} count=${12} tint="var(--surface2)" fg="var(--fg)" />
        ${['busy', 'idle', 'needsInput', 'ended', 'unknown'].map((s) => html`<span class="hstack" style=${{ gap: '2px' }}><${StateDot} state=${s} /><span class="t-callout">${Fmt.stateLabel(s)}</span></span>`)}
        <${Avatar} label="lead" /><${Avatar} label="verifier" tint="var(--busy)" /><${Avatar} label="ö" tint="var(--sys-purple)" />
      </div>
    </section>

    <section class="area-box">
      <h3>Spinners · clocks</h3>
      <div class="row">
        <${ProgressSpinner} /><${ProgressSpinner} large=${true} /><${ChaseRing} /><${ChaseRing} size=${24} /><${SpinnerGlyph} />
        <${BootClock}>${(t) => html`<span class="t-mono t-digits fg-busy">sweep ${BootClock.sweep(t).toFixed(2)}</span>`}<//>
      </div>
      <div class="row" style=${{ display: 'block' }}>
        <${SpinnerLine} verb="Pondering" details="(2m 30s · ↓ 9.8k tokens · 생각 중)">
          <${Button} kind="raisedCompact"><${Label} icon="arrow.uturn.down" title=${L('꺼내기')} class="t-caption" /><//>
          <${Button} kind="raisedCompact"><${Label} icon="paperplane.fill" title=${L('지금 보내기')} class="t-caption" /><//>
        <//>
      </div>
    </section>

    <section class="area-box">
      <h3>Menus · dialogs · popover</h3>
      <div class="row" style=${{ alignItems: 'flex-start' }}>
        <${MenuPanel} inline=${true} entries=${sampleMenu} />
        <${MenuPanel} inline=${true} entries=${ModelChoice.map((m) => ({ item: m.label, checked: m.raw === model }))} />
        <div class="vstack" style=${{ gap: '8px' }}>
          <${LazyMenu} kind="raisedCompact" entries=${() => sampleMenu}><${Label} icon="terminal" title="LazyMenu" /><//>
          <${Menu} kind="raisedCompact" entries=${sampleMenu} help=${L('터미널 탭 추가')}><${Icon} name="plus" /><//>
          <${Menu} borderless=${true} entries=${[{ item: 'English', checked: true }, { item: '한국어', checked: false }]}>
            <span class="label" style=${{ gap: '4px', fontSize: '11px', fontWeight: 500 }}><${Icon} name="globe" size=${11} />English</span>
          <//>
          <${Button} kind="raisedCompact" onClick=${() => confirm(L("'%@' 종료", 'demo'), L('작업 중입니다.'), [
            { label: L('지금 종료 (작업 중단)'), role: 'destructive', value: 'now' }, { label: L('작업 끝나면 종료'), value: 'whenIdle' }, { label: L('취소'), role: 'cancel' }])}>confirm()<//>
          <${Button} kind="raisedCompact" onClick=${() => prompt(L('이름 변경'), { value: 'demo' })}>prompt()<//>
          <${Button} kind="raisedCompact" onClick=${() => setSheet(true)}>Sheet<//>
          <span ref=${popRef} style=${{ display: 'inline-flex' }}><${Button} kind="icon" onClick=${() => setPop(!pop)}><${Icon} name="checklist" size=${16} /><//></span>
        </div>
        <div class="vstack" style=${{ gap: '8px', minWidth: '320px' }}>
          <div class="form-grouped">
            <${FormRow} label=${L('모델')}><${Picker} value=${model} onChange=${setModel} width=${140} options=${ModelChoice.map((m) => ({ value: m.raw, label: m.label }))} /><//>
            <${FormRow} label="effort"><${Picker} value="low" width=${100} options=${EffortChoice.map((e) => ({ value: e, label: e }))} /><//>
            <${FormRow} label=${L('팀원 구성 (이 세션이 팀장이 됨)')}><${Switch} checked=${sw} onChange=${setSw} /><//>
          </div>
          <${Segmented} value=${seg} onChange=${setSeg} options=${[{ value: false, label: L('이 Mac'), icon: 'desktopcomputer' }, { value: true, label: L('클라우드 (웹)'), icon: 'cloud' }]} />
          <div class="hstack" style=${{ gap: '12px' }}>
            <${Checkbox} checked=${chk} onChange=${setChk} label=${L('도구 펼침')} class="t-caption" />
            <${Checkbox} checked=${false} label=${L('생각')} class="t-caption" />
            <${Checkbox} checked=${true} disabled=${true} label="disabled" class="t-caption" />
          </div>
          <input class="textfield" placeholder=${L('비워 두면 지시를 기다립니다')} />
          <div class="card-surface" style=${{ padding: '8px 10px' }}>card-surface</div>
          <div class="card-surface selected" style=${{ padding: '8px 10px' }}>card-surface selected</div>
        </div>
        <div style=${{ width: '220px', height: '150px' }} class="card-surface">
          <${EmptyState} title=${L('표시할 세션이 없습니다')} icon="person.crop.rectangle" />
        </div>
      </div>
    </section>

    <section class="area-box">
      <h3>Fmt</h3>
      <div class="row t-mono t-callout" style=${{ gap: '18px' }}>
        <span>tokens: ${[999, 1234, 12345, 1234567].map(Fmt.tokens).join(' ')}</span>
        <span>ago: ${[now - 5e3, now - 5 * 60e3, now - 3 * 3600e3, now - 2 * 86400e3].map(Fmt.ago).join(' · ')}</span>
        <span>time: ${Fmt.time(now)}</span>
        <span>pretty: ${['claude-opus-5-5', 'claude-sonnet-4-5-20250929', 'claude-fable-5-1', 'gpt-x'].map(Agent.pretty).join(' · ')}</span>
        <span>${Agent.displayModel({ model: 'claude-haiku-4-5', modelIsGuess: true })} · ${Agent.displayModel({})}</span>
        <span>${HostMemory.ramText(12.345)} · ${HostMemory.diskText(NaN)} · ${HostMemory.diskText(201.44)}</span>
        <span>${Agent.modeLabel('plan mode')} · ${Agent.modeLabel(null)}</span>
      </div>
    </section>

    <section class="area-box">
      <h3>Icons (SF Symbol name → Lucide)</h3>
      <div class="row">${iconNames.map((n) => html`<div class="icon-cell"><${Icon} name=${n} />${n}</div>`)}</div>
    </section>

    ${sheet && html`<${Sheet} width=${520} onClose=${() => setSheet(false)}>
      <div class="vstack" style=${{ gap: '12px' }}>
        <span class="t-title3 t-bold">Sheet</span>
        <span class="fg-secondary">Esc closes it. Theme.background, padding 20.</span>
        <div class="hstack" style=${{ gap: '8px', justifyContent: 'flex-end' }}>
          <${Button} kind="raised" onClick=${() => setSheet(false)}>${L('취소')}<//>
          <${Button} kind="raisedProminent" onClick=${() => setSheet(false)}>${L('확인')}<//>
        </div>
      </div>
    <//>`}
    ${pop && html`<${Popover} anchor=${popRef} width=${260} onClose=${() => setPop(false)}><span class="t-callout">Popover anchored under its button.</span><//>`}
  </div>`;
}
