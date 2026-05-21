#!/usr/bin/env bash
# active-worktrees.sh — list the worktree paths a lead session needs registered.
#
# Usage:      active-worktrees.sh [<state-md-path>]
# Exit codes: 0 = printed zero or more paths to stdout
#             1 = state.md not found and no fallback resolution worked
#
# Source of truth: $IA_TW_STATE_DIR/state.md (or the explicit path passed as
# argv[1] for testing). Reads every `worktree:` value from the YAML
# frontmatter, drops worktrees in terminal phases (merged / closed / stopped),
# drops paths that no longer exist on disk, prints one absolute path per line
# in declaration order (no sort, no dedupe — state.md owns the order).
#
# Consumers:
#   - /worktree rehydrate            — runs /add-dir on each path
#   - hooks/scripts/bookkeeping/pre-compact.sh      — embeds the list in PreCompact summary
#   - hooks/scripts/bookkeeping/session-start.sh    — emits additionalContext on resume
#
# Best-effort. Always exits 0 when state.md is present, even if the worktree
# list is empty — the caller handles the empty case.

set -u

state_file="${1:-${IA_TW_STATE_DIR:-}/state.md}"
if [ -z "${state_file:-}" ] || [ ! -f "$state_file" ]; then
  exit 1
fi

# Parse the YAML frontmatter (between the first two `---` markers). Inside
# each `  - repo:` block, capture `worktree:` and `local_phase:`. Emit only
# entries with non-terminal local_phase. When local_phase is absent, treat
# as active (lead has not transitioned it yet).
awk '
  BEGIN { state = "pre"; in_wt = 0; cur_wt = ""; cur_phase = "" }
  /^---$/ {
    if (state == "pre") { state = "front"; next }
    if (state == "front") {
      # End of frontmatter — flush last entry then stop.
      if (cur_wt != "" && cur_phase !~ /^(merged|closed|stopped)$/) print cur_wt
      exit
    }
  }
  state != "front" { next }

  /^  - repo:/ {
    if (cur_wt != "" && cur_phase !~ /^(merged|closed|stopped)$/) print cur_wt
    in_wt = 1; cur_wt = ""; cur_phase = ""
    next
  }
  in_wt && /^[[:space:]]+worktree:[[:space:]]/ {
    cur_wt = $0; sub(/^[[:space:]]+worktree:[[:space:]]*/, "", cur_wt)
  }
  in_wt && /^[[:space:]]+local_phase:[[:space:]]/ {
    cur_phase = $0; sub(/^[[:space:]]+local_phase:[[:space:]]*/, "", cur_phase)
  }
' "$state_file" 2>/dev/null | while IFS= read -r path; do
  [ -n "$path" ] || continue
  # Drop unquoted YAML quotes if any (defensive).
  path="${path%\"}"
  path="${path#\"}"
  [ -d "$path" ] || continue
  printf '%s\n' "$path"
done

exit 0
