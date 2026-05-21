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
# Signals (regex-based, V1 — no LLM call):
#
#   - "cancelar"             (case-insensitive, whole word)   — explicit cancel
#   - "no, eso no"           — explicit pushback
#   - "deberías" / "debias"  — direction-setting
#   - "espera"               — pause request
#   - "stop"                 (Bash command guard line; whole word)
#   - "retract"              — explicit retract
#   - "no debió"             — past correction
#   - "asumiste mal"         — assumption rebuttal
#   - "eso no es lo que"     — misunderstanding
#
# Only fires in active lead sessions (IA_TW_FEATURE set), and only when phase
# is NOT "planning" (planning-phase edits go through the approval gate, which
# is its own signal channel). Otherwise no-op.
#
# A future revision MAY call `claude -p` (Haiku) for ambiguous content
# (S13 permits this in the intelligence bucket). V1 keeps it deterministic.

set -u

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

# Detect signals (case-insensitive, ERE).
signal=""
prompt_lc=$(printf '%s' "$prompt" | tr '[:upper:]' '[:lower:]')
case "$prompt_lc" in
  *cancelar*)                        signal="cancel" ;;
  *"no, eso no"*|*"eso no es lo que"*) signal="pushback" ;;
  *"deberías"*|*"debias"*)            signal="redirection" ;;
  *"asumiste mal"*|*"no debió"*|*"no debio"*) signal="rebuttal" ;;
  *retract*)                          signal="retract_request" ;;
  *"espera,"*|*"espera "*|*"para,"*)   signal="pause" ;;
  *)
    # Word-boundary check for "stop" to avoid matching "stopped" / "stopwatch".
    if printf '%s' "$prompt_lc" | grep -qE '(^|[[:space:][:punct:]])stop([[:space:][:punct:]]|$)'; then
      signal="stop"
    fi
    ;;
esac

[ -n "$signal" ] || exit 0

ts=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

# Dedupe key: ts (second granularity) + first 32 chars of prompt.
# Retries within the same second on identical prompts are skipped; same
# wording 1 s+ apart is treated as distinct.
key_hash=$(printf '%s|%s' "$ts" "${prompt:0:32}" | cksum 2>/dev/null | awk '{print $1}')
if grep -qF "user_correction:${key_hash}" "$state_file" 2>/dev/null; then
  exit 0
fi

# One-line excerpt (first 200 chars, collapsed).
excerpt=$(printf '%s' "$prompt" \
  | tr '\n\r\t' '   ' \
  | sed 's/[[:space:]]\+/ /g' \
  | sed 's/^[[:space:]]*//' \
  | cut -c1-200 \
  | sed 's/"/\\"/g')

tmp=$(mktemp 2>/dev/null) || exit 0
awk -v ts="$ts" -v signal="$signal" -v excerpt="$excerpt" -v key_hash="$key_hash" '
  BEGIN { state = "pre"; has_events_header = 0 }
  state == "pre" && /^---$/ { state = "front"; print; next }
  state == "front" && /^---$/ {
    if (has_events_header == 0) print "events:"
    printf "  - ts: %s\n",                ts
    printf "    kind: user_correction\n"
    printf "    signal: %s\n",            signal
    printf "    excerpt: \"%s\"\n",       excerpt
    printf "    dedupe_key: user_correction:%s\n", key_hash
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
