#!/bin/sh
# Makes (or replaces) the throwaway tmux session abtest-perf: 139x399 like the app's CLI panes, running fake-cli.py.
# Prints its pane id for `node test/perf/perf.js screen --pane %N`. `abtest-pane.sh kill` removes it.
# (Never touches any other session.)
S=abtest-perf
tmux has-session -t "=$S" 2>/dev/null && tmux kill-session -t "=$S"
[ "$1" = kill ] && exit 0
tmux new-session -d -s "$S" -x 139 -y 399 "python3 '$(cd "$(dirname "$0")" && pwd)/fake-cli.py'"
tmux list-panes -t "=$S" -F '#{pane_id}'
