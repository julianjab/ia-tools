# Harness Engineering — Skill Audit Rules (HE-S1…HE-S10)

Apply these checks to `skills/<name>/SKILL.md`. Skills are the
discrete action surface of the harness: each one is a small,
verifiable unit of capability. These rules complement
[`../skill-anti-patterns.md`](../skill-anti-patterns.md) (S1-S19) by
focusing on *harness behavior* rather than structural correctness.

## Contents

- HE-S1 Single bounded purpose — action
- HE-S2 Deny-by-default tool surface — action
- HE-S3 Preconditions before action — verification
- HE-S4 Fixed-label output block — observability
- HE-S5 Sensitive action requires a gate — guardrails
- HE-S6 Progressive disclosure of references — perception
- HE-S7 Structured failure envelopes — verification
- HE-S8 Idempotency / safe retry — guardrails
- HE-S9 Argument validation step — verification
- HE-S10 Verify-before-report — verification
- Report shape

## HE-S1 — Single bounded purpose (pillar: action)

A skill does ONE thing. Multi-purpose dispatchers (kitchen-sink
`/do-everything`) violate harness engineering's bounded-capability
principle. Sub-commands are fine when they share a single domain
(e.g. `/worktree init|list|cleanup`); unrelated dispatch is not.

- **Check**: count distinct verbs in the body's top-level headings.
  If > 1 unrelated verb and no shared domain noun → fail.
- **Severity**: MEDIUM.

## HE-S2 — Deny-by-default tool surface (pillar: action)

`allowed-tools` is set and is the minimum required. `Bash` without a
matcher is a HIGH violation (existing rule S7). Harness-level addition:
flag any skill whose `allowed-tools` includes a sensitive tool
(`Write`, `Edit`, `Bash`) without naming the files / paths it expects
to touch in the body.

- **Check**: if `Write` or `Edit` in `allowed-tools`, body must name
  the target file(s) or path pattern.
- **Severity**: MEDIUM.

## HE-S3 — Preconditions before action (pillar: verification)

Validation happens BEFORE the action runs, not after. Mitigates the
"context anxiety + one-shotting" pair from Faros.ai. A "Preconditions"
section, a guarded Step 0, or an explicit STOP table satisfies this.

- **Check**: body contains "Preconditions" heading OR Step 0/1 starts
  with "Verify" / "Check" / "Ensure" and lists a STOP condition.
- **Severity**: MEDIUM if missing.

## HE-S4 — Fixed-label output block (pillar: observability)

Every skill ends with a structured output block so the caller can
parse / log / chain. Free-form prose endings break session-to-PR
traceability.

- **Check**: body's last section is an "Output" code block with
  labeled fields (Target, Status, Findings, Verdict, Next).
- **Severity**: MEDIUM if missing (matches existing rule S12).

## HE-S5 — Sensitive action requires a gate (pillar: guardrails)

Skills that push, deploy, send, publish, commit, merge, or
delete must either set `disable-model-invocation: true` OR document
an explicit user-confirmation step. The harness must never trigger an
external side-effect from a non-deterministic decision.

- **Check**: body mentions push/deploy/send/publish/commit/merge/delete
  AND `disable-model-invocation` is `true` OR body has an
  `AskUserQuestion` / "confirm with user" step before the side-effect.
- **Severity**: HIGH if sensitive verb without a gate.

## HE-S6 — Progressive disclosure of references (pillar: perception)

References load only when needed. A skill that says "Load all references"
in Step 1 before knowing which apply is flooding context.

- **Check**: if multiple sibling references exist, body loads them
  conditionally (based on argument or detected artifact) — not all
  upfront.
- **Severity**: LOW.

## HE-S7 — Structured failure envelopes — success silent, failure verbose (pillar: verification)

AddyOsmani's rule: *"Success should be silent; failures verbose and
actionable."* Errors are structured envelopes the caller can parse and
act on. No silent failures (empty output on error). No prose-only
error handling ("if something goes wrong, stop"). An "Error handling"
table mapping condition → action → exit signal is the canonical shape.

Failure messages must include remediation guidance, not just "violation
detected" (Augment Code). "Lint message: `complexity > 10`" fails;
"Lint message: `complexity > 10 — extract helper for the loop body`"
passes.

- **Check**: body has "Error handling" / "Errors" section with
  condition → action mapping AND each error path names a remediation
  or a STOP message that points to the fix.
- **Severity**: MEDIUM if section missing; LOW per error row with no
  remediation guidance.

## HE-S8 — Idempotency / safe retry (pillar: guardrails)

Re-running the skill with the same arguments either is a no-op or
produces a clear "already done" message. Skills that compound damage
on retry (duplicate commits, double PRs) fail this.

- **Check**: body mentions "idempotent" / "safe to re-run" / "skip if
  already" OR — for write skills — describes a check that detects
  prior runs.
- **Severity**: MEDIUM for write skills; LOW for read-only.

## HE-S9 — Argument validation step (pillar: verification)

First numbered step validates `$ARGUMENTS` and STOPs on malformed
input. Mitigates "victory declaration bias" by failing fast.

- **Check**: Step 1 (or "Arguments" table preceding steps) names the
  expected shape and the STOP condition for missing / malformed args.
- **Severity**: MEDIUM if missing on a skill with arguments.

## HE-S10 — Verify-before-report (pillar: verification)

The penultimate step verifies the action succeeded; the final step
reports. Skills that report success without verifying fail this —
the canonical "victory declaration bias" symptom.

- **Check**: for skills that perform a mutation (commit, push,
  PR-create, file edit), penultimate step contains "Verify" / "Confirm"
  / "Check" against the system the mutation targets (git, gh, fs).
- **Severity**: HIGH if mutation skill skips verification.

## Report shape

```
| Severity | Rule   | Finding                                          | Location |
| HIGH     | HE-S5  | Skill calls `git push` without a confirmation    | L88      |
| MEDIUM   | HE-S7  | No Error handling section                        | body     |
```
