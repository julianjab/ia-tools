#!/usr/bin/env bash
# Forward a message to a running tmux session (typically a lead) and submit it.
#
# Usage:
#   send.sh <tmux-session-name> <message>
#
# The content is pasted with `tmux send-keys -l --` (literal — no key-name
# interpretation, so things like "Enter", "C-c", or "$" inside the message
# stay as text). A short pause lets the TUI's input buffer settle, then a
# SEPARATE `tmux send-keys ... Enter` invocation submits the message.
#
# The two calls MUST stay separate: combining content + Enter into a single
# send-keys invocation has been observed to leave the message pasted but
# not submitted in Claude Code's TUI (Enter ends up buffered as part of
# the input rather than treated as the submit key).
set -euo pipefail

session="${1:?tmux session name required}"
message="${2:?message required}"

# Reject tmux target-syntax in the session name. `.` and `:` are reserved
# by tmux for `session.window` and `session:window.pane` targeting.
case "$session" in
  *.*|*:*)
    echo "✗ tmux session name must not contain . or :" >&2
    exit 1
    ;;
esac

if ! tmux has-session -t "$session" 2>/dev/null; then
  echo "✗ tmux session '$session' not found" >&2
  exit 2
fi

# Step 1: paste content verbatim. `-l` disables key-name lookup; `--`
# ends option parsing so a message starting with `-` is treated as data.
tmux send-keys -t "$session" -l -- "$message"

# Step 2: short pause to let the TUI register the buffered text before
# the submit key arrives. 150ms is conservative and imperceptible.
sleep 0.15

# Step 3: SEPARATE Enter — this is the submit. Without this second
# invocation the content sits in the prompt but never executes.
tmux send-keys -t "$session" Enter

echo "✓ message forwarded to tmux session '$session'"
