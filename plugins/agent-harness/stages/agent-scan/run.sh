#!/usr/bin/env bash
# stages/agent-scan/run.sh — discover repo-local agents per worktree.
#
# Usage: run.sh <state.yaml>
# Reads:  .worktrees[]
# Writes: .worktrees[].agents[] (flat list of {id, description, source})
# Emits:  one event per worktree to harness-events.log
#
# Determinism: parses YAML frontmatter of `.claude/agents/*.md`.
# No LLM call. Skips files without frontmatter or without `name:`.

set -euo pipefail

state_file="${1:?usage: run.sh <state.yaml>}"
session_dir="$(dirname "$state_file")"
events_log="$session_dir/harness-events.log"

[[ -f "$state_file" ]] || { echo "✗ agent-scan: $state_file missing" >&2; exit 1; }

worktrees_json="$(yq -o=json '.worktrees // []' "$state_file")"
n="$(echo "$worktrees_json" | jq 'length')"
[[ "$n" -gt 0 ]] || { echo "✗ agent-scan: no .worktrees[] — run worktree first" >&2; exit 1; }

session_id="$(yq -r '.session_id' "$state_file")"
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Extract one agent file's frontmatter into a {id, description, source} object.
extract_agent() {
  local file="$1"
  # frontmatter lives between the first two lines that are exactly '---'.
  local fm
  fm="$(awk '
    /^---[[:space:]]*$/ { found++; next }
    found == 1 { print }
    found == 2 { exit }
  ' "$file")"
  [[ -n "$fm" ]] || return 1
  local name desc
  # use yq to parse the YAML frontmatter
  name="$(echo "$fm" | yq -r '.name // ""' 2>/dev/null || echo "")"
  desc="$(echo "$fm" | yq -r '.description // ""' 2>/dev/null || echo "")"
  [[ -n "$name" && "$name" != "null" ]] || return 1
  jq -nc --arg id "$name" --arg d "$desc" --arg s "$file" \
    '{id:$id, description:$d, source:$s}'
}

updated_worktrees="[]"
for i in $(seq 0 $((n - 1))); do
  wt_json="$(echo "$worktrees_json" | jq -c ".[$i]")"
  wt_name="$(echo "$wt_json" | jq -r '.name')"
  wt_path="$(echo "$wt_json" | jq -r '.path')"
  agents_arr="[]"

  # search both <wt>/.claude/agents/*.md AND, when present, plugin agents
  # synced under <wt>/.claude/agents/*.md by another tool. Single glob.
  shopt -s nullglob
  for af in "$wt_path"/.claude/agents/*.md; do
    if agent_obj="$(extract_agent "$af")"; then
      agents_arr="$(jq -c --argjson a "$agent_obj" '. += [$a]' <<<"$agents_arr")"
    fi
  done
  shopt -u nullglob

  count="$(echo "$agents_arr" | jq 'length')"
  updated_worktrees="$(jq -c \
    --argjson wt "$wt_json" --argjson agents "$agents_arr" \
    '. += [($wt + {agents:$agents})]' \
    <<<"$updated_worktrees")"

  jq -nc --arg ts "$(now)" --arg sid "$session_id" \
     --arg sum "$wt_name: $count agent(s)" \
     --arg n "$wt_name" --argjson a "$agents_arr" \
     '{ts:$ts, session_id:$sid, stage:"agent-scan", kind:"outcome",
       summary:$sum, data:{worktree:$n, agents:$a}}' \
     >>"$events_log"
done

now_ts="$(now)"
export NEW_WORKTREES="$updated_worktrees"
export NOW="$now_ts"

yq -i '
  .updated_at = strenv(NOW) |
  .phase = "agent-scan" |
  .worktrees = (strenv(NEW_WORKTREES) | from_json)
' "$state_file"

echo "✓ agent-scan complete"
echo "$updated_worktrees" | jq -r '.[] | "  • \(.name): \(.agents | length) agent(s)" + (
  if (.agents | length) > 0
  then "\n" + (.agents | map("      - \(.id)") | join("\n"))
  else ""
  end
)'
