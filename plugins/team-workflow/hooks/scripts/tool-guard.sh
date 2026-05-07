#!/usr/bin/env bash
# Generic tool guard — ia-tools plugin.
#
# Reads a PreToolUse JSON payload from stdin. Dispatches on tool_name to
# extract the relevant field:
#
#   Bash              → .tool_input.command
#   Edit/Write/MultiEdit → .tool_input.file_path
#   WebFetch          → .tool_input.url
#
# Patterns come from two sources:
#
#   1. Built-in table (PATTERNS array below). Format per entry:
#      "TOOL_NAME|ERE_PATTERN|Human-readable reason"
#      TOOL_NAME is matched case-insensitively against the incoming tool_name.
#      Use "*" as TOOL_NAME to match every tool.
#
#   2. settings.json / settings.local.json — any entry in permissions.deny
#      shaped like "ToolName(glob)" is extracted, the glob is converted to a
#      loose ERE, and appended at runtime. Supported tool names follow the
#      same rules as built-in entries (any tool_name or *).
#
# On any match the hook returns permissionDecision "ask", forcing a
# confirmation prompt even when --dangerously-skip-permissions is active.
#
# Adding a built-in rule: append one line to PATTERNS below.
# Adding a project-specific rule: add "ToolName(glob)" to permissions.deny
# in .claude/settings.json or .claude/settings.local.json.

set -u

payload=$(cat)
tool_name=$(printf '%s' "$payload" | jq -r '.tool_name // empty' 2>/dev/null)

if [ -z "$tool_name" ]; then
  printf '{}'
  exit 0
fi

# ── Resolve the field to inspect ─────────────────────────────────────────────
case "$tool_name" in
  Bash)
    subject=$(printf '%s' "$payload" | jq -r '.tool_input.command // empty' 2>/dev/null) ;;
  Edit|Write|MultiEdit)
    subject=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty' 2>/dev/null) ;;
  WebFetch)
    subject=$(printf '%s' "$payload" | jq -r '.tool_input.url // empty' 2>/dev/null) ;;
  *)
    # Unknown tool — pass through
    printf '{}'
    exit 0 ;;
esac

if [ -z "$subject" ]; then
  printf '{}'
  exit 0
fi

# ── Built-in pattern table ────────────────────────────────────────────────────
PATTERNS=(
  # ── Bash: Git — irreversible remote/local operations ──────────────────────
  "Bash|git[[:space:]].*push[[:space:]].*--force|git push --force reescribe historia compartida en el remoto."
  "Bash|git[[:space:]].*push[[:space:]].*[[:space:]]-f([[:space:]]|$)|git push -f reescribe historia compartida en el remoto."
  "Bash|git[[:space:]].*reset[[:space:]]+--hard|git reset --hard descarta commits locales de forma irreversible."
  "Bash|git[[:space:]].*clean[[:space:]]+-[a-zA-Z]*f|git clean -f borra archivos no trackeados permanentemente."
  "Bash|git[[:space:]].*branch[[:space:]]+-D[[:space:]]|git branch -D elimina forzosamente una rama local."

  # ── Bash: GitHub CLI ───────────────────────────────────────────────────────
  "Bash|gh[[:space:]]+pr[[:space:]]+merge|gh pr merge fusiona un PR. Verifica que CI esté verde y que fue revisado."
  "Bash|gh[[:space:]]+release[[:space:]]+create|gh release create publica un release público en GitHub."
  "Bash|gh[[:space:]]+release[[:space:]]+delete|gh release delete elimina un release público en GitHub."

  # ── Bash: Destructive file deletion ───────────────────────────────────────
  "Bash|rm[[:space:]]+-[a-zA-Z]*r[a-zA-Z]*[[:space:]]|rm -r/-rf elimina directorios completos de forma irreversible."

  # ── Bash: Infrastructure ──────────────────────────────────────────────────
  "Bash|kubectl[[:space:]]+delete|kubectl delete elimina recursos del cluster de Kubernetes."
  "Bash|terraform[[:space:]]+destroy|terraform destroy destruye infraestructura real gestionada por Terraform."
  "Bash|aws[[:space:]]+s3[[:space:]]+rm[[:space:]].*--recursive|aws s3 rm --recursive borra objetos S3 en masa permanentemente."
  "Bash|aws[[:space:]]+secretsmanager[[:space:]]+delete-secret|aws secretsmanager delete-secret elimina un secret permanentemente."

  # ── Bash: Package publishing ──────────────────────────────────────────────
  "Bash|npm[[:space:]]+publish|npm publish publica un paquete en el registry público."
  "Bash|pnpm[[:space:]]+publish|pnpm publish publica un paquete en el registry público."
  "Bash|uv[[:space:]]+upload|uv upload publica un paquete Python en PyPI."
  "Bash|twine[[:space:]]+upload|twine upload publica un paquete Python en PyPI."
  "Bash|docker[[:space:]]+push|docker push publica una imagen en el registry de contenedores."

  # ── Bash: Process termination ─────────────────────────────────────────────
  "Bash|kill[[:space:]]+-9[[:space:]]|kill -9 termina procesos sin posibilidad de limpieza."
  "Bash|pkill[[:space:]]|pkill termina procesos por nombre sin posibilidad de limpieza."
  "Bash|killall[[:space:]]|killall termina todos los procesos con ese nombre."

  # ── Edit/Write/MultiEdit: System file protection ──────────────────────────
  "Edit|^/etc/|Editar /etc/ modifica configuración del sistema operativo."
  "Write|^/etc/|Escribir en /etc/ modifica configuración del sistema operativo."
  "MultiEdit|^/etc/|Editar /etc/ modifica configuración del sistema operativo."
  "Edit|^/usr/|Editar /usr/ modifica archivos del sistema."
  "Write|^/usr/|Escribir en /usr/ modifica archivos del sistema."
  "MultiEdit|^/usr/|Editar /usr/ modifica archivos del sistema."

  # ── WebFetch: Internal/sensitive URLs ─────────────────────────────────────
  "WebFetch|^http://|WebFetch con http:// (no HTTPS) envía datos en texto plano."
)

# ── Load extra patterns from settings files ───────────────────────────────────
# Walks up from CWD looking for .claude/settings.json and
# .claude/settings.local.json. Extracts permissions.deny entries shaped like
# "ToolName(some glob)" and appends them as loose ERE patterns.
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

      local already=0
      for seen in "${seen_files[@]+"${seen_files[@]}"}"; do
        [[ "$seen" == "$fpath" ]] && already=1 && break
      done
      [[ "$already" -eq 1 ]] && continue
      seen_files+=("$fpath")

      # Extract "ToolName(...)" entries from permissions.deny
      # Entry format: "ToolName(glob)" → strip prefix+suffix to get "ToolName" and "glob"
      jq -r '(.permissions.deny // [])[] | select(test("^[A-Za-z*]+\\("))' \
        "$fpath" 2>/dev/null | while IFS= read -r entry; do
          local tname glob pattern
          tname=$(printf '%s' "$entry" | sed 's/(.*//')
          glob=$(printf '%s' "$entry" | sed 's/^[^(]*(\(.*\))$/\1/')
          pattern=$(printf '%s' "$glob" | sed 's/\./\\./g; s/\*/.*/g; s/?/./g')
          printf '%s|%s|[settings] Patrón personalizado bloqueado: %s\n' "$tname" "$pattern" "$entry"
        done
    done
    dir="$(dirname "$dir")"
  done
}

while IFS= read -r extra; do
  [[ -n "$extra" ]] && PATTERNS+=("$extra")
done < <(load_settings_patterns)

# ── Match loop ────────────────────────────────────────────────────────────────
tool_name_lower=$(printf '%s' "$tool_name" | tr '[:upper:]' '[:lower:]')

for entry in "${PATTERNS[@]}"; do
  entry_tool="${entry%%|*}"
  rest="${entry#*|}"
  pattern="${rest%%|*}"
  reason="${rest#*|}"

  entry_tool_lower=$(printf '%s' "$entry_tool" | tr '[:upper:]' '[:lower:]')

  # Match tool name (case-insensitive, "*" matches all)
  if [[ "$entry_tool_lower" != "*" && "$entry_tool_lower" != "$tool_name_lower" ]]; then
    continue
  fi

  if echo "$subject" | grep -qE "$pattern" 2>/dev/null; then
    escaped=$(printf '%s' "$reason" | sed 's/\\/\\\\/g; s/"/\\"/g')
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"%s"}}\n' \
      "$escaped"
    exit 0
  fi
done

# No match — allow
printf '{}'
exit 0
