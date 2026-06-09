#!/usr/bin/env bash
# stages/worktree/run.sh — provision one git worktree per repo.local entry.
#
# Usage: run.sh <state.yaml> [--branch <feature-branch>]
#
# Reads:  .repos.local[], .feature.branch (if set)
# Writes: .feature.branch (if not set), .worktrees[]
# Emits:  one event per worktree to harness-events.log
#
# Worktrees land at: <session_dir>/worktrees/<repo-basename>/
# Branches off:      origin/<base_branch>
#
# Idempotent: if the worktree already exists with the same branch, it
# is left untouched and reported as `reused`.

set -euo pipefail

state_file=""
feature_branch=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch) feature_branch="$2"; shift 2 ;;
    -*) echo "✗ worktree: unknown flag $1" >&2; exit 1 ;;
    *)  state_file="$1"; shift ;;
  esac
done
[[ -n "$state_file" ]] || { echo "usage: run.sh <state.yaml> [--branch <name>]" >&2; exit 1; }

session_dir="$(dirname "$state_file")"
events_log="$session_dir/harness-events.log"
worktrees_root="$session_dir/worktrees"
mkdir -p "$worktrees_root"

[[ -f "$state_file" ]] || { echo "✗ worktree: $state_file missing" >&2; exit 1; }

local_json="$(yq -o=json '.repos.local // []' "$state_file")"
n="$(echo "$local_json" | jq 'length')"
[[ "$n" -gt 0 ]] || { echo "✗ worktree: no .repos.local — run repo-fetch first" >&2; exit 1; }

# ── feature branch resolution ─────────────────────────────────────
if [[ -z "$feature_branch" ]]; then
  feature_branch="$(yq -r '.feature.branch // ""' "$state_file")"
fi
if [[ -z "$feature_branch" || "$feature_branch" == "null" ]]; then
  short="$(yq -r '.session_id' "$state_file" | awk -F_ '{print $NF}')"
  feature_branch="feat/agent-harness-${short}"
fi

session_id="$(yq -r '.session_id' "$state_file")"
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

worktrees_arr="[]"
for i in $(seq 0 $((n - 1))); do
  name="$(echo "$local_json" | jq -r ".[$i].name")"
  repo_path="$(echo "$local_json" | jq -r ".[$i].path")"
  base="$(echo "$local_json" | jq -r ".[$i].base_branch")"
  wt_path="$worktrees_root/$name"

  status="created"
  if [[ -d "$wt_path/.git" || -f "$wt_path/.git" ]]; then
    existing_branch="$(git -C "$wt_path" branch --show-current 2>/dev/null || echo "")"
    if [[ "$existing_branch" == "$feature_branch" ]]; then
      status="reused"
    else
      echo "✗ worktree: $wt_path exists on branch '$existing_branch' (expected '$feature_branch')" >&2
      exit 1
    fi
  else
    echo "▶ $name — creating worktree at $wt_path"
    # if the branch already exists in the repo, check it out; else create.
    if git -C "$repo_path" rev-parse --verify "refs/heads/$feature_branch" >/dev/null 2>&1; then
      git -C "$repo_path" worktree add "$wt_path" "$feature_branch"
    else
      git -C "$repo_path" worktree add -b "$feature_branch" "$wt_path" "origin/$base"
    fi
  fi

  worktrees_arr="$(jq -c \
    --arg name "$name" --arg repo "$repo_path" --arg p "$wt_path" \
    --arg b "$feature_branch" --arg base "$base" --arg st "$status" \
    '. += [{name:$name, repo:$repo, path:$p, branch:$b, base:$base, status:$st}]' \
    <<<"$worktrees_arr")"

  jq -nc --arg ts "$(now)" --arg sid "$session_id" \
     --arg sum "$status $name @ $feature_branch" \
     --arg n "$name" --arg p "$wt_path" --arg b "$feature_branch" --arg s "$status" \
     '{ts:$ts, session_id:$sid, stage:"worktree", kind:"outcome",
       summary:$sum, data:{name:$n, path:$p, branch:$b, status:$s}}' \
     >>"$events_log"
done

now_ts="$(now)"
export WORKTREES_JSON="$worktrees_arr"
export FEATURE_BRANCH="$feature_branch"
export NOW="$now_ts"

yq -i '
  .updated_at = strenv(NOW) |
  .phase = "worktree" |
  .feature.branch = strenv(FEATURE_BRANCH) |
  .worktrees = (strenv(WORKTREES_JSON) | from_json)
' "$state_file"

echo "✓ worktree complete — branch=$feature_branch ($n worktree(s))"
echo "$worktrees_arr" | jq -r '.[] | "  • \(.name): \(.status) at \(.path)"'
