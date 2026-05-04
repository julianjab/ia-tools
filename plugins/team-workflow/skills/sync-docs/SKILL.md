---
name: sync-docs
description: >
  Audit and auto-update CLAUDE.md files to match the current state of the codebase.
  Detects drift between documentation and actual code: new services, removed files,
  changed patterns, outdated commands, stale references. Applies fixes automatically
  and shows the diff. Use when you want to ensure CLAUDE.md files are accurate,
  or as part of a pre-PR workflow.
argument-hint: "[--dry-run] [--scope core|app|root|all]"
disable-model-invocation: false
---

## Sync Docs Workflow

Audit all CLAUDE.md files in the project against the actual codebase and auto-update them.

### Arguments
- `$ARGUMENTS` — optional:
  - `--dry-run` → Show what would change without modifying files
  - `--scope <value>` → Limit to `root`, `core`, `app`, or `all` (default: `all`)

---

### Step 1 — Discover CLAUDE.md Files

1. Find all CLAUDE.md files in the project:
```bash
find . -name "CLAUDE.md" -not -path "./.git/*" -not -path "./node_modules/*"
```
2. For each file, note its scope (root, core package, app package, etc.)

---

### Step 2 — Audit Each CLAUDE.md

For each CLAUDE.md file, perform the following checks by reading the actual codebase:

#### 2.1 — Structure Audit
- **Directory structure**: Compare documented tree vs actual `ls` output. Flag new directories, removed directories
- **File counts**: Check if documented file patterns still match (e.g., "services end with ServiceImp")

#### 2.2 — Component Audit
Scan the codebase for components and compare against what's documented.

First, detect the stack (see `shared/stack-detection.md`) and determine source file extensions. Then scan for key abstractions based on the project's architecture:

```bash
# Detect stack and adapt search patterns
# Python: grep -r "class.*Service" --include="*.py" -l
# TypeScript: grep -r "class.*Service\|export.*Service" --include="*.ts" -l
# Go: grep -r "type.*Service interface\|type.*Service struct" --include="*.go" -l
# Rust: grep -r "trait.*Service\|struct.*Service" --include="*.rs" -l
```

Read the project's CLAUDE.md to understand its architectural conventions (e.g., Services, Ports, Adapters, Controllers, Components, Composables) and scan for those specific patterns.

Flag:
- **New components** not mentioned in CLAUDE.md
- **Removed components** still referenced in CLAUDE.md
- **Renamed components** (old name in docs, new name in code)

#### 2.3 — Dependency Audit
- Check the project manifest (`pyproject.toml`, `package.json`, `go.mod`, `Cargo.toml`) for new/removed dependencies not reflected in docs
- Check DI/registration modules (if the project uses them) for new service registrations not documented

#### 2.4 — Command Audit
- Verify documented `make` targets still exist in Makefile
- Check if any new Makefile targets were added but not documented
- Verify documented CLI commands still work (check manifest scripts — `pyproject.toml`, `package.json`, etc.)

#### 2.5 — Pattern Audit
- Check if documented code patterns (exception handling, logging, DI) still match actual usage
- Scan for new patterns used in 3+ files that aren't documented
- Verify environment variables referenced in docs vs actual usage in code

#### 2.6 — Integration Audit
- Check integration points table: are all ports listed? Any new adapters?
- Verify external service references are current

---

### Step 3 — Generate Changes

For each drift detected, classify it:

| Category | Example | Action |
|----------|---------|--------|
| **New component** | New `NotificationPort` added | Add to relevant section |
| **Removed component** | Old `LegacyService` deleted | Remove from docs |
| **Renamed** | `CalService` → `CalendarService` | Update all references |
| **New pattern** | New error handling approach in 3+ files | Add pattern section |
| **Stale reference** | Documented env var no longer used | Remove or mark deprecated |
| **New dependency** | New package in manifest | Add to dependencies section |
| **New Makefile target** | New `make lint` target | Add to commands section |
| **Structure change** | New directory added | Update tree diagram |

---

### Step 4 — Apply Updates

If `--dry-run` is NOT set:

1. **Apply all changes** to the CLAUDE.md files using the Edit tool
2. **Preserve the existing style**: Match heading levels, emoji usage, table formats, code block styles
3. **Do NOT rewrite entire sections** — only add/remove/update the specific items that drifted
4. **Do NOT add new sections** unless there's a genuinely new category of information (e.g., a completely new integration layer)
5. **Run the project's format command** if any source files were touched (usually not needed for .md files)

---

### Step 5 — Report

Present a summary:

```
CLAUDE.md Sync Report
=====================

Files audited: <count>

<filename>:
  [+] Added: <component/section> — <reason>
  [-] Removed: <component/section> — <reason>  
  [~] Updated: <component/section> — <reason>
  [=] No changes needed

Total changes: <count additions> added, <count removals> removed, <count updates> updated
```

If `--dry-run` was set, prefix with:
```
DRY RUN — No files were modified. Changes above would be applied.
```

---

### Rules

- **Never remove user-written notes or context** — only update factual references (file paths, class names, commands)
- **Never change the overall structure or organization** of a CLAUDE.md — respect the author's layout
- **Preserve emoji usage** — if the file uses emojis in headers, keep them. If not, don't add them
- **Be conservative** — when in doubt about whether something is drift or intentional, leave it and mention it in the report as "potential drift"
- **Do not add comments like "updated by sync-docs"** — the changes should be invisible
- **If a CLAUDE.md doesn't exist for a package that has one**, do NOT create it. Only update existing files
