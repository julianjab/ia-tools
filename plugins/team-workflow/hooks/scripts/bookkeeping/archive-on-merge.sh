#!/usr/bin/env bash
# archive-on-merge.sh — preserve state.md + hook-audit.log to a
# persistent archive when the feature reaches phase=merged or closed.
#
# Bucket:      bookkeeping (always exits 0)
# Listens to:  SessionEnd  (registered in hooks/hooks.json)
# Blocking:    no
# Input:       env only
# Output:      logs to stderr
#
# Why this exists:
#   When $IA_TW_STATE_ROOT is set to a volatile location (e.g.
#   /tmp/claude/team-workflow), the state dir disappears on reboot or
#   OS-level temp cleanup. The memory + audit trail of a completed
#   feature is too valuable to lose. This hook copies the immutable
#   artifacts to $IA_TW_ARCHIVE_DIR (which always lives under $HOME)
#   the moment a session ends with state.md.phase ∈ {merged, closed}.
#
# Idempotency contract:
#   - Re-running with the same phase overwrites with identical content.
#   - Re-running before phase=merged is a silent no-op.
#   - Re-running after $IA_TW_ARCHIVE_ON_MERGE=0 is a silent no-op.
#
# Skip conditions (any of these → exit 0 without doing anything):
#   - IA_TW_ARCHIVE_ON_MERGE != "1"
#   - IA_TW_ARCHIVE_DIR unset / empty
#   - IA_TW_STATE_DIR unset / empty
#   - state.md missing
#   - state.md frontmatter has no phase, or phase ∉ {merged, closed}

set -u

[ "${IA_TW_ARCHIVE_ON_MERGE:-1}" = "1" ] || exit 0

archive_dir="${IA_TW_ARCHIVE_DIR:-}"
state_dir="${IA_TW_STATE_DIR:-}"

[ -n "$archive_dir" ] || exit 0
[ -n "$state_dir" ]   || exit 0

state_md="$state_dir/state.md"
[ -f "$state_md" ] && [ -r "$state_md" ] || exit 0

# ─── Parse phase from YAML frontmatter ─────────────────────────────────────
phase=$(awk '
  BEGIN { state = "pre" }
  /^---$/ {
    if (state == "pre")   { state = "front"; next }
    if (state == "front") { exit }
  }
  state == "front" && /^phase:[[:space:]]/ {
    sub(/^phase:[[:space:]]*/, "")
    sub(/[[:space:]]+$/, "")
    print
    exit
  }
' "$state_md" 2>/dev/null)

case "$phase" in
  merged|closed) ;;
  *) exit 0 ;;
esac

# ─── Mirror artifacts ──────────────────────────────────────────────────────
mkdir -p "$archive_dir" 2>/dev/null || exit 0

archived=0
for src_name in state.md hook-audit.log session-env.yaml api-contract.md; do
  src="$state_dir/$src_name"
  [ -f "$src" ] || continue
  dst="$archive_dir/$src_name"
  if cp -f "$src" "$dst" 2>/dev/null; then
    archived=$((archived + 1))
  fi
done

# Also mirror any memory file the lead may have written under $state_dir.
if [ -d "$state_dir/memory" ]; then
  cp -rf "$state_dir/memory" "$archive_dir/" 2>/dev/null \
    && archived=$((archived + 1))
fi

# Mark the archive as complete with a sentinel + timestamp so resume
# logic can detect previously-archived sessions.
{
  printf 'phase: %s\n'      "$phase"
  printf 'archived_at: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  printf 'source_state_dir: %s\n' "$state_dir"
} > "$archive_dir/ARCHIVED" 2>/dev/null

printf 'archive-on-merge: phase=%s, %d artifacts → %s\n' \
  "$phase" "$archived" "$archive_dir" >&2

exit 0
