#!/usr/bin/env bash
# TaskCompleted hook — enforces plugin invariants 2 and 3.
#
# State location resolution order (first match wins):
#   1. $IA_TW_STATE_DIR             — team-lead (v2) at $HOME/.claude/team-workflow/state/<topic-hash>/
#   2. $cwd/.sessions/<first-label> — v1 orchestrator layout (transition support)
#
# Blocks completion (exit 2) when:
#   A) A `:pr` task is marked completed but `state.md` (v2) or `prs.md` (v1)
#      lacks a `security: APPROVED for <worktree_prefix>` marker.
#   B) A `:green` / `:impl:` task is marked completed but no
#      `qa:red completed <worktree_prefix>` marker exists in state.md /
#      audit log.
#
# Without a state dir to consult, we allow (no false negatives).
#
# Input  (stdin JSON): { "task": { "id", "subject", "status" }, "cwd" }
# Output: exit 0 (allow) or exit 2 (block, with stderr feedback).
set -u

payload=$(cat)

subject=$(printf '%s' "$payload" | jq -r '.task.subject // empty' 2>/dev/null)
status=$(printf '%s' "$payload" | jq -r '.task.status // empty' 2>/dev/null)
cwd=$(printf '%s' "$payload" | jq -r '.cwd // empty' 2>/dev/null)

[ -z "$subject" ] && { printf '{}'; exit 0; }
[ "$status" = "completed" ] || { printf '{}'; exit 0; }

# Resolve state dir.
state_dir=""
state_file=""
if [ -n "${IA_TW_STATE_DIR:-}" ] && [ -d "$IA_TW_STATE_DIR" ]; then
  state_dir="$IA_TW_STATE_DIR"
  state_file="$state_dir/state.md"
elif [ -n "$cwd" ] && [ -d "$cwd/.sessions" ]; then
  state_dir=$(find "$cwd/.sessions" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | head -n 1)
  state_file="$state_dir/prs.md"   # v1 used prs.md for the security marker
fi

worktree_prefix="${subject%%:*}"
audit_log="${state_dir:-}/hook-audit.log"

case "$subject" in
  *":pr"|*":pr:open"|*":pr:"*)
    if [ -n "$state_dir" ] && [ -f "$state_file" ]; then
      if ! grep -E "security:[[:space:]]*APPROVED[[:space:]]+for[[:space:]]+${worktree_prefix}\b" "$state_file" >/dev/null 2>&1 \
         && ! grep -iE "${worktree_prefix}.*security.*approved" "$state_file" >/dev/null 2>&1; then
        printf 'ia-tools invariant 3 violated: cannot complete %s before a matching `security: APPROVED for %s` marker exists in %s. Run the security audit and append the marker before completing the pr task.\n' \
          "$subject" "$worktree_prefix" "$state_file" >&2
        exit 2
      fi
    fi
    ;;
  *":green"|*":green:"*|*":impl:"*)
    if [ -n "$state_dir" ]; then
      # Look for the qa:red completion marker. Two equivalent forms accepted:
      #   v1 audit log:    "qa:red completed <prefix>"
      #   v2 state.md:     "✅ RED confirmed for <prefix>"
      found=0
      [ -f "$audit_log" ] && grep -E "qa:red completed ${worktree_prefix}\b" "$audit_log" >/dev/null 2>&1 && found=1
      [ -f "${state_dir}/state.md" ] && grep -E "(RED confirmed|qa:red completed)[[:space:]]+(for[[:space:]]+)?${worktree_prefix}\b" "${state_dir}/state.md" >/dev/null 2>&1 && found=1
      if [ "$found" -eq 0 ]; then
        printf 'ia-tools invariant 2 violated: cannot complete %s before qa publishes the RED-confirmed marker for worktree %s. Wait for the qa:red task on the same prefix to complete first.\n' \
          "$subject" "$worktree_prefix" >&2
        exit 2
      fi
    fi
    ;;
esac

# Audit the completion regardless.
if [ -n "$state_dir" ]; then
  printf '%s TaskCompleted subject=%q status=%s\n' \
    "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$subject" "$status" \
    >> "${state_dir}/hook-audit.log" 2>/dev/null || true
fi

printf '{}'
exit 0
