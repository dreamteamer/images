# syntax=docker/dockerfile:1
# The `hq-agents` template: everything `hq` is, plus three more coding-agent CLIs — OpenAI Codex,
# Google Gemini CLI and Google Antigravity CLI (`agy`). Built FROM the hq image CI pushed in the same
# run, by digest, so the two never drift on the engine, the modules, the editor or the hardening.
#
# Every agent is logged into INSIDE the container by the person, once; the home volume keeps each
# login. No token or key is baked here — this image is public. tests/ pins that.
# CI passes the digest it just pushed; the default is the last published hq (v0.3.x) for a local build.
ARG HQ_DIGEST=sha256:23175d9c5fe8f6afa23b636f281412b6162e7ec78e9ba41d4ce4fd3074c1e49e
FROM ghcr.io/dreamteamer/hq@${HQ_DIGEST}
ARG CODEX_VERSION=0.156.1
ARG GEMINI_VERSION=0.61.0
LABEL dreamteamer.template="hq-agents" \
      dreamteamer.agents="claude,codex,gemini,agy" \
      org.opencontainers.image.title="dreamteamer hq-agents" \
      org.opencontainers.image.description="dreamteamer hq workspace with Claude Code, Codex, Gemini CLI and Antigravity CLI"
# hadolint ignore=DL3002
USER root
RUN npm install -g --no-audit --no-fund @openai/codex@${CODEX_VERSION} @google/gemini-cli@${GEMINI_VERSION} \
 && npm cache clean --force
# Antigravity CLI is a Go binary from Google's installer, not an npm package. Installed to /usr/local
# so it sits outside the home volume; `agy` authenticates through a browser-URL loop when it cannot
# open a browser, which is what a container is.
RUN curl -fsSL https://antigravity.google/cli/install.sh | bash \
 && (command -v agy >/dev/null || (ls /root/.local/bin/agy >/dev/null 2>&1 && install -m 0755 /root/.local/bin/agy /usr/local/bin/agy)) \
 && command -v agy
# strip whatever setuid/setgid bits the installs above added, as hq does
RUN find / -xdev -perm /6000 -type f -exec chmod a-s {} +
# root, like hq: the entrypoint applies the egress policy and drops every process it starts itself
# hadolint ignore=DL3002
USER root
WORKDIR /workspaces
