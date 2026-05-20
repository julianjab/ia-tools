# docker.example — base image for a team-workflow `router` pod.
#
# Build context is the ia-tools repo root:
#   docker build -f docker.example/Dockerfile -t ia-tools-router-pod:dev .
#
# This image is GENERIC — it ships team-workflow + slack-bridge and boots
# `router`, but does NOT bake any consumer-specific agent. Consumers
# (a team that owns a custom agent persona) extend it:
#
#   FROM ia-tools-router-pod:dev
#   COPY my-agents/<agent>.md /root/.claude/agents/<agent>.md
#
# and mount a .claude/team-workflow.yaml that points
# `router.topic_worker_agent: <agent>`. The framework invokes the agent
# by name and stays agnostic about who owns the file.

FROM node:22-bookworm-slim

# --- system deps -------------------------------------------------------------
# git + tmux: workflow primitives (clone, sub-sessions).
# gh: used by the /pr skill.
# yq: required by load-tw-config.sh to parse team-workflow.yaml.
# gettext-base: provides envsubst for ${VAR} interpolation in the yaml.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git tmux curl ca-certificates gnupg gettext-base \
  && curl -fsSL https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64 \
      -o /usr/local/bin/yq && chmod +x /usr/local/bin/yq \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# --- claude code + pnpm ------------------------------------------------------
RUN npm install -g @anthropic-ai/claude-code pnpm

# --- ia-tools plugin bundle --------------------------------------------------
# Copy the whole repo so the marketplace can be registered locally and the
# slack-bridge daemon can run from source. dist/ is committed, so no build
# step is strictly required for the plugins to load.
WORKDIR /opt/ia-tools
COPY . /opt/ia-tools
RUN pnpm install --frozen-lockfile

# Register the local marketplace so `--agent team-workflow:lead` etc. resolve.
RUN claude plugin marketplace add /opt/ia-tools \
  && claude plugin install team-workflow@ia-tools \
  && claude plugin install slack-bridge@ia-tools

# --- runtime -----------------------------------------------------------------
# State + clone cache live here; mount a PVC at this path in k8s so they
# survive pod restarts. Agents clone repos on-demand under
# $IA_TW_STATE_ROOT/clone-cache/<slug>/ — there is no pre-clone at boot.
ENV IA_TW_STATE_ROOT=/state
RUN mkdir -p /state /root/.claude/agents

# The pod's profile lives in /opt/ia-tools/.claude/team-workflow.yaml.
# Mount it at runtime from a Kubernetes ConfigMap, a docker compose bind
# mount, or `kubectl create configmap --from-file`. No file is baked in
# here — the image is intentionally configuration-free so the same
# binary can host any consumer's profile.
RUN mkdir -p /opt/ia-tools/.claude

COPY docker.example/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Working dir for the router session. It never edits code here — it
# only routes — so this is just a stable CWD.
WORKDIR /opt/ia-tools
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
