#!/usr/bin/env bash
# detect-repo-capabilities.sh — records what each touched consumer repo provides.
#
# Bucket:      intelligence
# Listens to:  PostToolUse  (matcher: Edit|Write|MultiEdit)
# Blocking:    no (always exit 0)
# Input  (stdin JSON): { "tool_input": { "file_path": "<abs>" }, ... }
# Output: exit 0 always; appends `kind: repo_capabilities` to state.md events:
#         for every worktree repo it has not yet inspected.
#
# Fires on state.md edits — the only time the worktrees list can change —
# and for each `worktrees[*].repo` entry, runs a one-shot capability probe.
# Idempotent (skips repos already recorded). The result lets future leads
# and the memory extraction know what features a repo actually has, so
# missing features are visible instead of silently degraded.
#
# Capabilities probed (all best-effort, never crash on missing tools):
#
#   pre_push_hook                — present | absent
#                                  (checks .git/hooks/pre-push, .husky/pre-push,
#                                   and core.hooksPath/<name>)
#   claude_agents_dir            — <count> (number of .md files in .claude/agents/)
#   agent_memory_dir             — present | absent
#   team_review_config           — present | absent
#                                  (looks for TEAM_REVIEW_CHANNEL in CLAUDE.md
#                                   or .claude/settings*.json)
#   conventional_commits_enforced — yes | no
#                                  (commitlint.config.* / .commitlintrc /
#                                   .husky/commit-msg / .git/hooks/commit-msg)
#   base_branch                  — main | master | <other>
#
# This is documentation-by-side-effect: the lead does not need to write any
# of this manually; the hook records it once on first state.md edit per repo
# and SessionEnd's extract-memory-signal includes it in the feedback file.

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

state_file="$file_path"
[ -f "$state_file" ] || exit 0

# ── Helper: probe a single repo's capabilities ─────────────────────────────
# Args:   $1 = absolute path to repo root
# Stdout: a single YAML event block (multi-line). Empty when the repo path
#         does not look like a git repo.
probe_repo_capabilities() {
  local repo="$1"
  [ -d "$repo" ] || return 0
  git -C "$repo" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 0

  # pre-push hook detection.
  local pre_push="absent"
  if [ -x "${repo}/.git/hooks/pre-push" ] && ! grep -q '^# Sample' "${repo}/.git/hooks/pre-push" 2>/dev/null; then
    pre_push="present"
  elif [ -f "${repo}/.husky/pre-push" ]; then
    pre_push="present (husky)"
  else
    local hooks_path
    hooks_path=$(git -C "$repo" config --get core.hooksPath 2>/dev/null)
    if [ -n "$hooks_path" ] && [ -x "${repo}/${hooks_path}/pre-push" ]; then
      pre_push="present (core.hooksPath)"
    fi
  fi

  # .claude/agents/ count.
  local agents_count=0
  if [ -d "${repo}/.claude/agents" ]; then
    agents_count=$(find "${repo}/.claude/agents" -maxdepth 1 -name '*.md' -type f 2>/dev/null | wc -l | tr -d ' ')
  fi

  # agent-memory dir.
  local agent_memory="absent"
  [ -d "${repo}/.claude/agent-memory" ] && agent_memory="present"

  # team-review config.
  local team_review="absent"
  if [ -f "${repo}/CLAUDE.md" ] \
     && grep -q '^[[:space:]]*TEAM_REVIEW_CHANNEL\|TEAM_REVIEW_MENTIONS' "${repo}/CLAUDE.md" 2>/dev/null; then
    team_review="present"
  elif [ -f "${repo}/.claude/settings.json" ] \
       && grep -q 'TEAM_REVIEW_CHANNEL\|TEAM_REVIEW_MENTIONS' "${repo}/.claude/settings.json" 2>/dev/null; then
    team_review="present"
  elif [ -f "${repo}/.claude/settings.local.json" ] \
       && grep -q 'TEAM_REVIEW_CHANNEL\|TEAM_REVIEW_MENTIONS' "${repo}/.claude/settings.local.json" 2>/dev/null; then
    team_review="present (local)"
  fi

  # Conventional Commits enforcement.
  local cc="no"
  if [ -f "${repo}/commitlint.config.js" ] || [ -f "${repo}/commitlint.config.mjs" ] \
     || [ -f "${repo}/commitlint.config.cjs" ] || [ -f "${repo}/.commitlintrc" ] \
     || [ -f "${repo}/.commitlintrc.json" ] || [ -f "${repo}/.commitlintrc.yml" ] \
     || [ -f "${repo}/.husky/commit-msg" ] || [ -x "${repo}/.git/hooks/commit-msg" ]; then
    cc="yes"
  fi

  # Default base branch.
  local base
  base=$(git -C "$repo" symbolic-ref refs/remotes/origin/HEAD 2>/dev/null \
         | sed 's|refs/remotes/origin/||')
  [ -n "$base" ] || base=$(git -C "$repo" branch --show-current 2>/dev/null)
  [ -n "$base" ] || base="unknown"

  # Emit the YAML block (multi-line). Caller collects into a temp file.
  printf '  - ts: %s\n'                    "$ts"
  printf '    kind: repo_capabilities\n'
  printf '    repo: %s\n'                  "$repo"
  printf '    pre_push_hook: "%s"\n'       "$pre_push"
  printf '    claude_agents_dir: %s\n'     "$agents_count"
  printf '    agent_memory_dir: %s\n'      "$agent_memory"
  printf '    team_review_config: "%s"\n'  "$team_review"
  printf '    conventional_commits_enforced: %s\n' "$cc"
  printf '    base_branch: %s\n'           "$base"
  printf '    dedupe_key: repo_capabilities:%s\n' "$(printf '%s' "$repo" | cksum 2>/dev/null | awk '{print $1}')"
}

ts=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

# Collect the set of repo paths from state.md (one per `  - repo:` line).
repos=$(grep -E '^[[:space:]]+- repo:[[:space:]]' "$state_file" 2>/dev/null \
        | sed 's/^[[:space:]]*-[[:space:]]*repo:[[:space:]]*//' \
        | sort -u)

[ -n "$repos" ] || exit 0

# Build the new events blob for repos not yet recorded.
new_events=$(mktemp 2>/dev/null) || exit 0
printf '%s\n' "$repos" | while IFS= read -r repo; do
  [ -n "$repo" ] || continue
  key_hash=$(printf '%s' "$repo" | cksum 2>/dev/null | awk '{print $1}')
  # Idempotency: skip if a repo_capabilities event for THIS repo already exists.
  if grep -qF "repo_capabilities:${key_hash}" "$state_file" 2>/dev/null; then
    continue
  fi
  probe_repo_capabilities "$repo" >> "$new_events" 2>/dev/null || true
done

if [ ! -s "$new_events" ]; then
  rm -f "$new_events"
  exit 0
fi

# Insert events into state.md (frontmatter, before closing ---). BSD awk
# rejects multi-line -v, so we pass the blob via a temp file and slurp it
# inside awk with getline.
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
