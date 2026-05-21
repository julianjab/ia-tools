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

# Build a temp file with NEW events that are not yet recorded.
new_events=$(mktemp 2>/dev/null) || exit 0
printf '%s\n' "$retracts" | while IFS='|' read -r wt marker; do
  [ -n "$wt" ] || continue
  # Dedupe key: a short hash of the marker text + wt_prefix.
  key_hash=$(printf '%s|%s' "$wt" "$marker" | cksum 2>/dev/null | awk '{print $1}')
  if grep -qF "marker_retracted:${key_hash}" "$state_file" 2>/dev/null; then
    continue
  fi
  # Escape quotes in marker.
  esc_marker=${marker//\"/\\\"}
  {
    printf '  - ts: %s\n'                 "$ts"
    printf '    kind: marker_retracted\n'
    printf '    wt_prefix: %s\n'          "$wt"
    printf '    marker: "%s"\n'           "$esc_marker"
    printf '    dedupe_key: marker_retracted:%s\n' "$key_hash"
  } >> "$new_events"
done

if [ ! -s "$new_events" ]; then
  rm -f "$new_events"
  exit 0
fi

# Insert the new events into state.md before the closing ---.
# Note: BSD awk on macOS rejects newlines inside -v values, so we pass the
# events blob as a file path and slurp it via getline from awk.
tmp=$(mktemp 2>/dev/null) || { rm -f "$new_events"; exit 0; }
awk -v blob_file="$new_events" '
  BEGIN { state = "pre"; has_events_header = 0 }
  state == "pre" && /^---$/ { state = "front"; print; next }
  state == "front" && /^---$/ {
    if (has_events_header == 0) print "events:"
    while ((getline line < blob_file) > 0) print line
    close(blob_file)
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
rm -f "$tmp" "$new_events" 2>/dev/null || true

exit 0
