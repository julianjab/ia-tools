---
name: validate-agents
description: >
  Static validator (Level 1) for the ia-tools plugin's agent and skill
  definitions. Checks frontmatter integrity, tool whitelists, cross-references,
  hook wiring, and stale pointers to removed agents/skills. Runs in pre-commit
  and is also callable manually. Catches ~80% of refactor-induced regressions
  without spending any API tokens.
  Examples: `/validate-agents`, `/validate-agents --verbose`,
  `/validate-agents --fix` (auto-fix is NOT implemented yet — flag reserved).
argument-hint: "[--verbose] [--json]"
disable-model-invocation: false
---

## /validate-agents — Level 1 Static Validator

`/validate-agents` runs a fast (~1s), hermetic validator against the agent and
skill definitions of this plugin. It does NOT spend Claude API tokens, does
NOT execute any agent, and does NOT make network calls. It reads files off
disk and produces a pass/fail report.

Use it:
- Automatically in pre-commit (wired in `.pre-commit-config.yaml`).
- Manually via `/validate-agents` when you've just refactored agents or skills.
- In CI (optional) for a safety net after merges.

## What it checks

The rules live in `skills/validate-agents/scripts/validate.sh`. Each rule
corresponds to a category of mistakes that have actually happened in the past.

### Category A — Frontmatter integrity

| Rule | Failure mode detected |
|------|----------------------|
| `A1` | Every `agents/*.md` has a well-formed YAML frontmatter (between `---` lines at the top). |
| `A2` | Every agent has `name`, `description`, `model` fields. |
| `A3` | The frontmatter `name:` field matches the filename (`foo.md` → `name: foo`). |
| `A4` | Every agent has an explicit `tools:` field (no silent inheritance). Prevents the triage whitelist leak. |
| `A5` | Every `skills/*/SKILL.md` has a well-formed frontmatter with `name` matching the parent directory name. |

### Category B — Tool whitelist guarantees

| Rule | Failure mode detected |
|------|----------------------|
| `B1` | `triage` MUST NOT list `Edit`, `Write`, `MultiEdit`, `NotebookEdit`, or `Agent` in its tools. Enforces "main session never edits, never delegates via Agent". |
| `B2` | `triage` MUST list `SlashCommand` (the only way it can hand off to `/task`). |
| `B3` | `security` MUST NOT list `Edit`, `Write`, `MultiEdit`, `NotebookEdit` (security never writes code per its contract). |
| `B4` | `orchestrator` MUST list `Agent` (it delegates to every stack agent) and `SlashCommand` (it calls `/pr`). |

### Category C — Cross-reference integrity

| Rule | Failure mode detected |
|------|----------------------|
| `C1` | Every `Agent(subagent_type="X")` or `subagent_type: "X"` reference in any markdown under `agents/` or `skills/` resolves to a real `agents/X.md` file. |
| `C2` | Every `/<skill>` reference in any markdown (excluding known CLI slashes like `/usr`, `/tmp`, `/dev`, etc.) resolves to a real `skills/<skill>/SKILL.md`. |
| `C3` | Every hook script referenced in `hooks/hooks.json` exists and is executable. |

### Category D — Stale references (post-refactor dead pointers)

| Rule | Failure mode detected |
|------|----------------------|
| `D1` | No mention of removed agents (`issue-refiner`, `backend-lead`, `frontend-lead`, `mobile-lead`, `api-agent`, `domain-agent`, `ui-agent`, `mobile-agent`, `qa-agent`, `security-reviewer`) in any `.md` **outside** AGENTS.md's historical "Removed in..." note and the new agents' "Collapses what used to be..." descriptions (those are explicitly whitelisted). |
| `D2` | No mention of removed skills (`/deliver`, `/worktree spawn`) in any markdown. |

### Category E — Env var / runtime consistency

| Rule | Failure mode detected |
|------|----------------------|
| `E1` | `SLACK_THREAD_TS` and `SLACK_CHANNELS` are spelled identically across `skills/task/scripts/start-task.sh`, `hooks/scripts/session-start.sh`, and `agents/orchestrator.md`. |
| `E2` | `IA_TOOLS_ROLE` is spelled identically across all scripts and `agents/*.md` that mention it. |

## How it runs

The skill is thin: it delegates to a single bash script.

```bash
bash "$(git rev-parse --show-toplevel)/skills/validate-agents/scripts/validate.sh" \
  [--verbose] [--json]
```

Exit codes:

| Code | Meaning |
|------|---------|
| `0`  | All rules passed |
| `1`  | At least one rule failed (details on stderr) |
| `2`  | Script itself errored (missing dependency, bad CWD, etc.) |

## Output format

Default (human):

```
✓ A1 frontmatter well-formed        8/8 agents
✓ A2 required fields present        8/8 agents
✓ A3 name matches filename          8/8 agents
✗ A4 explicit tools: field          6/8 agents
    - agents/backend.md (missing tools:)
    - agents/frontend.md (missing tools:)
✓ B1 triage no-edit whitelist       passed
...

Result: FAIL (1 rule failed, 2 findings)
```

With `--verbose`, also prints each skipped check and the full list of scanned files.

With `--json`, prints a machine-readable report suitable for CI:

```json
{
  "result": "fail",
  "rules": [
    {"id": "A4", "status": "fail", "findings": [{"file": "agents/backend.md", "line": 1, "message": "missing tools: field"}]}
  ]
}
```

## Invocation by humans and hooks

### Pre-commit

Wired in `.pre-commit-config.yaml` under a `local` repo block. It runs on every
commit that touches `agents/`, `skills/`, `hooks/`, `CLAUDE.md`, or `AGENTS.md`.
Failing the validator blocks the commit.

### Manual

```
/validate-agents
```

or from the terminal:

```
bash skills/validate-agents/scripts/validate.sh
```

### CI (optional)

Add to the existing GitHub Actions workflow:

```yaml
- name: Validate agents & skills
  run: bash skills/validate-agents/scripts/validate.sh --json
```

## What it does NOT check (out of scope for Level 1)

- **Behavior of agents.** That's Level 2 (golden set with real API calls).
- **Agent output quality.** Prompt engineering is not static-checkable.
- **Skill body quality.** SKILL.md prose is not analyzed for coherence.
- **Hook correctness.** We check the scripts exist, not that they produce
  correct JSON under all inputs (that would require a test harness).

Those belong in Level 2 and 3 — see the testing notes in CLAUDE.md.

## Adding a new rule

1. Add the rule ID + description to the tables above.
2. Implement the check in `scripts/validate.sh` as a `check_<id>` function.
3. Register it in the `RULES` array at the top of the script.
4. Run the validator against the repo, confirm it fires only on real failures.
5. Commit both the rule and any repo fixes in the same PR.

Rules should be **fast** (each under 100ms), **hermetic** (no network, no API,
no git mutations), and **deterministic** (same input → same output).
