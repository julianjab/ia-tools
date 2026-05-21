---
name: send-session-message
description: >
  Forward a message to a running tmux session (typically a `lead`) and
  submit it. Pastes the text literally with `tmux send-keys -l`, then
  fires a SEPARATE `tmux send-keys Enter` so Claude Code's TUI actually
  processes the message. Combining the content and Enter into one
  send-keys call leaves the text pasted but unsubmitted — this skill
  exists to make the two-step protocol the only path.

  Examples:
    /send-session-message feat-payment-tracking "status?"
    /send-session-message fix-login-bug "aprobar"
argument-hint: "<tmux-session-name> <message>"
disable-model-invocation: false
---

## /send-session-message — Forward + submit into a tmux session

`/send-session-message` is the only sanctioned way to push a message
into another Claude Code session running inside tmux. The receiving
session sees the text in its prompt and then receives an Enter as a
separate keystroke, which is what Claude Code's TUI needs in order to
treat the message as submitted.

### When to use it

- The `router` (or any other dispatcher session) needs to relay a
  message into a `lead` that already lives in its own tmux session,
  without restarting the lead or going through a fresh `/session`.
- A `lead` in local mode wants to send a status note to a sibling
  session running in tmux.

### When NOT to use it

- Do NOT use it to talk to another agent **in your own process**
  (teammate via the agent-teams framework). Use `SendMessage` for that.
- Do NOT use it to talk to a session on another machine.
- Do NOT use it to bypass the approval gate by pasting "aprobar" into
  someone else's lead — the operator decides approvals.

## Contract

```
/send-session-message <tmux-session-name> <message>
```

| Arg | Required | Purpose |
|---|---|---|
| `<tmux-session-name>` | ✅ | Target tmux session. Must NOT contain `.` or `:` (tmux target syntax). |
| `<message>` | ✅ | Free-form text. Pasted literally — no key-name interpretation. Newlines inside the message are preserved as Shift+Enter equivalents at the receiving TUI's discretion; the submit Enter is fired AFTER the paste, as a separate call. |

### Argument parsing

Tokenize `$ARGUMENTS`:

| Token shape | Extract into |
|---|---|
| First positional, no `.` / `:` | `SESSION` |
| Everything after the first whitespace | `MESSAGE` (quotes optional; preserve verbatim) |
| Empty `SESSION` or empty `MESSAGE` | reject with the usage line |

## What it does

The skill is a thin wrapper around `scripts/send.sh`. The script:

1. Validates the session name (no `.` / `:`).
2. Verifies the tmux session exists (`tmux has-session -t`).
3. Pastes the message: `tmux send-keys -t <session> -l -- "<message>"`.
   `-l` disables key-name interpretation so words like `Enter`, `C-c`,
   or `$` inside the message stay as text.
4. Sleeps 150 ms so the TUI registers the buffered text.
5. Fires Enter as a SEPARATE call: `tmux send-keys -t <session> Enter`.
   This is the submit. The separation is the whole point of the skill.

## Delegate script

```bash
!bash "${CLAUDE_PLUGIN_ROOT}/skills/send-session-message/scripts/send.sh" \
  "<tmux-session-name>" "<message>"
```

## Errors and recovery

| Situation | Action |
|---|---|
| `<tmux-session-name>` empty or contains `.` / `:` | Reject. |
| `<message>` empty | Reject. |
| tmux session does not exist | Report and stop; do not auto-create. |
| `tmux` not on PATH | Abort with install hint. |

## Why a separate Enter

Claude Code's TUI treats `Enter` keys received in the same input batch
as the pasted content as part of that content (multi-line input). Only
when Enter arrives as a *separate* `tmux send-keys` invocation does
the TUI register it as the submit keystroke. Empirically: combined
calls leave the prompt populated but unsubmitted, while the two-step
protocol submits reliably across iTerm2, Alacritty, and Kitty. This
skill encodes that protocol so callers cannot accidentally regress.
