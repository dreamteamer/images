# Changelog

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
- **Editor extensions pinned by version (R2.8):** `anthropic.claude-code@2.1.281` (the CLI's version) and
  `dreamteamer.dreamteamer-vscode@0.18.2`, in code-server and in `devcontainer.metadata`.
- **A volume mounted below `/workspaces`** (`dt start container` mounts one at `/workspaces/<name>`) is
  root-owned when it first comes up. The entrypoint now gives each such mount point to `node` (the mount
  point only, never its contents, never through a symlink); a read-only one is logged and left alone.
  Before this, the first start failed with `cp: Permission denied` and the container restarted in a loop.
- **Directories for system config are 0755:** `COPY --chmod=0644` had given `/etc/claude-code` and
  `/etc/gemini-cli` mode 0644, which `node` could not enter, so neither CLI could read its settings.
- **Security review fixes (local mode):**
  - `/healthz` answers only a local `Host` (403 otherwise), so a page on another site cannot probe
    localhost ports to learn that a machine is running. The engine's probe sends `127.0.0.1:<port>`.
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
