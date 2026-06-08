#!/usr/bin/env bash
# bin/harness-eval.sh — run fixture-based evals against inferential stages.
#
# Usage:
#   harness-eval.sh [--stage <name>] [--case <name>] [--keep]
#
#   --stage <name>   restrict to one stage (e.g. intake)
#   --case <name>    restrict to one case directory
#   --keep           keep the temp session dirs (default: rm on success)
#
# Fixtures layout:
#   plugins/agent-harness/examples/evals/<stage>/<case>/
#     input.txt       what the stage receives
#     expected.yaml   assertions (intent, min_targets, scope_hint_contains, …)
#
# A case PASSES when every assertion in expected.yaml holds against the
# stage's output written to state.yaml. Unsupported assertions are
# reported as a warning, not a failure, so fixtures can declare aspiration
# expectations the runner will check once it knows how.
#
# Output: a fixed-format report block at the end, plus one line per case
# (✓ pass, ✗ fail) along the way. Exit non-zero if any case fails.

set -euo pipefail

STAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$STAGE_DIR/.." && pwd)"
EVALS_DIR="$PLUGIN_ROOT/examples/evals"

only_stage=""
only_case=""
keep=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --stage) only_stage="$2"; shift 2 ;;
    --case)  only_case="$2";  shift 2 ;;
    --keep)  keep=1; shift ;;
    -*) echo "✗ unknown flag $1" >&2; exit 1 ;;
    *)  echo "✗ unexpected arg $1" >&2; exit 1 ;;
  esac
done

[[ -d "$EVALS_DIR" ]] || { echo "✗ no evals dir at $EVALS_DIR" >&2; exit 1; }

run_intake_case() {
  local case_dir="$1" name="$2"
  local input expected tmp state
  input="$(cat "$case_dir/input.txt")"
  expected="$case_dir/expected.yaml"

  tmp="$(mktemp -d -t harness-eval-intake-XXXX)"
  state="$tmp/state.yaml"

  if ! bash "$PLUGIN_ROOT/stages/intake/run.sh" "$state" "$input" >/dev/null 2>"$tmp/stderr"; then
    echo "✗ $name — intake script exit non-zero"
    sed 's/^/    /' "$tmp/stderr" | head -5
    [[ "$keep" -eq 1 ]] || rm -rf "$tmp"
    return 1
  fi

  local intent n_targets scope_hint titles_json
  intent="$(yq -r '.intake.result.intent' "$state")"
  n_targets="$(yq -o=json '.intake.result.targets' "$state" | jq 'length')"
  scope_hint="$(yq -r '.intake.result.signals.scope_hint' "$state")"
  titles_json="$(yq -o=json '.intake.result.targets' "$state" | jq '[.[] | .title]')"

  local fails=0 reasons=()

  local want_intent want_min want_max want_scope
  want_intent="$(yq -r '.intent // ""' "$expected")"
  want_min="$(yq -r '.min_targets // ""' "$expected")"
  want_max="$(yq -r '.max_targets // ""' "$expected")"
  want_scope="$(yq -r '.scope_hint_contains // ""' "$expected")"

  if [[ -n "$want_intent" && "$want_intent" != "$intent" ]]; then
    fails=$((fails+1)); reasons+=("intent: expected '$want_intent', got '$intent'")
  fi
  if [[ -n "$want_min" && "$n_targets" -lt "$want_min" ]]; then
    fails=$((fails+1)); reasons+=("targets: expected ≥ $want_min, got $n_targets")
  fi
  if [[ -n "$want_max" && "$n_targets" -gt "$want_max" ]]; then
    fails=$((fails+1)); reasons+=("targets: expected ≤ $want_max, got $n_targets")
  fi
  if [[ -n "$want_scope" ]]; then
    if ! echo "$scope_hint" | grep -qi -- "$want_scope"; then
      fails=$((fails+1)); reasons+=("scope_hint: expected to contain '$want_scope', got '$scope_hint'")
    fi
  fi

  # title group assertion (any title in titles_json must contain a token from
  # any of the listed groups; if a group has no match, that's a failure).
  local groups; groups="$(yq -o=json '.target_titles_must_contain_any_of // {}' "$expected")"
  if [[ "$groups" != "{}" && "$groups" != "null" ]]; then
    for gkey in $(echo "$groups" | jq -r 'keys[]'); do
      local tokens; tokens="$(echo "$groups" | jq -c --arg k "$gkey" '.[$k]')"
      local hit
      hit="$(jq -rn --argjson titles "$titles_json" --argjson tokens "$tokens" '
        ($titles[] | ascii_downcase) as $t |
        ($tokens[] | ascii_downcase) as $tok |
        select($t | test($tok)) | "hit"
      ' 2>/dev/null | head -1)"
      if [[ -z "$hit" ]]; then
        fails=$((fails+1))
        reasons+=("titles: group '$gkey' had no match in titles=$(echo "$titles_json" | jq -c .)")
      fi
    done
  fi

  if [[ "$fails" -eq 0 ]]; then
    echo "✓ $name (intent=$intent, targets=$n_targets)"
    [[ "$keep" -eq 1 ]] || rm -rf "$tmp"
    return 0
  fi

  echo "✗ $name"
  for r in "${reasons[@]}"; do echo "    - $r"; done
  echo "    state: $state"
  return 1
}

pass=0
fail=0
total=0

for stage_dir in "$EVALS_DIR"/*/; do
  stage="$(basename "$stage_dir")"
  [[ -z "$only_stage" || "$only_stage" == "$stage" ]] || continue

  echo "── stage: $stage ───────────────────────────────────────────"
  for case_dir in "$stage_dir"*/; do
    case_name="$(basename "$case_dir")"
    [[ -z "$only_case" || "$only_case" == "$case_name" ]] || continue
    total=$((total+1))
    case "$stage" in
      intake) run_intake_case "$case_dir" "$case_name" && pass=$((pass+1)) || fail=$((fail+1)) ;;
      *) echo "⚠ $case_name — runner for stage '$stage' not implemented yet"; fail=$((fail+1)) ;;
    esac
  done
done

echo
echo "harness-eval summary"
echo "  total:  $total"
echo "  pass:   $pass"
echo "  fail:   $fail"
echo
if [[ "$fail" -gt 0 ]]; then
  echo "Verdict: FAIL"
  exit 1
fi
echo "Verdict: PASS"
