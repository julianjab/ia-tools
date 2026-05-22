#!/usr/bin/env bash
# detect-retract.sh — records marker retracts in state.md as events.
#
# Bucket:      intelligence
# Listens to:  PostToolUse  (matcher: Edit|Write|MultiEdit)
# Blocking:    no (always exit 0)
# Input  (stdin JSON): { "tool_input": { "file_path": "<abs>" }, ... }
# Output: exit 0 always; appends `kind: marker_retracted` to events: when
#         state.md acquired a `RETRACTED` marker that has no matching event.
#
# Scans the worktree markers in state.md for entries containing the word
# RETRACTED (case-insensitive) and emits one event per retract that does not
# yet have a matching record. Idempotency is by (wt_prefix, marker-text-hash).

set -u

payload=$(cat)

file_path=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
[ -n "$file_path" ] || exit 0

# Only react to state.md edits.
case "$file_path" in
  */team-workflow/state/*/state.md) ;;
  *) exit 0 ;;
esac

[ -f "$file_path" ] || exit 0
state_file="$file_path"

# Use $IA_TW_STATE_DIR if set and matching; otherwise treat the edited
# file's dir as the state dir.
state_dir=$(dirname "$state_file")
[ -n "${IA_TW_STATE_DIR:-}" ] && [ "$IA_TW_STATE_DIR" = "$state_dir" ] || true

# Find all RETRACTED marker lines, paired with their worktree prefix.
# A worktree block starts at `  - repo:` and contains a `wt_prefix:` line;
# markers live in that block's `markers:` list. We scan with awk.
retracts=$(awk '
  /^  - repo:/ { wt = "" }
  /^[[:space:]]*wt_prefix:[[:space:]]/ { gsub(/^[[:space:]]*wt_prefix:[[:space:]]*/, ""); wt = $0 }
  /RETRACTED|[Rr]etract/ && /^[[:space:]]*-[[:space:]]+/ {
    marker = $0
    gsub(/^[[:space:]]*-[[:space:]]+/, "", marker)
    gsub(/^"/, "", marker); gsub(/"$/, "", marker)
    if (wt != "") printf "%s|%s\n", wt, marker
  }
' "$state_file" 2>/dev/null)

[ -n "$retracts" ] || exit 0

ts=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

# Emit one event per NEW retract. Each call to write-event.sh appends a
# single entry; idempotency is enforced per-marker via the dedupe_key
# grep so reruns on the same state.md are no-ops.
writer="$(dirname "$0")/../lib/write-event.sh"
printf '%s\n' "$retracts" | while IFS='|' read -r wt marker; do
  [ -n "$wt" ] || continue
  key_hash=$(printf '%s|%s' "$wt" "$marker" | cksum 2>/dev/null | awk '{print $1}')
  if grep -qF "marker_retracted:${key_hash}" "$state_file" 2>/dev/null; then
    continue
  fi
  jq -n \
    --arg ts       "$ts" \
    --arg wt       "$wt" \
    --arg marker   "$marker" \
    --arg key_hash "$key_hash" '{
      ts:         $ts,
      kind:       "marker_retracted",
      wt_prefix:  $wt,
      marker:     $marker,
      dedupe_key: ("marker_retracted:" + $key_hash)
    }' \
    | IA_TW_STATE_DIR="$state_dir" bash "$writer" || true
done

exit 0
