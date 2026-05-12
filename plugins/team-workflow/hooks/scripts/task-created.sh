#!/usr/bin/env bash
# TaskCreated hook — audit + soft enforcement of ia-tools task conventions.
#
# Plugin invariants 2/3 (qa:red blocks stack:*, security blocks pr:open) are
# enforced at task-COMPLETION via task-completed.sh and via dependencies
# declared by the orchestrator in TaskUpdate. The TaskCreated payload does
# NOT include blockedBy yet, so this hook is intentionally audit-only:
# it records every task subject under .sessions/<label>/hook-audit.log
# (when present) so the orchestrator can self-check, and warns to stderr
# when a stack-or-pr task is created without a clear dependency prefix.
#
# Input  (stdin JSON, per https://code.claude.com/docs/en/hooks#taskcreated):
#   { "task": { "id", "subject", "description" }, "cwd", ... }
# Output: exit 0 (allow) — this hook never blocks creation.
set -u

payload=$(cat)

subject=$(printf '%s' "$payload" | jq -r '.task.subject // empty' 2>/dev/null)
task_id=$(printf '%s' "$payload" | jq -r '.task.id // empty' 2>/dev/null)
cwd=$(printf '%s' "$payload" | jq -r '.cwd // empty' 2>/dev/null)

[ -z "$subject" ] && { printf '{}'; exit 0; }

# Audit log — best effort. Pick the first .sessions/<label>/ under cwd if any,
# else write under .claude/ to avoid silently dropping data.
audit_dir=""
if [ -n "$cwd" ] && [ -d "$cwd/.sessions" ]; then
  audit_dir=$(find "$cwd/.sessions" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | head -n 1)
fi
[ -z "$audit_dir" ] && audit_dir="${cwd:-.}/.claude"
mkdir -p "$audit_dir" 2>/dev/null || true
printf '%s TaskCreated id=%s subject=%q\n' \
  "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$task_id" "$subject" \
  >> "$audit_dir/hook-audit.log" 2>/dev/null || true

# Soft warnings — stderr is captured by Claude Code but exit 0 means allow.
case "$subject" in
  *":qa:red"|*"qa:red")
    ;;
  *":backend:"*|*":frontend:"*|*":mobile:"*|*":impl:"*|*":green"*)
    echo "[ia-tools] note: stack task created — orchestrator must add 'blockedBy: <prefix>:qa:red' via TaskUpdate before any teammate claims it." >&2
    ;;
  *":pr"|*":pr:"*)
    echo "[ia-tools] note: pr task created — orchestrator must add 'blockedBy: <prefix>:security' via TaskUpdate before completion." >&2
    ;;
esac

printf '{}'
exit 0
