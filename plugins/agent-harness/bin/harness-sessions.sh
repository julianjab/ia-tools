#!/usr/bin/env bash
# bin/harness-sessions.sh — list / status / resume backend for /harness skill.
#
# Usage:
#   harness-sessions.sh list   [--all]
#   harness-sessions.sh status [<id-prefix>]
#   harness-sessions.sh resume <id-prefix>          # resolves and prints session dir
#
# `list`   prints one line per session (id, phase, updated_at, task summary).
#          Defaults to the 10 most recent; --all shows everything.
# `status` prints a single session's summary block + the last 10 events.
#          With no arg, picks the most recently touched session.
# `resume` resolves <id-prefix> to exactly one session dir and prints it.
#          Multiple matches → list them + exit 2. No match → exit 1.
#
# Output goes to stdout; errors to stderr. Exit codes:
#   0  success
#   1  no matching session
#   2  ambiguous (multiple matches for `resume`)
#   3  missing precondition (e.g. session dir not initialized)

set -euo pipefail

STAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$STAGE_DIR/.." && pwd)"

# shellcheck source=../lib/config.sh
source "$PLUGIN_ROOT/lib/config.sh"
# shellcheck source=../lib/session.sh
source "$PLUGIN_ROOT/lib/session.sh"
config_init

sub="${1:-}"
[[ -n "$sub" ]] || { echo "usage: harness-sessions.sh list|status|resume [args]" >&2; exit 3; }
shift

# helpers ─────────────────────────────────────────────────────────
fmt_task_summary() {
  local state="$1"
  yq -o=json '.tasks // []' "$state" | jq -r '
    if length == 0 then "no tasks"
    else
      [.[] | .status // "pending"] |
      reduce .[] as $s ({}; .[$s] = (.[$s] // 0) + 1) |
      to_entries | map("\(.value) \(.key)") | join(", ")
    end'
}

print_session_line() {
  local dir="$1"
  local id state phase updated tasks
  id="$(basename "$dir")"
  state="$dir/state.yaml"
  if [[ ! -f "$state" ]]; then
    printf '%-44s  (no state.yaml)\n' "$id"
    return
  fi
  phase="$(yq -r '.phase // "unknown"' "$state")"
  updated="$(yq -r '.updated_at // ""' "$state")"
  tasks="$(fmt_task_summary "$state")"
  printf '%-44s  phase=%-12s  updated=%s\n' "$id" "$phase" "$updated"
  printf '  tasks: %s\n' "$tasks"
}

# subcommands ─────────────────────────────────────────────────────
case "$sub" in
  list)
    all=0
    [[ "${1:-}" == "--all" ]] && all=1
    root="$(config_get session_root)"
    [[ -d "$root" ]] || { echo "no sessions yet under $root"; exit 0; }
    dirs=()
    while IFS= read -r line; do dirs+=("$line"); done < <(ls -dt "$root"/*/ 2>/dev/null | sed 's:/$::')
    [[ "${#dirs[@]}" -gt 0 ]] || { echo "no sessions yet under $root"; exit 0; }
    if [[ "$all" -ne 1 ]]; then
      top=()
      for d in "${dirs[@]:0:10}"; do top+=("$d"); done
      dirs=("${top[@]}")
    fi
    for d in "${dirs[@]}"; do print_session_line "$d"; done
    ;;

  status)
    prefix="${1:-}"
    if [[ -z "$prefix" ]]; then
      dir="$(latest_session_dir)"
      [[ -n "$dir" ]] || { echo "no sessions yet" >&2; exit 1; }
    else
      hits=()
      while IFS= read -r line; do hits+=("$line"); done < <(find_session_dirs "$prefix")
      case "${#hits[@]}" in
        0) echo "no session matches '$prefix'" >&2; exit 1 ;;
        1) dir="${hits[0]}" ;;
        *) echo "multiple sessions match '$prefix':" >&2
           printf '  %s\n' "${hits[@]##*/}" >&2
           exit 2 ;;
      esac
    fi
    state="$dir/state.yaml"
    log="$dir/harness-events.log"
    id="$(basename "$dir")"
    phase="$(yq -r '.phase // "unknown"' "$state" 2>/dev/null || echo unknown)"
    repos="$(yq -o=json '.repos.local // []' "$state" 2>/dev/null | jq -r 'map(.name) | join(", ")' 2>/dev/null || echo "")"
    total="$(yq -o=json '.tasks // []' "$state" 2>/dev/null | jq 'length')"
    by_status="$(fmt_task_summary "$state")"

    echo "Session:  $id"
    echo "Phase:    $phase"
    [[ -n "$repos" ]] && echo "Repos:    $repos"
    echo "Tasks:    $total ($by_status)"
    echo
    if [[ -f "$log" ]]; then
      echo "Last events:"
      tail -n 10 "$log" | jq -r '"  " + .ts + "  [" + .stage + "/" + .kind + "] " + .summary'
    else
      echo "Last events: (none)"
    fi
    echo
    echo "state:  $state"
    echo "events: $log"
    ;;

  resume)
    prefix="${1:-}"
    [[ -n "$prefix" ]] || { echo "usage: harness-sessions.sh resume <id-prefix>" >&2; exit 3; }
    hits=()
    while IFS= read -r line; do hits+=("$line"); done < <(find_session_dirs "$prefix")
    case "${#hits[@]}" in
      0) echo "no session matches '$prefix'" >&2; exit 1 ;;
      1) echo "${hits[0]}" ;;
      *) echo "multiple sessions match '$prefix':" >&2
         printf '  %s\n' "${hits[@]##*/}" >&2
         exit 2 ;;
    esac
    ;;

  *)
    echo "unknown subcommand: $sub" >&2
    echo "valid: list | status | resume" >&2
    exit 3
    ;;
esac
