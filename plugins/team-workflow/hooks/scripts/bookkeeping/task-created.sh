#!/usr/bin/env bash
# TaskCreated hook — audit + soft enforcement of ia-tools task conventions.
#
# Bucket:      bookkeeping
# Listens to:  TaskCreated
# Blocking:    no (always exit 0; soft warnings on stderr only)
# Input  (stdin JSON): { "task": { "id", "subject", "description" }, "cwd", ... }
# Output: exit 0 always; warnings on stderr.
#
# State location resolution order (first match wins):
#   1. $IA_TW_STATE_DIR             — set by team-lead (v2) at boot. Points to
#                                      $HOME/.claude/team-workflow/state/<topic-hash>/
#   2. $cwd/.sessions/<first-label> — v1 orchestrator layout (transition support)
#   3. $cwd/.claude                 — last-resort, write audit log there.
#
# This hook is intentionally audit-only — TaskCreated payload does NOT
# include blockedBy yet, so it never blocks creation. Cross-task enforcement
# happens in task-completed.sh and teammate-idle.sh.
set -u

payload=$(cat)

subject=$(printf '%s' "$payload" | jq -r '.task.subject // empty' 2>/dev/null)
task_id=$(printf '%s' "$payload" | jq -r '.task.id // empty' 2>/dev/null)
cwd=$(printf '%s' "$payload" | jq -r '.cwd // empty' 2>/dev/null)

[ -z "$subject" ] && { printf '{}'; exit 0; }

# Resolve audit dir.
audit_dir=""
if [ -n "${IA_TW_STATE_DIR:-}" ] && [ -d "$IA_TW_STATE_DIR" ]; then
  audit_dir="$IA_TW_STATE_DIR"
elif [ -n "$cwd" ] && [ -d "$cwd/.sessions" ]; then
  audit_dir=$(find "$cwd/.sessions" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | head -n 1)
fi
[ -z "$audit_dir" ] && audit_dir="${cwd:-.}/.claude"
mkdir -p "$audit_dir" 2>/dev/null || true
printf '%s TaskCreated id=%s subject=%q\n' \
  "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$task_id" "$subject" \
  >> "$audit_dir/hook-audit.log" 2>/dev/null || true

# Soft warnings — stderr is captured but exit 0 means allow.
case "$subject" in
  *":qa:red"|*"qa:red")
    ;;
  *":backend:"*|*":frontend:"*|*":mobile:"*|*":impl:"*|*":green"*)
    printf '%s\n' "[ia-tools] note: stack task created — team-lead/orchestrator must add 'blockedBy: <prefix>:qa:red' via TaskUpdate before any teammate claims it." >&2
    ;;
  *":pr"|*":pr:"*)
    printf '%s\n' "[ia-tools] note: pr task created — team-lead/orchestrator must add 'blockedBy: <prefix>:security' via TaskUpdate before completion." >&2
    ;;
esac

printf '{}'
exit 0
