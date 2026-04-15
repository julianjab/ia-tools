#!/usr/bin/env bash
# Spec-lint for `/worktree cleanup --dry-run`.
#
# The worktree skill is consumed by Claude as natural-language instructions,
# so this test asserts SKILL.md documents the dry-run contract in a way that
# guarantees destructive operations are gated. Regression guardrail: any edit
# that drops one of these assertions must update the test intentionally.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
SKILL="${REPO_ROOT}/skills/worktree/SKILL.md"

if [[ ! -f "${SKILL}" ]]; then
  echo "FAIL: ${SKILL} not found" >&2
  exit 1
fi

fail=0
assert_contains() {
  local pattern="$1"
  local msg="$2"
  if ! grep -qE -e "${pattern}" "${SKILL}"; then
    echo "FAIL: ${msg}" >&2
    echo "  missing pattern: ${pattern}" >&2
    fail=1
  fi
}

# 1. Flag is declared in the cleanup arguments signature.
assert_contains \
  '/worktree cleanup .*\[--dry-run\]' \
  "cleanup arguments signature must list [--dry-run]"

# 2. Flag appears in the arguments table with a non-destructive description.
assert_contains \
  '`--dry-run`.*Preview' \
  "arguments table must describe --dry-run as a preview-only flag"

# 3. Gate exists before the destructive sub-steps.
assert_contains \
  'If `--dry-run` is set, STOP HERE' \
  "SKILL.md must explicitly STOP before destructive sub-steps when --dry-run is set"

# 4. Each destructive op is explicitly marked as skipped under dry-run.
for op in 'git worktree remove' 'git push origin --delete' 'git worktree prune'; do
  # Look for the op followed within ~6 lines by the "Skipped under --dry-run" marker.
  if ! awk -v op="${op}" '
    $0 ~ op { found=NR }
    found && NR-found<=6 && /Skipped under `--dry-run`/ { ok=1; exit }
    END { exit ok?0:1 }
  ' "${SKILL}"; then
    echo "FAIL: destructive op '${op}' must be annotated 'Skipped under \`--dry-run\`' nearby" >&2
    fail=1
  fi
done

# 5. Preview report leads with the banner.
assert_contains \
  'DRY RUN — no changes made' \
  "dry-run report must include the banner 'DRY RUN — no changes made'"

# 6. Safety checks (uncommitted changes) are still reported in dry-run.
assert_contains \
  'check runs in dry-run too' \
  "SKILL.md must state that safety checks still run under --dry-run"

# 7. Composes with every selector.
assert_contains \
  '--dry-run.*composes with every selector' \
  "SKILL.md must document that --dry-run composes with every selector"

if [[ "${fail}" -ne 0 ]]; then
  echo "cleanup_dry_run_spec: FAILED" >&2
  exit 1
fi

echo "cleanup_dry_run_spec: OK"
