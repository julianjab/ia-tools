# Canonical template — `.sdlc/tasks.md` Phase 1 plan

> **Purpose.** This is the canonical shape of the `## Plan` section that the
> orchestrator writes to `.sdlc/tasks.md` during Phase 1 and publishes to the
> user for approval. It is referenced from `agents/orchestrator.md`.
>
> **Rules of the template.**
> 1. Respect the schema headings verbatim. No extra sections ("Hallazgos",
>    "Decisiones arquitectónicas", "Delta vs plan anterior", etc.).
> 2. Research prose goes to `.sdlc/specs/REQ-<NNN>/research.md`, never into
>    `tasks.md`. The plan references the research file; it does not duplicate it.
> 3. `Scope` is a checklist with one line per item. Implementation detail of
>    each item is resolved during execution, not pre-negotiated in the plan.
> 4. `Decisiones clave` is a list of 1-line bullets. If a decision needs a
>    paragraph to explain, it belongs in `specs/`, not in the plan.
> 5. Total plan length should be reviewable in under 2 minutes of reading.

---

## Plan: `<branch-name>`

**What**: <1-sentence outcome>

**Scope**:
- [ ] <concrete change 1>
- [ ] <concrete change 2>
- [ ] <…>

**Stack touched**: `backend` | `frontend` | `mobile` | `none` | (combination)

**API contract**: `new` | `changed` | `none`
  (`new` or `changed` triggers the architect phase)

**Tests**: <which files / layers qa will write RED tests for, or `none`>

**Risks / open questions**: <max 3 one-line bullets or `none`>

**Decisiones clave**: <max 3 one-line bullets — only non-obvious choices>

**Estimated delegations**: <1 line per teammate/subagent the orchestrator
expects to invoke, in rough order>

**Research notes**: `.sdlc/specs/REQ-<NNN>/research.md` (or `none`)
