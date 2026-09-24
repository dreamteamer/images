# syntax=docker/dockerfile:1
# The `hq-agents` template: everything `hq` is, plus three more coding-agent CLIs — OpenAI Codex,
# Google Gemini CLI and Google Antigravity CLI (`agy`). Built FROM the hq image of the same version,
# so the two never drift on the engine, the modules or the editor.
#
# Every agent is logged into INSIDE the container by the person, once; the home volume keeps each
# login. No token or key is baked here — this image is public. tests/ pins that.
ARG HQ_VERSION=latest
FROM ghcr.io/dreamteamer/hq:${HQ_VERSION}
ARG CODEX_VERSION=0.156.1
ARG GEMINI_VERSION=0.61.0
LABEL dreamteamer.template="hq-agents" \
      dreamteamer.agents="claude,codex,gemini,agy" \
      org.opencontainers.image.title="dreamteamer hq-agents" \
      org.opencontainers.image.description="dreamteamer hq workspace with Claude Code, Codex, Gemini CLI and Antigravity CLI"
USER root
RUN npm install -g --no-audit --no-fund @openai/codex@${CODEX_VERSION} @google/gemini-cli@${GEMINI_VERSION} \
 && npm cache clean --force
# Antigravity CLI is a Go binary from Google's installer, not an npm package. Installed to /usr/local
# so it sits outside the home volume; `agy` authenticates through a browser-URL loop when it cannot
# open a browser, which is what a container is.
RUN curl -fsSL https://antigravity.google/cli/install.sh | bash \
 && (command -v agy >/dev/null || (ls /root/.local/bin/agy >/dev/null 2>&1 && install -m 0755 /root/.local/bin/agy /usr/local/bin/agy)) \
 && command -v agy
USER node
WORKDIR /workspaces
