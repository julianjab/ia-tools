#!/usr/bin/env bash
# PreCompact hook — injects state context into the compaction summary.
#
# When lead compacts mid-dispatch, the resulting summary must include enough
# context to resume without re-running pre-analysis. This hook reads state.md
# and the audit log and emits additionalContext so the compactor includes
# phase, worktrees, and recent task events in the summary.
#
# Does NOT block compaction (never exits 2). Only injects context.
#
# Input  (stdin JSON): { "trigger": "auto|manual", "cwd", ... }
# Output: JSON with hookSpecificOutput.additionalContext, or {} if no state.

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

Recent task events (last 15):
${recent_events}

On resume: read ${state_file} to reconstruct worktrees + agent map, then continue dispatch loop from phase=${phase}. Do NOT re-run pre-analysis."

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
