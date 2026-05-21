#!/usr/bin/env bash
# Forward a message to a running lead session and submit it.
#
# Usage:
#   send.sh <session-name> <message>
#
# Exit codes:
#   0  message forwarded
#   1  bad arguments / invalid session name
#   2  no session found in any supported host
#
# Host selection — driven by IA_TW_TERMINAL:
#   tmux   → only look in tmux
#   iterm  → only look in iTerm2 (osascript)
#   auto / unset (default) → tmux first, iTerm2 fallback (mirrors start-lead.sh)
#
# The two-step paste / submit protocol is preserved on both hosts:
#   1. paste the message verbatim (no key-name interpretation, "Enter"
#      / "C-c" inside the text remain literal),
#   2. brief pause so the TUI registers the buffered text,
#   3. SEPARATE submit keystroke (Return).
#
# Combining content + Enter into a single call leaves the prompt populated
# but unsubmitted in Claude Code's TUI. Keep them separate.
set -euo pipefail

session="${1:?session name required}"
message="${2:?message required}"
terminal_pref="${IA_TW_TERMINAL:-auto}"

# Reject tmux target-syntax in the session name. `.` and `:` are reserved
# by tmux for `session.window` and `session:window.pane` targeting; we
# enforce the same rule for iTerm2 names so the contract stays uniform.
case "$session" in
  *.*|*:*)
    echo "✗ session name must not contain . or :" >&2
    exit 1
    ;;
esac

# ─── Host probes ────────────────────────────────────────────────────────────
tmux_has_session() {
  command -v tmux >/dev/null 2>&1 || return 1
  tmux has-session -t "$1" 2>/dev/null
}

iterm_has_session() {
  command -v osascript >/dev/null 2>&1 || return 1
  osascript -e 'id of application "iTerm"' >/dev/null 2>&1 || return 1
  # Returns "yes" via stdout when a session named $1 exists in any window.
  local result
  result=$(osascript <<APPLESCRIPT 2>/dev/null
tell application "iTerm"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if name of s is "$1" then return "yes"
      end repeat
    end repeat
  end repeat
  return "no"
end tell
APPLESCRIPT
)
  [ "$result" = "yes" ]
}

# ─── Sends ─────────────────────────────────────────────────────────────────
send_tmux() {
  # Step 1: paste content verbatim. `-l` disables key-name lookup; `--` ends
  # option parsing so a message starting with `-` is treated as data.
  tmux send-keys -t "$1" -l -- "$2"
  # Step 2: short pause so the TUI registers the buffered text before submit.
  sleep 0.15
  # Step 3: SEPARATE Enter — this is the submit.
  tmux send-keys -t "$1" Enter
  echo "✓ message forwarded to tmux session '$1'"
}

send_iterm() {
  # AppleScript: locate the session by name, paste message without newline,
  # pause, then send a second `write text ""` WITH newline as the submit.
  # We escape backslashes and double-quotes to keep the AppleScript string
  # intact; the message body is passed via stdin to avoid argv length limits.
  local target="$1" body="$2"
  local escaped
  escaped=$(printf '%s' "$body" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')

  osascript >/dev/null <<APPLESCRIPT
tell application "iTerm"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if name of s is "$target" then
          tell s
            write text "$escaped" newline NO
            delay 0.15
            write text "" newline YES
          end tell
          return
        end if
      end repeat
    end repeat
  end repeat
end tell
APPLESCRIPT
  echo "✓ message forwarded to iTerm2 session '$target'"
}

# ─── Host selection ─────────────────────────────────────────────────────────
case "$terminal_pref" in
  tmux)
    if tmux_has_session "$session"; then
      send_tmux "$session" "$message"
      exit 0
    fi
    echo "✗ tmux session '$session' not found (IA_TW_TERMINAL=tmux)" >&2
    exit 2
    ;;
  iterm)
    if iterm_has_session "$session"; then
      send_iterm "$session" "$message"
      exit 0
    fi
    echo "✗ iTerm2 session '$session' not found (IA_TW_TERMINAL=iterm)" >&2
    exit 2
    ;;
  auto|"")
    if tmux_has_session "$session"; then
      send_tmux "$session" "$message"
      exit 0
    fi
    if iterm_has_session "$session"; then
      send_iterm "$session" "$message"
      exit 0
    fi
    echo "✗ session '$session' not found in tmux or iTerm2." >&2
    echo "  Run /session $session ... first, or set IA_TW_TERMINAL to" >&2
    echo "  force a specific host." >&2
    exit 2
    ;;
  *)
    echo "✗ IA_TW_TERMINAL='$terminal_pref' invalid. Use 'tmux', 'iterm', or 'auto'." >&2
    exit 1
    ;;
esac
