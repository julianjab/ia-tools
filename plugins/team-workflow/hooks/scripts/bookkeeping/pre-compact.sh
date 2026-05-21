#!/usr/bin/env bash
# PreCompact hook — injects state context into the compaction summary.
#
# Bucket:      bookkeeping
# Listens to:  PreCompact
# Blocking:    no (always exit 0; only injects additionalContext)
# Input  (stdin JSON): { "trigger": "auto|manual", "cwd", ... }
# Output: JSON with hookSpecificOutput.additionalContext, or {} if no state.
#
# When lead compacts mid-dispatch, the resulting summary must include enough
# context to resume without re-running pre-analysis. This hook reads state.md
# and the audit log and emits additionalContext so the compactor includes
# phase, worktrees, and recent task events in the summary.

set -u

# Only relevant inside a lead session with state.
if [ -z "${IA_TW_STATE_DIR:-}" ] || [ ! -f "${IA_TW_STATE_DIR}/state.md" ]; then
  printf '{}'
  exit 0
fi

state_file="${IA_TW_STATE_DIR}/state.md"
audit_log="${IA_TW_STATE_DIR}/hook-audit.log"

phase=$(grep '^phase:' "$state_file" 2>/dev/null | head -1 | sed 's/phase:[[:space:]]*//')
feature=$(grep '^feature:' "$state_file" 2>/dev/null | head -1 | sed 's/feature:[[:space:]]*//')
topic=$(grep '^topic:' "$state_file" 2>/dev/null | head -1 | sed 's/topic:[[:space:]]*//')

# Collect wt_prefix entries and their local_phase.
worktree_summary=$(grep -E 'wt_prefix:|local_phase:' "$state_file" 2>/dev/null | paste - - | \
  sed 's/[[:space:]]*wt_prefix:[[:space:]]*/prefix=/; s/[[:space:]]*local_phase:[[:space:]]*/  phase=/' || true)

# Active worktree paths (terminal-phase / missing-on-disk entries are filtered
# out by the shared helper). Used by `/worktree rehydrate` on resume to
# re-register /add-dir.
active_worktrees=""
helper="${CLAUDE_PLUGIN_ROOT:-}/skills/worktree/scripts/active-worktrees.sh"
if [ -x "$helper" ]; then
  active_worktrees=$(bash "$helper" "$state_file" 2>/dev/null || true)
fi

# Last 15 audit events.
recent_events=""
if [ -f "$audit_log" ]; then
  recent_events=$(tail -15 "$audit_log" 2>/dev/null || true)
fi

context="[team-workflow PreCompact snapshot]
feature:     ${feature}
phase:       ${phase}
topic:       ${topic}
state_dir:   ${IA_TW_STATE_DIR}

Worktrees:
${worktree_summary}

Active worktree paths (one per line):
${active_worktrees:-(none)}

Recent task events (last 15):
${recent_events}

On resume: read ${state_file} to reconstruct worktrees + agent map, then run /worktree rehydrate to re-register the paths above via /add-dir, then continue the dispatch loop from phase=${phase}. The hook already filled in stack/agents/capabilities; pre-analysis stays cached."

# JSON-encode the context string.
if command -v python3 >/dev/null 2>&1; then
  encoded=$(printf '%s' "$context" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))")
else
  # Fallback: manual escape (covers the common cases).
  encoded=$(printf '%s' "$context" | sed 's/\\/\\\\/g; s/"/\\"/g' | awk '{printf "%s\\n", $0}' | sed '$ s/\\n$//')
  encoded="\"${encoded}\""
fi

printf '{"hookSpecificOutput":{"hookEventName":"PreCompact","additionalContext":%s}}' "$encoded"
exit 0
