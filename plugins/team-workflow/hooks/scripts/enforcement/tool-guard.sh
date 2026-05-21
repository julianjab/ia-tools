#!/usr/bin/env bash
# Generic tool guard — ia-tools plugin.
#
# Bucket:      enforcement
# Listens to:  PreToolUse  (matcher: Bash|Edit|Write|MultiEdit|WebFetch)
# Blocking:    yes (emits permissionDecision=deny in hookSpecificOutput)
# Input  (stdin JSON): { "tool_name": "<name>", "tool_input": { ... }, ... }
# Output: empty `{}` on allow, or PreToolUse-shaped deny JSON on block.
#
# Philosophy: block ONLY commands that cause irreversible damage or push
# state to a place that requires non-trivial undo (e.g. merging a PR).
# Anything else (creating PRs, publishing packages, pushing containers,
# overwriting local files, fetching http URLs) is the caller's
# responsibility — the hook does not second-guess intent.
#
# Reads a PreToolUse JSON payload from stdin. Dispatches on tool_name to
# extract the relevant field:
#
#   Bash                 → .tool_input.command
#   Edit/Write/MultiEdit → .tool_input.file_path
#   WebFetch             → .tool_input.url
#
# Patterns come from two sources, applied additively:
#
#   1. Built-in safety net (PATTERNS array below). A minimal, curated
#      list of clearly destructive operations. Format per entry:
#      "TOOL_NAME|ERE_PATTERN|Human-readable reason". TOOL_NAME is
#      matched case-insensitively. Use "*" to match every tool.
#
#   2. User + project settings — Claude Code's normal hierarchy:
#        - $HOME/.claude/settings.json           (user-global)
#        - $HOME/.claude/settings.local.json     (user-global, local)
#        - Walking up from CWD, every            (project / session)
#          <ancestor>/.claude/settings.json
#          <ancestor>/.claude/settings.local.json
#      Entries in `permissions.deny` shaped like `"ToolName(glob)"` are
#      extracted, the glob is converted to a loose ERE, and appended at
#      runtime. This is the recommended place for project- or
#      user-specific rules — keep the built-in list lean.
#
# On any match the hook returns permissionDecision "ask", forcing a
# confirmation prompt even when --dangerously-skip-permissions is active.

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

# ── Built-in safety net ───────────────────────────────────────────────────────
# Conservative list. Anything that publishes, deletes, or terminates is
# in here as the default safety net. The only thing intentionally NOT
# hardcoded is `gh pr create` / `gh release create` — creating a PR or
# draft release is reversible (close/delete) and shouldn't require a
# prompt. Merging a PR (`gh pr merge`) IS in the list because that lands
# code on main.
PATTERNS=(
  # ── Bash: Git — irreversible remote/local operations ──────────────────────
  "Bash|git[[:space:]].*push[[:space:]].*--force|git push --force reescribe historia compartida en el remoto."
  "Bash|git[[:space:]].*push[[:space:]].*[[:space:]]-f([[:space:]]|$)|git push -f reescribe historia compartida en el remoto."
  "Bash|git[[:space:]].*reset[[:space:]]+--hard|git reset --hard descarta commits locales de forma irreversible."
  "Bash|git[[:space:]].*clean[[:space:]]+-[a-zA-Z]*f|git clean -f borra archivos no trackeados permanentemente."
  "Bash|git[[:space:]].*branch[[:space:]]+-D[[:space:]]|git branch -D elimina forzosamente una rama local."

  # ── Bash: GitHub CLI — merges + destructive (creates are NOT here) ───────
  "Bash|gh[[:space:]]+pr[[:space:]]+merge|gh pr merge fusiona un PR. Verifica que CI esté verde y que fue revisado."
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

  # ── WebFetch: Insecure URLs ───────────────────────────────────────────────
  "WebFetch|^http://|WebFetch con http:// (no HTTPS) envía datos en texto plano."
)

# ── Load extra patterns from settings files ───────────────────────────────────
# Resolves settings via Claude Code's normal hierarchy:
#
#   1. $HOME/.claude/settings.json           (user-global)
#   2. $HOME/.claude/settings.local.json     (user-global, local)
#   3. Walking up from CWD:                  (project / session)
#      <dir>/.claude/settings.json
#      <dir>/.claude/settings.local.json
#
# All entries are additive; duplicates (same absolute path) are skipped.
# Extracts permissions.deny entries shaped like "ToolName(some glob)" and
# appends them as loose ERE patterns.
#
# Glob → ERE conversion:
#   *   → .*    (match anything)
#   ?   → .     (match one char)
#   The rest is treated as a literal substring (not anchored).

_emit_patterns_from_file() {
  local fpath="$1"
  jq -r '(.permissions.deny // [])[] | select(test("^[A-Za-z*]+\\("))' \
    "$fpath" 2>/dev/null | while IFS= read -r entry; do
      local tname glob pattern
      tname=$(printf '%s' "$entry" | sed 's/(.*//')
      glob=$(printf '%s' "$entry" | sed 's/^[^(]*(\(.*\))$/\1/')
      pattern=$(printf '%s' "$glob" | sed 's/\./\\./g; s/\*/.*/g; s/?/./g')
      printf '%s|%s|[settings] Patrón personalizado bloqueado: %s\n' "$tname" "$pattern" "$entry"
    done
}

load_settings_patterns() {
  local seen_files=()
  local fpath

  # 1-2. User-global settings.
  for fname in settings.json settings.local.json; do
    fpath="$HOME/.claude/$fname"
    [[ -f "$fpath" ]] || continue
    seen_files+=("$fpath")
    _emit_patterns_from_file "$fpath"
  done

  # 3. Project / session settings — walk up from CWD.
  local dir="$PWD"
  while [[ "$dir" != "/" ]]; do
    for fname in settings.json settings.local.json; do
      fpath="$dir/.claude/$fname"
      [[ -f "$fpath" ]] || continue

      local already=0
      for seen in "${seen_files[@]+"${seen_files[@]}"}"; do
        [[ "$seen" == "$fpath" ]] && already=1 && break
      done
      [[ "$already" -eq 1 ]] && continue
      seen_files+=("$fpath")

      _emit_patterns_from_file "$fpath"
    done
    dir="$(dirname "$dir")"
  done
}

while IFS= read -r extra; do
  [[ -n "$extra" ]] && PATTERNS+=("$extra")
done < <(load_settings_patterns)

# ── Strip quoted strings + heredoc bodies for Bash subjects ──────────────────
# The patterns are designed to match COMMANDS that would actually execute.
# When dangerous tokens appear only inside quoted strings or heredoc bodies
# (e.g. `echo "rm -rf /tmp"`, a for-loop with literal commands as data),
# they are not invocations and shouldn't trigger a prompt. We sanitize the
# subject by removing those regions before matching.
#
# Removes (in order):
#   1. Heredoc bodies:  <<EOF ... EOF   /  <<'EOF' ... EOF   /  <<-EOF ... EOF
#   2. Single-quoted strings:  '...'
#   3. Double-quoted strings:  "..."
# Then collapses runs of whitespace so patterns with [[:space:]]+ still match.
match_subject="$subject"
if [ "$tool_name" = "Bash" ]; then
  match_subject=$(printf '%s' "$subject" | awk '
    BEGIN { in_heredoc=0; tag="" }
    {
      line=$0
      if (in_heredoc) {
        if (line ~ "^[[:space:]]*" tag "[[:space:]]*$") { in_heredoc=0 }
        next
      }
      # Detect heredoc start: <<-?["'\'']?TAG["'\'']?
      if (match(line, /<<-?[[:space:]]*[\x27"]?[A-Za-z_][A-Za-z0-9_]*[\x27"]?/)) {
        h=substr(line, RSTART, RLENGTH)
        gsub(/^<<-?[[:space:]]*[\x27"]?/, "", h)
        gsub(/[\x27"]$/, "", h)
        tag=h
        in_heredoc=1
        line=substr(line, 1, RSTART-1)
      }
      # Strip single- and double-quoted regions
      gsub(/\x27[^\x27]*\x27/, " ", line)
      gsub(/"[^"]*"/, " ", line)
      print line
    }
  ')
fi

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

  if printf '%s' "$match_subject" | grep -qE "$pattern" 2>/dev/null; then
    escaped=$(printf '%s' "$reason" | sed 's/\\/\\\\/g; s/"/\\"/g')
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"%s"}}\n' \
      "$escaped"
    exit 0
  fi
done

# No match — allow
printf '{}'
exit 0
