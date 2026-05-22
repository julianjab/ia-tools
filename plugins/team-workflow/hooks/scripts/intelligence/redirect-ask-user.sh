#!/usr/bin/env bash
# PreToolUse hook for AskUserQuestion (intelligence bucket — calls Haiku).
#
# Bucket:      intelligence
# Listens to:  PreToolUse / AskUserQuestion (registered in hooks.json)
# Blocking:    yes (exits 2 with a teaching stderr message)
# Input:       JSON payload on stdin (PreToolUse contract)
# Output:      stderr text the agent re-reads on the next turn
#
# Two responsibilities:
#
#  1. In a team-workflow session, redirect every user-facing question to
#     the team-workflow:ask-user skill (it is a Skill, NOT a slash
#     command — the skill routes to Slack / parent IPC / terminal based
#     on session env).
#
#  2. Guard against self-inflicted questions. Calls Haiku via the shared
#     `fast_claude` helper to classify the question. Verdict drives the
#     teaching message:
#
#       SELF_INFLICTED → "resolve it yourself" message. The agent is
#                        offloading a problem it produced (blocked tool,
#                        missing capability, hook rejection, mistake).
#       LEGITIMATE     → "use the team-workflow:ask-user skill" message.
#                        Genuine policy / scope / approval / rule-conflict.
#       UNCLEAR        → same as LEGITIMATE (least disruptive default).
#
# The model judgment is preferred over regex because the question wording
# varies too much to enumerate. When the model call fails (no API key,
# offline, claude binary missing) the hook degrades to LEGITIMATE so we
# never break the user gate over a transient classifier failure.
#
# Outside the team-workflow context (no IA_TW_* envs), the hook is a
# no-op and native AskUserQuestion is allowed.

set -euo pipefail

# ─── Detect team-workflow context ──────────────────────────────────────────
active_context=0
reason=""

if [ -n "${IA_TW_TOPIC:-}" ] && [ "$IA_TW_TOPIC" != "local" ]; then
  active_context=1
  reason="Slack topic active (IA_TW_TOPIC=$IA_TW_TOPIC)"
fi

if [ -n "${IA_TW_PARENT_SOCK:-}" ] && [ -S "$IA_TW_PARENT_SOCK" ]; then
  active_context=1
  if [ -n "$reason" ]; then
    reason="$reason; parent IPC socket reachable"
  else
    reason="parent IPC socket reachable ($IA_TW_PARENT_SOCK)"
  fi
fi

if [ "$active_context" -eq 0 ] && [ -n "${IA_TW_FEATURE:-}" ]; then
  active_context=1
  reason="team-workflow lead/worker session (IA_TW_FEATURE=$IA_TW_FEATURE)"
fi

if [ "$active_context" -eq 0 ]; then
  exit 0
fi

# ─── Read stdin payload + extract question text ────────────────────────────
payload=""
if [ ! -t 0 ]; then
  payload=$(cat 2>/dev/null || true)
fi

questions_text=""
if [ -n "$payload" ] && command -v jq >/dev/null 2>&1; then
  questions_text=$(
    printf '%s' "$payload" \
      | jq -r '
          (.tool_input.questions // [])
          | map(
              (.question // "")
              + (if .options
                   then " | options: " + ((.options | map(.label // "") | join(", ")))
                   else ""
                 end)
            )
          | join("\n---\n")
        ' 2>/dev/null || true
  )
fi

# ─── Classify via Haiku ────────────────────────────────────────────────────
# Default verdict when classification can't run.
verdict="LEGITIMATE"

if [ -n "$questions_text" ]; then
  # shellcheck disable=SC1091
  . "$(dirname "$0")/_fast_claude.sh"

  prompt=$(
    cat <<PROMPT
You are a strict classifier. Decide whether the following question, which
an autonomous coding agent is about to ask its human operator, is
SELF_INFLICTED or LEGITIMATE.

SELF_INFLICTED means the agent is trying to make the user resolve a
problem the agent itself produced. Examples:
  - A tool was blocked / denied / not in its tool list, and the agent
    is asking the user to run it or to give it the missing capability.
  - A hook (PreToolUse, enforce-worktree, etc.) rejected the call and
    the agent is asking the user how to proceed instead of adapting.
  - The agent made a mistake (overwrote, deleted, broke a file) and
    is asking the user to fix or undo it.
  - The agent is asking the user to do work the agent is fully capable
    of doing itself (research, file reads, code writes, command runs).

LEGITIMATE means the question genuinely requires the operator's input:
  - Product / scope / policy decision only the human can make
    (e.g. "should we ship feature X or Y?", "approve this plan").
  - Approval gate (aprobar / cancelar / plan-edit reply).
  - Two rules in the agent's instructions genuinely contradict each
    other and the agent cannot pick one with confidence — the question
    quotes both rules and asks for adjudication.
  - Missing domain knowledge the operator owns (credentials, business
    rules, prior decisions not in the codebase).

When uncertain, answer UNCLEAR.

Reply with a SINGLE token on a single line: SELF_INFLICTED, LEGITIMATE,
or UNCLEAR. No prose, no punctuation, no explanation.

QUESTION TEXT (may include multiple questions separated by '---'):
<<<
$questions_text
>>>
PROMPT
  )

  result=$(
    printf '%s' "$prompt" \
      | fast_claude --model claude-haiku-4-5-20251001 2>/dev/null || true
  )

  # Sanitize: keep first non-empty line, uppercase, strip non-letters.
  result_clean=$(
    printf '%s' "$result" \
      | awk 'NF { print toupper($0); exit }' \
      | tr -cd 'A-Z_'
  )

  case "$result_clean" in
    SELF_INFLICTED) verdict="SELF_INFLICTED" ;;
    LEGITIMATE)     verdict="LEGITIMATE" ;;
    UNCLEAR)        verdict="LEGITIMATE" ;;  # default to less-disruptive
    *)              verdict="LEGITIMATE" ;;  # classifier failure → allow redirect path
  esac
fi

# ─── Emit teaching message + exit 2 ────────────────────────────────────────
if [ "$verdict" = "SELF_INFLICTED" ]; then
  cat >&2 <<EOF
AskUserQuestion intercepted: classifier flagged the question as self-inflicted.

Context: $reason
Verdict: SELF_INFLICTED  (model: claude-haiku-4-5)

The question text suggests you are asking the operator to resolve a
problem you produced — a blocked tool, a missing capability, a hook
rejection, or a mistake to undo. Do NOT escalate this to the user.

Resolve it yourself. Options:
  • Re-read the hook / tool error and adapt (create the worktree,
    fall back to an allowed tool, fix your own input).
  • Use a different tool path (Bash + Skill instead of an unavailable
    SlashCommand, Edit inside the worktree instead of on main, etc.).
  • Re-plan the step without the blocked capability.

When IS it valid to ask the user?
  (a) Product / policy / scope decision only the operator can make.
  (b) Two rules in your instructions genuinely contradict each other
      and you cannot pick one with confidence — quote both rules in the
      question so the operator can adjudicate.

If neither (a) nor (b) applies, you must self-resolve. Retry without
the AskUserQuestion call.
EOF
  exit 2
fi

cat >&2 <<EOF
AskUserQuestion intercepted in this session ($reason).
Verdict: $verdict  (classifier: claude-haiku-4-5)

In team-workflow sessions, route every user-facing question through the
**team-workflow:ask-user skill** (it is a Skill, not a slash command).
The skill picks the destination (Slack reply, parent IPC, or terminal)
from the session env so the operator actually sees the question.

Retry as:
  Skill(skill="team-workflow:ask-user",
        args="\"<your question text>\" --ask --in-reply-to <inbound message_ts when applicable>")

For one-way notifications (no answer needed) drop the --ask flag.
EOF

exit 2
