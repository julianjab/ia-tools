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

# ── Detect coverage failure signal (Haiku-only) ──────────────────────────────
# Pre-push hook output is NOT controlled by ia-tools — every consumer repo
# emits a different shape (lahaus backend uses "[pre-push] FAIL …", an Astro
# repo might say "Coverage 71% below 80% threshold", a Cargo project something
# else entirely). Haiku reads the output and decides whether the failure was
# a coverage threshold. No regex floor: when `claude` is missing or the call
# fails, the hook exits 0 with no event written.
#
# Operators who need offline coverage configure CLAUDE_CODE_OAUTH_TOKEN
# (subscription auth) or ANTHROPIC_API_KEY (API auth); see _fast_claude.sh.
command -v claude >/dev/null 2>&1 || exit 0

# Truncate input so the prompt stays small (output can be megabytes).
# Coverage messages typically appear in the first ~3 KB of pre-push output.
output_for_prompt=$(printf '%s' "$output" | head -c 3072)
[ -n "$output_for_prompt" ] || exit 0

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
  *'"coverage_failure"'*':'*'true'*) ;;            # ok — proceed to write event
  *) exit 0 ;;                                      # false, unparseable, empty → no event
esac

# Haiku confirmed this is a coverage failure — fall through to event emission.

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
# coverage, joined. No "-escaping — write-event.sh handles quoting.
excerpt=$(printf '%s' "$output" \
  | grep -iE 'FAIL|coverage' 2>/dev/null \
  | head -6 \
  | tr '\n' ' ' \
  | sed 's/[[:space:]]\+/ /g' \
  | cut -c1-300)

ts=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

# Dedupe key: ts (second) + wt_prefix + excerpt hash.
key_hash=$(printf '%s|%s|%s' "$ts" "$wt_prefix" "$excerpt" \
  | cksum 2>/dev/null | awk '{print $1}')
if grep -qF "coverage_gate:${key_hash}" "$state_file" 2>/dev/null; then
  exit 0
fi

# Delegate the YAML insert to the shared helper. Optional fields are
# included only when non-empty (write-event.sh emits whatever keys the
# JSON carries).
jq -n \
  --arg ts         "$ts" \
  --arg wt         "$wt_prefix" \
  --arg excerpt    "$excerpt" \
  --arg key_hash   "$key_hash" '
  {
    ts:         $ts,
    kind:       "coverage_gate_iteration",
    dedupe_key: ("coverage_gate:" + $key_hash)
  }
  | if ($wt      | length) > 0 then .wt_prefix = $wt      else . end
  | if ($excerpt | length) > 0 then .excerpt   = $excerpt else . end
' | bash "$(dirname "$0")/../lib/write-event.sh" || true

exit 0
