#!/usr/bin/env bash
# detect-coverage-gate.sh — records coverage-gate iterations from push attempts.
#
# Bucket:      intelligence
# Listens to:  PostToolUse  (matcher: Bash)
# Blocking:    no (always exit 0)
# Input  (stdin JSON): { "tool_name": "Bash",
#                       "tool_input":    { "command": "<bash command>" },
#                       "tool_response": { "output":  "<stdout+stderr>" } }
# Output: exit 0 always; appends `kind: coverage_gate_iteration` to state.md
#         events: when a coverage failure pattern is detected in the output
#         of a `git push` (or equivalent) command.
#
# Detection signals (in tool_response.output):
#
#   - "[pre-push] ... FAIL"          repo's pre-push coverage gate
#   - "coverage ... below threshold" generic coverage gate
#   - "FAIL" near "coverage" within ±5 lines
#
# We only inspect the output when the command itself was a push-related
# operation (push, gh pr create, git rebase + push), to avoid scanning every
# unrelated bash invocation.

set -u

payload=$(cat)

[ -n "${IA_TW_STATE_DIR:-}" ] || exit 0
state_file="${IA_TW_STATE_DIR}/state.md"
[ -f "$state_file" ] || exit 0

tool_name=$(printf '%s' "$payload" | jq -r '.tool_name // empty' 2>/dev/null)
[ "$tool_name" = "Bash" ] || exit 0

command=$(printf '%s' "$payload" | jq -r '.tool_input.command // empty' 2>/dev/null)
[ -n "$command" ] || exit 0

# Only inspect output for push-shaped commands.
case "$command" in
  *"git push"*|*"git -C "*"push"*|*"gh pr create"*|*"gh pr ready"*) ;;
  *) exit 0 ;;
esac

# The output may be on stdout, stderr, or a tool-specific field. PostToolUse
# typically surfaces it under .tool_response.output for Bash.
output=$(printf '%s' "$payload" | jq -r '.tool_response.output // empty' 2>/dev/null)
[ -n "$output" ] || exit 0

# ── Detect coverage failure signal ────────────────────────────────────────────
# Pre-push hook output is NOT controlled by ia-tools — every consumer repo
# can emit a different shape (lahaus backend uses "[pre-push] FAIL …", an
# Astro repo might say "Coverage 71% below 80% threshold", a Cargo project
# something else entirely). Two-stage detection:
#
#   Stage 1 — Haiku classification (preferred). One short call asks
#             "did this push fail because of coverage?". Output is parsed
#             as {"coverage_failure": true|false}.
#
#   Stage 2 — Regex fallback for common phrasings. Used when claude is
#             unavailable or the response doesn't parse.

# Truncate input so the prompt stays small (output can be megabytes).
# Coverage messages typically appear in the first ~3 KB of pre-push output.
output_for_prompt=$(printf '%s' "$output" | head -c 3072)

is_coverage_failure=0
if command -v claude >/dev/null 2>&1 && [ -n "$output_for_prompt" ]; then
  classifier_prompt="The following text is the output of a 'git push' attempt that may have been rejected by a pre-push hook. Determine if the failure was caused by a CODE COVERAGE threshold (e.g. coverage gate, coverage below N%, --cov-fail-under, jest --coverage threshold, tarpaulin minimum) — and NOT by some other reason (lint, type-check, test failures unrelated to coverage, network error, branch protection).

  ---
  ${output_for_prompt}
  ---

  Output ONLY a JSON object on one line:
    {\"coverage_failure\": true}
    {\"coverage_failure\": false}
  No prose, no markdown, no code fence."

  . "$(dirname "$0")/_fast_claude.sh"
  classifier_response=$(printf '%s' "$classifier_prompt" \
    | fast_claude --model claude-haiku-4-5-20251001) || classifier_response=""

  case "$classifier_response" in
    *'"coverage_failure"'*':'*'true'*)  is_coverage_failure=1 ;;
    *'"coverage_failure"'*':'*'false'*) is_coverage_failure=0 ;;
    *) is_coverage_failure=-1 ;;  # unparseable → drop to fallback
  esac
fi

# Stage 2 fallback (also runs when Haiku unavailable / unparseable).
if [ "$is_coverage_failure" = "-1" ] || [ "$is_coverage_failure" = "0" -a ! -x "$(command -v claude 2>/dev/null)" ]; then
  if printf '%s' "$output" | grep -qiE 'pre-push.*FAIL|coverage.*below|FAIL.*coverage|coverage.*FAIL|--cov-fail-under|coverage threshold' 2>/dev/null; then
    is_coverage_failure=1
  else
    is_coverage_failure=0
  fi
fi

[ "$is_coverage_failure" = "1" ] || exit 0

# Try to extract the wt_prefix from the command (look for .worktrees/<feature>
# in -C / cwd; map to wt_prefix via state.md if possible).
worktree_path=""
case "$command" in
  *"-C "*) worktree_path=$(printf '%s' "$command" | grep -oE '(-C[[:space:]]+)[^ ]+' | head -1 | sed 's/^-C[[:space:]]*//') ;;
esac

wt_prefix=""
if [ -n "$worktree_path" ]; then
  wt_prefix=$(awk -v wp="$worktree_path" '
    $0 ~ "worktree:[[:space:]]*" wp { in_block = 1 }
    in_block && /^[[:space:]]*wt_prefix:[[:space:]]/ {
      gsub(/^[[:space:]]*wt_prefix:[[:space:]]*/, "")
      print; exit
    }
  ' "$state_file" 2>/dev/null)
fi

# Build a short excerpt of the failure: first 6 lines containing FAIL or
# coverage, joined.
excerpt=$(printf '%s' "$output" \
  | grep -iE 'FAIL|coverage' 2>/dev/null \
  | head -6 \
  | tr '\n' ' ' \
  | sed 's/[[:space:]]\+/ /g' \
  | cut -c1-300 \
  | sed 's/"/\\"/g')

ts=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

# Dedupe key: ts (second) + wt_prefix + excerpt hash.
key_hash=$(printf '%s|%s|%s' "$ts" "$wt_prefix" "$excerpt" \
  | cksum 2>/dev/null | awk '{print $1}')
if grep -qF "coverage_gate:${key_hash}" "$state_file" 2>/dev/null; then
  exit 0
fi

tmp=$(mktemp 2>/dev/null) || exit 0
awk -v ts="$ts" -v wt="$wt_prefix" -v excerpt="$excerpt" -v key_hash="$key_hash" '
  BEGIN { state = "pre"; has_events_header = 0 }
  state == "pre" && /^---$/ { state = "front"; print; next }
  state == "front" && /^---$/ {
    if (has_events_header == 0) print "events:"
    printf "  - ts: %s\n",                       ts
    printf "    kind: coverage_gate_iteration\n"
    if (wt != "")      printf "    wt_prefix: %s\n", wt
    if (excerpt != "") printf "    excerpt: \"%s\"\n", excerpt
    printf "    dedupe_key: coverage_gate:%s\n", key_hash
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
rm -f "$tmp" 2>/dev/null || true

exit 0
