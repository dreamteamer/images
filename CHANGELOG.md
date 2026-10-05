# Changelog

## 0.7.1 — 2026-10-05 — standalone modules

- Upgrade the published engine to 0.33.0 and the verified editor extension to 0.23.2.
- Replace the extensions bundle with explicit users, companies, contacts, assets, projects and meetings dependencies.
- Existing workspaces keep their own package versions; descriptor migration is explicit.
- Local verification: 174 source tests, 38 container tests, hosted smoke and Dockerfile lint passed.
- Release 0.7.0 stopped before publishing because its changelog entry was missing; this release corrects the metadata.

### Host command extraction

- **Every container verb is spelled `dt-host`.** Engine 0.31.0 moved `setup` and the `container`/`image`
  verbs out of `dt` into the standalone `@dreamteamer/host` binary (`npm i -g @dreamteamer/host`), with
  the same words, volumes, labels and networks. The README, the package description, the Dockerfile,
  entrypoint, `dt-new`, `dt-local-egress` and origin-proxy comments and messages, and the tests say
  `dt-host start|open|stop|rm container`, `dt-host list images` and `dt-host setup`.
- **The local-mode 401 now reads ``Open this machine with `dt-host open container <name>`.``** The tests
  pin the new sentence.

## 0.6.1 — 2026-09-30 — attested

- **Release provenance a verifier can find.** Each pushed digest now also gets a GitHub build-provenance
  attestation (`actions/attest-build-provenance`), beside the cosign signature and the buildx provenance.
  `gh attestation verify oci://<ref> --repo dreamteamer/images` answered 404 for every earlier digest,
  0.5.0 and 0.6.0 included, so a deploy gate that requires it refused them all. Image content is
  unchanged from 0.6.0.

## 0.6.0 — 2026-09-28 — local mode behind a URL token; agents under trust

- **Local mode runs behind the origin proxy.** The proxy runs as `dtproxy` on 8080 (bound to
  `DT_LOCAL_BIND`, default `127.0.0.1`), with code-server on `127.0.0.1:8081`, the same two processes as
  hosted mode. Hosted mode is unchanged. A URL token (32 random bytes, base64url) is written on first start
  to `/home/node/.dt/url-token`, `root:dtproxy 0640`, where the proxy can read it and `node` cannot.
  `?tkn=<token>` sets an `HttpOnly; SameSite=Strict` cookie (`dt_local_<port>`) and redirects without the
  token. Without the cookie a request gets 401; a `Host` that is not `localhost`/`127.0.0.1`/`[::1]` gets
  403; `/healthz` stays open. A rotation takes effect on the next request (the proxy re-reads the file on an
  mtime change). `DT_LOCAL_AUTH=off` turns the check off and logs a warning. A bare URL opens the machine
  home in local mode too.
- **`dt-url-token show|rotate`** (root only) and **`/opt/dt-image/features`** (`url-token`): the engine
  reads the token through a root `docker exec` and opens the tokened URL.
- **`dt-new` refuses a root that is not a real mount** (`findmnt`: `overlay`, `tmpfs`, `ramfs`), naming the
  mount to add, in both modes.
- **Agents under trust (R2.7).** Claude Code: managed `enableAllProjectMcpServers: false`. Gemini CLI:
  folder trust pinned on in `/etc/gemini-cli/settings.json`. Codex needs no setting, since it ignores an
  untrusted project's `.codex/`. The README's "Agents and trust" table lists what no setting covers
  (`claude -p` in an untrusted folder, Antigravity).
- **Editor extensions pinned by version and sha256 (R2.8):** `anthropic.claude-code@2.1.281` (the CLI's
  version, per platform) and `dreamteamer.dreamteamer-vscode@0.18.2`. The `.vsix` files are downloaded from
  Open VSX and checked with `sha256sum -c`, like the code-server `.deb`. `devcontainer.metadata` is built
  from the same ARGs, so its versions cannot drift from the installed ones.
- **A volume mounted below `/workspaces`** (`dt start container` mounts one at `/workspaces/<name>`) is
  root-owned when it first comes up. The entrypoint now gives each such mount point to `node` (the mount
  point only, never its contents, never through a symlink); a read-only one is logged and left alone.
  Before this, the first start failed with `cp: Permission denied` and the container restarted in a loop.
- **Directories for system config are 0755:** `COPY --chmod=0644` had given `/etc/claude-code` and
  `/etc/gemini-cli` mode 0644, which `node` could not enter, so neither CLI could read its settings.
- **Security review fixes (local mode):**
  - `/healthz` answers only a local `Host` (403 otherwise), so a page on another site cannot probe
    localhost ports to learn that a machine is running. The engine's probe sends `127.0.0.1:<port>`.
  - **Isolation between local containers.** A bridge network per container does not isolate on Docker
    Desktop (measured on 29.3.1: from container A, B's container IP and `host.docker.internal:<B's
    published port>` both reached B). With `CAP_NET_ADMIN` the entrypoint now applies `dt-local-egress`, an
    nft policy for `node` only: no new connection to private, CGNAT or link-local IPv4, IPv6 ULA or
    link-local, or the host gateways resolved at start; DNS, loopback and the internet stay open.
    `DT_LOCAL_EGRESS=open` skips it, loudly. Without `CAP_NET_ADMIN` the start goes on with a warning.
  - A WebSocket upgrade, and every request that is not `GET`/`HEAD`, must carry an `Origin` naming exactly
    the request's `Host` (`http://localhost:<port>`), else 403. Every localhost port is the same site, so
    `SameSite=Strict` let a page on another local port send the cookie with its fetches and WebSockets
    (cross-site WebSocket hijacking). A `GET` without an `Origin` (a navigation) still passes. The check
    holds with `DT_LOCAL_AUTH=off` too.
- **`claude -p` under trust.** Measured on Claude Code 2.1.281: `claude -p` in an untrusted cloned
  repository ran its `.claude/settings.json` hooks and started its `.mcp.json` servers, logged in or not.
  `claude` on PATH is now a front for the npm binary: a non-interactive run in a folder that
  `~/.claude.json` does not trust gets `--setting-sources user`, which skips the folder's settings, hooks,
  `.mcp.json` servers, `CLAUDE.md` and skills (measured against a fixture; `--safe-mode` would also drop the
  user's own). Interactive sessions are unchanged. The Agent SDK and the editor extension do not go through
  the front (README, Agents and trust).
- **Breaking:** a non-root start (`-u node`) has no proxy and so no token, and now refuses
  `DT_LOCAL_BIND=0.0.0.0` unless `DT_LOCAL_AUTH=off`.

## 0.5.0 — 2026-09-26 — several workspaces per machine; the whole home persists

- **The whole home is on the volume** (hosted). `DT_PERSIST_HOME` is node's home itself, not a list of
  linked paths: measured on Fly, a machine's own filesystem is rebuilt on every stop/start, so layout 1
  lost `~/.git-credentials`, shell history, `~/.npmrc`, `~/.local/bin` and caches at every stop. Caches
  persist too (a typical web app's npm cache is ~370 MB and cuts an install from 19 s to 6 s). A
  layout-1 volume is migrated once; node's account home points at the volume, so every way in agrees.
  Claude Code's self-updater is off (`DISABLE_AUTOUPDATER=1`): the image pins its version.
- **Machine home and many workspaces** (hosted). A bare URL opens `/opt/dt-launcher`, whatever was open
  last; the built-in `dreamteamer machine` extension lists `/workspaces/*` and creates (template, clone,
  empty), opens (new tab / this tab), switches and deletes. `dt-new` is the terminal form: one name rule,
  reserved names refused, its own `FILES_FOLDER` (`/workspaces/.files/<name>`), a cloned repo never
  installed or compiled without `--install`.
- **Safer editor defaults:** workspace trust stays on, `task.allowAutomaticTasks: off`,
  `chat.disableAIFeatures: true`, `files.enableTrash: false`; git's `credential.helper store` (the file is
  in the persisted home), unless the person chose another.
- **`FILES_FOLDER` is no longer exported machine-wide:** each workspace's `.env` names its own.

## 0.4.1 — 2026-09-25

- **Hosted `FILES_FOLDER` is on the persistent volume** (Codex second review #4). With `DT_MODE=hosted`
  it is `/workspaces/files`: created and owned by `node`, written into a fresh workspace `.env`, and
  exported to code-server. An existing `.env` that still says `/files` gets that one value rewritten,
  and whatever is in `/files` is moved over once. A name that already exists on the volume is never
  overwritten; it stays put and is logged. Re-running changes nothing (`dt-files-folder`). Local mode
  is unchanged.

## 0.4.0 — 2026-09-25 — hardening

Security fixes from the 2026-09-25 review of the hosted service (findings IMG-1…IMG-7, S8-01/S8-02).

**Breaking for local use:** code-server now binds `127.0.0.1` inside the container unless
`DT_LOCAL_BIND=0.0.0.0` is set, so a Docker port mapping reaches it only with that flag. `dt start
container` does not pass it yet, which is why CI no longer pushes `:latest` (the engine resolves
`--template hq` to `:latest`, which stays on 0.3.3 until the engine sends the flag).

- **The origin proxy is not the workspace user's.** It runs as its own system user `dtproxy`, under
  `node --disable-sigusr1`, with a clean environment, no new privileges and no capabilities; the
  proxy, entrypoint and persist-home files are root-owned `0755`. PID 1 is a small root supervisor
  that `node` cannot signal; when the proxy or code-server exits it stops the other and exits
  non-zero, so the platform restarts the machine.
- **Hosted mode is explicit.** The public listener starts only with `DT_MODE=hosted`, a
  `DT_GATEWAY_PUBLIC_KEY` (or a `DT_GATEWAY_PUBLIC_KEYS` JSON array: an assertion from any key
  verifies) that imports, and `DT_ORIGIN_HOST`. Otherwise the container exits non-zero within a second
  and says why. Any other `DT_MODE` is refused.
- **Egress policy (hosted).** `/etc/dt/egress.nft`: SMTP and common mining/IRC ports, RFC 1918,
  CGNAT, link-local and Fly 6PN (`fdaa::/16`, except the resolver `fdaa::3:53`) are dropped; new
  connections are capped at 50/s (burst 100); a `tc tbf` caps egress at `DT_EGRESS_MBIT` (default
  20). Failure to apply it is fatal. `DT_EGRESS_POLICY=off` is the logged debugging opt-out.
- **No new privileges anywhere, no setuid.** Every process the entrypoint starts runs with
  `--no-new-privs`, an empty inheritable and bounding set; setuid/setgid bits are stripped at build.
- **`/healthz` tells the truth.** 200 only when code-server answers its own `/healthz` within 2 s,
  else 503.
- **Supply chain.** Base image pinned by digest; code-server from the release `.deb`, checked against
  the per-arch sha256 GitHub lists for the asset (no `curl | sh`); `SHELL` with `pipefail`;
  `hq-agents` builds `FROM` the hq digest the same CI run pushed.
- **CI.** Runs on pull requests (gates, build, built-image smoke, container tests; no push) and on
  `v*` tags (plus Trivy CRITICAL gate, push by digest, `digest.txt` artifact, SBOM, provenance, cosign
  keyless signature). Actions pinned by SHA, `permissions: {}` at the top and per-job least
  privilege, a timeout on every job; the leak gate counts matches and never prints them.

## 0.3.x

Hosted mode: the origin proxy, home persistence onto the workspace volume, chown-then-setpriv.

## 0.2.0

The `hq` and `hq-agents` templates.
