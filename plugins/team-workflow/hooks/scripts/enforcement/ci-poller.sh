#!/usr/bin/env bash
# Async CI poller — triggered by TaskCompleted on :pr tasks.
#
# Bucket:      enforcement (uses exit 2 to deliver async wake signal)
# Listens to:  TaskCompleted  (async: true, asyncRewake: true in hooks.json)
# Blocking:    yes (exit 2 wakes the lead session via asyncRewake)
# Input  (stdin JSON): { "task": { "id", "subject", "status" }, "cwd", ... }
# Output: exit 0 = not relevant; exit 2 = wakes Claude with stderr message.
#
# Runs in the background (asyncRewake). Polls gh pr checks until all checks
# pass or any fail, then exits 2 to wake the lead session with the result.
#
# This replaces the blocking `gh pr checks --watch` approach: lead can
# continue dispatching other unblocked tasks while CI runs.

set -u

payload=$(cat)
subject=$(printf '%s' "$payload" | jq -r '.task.subject // empty' 2>/dev/null)
status=$(printf '%s'  "$payload" | jq -r '.task.status // empty'  2>/dev/null)

[ "$status" = "completed" ] || exit 0

# Only trigger on :pr tasks.
case "$subject" in
  *":pr"|*":pr:"*) ;;
  *) exit 0 ;;
esac

# Need gh CLI and a state file with a PR URL.
command -v gh >/dev/null 2>&1 || exit 0
state_file="${IA_TW_STATE_DIR:-}/state.md"
[ -f "$state_file" ] || exit 0

# Extract the most recently added pr_url for this worktree prefix.
worktree_prefix="${subject%%:*}"
pr_url=$(grep -A 10 "wt_prefix:[[:space:]]*${worktree_prefix}" "$state_file" 2>/dev/null \
  | grep 'pr_url:' | head -1 | sed 's/[[:space:]]*pr_url:[[:space:]]*//' | grep -v '^[[:space:]]*$')

# Fallback: any pr_url in state.md.
[ -n "$pr_url" ] || pr_url=$(grep 'pr_url:' "$state_file" 2>/dev/null | tail -1 \
  | sed 's/[[:space:]]*pr_url:[[:space:]]*//' | grep -v '^[[:space:]]*$')

[ -n "$pr_url" ] || { printf 'ci-poller: no pr_url found in %s for %s — skipping CI watch.\n' "$state_file" "$subject" >&2; exit 0; }

# Poll: 30s intervals, max 20 minutes (40 attempts).
max_attempts=40
attempt=0

while [ $attempt -lt $max_attempts ]; do
  sleep 30
  attempt=$((attempt + 1))

  result=$(gh pr checks "$pr_url" --json name,state 2>/dev/null) || continue
  total=$(printf '%s' "$result" | jq 'length' 2>/dev/null)
  [ "${total:-0}" -gt 0 ] || continue

  # Any failure → wake immediately.
  failed=$(printf '%s' "$result" | jq -r \
    '[.[] | select(.state == "FAILURE" or .state == "ERROR")] | map(.name) | join(", ")' 2>/dev/null)
  if [ -n "$failed" ]; then
    printf 'CI FAILED for %s\nFailed checks: %s\nRun: gh pr checks %s\n' \
      "$pr_url" "$failed" "$pr_url" >&2
    exit 2
  fi

  # All green → wake.
  pending=$(printf '%s' "$result" | jq \
    '[.[] | select(.state != "SUCCESS" and .state != "SKIPPED")] | length' 2>/dev/null)
  if [ "${pending:-1}" -eq 0 ]; then
    printf 'CI GREEN for %s — all checks passed. Ready to proceed with :team-review.\n' "$pr_url" >&2
    exit 2
  fi
done

printf 'CI TIMEOUT for %s after %d minutes — check manually with: gh pr checks %s\n' \
  "$pr_url" "$((max_attempts / 2))" "$pr_url" >&2
exit 2
