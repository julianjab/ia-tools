#!/usr/bin/env bash
# extract-memory-signal.sh — materializes correction events into feedback memory.
#
# Bucket:      intelligence
# Listens to:  SessionEnd
# Blocking:    no (always exit 0)
# Input  (stdin JSON): { "end_reason": "...", "transcript_path": "...", ... }
# Output: exit 0 always; writes feedback_<slug>.md files under
#         ~/.claude/projects/<encoded-cwd>/memory/ for the IA_TW_ROOT_DIR
#         and each touched consumer repo (N+1 destinations).
#
# Reads state.md events: block. Collects every entry of kind:
#
#   user_correction       — signal from detect-user-correction.sh
#   marker_retracted      — signal from detect-retract.sh
#   task_replaced         — signal from detect-task-replaced.sh
#   coverage_gate_iteration — signal from detect-coverage-gate.sh
#   green_retracted       — written by lead manually when revoking a green
#
# Groups them by repo (using wt_prefix → repo lookup in state.md). For each
# group, writes one file:
#
#   ~/.claude/projects/<encoded-repo-path>/memory/feedback_<feature>.md
#
# Plus one summary file at the lead's root dir:
#
#   ~/.claude/projects/<encoded-IA_TW_ROOT_DIR>/memory/feedback_<feature>.md
#
# Each file follows the auto-memory schema: frontmatter (name/description/
# metadata.type: feedback) + body sections Rule / Why / How to apply.
#
# Best-effort: missing claude CLI, write errors, or empty events block all
# yield a clean exit 0. Runs AFTER session-end.sh in the SessionEnd chain so
# the lead memory extraction has already landed before this fires.

set -u

[ -n "${IA_TW_STATE_DIR:-}" ] || exit 0
state_file="${IA_TW_STATE_DIR}/state.md"
[ -f "$state_file" ] || exit 0

phase=$(grep '^phase:' "$state_file" 2>/dev/null | head -1 | sed 's/phase:[[:space:]]*//')
case "$phase" in
  merged|prs-open) ;;
  *) exit 0 ;;
esac

feature=$(grep '^feature:' "$state_file" 2>/dev/null | head -1 | sed 's/feature:[[:space:]]*//')
root_dir=$(grep '^root_dir:' "$state_file" 2>/dev/null | head -1 | sed 's/root_dir:[[:space:]]*//')
[ -n "$feature" ] || exit 0

date_now=$(date -u '+%Y-%m-%d')
feature_slug=$(printf '%s' "$feature" | tr '/' '-' | tr ' ' '-' | tr '[:upper:]' '[:lower:]')

# ── Helper: encode a cwd path to the Claude auto-memory directory name ────
# /Users/x/dev/repo  →  -Users-x-dev-repo
encode_cwd() {
  printf '%s' "$1" | sed 's|/|-|g'
}

# ── Helper: collect events of correction-shaped kinds ─────────────────────
# Returns lines of the form "kind|wt_prefix|excerpt" (one per event).
collect_events() {
  awk '
    /^[[:space:]]+- ts:/ { in_event = 1; kind = ""; wt = ""; excerpt = ""; next }
    in_event && /^[[:space:]]+kind:[[:space:]]/ {
      gsub(/^[[:space:]]+kind:[[:space:]]*/, "")
      kind = $0
    }
    in_event && /^[[:space:]]+wt_prefix:[[:space:]]/ {
      gsub(/^[[:space:]]+wt_prefix:[[:space:]]*/, "")
      wt = $0
    }
    in_event && /^[[:space:]]+(excerpt|note|marker|reason):/ {
      gsub(/^[[:space:]]+(excerpt|note|marker|reason):[[:space:]]*/, "")
      gsub(/^"/, ""); gsub(/"$/, "")
      excerpt = $0
    }
    /^[[:space:]]+- ts:/ && in_event {
      # next event: flush previous
    }
    in_event && /^[a-zA-Z]/ { in_event = 0 }
    END {
      if (in_event && kind != "") print kind "|" wt "|" excerpt
    }
    {
      if (in_event && kind ~ /^(user_correction|marker_retracted|task_replaced|coverage_gate_iteration|green_retracted)$/) {
        # noop, kept for clarity; END handles flush
      }
    }
  ' "$state_file" 2>/dev/null
}

# Slightly simpler approach: walk events: block linearly, emit one line per
# correction-kind event with a fixed schema.
collect_correction_events() {
  awk '
    BEGIN { state = "pre"; entry_kind = ""; entry_wt = ""; entry_note = "" }
    /^events:[[:space:]]*$/ { state = "events"; next }
    state == "events" && /^[a-zA-Z]/ && !/^events:/ { state = "after" }
    state != "events" { next }

    /^[[:space:]]+- ts:[[:space:]]/ {
      if (entry_kind ~ /^(user_correction|marker_retracted|task_replaced|coverage_gate_iteration|green_retracted)$/) {
        printf "%s|%s|%s\n", entry_kind, entry_wt, entry_note
      }
      entry_kind = ""; entry_wt = ""; entry_note = ""
      next
    }
    /^[[:space:]]+kind:[[:space:]]/ {
      gsub(/^[[:space:]]+kind:[[:space:]]*/, "")
      entry_kind = $0; next
    }
    /^[[:space:]]+wt_prefix:[[:space:]]/ {
      gsub(/^[[:space:]]+wt_prefix:[[:space:]]*/, "")
      entry_wt = $0; next
    }
    /^[[:space:]]+(excerpt|note|marker|signal|reason):/ {
      sub(/^[[:space:]]+(excerpt|note|marker|signal|reason):[[:space:]]*/, "")
      sub(/^"/, ""); sub(/"$/, "")
      if (entry_note == "") entry_note = $0
      next
    }
    END {
      if (entry_kind ~ /^(user_correction|marker_retracted|task_replaced|coverage_gate_iteration|green_retracted)$/) {
        printf "%s|%s|%s\n", entry_kind, entry_wt, entry_note
      }
    }
  ' "$state_file" 2>/dev/null
}

# ── Helper: resolve wt_prefix → repo path from state.md ───────────────────
wt_to_repo() {
  local wt="$1"
  awk -v wt="$wt" '
    /^  - repo:/ { gsub(/^  - repo:[[:space:]]*/, ""); cur_repo = $0 }
    $0 ~ "wt_prefix:[[:space:]]*" wt "([^[:alnum:]_-]|$)" {
      print cur_repo
      exit
    }
  ' "$state_file" 2>/dev/null
}

# ── Helper: write one feedback memory file ────────────────────────────────
# Args: $1=auto_mem_dir  $2=name_slug  $3=scope_label  $4=events_lines_file
write_feedback() {
  local mem_dir="$1" name_slug="$2" scope_label="$3" events_file="$4"
  local mem_file="$mem_dir/feedback_${name_slug}.md"
  local index_file="$mem_dir/MEMORY.md"

  mkdir -p "$mem_dir" 2>/dev/null || return 0
  [ -s "$events_file" ] || return 0

  # Skip if a memory for this feature is already recorded (idempotency).
  [ -f "$mem_file" ] && return 0

  # Build the markdown body.
  local n
  n=$(wc -l < "$events_file" 2>/dev/null | tr -d ' ')
  local desc="Correction signals observed during ${feature} (${scope_label}): ${n} events including retracts, user corrections, coverage iterations. Source: state.md events block."

  {
    printf '%s\n' '---'
    printf 'name: feedback-%s\n' "$name_slug"
    printf 'description: %s\n'   "$desc"
    printf 'metadata:\n'
    printf '  type: feedback\n'
    printf '%s\n\n' '---'
    printf '# Feedback — %s [%s]\n\n' "$feature" "$scope_label"
    printf '> Auto-extracted by the team-workflow SessionEnd hook on %s.\n\n' "$date_now"

    # Group by kind.
    for k in user_correction marker_retracted green_retracted task_replaced coverage_gate_iteration; do
      local count
      count=$(grep -c "^${k}|" "$events_file" 2>/dev/null || true)
      [ "${count:-0}" -gt 0 ] || continue

      case "$k" in
        user_correction)        printf '## Correcciones explícitas del usuario (%s)\n\n' "$count" ;;
        marker_retracted)       printf '## Markers retractados (%s)\n\n' "$count" ;;
        green_retracted)        printf '## Greens revocados por revisión (%s)\n\n' "$count" ;;
        task_replaced)          printf '## Tareas reabiertas / reemplazadas (%s)\n\n' "$count" ;;
        coverage_gate_iteration) printf '## Iteraciones de coverage gate (%s)\n\n' "$count" ;;
      esac

      grep "^${k}|" "$events_file" 2>/dev/null | while IFS='|' read -r _kind wt note; do
        if [ -n "$wt" ]; then
          printf -- '- **%s** — %s\n' "$wt" "$note"
        else
          printf -- '- %s\n' "$note"
        fi
      done
      printf '\n'
    done

    printf '## How to apply\n\n'
    printf 'Revisa este archivo antes de planear features similares en este repo. Los patrones de fricción recurrente suelen indicar:\n\n'
    printf -- '- **Markers retractados / greens revocados** → la rama de definición de "done" del agente impl no incluye un check que sí importa al humano. Ajusta el contrato del task (acceptance criteria explícito) o el verdict del agente.\n'
    printf -- '- **Coverage gate iterations** → estima el gap de coverage por módulo upfront y crea task de coverage como hermano del impl:green, no como follow-up.\n'
    printf -- '- **User corrections explícitas** → revisa qué señal del plan se interpretó mal y endurece la sección correspondiente de la próxima propuesta.\n'
    printf -- '- **Task replaced** → un task se completó y fue reabierto; el verdict original era prematuro. Reforzar el gate antes de marcar completed.\n'
  } > "$mem_file" 2>/dev/null || return 0

  # Update MEMORY.md index (truncate-friendly: each entry one line).
  local index_line="- [Feedback ${feature} (${scope_label})](feedback_${name_slug}.md) — ${n} correction events captured by the team-workflow session-end hook"
  if [ -f "$index_file" ]; then
    grep -qF "feedback_${name_slug}.md" "$index_file" 2>/dev/null \
      || printf '%s\n' "$index_line" >> "$index_file" 2>/dev/null || true
  else
    printf '%s\n' "$index_line" > "$index_file" 2>/dev/null || true
  fi
}

# ── Main ──────────────────────────────────────────────────────────────────
events_file=$(mktemp 2>/dev/null) || exit 0
collect_correction_events > "$events_file" 2>/dev/null

if [ ! -s "$events_file" ]; then
  rm -f "$events_file"
  exit 0
fi

# Per consumer repo: split events by wt_prefix → repo and write feedback.
# Build a map of unique repos.
repos_seen=$(mktemp 2>/dev/null) || { rm -f "$events_file"; exit 0; }

while IFS='|' read -r kind wt note; do
  [ -n "$wt" ] || continue
  repo=$(wt_to_repo "$wt")
  [ -n "$repo" ] || continue
  if ! grep -qFx "$repo" "$repos_seen" 2>/dev/null; then
    printf '%s\n' "$repo" >> "$repos_seen" 2>/dev/null || true
  fi
done < "$events_file"

while IFS= read -r repo; do
  [ -n "$repo" ] || continue
  repo_encoded=$(encode_cwd "$repo")
  repo_events=$(mktemp 2>/dev/null) || continue

  while IFS='|' read -r kind wt note; do
    [ -n "$wt" ] || continue
    repo_match=$(wt_to_repo "$wt")
    [ "$repo_match" = "$repo" ] || continue
    printf '%s|%s|%s\n' "$kind" "$wt" "$note" >> "$repo_events" 2>/dev/null || true
  done < "$events_file"

  repo_name=$(basename "$repo")
  write_feedback "$HOME/.claude/projects/${repo_encoded}/memory" \
                 "${feature_slug}-${repo_name}" \
                 "$repo_name" \
                 "$repo_events"
  rm -f "$repo_events" 2>/dev/null || true
done < "$repos_seen"

# Root-dir summary (cross-repo orchestration view).
if [ -n "$root_dir" ]; then
  root_encoded=$(encode_cwd "$root_dir")
  write_feedback "$HOME/.claude/projects/${root_encoded}/memory" \
                 "${feature_slug}-orchestration" \
                 "orchestration" \
                 "$events_file"
fi

rm -f "$events_file" "$repos_seen" 2>/dev/null || true

exit 0
