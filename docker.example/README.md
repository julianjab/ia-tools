# docker.example — team-workflow `router` as a configurable pod

A reference deployment for running team-workflow non-statically: **one
generic image, configured at runtime by a yaml file plus a small set of
secrets**. The same image hosts any consumer-owned agent (or no persona
at all) by mounting a different `team-workflow.yaml` and, optionally,
baking a different `<agent>.md` into a derived image.

## The contract

| Source of truth | Where it lives | Who owns it |
|---|---|---|
| Image (router + slack-bridge + Claude Code + yq) | this `Dockerfile` | ia-tools (generic) |
| Pod profile (`router.topic_worker_agent`, repos whitelist, ACL, slack topics) | `team-workflow.yaml` mounted at `/opt/ia-tools/.claude/team-workflow.yaml` | the consumer (per pod) |
| Consumer agent (`<name>.md`) | `/root/.claude/agents/<name>.md` baked in a derived image (or mounted) | the consumer |
| Secrets (`*_TOKEN`, OAuth) | `.env` (local) or k8s Secret (cluster) | the operator |

The image is **agent-agnostic**. It contains zero consumer code. A
consumer team produces their pod by extending this image:

```dockerfile
FROM ia-tools-router-pod:0.x.y
COPY agents/<agent>.md /root/.claude/agents/<agent>.md
```

and writing their `team-workflow.yaml`:

```yaml
router:
  topic_worker_agent: <agent>
repos:
  - https://github.com/your-org/your-primary-repo.git
  - https://github.com/your-org/your-secondary-repo.git
access:
  dm: true                       # any user can DM; channel membership is the boundary
  mentions: [U02M1QFA0AF]
```

## How a request flows

```
Slack / terminal
     ↓
router (always-on, PID 1 of the pod) — deterministic dispatcher
     ↓ topic miss
Agent("$IA_TW_TOPIC_WORKER_AGENT") spawned as topic-worker
     ↓ classify
   answer/ask → reply inline (grep cache when needed)
   dispatch   → /session --agent team-workflow:lead
                 ↓
              lead (sub-tmux session)
                 ↓ provision worktree / clone (lazy)
                 ↓ /add-dir <repo>
                 ↓ discover .claude/agents/*.md in the repo
                 ↓ bucket fallback = $IA_TW_TOPIC_WORKER_AGENT
                 ↓ task graph (qa:red → impl:green → security → /pr)
                 ↓ PR opened
router stays up for the next request; pod is never torn down per feature.
```

The four invariants (approval gate, QA-first, security-APPROVED-per-PR,
`/pr`-only-to-main) live in the framework prompts and apply to every
agent, including consumer ones.

## Lazy clone — no boot-time fetching

The `repos:` list in `team-workflow.yaml` is a **whitelist**, not a
pre-clone instruction. The pod boots in seconds with an empty cache.
The first time an agent (router-spawned topic-worker, or a `lead` task)
references a repo, it clones it into
`$IA_TW_STATE_ROOT/clone-cache/<slug>/`. Subsequent uses reuse the
cache (`git fetch`). The PVC keeps clones across pod restarts.

This means:
- Cold boot ≈ image start time, not N × git-clone time.
- Adding a repo to the whitelist requires no rebuild — just edit the yaml.
- Disk usage scales with repos actually touched, not declared.

## Files

| File | Purpose |
|---|---|
| `Dockerfile` | Base image: node + git + tmux + gh + yq + Claude Code + ia-tools plugins. NO baked agent. |
| `entrypoint.sh` | Sources `load-tw-config.sh`, validates auth, starts slack-bridge daemon, execs `router`. |
| `team-workflow.example.yaml` | Sample pod profile. Copy to `team-workflow.yaml` and edit. |
| `.env.example` | Secrets + `${VAR}` placeholders that the yaml interpolates. Copy to `.env` and fill in. |
| `docker-compose.example.yml` | Local test harness: builds the image, mounts the yaml + a named PVC volume. |
| `k8s/deployment.example.yaml` | ConfigMap (yaml) + Secret + PVC + Deployment for a real cluster. |

## Run it locally

```bash
cp docker.example/.env.example                  docker.example/.env
cp docker.example/team-workflow.example.yaml    docker.example/team-workflow.yaml

# Edit both: set tokens in .env, fill in agent name + repos + topics in
# team-workflow.yaml. The placeholders in the yaml resolve from .env at
# loader time.

docker compose -f docker.example/docker-compose.example.yml up --build
```

Attach to the running router:

```bash
docker compose -f docker.example/docker-compose.example.yml exec router \
  tmux attach -t 0
```

Send a message in the subscribed Slack topic (or, terminal-only, type
at the router prompt). On `dispatch` the router spawns a sub-session:

```bash
docker compose ... exec router tmux ls
docker compose ... exec router tmux attach -t feat-<slug>
```

## Run it in Kubernetes

```bash
# 1. tokens → Secret
kubectl create secret generic router-pod-secrets \
  --from-literal=CLAUDE_CODE_OAUTH_TOKEN=... \
  --from-literal=GITHUB_TOKEN=... \
  --from-literal=SLACK_BOT_TOKEN=... \
  --from-literal=SLACK_APP_TOKEN=...

# 2. pod profile → ConfigMap
kubectl create configmap router-pod-profile \
  --from-file=team-workflow.yaml=docker.example/team-workflow.yaml

# 3. PVC + Deployment
kubectl apply -f docker.example/k8s/deployment.example.yaml
```

Re-point at a different repo / agent: edit the yaml, `kubectl create
configmap router-pod-profile --from-file=... --dry-run=client -o yaml |
kubectl apply -f -`, then `kubectl rollout restart deployment/router-pod`.

## Building a consumer pod

A consumer team that owns one or more agents produces one image per
pod from a derived Dockerfile:

```dockerfile
# <consumer>/docker/Dockerfile
FROM ghcr.io/ia-tools/router-pod:0.x.y

ARG AGENT
COPY agents/${AGENT}.md /root/.claude/agents/${AGENT}.md
```

```bash
docker build --build-arg AGENT=<agent-a> -t <consumer>/<agent-a>-pod:1.0 .
docker build --build-arg AGENT=<agent-b> -t <consumer>/<agent-b>-pod:1.0 .
```

The agent's `<name>.md` is the only thing that differs between pods of
the same team — the rest is the same base image plus a different
ConfigMap.

## Caveats — this is an *example*

- `--dangerously-skip-permissions` and
  `--dangerously-load-development-channels` are used to make the pod
  non-interactive. Understand the implications before production use.
- Secrets pass as plain env vars via a k8s Secret. Use your cluster's
  real secrets manager (External Secrets, Vault, …) in production.
- No autoscaling, no NetworkPolicy, no non-root user hardening — add
  them for your environment.
- The PVC is `ReadWriteOnce` and `Recreate` strategy: never run two
  routers against the same volume. Each pod owns its state + cache.

## Prerequisites

This setup depends on the `load-tw-config.sh` loader added in PR #78
(`feat/team-workflow-slack-agents`). Merge that PR before building the
image, or rebase this branch on top of it locally if you need to test
ahead of the merge.
