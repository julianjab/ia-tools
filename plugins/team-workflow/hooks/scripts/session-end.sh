#!/usr/bin/env bash
# SessionEnd hook — extracts and consolidates feature learnings into agent memory.
#
# When a lead session ends with phase=merged, uses `claude -p` (haiku) to
# extract three types of memory from the transcript + state.md:
#   - Episodic:   what happened in this feature (timestamps, events)
#   - Semantic:   validated knowledge about this repo/stack
#   - Procedural: how to behave differently next time
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

# Locate agent-memory dir (shared across agents for this repo).
memory_dir="${IA_TW_ROOT_DIR:-.}/.claude/agent-memory/lead"
mkdir -p "$memory_dir" 2>/dev/null || true
memory_file="${memory_dir}/MEMORY.md"

# Idempotent: skip if already recorded today for this feature.
grep -q "^## ${date_now}.*${feature}" "$memory_file" 2>/dev/null && exit 0

# ── Extract structured learnings via claude -p ─────────────────────────────
# Uses the transcript (first 6KB for planning decisions + last 10KB for
# recent work) plus state.md as context. Falls back to basic metadata.

stacks=$(grep   'stack:'    "$state_file" 2>/dev/null | sed 's/[[:space:]]*stack:[[:space:]]*//' | sort -u | tr '\n' ',' | sed 's/,$//')
pr_urls=$(grep  'pr_url:'   "$state_file" 2>/dev/null | sed 's/[[:space:]]*pr_url:[[:space:]]*//' | grep -v '^[[:space:]]*$' | tr '\n' ' ')
prefixes=$(grep 'wt_prefix:' "$state_file" 2>/dev/null | sed 's/[[:space:]]*wt_prefix:[[:space:]]*//' | tr '\n' ' ')

write_basic_entry() {
  {
    printf '\n## %s — %s  [%s]\n' "$date_now" "$feature" "${stacks:-unknown}"
    printf '> auto: claude CLI unavailable — basic metadata only\n'
    printf '- PRs: %s\n'      "${pr_urls:-none}"
    printf '- prefixes: %s\n' "${prefixes:-unknown}"
    printf '- state_dir: %s\n' "$IA_TW_STATE_DIR"
  } >> "$memory_file" 2>/dev/null || true
}

if ! command -v claude >/dev/null 2>&1; then
  write_basic_entry
  exit 0
fi

# Build transcript excerpt: first 6KB (planning decisions) + last 10KB (recent).
transcript_excerpt=""
if [ -n "$transcript_path" ] && [ -f "$transcript_path" ]; then
  head_part=$(head -c 6144 "$transcript_path" 2>/dev/null || true)
  tail_part=$(tail -c 10240 "$transcript_path" 2>/dev/null || true)
  transcript_excerpt="${head_part}

[... middle omitted ...]

${tail_part}"
fi

state_content=$(cat "$state_file" 2>/dev/null || true)

# Prompt designed to extract the three memory types concisely.
# Output must be valid markdown ready to append to MEMORY.md.
extraction_prompt="You are extracting structured learnings from a completed software feature to save in an agent memory file. Future AI agents will read this to work more effectively on the same codebase.

Extract exactly three sections. Be concise — 2-5 bullets each. Only include non-obvious insights that are NOT already in the code or git history. Skip sections with nothing meaningful.

Feature: ${feature}
Stacks: ${stacks:-unknown}
PRs: ${pr_urls:-none}
Date: ${date_now}

--- state.md ---
${state_content}

--- transcript excerpt ---
${transcript_excerpt}
--- end ---

Output ONLY the following markdown block, no other text:

## ${date_now} — ${feature}  [${stacks:-unknown}]

### Decisiones
- <design choice and WHY — constraints, tradeoffs, stakeholder requirements not visible in code>

### Fricción
- <what slowed down the process: missing config, agent iteration counts, unclear specs, tool failures>

### Próxima vez
- <concrete behavioral change for the lead or teammates: verify X before Y, allocate more turns for Z, add W to CLAUDE.md>

If a section has nothing non-obvious to say, write '- (nada relevante)' for that section."

learnings=$(printf '%s' "$extraction_prompt" | \
  claude -p --model claude-haiku-4-5-20251001 --max-tokens 600 2>/dev/null) || true

if [ -n "$learnings" ]; then
  printf '\n%s\n' "$learnings" >> "$memory_file" 2>/dev/null || true
else
  # claude ran but returned empty — fall back to basic.
  write_basic_entry
fi

exit 0
