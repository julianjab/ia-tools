# docker.example — team-workflow `router` as a configurable pod

A worked example of running team-workflow **non-statically**: one Docker
image, one `router` agent, and a **pod dispatch profile** supplied
entirely through environment variables. Flip the profile and the same
image behaves as a developer-host orchestrator or a single-repo
Kubernetes pod — no code change, no rebuild.

## The idea: configuration by variables (openclaw-style)

There is **one router agent** and **two orchestrator personas** (`lead`,
`repo-worker`). Nothing is hardcoded — the router reads three env vars
at boot and forwards them to every sub-session it spawns:

| Env var | Default | Purpose |
|---|---|---|
| `IA_TW_DISPATCH_AGENT` | `team-workflow:lead` | Orchestrator persona each `dispatch` spawns. |
| `IA_TW_DISPATCH_PROVISION` | `worktree-local` | `worktree-local` (worktree of a sibling repo) or `clone` (git clone of a remote URL). |
| `IA_TW_REPO_URL` | — | Git URL to clone. Required when `provision=clone`. |

Two canonical profiles, same image:

| Profile | `IA_TW_DISPATCH_AGENT` | `IA_TW_DISPATCH_PROVISION` | Use |
|---|---|---|---|
| **Dev host** | _(unset)_ → `lead` | _(unset)_ → `worktree-local` | multi-repo, worktrees on a developer machine |
| **Pod** | `team-workflow:repo-worker` | `clone` | one repo, clone-work-PR, long-lived k8s pod |

In Kubernetes the profile lives in a **ConfigMap** (non-secret) and
tokens in a **Secret**. Editing the ConfigMap + restarting the pod
re-points it at a different repo — that is the whole "configuration by
variables" story.

### Optional: `pod-config.json` (the openclaw-style mirror)

Env vars are the real contract. `pod-config.json` is an optional single
readable file that mirrors the profile; `entrypoint.sh` reads it,
interpolates `${ENV}` refs, and exports the `IA_TW_*` vars it implies.
**Env always wins** — the file only fills gaps. Delete it to go
pure-env.

## How a request flows

```
request arrives (Slack / terminal)
   ↓
router  (always-on, PID 1 of the pod) — classifies answer / ask / dispatch
   ↓ dispatch
router invokes start-lead.sh, forwarding the pod profile:
   IA_TW_AGENT=$IA_TW_DISPATCH_AGENT
   IA_TW_PROVISION=$IA_TW_DISPATCH_PROVISION
   IA_TW_REPO_URL=$IA_TW_REPO_URL
   ↓
repo-worker  (new tmux session, same pod)
   - git clone IA_TW_REPO_URL → /state/<hash>/clone  (reused on restart: git fetch)
   - plan → BLOCK on `aprobar`
   - task graph: qa:red → impl:green → security → pr
   - opens exactly ONE PR
   ↓
router stays up for the next request; pod is never torn down per feature
```

The four invariants (approval gate, QA-first, security-APPROVED-per-PR,
`/pr`-only-to-main) are identical on both profiles — see `AGENTS.md`.

## Agents involved

| Agent | Role |
|---|---|
| `team-workflow:router` | Always-on main session. 3-intent classifier; dispatches per the pod profile. Never edits code. |
| `team-workflow:repo-worker` | Single-repo orchestrator. Clones `IA_TW_REPO_URL` onto the persistent volume, runs the full graph, opens one PR. |
| `team-workflow:lead` | Multi-repo orchestrator (dev-host profile). |
| `team-workflow:implementer` | Plugin fallback when a cloned repo ships no repo-local implementer agent. |

## Files

| File | Purpose |
|---|---|
| `Dockerfile` | Image: node + git + tmux + gh + claude-code + the ia-tools plugin bundle. |
| `entrypoint.sh` | Resolves the pod profile (`pod-config.json` + env), starts the slack-bridge daemon, `exec`s `router` as PID 1. |
| `pod-config.example.json` | Optional openclaw-style profile mirror. |
| `.env.example` | All runtime config. Copy to `.env` and fill in. |
| `docker-compose.example.yml` | Local test harness — mirrors the k8s setup with a named volume. |
| `k8s/deployment.example.yaml` | ConfigMap (profile) + Secret + PVC + Deployment for a real cluster. |

## Run it locally

```bash
cp docker.example/.env.example docker.example/.env
# edit docker.example/.env — set CLAUDE_CODE_OAUTH_TOKEN, IA_TW_REPO_URL,
# GITHUB_TOKEN, the IA_TW_DISPATCH_* profile, and (optionally) SLACK_* tokens.

docker compose -f docker.example/docker-compose.example.yml up --build
```

Drive it. With Slack tokens set, message the bot in the subscribed
topic. Without Slack, attach to the terminal session:

```bash
docker compose -f docker.example/docker-compose.example.yml exec router \
  tmux attach -t 0
```

Ask the router for something concrete ("agrega un botón de logout en el
header"). It classifies → `dispatch` → spawns a `repo-worker` tmux
session. Inspect it:

```bash
docker compose ... exec router tmux ls
docker compose ... exec router tmux attach -t feat-logout-button
```

`repo-worker` clones the repo into `/state/<topic-hash>/clone`, posts a
plan, waits for `aprobar`, then runs the graph and opens a PR.

## Run it in Kubernetes

```bash
# 1. tokens → Secret
kubectl create secret generic router-pod-secrets \
  --from-literal=CLAUDE_CODE_OAUTH_TOKEN=... \
  --from-literal=GITHUB_TOKEN=... \
  --from-literal=SLACK_BOT_TOKEN=... \
  --from-literal=SLACK_APP_TOKEN=...

# 2. profile (ConfigMap) + PVC + Deployment
#    edit IA_TW_REPO_URL in the ConfigMap first
kubectl apply -f docker.example/k8s/deployment.example.yaml
```

The PVC keeps `state.md` and the repo clone across pod restarts — on
reboot `repo-worker` reuses the clone (`git fetch`) instead of
re-cloning, and resumes any in-flight feature from its `state.md`.

To re-point the pod at another repo: edit `IA_TW_REPO_URL` in the
`router-pod-profile` ConfigMap and `kubectl rollout restart deployment/router-pod`.

## Caveats — this is an *example*

- `--dangerously-skip-permissions` and
  `--dangerously-load-development-channels` are used to make the pod
  non-interactive. Understand the implications before production use.
- Secrets are passed as plain env vars via a k8s Secret. Use your
  cluster's real secrets manager (External Secrets, Vault, etc.).
- One repo per pod. Multi-repo work uses the dev-host profile
  (`lead` + `worktree-local`) on a developer machine.
- No autoscaling, no network policy, no non-root user hardening — add
  them for your environment.
