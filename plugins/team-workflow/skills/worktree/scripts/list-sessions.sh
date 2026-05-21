#!/usr/bin/env bash
# list-sessions.sh — list every lead session whose state lives in
# $HOME/.claude/team-workflow/state/.
#
# Usage:      list-sessions.sh [--format human|tsv|json]
# Exit codes: 0 = printed zero or more session rows
#             1 = state root missing entirely
#
# Reads the session-env.yaml sidecar that start-lead.sh writes per-session
# (feature / topic / state_dir / terminal / started_at / boot_host / phase
# from state.md). Sessions are sorted with active phases first, newest
# started_at first within each group.
#
# Consumed by:
#   - /worktree rehydrate (when $IA_TW_STATE_DIR is unset, present the
#     operator with the list and ask which feature to rehydrate)
#   - operator inspection / debugging
#
# Best-effort: a session dir without session-env.yaml is skipped; a
# session-env.yaml without state.md still appears (phase=unknown). Never
# fails for individual rows.

set -u

format="human"
case "${1:-}" in
  --format) format="${2:-human}" ;;
  --format=*) format="${1#--format=}" ;;
  "") ;;
  *) echo "Usage: list-sessions.sh [--format human|tsv|json]" >&2; exit 1 ;;
esac

root="${HOME}/.claude/team-workflow/state"
[ -d "$root" ] || exit 1

# Collect rows as TSV in a temp file:
#   phase  started_at  feature  topic  state_dir  terminal  boot_host
rows=$(mktemp 2>/dev/null) || exit 1

for d in "$root"/*/; do
  d="${d%/}"
  env_file="$d/session-env.yaml"
  state_file="$d/state.md"
  [ -f "$env_file" ] || continue

  feature=$(grep '^feature:' "$env_file" 2>/dev/null | head -1 | sed 's/^feature:[[:space:]]*//')
  topic=$(grep '^topic:' "$env_file" 2>/dev/null | head -1 | sed 's/^topic:[[:space:]]*//')
  terminal=$(grep '^terminal:' "$env_file" 2>/dev/null | head -1 | sed 's/^terminal:[[:space:]]*//')
  started_at=$(grep '^started_at:' "$env_file" 2>/dev/null | head -1 | sed 's/^started_at:[[:space:]]*//')
  boot_host=$(grep '^boot_host:' "$env_file" 2>/dev/null | head -1 | sed 's/^boot_host:[[:space:]]*//')
  phase="unknown"
  [ -f "$state_file" ] && phase=$(grep '^phase:' "$state_file" 2>/dev/null | head -1 | sed 's/^phase:[[:space:]]*//')

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "${phase:-unknown}" "${started_at:-?}" "${feature:-?}" "${topic:-?}" "$d" "${terminal:-?}" "${boot_host:-?}" \
    >> "$rows"
done

# Sort: active phases first (planning/implementing/prs-open/reviewing), then
# terminal/unknown last. Within each group, newest started_at first.
phase_rank() {
  case "$1" in
    planning|implementing|prs-open|reviewing) printf '1' ;;
    merged|closed|stopped)                    printf '3' ;;
    *)                                        printf '2' ;;  # unknown
  esac
}

sorted=$(mktemp 2>/dev/null) || { rm -f "$rows"; exit 1; }
while IFS=$'\t' read -r phase started_at feature topic state_dir terminal boot_host; do
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$(phase_rank "$phase")" "$phase" "$started_at" "$feature" "$topic" "$state_dir" "$terminal" "$boot_host"
done < "$rows" | sort -t$'\t' -k1,1 -k3,3r > "$sorted"

case "$format" in
  human)
    if [ ! -s "$sorted" ]; then
      printf 'No team-workflow sessions found under %s\n' "$root"
      rm -f "$rows" "$sorted"
      exit 0
    fi
    printf '%-3s  %-13s  %-26s  %-40s  %-7s\n' '#' 'phase' 'started_at' 'feature' 'host'
    printf '%-3s  %-13s  %-26s  %-40s  %-7s\n' '---' '-------------' '--------------------------' '----------------------------------------' '-------'
    i=1
    while IFS=$'\t' read -r _rank phase started feature topic state_dir terminal host; do
      printf '%-3d  %-13s  %-26s  %-40s  %-7s\n' "$i" "$phase" "$started" "$feature" "$terminal"
      printf '     topic:     %s\n' "$topic"
      printf '     state_dir: %s\n' "$state_dir"
      i=$((i + 1))
    done < "$sorted"
    ;;
  tsv)
    # Header line + rows. Caller pipes to awk / cut as needed.
    printf 'phase\tstarted_at\tfeature\ttopic\tstate_dir\tterminal\tboot_host\n'
    awk -F'\t' '{print $2"\t"$3"\t"$4"\t"$5"\t"$6"\t"$7"\t"$8}' "$sorted"
    ;;
  json)
    if command -v jq >/dev/null 2>&1; then
      awk -F'\t' '
        BEGIN { printf "[" }
        NR > 1 { printf "," }
        {
          printf "{\"phase\":\"%s\",\"started_at\":\"%s\",\"feature\":\"%s\",\"topic\":\"%s\",\"state_dir\":\"%s\",\"terminal\":\"%s\",\"boot_host\":\"%s\"}",
            $2, $3, $4, $5, $6, $7, $8
        }
        END { printf "]\n" }
      ' "$sorted" | jq .
    else
      # Manual JSON without jq.
      printf '['
      first=1
      while IFS=$'\t' read -r _rank phase started feature topic state_dir terminal host; do
        [ "$first" -eq 0 ] && printf ','
        first=0
        printf '{"phase":"%s","started_at":"%s","feature":"%s","topic":"%s","state_dir":"%s","terminal":"%s","boot_host":"%s"}' \
          "$phase" "$started" "$feature" "$topic" "$state_dir" "$terminal" "$host"
      done < "$sorted"
      printf ']\n'
    fi
    ;;
  *)
    echo "Unknown format '$format'. Use human|tsv|json." >&2
    rm -f "$rows" "$sorted"
    exit 1
    ;;
esac

rm -f "$rows" "$sorted"
exit 0
