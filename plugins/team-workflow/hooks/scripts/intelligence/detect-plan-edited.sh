#!/usr/bin/env bash
# detect-plan-edited.sh — captures plan revisions during the approval gate.
#
# Bucket:      intelligence
# Listens to:  PostToolUse  (matcher: Edit|Write|MultiEdit)
# Blocking:    no (always exit 0)
# Input  (stdin JSON): { "tool_input": { "file_path": "<abs>" }, ... }
# Output: exit 0 always; appends `kind: plan_edited` to state.md events:
#         when the `## Plan aprobado` section gains a new revision while
#         phase is still `planning`.
#
# Signal: a Plan-aprobado section was previously written and is being
# overwritten or extended. We detect this by reading the BEFORE state
# (cached at $IA_TW_STATE_DIR/.plan-hash) and the AFTER state, and
# comparing content hashes. Mismatch + phase=planning → plan_edited event.
#
# This complements detect-user-correction: that fires on free-text user
# input; this one fires when the LEAD re-publishes the plan after a user
# requested edit. Both can fire for the same conversation turn — they
# capture different sides of the same correction signal.
#
# Best-effort: if the cache file is missing or content cannot be hashed,
# the hook simply records the current plan hash for the next comparison
# and exits.

set -u

payload=$(cat)

[ -n "${IA_TW_STATE_DIR:-}" ] || exit 0

file_path=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
[ -n "$file_path" ] || exit 0

# Only react to state.md edits.
case "$file_path" in
  */team-workflow/state/*/state.md) ;;
  *) exit 0 ;;
esac

[ -f "$file_path" ] || exit 0
state_file="$file_path"

# Skip terminal phases (plan body is frozen). Anything else — planning /
# implementing / prs-open / reviewing — is fair game for revisions.
phase=$(grep '^phase:' "$state_file" 2>/dev/null | head -1 | sed 's/phase:[[:space:]]*//')
case "$phase" in
  merged|closed|stopped) exit 0 ;;
esac

# Extract the Plan aprobado section body (everything between `## Plan aprobado`
# and the next `##` heading or EOF).
current_plan=$(awk '
  /^## Plan aprobado/ { in_plan = 1; next }
  in_plan && /^## / { in_plan = 0 }
  in_plan { print }
' "$state_file" 2>/dev/null | tr -d '\r')

# No plan yet — nothing to compare.
[ -n "$current_plan" ] || exit 0

cache_file="${IA_TW_STATE_DIR}/.plan-hash"
current_hash=$(printf '%s' "$current_plan" | cksum 2>/dev/null | awk '{print $1}')

# First run: record the baseline and exit (no event — there's nothing to
# compare against yet).
if [ ! -f "$cache_file" ]; then
  printf '%s\n' "$current_hash" > "$cache_file" 2>/dev/null || true
  exit 0
fi

prev_hash=$(head -1 "$cache_file" 2>/dev/null)

# Unchanged → no signal.
[ "$current_hash" = "$prev_hash" ] && exit 0

# Update cache to the new hash so the next edit is compared against THIS one.
printf '%s\n' "$current_hash" > "$cache_file" 2>/dev/null || true

# Idempotency: skip if an event with this exact hash already exists.
if grep -qF "plan_hash: ${current_hash}" "$state_file" 2>/dev/null; then
  exit 0
fi

ts=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
# Short preview of the new plan (first 200 chars, single line).
preview=$(printf '%s' "$current_plan" \
  | tr '\n\r\t' '   ' \
  | sed 's/[[:space:]]\+/ /g' \
  | sed 's/^[[:space:]]*//' \
  | cut -c1-200 \
  | sed 's/"/\\"/g')

tmp=$(mktemp 2>/dev/null) || exit 0
awk -v ts="$ts" -v hash="$current_hash" -v prev="$prev_hash" -v preview="$preview" '
  BEGIN { state = "pre"; has_events_header = 0 }
  state == "pre" && /^---$/ { state = "front"; print; next }
  state == "front" && /^---$/ {
    if (has_events_header == 0) print "events:"
    printf "  - ts: %s\n",          ts
    printf "    kind: plan_edited\n"
    printf "    plan_hash: %s\n",   hash
    printf "    prev_hash: %s\n",   prev
    printf "    preview: \"%s\"\n", preview
    state = "body"
    print
    next
  }
  state == "front" && /^events:[[:space:]]*$/ { has_events_header = 1 }
  { print }
' "$state_file" > "$tmp" 2>/dev/null

if [ -s "$tmp" ]; then
  cat "$tmp" > "$state_file" 2>/dev/null || true
fi
rm -f "$tmp" 2>/dev/null || true

exit 0
