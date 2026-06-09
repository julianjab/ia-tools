#!/usr/bin/env bash
# stages/repo-detect/run.sh — pick which repos the request touches.
#
# Usage: run.sh <state.yaml>
# Reads:  .intake.result (signals, targets), config repo_roots, max_repos
# Writes: .repos.candidates[] + .repos.catalog_size
# Emits:  one event to harness-events.log

set -euo pipefail

STAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$STAGE_DIR/../.." && pwd)"
PROMPT_FILE="$STAGE_DIR/prompt.md"
SCHEMA_FILE="$STAGE_DIR/schema.json"

# shellcheck source=../../lib/config.sh
source "$PLUGIN_ROOT/lib/config.sh"
config_init

state_file="${1:?usage: run.sh <state.yaml>}"
session_dir="$(dirname "$state_file")"
events_log="$session_dir/harness-events.log"

[[ -f "$state_file" ]] || { echo "✗ repo-detect: $state_file missing — run intake first" >&2; exit 1; }

intake_json="$(yq -o=json '.intake.result' "$state_file")"
[[ "$intake_json" != "null" ]] || { echo "✗ repo-detect: .intake.result missing" >&2; exit 1; }

MODEL="$(config_model repo-detect)"
MAX_REPOS="$(config_get max_repos)"
IFS=':' read -ra repo_roots <<<"$(config_get repo_roots)"

# ── 1. build catalog: scan repo_roots for .git dirs ───────────────
catalog_tmp="$(mktemp)"
trap 'rm -f "$catalog_tmp"' EXIT
echo "[]" >"$catalog_tmp"

for root in "${repo_roots[@]}"; do
  [[ -d "$root" ]] || continue
  while IFS= read -r -d '' gitdir; do
    repo_path="$(dirname "$gitdir")"
    name="$(basename "$repo_path")"
    remote="$(git -C "$repo_path" remote get-url origin 2>/dev/null || echo "")"
    jq --arg n "$name" --arg p "$repo_path" --arg r "$remote" \
       '. += [{name:$n, path:$p, remote:$r}]' \
       "$catalog_tmp" >"$catalog_tmp.new" && mv "$catalog_tmp.new" "$catalog_tmp"
  done < <(find "$root" -maxdepth 4 -type d -name .git -print0 2>/dev/null)
done

catalog_size="$(jq 'length' "$catalog_tmp")"
if [[ "$catalog_size" -eq 0 ]]; then
  echo "✗ repo-detect: no repos found under repo_roots ($(config_get repo_roots))" >&2
  echo "  tip: set AGENT_HARNESS_REPO_ROOTS or edit ~/.agent-harness/config.yaml" >&2
  exit 1
fi

# ── 2. compose model input ────────────────────────────────────────
catalog_json="$(cat "$catalog_tmp")"
user_payload="$(jq -nc \
  --argjson intake "$intake_json" \
  --argjson catalog "$catalog_json" \
  --argjson max "$MAX_REPOS" \
  '{intake:$intake, catalog:$catalog, max_repos:$max}')"

prompt="$(cat "$PROMPT_FILE")"
schema="$(cat "$SCHEMA_FILE")"

raw="$(
  claude -p \
    --model "$MODEL" \
    --output-format json \
    --disable-slash-commands \
    --json-schema "$schema" \
    --system-prompt "$prompt" \
    -- "$user_payload"
)"

result_json="$(echo "$raw" | jq -c .structured_output)"
[[ "$result_json" != "null" && -n "$result_json" ]] || {
  echo "✗ repo-detect: model returned no structured output" >&2
  echo "$raw" >&2
  exit 1
}

# ── 3. validate candidates exist in catalog ───────────────────────
invalid="$(jq --argjson cat "$catalog_json" '
  [.candidates[] | select(. as $c | ($cat | map(.path) | index($c.path)) == null) | .name]
' <<<"$result_json")"

if [[ "$(echo "$invalid" | jq 'length')" -gt 0 ]]; then
  echo "✗ repo-detect: model invented repos not in catalog: $invalid" >&2
  exit 1
fi

# ── 4. merge into state.yaml ──────────────────────────────────────
now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
export REPO_DETECT_JSON="$result_json"
export NOW="$now"
export CATALOG_SIZE="$catalog_size"

yq -i '
  .updated_at = strenv(NOW) |
  .phase = "repo-detect" |
  .repos.catalog_size = (strenv(CATALOG_SIZE) | to_number) |
  .repos.candidates = (strenv(REPO_DETECT_JSON) | from_json | .candidates)
' "$state_file"

# ── 5. append event ───────────────────────────────────────────────
session_id="$(yq -r '.session_id' "$state_file")"
n_cand="$(echo "$result_json" | jq '.candidates | length')"
summary="catalog=$catalog_size candidates=$n_cand"
jq -nc \
  --arg ts "$now" \
  --arg sid "$session_id" \
  --arg sum "$summary" \
  --argjson data "$result_json" \
  '{ts:$ts, session_id:$sid, stage:"repo-detect", kind:"outcome", summary:$sum, data:$data}' \
  >>"$events_log"

echo "✓ repo-detect complete — $summary"
echo "$result_json" | jq -r '.candidates[] | "  • \(.name) [\(.confidence)] — \(.reason)"'
