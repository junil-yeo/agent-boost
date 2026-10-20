# Agent Boost

Watch and drive teams of Claude Code agents from one window, on macOS and Linux.
tmux is used only as an invisible engine underneath; you work in the app.

One app, one codebase: an Electron app in `app/` for both systems. (The earlier SwiftUI version is kept in `Sources/`
for reference while the Electron app takes over; it is no longer installed.)

## Install

Paste one line into a terminal, on macOS or Linux. It checks and installs everything the app needs, signs you in to
Claude, installs the app and opens it. Run it again to update.

- **macOS** (12 or later): Homebrew for tmux and the GitHub CLI, a private Node.js, Claude Code; packages the app and
  puts it in Applications.
- **Linux** (Ubuntu/Debian, Fedora, Arch, openSUSE; x86_64 or arm64): tmux and the window's system libraries through
  your package manager (it asks for your password once), a private Node.js, Claude Code, GitHub CLI; installs the app
  under `~/.local/share/agent-boost` with an `agent-boost` command and an entry in your app menu.

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/junil-yeo/agent-boost/main/install.sh)"
```

Languages: English, 한국어, 日本語, 简体中文, Español. You pick one at first launch and can change it at any time from
the menu above the clock.

## Develop

- Run from source: `cd app && npm install && npm start`. Tests: `npm test`.
- Package the macOS app: `./build.sh` (seconds: no compile step), `./build.sh run` also restarts a running copy
  (sessions keep running). On Linux the installer runs the app from `~/.local/share/agent-boost/app`.
- Layout: `app/main/` holds the logic (one module per former Swift file, same function names: `TmuxControl.send` →
  `tmux.send`), `app/renderer/` the screens (Preact, no build step). Translations: `Resources/l10n` (+ `app/l10n-extra`).
- `AB_READONLY=1 npm start` runs it without changing any session or file (for trying it next to a running copy).

## Legacy SwiftUI version (reference)

- Build: `./build-swift.sh` (development, fast) / `./build-swift.sh release` (optimized, for this Mac) /
  `./build-swift.sh dist` (optimized, for distribution)
- Requires macOS 15+, `tmux` and the `claude` CLI. Command Line Tools (Swift) only when building yourself.
- Where the app looks for tools: `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `/opt/local/bin`, then the
  login shell's PATH. If they live elsewhere, point to them with `BOARD_TMUX` and `BOARD_CLAUDE`.
- `./build-swift.sh dist` makes a universal binary for Intel and Apple Silicon (both compiled at the same time).

### First launch on another Mac

1. **Gatekeeper**: an app downloaded as a file has no developer signature, so macOS refuses to open it ("unidentified
   developer" or "damaged"). Run `xattr -d com.apple.quarantine /path/to/AgentBoost.app`, or right-click > Open once.
   The one-line installer above builds on your Mac and is not affected.
2. **tmux**: if it is missing, the notice bar at the top explains how to install it (`brew install tmux`). Starting,
   typing into and quitting sessions all go through tmux, so it is required.
3. **Claude Code sign-in**: if Claude Code is installed but not signed in, the usage gauges show `OFF` with a "sign-in
   needed" notice. Run `claude` once in Terminal to pick the text style and sign in. If you created a session in the
   app first, its card shows a "finish setup in Terminal" button that does the same.
4. **Folder access**: the first time the app reads a project inside Desktop or Documents, macOS asks for permission.
   Without it the app cannot read that folder's session history.
5. With no sessions yet the org chart is empty; start one with "New session" (⌘N) at the top right.

- App data: `~/.agent-boost/` (team memory, task names, archive). The session list itself is not stored; it is read
  from the CLI's files. The app writes to Claude's own data only to save names (custom-title), to delete (move to the
  Trash) and through `claude stop` / `claude rm`.

## Screens

| Tab | Contents |
|---|---|
| Org chart | Every team and session as cards: team lead → teammates, model, effort, tokens, state; ended teams too |
| Individual Sessions | Sessions without teammates (running / ended). Ended ones can be restarted |
| Team tabs | One tab per live team: member list, chat and input |
| Top banner | Current session / weekly / weekly Fable usage (green) and time elapsed (blue, dotted ticks), traffic light, to-dos, clock, language menu |

## What you can do

- **New session** (⌘N): name, folder, model, effort, teammates, first task. With no first task it waits without using
  tokens. Defaults: team lead Opus 5.5 · low, teammates Sonnet 5.5 · low.
- **Cloud session**: in the New session window, switch to "Cloud (web)", pick GitHub repositories (listed through the
  GitHub CLI, or type `owner/repo`) and a first task; claude.ai/code opens with them filled in. Cloud sessions run and
  are watched on the web or the mobile app; they do not appear in this app's session list.
- **Add teammates**: the app asks the team lead to create them, then checks for two minutes that they really exist
  with the requested model and effort, and shows the result.
- **Send messages**, **interrupt** (Esc), **rename** (/rename), **change model / effort** (/model, /effort — held
  until the agent is idle when it is working).
- **Attachments**: drop files or paste screenshots into the input box. The app waits until the CLI has read pasted
  images before pressing Enter, and removes its own copies once the CLI has taken the message.
- **Queued messages**: messages sent while an agent works wait in the CLI's queue. "Send now" stops the current work
  and sends them; "Pull back" returns them to the input box to edit or delete (like ↑ in the CLI).
- **Copy answer**: copies the latest answer; the ▾ next to it lists the last five.
- **Search chats** (⌘⇧F): search every session's conversation; see each hit with the messages around it, copy it or
  jump to the session.
- **Paths are links**: a file path in the chat opens its folder in Finder (a file is shown selected).
- **Quit**: types `/exit`. While the agent is working you choose "quit now / quit when done". SIGTERM if it has not
  ended after 30 seconds.
- **Delete**: quits it first if running, then moves the conversation to the Trash (restorable). Background jobs use
  `claude stop` + `claude rm`.
- **Restart**: reopens an ended session with `claude --resume` under the same ID (choose model and effort; a copy is
  optional).
- Dock badge = number of working sessions.

## Two kinds of names

| | Session name (alias) | Team address |
|---|---|---|
| Example | `paper figure review` | `teammate1@session-9b510d0d` |
| Set by | You (`-n`, `/rename`) | Claude, when it creates the teammate |
| Can change | Any time (pencil icon in the app) | No (create the teammate again) |
| Limits | Any language | Teammate names: letters, digits, `_`, `-` only (Claude Agent tool limit) |

The name you type for a new session is an **alias**. A teammate's name is both its alias and the first part of its
address, so it must be plain ASCII (the app checks).

## Chat (the same input experience as the CLI)

- **Status line**: while working, the CLI's glyph (`· ✢ ✳ ✶ ✻ ✽`) turns under the chat with the verb, elapsed time and
  tokens the CLI itself shows (`Mustering… (2m 30s · ↓ 9.8k tokens)`) and the tool running now. Stop with the button
  or Esc. A raised hand shows when a question is waiting; when done, `✻ Last turn 2m 47s · done 2:16 AM` stays dimmed.
  The member list's state chip shows the same verb and time.
- **Tab completion (grey suggestion)**: first choice is the CLI's own next-prompt prediction, which the CLI draws dimmed
  in its input line after a turn; the app shows the same sentence. The CLI has this off by default, so the app adds
  `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=1` only to sessions it starts (not to teammates; turn it off with
  View > "Enable CLI next-input suggestions (new sessions only)"). Without a CLI suggestion the app uses its own rules: in an empty box a
  likely next input from the conversation (a "Shall I…?" answer gets "Yes, go ahead", numbered options get "Option
  1…", a tool error gets "Find and fix the cause"); while typing, the most recent earlier input from
  `~/.claude/history.jsonl` that starts the same way. Tab fills it in.
- **↑/↓ input history**: in an empty box ↑ brings back earlier inputs (this session → same folder → all) and ↓ goes
  back. Esc cancels.
- **`@` file mentions**: typing `@` lists the working folder's files (fuzzy search); Tab/Enter inserts `@path`.
  Claude Code reads the file when the message is sent.
- **Shift+Tab cycles the permission mode**, as does clicking the `⏵⏵ auto mode` chip. The mode shown is read from the
  CLI's footer.
- **Footer**: permission mode · context use (last request's input + cache tokens / 200k, 1M for 1M models) · agents
  the CLI counts · pending commands · Tab suggestion · `? shortcuts`.

## Terminal and shell commands

- **Terminal**: the session's "Terminal" button opens its tmux session in a Terminal window. Closing the window keeps
  the session running, and typing on either side shows on the other.
- **`!command`**: a message starting with `!` goes to Claude Code's shell mode and runs in the agent's working folder
  (e.g. `!ls`, `!git status`). Claude Code runs it under its own permission settings. The agent sees the output too,
  so a short model turn may follow.

## Staying in step with the CLI (the session list is the CLI's)

The app keeps no session list of its own. Every 2 seconds it reads the CLI's files and draws from them.

| Shown in the app | Source (CLI files) |
|---|---|
| Running sessions | `~/.claude/sessions/<pid>.json` (what `claude agents` sees) |
| Background jobs | `~/.claude/jobs/<id>/state.json` (`claude agents --all`) |
| Ended conversations | every `~/.claude/projects/*/<id>.jsonl` (what the `/resume` picker lists) |
| Teams | `~/.claude/teams`, plus the app's memory (`seen-members.json`) for teams whose folder was removed when the lead ended |

Sessions started in a terminal show up as they are, and a conversation deleted in a terminal disappears from the
board. The archive only hides cards; it never touches files.

**The CLI's `← for agents` screen (session list).** Claude Code 2.1.301 **moves the conversation into a background job
with a new session ID** the moment you enter that screen. The process in the terminal becomes a viewer, and
`claude agents` lists only the job. For a conversation that already had messages the original transcript stays and
the job gets a copy (a branch the CLI makes, not the app). The app follows it like this:
- The card is **the job**. It borrows the viewer's screen (tmux pane) and name. While the viewer lives, the original
  transcript is not drawn separately (`claude agents` does not count the viewer either).
- While that screen shows the session list or the `/resume` picker, the app **does not type** (a message would land
  in the box that creates a new session). The input box says why, and a held command such as `/model` is sent after
  you press Esc in the CLI to return to the conversation.
- Quit closes the viewer (ctrl+c twice, else SIGTERM), then `claude stop <job>`. Delete is `claude stop` +
  `claude rm` + transcript to the Trash.
- Restart follows the CLI: `claude --bg --resume <id>` (same ID), then `claude attach` for the screen.
  (`claude --resume` refuses a job conversation with "No deferred tool marker…". If a stopped job's record remains,
  the CLI makes a copy, so `claude rm` runs first.)
- A running conversation is never opened twice. Conversations made by other programs (the desktop app, etc.) continue
  under the same ID; a copy (`--fork-session`) is made only when you turn it on in the restart window.

**If someone is typing into the same session in a terminal**, the app does not send and tells you (commands wait
while that box has text).

**Quitting the app.** "Quit with Sessions" warns before it acts: sessions waiting for an answer (with the question; quitting
cancels it with Esc), working sessions, and sessions whose CLI shows the list screen. "Quit App Only" also warns
first if a session is waiting for an answer. A session force-quit after not answering /exit within 30 seconds gets
one more warning just before.

**CLI updates.** When `claude --version` reports a new version, the app checks once (no tokens) that the screen texts
it reads are still in the new CLI and that every idle session's input box is still found, and warns if not.

## Good to know

- `/model` and `/effort` also change Claude's **global default**, so the app restores `settings.json` around the
  change (verified byte-identical).
- Ending the team lead makes Claude **end the teammates too** and delete the team folder. The app keeps showing the
  ended team from its own memory.
- Restarting an ended **teammate** opens it as a solo session, separate from the team.
- Sessions started from the desktop app or a plain terminal are **view only** (no input or changes). Quit sends a
  real SIGTERM, with a warning in the confirmation.
- Small models (Haiku) often get the team protocol wrong. Sonnet or better is recommended for team leads.
- The `haiku` alias resolves to Haiku 5.5 in this CLI version.

## Tests

`AgentBoost --snapshot DIR [--selftest] [--selftest-live] [--selftest-team] [--selftest-sync]`
`--selftest-sync`: checks that a session started in a terminal appears, that the CLI's `← agents` screen merges into
one card and refuses input, that held commands go out after Esc, that quit ends with `claude stop` and a clean list,
that restart continues the same ID with `--bg --resume` + `attach`, and that delete also clears the CLI's list
(Haiku, one one-word answer).
`AgentBoost --selftest-detect`: screen recognition (working / needs input / list screen) on fixed samples.
`AgentBoost --snapshot DIR --tab __loose --agent <sessionID> --bench-typing [--bench-long]`: simulates keystrokes in the
input box and measures time per key (median, top 10%, max, CPU time). The target is 16 ms (one frame) or less per key.
Saves the window as PNGs and writes `report.json`. `--selftest-live/team` create real Claude sessions (Haiku, no task
→ almost no tokens), verify create / change / quit / restart, then clean up.
