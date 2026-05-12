#!/usr/bin/env bash
# TaskCompleted hook — enforces plugin invariants 3 and 4.
#
# Blocks completion (exit 2) when:
#   A) A task whose subject ends in `:pr` (or `:pr:open`) is marked
#      completed but the orchestrator has NOT recorded a matching
#      `security: APPROVED` line in .sessions/<label>/prs.md for the same
#      worktree prefix. This catches accidental "/pr" runs that bypass the
#      security gate.
#   B) A task whose subject contains `:green` / `:impl:` is marked
#      completed but no `:qa:red` task with the same worktree prefix has
#      been completed yet. Catches teammates marking themselves green
#      before qa publishes RED-confirmed.
#
# Detection uses the audit log written by task-created.sh + a forward scan
# of `prs.md` when present. The hook is conservative: when state is
# ambiguous (no .sessions/ dir, no audit log), it allows the completion.
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

# Find the active .sessions/<label>/ dir, if any. Without one we can't
# reason about cross-task state, so we allow.
session_dir=""
if [ -n "$cwd" ] && [ -d "$cwd/.sessions" ]; then
  session_dir=$(find "$cwd/.sessions" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | head -n 1)
fi

worktree_prefix="${subject%%:*}"

audit_log="$session_dir/hook-audit.log"
prs_md="$session_dir/prs.md"

case "$subject" in
  *":pr"|*":pr:open"|*":pr:"*)
    if [ -n "$session_dir" ] && [ -f "$prs_md" ]; then
      if ! grep -E "^- *${worktree_prefix}[[:space:]]+security[: ]+APPROVED" "$prs_md" >/dev/null 2>&1 \
         && ! grep -iE "${worktree_prefix}.*security.*approved" "$prs_md" >/dev/null 2>&1; then
        printf 'ia-tools invariant 3 violated: cannot complete %s before a matching `security: APPROVED` entry exists in %s for worktree %s. Run the security audit and record the verdict before completing the pr task.\n' \
          "$subject" "$prs_md" "$worktree_prefix" >&2
        exit 2
      fi
    fi
    ;;
  *":green"|*":green:"*|*":impl:"*)
    if [ -n "$session_dir" ] && [ -f "$audit_log" ]; then
      # Look for a completed qa:red marker. We log creation only, so we
      # also look for a manual marker line `qa:red completed <prefix>` that
      # the qa agent appends via its skill.
      if ! grep -E "qa:red completed ${worktree_prefix}\b" "$audit_log" >/dev/null 2>&1; then
        printf 'ia-tools invariant 2 violated: cannot complete %s before qa publishes "RED confirmed" for worktree %s. Wait for qa:red on the same prefix to complete first.\n' \
          "$subject" "$worktree_prefix" >&2
        exit 2
      fi
    fi
    ;;
esac

# Audit the completion regardless.
if [ -n "$session_dir" ]; then
  printf '%s TaskCompleted subject=%q status=%s\n' \
    "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$subject" "$status" \
    >> "$session_dir/hook-audit.log" 2>/dev/null || true
fi

printf '{}'
exit 0
