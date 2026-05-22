#!/usr/bin/env bash
# append-message.sh — append a structured turn entry to the topic's messages.md.
#
# Bucket:      bookkeeping
# Listens to:  UserPromptSubmit | Stop | SubagentStop |
#              PostToolUse(claim_message|reply|reply_update)
# Blocking:    no (always exit 0)
# Output:      append-only entry to $IA_TW_STATE_DIR/messages.md
#
# Modes (selected by the first argument from hooks.json):
#   user-prompt    UserPromptSubmit — reads .prompt; actor=user.
#                   This also captures Slack inbounds when the slack-bridge
#                   injects them as user prompts in the session.
#   agent-stop     Stop            — reads .transcript_path → last assistant
#                                    message; actor=${IA_TW_AGENT:-agent}.
#   subagent-stop  SubagentStop    — same as agent-stop; actor=.subagent_type.
#   tool-use       PostToolUse     — for slack-bridge tools that carry text on
#                                    the outbound side (reply / reply_update).
#                                    claim_message has no text payload, so
#                                    inbound capture for Slack relies on the
#                                    UserPromptSubmit injection above.
#
# State dir resolution:
#   $IA_TW_STATE_DIR set, directory exists, AND messages.md already created
#   → append. Otherwise → no-op (the router bootstraps messages.md on the
#   first topic resolve; this hook never creates it from scratch).
#
# Dedup: each entry tags `ts:` to the second; identical adjacent entries from
# the same actor within the same second are merged (last write wins) to absorb
# the (very rare) case where Stop + a redundant tool-use both fire for the
# same final response.

set -u

mode="${1:-}"
payload=$(cat 2>/dev/null || true)

# State dir gate ─────────────────────────────────────────────────────────────
# Precedence:
#   1. $IA_TW_STATE_DIR inherited from the launching process (lead sessions
#      always have it via start-lead.sh).
#   2. Sentinel file written by bootstrap-topic-state.sh
#      (~/.claude/team-workflow/state/.current). Used by router-side hooks
#      where the agent cannot export envs up to the parent Claude Code
#      process — the sentinel is refreshed each turn the router invokes
#      the helper.
# In either case, messages.md must already exist (only the helper creates it).
sd="${IA_TW_STATE_DIR:-}"
if [ -z "$sd" ]; then
  sentinel="${IA_TW_STATE_ROOT:-$HOME/.claude/team-workflow/state}/.current"
  [ -f "$sentinel" ] && sd="$(cat "$sentinel" 2>/dev/null || true)"
fi
[ -n "$sd" ] || exit 0
[ -d "$sd" ] || exit 0
[ -f "$sd/messages.md" ] || exit 0

iso_now() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

# Normalise an actor string: strip a leading plugin prefix (`plugin:name` → `name`)
# and lowercase non-empty values. Empty input → "agent".
actor_norm() {
  local raw="${1:-}"
  raw="${raw##*:}"
  [ -n "$raw" ] || raw="agent"
  printf '%s' "$raw" | tr '[:upper:]' '[:lower:]'
}

# Read the last assistant message from a JSONL transcript and concatenate
# its text blocks. macOS-friendly (uses awk, not tac).
read_transcript_tail() {
  local tp="$1"
  [ -n "$tp" ] && [ -f "$tp" ] || return 0
  awk '/"role"[[:space:]]*:[[:space:]]*"assistant"/ { last=$0 } END { if (last) print last }' \
    "$tp" 2>/dev/null \
    | jq -r '
      if .message.content then
        [ .message.content[]? | select(.type=="text") | .text ] | join("\n")
      elif .content then
        [ .content[]? | select(.type=="text") | .text ] | join("\n")
      else "" end
    ' 2>/dev/null
}

# Append one entry. Skips empty text to avoid noise.
emit() {
  local actor="$1" text="$2"
  [ -n "$text" ] || return 0
  actor=$(actor_norm "$actor")
  {
    printf '\n## %s · %s\n\n' "$(iso_now)" "$actor"
    printf '%s\n' "$text"
  } >> "$sd/messages.md" 2>/dev/null || true
}

case "$mode" in
  user-prompt)
    text=$(printf '%s' "$payload" | jq -r '.prompt // empty' 2>/dev/null)
    # Slack inbounds arrive wrapped in slack-bridge's channel envelope:
    #   <channel ...>
    #   [slack-bridge] <claim reminder paragraph>
    #
    #   <actual user message>
    #   </channel>
    # The wrapper + claim reminder is noise for the conversation log —
    # strip both and keep only the user's message. Local terminal
    # prompts (no envelope) are emitted verbatim.
    if printf '%s' "$text" | head -n1 | grep -q '^<channel '; then
      text=$(printf '%s' "$text" | awk '
        BEGIN { in_channel = 0; past_reminder = 0 }
        /^<channel / { in_channel = 1; next }
        /^<\/channel>/ { in_channel = 0; next }
        in_channel == 1 && past_reminder == 0 {
          if ($0 == "") { past_reminder = 1 }
          next
        }
        { print }
      ')
    fi
    emit "user" "$text"
    ;;

  agent-stop)
    tp=$(printf '%s' "$payload" | jq -r '.transcript_path // empty' 2>/dev/null)
    text=$(read_transcript_tail "$tp")
    emit "${IA_TW_AGENT:-agent}" "$text"
    ;;

  subagent-stop)
    tp=$(printf '%s' "$payload" | jq -r '.transcript_path // empty' 2>/dev/null)
    text=$(read_transcript_tail "$tp")
    # Claude Code's SubagentStop payload uses `.agent_name` (matching the
    # field consumed by `subagent-stop.sh` for state.md events). Fall back
    # to `.subagent_type` for compatibility, then to the literal "subagent"
    # as a last resort.
    actor=$(printf '%s' "$payload" \
      | jq -r '.agent_name // .subagent_type // "subagent"' \
        2>/dev/null)
    emit "$actor" "$text"
    ;;

  tool-use)
    tool=$(printf '%s' "$payload" | jq -r '.tool_name // empty' 2>/dev/null)
    case "$tool" in
      reply|*reply|reply_update|*reply_update)
        text=$(printf '%s' "$payload" \
          | jq -r '.tool_input.text // .tool_input.message // .tool_input.content // empty' \
            2>/dev/null)
        emit "${IA_TW_AGENT:-router}" "$text"
        ;;
      # claim_message has no message text in its tool_input; rely on the
      # UserPromptSubmit injection for Slack inbound capture.
      *) : ;;
    esac
    ;;

  *)
    : ;;
esac

printf '{}\n'
exit 0
