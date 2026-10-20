# Agent Boost

Claude Code 에이전트 팀을 한 화면에서 보고 조작하는 macOS 네이티브 앱(SwiftUI).
tmux는 화면에 보이지 않는 실행 엔진으로만 쓰이며, 사용자는 이 앱만 다룹니다.

## Install / 설치

Paste one line into Terminal. It checks and installs everything the app needs (Command Line Tools, Homebrew, tmux,
Claude Code, GitHub CLI), signs you in to Claude, builds the app for your Mac, puts it in Applications and opens it.
Run it again to update.

터미널에 한 줄을 붙여 넣으면 필요한 도구 확인·설치, Claude 로그인, 빌드, 응용 프로그램 폴더 설치와 실행까지 한 번에 진행합니다.
다시 실행하면 최신 버전으로 업데이트됩니다.

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/junil-yeo/agent_bridge/main/install.sh)"
```

Languages: English, 한국어, 日本語, 简体中文, Español (chosen at first launch; change any time from the menu above the clock).

## 실행 / 빌드

- 실행: `AgentBoost.app` 더블클릭
- 빌드: `./build.sh` (개발용, 빠름) / `./build.sh release` (최적화, 이 Mac용) / `./build.sh dist` (최적화, 배포용)
- 필요: macOS 15+, `tmux`, `claude` CLI. 직접 빌드할 때만 Command Line Tools(Swift)
- 앱이 찾는 위치: `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `/opt/local/bin`, 그리고 로그인 셸의 PATH. 다른 곳에 있으면 환경 변수 `BOARD_TMUX`, `BOARD_CLAUDE`로 경로를 알려 줍니다.
- `./build.sh dist`는 Intel·Apple Silicon 공용(universal) 바이너리를 만듭니다(두 종류를 동시에 컴파일). `./build.sh`와 `./build.sh release`는 빌드하는 Mac의 종류로만 만듭니다.

### 다른 Mac에서 처음 실행할 때

1. **Gatekeeper**: 다운로드한 앱은 개발자 서명이 없어 "확인할 수 없는 개발자" 또는 "손상되었다"는 안내와 함께 열리지 않습니다. 터미널에서 `xattr -d com.apple.quarantine /path/to/AgentBoost.app`을 실행하거나, Finder에서 우클릭 > 열기를 한 번 하면 그 뒤로는 그냥 열립니다.
2. **tmux**: 없으면 앱 상단 알림에 설치 방법이 뜹니다 (`brew install tmux`). 세션 시작·입력·종료가 모두 tmux를 거치므로 필수입니다.
3. **Claude Code 로그인**: 설치만 하고 로그인하지 않았으면 사용량 계기판이 `OFF`로 표시되고 "로그인 필요" 알림이 뜹니다. 터미널에서 `claude`를 한 번 실행해 글자 스타일 선택과 로그인을 마치면 됩니다. 앱에서 새 세션을 먼저 만들었다면 그 카드에 "터미널에서 설정 마치기" 버튼이 나타나며, 거기서 마쳐도 됩니다.
4. **폴더 접근 권한**: 바탕 화면·문서 폴더 안의 프로젝트를 처음 읽을 때 macOS가 접근 허용을 묻습니다. 허용하지 않으면 그 폴더의 세션 기록을 읽지 못합니다.
5. 세션이 하나도 없으면 조직도가 비어 있고, 오른쪽 위 "새 세션"(⌘N)으로 시작합니다.
- 앱 데이터: `~/.agent-boost/` (팀 기억, 작업 이름, 보관함). 세션 목록 자체는 기억하지 않고 CLI 파일을 읽습니다. Claude 자체 데이터는
  이름 저장(custom-title)과 삭제(휴지통 이동), `claude stop/rm` 외에는 쓰지 않습니다.

## 화면

| 탭 | 내용 |
|---|---|
| 조직도 | 모든 팀·세션 카드. 팀장 → 팀원 구조, 모델·effort·토큰·상태, 종료된 팀도 표시 |
| 개별 세션 | 팀원이 없는 세션(실행 중 / 종료됨). 종료된 세션은 다시 시작 가능 |
| 팀 탭 | 살아 있는 팀만 탭으로. 팀원 목록 + 말풍선 대화창 + 입력 |
| 상단 배너 | 현재 세션 / 주간 전체 / 주간 Fable 사용량(녹색)과 시간 경과(파란색, 점선 눈금) |

## 할 수 있는 것

- **새 세션** (⌘N): 이름, 폴더, 모델, effort, 팀원 구성, 첫 작업. 첫 작업을 비우면 토큰을 쓰지 않고 대기. 기본값은 팀장 Opus 5.5 · low, 팀원 Sonnet 5.5 · low
- **팀원 추가**: 팀장에게 생성 지시 → 앱이 2분간 실제 생성·모델·effort를 검증해 결과 표시
- **메시지 보내기**, **중단**(Esc), **이름 변경**(/rename), **모델·effort 변경**(/model, /effort — 작업 중이면 대기 후 전송)
- **종료**: `/exit` 직접 입력. 작업 중이면 "지금 종료 / 작업 끝나면 종료" 선택. 30초 안에 안 끝나면 SIGTERM
- **삭제**: 실행 중이면 종료 후, 대화 기록을 휴지통으로 이동 (복원 가능). 백그라운드 작업은 `claude stop` + `claude rm`
- **다시 시작**: 종료된 세션을 `claude --resume`으로 같은 ID로 이어서 열기 (모델·effort 선택, 복사본은 선택 사항)
- Dock 배지 = 작업 중인 세션 수

## 이름 두 가지

| | 세션 이름(별칭) | 팀 주소 |
|---|---|---|
| 예 | `논문 그림 리뷰` | `teammate1@session-9b510d0d` |
| 누가 정하나 | 사용자 (`-n`, `/rename`) | Claude가 팀원 생성 시 부여 |
| 바꿀 수 있나 | 언제든 (앱의 연필 아이콘) | 못 바꿈 (팀원을 새로 만들어야 함) |
| 제한 | 한글 가능 | 팀원 이름은 영문·숫자·`_`·`-` 만 (Claude Agent 도구 제한) |

새 세션에서 입력하는 이름은 **별칭**입니다. 팀원 이름은 별칭이자 주소의 앞부분이 되므로 영문만 됩니다(앱이 검사합니다).

## 대화창 (CLI와 같은 입력 경험)

- **작업 표시줄**: 작업 중이면 대화 아래에 CLI와 같은 글리프(`· ✢ ✳ ✶ ✻ ✽`)가 돌며 CLI가 실제로 띄우는 동사·경과 시간·토큰 수(`Mustering… (2m 30s · ↓ 9.8k tokens)`)와 지금 돌리는 도구를 보여 줍니다. `esc 중단` 버튼 또는 Esc 키로 중단. 질문이 뜨면 손 모양, 끝나면 `✻ 지난 작업 2m 47s · 2:16 AM 완료`가 흐리게 남습니다. 멤버 목록의 상태 칩에도 같은 동사·경과가 보입니다.
- **Tab 자동완성(회색 제안)**: 1순위는 CLI가 직접 만든 "다음 입력 예측"입니다. CLI는 턴이 끝나면 입력줄에 흐린 글씨로 예측 문장을 그리는데, 앱이 이를 읽어 같은 문장을 보여 줍니다. 이 기능은 CLI 기본값이 꺼져 있어, 앱이 시작하는 세션에만 `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=1`을 붙입니다(팀원에게는 붙지 않음, 메뉴 "보기 > CLI 다음 입력 제안 켜기"로 끌 수 있음). CLI 제안이 없을 때는 앱 규칙으로 대신합니다. 빈 입력창에는 대화 흐름으로 짐작한 다음 입력(에이전트가 "할까요?"로 끝내면 "네, 그렇게 진행해 주세요", 번호 선택지면 "1번으로…", 도구 오류면 "오류 원인을 찾아 고쳐 주세요")이, 타자 중에는 `~/.claude/history.jsonl`의 이전 입력 중 같은 글자로 시작하는 가장 최근 것이 회색으로 이어집니다. Tab으로 채웁니다.
- **↑/↓ 입력 이력**: 입력창이 비어 있을 때 ↑로 이전 입력(이 세션 → 같은 폴더 → 전체 순)을 불러오고 ↓로 돌아옵니다. Esc로 취소.
- **`@` 파일 멘션**: `@`를 치면 작업 폴더의 파일 목록(퍼지 검색)이 뜨고 Tab/Enter로 `@경로`를 넣습니다. Claude Code가 전송 시 그 파일을 읽습니다.
- **Shift+Tab 권한 모드 순환**, 하단 `⏵⏵ 자동 모드` 칩 클릭도 같습니다. CLI 하단 줄에서 읽은 모드가 표시됩니다.
- **하단 상태줄**: 권한 모드 · 컨텍스트 사용량(마지막 요청의 입력+캐시 토큰 / 200k, 1M 모델은 1M) · CLI가 세는 에이전트 수 · 대기 중인 명령 · Tab 제안 · `? 단축키` 목록.
- 작업 중에 보낸 메시지는 CLI가 대기열에 넣고 차례로 처리합니다. 작업 표시줄에 `대기열 N`으로 보입니다.

## 터미널과 셸 명령

- **터미널**: 세션 세부 화면의 "터미널" 버튼은 그 세션의 tmux 세션을 Terminal 창으로 엽니다. 창을 닫아도 세션은 계속 돌고, 양쪽 입력이 서로 반영됩니다.
- **`!명령`**: 입력창에서 `!`로 시작하면 Claude Code의 셸 모드로 전달되어 에이전트의 작업 폴더에서 실행됩니다(예: `!ls`, `!git status`). 실행은 Claude Code가 하며 그 권한 설정을 따릅니다. 출력이 에이전트에게도 보이므로 짧은 모델 턴이 한 번 돌 수 있습니다.

## CLI와 같이 써도 어긋나지 않게 (세션 목록은 CLI의 것)

이 앱은 세션 목록을 따로 갖지 않습니다. 매 2초 CLI의 파일만 읽어 그립니다.

| 앱이 보여주는 것 | 출처 (CLI 파일) |
|---|---|
| 실행 중인 세션 | `~/.claude/sessions/<pid>.json` (`claude agents`가 보는 것과 같음) |
| 백그라운드 작업 | `~/.claude/jobs/<id>/state.json` (`claude agents --all`) |
| 종료된 대화 | `~/.claude/projects/*/<id>.jsonl` 전부 (`/resume` 선택창에 뜨는 것과 같음) |
| 팀 | `~/.claude/teams`, 그리고 팀장이 끝나 폴더가 지워진 팀은 앱 기억(`seen-members.json`) |

터미널에서 띄운 세션은 그대로 나타나고, 터미널에서 지운 대화는 카드가 사라집니다. 보관함은 화면에서 숨길 뿐 파일을 건드리지 않습니다.

**CLI의 `← for agents` 화면 (세션 목록).** Claude Code 2.1.301은 이 화면에 들어가는 순간 대화를 **백그라운드 작업(job)으로 옮기고 새 세션 ID를 줍니다**. 터미널에 보이는 프로세스는 그때부터 보기용(viewer)이 되고, `claude agents`는 작업만 보여 줍니다. 이미 메시지가 있던 대화는 원본 기록이 그대로 남고 작업 쪽에 복사본이 생깁니다 (CLI가 만드는 분기이며, 앱은 만들지 않습니다). 앱은 다음처럼 따라갑니다.
- 카드는 **작업 하나**입니다. viewer의 화면(tmux pane)과 이름을 빌려 씁니다. viewer가 살아 있는 동안 원본 기록은 따로 그리지 않습니다 (`claude agents`도 viewer를 세지 않음).
- 그 화면이 세션 목록이나 `/resume` 선택창인 동안은 **입력하지 않습니다** (보냈다면 새 세션을 만드는 칸에 들어감). 입력창에 그 이유가 보이고, 대기시킨 `/model` 같은 명령은 CLI에서 Esc로 대화로 돌아온 뒤에 보냅니다.
- 종료는 viewer를 닫고(ctrl+c 두 번, 안 되면 SIGTERM) `claude stop <작업>`. 삭제는 `claude stop` + `claude rm` + 기록을 휴지통으로.
- 다시 시작은 CLI 방식대로 `claude --bg --resume <id>`(같은 ID) 뒤 `claude attach`로 화면을 붙입니다. (`claude --resume`은 작업 대화를 "No deferred tool marker…"로 거부합니다. 멈춘 작업 기록이 남아 있으면 CLI가 복사본을 만들기 때문에 먼저 `claude rm`을 합니다.)
- 실행 중인 대화는 절대 두 번 띄우지 않습니다. 다른 프로그램(데스크톱 앱 등)이 만든 대화도 같은 ID로 이어가며, 복사본(`--fork-session`)은 다시 시작 창에서 직접 켤 때만 만듭니다.

**터미널에서 같은 세션에 타자 중이면** 앱은 보내지 않고 알립니다 (입력창에 글이 있는 동안 명령 대기).

**앱 종료.** "세션까지 종료"를 고르면 끄기 전에 알립니다. 응답을 기다리는 세션(질문 내용 포함, 종료하면 Esc로 취소됨), 작업 중인 세션, CLI가 목록 화면인 세션. "앱만 종료"도 응답 대기 세션이 있으면 먼저 알립니다. /exit에 30초 안에 답하지 않아 강제 종료한 세션은 종료 직전에 한 번 더 알립니다.

## 알아둘 점

- `/model`, `/effort`는 Claude가 **전체 기본값**도 바꾸므로, 앱이 `settings.json`을 변경 전후로 되돌립니다(바이트 동일 검증됨).
- 팀장을 종료하면 Claude가 **팀원도 함께 종료**하고 팀 폴더를 지웁니다. 앱은 자체 기억으로 종료된 팀을 계속 보여 줍니다.
- 종료된 **팀원**을 다시 시작하면 팀과 분리된 개별 세션으로 열립니다.
- 데스크톱 앱이나 일반 터미널에서 띄운 세션은 **보기만** 됩니다(입력·변경 불가). 종료는 SIGTERM으로 실제 종료되며 확인 창에 경고가 뜹니다.
- 작은 모델(Haiku)은 팀 규약을 자주 틀립니다. 팀장은 Sonnet 이상을 권장합니다.
- `haiku` 별칭은 이 CLI 버전에서 Haiku 5.5로 해석됩니다.

## 테스트

`AgentBoost --snapshot DIR [--selftest] [--selftest-live] [--selftest-team] [--selftest-sync]`
`--selftest-sync`: 터미널에서 띄운 세션이 보이는지, CLI의 `← agents` 화면에서 카드가 하나로 합쳐지고 입력이 거부되는지, Esc 뒤 대기 명령이 나가는지, 종료가 `claude stop`으로 끝나고 목록이 깨끗한지, 다시 시작이 `--bg --resume` + `attach`로 같은 ID를 잇는지, 삭제가 CLI 목록까지 지우는지 (Haiku, 한 단어 답 1회).
`AgentBoost --selftest-detect`: 화면 인식(작업 중/응답 필요/목록 화면) 고정 샘플 검사.
`AgentBoost --snapshot DIR --tab __loose --agent <세션ID> --bench-typing [--bench-long]`: 입력창에 키를 흉내 내 키당 처리 시간(중간값·상위 10%·최대, CPU 시간)을 잽니다. 목표는 키당 16ms(한 프레임) 이하입니다.
창을 PNG로 저장하고 `report.json`을 남깁니다. `--selftest-live/team`은 실제 Claude 세션을 만들어
(Haiku, 작업 없음 → 토큰 거의 0) 생성·변경·종료·재시작을 검증한 뒤 정리합니다.
