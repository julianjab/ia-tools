#!/usr/bin/env bash
# write-event.sh — append a structured event entry to state.md's events: list.
#
# Internal hook helper. Centralizes the YAML-insert pattern that was
# duplicated across 7+ hooks (bookkeeping/subagent-stop.sh,
# bookkeeping/record-state-event.sh, intelligence/detect-*.sh). Callers pass
# a JSON object on stdin describing the event; the helper resolves the
# topic's state.md, finds the events: block in the frontmatter, and inserts
# the entry at the end of the list (creating the events: header when
# absent, normalising the inline empty form `events: []` on first write).
#
# Usage:
#   printf '%s' '<json>' | bash write-event.sh
#
# Input JSON (stdin):
#   {
#     "kind":      "task_completed",    REQUIRED. Free-form snake_case label.
#     "ts":        "2026-05-22T...Z",   Optional. Auto-filled to UTC now.
#     "subject":   "wt-backend:qa:red", Optional. Any string field.
#     "wt_prefix": "wt-backend-abc123", Optional. Any string field.
#     "<extra>":   "<any-string>"       Optional. Repeat for any field
#                                       hooks need (agent, note, url,
#                                       exit_code, etc.). All extra keys
#                                       are emitted as YAML scalars
#                                       sorted alphabetically.
#   }
#
# State dir resolution (same precedence as append-message.sh):
#   1. $IA_TW_STATE_DIR (set by start-lead.sh for lead sessions).
#   2. $IA_TW_STATE_ROOT/.current sentinel (written by
#      bootstrap-topic-state.sh on every router turn).
#
# Exit codes:
#   0  event appended, OR no state.md to write to (silent no-op so
#      callers — typically bookkeeping/intelligence hooks — can chain
#      this call without guarding it themselves).
#   1  malformed input JSON OR missing required `kind` field.
#
# Idempotency / dedup: NOT handled here. Each caller hook owns its own
# dedup logic (e.g. ts+agent+subject composite key). This script is a
# pure inserter.

set -u

payload=$(cat 2>/dev/null || true)
[ -n "$payload" ] || { printf 'write-event: empty stdin\n' >&2; exit 1; }

# Validate JSON + extract kind ─────────────────────────────────────────────
kind=$(printf '%s' "$payload" | jq -r '.kind // empty' 2>/dev/null) \
  || { printf 'write-event: malformed JSON on stdin\n' >&2; exit 1; }
[ -n "$kind" ] \
  || { printf 'write-event: missing required field .kind\n' >&2; exit 1; }

# Auto-fill ts when absent
payload=$(printf '%s' "$payload" \
  | jq --arg ts "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
      'if .ts then . else .ts = $ts end' \
    2>/dev/null)

# Resolve state dir ─────────────────────────────────────────────────────────
sd="${IA_TW_STATE_DIR:-}"
if [ -z "$sd" ]; then
  sentinel="${IA_TW_STATE_ROOT:-$HOME/.claude/team-workflow/state}/.current"
  [ -f "$sentinel" ] && sd="$(cat "$sentinel" 2>/dev/null || true)"
fi
[ -n "$sd" ] || exit 0
[ -d "$sd" ] || exit 0
state_file="$sd/state.md"
[ -f "$state_file" ] || exit 0

# Render the YAML block for this event ──────────────────────────────────────
# Order: ts first, kind second, every other key alphabetically. All values
# emitted as YAML scalars; strings are single-line-safe (jq's tostring +
# escape via dq form). Multi-line strings get their newlines collapsed to
# spaces — events are summary records, not full payloads (the long form
# already lives in messages.md / hook-audit.log).
event_block=$(printf '%s' "$payload" | jq -r '
  # Emit a YAML scalar. Quote ONLY when the value contains characters
  # that would change the YAML parse — `: ` (key separator), leading
  # YAML-significant char (! & * % @ etc.), newlines, or leading/
  # trailing whitespace. Multi-line strings are flattened to one line
  # because events: are summary records; long form lives in messages.md
  # and hook-audit.log. The conservative quoting matches the convention
  # used by the legacy per-hook awk emitters and keeps downstream
  # idempotency greps (`grep -qF "kind: foo"`) working.
  def needs_quote:
    type == "string" and (
         test(":[ \\t]")
      or test("^[\"'"'"'!&*%@`?|>-]")
      or test("\\n")
      or test("^[[:space:]]")
      or test("[[:space:]]$")
      or test("^(true|false|null|~|yes|no|on|off)$"; "i")
      or test("^-?[0-9]+(\\.[0-9]+)?$")
    );
  def fmt_value:
    if type == "string" then
      if needs_quote then
        "\"" + (. | gsub("\n"; " ") | gsub("\""; "\\\"")) + "\""
      else . end
    elif type == "boolean" or type == "number" then tostring
    elif type == "null" then "null"
    else (tostring) end;
  ([
    "  - ts: " + (.ts | fmt_value),
    "    kind: " + (.kind | fmt_value)
  ] + (to_entries
        | map(select(.key != "ts" and .key != "kind"))
        | sort_by(.key)
        | map("    " + .key + ": " + (.value | fmt_value))
      )
  ) | join("\n")
' 2>/dev/null)

[ -n "$event_block" ] \
  || { printf 'write-event: failed to render event block from JSON\n' >&2; exit 1; }

# Insert into state.md's frontmatter events: list ───────────────────────────
# Awk handles four layouts:
#   (a) `events:` exists multi-line with prior entries  → append at end
#       of list (right before the next non-indented frontmatter key, or
#       the closing `---` of the frontmatter).
#   (b) `events:` exists multi-line with no entries     → append directly.
#   (c) `events: []` (inline empty)                     → rewrite as
#       `events:` + the new entry block (so future writes use form a).
#   (d) `events:` absent                                → emit
#       `events:` header + entry block right before the closing `---`.
#
# The multi-line event block is staged in a temp file and read back with
# `getline` so we don't have to pass it via `-v block=...` (BSD awk on
# macOS rejects newlines inside `-v` assignments).
block_file=$(mktemp 2>/dev/null) || exit 0
printf '%s\n' "$event_block" > "$block_file"

tmp=$(mktemp 2>/dev/null) || { rm -f "$block_file"; exit 0; }

awk -v block_file="$block_file" '
  function emit_block(    line) {
    while ((getline line < block_file) > 0) print line
    close(block_file)
  }
  BEGIN { state = "pre"; in_events = 0; block_emitted = 0 }

  # Frontmatter open
  state == "pre" && /^---$/ { state = "front"; print; next }

  # Frontmatter close
  state == "front" && /^---$/ {
    if (block_emitted == 0) {
      if (in_events == 0) print "events:"
      emit_block()
      block_emitted = 1
    }
    state = "body"
    print
    next
  }

  # Inside frontmatter
  state == "front" {
    # events: [] (inline empty) → rewrite as multi-line + block
    if (block_emitted == 0 && $0 ~ /^events:[[:space:]]*\[\][[:space:]]*$/) {
      print "events:"
      emit_block()
      in_events = 1
      block_emitted = 1
      next
    }
    # events: (multi-line header, no value) → enter list
    if (block_emitted == 0 && $0 ~ /^events:[[:space:]]*$/) {
      print
      in_events = 1
      next
    }
    # Inside events: list — indented continuation lines pass through
    if (in_events == 1 && $0 ~ /^[[:space:]]+/) { print; next }
    # Left events: list at a sibling key. Emit block before this line.
    if (in_events == 1 && block_emitted == 0) {
      emit_block()
      block_emitted = 1
      in_events = 0
    }
    print
    next
  }

  # Body
  { print }
' "$state_file" > "$tmp" 2>/dev/null

if [ -s "$tmp" ]; then
  mv "$tmp" "$state_file" 2>/dev/null || rm -f "$tmp" 2>/dev/null
else
  rm -f "$tmp" 2>/dev/null
fi
rm -f "$block_file" 2>/dev/null

exit 0
