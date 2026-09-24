# syntax=docker/dockerfile:1
# The `hq` template: a dreamteamer workspace with the hq modules (users · contacts · meetings ·
# projects, plus assets which contacts depends on), code-server as the editor, Claude Code
# preinstalled as CLI and extension. `dt start container <name> --template hq` runs this; the
# `dreamteamer.*` labels are what make it a template to `dt list images`. Behind the hosted gateway
# (DT_GATEWAY_PUBLIC_KEY set) the same image puts dt-origin-proxy in front of the editor and persists
# the durable parts of $HOME onto the workspace volume (DT_PERSIST_HOME).
#
# Build:  docker build -t ghcr.io/dreamteamer/hq:<version> -t ghcr.io/dreamteamer/hq:latest hq
# CI builds and pushes it on a `v*` tag (.github/workflows/images.yml) for amd64 and arm64.
#
# ⚠ NOTHING PERSONAL, NOTHING SECRET, EVER. This image is public. No token, key, .env value, mail
# address or host path goes in here; the person logs in to their coding agent INSIDE the container,
# once, and the login lives in their home volume. tests/ pins that promise on every commit.
FROM node:22-bookworm-slim
ARG DT_VERSION=0.28.0
ARG EXT_VERSION=0.11.0
ARG CLAUDE_VERSION=2.1.281
ARG CODE_SERVER_VERSION=4.138.0
LABEL dreamteamer.template="hq" \
      dreamteamer.ports="8080" \
      dreamteamer.modules="users,contacts,meetings,projects,assets" \
      dreamteamer.engine="${DT_VERSION}" \
      org.opencontainers.image.title="dreamteamer hq" \
      org.opencontainers.image.description="dreamteamer hq workspace: code-server + Claude Code over users, contacts, meetings, projects" \
      org.opencontainers.image.licenses="Apache-2.0"
# Dev Containers metadata: when the host's VS Code ATTACHES to a running container of this image
# (`dt open container <name> --vscode`), the Dev Containers extension reads this label and installs
# these extensions into the container's VS Code Server — a second extension host beside code-server's,
# over the same files — and runs as `node`, the user that owns the workspace.
LABEL devcontainer.metadata='[{"remoteUser":"node","customizations":{"vscode":{"extensions":["dreamteamer.dreamteamer-vscode","anthropic.claude-code"],"settings":{"git.autofetch":true}}}}]'
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates openssh-client procps \
 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://code-server.dev/install.sh | sh -s -- --version ${CODE_SERVER_VERSION} \
 && rm -rf /var/lib/apt/lists/* /root/.cache
RUN npm install -g --no-audit --no-fund dreamteamer@${DT_VERSION} @anthropic-ai/claude-code@${CLAUDE_VERSION} \
 && npm cache clean --force
# Extensions live OUTSIDE the home volume, so a fresh /home/node on first start still has them.
RUN mkdir -p /opt/code-server/extensions \
 && code-server --extensions-dir /opt/code-server/extensions --install-extension anthropic.claude-code \
 && code-server --extensions-dir /opt/code-server/extensions --install-extension dreamteamer.dreamteamer-vscode \
 && chown -R node:node /opt/code-server
RUN mkdir -p /opt/dt-template /workspaces /files && chown -R node:node /opt/dt-template /workspaces /files
USER node
# The workspace template, built ONCE here: init, the hq bundle trimmed to its modules, compile.
# The entrypoint copies it into the (empty) workspace volume on first start — or clones DT_REPO instead.
WORKDIR /opt/dt-template
RUN git init -q && git config user.name dreamteamer && git config user.email dreamteamer@localhost \
 && dreamteamer init --name hq --harnesses claude-code \
 && npm install --no-audit --no-fund dreamteamer@${DT_VERSION} @dreamteamer/extensions@${EXT_VERSION} \
 && node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json'));p.dreamteamer.disable=['notebooks','perspective','recordings','rnd','search'];fs.writeFileSync('package.json',JSON.stringify(p,null,'\t')+'\n')" \
 && mkdir -p .vscode && printf '{\n\t"recommendations": ["dreamteamer.dreamteamer-vscode", "anthropic.claude-code", "ms-vscode-remote.remote-containers"]\n}\n' > .vscode/extensions.json \
 && npx dreamteamer compile && npx dreamteamer check \
 && git add -A && git commit -qm "dreamteamer: hq template" \
 && npm cache clean --force
COPY --chown=node:node entrypoint.sh /usr/local/bin/dt-entrypoint
COPY --chown=node:node persist-home.sh /usr/local/bin/dt-persist-home
COPY --chown=node:node origin-proxy.mjs /usr/local/bin/dt-origin-proxy
WORKDIR /workspaces
EXPOSE 8080
# root only long enough for the entrypoint to chown a freshly attached volume to node; it drops to node
# with setpriv before anything else runs (the template above was still built as node).
USER root
ENTRYPOINT ["dt-entrypoint"]
