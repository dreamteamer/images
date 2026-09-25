# syntax=docker/dockerfile:1
# The `hq` template: a dreamteamer workspace with the hq modules (users · contacts · meetings ·
# projects, plus assets which contacts depends on), code-server as the editor, Claude Code
# preinstalled as CLI and extension. `dt start container <name> --template hq` runs this; the
# `dreamteamer.*` labels are what make it a template to `dt list images`. Behind the hosted gateway
# (DT_GATEWAY_PUBLIC_KEY set) the same image puts dt-origin-proxy in front of the editor and persists
# the durable parts of $HOME onto the workspace volume (DT_PERSIST_HOME).
#
# Build:  docker build -t ghcr.io/dreamteamer/hq:<version> hq
# CI builds and pushes it on a `v*` tag (.github/workflows/images.yml) for amd64 and arm64.
#
# ⚠ NOTHING PERSONAL, NOTHING SECRET, EVER. This image is public. No token, key, .env value, mail
# address or host path goes in here; the person logs in to their coding agent INSIDE the container,
# once, and the login lives in their home volume. tests/ pins that promise on every commit.
#
# Supply chain: the base is pinned by digest (Dependabot bumps it), code-server is the release .deb
# checked against the sha256 GitHub lists for that asset, apt installs nothing recommended.
FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
ARG DT_VERSION=0.28.0
ARG EXT_VERSION=0.11.0
ARG CLAUDE_VERSION=2.1.281
ARG CODE_SERVER_VERSION=4.138.0
# sha256 of code-server_${CODE_SERVER_VERSION}_<arch>.deb, from the v4.138.0 release's asset digests (read 2026-09-25)
ARG CODE_SERVER_SHA256_AMD64=044eddb4871c9ab7e3a26e23bb472c8fbfedb2723fa2db7c964d903b491ff643
ARG CODE_SERVER_SHA256_ARM64=a0f404035146ecbd596cc204300ea48f1e2ad6b7ed4c677291e82487a71dec40
ARG TARGETARCH
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
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ENV DEBIAN_FRONTEND=noninteractive
# nftables + iproute2: the hosted egress policy (entrypoint, root phase). Unpinned on purpose: the base
# digest fixes the release, and a rebuild should pick up Debian security fixes.
# hadolint ignore=DL3008
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates openssh-client procps nftables iproute2 \
 && rm -rf /var/lib/apt/lists/*
RUN case "${TARGETARCH}" in \
      amd64) sum="${CODE_SERVER_SHA256_AMD64}" ;; \
      arm64) sum="${CODE_SERVER_SHA256_ARM64}" ;; \
      *) echo "no pinned code-server sha256 for arch '${TARGETARCH}'" >&2; exit 1 ;; \
    esac \
 && deb="code-server_${CODE_SERVER_VERSION}_${TARGETARCH}.deb" \
 && curl -fsSLo "/tmp/${deb}" "https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/${deb}" \
 && echo "${sum}  /tmp/${deb}" | sha256sum -c - \
 && dpkg -i "/tmp/${deb}" \
 && rm -f "/tmp/${deb}"
# The origin proxy's own user: the workspace user (node) can neither signal nor ptrace it.
RUN useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin dtproxy
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
# Root-owned and read-only to everyone else: the workspace user cannot rewrite the auth boundary.
COPY --chown=root:root --chmod=0755 entrypoint.sh /usr/local/bin/dt-entrypoint
COPY --chown=root:root --chmod=0755 persist-home.sh /usr/local/bin/dt-persist-home
COPY --chown=root:root --chmod=0755 files-folder.sh /usr/local/bin/dt-files-folder
COPY --chown=root:root --chmod=0755 origin-proxy.mjs /usr/local/bin/dt-origin-proxy
COPY --chown=root:root --chmod=0644 egress.nft /etc/dt/egress.nft
WORKDIR /workspaces
EXPOSE 8080
# root: the entrypoint applies the egress policy, chowns a freshly attached volume, and stays as a small
# supervisor (PID 1) that starts the proxy as dtproxy and code-server as node, each through setpriv with
# no new privileges and no capabilities. setuid/setgid bits go, so nothing can climb back.
# hadolint ignore=DL3002
USER root
RUN find / -xdev -perm /6000 -type f -exec chmod a-s {} +
ENTRYPOINT ["dt-entrypoint"]
