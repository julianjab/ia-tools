#!/usr/bin/env bash
# Dangerous Bash command guard — ia-tools plugin.
#
# Intercepts PreToolUse Bash calls and forces a confirmation prompt when the
# command matches a known-dangerous pattern (irreversible remote operations,
# destructive deletes, infra teardown, package publishing, etc.).
#
# Returning permissionDecision "ask" forces Claude Code to prompt the user
# even when --dangerously-skip-permissions is active.

set -u

payload=$(cat)
command=$(printf '%s' "$payload" | jq -r '.tool_input.command // empty' 2>/dev/null)

if [ -z "$command" ]; then
  printf '{}'
  exit 0
fi

ask() {
  local reason="$1"
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"%s"}}' "$reason"
  exit 0
}

# ── Git / GitHub ──────────────────────────────────────────────────────────────
if echo "$command" | grep -qE 'git\s+push\s+.*(-f|--force)'; then
  ask "git push --force reescribe historia compartida en el remoto y puede destruir commits de otros."
fi

if echo "$command" | grep -qE 'git\s+reset\s+--hard'; then
  ask "git reset --hard descarta commits locales de forma irreversible."
fi

if echo "$command" | grep -qE 'git\s+clean\s+.*-[a-zA-Z]*f'; then
  ask "git clean -f borra archivos no trackeados de forma irreversible."
fi

if echo "$command" | grep -qE 'git\s+branch\s+.*-D'; then
  ask "git branch -D elimina forzosamente una rama local aunque no esté mergeada."
fi

if echo "$command" | grep -qE 'gh\s+pr\s+merge'; then
  ask "gh pr merge fusiona un PR en la rama base. Verifica que CI esté verde y que el PR fue revisado."
fi

if echo "$command" | grep -qE 'gh\s+release\s+(create|delete)'; then
  ask "gh release create/delete publica o elimina un release público en GitHub."
fi

# ── Eliminación de archivos ───────────────────────────────────────────────────
if echo "$command" | grep -qE '\brm\s+.*-[a-zA-Z]*r'; then
  ask "rm -r/-rf elimina directorios completos de forma irreversible."
fi

# ── Infraestructura ───────────────────────────────────────────────────────────
if echo "$command" | grep -qE 'kubectl\s+delete'; then
  ask "kubectl delete elimina recursos del cluster de Kubernetes."
fi

if echo "$command" | grep -qE 'terraform\s+destroy'; then
  ask "terraform destroy destruye infraestructura real gestionada por Terraform."
fi

if echo "$command" | grep -qE 'aws\s+s3\s+rm\s+.*--recursive'; then
  ask "aws s3 rm --recursive borra objetos S3 en masa de forma irreversible."
fi

if echo "$command" | grep -qE 'aws\s+secretsmanager\s+delete-secret'; then
  ask "aws secretsmanager delete-secret elimina un secret de forma permanente."
fi

# ── Publicación de paquetes ───────────────────────────────────────────────────
if echo "$command" | grep -qE '\b(npm|pnpm)\s+publish'; then
  ask "npm/pnpm publish publica un paquete en el registry público."
fi

if echo "$command" | grep -qE '\b(uv|twine)\s+upload'; then
  ask "uv/twine upload publica un paquete Python en PyPI."
fi

if echo "$command" | grep -qE 'docker\s+push'; then
  ask "docker push publica una imagen en el registry público."
fi

# ── Procesos ──────────────────────────────────────────────────────────────────
if echo "$command" | grep -qE '\bkill\s+.*-9\b|\bpkill\b|\bkillall\b'; then
  ask "kill -9/pkill/killall termina procesos forzosamente sin posibilidad de limpieza."
fi

# No match — allow
printf '{}'
exit 0
