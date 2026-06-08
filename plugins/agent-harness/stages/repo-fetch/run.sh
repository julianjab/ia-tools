#!/usr/bin/env bash
# stages/repo-fetch/run.sh — ensure each candidate repo is up-to-date locally.
#
# Usage: run.sh <state.yaml>
# Reads:  .repos.candidates[]
# Writes: .repos.local[] with {name, path, head, base_branch, fetched_at}
# Emits:  one event per repo to harness-events.log
#
# Determinism: this stage is computational. It does NOT call claude -p.
# Its only LLM-adjacent decision is base-branch detection, which falls
# back from `main` to `master` deterministically.

set -euo pipefail

state_file="${1:?usage: run.sh <state.yaml>}"
session_dir="$(dirname "$state_file")"
events_log="$session_dir/harness-events.log"

[[ -f "$state_file" ]] || { echo "✗ repo-fetch: $state_file missing" >&2; exit 1; }

candidates_json="$(yq -o=json '.repos.candidates // []' "$state_file")"
n_cand="$(echo "$candidates_json" | jq 'length')"
[[ "$n_cand" -gt 0 ]] || { echo "✗ repo-fetch: no candidates — run repo-detect first" >&2; exit 1; }

session_id="$(yq -r '.session_id' "$state_file")"
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

local_arr="[]"
for i in $(seq 0 $((n_cand - 1))); do
  name="$(echo "$candidates_json" | jq -r ".[$i].name")"
  path="$(echo "$candidates_json" | jq -r ".[$i].path")"

  if [[ ! -d "$path/.git" ]]; then
    echo "✗ repo-fetch: $name at $path is not a git repo" >&2
    jq -nc --arg ts "$(now)" --arg sid "$session_id" \
      --arg sum "missing-git $name" --arg n "$name" --arg p "$path" \
      '{ts:$ts, session_id:$sid, stage:"repo-fetch", kind:"error", summary:$sum, data:{name:$n, path:$p}}' \
      >>"$events_log"
    exit 1
  fi

  echo "▶ $name — fetching origin..."
  if ! git -C "$path" fetch origin --quiet 2>&1 | sed 's/^/    /'; then
    echo "  (continuing despite fetch warning)"
  fi

  # base branch detection: origin/main, fallback origin/master
  base="main"
  if ! git -C "$path" rev-parse --verify "origin/main" >/dev/null 2>&1; then
    if git -C "$path" rev-parse --verify "origin/master" >/dev/null 2>&1; then
      base="master"
    else
      echo "✗ repo-fetch: $name has neither origin/main nor origin/master" >&2
      exit 1
    fi
  fi
  head="$(git -C "$path" rev-parse "origin/$base")"

  local_arr="$(jq -c --arg n "$name" --arg p "$path" --arg b "$base" \
                     --arg h "$head" --arg t "$(now)" \
                     '. += [{name:$n, path:$p, base_branch:$b, head:$h, fetched_at:$t}]' \
              <<<"$local_arr")"

  jq -nc --arg ts "$(now)" --arg sid "$session_id" \
     --arg sum "fetched $name @ $base ($head)" \
     --arg n "$name" --arg p "$path" --arg b "$base" --arg h "$head" \
     '{ts:$ts, session_id:$sid, stage:"repo-fetch", kind:"outcome",
       summary:$sum, data:{name:$n, path:$p, base_branch:$b, head:$h}}' \
     >>"$events_log"
done

now_ts="$(now)"
export REPO_FETCH_JSON="$local_arr"
export NOW="$now_ts"

yq -i '
  .updated_at = strenv(NOW) |
  .phase = "repo-fetch" |
  .repos.local = (strenv(REPO_FETCH_JSON) | from_json)
' "$state_file"

echo "✓ repo-fetch complete — $n_cand repo(s) ready"
