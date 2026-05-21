---
name: send-session-message
description: >
  Forward a message to a running lead session (tmux or iTerm2) and
  submit it. Auto-detects the host: tmux first (`tmux has-session`), then
  iTerm2 (osascript lookup by session name). Pastes the text literally,
  then fires a SEPARATE submit keystroke so Claude Code's TUI actually
  processes the message. Combining content + Enter into one call leaves
  the text pasted but unsubmitted — this skill exists to make the
  two-step protocol the only path on both hosts. Override the auto
  selection with `IA_TW_TERMINAL=tmux` or `IA_TW_TERMINAL=iterm`.

  Examples:
    /send-session-message feat-payment-tracking "status?"
    /send-session-message fix-login-bug "aprobar"
argument-hint: "<tmux-session-name> <message>"
disable-model-invocation: false
---

## /send-session-message — Forward + submit into a lead session

`/send-session-message` is the only sanctioned way to push a message
into another Claude Code session, regardless of whether it lives in
tmux or in an iTerm2 window. The receiving session sees the text in
its prompt and then receives Enter as a separate keystroke, which is
what Claude Code's TUI needs in order to treat the message as
submitted.

### Host detection

| `IA_TW_TERMINAL` | Behavior |
|---|---|
| unset / `auto` (default) | Probe tmux (`tmux has-session`); if not found, probe iTerm2 (osascript). Send to the first match. |
| `tmux` | Only look in tmux. Exit 2 if the session is not there. |
| `iterm` | Only look in iTerm2. Exit 2 if no session of that name. |

The probe is name-based on both hosts. `/session` sets the tmux session
name and the iTerm2 session/window name to `<feature>`, so the lookup
is symmetric.

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
/send-session-message <session-name> <message>
```

| Arg | Required | Purpose |
|---|---|---|
| `<session-name>` | ✅ | Target session. Must NOT contain `.` or `:` (tmux target syntax — also enforced for iTerm2 to keep the contract uniform). |
| `<message>` | ✅ | Free-form text. Pasted literally — no key-name interpretation. The submit Enter is fired AFTER the paste, as a separate call. |

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
2. Resolves the host according to `IA_TW_TERMINAL` (auto / tmux / iterm).
3. **tmux path**: `tmux has-session -t` → `tmux send-keys -l --` (paste,
   `-l` keeps `Enter`/`C-c`/`$` literal) → 150 ms sleep → separate
   `tmux send-keys Enter` (submit).
4. **iTerm2 path**: locate the session by name via AppleScript →
   `write text "<msg>" newline NO` (paste) → 150 ms delay →
   `write text "" newline YES` (submit). The two `write text` calls
   stay separate for the same reason tmux needs two `send-keys`.

## Delegate script

```bash
!bash "${CLAUDE_PLUGIN_ROOT}/skills/send-session-message/scripts/send.sh" \
  "<session-name>" "<message>"
```

Add an `IA_TW_TERMINAL=tmux|iterm` env prefix to force a specific host
instead of using auto-detection.

## Errors and recovery

| Situation | Action |
|---|---|
| `<session-name>` empty or contains `.` / `:` | Reject. |
| `<message>` empty | Reject. |
| Session not found in any host (auto) | Report and stop; do not auto-create. |
| `IA_TW_TERMINAL=tmux` and session missing in tmux | Exit 2. |
| `IA_TW_TERMINAL=iterm` and session missing in iTerm2 | Exit 2. |
| Neither tmux nor `osascript` available | Abort with install hint. |

## Why a separate Enter

Claude Code's TUI treats `Enter` keys received in the same input batch
as the pasted content as part of that content (multi-line input). Only
when Enter arrives as a *separate* `tmux send-keys` invocation does
the TUI register it as the submit keystroke. Empirically: combined
calls leave the prompt populated but unsubmitted, while the two-step
protocol submits reliably across iTerm2, Alacritty, and Kitty. This
skill encodes that protocol so callers cannot accidentally regress.
