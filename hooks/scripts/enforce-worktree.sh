#!/usr/bin/env bash
# Pipeline enforcement hook — ia-tools plugin.
#
# Two independent checks on Edit/Write/MultiEdit tool calls:
#
#  1. Worktree boundary (spawned sessions only).
#     When $IA_TOOLS_WORKTREE_BOUNDARY is set (spawn-claude.sh exports it),
#     any edit to an absolute path outside that directory is rejected. This
#     prevents a spawned Orchestrator from accidentally writing to another
#     repo during autonomous runs. For genuine multi-repo work, the engineer
#     must declare scope and the orchestrator must spawn additional worktrees.
#
#  2. Main/master protection.
#     Blocks edits to protected paths (src/, agents/, skills/, scripts/,
#     profiles/) when the current git branch is main/master. Forces the
#     ia-tools pipeline rule: every code change must happen inside a worktree
#     (see AGENTS.md rule #4).
#
# Reads Claude Code PreToolUse stdin payload and emits a JSON decision.

set -u

payload=$(cat)
file_path=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty' 2>/dev/null)

if [ -z "$file_path" ]; then
  printf '{}'
  exit 0
fi

# ── 1. Worktree-scope allow-list (only active in spawned sessions) ───────────
# Allow-list sources, in priority order:
#   a) $IA_TOOLS_WORKTREE_BOUNDARY/.sdlc/scope.json — dynamic allow-list that
#      the Orchestrator can grow at runtime when it declares extra repos.
#      Expected shape: {"worktrees": ["/abs/path/a", "/abs/path/b"]}
#   b) $IA_TOOLS_WORKTREE_BOUNDARY itself — bootstrap fallback used before the
#      scope.json exists or when jq is unavailable.
if [ -n "${IA_TOOLS_WORKTREE_BOUNDARY:-}" ]; then
  # Resolve absolute target path (file may not exist yet for Write).
  case "$file_path" in
    /*) target_abs="$file_path" ;;
    *)  target_abs="$PWD/$file_path" ;;
  esac

  allowed=""
  scope_file="${IA_TOOLS_WORKTREE_BOUNDARY}/.sdlc/scope.json"
  if [ -s "$scope_file" ] && command -v jq >/dev/null 2>&1; then
    # Space-separated list of allowed absolute paths.
    allowed=$(jq -r '.worktrees[]? // empty' "$scope_file" 2>/dev/null | tr '\n' ' ')
  fi
  # Always include the primary boundary as a safety net.
  primary_abs=$(cd "$IA_TOOLS_WORKTREE_BOUNDARY" 2>/dev/null && pwd -P || printf '%s' "$IA_TOOLS_WORKTREE_BOUNDARY")
  allowed="$allowed $primary_abs"

  in_scope=0
  for root in $allowed; do
    [ -z "$root" ] && continue
    case "$target_abs" in
      "$root"|"$root"/*)
        in_scope=1
        break
        ;;
    esac
  done

  if [ "$in_scope" -eq 0 ]; then
    scope_list=$(printf '%s' "$allowed" | sed 's/^ *//;s/ *$//')
    reason="Worktree scope violation: this spawned session is declared to operate on [${scope_list}] but the tool tried to edit ${target_abs}. If this is a genuine multi-repo task, ask the engineer to declare the extra repo, run /worktree init feat/<name> inside it, append its absolute path to .sdlc/scope.json, and /add-dir it to the session before retrying."
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}' "$reason"
    exit 0
  fi
fi

# ── 2. Main/master protection on protected paths ─────────────────────────────
case "$file_path" in
  */src/*|*/agents/*|*/skills/*|*/scripts/*|*/profiles/*)
    ;;
  *)
    printf '{}'
    exit 0
    ;;
esac

branch=$(git -C "$(dirname "$file_path")" rev-parse --abbrev-ref HEAD 2>/dev/null)

if [ "$branch" = "main" ] || [ "$branch" = "master" ]; then
  printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Pipeline violation: you are on '"$branch"' and tried to edit a protected path ('"$file_path"'). Per AGENTS.md rule #4, any change under src/, agents/, skills/, scripts/, or profiles/ must happen inside a worktree. Run /worktree init feat/<name> and edit inside that worktree."}}'
  exit 0
fi

printf '{}'
