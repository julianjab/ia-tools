#!/usr/bin/env bash
# Dangerous Bash command guard — ia-tools plugin.
#
# Reads a PreToolUse JSON payload from stdin, extracts .tool_input.command,
# and matches it against two sources of patterns:
#
#   1. Built-in table (PATTERNS array below) — sensible defaults shipped with
#      the plugin. Each entry: "ERE_PATTERN|Human-readable reason".
#
#   2. settings.json / settings.local.json — any entry in permissions.deny
#      that follows the Claude Code format "Bash(glob)" is extracted, the glob
#      is converted to a loose ERE pattern, and added at runtime. This lets
#      teams maintain a single list in their settings files without touching
#      this script.
#
# On any match the hook returns permissionDecision "ask", forcing a
# confirmation prompt even when --dangerously-skip-permissions is active.
#
# Adding a built-in rule: append one line to PATTERNS below.
# Adding a project-specific rule: add "Bash(pattern*)" to permissions.deny
# in .claude/settings.json or .claude/settings.local.json.

set -u

payload=$(cat)
command=$(printf '%s' "$payload" | jq -r '.tool_input.command // empty' 2>/dev/null)

if [ -z "$command" ]; then
  printf '{}'
  exit 0
fi

# ── Built-in pattern table ────────────────────────────────────────────────────
# Format: "ERE_PATTERN|Reason shown to the user"
PATTERNS=(
  # Git — irreversible remote/local operations
  "git[[:space:]].*push[[:space:]].*--force|git push --force reescribe historia compartida en el remoto."
  "git[[:space:]].*push[[:space:]].*[[:space:]]-f([[:space:]]|$)|git push -f reescribe historia compartida en el remoto."
  "git[[:space:]].*reset[[:space:]]+--hard|git reset --hard descarta commits locales de forma irreversible."
  "git[[:space:]].*clean[[:space:]]+-[a-zA-Z]*f|git clean -f borra archivos no trackeados permanentemente."
  "git[[:space:]].*branch[[:space:]]+-D[[:space:]]|git branch -D elimina forzosamente una rama local."

  # GitHub CLI
  "gh[[:space:]]+pr[[:space:]]+merge|gh pr merge fusiona un PR. Verifica que CI esté verde y que fue revisado."
  "gh[[:space:]]+release[[:space:]]+create|gh release create publica un release público en GitHub."
  "gh[[:space:]]+release[[:space:]]+delete|gh release delete elimina un release público en GitHub."

  # Destructive file deletion
  "rm[[:space:]]+-[a-zA-Z]*r[a-zA-Z]*[[:space:]]|rm -r/-rf elimina directorios completos de forma irreversible."

  # Infrastructure
  "kubectl[[:space:]]+delete|kubectl delete elimina recursos del cluster de Kubernetes."
  "terraform[[:space:]]+destroy|terraform destroy destruye infraestructura real gestionada por Terraform."
  "aws[[:space:]]+s3[[:space:]]+rm[[:space:]].*--recursive|aws s3 rm --recursive borra objetos S3 en masa permanentemente."
  "aws[[:space:]]+secretsmanager[[:space:]]+delete-secret|aws secretsmanager delete-secret elimina un secret permanentemente."

  # Package publishing
  "npm[[:space:]]+publish|npm publish publica un paquete en el registry público."
  "pnpm[[:space:]]+publish|pnpm publish publica un paquete en el registry público."
  "uv[[:space:]]+upload|uv upload publica un paquete Python en PyPI."
  "twine[[:space:]]+upload|twine upload publica un paquete Python en PyPI."
  "docker[[:space:]]+push|docker push publica una imagen en el registry de contenedores."

  # Process termination
  "kill[[:space:]]+-9[[:space:]]|kill -9 termina procesos sin posibilidad de limpieza."
  "pkill[[:space:]]|pkill termina procesos por nombre sin posibilidad de limpieza."
  "killall[[:space:]]|killall termina todos los procesos con ese nombre."
)

# ── Load extra patterns from settings files ───────────────────────────────────
# Walks up from CWD looking for .claude/settings.json and
# .claude/settings.local.json. Extracts permissions.deny entries shaped like
# "Bash(some glob)" and appends them as loose ERE patterns.
#
# Glob → ERE conversion:
#   *   → .*    (match anything)
#   ?   → .     (match one char)
#   The rest is treated as a literal substring (not anchored).

load_settings_patterns() {
  local dir="$PWD"
  local seen_files=()

  while [[ "$dir" != "/" ]]; do
    for fname in settings.json settings.local.json; do
      local fpath="$dir/.claude/$fname"
      [[ -f "$fpath" ]] || continue

      # Avoid processing the same file twice (symlinks, etc.)
      local already=0
      for seen in "${seen_files[@]+"${seen_files[@]}"}"; do
        [[ "$seen" == "$fpath" ]] && already=1 && break
      done
      [[ "$already" -eq 1 ]] && continue
      seen_files+=("$fpath")

      # Extract "Bash(...)" entries from permissions.deny
      jq -r '(.permissions.deny // [])[] | select(startswith("Bash(")) | .[5:-1]' \
        "$fpath" 2>/dev/null | while IFS= read -r glob; do
          # Convert glob to a loose ERE: * → .*, ? → .
          local pattern
          pattern=$(printf '%s' "$glob" | sed 's/\./\\./g; s/\*/.*/g; s/?/./g')
          printf '%s|[settings] Patrón personalizado bloqueado: %s\n' "$pattern" "$glob"
        done
    done
    dir="$(dirname "$dir")"
  done
}

# Append settings-derived patterns to the built-in list
while IFS= read -r extra; do
  [[ -n "$extra" ]] && PATTERNS+=("$extra")
done < <(load_settings_patterns)

# ── Match loop ────────────────────────────────────────────────────────────────
for entry in "${PATTERNS[@]}"; do
  pattern="${entry%%|*}"
  reason="${entry#*|}"

  if echo "$command" | grep -qE "$pattern" 2>/dev/null; then
    escaped=$(printf '%s' "$reason" | sed 's/\\/\\\\/g; s/"/\\"/g')
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"%s"}}\n' \
      "$escaped"
    exit 0
  fi
done

# No match — allow
printf '{}'
exit 0
