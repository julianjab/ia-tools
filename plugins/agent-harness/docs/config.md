# Configuration

Per-user settings that change behavior without touching plugin code.

## Resolution order

For every setting, the first non-empty value wins:

1. Environment variable (`AGENT_HARNESS_<NAME>`)
2. User config file at `${AGENT_HARNESS_HOME:-$HOME/.agent-harness}/config.yaml`
3. Plugin default (documented below)

This lets a user pin defaults in their config file and override
per-shell with env vars (useful in CI, tmux per-pane, etc.).

## Settings

| Key            | Env var                       | Default                                  | Purpose |
|----------------|-------------------------------|------------------------------------------|---------|
| `home`         | `AGENT_HARNESS_HOME`          | `$HOME/.agent-harness`                   | Root for config + sessions. |
| `session_root` | `AGENT_HARNESS_SESSION_ROOT`  | `<home>/sessions`                        | Where session workspaces (`state.yaml` + log) live. |
| `repo_roots`   | `AGENT_HARNESS_REPO_ROOTS`    | `$HOME/development`                      | Colon-separated dirs scanned for repo candidates. |
| `default_model`| `AGENT_HARNESS_DEFAULT_MODEL` | `haiku`                                  | Model used by stages that don't override. |
| `stage_models` | (per-stage envs, see below)   | `{}` (falls back to `default_model`)     | Per-stage model picks. |
| `max_repos`    | `AGENT_HARNESS_MAX_REPOS`     | `8`                                      | Safety cap for repo-detect output. |
| `language`     | `AGENT_HARNESS_LANGUAGE`      | `auto`                                   | `es`/`en`/`auto` — hint for stages that produce prose. |

### Per-stage model override

`AGENT_HARNESS_MODEL_<STAGE>` overrides the model for that stage. Example:

```bash
AGENT_HARNESS_MODEL_TASK_PLAN=sonnet
AGENT_HARNESS_MODEL_AGENT_SCAN=haiku
```

## Config file format

`<home>/config.yaml`:

```yaml
session_root: /Users/me/.agent-harness/sessions
repo_roots:
  - /Users/me/development/personal
  - /Users/me/development/work
default_model: haiku
stage_models:
  task-plan: sonnet
max_repos: 12
language: es
```

Unknown keys are ignored (forward-compat).

## Bootstrapping

There is no required setup step. Stages that need a config value call
`lib/config.sh` which materializes `<home>/` and `<home>/config.yaml`
on first use with the documented defaults. The user can then edit the
file to taste.
