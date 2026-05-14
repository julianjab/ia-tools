#!/usr/bin/env bash
# SessionEnd hook — extracts and consolidates feature learnings into agent memory.
#
# When a lead session ends with phase=merged:
#   1. Writes lead memory (decisions, friction, next-time hints).
#   2. For each worktree in state.md, writes role-specific memories to each
#      repo-local agent's memory file:
#        <repo>/.claude/agent-memory/<agent-name>/MEMORY.md
#      Roles covered: impl, qa, sec.
#
# Memory types stored (episodic/semantic/procedural per ACE pattern):
#   - Decisiones: design choices + WHY (not in code)
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

# Build transcript excerpt once: first 6KB (planning) + last 10KB (recent work).
transcript_excerpt=""
if [ -n "$transcript_path" ] && [ -f "$transcript_path" ]; then
  head_part=$(head -c 6144  "$transcript_path" 2>/dev/null || true)
  tail_part=$(tail -c 10240 "$transcript_path" 2>/dev/null || true)
  transcript_excerpt="${head_part}
[... middle omitted ...]
${tail_part}"
fi

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

  # impl memory (skip fallback names that aren't repo-local agents).
  if [ -n "$impl" ] && [ "$impl" != "lead" ] && [ "$impl" != "general-purpose" ]; then
    # Remove impl-<wt_prefix> fallback pattern — not a real repo agent.
    case "$impl" in impl-*) ;; *)
      write_memory "${repo}/.claude/agent-memory/${impl}/MEMORY.md" "impl" "$impl" "$repo" "$stack"
    ;; esac
  fi

  # qa memory.
  if [ -n "$qa" ] && [ "$qa" != "lead" ] && [ "$qa" != "general-purpose" ]; then
    write_memory "${repo}/.claude/agent-memory/${qa}/MEMORY.md" "qa" "$qa" "$repo" "$stack"
  fi

  # sec memory.
  if [ -n "$sec" ] && [ "$sec" != "lead" ] && [ "$sec" != "general-purpose" ]; then
    write_memory "${repo}/.claude/agent-memory/${sec}/MEMORY.md" "sec" "$sec" "$repo" "$stack"
  fi

done < <(parse_worktrees)

exit 0
