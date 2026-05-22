#!/usr/bin/env bash
# generate-vscode-workspace.sh — write a VS Code multi-root workspace
# file for the current feature, listing every active worktree plus the
# session workspace itself as folders.
#
# Bucket:      skills/session/scripts (utility, not a hook)
# Listens to:  N/A (invoked from start-lead.sh, init.sh, sync-agents.sh)
# Blocking:    no — exits 0 on missing precondition; never aborts callers
# Input:       env vars + state.md
# Output:      $IA_TW_STATE_DIR/<feature-safe>.code-workspace (atomic write)
#
# Usage:
#   generate-vscode-workspace.sh <state-dir>
#
# Required env:
#   IA_TW_FEATURE         feature label (e.g. feat/notificaciones)
#   IA_TW_STATE_DIR       per-feature workspace dir
#
# Optional env:
#   IA_TW_ROOT_DIR        consumer / multi-repo root — included as a
#                         "(consumer repo)" folder when set + non-empty
#                         so the operator can browse the source tree.
#
# Idempotency contract:
#   - Re-running with same state.md produces byte-identical output.
#   - Adding a worktree → next call shows it as a folder.
#   - Removing a worktree from state.md → next call drops it.
#   - File written via mktemp + mv; partial writes cannot corrupt the
#     existing workspace.

set -u

state_dir="${1:?usage: generate-vscode-workspace.sh <state-dir>}"
[ -d "$state_dir" ] || { printf '✗ state_dir not found: %s\n' "$state_dir" >&2; exit 1; }

: "${IA_TW_FEATURE:?IA_TW_FEATURE required}"

if ! command -v jq >/dev/null 2>&1; then
  printf '⚠ jq not on PATH — skipping .code-workspace generation.\n' >&2
  exit 0
fi

# ─── Compute feature-safe filename ─────────────────────────────────────────
# Slashes break VS Code's file argument; replace with dashes. Same
# convention `start-lead.sh` uses for tmux session names.
feature_safe="${IA_TW_FEATURE//\//-}"
out="$state_dir/${feature_safe}.code-workspace"

# ─── Resolve worktree list from state.md ───────────────────────────────────
worktrees_json='[]'
if [ -f "$state_dir/state.md" ]; then
  active_script="$(dirname "${BASH_SOURCE[0]}")/../../worktree/scripts/active-worktrees.sh"
  if [ -x "$active_script" ]; then
    worktrees_json=$(bash "$active_script" "$state_dir/state.md" 2>/dev/null \
                       | jq -R . \
                       | jq -s 'map(select(length > 0))')
  fi
fi

# ─── Compose the workspace JSON ────────────────────────────────────────────
# Folder layout:
#   - One entry per active worktree, named "<basename> (<branch>?)".
#   - The session workspace itself (state.md, contracts, etc.).
#   - The consumer-repo root if IA_TW_ROOT_DIR is set — useful for
#     cross-referencing the source tree without making it a worktree.
tmp="$(mktemp "$out.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

jq -n \
  --arg feature   "$IA_TW_FEATURE" \
  --arg state_dir "$state_dir" \
  --arg root_dir  "${IA_TW_ROOT_DIR:-}" \
  --argjson worktrees "$worktrees_json" \
  '
  # Build folder entries. VS Code shows them in declaration order.
  {
    folders: (
      ( $worktrees
        | map({
            name: (. | split("/") | .[-1]),
            path: .
          })
      )
      + [{
          name: "session (state.md + .claude)",
          path: $state_dir
      }]
      + (if $root_dir != "" then
           [{
             name: "(consumer repo root)",
             path: $root_dir
           }]
         else [] end)
    ),
    settings: {
      "window.title": ($feature + " — ${activeEditorShort}${separator}${rootName}"),
      "explorer.compactFolders": false
    }
  }
  ' > "$tmp"

mv "$tmp" "$out"
trap - EXIT
printf '✓ wrote %s\n' "$out"
