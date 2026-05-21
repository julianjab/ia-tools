#!/usr/bin/env bash
# SessionStart hook — re-exports team-workflow env vars into CLAUDE_ENV_FILE.
#
# Bucket:      bookkeeping
# Listens to:  SessionStart
# Blocking:    no (always exit 0)
# Input  (stdin JSON): { "startup_mode": "startup|resume|clear|compact", ... }
# Output: writes to $CLAUDE_ENV_FILE; always exit 0.
#
# start-lead.sh exports IA_TW_* at boot, but after a /resume or context
# compaction those variables are not automatically re-injected into subsequent
# Bash tool calls. This hook writes them into CLAUDE_ENV_FILE so they persist
# for the full session lifetime, including after resume.
#
# Also derives IA_TW_STATE_DIR when it is missing (e.g. cold /resume where
# start-lead.sh did not run again).

set -u

payload=$(cat)
startup_mode=$(printf '%s' "$payload" | jq -r '.startup_mode // empty' 2>/dev/null)

# Only relevant in a team-workflow lead session.
[ -n "${IA_TW_FEATURE:-}" ] || exit 0
[ -n "${IA_TW_TOPIC:-}" ]   || exit 0
[ -n "${CLAUDE_ENV_FILE:-}" ] || exit 0

env_already_written=0
if [ -f "$CLAUDE_ENV_FILE" ] \
   && grep -qF "export IA_TW_FEATURE=" "$CLAUDE_ENV_FILE" 2>/dev/null \
   && grep -qF "${IA_TW_FEATURE}" "$CLAUDE_ENV_FILE" 2>/dev/null; then
  env_already_written=1
fi

# Re-inject known vars when CLAUDE_ENV_FILE does not yet declare them.
# Idempotency (S8): SessionStart fires on startup AND every resume / clear /
# compact. A previous version appended 3-4 lines per fire, so the env file
# grew unbounded with redundant exports. The flag above gates that write.
# Best-effort (S9): the env file may be read-only or on a full filesystem;
# the hook must never crash the session for a bookkeeping write.
if [ "$env_already_written" -eq 0 ]; then
  {
    printf 'export IA_TW_FEATURE=%q\n'  "${IA_TW_FEATURE}"
    printf 'export IA_TW_TOPIC=%q\n'    "${IA_TW_TOPIC}"
    printf 'export IA_TW_ROOT_DIR=%q\n' "${IA_TW_ROOT_DIR:-}"
  } >> "$CLAUDE_ENV_FILE" 2>/dev/null || true
fi

# Derive state dir if missing.
if [ -z "${IA_TW_STATE_DIR:-}" ]; then
  if command -v python3 >/dev/null 2>&1; then
    topic_input="${IA_TW_TOPIC}"
    [ "$IA_TW_TOPIC" = "local" ] && topic_input="local:${IA_TW_FEATURE}"
    topic_hash=$(printf '%s' "$topic_input" | python3 -c \
      "import sys,hashlib; print(hashlib.sha1(sys.stdin.read().encode()).hexdigest()[:12])" 2>/dev/null)
  elif command -v shasum >/dev/null 2>&1; then
    topic_hash=$(printf '%s' "${IA_TW_TOPIC}" | shasum -a 1 2>/dev/null | cut -c1-12)
  else
    exit 0
  fi

  [ -n "${topic_hash:-}" ] || { printf '{}'; exit 0; }
  state_dir="${HOME}/.claude/team-workflow/state/${topic_hash}"
  mkdir -p "$state_dir" 2>/dev/null || true
  if [ "$env_already_written" -eq 0 ]; then
    printf 'export IA_TW_STATE_DIR=%q\n' "$state_dir" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true
  fi
  resolved_state_dir="$state_dir"
else
  if [ "$env_already_written" -eq 0 ]; then
    printf 'export IA_TW_STATE_DIR=%q\n' "${IA_TW_STATE_DIR}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true
  fi
  resolved_state_dir="${IA_TW_STATE_DIR}"
fi

# On resume / clear / compact, the session lost its /add-dir registrations
# for each worktree. Nudge the lead to run `/worktree rehydrate` on its
# first turn so repo-local agent spawns work again. The helper script lists
# the active worktree paths so the additionalContext is concrete.
case "$startup_mode" in
  resume|clear|compact) ;;
  *) printf '{}'; exit 0 ;;
esac

state_file="${resolved_state_dir}/state.md"
[ -f "$state_file" ] || { printf '{}'; exit 0; }

helper="${CLAUDE_PLUGIN_ROOT:-}/skills/worktree/scripts/active-worktrees.sh"
[ -x "$helper" ] || { printf '{}'; exit 0; }

active_worktrees=$(bash "$helper" "$state_file" 2>/dev/null || true)
[ -n "$active_worktrees" ] || { printf '{}'; exit 0; }

context="[team-workflow SessionStart — startup_mode=${startup_mode}]
Active worktrees in state.md (one per line):
${active_worktrees}

Run /worktree rehydrate on your first turn to re-register these paths
via /add-dir. Without this, Agent(subagent_type=<repo-local-name>) calls
fail with 'agent type not found'."

if command -v python3 >/dev/null 2>&1; then
  encoded=$(printf '%s' "$context" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))")
else
  encoded=$(printf '%s' "$context" | sed 's/\\/\\\\/g; s/"/\\"/g' | awk '{printf "%s\\n", $0}' | sed '$ s/\\n$//')
  encoded="\"${encoded}\""
fi

printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":%s}}' "$encoded"
exit 0
