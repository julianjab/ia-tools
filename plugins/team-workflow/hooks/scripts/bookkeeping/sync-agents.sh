#!/usr/bin/env bash
# sync-agents.sh — link/copy repo-local Claude agents into the per-session
# agent directory so the lead can spawn them by their prefixed name without
# having to run `/add-dir` at runtime (which is not model-callable in
# current Claude Code builds).
#
# Bucket:      bookkeeping (always exits 0)
# Listens to:  SessionStart  (registered in hooks/hooks.json)
# Blocking:    no
# Input:       env only (no stdin needed)
# Output:      logs to stderr; never alters claude's response
#
# What it does (idempotent):
#   1. Resolve $IA_TW_AGENT_LINK_DIR (target) and $IA_TW_STATE_DIR/state.md
#      (source of truth for touched repos). Best-effort: missing either
#      one → exit 0 (nothing to sync).
#   2. Sweep dangling/stale entries: every existing symlink whose target
#      no longer exists is removed; every regular file/symlink whose name
#      no longer maps to an active source is removed.
#   3. For each `repo:` declared in state.md, enumerate
#      `<repo>/.claude/agents/*.md` and materialize each one into
#      `$IA_TW_AGENT_LINK_DIR/<basename($repo)>-<agent-name>.md`. Strategy
#      depends on `$IA_TW_AGENT_LINK_STRATEGY`:
#        symlink (default) → `ln -sf <abs-src> <dst>`
#        copy              → `cp -f <abs-src> <dst>`
#   4. Print a one-line summary to stderr.
#
# Idempotency contract:
#   - Two consecutive runs leave the same set of files in the target dir.
#   - Adding a worktree → next run adds its agents.
#   - Removing a worktree from state.md → next run drops its agents.
#   - Editing an agent in the source repo → reflected immediately via
#     symlink; with --strategy copy, reflected on next sync.

set -u

agent_link_dir="${IA_TW_AGENT_LINK_DIR:-}"
state_dir="${IA_TW_STATE_DIR:-}"
strategy="${IA_TW_AGENT_LINK_STRATEGY:-symlink}"

[ -n "$agent_link_dir" ] || exit 0
[ -n "$state_dir" ]       || exit 0

state_md="$state_dir/state.md"
[ -f "$state_md" ] && [ -r "$state_md" ] || exit 0

mkdir -p "$agent_link_dir"

# ─── Step 1: Enumerate touched repos from state.md ─────────────────────────
# Parse YAML frontmatter (between the two leading `---` lines). Capture
# every `repo:` field declared under `worktrees:`. Awk handles nested
# indentation deterministically without needing yq.
repos_csv=$(awk '
  BEGIN { state = "pre" }
  /^---$/ {
    if (state == "pre") { state = "front"; next }
    if (state == "front") { exit }
  }
  state == "front" && /^[[:space:]]+- repo:[[:space:]]/ {
    sub(/^[[:space:]]+- repo:[[:space:]]*/, "")
    sub(/[[:space:]]+$/, "")
    print
  }
' "$state_md" 2>/dev/null | sort -u)

# ─── Step 2: Build the expected destination set (filename → src path) ─────
# We accumulate the expected destinations first, then sweep entries in
# $agent_link_dir that are NOT in this set.
declare -a wanted_names=()
declare -a wanted_targets=()

while IFS= read -r repo; do
  [ -n "$repo" ] || continue
  [ -d "$repo/.claude/agents" ] || continue
  slug=$(basename "$repo")

  while IFS= read -r -d '' agent_file; do
    agent_name=$(basename "$agent_file" .md)
    dst_name="${slug}-${agent_name}.md"
    wanted_names+=("$dst_name")
    wanted_targets+=("$agent_file")
  done < <(find "$repo/.claude/agents" -maxdepth 1 -name '*.md' -type f -print0 2>/dev/null)
done <<<"$repos_csv"

# ─── Step 3: Sweep — remove entries not in the wanted set ─────────────────
removed=0
while IFS= read -r -d '' existing; do
  name=$(basename "$existing")
  keep=0
  for w in "${wanted_names[@]+"${wanted_names[@]}"}"; do
    [ "$w" = "$name" ] && { keep=1; break; }
  done
  if [ "$keep" -eq 0 ]; then
    rm -f "$existing" 2>/dev/null && removed=$((removed + 1))
  elif [ -L "$existing" ] && [ ! -e "$existing" ]; then
    # Dangling symlink — drop and let step 4 recreate.
    rm -f "$existing" 2>/dev/null
  fi
done < <(find "$agent_link_dir" -maxdepth 1 -name '*.md' \( -type f -o -type l \) -print0 2>/dev/null)

# ─── Step 4: Materialize wanted entries (symlink or copy) ──────────────────
created=0
refreshed=0
n=${#wanted_names[@]}
i=0
while [ "$i" -lt "$n" ]; do
  name="${wanted_names[$i]}"
  src="${wanted_targets[$i]}"
  dst="$agent_link_dir/$name"

  if [ -e "$dst" ] || [ -L "$dst" ]; then
    # Already present — verify it points/matches what we want.
    if [ "$strategy" = "symlink" ] && [ -L "$dst" ]; then
      current=$(readlink "$dst" 2>/dev/null || true)
      [ "$current" = "$src" ] && { i=$((i + 1)); continue; }
    fi
    rm -f "$dst" 2>/dev/null
    refreshed=$((refreshed + 1))
  fi

  case "$strategy" in
    copy)
      cp -f "$src" "$dst" 2>/dev/null && created=$((created + 1))
      ;;
    symlink|*)
      ln -sf "$src" "$dst" 2>/dev/null && created=$((created + 1))
      ;;
  esac
  i=$((i + 1))
done

printf 'sync-agents: %d linked/copied (%d refreshed), %d stale removed → %s\n' \
  "$created" "$refreshed" "$removed" "$agent_link_dir" >&2

exit 0
