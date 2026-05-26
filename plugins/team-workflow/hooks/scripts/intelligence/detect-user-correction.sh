#!/usr/bin/env bash
# detect-user-correction.sh — captures user corrections in mid-flight sessions.
#
# Bucket:      intelligence
# Listens to:  UserPromptSubmit
# Blocking:    no (always exit 0)
# Input  (stdin JSON): { "prompt": "<user message>", ... }
# Output: exit 0 always; appends `kind: user_correction` to state.md events:
#         when a deterministic correction signal is detected.
#
# Haiku-only classification. A short prompt asks the model to label the
# message as one of:
#   cancel | pushback | redirection | rebuttal | pause | undo | stop |
#   retract | none.
# Free-text, multi-language, tone-aware. Cost: ~one Haiku call per user
# prompt in a lead session. We fire only when phase is past planning, so
# volume is bounded.
#
# When `claude` is missing or the call returns nothing, the script exits 0
# with no event written. Per the intelligence-bucket contract, this is
# best-effort — no regex floor, no silent guessing. Operators who need
# offline coverage configure CLAUDE_CODE_OAUTH_TOKEN (subscription auth)
# or ANTHROPIC_API_KEY (API auth) so the call succeeds in CI / Docker;
# see _fast_claude.sh for the env-var matrix.
#
# Fires only in active lead sessions (IA_TW_FEATURE set), and only when
# the recorded phase is past planning (planning-phase edits go through the
# approval gate, which is its own signal channel).

set -u

# Recursion guard. fast_claude spawns `claude -p` which inherits IA_TW_*
# and re-fires UserPromptSubmit with the classifier's own template as
# `.prompt`. Without this guard, the hook ends up classifying its own
# wrapper text ("Classify this user message...") and writing garbage
# events to state.md. The export below propagates IA_TW_IN_HOOK to the
# child so the recursive invocation bails here.
[ -z "${IA_TW_IN_HOOK:-}" ] || exit 0

payload=$(cat)

[ -n "${IA_TW_FEATURE:-}" ]   || exit 0
[ -n "${IA_TW_STATE_DIR:-}" ] || exit 0

state_file="${IA_TW_STATE_DIR}/state.md"
[ -f "$state_file" ] || exit 0

# Skip planning phase — approval-gate edits are not "corrections" in the
# memory-feedback sense.
phase=$(grep '^phase:' "$state_file" 2>/dev/null | head -1 | sed 's/phase:[[:space:]]*//')
[ "$phase" != "planning" ] || exit 0

prompt=$(printf '%s' "$payload" | jq -r '.prompt // empty' 2>/dev/null)
[ -n "$prompt" ] || exit 0

# ── Haiku classification ─────────────────────────────────────────────────────
signal=""
command -v claude >/dev/null 2>&1 || exit 0

classifier_prompt="Classify this user message from a software-engineering chat:

  ---
  ${prompt}
  ---

  Pick ONE label that best matches:

    cancel       — the user explicitly wants to abort the current work
    pushback     — the user rejects something just done ('no, that's not it')
    redirection  — the user steers toward a different approach ('you should X')
    rebuttal     — the user corrects a wrong assumption you held
    pause        — the user wants to stop momentarily (not abort)
    undo         — the user wants the last action reverted
    stop         — the user wants execution halted entirely
    retract      — the user explicitly invokes 'retract' / 'unretract'
    none         — the message is neither a correction nor a steer

  Output ONLY a JSON object on one line: {\"signal\":\"<label>\"}
  No prose, no markdown, no code fence."

. "$(dirname "$0")/_fast_claude.sh"
export IA_TW_IN_HOOK=1
classifier_response=$(printf '%s' "$classifier_prompt" \
  | fast_claude --model claude-haiku-4-5-20251001) || classifier_response=""
unset IA_TW_IN_HOOK

# Extract the signal field. Rejects 'none' so we don't write spurious events.
signal=$(printf '%s' "$classifier_response" \
  | grep -oE '"signal"[[:space:]]*:[[:space:]]*"[a-z_]+"' \
  | head -1 \
  | sed 's/.*"\([a-z_]*\)"$/\1/' 2>/dev/null)

case "$signal" in
  cancel|pushback|redirection|rebuttal|pause|undo|stop|retract) ;;
  *) exit 0 ;;  # 'none', empty, or unknown → exit without writing
esac

ts=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

# Dedupe key: ts (second granularity) + first 32 chars of prompt.
# Retries within the same second on identical prompts are skipped; same
# wording 1 s+ apart is treated as distinct.
key_hash=$(printf '%s|%s' "$ts" "${prompt:0:32}" | cksum 2>/dev/null | awk '{print $1}')
if grep -qF "user_correction:${key_hash}" "$state_file" 2>/dev/null; then
  exit 0
fi

# One-line excerpt (first 200 chars, collapsed). No "-escaping needed —
# write-event.sh quotes when it sees ":" or other YAML-significant chars.
excerpt=$(printf '%s' "$prompt" \
  | tr '\n\r\t' '   ' \
  | sed 's/[[:space:]]\+/ /g' \
  | sed 's/^[[:space:]]*//' \
  | cut -c1-200)

# Delegate the YAML insert to the shared helper.
jq -n \
  --arg ts         "$ts" \
  --arg signal     "$signal" \
  --arg excerpt    "$excerpt" \
  --arg key_hash   "$key_hash" '{
    ts:         $ts,
    kind:       "user_correction",
    signal:     $signal,
    excerpt:    $excerpt,
    dedupe_key: ("user_correction:" + $key_hash)
  }' | bash "$(dirname "$0")/../lib/write-event.sh" || true

exit 0
