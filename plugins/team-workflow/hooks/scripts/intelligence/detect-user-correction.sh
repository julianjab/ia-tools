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
# Two-stage classification (prompt-first, regex-fallback):
#
#   Stage 1 — Haiku classification (preferred when `claude` CLI is available).
#             A short prompt asks the model to label the message as one of:
#             cancel|pushback|redirection|rebuttal|pause|undo|stop|retract|none.
#             Free-text, multi-language, tone-aware. Cost: ~one Haiku call
#             per user prompt in a lead session. We only fire when phase
#             is past planning, so volume is bounded.
#
#   Stage 2 — Regex fallback (deterministic). Used when `claude` is missing,
#             the call fails, or the response is unparseable. Keeps us
#             functional in CI / offline and provides a floor of coverage.
#             Bilingual patterns for cancel / pushback / redirection /
#             rebuttal / pause / undo / retract / stop.
#
# The script ALWAYS exits 0. Intelligence-bucket contract: best-effort,
# never blocks the user.
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

# ── Stage 1: Haiku classification (preferred) ────────────────────────────────
signal=""
if command -v claude >/dev/null 2>&1; then
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
  classifier_response=$(printf '%s' "$classifier_prompt" \
    | fast_claude --model claude-haiku-4-5-20251001) || classifier_response=""

  # Extract the signal field. Tolerant of leading/trailing whitespace; rejects
  # 'none' so we don't write spurious events.
  signal=$(printf '%s' "$classifier_response" \
    | grep -oE '"signal"[[:space:]]*:[[:space:]]*"[a-z_]+"' \
    | head -1 \
    | sed 's/.*"\([a-z_]*\)"$/\1/' 2>/dev/null)

  case "$signal" in
    none|"") signal="" ;;
    cancel|pushback|redirection|rebuttal|pause|undo|stop|retract) ;;  # ok
    *) signal="" ;;  # unknown label — drop to fallback
  esac
fi

# ── Stage 2: regex fallback (when classifier was unavailable or returned empty) ──
# Order matters: more-specific patterns (rebuttal, pushback) come BEFORE the
# generic ones (redirection, cancel) so a longer match wins.
if [ -z "$signal" ]; then
prompt_lc=$(printf '%s' "$prompt" | tr '[:upper:]' '[:lower:]')
case "$prompt_lc" in
  # Cancel — explicit abort.
  *cancelar*|*"cancel "*|*"cancel,"*|*"cancel."*)
    signal="cancel" ;;

  # Rebuttal — past tense correction of an assumption.
  *"asumiste mal"*|*"no debió"*|*"no debio"*\
  |*"you assumed"*|*"you got it wrong"*|*"wrong assumption"*)
    signal="rebuttal" ;;

  # Pushback — explicit "no, that's not".
  *"no, eso no"*|*"eso no es lo que"*\
  |*"no, that's not"*|*"no thats not"*|*"not what i"*)
    signal="pushback" ;;

  # Redirection — direction-setting.
  *"deberías"*|*"debias"*\
  |*"you should"*|*"you ought to"*|*"you need to"*)
    signal="redirection" ;;

  # Pause — please wait.
  *"espera,"*|*"espera "*|*"para,"*\
  |*"wait,"*|*"wait "*|*"hold on"*|*"hang on"*)
    signal="pause" ;;

  # Undo — please revert.
  *deshaz*|*revierte*\
  |*"undo "*|*"undo,"*|*"undo."*|*revert*)
    signal="undo" ;;

  # Retract request — universal.
  *retract*)
    signal="retract_request" ;;

  *)
    # Word-boundary check for "stop" to avoid matching "stopped" / "stopwatch".
    if printf '%s' "$prompt_lc" | grep -qE '(^|[[:space:][:punct:]])stop([[:space:][:punct:]]|$)'; then
      signal="stop"
    fi
    ;;
esac
fi  # end Stage 2 fallback

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
