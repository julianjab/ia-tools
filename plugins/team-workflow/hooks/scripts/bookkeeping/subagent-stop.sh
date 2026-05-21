#!/usr/bin/env bash
# SubagentStop hook — appends structured agent-run metadata to state.md events block.
#
# Bucket:      bookkeeping
# Listens to:  SubagentStop
# Blocking:    no (always exit 0)
# Input  (stdin JSON): { "agent_name", "exit_code", "output", "task": { "subject" }, ... }
# Output: exit 0 always; writes an events: entry to state.md when applicable.
#
# Fires when a one-shot Agent() subagent finishes. Captures agent name, task,
# exit code, and a short output excerpt into state.md as a structured events: list.
# This gives session-end a curated pre-memory instead of raw transcript parsing.
#
# No LLM call — fast, cheap, and safe to run on every subagent stop.

set -u

payload=$(cat)

[ -n "${IA_TW_STATE_DIR:-}" ] || exit 0
state_file="${IA_TW_STATE_DIR}/state.md"
[ -f "$state_file" ] || exit 0

agent_name=$(printf '%s' "$payload" | jq -r '.agent_name // empty'    2>/dev/null)
exit_code=$(printf '%s'  "$payload" | jq -r '.exit_code  // "0"'      2>/dev/null)
task_subj=$(printf '%s'  "$payload" | jq -r '.task.subject // empty'   2>/dev/null)
raw_output=$(printf '%s' "$payload" | jq -r '.output // empty'         2>/dev/null)
ts=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

[ -n "$agent_name" ] || exit 0

# Idempotency (S8): skip if this exact ts+agent+task combo is already recorded.
# SubagentStop can refire on transient hook retries; dedupe by composite key.
dedupe_key="ts: ${ts}"
if grep -qF "$dedupe_key" "$state_file" 2>/dev/null \
   && grep -A 4 -F "$dedupe_key" "$state_file" 2>/dev/null \
      | grep -qF "agent: ${agent_name}" 2>/dev/null; then
  exit 0
fi

# One-line summary: last 400 chars of output, collapsed to single line.
note=""
if [ -n "$raw_output" ]; then
  note=$(printf '%s' "$raw_output" \
    | tail -c 400 \
    | tr '\n\r\t' '   ' \
    | sed 's/[[:space:]]\+/ /g' \
    | sed 's/^[[:space:]]*//' \
    | sed 's/[[:space:]]*$//' \
    | sed 's/"/\\"/g')
fi

# Insert the event entry inside the YAML frontmatter, before the closing `---`.
# Previously this appended to EOF, which placed events after the frontmatter
# in the markdown body — incompatible with the lead/session-end YAML parser
# (S14: structured output must land in the right place). awk single-pass:
#   - Track frontmatter state (between the two `---` lines).
#   - On the closing `---`, emit `events:` header if missing, then the entry,
#     then the dash itself.
tmp=$(mktemp 2>/dev/null) || tmp=""
if [ -n "$tmp" ]; then
  awk -v ts="$ts" -v agent="$agent_name" -v task="$task_subj" \
      -v exitc="$exit_code" -v note="$note" '
    BEGIN { state = "pre"; has_events_header = 0 }
    state == "pre" && /^---$/ { state = "front"; print; next }
    state == "front" && /^---$/ {
      if (has_events_header == 0) print "events:"
      printf "  - ts: %s\n",     ts
      printf "    agent: %s\n",  agent
      if (task != "")  printf "    task: %s\n", task
      printf "    exit_code: %s\n", exitc
      if (note != "")  printf "    note: \"%s\"\n", note
      state = "body"
      print
      next
    }
    state == "front" && /^events:[[:space:]]*$/ { has_events_header = 1 }
    { print }
  ' "$state_file" > "$tmp" 2>/dev/null

  if [ -s "$tmp" ]; then
    cat "$tmp" > "$state_file" 2>/dev/null || true
  fi
  rm -f "$tmp" 2>/dev/null || true
fi

exit 0
