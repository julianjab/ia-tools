# docker.example — long-lived pod image for a team-workflow `router`.
#
# Build context is the ia-tools repo root:
#   docker build -f docker.example/Dockerfile -t ia-tools-router-pod:dev .
#
# The image bundles the team-workflow + slack-bridge plugins and boots a
# `router` main session configured with a POD dispatch profile (env vars
# IA_TW_DISPATCH_*). On dispatch, the router spawns `repo-worker`
# sub-sessions (tmux, same pod) that clone a single repo, run the
# QA-first/security/PR graph, and open one PR.

FROM node:22-bookworm-slim

# --- system deps -------------------------------------------------------------
# git + tmux: required by the workflow (worktree/clone, sub-sessions).
# gh: used by the /pr skill. ca-certificates + curl for installs.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git tmux curl ca-certificates gnupg \
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

# Register the local marketplace so `--agent team-workflow:pixelin` resolves.
RUN claude plugin marketplace add /opt/ia-tools \
  && claude plugin install team-workflow@ia-tools \
  && claude plugin install slack-bridge@ia-tools

# --- runtime -----------------------------------------------------------------
# State (state.md + clones) lives here; mount a PVC at this path in k8s so it
# survives pod restarts.
ENV IA_TW_STATE_ROOT=/state
RUN mkdir -p /state

# Optional openclaw-style pod profile. entrypoint.sh reads it, interpolates
# ${ENV} refs, and exports the IA_TW_* vars it implies (env still wins).
# Override by mounting your own at /opt/ia-tools/pod-config.json, or delete
# it and configure purely via env / ConfigMap.
COPY docker.example/pod-config.example.json /opt/ia-tools/pod-config.json
COPY docker.example/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Working dir for the router session. It never edits code here — it only
# routes — so this is just a stable CWD.
WORKDIR /opt/ia-tools
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
