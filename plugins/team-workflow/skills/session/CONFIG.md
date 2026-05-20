# team-workflow.yaml — declarative pod / repo configuration

`/session` and `start-lead.sh` source
`scripts/load-tw-config.sh` at boot. When a
`<consumer-repo>/.claude/team-workflow.yaml`, `~/.claude/team-workflow.yaml`,
or `$IA_TW_CONFIG` file is present, the loader maps it into the
`IA_TW_*` / `SLACK_TOPICS` / `ALLOWED_USERS_*` env vars the rest of the
stack already consumes. **Env vars set before the loader runs always
win** — the file fills gaps, never overrides.

The schema is documented inline in
[`team-workflow.example.yaml`](./team-workflow.example.yaml). Read that
file first; the section below is conceptual.

## Why a yaml at all (env vars already worked)

- One single readable place to see the whole pod profile (5+ vars in a
  block, not scattered across a ConfigMap).
- Same shape for dev-host (`.claude/team-workflow.yaml` in the repo),
  Docker, and Kubernetes — the only difference is where the file
  lives.
- `${VAR}` interpolation keeps secrets in env (Kubernetes Secret,
  `.env`), not in the file.
- Override is unambiguous: set the env var and forget about the yaml.

## What it controls

| Section | Maps to env vars | Consumer |
|---|---|---|
| `router.topic_worker_agent` | `IA_TW_TOPIC_WORKER_AGENT` | `router.md` (which persona answers info questions) |
| `router.dispatch.agent` | `IA_TW_DISPATCH_AGENT` | `start-lead.sh` (which orchestrator boots on `dispatch`) |
| `router.dispatch.provision` | `IA_TW_PROVISION` | `lead.md` / `repo-worker.md` (`worktree-local` or `clone`) |
| `router.dispatch.repo_url` | `IA_TW_REPO_URL` | `repo-worker.md` (single-repo clone target) |
| `repos[]` | `IA_TW_REPO_URLS` | entrypoint pre-clone + `topic-worker.md` cache grep |
| `slack.topics[]` | `SLACK_TOPICS` | slack-bridge MCP auto-subscribe |
| `access.dm` / `access.mentions` | `ALLOWED_USERS_DM` / `ALLOWED_USERS_MENTIONS` | slack-bridge access gate |
| `state.root` | `IA_TW_STATE_ROOT` | entrypoint / state.md location |
| `git.author_name` / `git.author_email` | `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` | `entrypoint.sh` git config |

## Access control quick reference

The `access:` block is a thin wrapper around slack-bridge's
deny-by-default allowlists:

```yaml
access:
  dm: true                     # ALLOWED_USERS_DM=*    (any user can DM)
  mentions: [U1, U2]           # ALLOWED_USERS_MENTIONS=U1,U2
  # dm: false                  # ALLOWED_USERS_DM=     (block all)
  # mentions: false            # ALLOWED_USERS_MENTIONS= (block all)
```

If the block is absent or both axes are unset, the loader leaves the
two env vars untouched — slack-bridge falls back to its own
`process.env` lookup, which (unset) is deny-by-default. Be explicit if
you want a public bot: `dm: true` or `mentions: true`.

See `plugins/slack-bridge/README.md` → "Access control" for the full
behaviour at the bridge level.

## Persona pods (kubito, gordo, centinela, …)

A persona pod is just a `team-workflow.yaml` that points
`topic_worker_agent` and `dispatch.agent` at the persona-specific
overlays you wrote on top of the base `topic-worker.md` / `lead.md` /
`repo-worker.md`. See `plugins/team-workflow/agents/example-topic.md`
and `example-worker.md` for the overlay template.

```yaml
router:
  topic_worker_agent: team-workflow:kubito-topic
  dispatch:
    agent: team-workflow:kubito-worker
    provision: clone
repos:
  - https://github.com/your-org/eks.git
  - https://github.com/your-org/platform-infrastructure.git
slack:
  topics:
    - C0DEVOPS-INFRA
    - DM:U02M1QFA0AF
access:
  dm: [U02M1QFA0AF, U03ABCDEF]
  mentions: [U02M1QFA0AF, U03ABCDEF, U04SRE-ONCALL]
```

## Local dev requirements

`load-tw-config.sh` needs `yq` (mikefarah/yq, v4+). Install on dev
hosts via your package manager:

```bash
# macOS
brew install yq
# Debian / Ubuntu
apt install yq
```

In the Docker pod image the Dockerfile installs `yq` at build time.

## Wiring into a Docker / k8s pod

When the docker.example reference deployment is available (see PR
#77 → `docker.example/`), the wiring is two lines in `entrypoint.sh`:

```bash
# Source the loader before the final exec
. /opt/ia-tools/plugins/team-workflow/skills/session/scripts/load-tw-config.sh

# Pre-clone iterates IA_TW_REPO_URLS into IA_TW_STATE_ROOT/clone-cache/
```

And one line in the Dockerfile:

```dockerfile
RUN apt-get install -y --no-install-recommends yq
```

The yaml file is mounted from a Kubernetes ConfigMap to
`/opt/ia-tools/.claude/team-workflow.yaml`; the Secret carries
`CLAUDE_CODE_OAUTH_TOKEN`, `GITHUB_TOKEN`, `SLACK_BOT_TOKEN`,
`SLACK_APP_TOKEN`, and any repo-URL tokens referenced via `${...}`
inside the yaml.
