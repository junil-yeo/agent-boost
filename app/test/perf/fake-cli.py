#!/usr/bin/env python3
# A stand-in for a busy Claude CLI screen (perf runs only): coloured output, Korean text, file paths and box-drawing
# tables, a new line every 300 ms. Runs inside a throwaway abtest-* tmux pane (abtest-pane.sh), never a real session.
import sys, time, itertools
C = ['\033[38;5;75m', '\033[38;5;114m', '\033[38;5;180m', '\033[1;37m', '\033[38;5;245m', '\033[48;5;236m\033[38;5;252m']
R = '\033[0m'
L = [
  '● Read(app/main/store.js) — 2548 lines',
  '  ⎿  Found 12 matches in /Users/Junil/Desktop/agent-boost/app/renderer/ui/teamdetail.js',
  '│ 항목            │ 크기    │ 판단        │',
  '├─────────────────┼─────────┼─────────────┤',
  '│ ~/Library/Caches │ 4.2 GB  │ 안전        │',
  '● 테스트를 실행하고 결과를 요약합니다. The refresh loop reads tmux every two seconds.',
  '> 사용자 메시지: 스토어 모듈의 실패하는 테스트를 확인해 주세요',
  '  ⎿  PASS test/store-prefs.test.js (0.4 s)',
]
for i in itertools.count():
    line = L[i % len(L)]
    print(f'{C[i % len(C)]}{i:5d} {line}{R}', flush=True)
    time.sleep(0.3)
