#!/usr/bin/env bash
# forge_candidates — unify D2/D3/D4 outputs into a single ranked list.
#
# Bucket:      lib (wrapper — invoked by /forge list)
# Listens to:  n/a — invoked manually or by skill bash blocks
# Blocking:    no (always exit 0)
# Input:       CLI flags
# Output:      JSON array (default) or pretty table on stdout
#
# Usage:
#   forge_candidates.sh [--days N] [--table]
#
# Defaults: --days 30, JSON output.
#
# Confidence score v1:
#   confidence = frequency * exp(-age_days / 7)
#
# Each candidate gets:
#   { "id", "type", "kind", "pattern", "frequency", "last_seen", "confidence" }
#
# - id        : deterministic sha1(kind:pattern)[0:12]
# - type      : artefact suggested (skill | permission | memory)
# - kind      : detector tag (bash_repeat | prompt_repeat | correction)
# - pattern   : the literal value detected (command / prompt / correction text)

set -u
set +e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/../../_lib/common.sh"

days=30
format="json"

while [ $# -gt 0 ]; do
  case "$1" in
    --days)  days="$2"; shift 2 ;;
    --json)  format="json"; shift ;;
    --table) format="table"; shift ;;
    *) sf_log_err "forge_candidates: unknown arg $1"; shift ;;
  esac
done

case "$days" in ''|*[!0-9]*) days=30 ;; esac

DET_DIR="${SCRIPT_DIR}/.."

# Each detector emits a JSON array; jq normalises into a uniform shape with
# kind + type. Empty results become []. Concatenated, sorted by confidence.
d2=$(bash "${DET_DIR}/D2_repeated_bash.sh"     --days "$days" --json 2>/dev/null)
d3=$(bash "${DET_DIR}/D3_repeated_prompts.sh"  --days "$days" --json 2>/dev/null)
d4=$(bash "${DET_DIR}/D4_corrections.sh"       --days "$days" --json 2>/dev/null)

[ -n "$d2" ] || d2='[]'
[ -n "$d3" ] || d3='[]'
[ -n "$d4" ] || d4='[]'

# Confidence weighting and id derivation done in jq for portability.
# `now` is in seconds since epoch; `last_seen` is a localtime string from
# sqlite, which jq parses with fromdateiso8601 (we coerce by replacing the
# space with 'T').
combine='
def conf(freq; last_iso):
  (last_iso | gsub(" "; "T") | strptime("%Y-%m-%dT%H:%M:%S") | mktime) as $ts
  | ((now - $ts) / 86400) as $age
  # jq pow is binary: pow($base; $exp). Use 2.71828 ** (-age/7) as the
  # recency weight, multiplied by frequency.
  | (freq * pow(2.71828; (- $age / 7)))
  | (. * 100 | round) / 100
;
def fid(kind; pat):
  (kind + ":" + (pat // "" | tostring))
  | @base64 | .[0:12]
;
($d2 | map({ kind: "bash_repeat",   type: "permission", pattern: .cmd,    frequency: .n, last_seen: .last_seen }))
+ ($d3 | map({ kind: "prompt_repeat", type: "skill",      pattern: .prompt, frequency: .n, last_seen: .last_seen }))
+ ($d4 | map({ kind: "correction",  type: "memory",     pattern: .prompt, frequency: 1,  last_seen: .at }))
| map(. + {
    id: fid(.kind; .pattern),
    confidence: conf(.frequency; .last_seen)
  })
| sort_by(-.confidence)
'

candidates=$(jq -n \
  --argjson d2 "$d2" \
  --argjson d3 "$d3" \
  --argjson d4 "$d4" \
  "$combine" 2>>"$SF_ERRORS_LOG")

[ -n "$candidates" ] || candidates='[]'

if [ "$format" = "json" ]; then
  printf '%s\n' "$candidates"
else
  printf '%s' "$candidates" | jq -r '
    if length == 0 then "no candidates"
    else
      ["id","kind","type","freq","conf","last_seen","pattern"],
      (.[] | [.id, .kind, .type, (.frequency|tostring), (.confidence|tostring), .last_seen, (.pattern // "" | .[0:80])])
      | @tsv
    end' | column -t -s $'\t'
fi

exit 0
