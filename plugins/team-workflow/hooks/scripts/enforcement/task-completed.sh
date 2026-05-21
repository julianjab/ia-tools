#!/usr/bin/env bash
# TaskCompleted hook — enforces plugin invariants 2 and 3.
#
# Bucket:      enforcement
# Listens to:  TaskCompleted
# Blocking:    yes (exit 2 with stderr feedback)
# Input  (stdin JSON): { "task": { "id", "subject", "status" }, "cwd" }
# Output: empty `{}` + exit 0 (allow) or stderr message + exit 2 (block).
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
      # Look for the qa:red completion marker. Three equivalent forms accepted:
      #   v1 audit log:    "qa:red completed <prefix>"
      #   v2 state.md:     "✅ RED confirmed for <prefix>"
      #   qa skipped:      "qa: skipped for <prefix>"  (infra/config/no-logic changes)
      found=0
      [ -f "$audit_log" ] && grep -E "qa:red completed ${worktree_prefix}\b" "$audit_log" >/dev/null 2>&1 && found=1
      [ -f "${state_dir}/state.md" ] && grep -E "(RED confirmed|qa:red completed)[[:space:]]+(for[[:space:]]+)?${worktree_prefix}\b" "${state_dir}/state.md" >/dev/null 2>&1 && found=1
      [ -f "${state_dir}/state.md" ] && grep -E "qa:[[:space:]]*skipped[[:space:]]+(for[[:space:]]+)?${worktree_prefix}\b" "${state_dir}/state.md" >/dev/null 2>&1 && found=1
      if [ "$found" -eq 0 ]; then
        printf 'ia-tools invariant 2 violated: cannot complete %s before qa publishes the RED-confirmed marker for worktree %s. Either complete the qa:red task, or write "qa: skipped for %s" in state.md if QA is not applicable (infra/config/docs change).\n' \
          "$subject" "$worktree_prefix" "$worktree_prefix" >&2
        exit 2
      fi

      # Staging contract: staged_files must be declared in state.md for this worktree.
      # Looks in the 30 lines following the wt_prefix entry (covers the whole worktree block).
      if [ -f "${state_dir}/state.md" ]; then
        if ! grep -A 30 "wt_prefix:[[:space:]]*${worktree_prefix}" "${state_dir}/state.md" 2>/dev/null \
             | grep -q "staged_files:" 2>/dev/null; then
          printf 'ia-tools staging contract violated: cannot complete %s without staged_files: in state.md for worktree %s. Stage the exact commit set with git add <file-list>, verify with git -C <wt> diff --cached --name-only, then add staged_files: to the worktree entry before marking green.\n' \
            "$subject" "$worktree_prefix" >&2
          exit 2
        fi
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

# Structured bookkeeping into state.md: append an `events:` entry and
# transition the worktree's `local_phase`. Best-effort — only runs when v2
# state.md exists and the subject matches a known role. Idempotency is not
# guaranteed at the hook layer; SessionEnd downstream can dedupe by ts+subject.
if [ -n "${state_dir:-}" ] && [ -f "${state_dir}/state.md" ] && [ -n "$worktree_prefix" ]; then
  state_md="${state_dir}/state.md"
  ts=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

  # Marker→phase mapping for this subject.
  new_phase=""
  case "$subject" in
    *":qa:red"|*":qa:red:"*)        new_phase="red-confirmed" ;;
    *":impl:green"|*":impl:"*|*":green"|*":green:"*) new_phase="green" ;;
    *":security"|*":security:"*|*":sec"|*":sec:"*)    new_phase="security-approved" ;;
    *":pr"|*":pr:open"|*":pr:"*)    new_phase="pr-open" ;;
  esac

  tmp=$(mktemp 2>/dev/null) || tmp=""
  if [ -n "$tmp" ]; then
    awk -v prefix="$worktree_prefix" \
        -v new_phase="$new_phase" \
        -v ts="$ts" \
        -v subject="$subject" '
      BEGIN { state = "pre"; has_events_header = 0; matched = 0; inserted = 0 }

      state == "pre" && /^---$/ { state = "front"; print; next }

      state == "front" && /^---$/ {
        if (has_events_header == 0) print "events:"
        print "  - ts: " ts
        print "    kind: task_completed"
        print "    subject: \"" subject "\""
        print "    wt_prefix: " prefix
        state = "body"
        print
        inserted = 1
        next
      }

      state == "front" && /^events:[[:space:]]*$/ { has_events_header = 1 }
      state == "front" && /^last_event_at:[[:space:]]/ {
        sub(/last_event_at:[[:space:]]*.*/, "last_event_at: " ts)
      }
      state == "front" && /^  - repo:/ { matched = 0 }
      state == "front" && matched == 0 && $0 ~ ("wt_prefix:[[:space:]]*" prefix "([^[:alnum:]_-]|$)") { matched = 1 }
      state == "front" && matched == 1 && new_phase != "" && /^[[:space:]]*local_phase:[[:space:]]/ {
        sub(/local_phase:[[:space:]]*[^[:space:]]+.*/, "local_phase: " new_phase)
        matched = 2
      }

      { print }
    ' "$state_md" > "$tmp" 2>/dev/null

    # Only swap if awk produced non-empty output (guard against truncation).
    if [ -s "$tmp" ]; then
      cat "$tmp" > "$state_md" 2>/dev/null || true
    fi
    rm -f "$tmp" 2>/dev/null || true
  fi
fi

printf '{}'
exit 0
