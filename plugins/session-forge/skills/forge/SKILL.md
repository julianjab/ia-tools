---
name: forge
description: >
  List candidate artefacts (skills, permission allowlists, memory rules)
  detected from captured Claude Code session patterns. PR2 ships read-only
  `list`; PR3 will add `accept` to generate the artefact via scaffold:*.
argument-hint: "list [--days N] [--json]"
disable-model-invocation: false
---

# /forge — propose Claude Code artefacts from detected patterns

This skill reads the patterns detected by `D2_repeated_bash`,
`D3_repeated_prompts`, and `D4_corrections`, ranks them by confidence
(`frequency × recency_weight`), and prints the resulting candidates. It is
**read-only** in PR2: nothing is generated yet.

PR3 will add:
- `/forge accept <id>` — generate the artefact via `scaffold:skill-author` /
  `scaffold:script-author` / `scaffold:agent-author` and register it in
  `~/.claude/session-forge/forge_registry.json`.
- `/forge dismiss <id>` — record a "no" so the same candidate is not
  re-proposed.

## Arguments

| First token   | Meaning |
|---------------|---------|
| `list`        | Print ranked candidates (default last 30 days). |
| `list --days N` | Restrict the analysis window. |
| `list --json` | Emit JSON array instead of a table. |
| _(empty)_     | Treat as `list` with defaults. |
| anything else | Print "unknown subcommand <x>" and stop. |

## Preconditions

| Condition | Action |
|-----------|--------|
| `sqlite3` or `jq` not on PATH | Print a clear error and stop. |
| `~/.claude/session-forge/db.sqlite` missing | Print "no session data yet" and stop. |

## Implementation

Dispatches to `forge_candidates.sh` under
`${CLAUDE_PLUGIN_ROOT}/hooks/scripts/detectors/_lib/`.

```bash
SF_DB="${HOME}/.claude/session-forge/db.sqlite"
DET_DIR="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/plugins/cache/ia-tools/session-forge/$(ls -1 $HOME/.claude/plugins/cache/ia-tools/session-forge/ 2>/dev/null | tail -1)}/hooks/scripts/detectors"

for bin in sqlite3 jq; do
  command -v "$bin" >/dev/null 2>&1 || {
    printf '%s not installed — session-forge is disabled.\n' "$bin"
    exit 0
  }
done
[ -f "$SF_DB" ] || {
  printf 'No session data yet at %s.\n' "$SF_DB"
  exit 0
}

sub="${1:-list}"; shift 2>/dev/null || true

case "$sub" in
  list)
    # Default is table for human reading; user can pass --json.
    has_format=0
    for arg in "$@"; do
      case "$arg" in --json|--table) has_format=1 ;; esac
    done
    if [ "$has_format" -eq 0 ]; then
      bash "${DET_DIR}/_lib/forge_candidates.sh" --table "$@"
    else
      bash "${DET_DIR}/_lib/forge_candidates.sh" "$@"
    fi
    ;;
  '')
    bash "${DET_DIR}/_lib/forge_candidates.sh" --table
    ;;
  accept|dismiss)
    printf '/forge %s is not implemented in PR2. Coming in PR3.\n' "$sub"
    ;;
  *)
    printf 'unknown subcommand: %s\n' "$sub"
    printf 'Usage: /forge list [--days N] [--json]\n'
    ;;
esac
```

## Notes

- Candidates are identified by a deterministic 12-char id derived from
  `sha1(kind:pattern)`. The same pattern across runs gets the same id, so
  PR3's `accept`/`dismiss` records can survive re-detection.
- Confidence is `frequency × exp(-age_days/7)`. Tunable in
  `forge_candidates.sh` if signal turns out noisy on real data.
- Output respects `--json` for piping into other tools (jq, Datasette,
  external scripts).
