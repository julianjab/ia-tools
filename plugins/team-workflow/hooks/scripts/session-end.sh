#!/usr/bin/env bash
# SessionEnd hook — extracts and consolidates feature learnings into agent memory.
#
# When a lead session ends with phase=merged:
#   1. Writes lead memory (decisions, friction, next-time hints).
#   2. For each worktree in state.md, writes role-specific memories to each
#      repo-local agent's memory file:
#        <repo>/.claude/agent-memory/<agent-name>/MEMORY.md
#      If the named agent does not exist in <repo>/.claude/agents/, falls back to
#      the plugin-level agent name that Claude auto-loads via memory: project:
#        impl fallback → implementer (has memory: project in plugin)
#        qa/sec fallback → skipped (lead ran inline; no persistent memory target)
#   3. After writing all memories for a repo, opens a `chore/memory-<feature>`
#      PR in that repo so the memory is versioned and reviewable.
#
# Memory types stored (episodic/semantic/procedural per ACE pattern):
#   - Aprendido: non-obvious validated insight
#   - Fricción:   what slowed the process
#   - Próxima vez: concrete behavioral change
#
# Falls back to basic metadata if claude CLI is unavailable.
# Always append-only. Idempotent (skips if feature already recorded today).
#
# Input  (stdin JSON): { "end_reason": "...", "transcript_path": "...", "cwd", ... }
# Output: always exit 0 (SessionEnd is non-blocking).

set -u

payload=$(cat)
transcript_path=$(printf '%s' "$payload" | jq -r '.transcript_path // empty' 2>/dev/null)

[ -n "${IA_TW_STATE_DIR:-}" ] || exit 0
state_file="${IA_TW_STATE_DIR}/state.md"
[ -f "$state_file" ] || exit 0

phase=$(grep '^phase:' "$state_file" 2>/dev/null | head -1 | sed 's/phase:[[:space:]]*//')
[ "$phase" = "merged" ] || exit 0

feature=$(grep '^feature:' "$state_file" 2>/dev/null | head -1 | sed 's/feature:[[:space:]]*//')
date_now=$(date -u '+%Y-%m-%d')
stacks=$(grep 'stack:' "$state_file" 2>/dev/null | sed 's/[[:space:]]*stack:[[:space:]]*//' | sort -u | tr '\n' ',' | sed 's/,$//')
pr_urls=$(grep 'pr_url:' "$state_file" 2>/dev/null | sed 's/[[:space:]]*pr_url:[[:space:]]*//' | grep -v '^[[:space:]]*$' | tr '\n' ' ')
state_content=$(cat "$state_file" 2>/dev/null || true)
has_claude=0
command -v claude >/dev/null 2>&1 && has_claude=1
has_gh=0
command -v gh >/dev/null 2>&1 && has_gh=1

# Build transcript excerpt once: first 6KB (planning) + last 10KB (recent work).
transcript_excerpt=""
if [ -n "$transcript_path" ] && [ -f "$transcript_path" ]; then
  head_part=$(head -c 6144  "$transcript_path" 2>/dev/null || true)
  tail_part=$(tail -c 10240 "$transcript_path" 2>/dev/null || true)
  transcript_excerpt="${head_part}
[... middle omitted ...]
${tail_part}"
fi

# ── Helper: resolve the memory target agent name ───────────────────────────────
# If <repo>/.claude/agents/<agent>.md exists → use <agent> as-is.
# If the recorded name is a fallback pattern (impl-*, lead, general-purpose):
#   impl-* → "implementer"  (plugin agent with memory: project — auto-loaded)
#   others → empty string   (no persistent memory target; skip)
# Returns the resolved name on stdout, or empty if memory should be skipped.
resolve_memory_agent() {
  local agent="$1" repo="$2" role="$3"

  # Fallback patterns: impl-<wt_prefix> teammate name.
  case "$agent" in
    impl-*)
      # Fallback impl → write to implementer's memory (memory: project in plugin).
      printf 'implementer'
      return 0
      ;;
    lead|general-purpose)
      # lead ran inline; no dedicated memory file. Skip.
      printf ''
      return 0
      ;;
  esac

  # Repo-local agent: verify the agent file exists.
  if [ -f "${repo}/.claude/agents/${agent}.md" ]; then
    printf '%s' "$agent"
  else
    # Agent recorded in state.md but file is gone. Skip to avoid orphaned memory.
    printf ''
  fi
}

# ── Helper: write one memory entry ────────────────────────────────────────────
# Args: $1=memory_file  $2=role_hint  $3=agent_name  $4=repo_path  $5=stack
write_memory() {
  local mem_file="$1" role="$2" agent="$3" repo="$4" stack="$5"

  # Idempotent: skip if already recorded today for this feature.
  grep -q "^## ${date_now}.*${feature}" "$mem_file" 2>/dev/null && return 0

  mkdir -p "$(dirname "$mem_file")" 2>/dev/null || true

  if [ "$has_claude" -eq 0 ]; then
    {
      printf '\n## %s — %s  [%s]\n' "$date_now" "$feature" "$stack"
      printf '> auto: claude CLI unavailable — basic metadata only\n'
      printf '- PRs: %s\n' "${pr_urls:-none}"
    } >> "$mem_file" 2>/dev/null || true
    return 0
  fi

  # Role-specific extraction focus.
  local focus
  case "$role" in
    qa)   focus="test patterns that worked or failed, modules that needed extra iterations, missing fixtures or test infrastructure, TDD antipatterns to avoid in this codebase" ;;
    sec)  focus="vulnerability patterns found (recurring or high-risk), code paths that always need extra scrutiny, false positive patterns to skip, repo-specific security context" ;;
    impl) focus="code conventions NOT in CLAUDE.md, module coupling pitfalls, dependency quirks, integration gotchas, patterns that caused rework" ;;
    *)    focus="what worked, what didn't, what to do differently next time" ;;
  esac

  local prompt="You are extracting role-specific learnings for the '${agent}' agent (role: ${role}) from a completed software feature. Future runs of this agent on the same repo will read this memory to work more effectively.

Be concise — 2-4 bullets per section. Only include non-obvious insights NOT already in the code, tests, or git history. If a section has nothing meaningful, write '- (nada relevante)'.

Focus specifically on: ${focus}

Feature: ${feature}
Repo: ${repo}
Stack: ${stack}
Date: ${date_now}

--- state.md ---
${state_content}

--- transcript excerpt ---
${transcript_excerpt}
--- end ---

Output ONLY this markdown block, no other text:

## ${date_now} — ${feature}  [${stack}]

### Aprendido
- <non-obvious insight specific to this agent's role>

### Fricción
- <what slowed this agent: missing context, unclear spec, tool issues, iteration waste>

### Próxima vez
- <concrete behavioral change: check X first, skip Y pattern, always Z in this repo>"

  local result
  result=$(printf '%s' "$prompt" | \
    claude -p --model claude-haiku-4-5-20251001 --max-tokens 400 2>/dev/null) || true

  if [ -n "$result" ]; then
    printf '\n%s\n' "$result" >> "$mem_file" 2>/dev/null || true
  else
    {
      printf '\n## %s — %s  [%s]\n' "$date_now" "$feature" "$stack"
      printf '> auto: extraction empty — basic metadata\n'
      printf '- PRs: %s\n' "${pr_urls:-none}"
    } >> "$mem_file" 2>/dev/null || true
  fi
}

# ── Helper: open a memory PR for a consumer repo ──────────────────────────────
# Creates branch chore/memory-<feature>, commits .claude/agent-memory/ changes,
# pushes, and opens a draft PR tagged [skip ci].
# Args: $1=repo_path
create_memory_pr() {
  local repo="$1"
  [ "$has_gh" -eq 1 ] || return 0

  # Only proceed if there are uncommitted changes in agent-memory.
  local mem_dir="${repo}/.claude/agent-memory"
  [ -d "$mem_dir" ] || return 0

  local changes
  changes=$(git -C "$repo" status --porcelain -- ".claude/agent-memory/" 2>/dev/null | grep -c .) || true
  [ "${changes:-0}" -gt 0 ] || return 0

  local branch="chore/memory-${feature//\//-}"
  local current_branch
  current_branch=$(git -C "$repo" branch --show-current 2>/dev/null || true)

  # Abort if already on a feature branch with pending work — don't clobber it.
  case "${current_branch:-}" in
    main|master) ;;
    "") ;;
    *)
      # Only create the memory branch if we're on main/master or the feature branch is already merged.
      local main_branch
      main_branch=$(git -C "$repo" symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||') || main_branch="main"
      if ! git -C "$repo" merge-base --is-ancestor HEAD "origin/${main_branch}" 2>/dev/null; then
        # Current branch is ahead of origin/main — not safe to create memory branch here.
        return 0
      fi
      ;;
  esac

  # Create or reset the memory branch from origin/main.
  local main_branch
  main_branch=$(git -C "$repo" symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||') || main_branch="main"

  git -C "$repo" fetch origin "${main_branch}" --quiet 2>/dev/null || true
  git -C "$repo" checkout -B "$branch" "origin/${main_branch}" --quiet 2>/dev/null || return 0

  # Stage only agent-memory changes.
  git -C "$repo" add -- ".claude/agent-memory/" 2>/dev/null || return 0

  # Bail if nothing staged after add.
  git -C "$repo" diff --cached --quiet -- ".claude/agent-memory/" 2>/dev/null && return 0

  git -C "$repo" commit -m "chore(memory): ${feature} [skip ci]

Auto-generated by session-end hook after feature merge.
Adds role-specific learnings extracted from the lead session transcript.

Co-Authored-By: ia-tools session-end hook <noreply@ia-tools>" \
    --quiet 2>/dev/null || return 0

  git -C "$repo" push origin "$branch" --quiet 2>/dev/null || return 0

  gh pr create \
    --repo "$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)" \
    --base "$main_branch" \
    --head "$branch" \
    --title "chore(memory): ${feature}" \
    --body "$(cat <<EOF
## Memory update — ${feature}

Auto-generated by the ia-tools \`session-end\` hook after the feature PR was merged.

### What's in here
Role-specific learnings extracted from the lead session transcript:
- \`.claude/agent-memory/<agent>/MEMORY.md\` — one entry per agent that participated in this feature.

### Review guidance
- Each memory entry has three sections: **Aprendido** (insight), **Fricción** (friction), **Próxima vez** (behavioral change).
- Edit or remove entries that are inaccurate before merging.
- Merging adds this to the agents' memory for future features on this repo.

🤖 Generated with [ia-tools](https://github.com/anthropics/ia-tools) session-end hook
EOF
)" \
    --draft 2>/dev/null || true

  # Return to whatever branch was current before.
  git -C "$repo" checkout "${current_branch:-${main_branch}}" --quiet 2>/dev/null || true
}

# ── 1. Lead memory ─────────────────────────────────────────────────────────────
lead_memory_dir="${IA_TW_ROOT_DIR:-.}/.claude/agent-memory/lead"
mkdir -p "$lead_memory_dir" 2>/dev/null || true
lead_memory_file="${lead_memory_dir}/MEMORY.md"

if ! grep -q "^## ${date_now}.*${feature}" "$lead_memory_file" 2>/dev/null; then
  if [ "$has_claude" -eq 1 ]; then
    lead_prompt="You are extracting structured learnings from a completed software feature for the lead orchestrator agent. Future leads will read this before planning similar features on this codebase.

Extract exactly three sections. Be concise — 2-5 bullets each. Only include non-obvious insights NOT already in the code or git history.

Feature: ${feature}
Stacks: ${stacks:-unknown}
PRs: ${pr_urls:-none}
Date: ${date_now}

--- state.md ---
${state_content}

--- transcript excerpt ---
${transcript_excerpt}
--- end ---

Output ONLY this markdown block, no other text:

## ${date_now} — ${feature}  [${stacks:-unknown}]

### Decisiones
- <design choice and WHY — constraints, tradeoffs, stakeholder requirements not visible in code>

### Fricción
- <what slowed the process: missing config, agent iteration counts, unclear specs, tool failures>

### Próxima vez
- <concrete behavioral change: verify X before Y, allocate more turns for Z, add W to CLAUDE.md>"

    lead_result=$(printf '%s' "$lead_prompt" | \
      claude -p --model claude-haiku-4-5-20251001 --max-tokens 600 2>/dev/null) || true

    if [ -n "$lead_result" ]; then
      printf '\n%s\n' "$lead_result" >> "$lead_memory_file" 2>/dev/null || true
    fi
  else
    {
      printf '\n## %s — %s  [%s]\n' "$date_now" "$feature" "${stacks:-unknown}"
      printf '> auto: claude CLI unavailable\n'
      printf '- PRs: %s\n' "${pr_urls:-none}"
      printf '- state_dir: %s\n' "$IA_TW_STATE_DIR"
    } >> "$lead_memory_file" 2>/dev/null || true
  fi
fi

# ── 2. Per-worktree subagent memories ──────────────────────────────────────────
# Parse worktree blocks from state.md using awk.
# Each block starts with "  - repo:" and ends before the next one.
# Extracts: repo, stack, agents.impl, agents.qa, agents.sec.

parse_worktrees() {
  awk '
    /^  - repo:/ {
      if (repo != "") print repo "|" stack "|" impl "|" qa "|" sec
      repo = ""; stack = ""; impl = ""; qa = ""; sec = ""
    }
    /^[[:space:]]*repo:[[:space:]]/ && repo == "" { gsub(/^[[:space:]]*repo:[[:space:]]*/, ""); repo = $0 }
    /^[[:space:]]*stack:[[:space:]]/  { gsub(/^[[:space:]]*stack:[[:space:]]*/, ""); stack = $0 }
    /^[[:space:]]*impl:[[:space:]]/   { gsub(/^[[:space:]]*impl:[[:space:]]*/, ""); impl = $0 }
    /^[[:space:]]*qa:[[:space:]]/     { gsub(/^[[:space:]]*qa:[[:space:]]*/, ""); qa = $0 }
    /^[[:space:]]*sec:[[:space:]]/    { gsub(/^[[:space:]]*sec:[[:space:]]*/, ""); sec = $0 }
    END { if (repo != "") print repo "|" stack "|" impl "|" qa "|" sec }
  ' "$state_file" 2>/dev/null
}

while IFS='|' read -r repo stack impl qa sec; do
  [ -n "$repo" ] || continue

  # impl memory — resolve agent name (handles impl-* fallback → implementer).
  if [ -n "$impl" ]; then
    resolved_impl=$(resolve_memory_agent "$impl" "$repo" "impl")
    if [ -n "$resolved_impl" ]; then
      write_memory "${repo}/.claude/agent-memory/${resolved_impl}/MEMORY.md" "impl" "$resolved_impl" "$repo" "$stack"
    fi
  fi

  # qa memory — only for real repo-local agents (lead/general-purpose ran inline).
  if [ -n "$qa" ]; then
    resolved_qa=$(resolve_memory_agent "$qa" "$repo" "qa")
    if [ -n "$resolved_qa" ]; then
      write_memory "${repo}/.claude/agent-memory/${resolved_qa}/MEMORY.md" "qa" "$resolved_qa" "$repo" "$stack"
    fi
  fi

  # sec memory — same rule as qa.
  if [ -n "$sec" ]; then
    resolved_sec=$(resolve_memory_agent "$sec" "$repo" "sec")
    if [ -n "$resolved_sec" ]; then
      write_memory "${repo}/.claude/agent-memory/${resolved_sec}/MEMORY.md" "sec" "$resolved_sec" "$repo" "$stack"
    fi
  fi

  # Open a memory PR in this repo for review + versioning.
  create_memory_pr "$repo"

done < <(parse_worktrees)

exit 0
