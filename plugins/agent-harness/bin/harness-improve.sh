#!/usr/bin/env bash
# bin/harness-improve.sh — aggregate harness-events.log across sessions
# and surface patterns worth turning into guide/sensor improvements.
#
# Usage:
#   harness-improve.sh [--days <n>] [--out <report-path>] [--json]
#
#   --days <n>     only consider events whose ts is within the last <n>
#                  days (default: 30; 0 = all time)
#   --out <path>   write a markdown report to <path>. Defaults to
#                  $AGENT_HARNESS_HOME/reports/improve-<YYYY-MM-DD>.md
#   --json         additionally emit the aggregate as JSON next to the
#                  markdown report (same stem, `.json` extension)
#
# Reads:  every harness-events.log under $AGENT_HARNESS_HOME/sessions/
# Writes: a markdown report and optionally a JSON aggregate
# Stdout: the report path (so callers can chain)
#
# The aggregate counts events grouped by (stage, kind). For each stage
# it computes:
#   - total events
#   - error rate (kind=error / total)
#   - skip rate  (kind=skipped / total)
#   - top 3 error summaries (verbatim, as they appear in events)
#
# Patterns with non-zero error or skip rate get a "suggested action"
# line in the markdown report: improve the guide (prevent the error)
# or add a sensor (catch it before the stage completes).

set -euo pipefail

STAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$STAGE_DIR/.." && pwd)"

# shellcheck source=../lib/config.sh
source "$PLUGIN_ROOT/lib/config.sh"
config_init

days=30
out=""
emit_json=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --days) days="$2"; shift 2 ;;
    --out)  out="$2"; shift 2 ;;
    --json) emit_json=1; shift ;;
    -*) echo "✗ unknown flag $1" >&2; exit 1 ;;
    *)  echo "✗ unexpected arg $1" >&2; exit 1 ;;
  esac
done

home="$(config_get home)"
sessions_root="$(config_get session_root)"
reports_dir="$home/reports"
mkdir -p "$reports_dir"

[[ -n "$out" ]] || out="$reports_dir/improve-$(date -u +%Y-%m-%d).md"

# ── collect events ────────────────────────────────────────────────
tmp_events="$(mktemp)"
trap 'rm -f "$tmp_events"' EXIT

if [[ "$days" -gt 0 ]]; then
  cutoff="$(date -u -v-"${days}"d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || \
            date -u -d "${days} days ago" +%Y-%m-%dT%H:%M:%SZ)"
else
  cutoff="0000-00-00T00:00:00Z"
fi

n_sessions=0
n_events_total=0
shopt -s nullglob
for f in "$sessions_root"/*/harness-events.log; do
  ((++n_sessions))
  jq -c --arg cutoff "$cutoff" 'select(.ts >= $cutoff)' "$f" >>"$tmp_events" 2>/dev/null || true
done
shopt -u nullglob
n_events_total="$(wc -l <"$tmp_events" | tr -d ' ')"

# ── aggregate ─────────────────────────────────────────────────────
aggregate="$(jq -s '
  group_by(.stage)
  | map({
      stage: .[0].stage,
      total: length,
      by_kind: (group_by(.kind) | map({key: .[0].kind, value: length}) | from_entries),
      errors:  ([.[] | select(.kind == "error")   | .summary] | unique | .[0:3]),
      skips:   ([.[] | select(.kind == "skipped") | .summary] | unique | .[0:3])
    })
  | sort_by(-.total)
' "$tmp_events")"

# ── markdown report ───────────────────────────────────────────────
{
  echo "# Harness improvement report"
  echo
  if [[ "$days" -gt 0 ]]; then
    echo "Window: last ${days} days (since ${cutoff})"
  else
    echo "Window: all time"
  fi
  echo "Sessions scanned: ${n_sessions}"
  echo "Events in window: ${n_events_total}"
  echo
  if [[ "$n_events_total" -eq 0 ]]; then
    echo "No events to report."
    exit 0
  fi
  echo "## Per-stage breakdown"
  echo
  echo "| Stage | Total | Errors | Skipped | Decisions | Outcomes |"
  echo "|-------|-------|--------|---------|-----------|----------|"
  echo "$aggregate" | jq -r '.[] |
    "| \(.stage) | \(.total) | \(.by_kind.error // 0) | \(.by_kind.skipped // 0) | \(.by_kind.decision // 0) | \(.by_kind.outcome // 0) |"'
  echo
  echo "## Suggested improvements"
  echo
  any=0
  while IFS= read -r line; do
    stage="$(echo "$line" | jq -r .stage)"
    err="$(echo "$line"   | jq -r '.by_kind.error // 0')"
    sk="$(echo "$line"    | jq -r '.by_kind.skipped // 0')"
    if [[ "$err" -gt 0 ]]; then
      any=1
      echo "### $stage — errors observed"
      echo
      echo "- Error rate: ${err} / $(echo $line | jq -r .total)"
      echo "- Top error summaries (verbatim):"
      echo "$line" | jq -r '.errors[] | "  - " + .'
      echo "- Action: add a **sensor** that catches this condition before the stage exits,"
      echo "  or strengthen the **guide** (prompt / schema / preconditions) so it never"
      echo "  reaches this state."
      echo
    fi
    if [[ "$sk" -gt 0 ]]; then
      any=1
      echo "### $stage — skips observed"
      echo
      echo "- Skip rate: ${sk} / $(echo $line | jq -r .total)"
      echo "- Top skip summaries (verbatim):"
      echo "$line" | jq -r '.skips[] | "  - " + .'
      echo "- Action: if the skip is intentional (e.g. assigned_to: null is a"
      echo "  signal the user must act on), document it. Otherwise upgrade the"
      echo "  upstream stage so the skip never has to happen."
      echo
    fi
  done < <(echo "$aggregate" | jq -c '.[]')
  if [[ "$any" -eq 0 ]]; then
    echo "No errors or skips in this window — the harness is running clean."
  fi
} >"$out"

if [[ "$emit_json" -eq 1 ]]; then
  echo "$aggregate" >"${out%.md}.json"
fi

echo "$out"
