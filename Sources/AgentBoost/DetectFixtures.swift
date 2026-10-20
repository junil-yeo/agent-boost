// Real capture-pane dumps (Claude Code 2.1.296) used by `--selftest-detect`. Generated; do not edit by hand.
enum DetectFixtures {
    struct Fixture { var name: String; var text: String; var busy: Bool; var needsInput: Bool; var switchModel = false; var prompt: (title: String, options: Int, cursor: Int, numbered: Bool)? = nil; var overlay: String? = nil }
    static let all: [Fixture] = [
        // Claude Code 2.1.301: "← for agents" — the conversation is moved to a background job; the box here starts a NEW session
        Fixture(name: "agents-view-overlay", text: #"""
 ▐▛███▛█   Claude Code v2.1.301
▝▜██████▀  New sessions: Opus 5.5 · medium effort · /private/tmp/ab-sync-test
 ▝▝   ▝▝   0 awaiting input · 0 working · 1 completed
Your conversation moved to the background — enter opens it · esc returns to it · ctrl+c twice quits

Needs input
 Sessions that have a question or need your decision land here

Working
 Sessions Claude is actively working on — they keep running even if you close the terminal

Completed
 Finished sessions wait here for you to review
 ✻ current session  replied "ok" as requested                                                                                                                 1m

 A different way to work with Claude: hand off a bigger task than you would chat through, and Claude organizes it in the sections above so you know when it
 needs you.
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯ describe a task for a new session
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ auto mode · enter to return · space to reply · ctrl+x to delete · ? for shortcuts
"""#, busy: false, needsInput: false, overlay: "agents"),
        // Claude Code 2.1.301: the /resume picker
        Fixture(name: "resume-picker-overlay", text: #"""
⏺ ok

✻ Cogitated for 4s · done 12:21 PM

※ recap: The goal is still unclear: your only request was to reply "ok," which I did, and no task has been started in /private/tmp/ab-sync-test. The next action
  is yours: tell me what you want done there. (disable recaps in /config)
▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔
   Resume session
   ╭────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
   │ ⌕ Search…                                                                                                                                              │
   ╰────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
     ab-sync-test
    No conversations found in this project.
    Ctrl+A to show all projects

     Ctrl+A to show all projects · Ctrl+B to only show current branch · Type to search · Esc to cancel
"""#, busy: false, needsInput: false, overlay: "resume"),
        Fixture(name: "agent-list-under-footer", text: #"""
⏺ 팀원 세 명은 여전히 주간 한도로 멈춰 있습니다.

────────────────────────────────────────────────────────────
❯ 
────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle) · ← 3 agents
  ↑/↓ to select
❯ ⏺ main
  ◯ teammate1  Teammate1 ready and idle          14h 25m 28s
  ◯ teammate3  Teammate3 ready and idle          14h 25m 27s
  ◯ teammate2  Teammate2 ready and idle          14h 25m 27s
  ◯ general-purpose  Grepping sent2.txt for prompts   2m 45s · ↓ 150.4k tokens
  ↓ 3 more
"""#, busy: false, needsInput: false),
        Fixture(name: "trust-folder", text: #"""

────────────────────────────────────────────────────────────
 Accessing workspace:

 /private/tmp/claude-501/-Users-Junil-Desktop-agent-board-S
 ources-AgentBridge/fe771f49-c3cb-4c0a-bf29-f3cdaec42ae9/scr
 atchpad/fx/work

 Quick safety check: Is this a project you created or one
 you trust? (Like your own code, a well-known open source
 project, or work from your team). If not, take a moment to
 review what's in this folder first.

 Claude Code'll be able to read, edit, and execute files
 here.

 Security guide

 ❯ No, exit
   Yes, I trust this folder

 Enter to confirm · Esc to cancel
"""#, busy: false, needsInput: true, prompt: ("Accessing workspace:", 2, 0, false)),
        Fixture(name: "idle-60", text: #"""

 ▐▛███▛█   Claude Code v2.1.296
▝▜██████▀  Haiku 5.5 · Claude Max
 ▝▝   ▝▝   /…/scratchpad/fx/work · /rc






























                                        ◐ medium · /effort
────────────────────────────────────────────────────────────
❯ Try "how do I log an error?"
────────────────────────────────────────────────────────────
  ⏸ manual mode on · ? for shortcuts · ← 3 agents
"""#, busy: false, needsInput: false),
        Fixture(name: "busy-60", text: #"""

 ▐▛███▛█   Claude Code v2.1.296
▝▜██████▀  Haiku 5.5 · Claude Max
 ▝▝   ▝▝   /…/scratchpad/fx/work · /rc


❯ Write a 600 word essay about tmux history


























✶ Embellishing…
                                        ◐ medium · /effort
────────────────────────────────────────────────────────────
❯ 
────────────────────────────────────────────────────────────
  ⏸ manual mode on · esc to interrupt · ← 3 agents
"""#, busy: true, needsInput: false),
        Fixture(name: "permission-cursor-1", text: #"""
  default on many server images. Its influence reaches
  beyond its own users. Terminal emulators now advertise
  tmux compatibility, IDEs embed similar multiplexing
  concepts, and countless engineers have learned to think of
  their terminal sessions as durable, detachable things.

  The story of tmux is partly a story of a tool that did one
  thing well and let that focus shape its design. It did
  not try to replace the shell or the editor. It simply made
  the terminal persistent, scriptable, and reachable from
  anywhere, and nearly two decades later that remains its
  quiet, enduring contribution.

✻ Crunched for 16s · done 12:31 AM

❯ Run touch x.txt with the Bash tool

⏺ Creating empty file x.txt in working directory
  ⎿  $ touch x.txt

────────────────────────────────────────────────────────────
 Bash command
 Tip: auto mode handles these prompts for you — choose
 "switch to auto mode" below
 Create empty file x.txt in working directory
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 touch x.txt
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and always allow access to
      /private/tmp/claude-501/-Users-Junil-Desktop-agent-boa
      rd-Sources-AgentBridge/fe771f49-c3cb-4c0a-bf29-f3cdaec4
      2ae9/scratchpad/fx/work from this project
   3. Yes, and switch to auto mode · auto mode handles these
      prompts for you
   4. No

 Esc to cancel · Tab to amend
"""#, busy: false, needsInput: true, prompt: ("Do you want to proceed?", 4, 0, true)),
        Fixture(name: "permission-cursor-2", text: #"""
  default on many server images. Its influence reaches
  beyond its own users. Terminal emulators now advertise
  tmux compatibility, IDEs embed similar multiplexing
  concepts, and countless engineers have learned to think of
  their terminal sessions as durable, detachable things.

  The story of tmux is partly a story of a tool that did one
  thing well and let that focus shape its design. It did
  not try to replace the shell or the editor. It simply made
  the terminal persistent, scriptable, and reachable from
  anywhere, and nearly two decades later that remains its
  quiet, enduring contribution.

✻ Crunched for 16s · done 12:31 AM

❯ Run touch x.txt with the Bash tool

⏺ Creating empty file x.txt in working directory
  ⎿  $ touch x.txt

────────────────────────────────────────────────────────────
 Bash command
 Tip: auto mode handles these prompts for you — choose
 "switch to auto mode" below
 Create empty file x.txt in working directory
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 touch x.txt
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Do you want to proceed?
   1. Yes
 ❯ 2. Yes, and always allow access to
      /private/tmp/claude-501/-Users-Junil-Desktop-agent-boa
      rd-Sources-AgentBridge/fe771f49-c3cb-4c0a-bf29-f3cdaec4
      2ae9/scratchpad/fx/work from this project
   3. Yes, and switch to auto mode · auto mode handles these
      prompts for you
   4. No

 Esc to cancel
"""#, busy: false, needsInput: true, prompt: ("Do you want to proceed?", 4, 1, true)),
        Fixture(name: "idle-old-question-in-chat", text: #"""
  wanted a polished starting point.

  Today tmux is a standard part of the Unix toolkit. It runs
  on Linux, macOS, and the BSDs, and it is installed by
  default on many server images. Its influence reaches
  beyond its own users. Terminal emulators now advertise
  tmux compatibility, IDEs embed similar multiplexing
  concepts, and countless engineers have learned to think of
  their terminal sessions as durable, detachable things.

  The story of tmux is partly a story of a tool that did one
  thing well and let that focus shape its design. It did
  not try to replace the shell or the editor. It simply made
  the terminal persistent, scriptable, and reachable from
  anywhere, and nearly two decades later that remains its
  quiet, enduring contribution.

✻ Crunched for 16s · done 12:31 AM

❯ Run touch x.txt with the Bash tool

  Ran 1 shell command
  ⎿  Interrupted · What should Claude do instead?

✻ Crunched for 2s · done 12:32 AM

❯ Reply with exactly these lines and nothing else: Do you
  want me to continue? / 1. Yes / 2. No

⏺ Do you want me to continue?
  1. Yes
  2. No

✻ Worked for 2s · done 12:32 AM

────────────────────────────────────────────────────────────
❯ yes
────────────────────────────────────────────────────────────
  ⏸ manual mode on · ? for shortcuts · ← 3 agents
"""#, busy: false, needsInput: false),
        Fixture(name: "idle-quoted-esc-and-spinner", text: #"""

  The story of tmux is partly a story of a tool that did one
  thing well and let that focus shape its design. It did
  not try to replace the shell or the editor. It simply made
  the terminal persistent, scriptable, and reachable from
  anywhere, and nearly two decades later that remains its
  quiet, enduring contribution.

✻ Crunched for 16s · done 12:31 AM

❯ Run touch x.txt with the Bash tool

  Ran 1 shell command
  ⎿  Interrupted · What should Claude do instead?

✻ Crunched for 2s · done 12:32 AM

❯ Reply with exactly these lines and nothing else: Do you
  want me to continue? / 1. Yes / 2. No

⏺ Do you want me to continue?
  1. Yes
  2. No

✻ Worked for 2s · done 12:32 AM

❯ Reply with exactly these two lines and nothing else, no
  code block: "press esc to interrupt" and "Compiling… (12s
  · thinking)"

⏺ press esc to interrupt
  Compiling… (12s · thinking)

✻ Crunched for 2s · done 12:32 AM

────────────────────────────────────────────────────────────
❯ 
────────────────────────────────────────────────────────────
  ⏸ manual mode on · ? for shortcuts · ← 3 agents
"""#, busy: false, needsInput: false),
        Fixture(name: "busy-30-narrow", text: #"""

           Claude Code
 ▐▛███▛█   v2.1.296
▝▜██████▀  Haiku 5.5
 ▝▝   ▝▝   Claude Max
           /…/fx/work


❯ Write a 600 word essay
  about tmux history













✢ Flibbertigibbeting… (3s)
  tmux focus-events off · a…
──────────────────────────────
❯ 
──────────────────────────────
  ⏸ manual mode on · esc to…
"""#, busy: true, needsInput: false),
        Fixture(name: "permission-long-diff", text: #"""
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
+ let line0 = compute(0)
+ let line1 = compute(1)
+ let line2 = compute(2)
+ let line3 = compute(3)
+ let line4 = compute(4)
+ let line5 = compute(5)
+ let line6 = compute(6)
+ let line7 = compute(7)
+ let line8 = compute(8)
+ let line9 = compute(9)
+ let line10 = compute(10)
+ let line11 = compute(11)
+ let line12 = compute(12)
+ let line13 = compute(13)
+ let line14 = compute(14)
+ let line15 = compute(15)
+ let line16 = compute(16)
+ let line17 = compute(17)
+ let line18 = compute(18)
+ let line19 = compute(19)
+ let line20 = compute(20)
+ let line21 = compute(21)
+ let line22 = compute(22)
+ let line23 = compute(23)
+ let line24 = compute(24)
+ let line25 = compute(25)
+ let line26 = compute(26)
+ let line27 = compute(27)
+ let line28 = compute(28)
+ let line29 = compute(29)
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
  default on many server images. Its influence reaches
  beyond its own users. Terminal emulators now advertise
  tmux compatibility, IDEs embed similar multiplexing
  concepts, and countless engineers have learned to think of
  their terminal sessions as durable, detachable things.

  The story of tmux is partly a story of a tool that did one
  thing well and let that focus shape its design. It did
  not try to replace the shell or the editor. It simply made
  the terminal persistent, scriptable, and reachable from
  anywhere, and nearly two decades later that remains its
  quiet, enduring contribution.

✻ Crunched for 16s · done 12:31 AM

❯ Run touch x.txt with the Bash tool

⏺ Creating empty file x.txt in working directory
  ⎿  $ touch x.txt

────────────────────────────────────────────────────────────
 Bash command
 Tip: auto mode handles these prompts for you — choose
 "switch to auto mode" below
 Create empty file x.txt in working directory
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 touch x.txt
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and always allow access to
      /private/tmp/claude-501/-Users-Junil-Desktop-agent-boa
      rd-Sources-AgentBridge/fe771f49-c3cb-4c0a-bf29-f3cdaec4
      2ae9/scratchpad/fx/work from this project
   3. Yes, and switch to auto mode · auto mode handles these
      prompts for you
   4. No

 Esc to cancel · Tab to amend
"""#, busy: false, needsInput: true, prompt: ("Do you want to proceed?", 4, 0, true)),
        Fixture(name: "busy-28-streaming-footer-esc-cut", text: #"""
  Learning tmux: checklist
  -
    a. Install tmux and
       start your first
       session
  -
    b. Understand sessions,
       windows, and panes
  -
    c. Practice detaching
       and reattaching
  -
    d. Learn the prefix key
       and core keybindings
  -
    e. Split and navigate
       panes
  -
    f. Use copy mode to
       scroll and copy text
  -
    g. Write a custom
       ~/.tmux.conf

  Essay: The History of tmux

  Every terminal user
  eventually meets the same
  problem. You log into a
  remote server, start a
  long-running job, and then
  your connection drops.
  The job dies with it, and
  you are left
  reconstructing your work.
  For decades the standard
  answer was GNU Screen, a
  program that let a single
  terminal session survive

────────────────────────────
❯ 
────────────────────────────
  ⏸ manual mode on · esc …
"""#, busy: true, needsInput: false),
        Fixture(name: "busy-28-todo-list-synthetic", text: #"""

           Claude Code
 ▐▛███▛█   v2.1.296
▝▜██████▀  Haiku 5.5
 ▝▝   ▝▝   Claude Max
           /…/fx/work


❯ Use the TodoWrite tool to
  create a todo list with
  7 items about learning
  tmux (all pending), then
  write a 700 word essay
  about tmux history, then
  mark items done one by
  one.






















✳ Enchanting… (thinking)
  ⎿ ☐ Install tmux
    ☐ Learn panes
    ☐ Learn windows
    ☐ Learn sessions
    ☐ Configure keys
    ☐ Write notes

────────────────────────────
❯ 
────────────────────────────
  ⏸ manual mode on · esc …
"""#, busy: true, needsInput: false),
        Fixture(name: "idle-28-after-reply", text: #"""
  Progress
  -
    a. Install tmux and
       start your first
       session
  -
    b. Understand sessions,
       windows, and panes
  -
    c. Practice detaching
       and reattaching
  -
    d. Learn the prefix key
       and core keybindings
  -
    e. Split and navigate
       panes
  -
    f. Use copy mode to
       scroll and copy text
  -
    g. Write a custom
       ~/.tmux.conf

  Note: the seven checklist
  items are marked done in
  this reply as a record,
  but I haven't actually
  installed tmux or run any
  of these steps. The essay
  is from my general
  knowledge and wasn't
  checked against sources,
  so verify the dates and
  release details if you
  plan to cite it.

✻ Churned for 15s · done
  12:39 AM

────────────────────────────
❯ Install tmux and start my…
────────────────────────────
  ⏸ manual mode on · ? fo…
"""#, busy: false, needsInput: false),
        Fixture(name: "idle-28-background-shell-footer", text: #"""
       session
  -
    b. Understand sessions,
       windows, and panes
  -
    c. Practice detaching
       and reattaching
  -
    d. Learn the prefix key
       and core keybindings
  -
    e. Split and navigate
       panes
  -
    f. Use copy mode to
       scroll and copy text
  -
    g. Write a custom
       ~/.tmux.conf

  The harness blocked a
  foreground sleep 60, so I
  ran it as a background
  task instead (ID
  bhf74xx21). I'll be
  notified when it finishes.

  I also need to correct my
  last reply. I marked all
  seven items [x] as
  "Progress," but I had not
  done any of them. Treat
  those checkmarks as wrong.
  The list above is the
  accurate state.

✻ Worked for 8s · done 12:40
  AM · 1 shell still
  running

────────────────────────────
❯ check the background slee…
────────────────────────────
  ⏸ manual mode on · 1 she
"""#, busy: false, needsInput: false),
        Fixture(name: "switch-model-confirmation", text: #"""
❯ Say hello in one short sentence.
⏺ Hello!
✻ Sautéed for 2s · done 1:07 AM
▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔
   Switch model?
   Your next response will be slower and use more tokens
   This conversation is cached for the current model. Switching to
   Sonnet 5.5 means the full history gets re-read on your next
   message.
   ❯ 1. Yes, switch to Sonnet 5.5
     2. No, go back
"""#, busy: false, needsInput: true, switchModel: true, prompt: ("Switch model?", 2, 0, true)),
    ]
}
