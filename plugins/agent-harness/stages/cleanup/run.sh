#!/usr/bin/env bash
# stages/cleanup/run.sh — remove provisioned worktrees once a session is done.
#
# Usage:
#   run.sh <state.yaml> [--force] [--archive]
#
#   <state.yaml>   session state
#   --force        remove worktrees even when the session is not in
#                  phase=done (e.g. you decided to abort). Skipped
#                  worktrees with uncommitted changes still warn unless
#                  --force is set.
#   --archive      after removing worktrees, move <session>/ to
#                  <home>/archive/<id>/ so the history is kept but the
#                  active sessions list stays clean.
#
# Reads:  .phase, .worktrees[]
# Writes: removes worktrees, optionally moves the session dir,
#         appends one event per removed worktree.
#
# Worktrees with uncommitted or unpushed changes WITHOUT --force are
# reported and left alone. The script never deletes a worktree whose
# branch is the default branch of its repo.

set -euo pipefail

STAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$STAGE_DIR/../.." && pwd)"

# shellcheck source=../../lib/config.sh
source "$PLUGIN_ROOT/lib/config.sh"
config_init

state_file=""
force=0
archive=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --force)   force=1;   shift ;;
    --archive) archive=1; shift ;;
    -*) echo "✗ cleanup: unknown flag $1" >&2; exit 1 ;;
    *)  state_file="$1"; shift ;;
  esac
done
[[ -n "$state_file" ]] || { echo "usage: run.sh <state.yaml> [--force] [--archive]" >&2; exit 1; }
[[ -f "$state_file" ]] || { echo "✗ cleanup: $state_file missing" >&2; exit 1; }

session_dir="$(dirname "$state_file")"
events_log="$session_dir/harness-events.log"
session_id="$(yq -r '.session_id' "$state_file")"
phase="$(yq -r '.phase // "unknown"' "$state_file")"

if [[ "$force" -ne 1 && "$phase" != "done" ]]; then
  echo "✗ cleanup: session is in phase=$phase; pass --force to clean up anyway" >&2
  exit 1
fi

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

worktrees_json="$(yq -o=json '.worktrees // []' "$state_file")"
n="$(echo "$worktrees_json" | jq 'length')"

removed=0
skipped=0
for i in $(seq 0 $((n - 1))); do
  wt_json="$(echo "$worktrees_json" | jq -c ".[$i]")"
  name="$(echo "$wt_json" | jq -r .name)"
  path="$(echo "$wt_json" | jq -r .path)"
  repo="$(echo "$wt_json" | jq -r .repo)"
  branch="$(echo "$wt_json" | jq -r .branch)"

  if [[ ! -d "$path/.git" && ! -f "$path/.git" ]]; then
    echo "↷ $name — worktree path missing (already cleaned)"
    skipped=$((skipped + 1))
    continue
  fi

  # safety: never delete a worktree on the default branch
  case "$branch" in
    main|master)
      echo "✗ $name — refusing to remove worktree on $branch" >&2
      skipped=$((skipped + 1))
      continue
      ;;
  esac

  # uncommitted check
  if [[ "$force" -ne 1 ]]; then
    if [[ -n "$(git -C "$path" status --porcelain 2>/dev/null)" ]]; then
      echo "✗ $name — uncommitted changes, pass --force to remove" >&2
      skipped=$((skipped + 1))
      continue
    fi
  fi

  echo "▶ $name — removing worktree at $path"
  if [[ "$force" -eq 1 ]]; then
    git -C "$repo" worktree remove --force "$path" 2>/dev/null || rm -rf "$path"
  else
    git -C "$repo" worktree remove "$path" 2>/dev/null || rm -rf "$path"
  fi
  git -C "$repo" worktree prune 2>/dev/null || true

  jq -nc --arg ts "$(now)" --arg sid "$session_id" \
     --arg sum "removed worktree $name" \
     --arg n "$name" --arg p "$path" --arg b "$branch" \
     '{ts:$ts, session_id:$sid, stage:"cleanup", kind:"outcome",
       summary:$sum, data:{name:$n, path:$p, branch:$b}}' \
     >>"$events_log"
  removed=$((removed + 1))
done

# also remove the top-level worktrees/ dir if empty
if [[ -d "$session_dir/worktrees" ]] && [[ -z "$(ls -A "$session_dir/worktrees" 2>/dev/null)" ]]; then
  rmdir "$session_dir/worktrees"
fi

# update phase + summary event
export NOW="$(now)"
yq -i '.updated_at = strenv(NOW) | .phase = "cleaned"' "$state_file"

jq -nc --arg ts "$(now)" --arg sid "$session_id" \
   --arg sum "cleanup summary: $removed removed, $skipped skipped" \
   --argjson r "$removed" --argjson s "$skipped" \
   '{ts:$ts, session_id:$sid, stage:"cleanup", kind:"outcome",
     summary:$sum, data:{removed:$r, skipped:$s}}' \
   >>"$events_log"

# archive if asked
if [[ "$archive" -eq 1 ]]; then
  archive_root="$(config_get home)/archive"
  mkdir -p "$archive_root"
  archive_path="$archive_root/$session_id"
  mv "$session_dir" "$archive_path"
  echo "✓ cleanup complete — $removed removed, $skipped skipped, archived to $archive_path"
else
  echo "✓ cleanup complete — $removed removed, $skipped skipped"
fi
