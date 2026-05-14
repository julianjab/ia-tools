#!/usr/bin/env bash
# SessionEnd hook — auto-consolidates feature memory when a lead session ends.
#
# If state.md has phase=merged, appends a summary entry to the global
# agent-memory for lead. This is the safety net for when the lead's inline
# cleanup step (manual memory write) did not execute — e.g. session killed,
# crash, or compaction-driven stop.
#
# Does NOT overwrite existing memory entries (append-only).
# Does NOT run when phase != merged (incomplete features keep no memory).
#
# Input  (stdin JSON): { "end_reason": "logout|...", "cwd", ... }
# Output: always exit 0 (SessionEnd is non-blocking).

set -u

[ -n "${IA_TW_STATE_DIR:-}" ] || exit 0
state_file="${IA_TW_STATE_DIR}/state.md"
[ -f "$state_file" ] || exit 0

phase=$(grep '^phase:' "$state_file" 2>/dev/null | head -1 | sed 's/phase:[[:space:]]*//')
[ "$phase" = "merged" ] || exit 0

feature=$(grep '^feature:' "$state_file"   2>/dev/null | head -1 | sed 's/feature:[[:space:]]*//')
topic=$(grep   '^topic:'   "$state_file"   2>/dev/null | head -1 | sed 's/topic:[[:space:]]*//')
date_now=$(date -u '+%Y-%m-%d')

# Locate agent-memory dir.
memory_dir="${IA_TW_ROOT_DIR:-.}/.claude/agent-memory/lead"
mkdir -p "$memory_dir" 2>/dev/null || true
memory_file="${memory_dir}/MEMORY.md"

# Skip if this feature was already recorded (idempotent).
if grep -q "^## ${date_now}.*${feature}" "$memory_file" 2>/dev/null; then
  exit 0
fi

# Collect PR URLs and stacks from state.md.
pr_urls=$(grep  'pr_url:' "$state_file" 2>/dev/null | sed 's/[[:space:]]*pr_url:[[:space:]]*//' | grep -v '^[[:space:]]*$' | tr '\n' ' ')
stacks=$(grep   'stack:'  "$state_file" 2>/dev/null | sed 's/[[:space:]]*stack:[[:space:]]*//' | sort -u | tr '\n' ' ')
prefixes=$(grep 'wt_prefix:' "$state_file" 2>/dev/null | sed 's/[[:space:]]*wt_prefix:[[:space:]]*//' | tr '\n' ' ')

{
  printf '\n## %s — %s\n' "$date_now" "$feature"
  printf '- topic: %s\n'    "${topic:-unknown}"
  printf '- stacks: %s\n'   "${stacks:-unknown}"
  printf '- prefixes: %s\n' "${prefixes:-unknown}"
  printf '- PRs: %s\n'      "${pr_urls:-none}"
  printf '- state_dir: %s\n' "$IA_TW_STATE_DIR"
} >> "$memory_file" 2>/dev/null || true

exit 0
