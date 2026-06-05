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

# Confidence weighting and type classification done in jq. The id is added
# afterwards in shell (jq has no sha1 builtin; @base64 collisions when
# truncated, so we use a real digest via shasum).
#
# Bash classification:
#   - "permission" when the command is short (<=80 chars) and atomic (no
#     &&, |, ;) — these belong in settings.json allowlist.
#   - "skill" when the command is long or composite — these are better
#     wrapped in a reusable skill than blanket-allowed.
combine='
def conf(freq; last_iso):
  (last_iso | gsub(" "; "T") | strptime("%Y-%m-%dT%H:%M:%S") | mktime) as $ts
  | ((now - $ts) / 86400) as $age
  | (freq * pow(2.71828; (- $age / 7)))
  | (. * 100 | round) / 100
;
def classify_bash(cmd):
  if (cmd | length) <= 80
     and (cmd | test("&&|\\|\\||;|\\|") | not)
  then "permission" else "skill" end
;
($d2 | map({
    kind: "bash_repeat",
    type: classify_bash(.cmd // ""),
    pattern: .cmd, frequency: .n, last_seen: .last_seen
  }))
+ ($d3 | map({
    kind: "prompt_repeat", type: "skill",
    pattern: .prompt, frequency: .n, last_seen: .last_seen
  }))
+ ($d4 | map({
    kind: "correction", type: "memory",
    pattern: .prompt, frequency: 1, last_seen: .at
  }))
| map(. + { confidence: conf(.frequency; .last_seen) })
| sort_by(-.confidence)
'

without_id=$(jq -n \
  --argjson d2 "$d2" \
  --argjson d3 "$d3" \
  --argjson d4 "$d4" \
  "$combine" 2>>"$SF_ERRORS_LOG")

[ -n "$without_id" ] || without_id='[]'

# Add deterministic sha1(kind:pattern)[0:12] as id. The same pattern across
# runs yields the same id, so PR3 forge_registry can match accept/dismiss
# records back to detected candidates.
candidates=$(printf '%s' "$without_id" | jq -c '.[]' 2>/dev/null \
  | while IFS= read -r row; do
      kind=$(printf '%s' "$row" | jq -r '.kind')
      pat=$(printf '%s'  "$row" | jq -r '.pattern // ""')
      id=$(printf '%s:%s' "$kind" "$pat" | shasum -a 1 2>/dev/null | cut -c1-12)
      printf '%s' "$row" | jq -c --arg id "$id" '. + { id: $id }'
    done | jq -s '.' 2>/dev/null)

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
