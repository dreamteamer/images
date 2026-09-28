# dreamteamer images

The template images `dt start container <name> --template <t>` runs. Public, built by CI on a `v*`
tag, pushed to `ghcr.io/dreamteamer/<template>` for amd64 and arm64.

| template | what it carries |
|---|---|
| `hq` | a dreamteamer workspace with the hq modules (users · contacts · meetings · projects · assets), code-server as the editor, Claude Code as CLI and extension, the dreamteamer VS Code extension |
| `hq-agents` | `hq` plus OpenAI Codex, Google Gemini CLI and Google Antigravity CLI (`agy`) |

```bash
npm i -g dreamteamer                              # the engine — also puts `dt` on PATH
dt setup                                          # checks Docker, writes ~/.dreamteamer/.env
dt start container hq-dana --template hq          # → http://localhost:8100/?tkn=… (the machine home)
dt start container hq-dana --template hq --repo https://github.com/example/hq-dana.git   # join an existing workspace instead
dt open container hq-dana --vscode                # attach the host's VS Code (Dev Containers) to the same container
```

## what a template is

An image carrying three labels — `dreamteamer.template`, `dreamteamer.ports`, `dreamteamer.modules` —
and a `devcontainer.metadata` label naming the extensions the host's VS Code installs on attach. `dt
list images` shows the templates present; `--template hq` resolves to `ghcr.io/dreamteamer/hq:latest`
(which CI has not moved since 0.4.0)
(`DT_REGISTRY` and `DT_TEMPLATE_TAG` in `~/.dreamteamer/.env`), or to `DT_IMAGE_hq=<ref>` when pinned.

## where things live in a container

| path | what | volume |
|---|---|---|
| `/workspaces/<name>` | the workspace — a git repo, the pinned engine under its `node_modules`, the compiled runtime | `dreamteamer-<name>-workspace` |
| `/home/node` | the person's logins (Claude, Codex, Gemini, Antigravity), editor settings | `dreamteamer-<name>-home` |
| `/files` | `FILES_FOLDER` — the files records point at | `dreamteamer-<name>-files` |
| `/opt/code-server/extensions` | the editor extensions, baked | image |

`--mount <host-path|volume>:<container-path>[:ro]` adds more. Plain `dt rm container` keeps all three
volumes; `--force` removes them.

## two editors, one container

- **code-server** in the container, at the loopback URL `dt start` prints: zero install on the host.
- **The host's VS Code, attached** (`dt open container <name> --vscode`): the Dev Containers extension
  starts a VS Code Server inside the container and installs the extensions from `devcontainer.metadata`
  into it. It is a second extension host, over the same files, so the Claude Code extension is
  installed once per editor. Both editors need a login inside the container.

## nothing personal, nothing secret

These images are public. No token, key, `.env` value, mail address or host path is ever baked in;
every login happens inside the container, once, into the home volume. `npm test` pins that promise —
credential-shaped `ENV`/`ARG`, copied `.env`, host paths, addresses, private names — and CI refuses to
publish on a red test. Credentials a workspace needs at runtime go in its own `.env`, which is
gitignored by `dreamteamer init`.

## versions

One tag, one version of everything: the engine (`DT_VERSION`), the module bundle (`EXT_VERSION`),
Claude Code, code-server and, for `hq-agents`, Codex and Gemini are pinned as `ARG`s in each
Dockerfile. `hq-agents` is built `FROM ghcr.io/dreamteamer/hq:<the same tag>`.

Apache-2.0.

## Local mode (the default)

With `DT_MODE` unset (or `local`), the container runs the same two processes as hosted mode:
code-server on `127.0.0.1:8081`, and `dt-origin-proxy` (as its own user `dtproxy`) on port 8080 in
front of it, bound to `127.0.0.1` unless `DT_LOCAL_BIND=0.0.0.0` — which a Docker port mapping needs,
and which `dt start container` passes. The host side of the mapping stays on loopback. A bare URL opens
the machine home (`/opt/dt-launcher`), as in hosted mode.

The proxy asks for a **URL token**, so another program or web page on the same computer cannot open the
editor just by knowing the port:

- On first start the entrypoint (root) writes 32 random bytes, base64url, to `/home/node/.dt/url-token`
  in the home volume, so it survives restarts. The file is `root:dtproxy 0640` in a `root:dtproxy 0750`
  directory: the proxy reads it, the workspace user `node` cannot.
- `http://localhost:<port>/?tkn=<token>` (any path) sets an `HttpOnly; SameSite=Strict` cookie and
  redirects to the same URL without `tkn`. Every other request, WebSocket upgrades included, needs that
  cookie, else 401 (`Open this machine with dt open container <name>`). The cookie is named
  `dt_local_<port>`: cookies are not port-scoped, so two machines on `localhost` keep separate ones.
- The `Host` header must be `localhost`, `127.0.0.1` or `[::1]` (any port), else 403: a DNS-rebinding page
  cannot reach it through a name of its own.
- A WebSocket upgrade, and every request that is not `GET`/`HEAD`, must carry an `Origin` naming exactly
  the `Host` (`http://localhost:<port>`), else 403. Every localhost port is the same site, so the
  `SameSite=Strict` cookie alone would ride along with a page on another local port.
- `/healthz` needs no token but does need a local `Host`, and returns only 200 or 503.
- `dt-url-token show` prints the token; `dt-url-token rotate` writes a new one atomically and prints it.
  Both run only as root (`docker exec -u root <container> dt-url-token show`). The proxy re-reads the
  file when its mtime changes, so after a rotation every old cookie gets 401 on its next request.
- `/opt/dt-image/features` lists `url-token`, which is how the engine knows to fetch the token and open
  the tokened URL. An image without that file gets the plain URL.
- `DT_LOCAL_AUTH=off` turns the token check off (the Host check stays) and logs a warning. It exists for
  debugging.

```bash
docker run -d -p 127.0.0.1:8100:8080 -e DT_LOCAL_BIND=0.0.0.0 --name hq-dana ghcr.io/dreamteamer/hq:0.6.0
docker exec -u root hq-dana dt-url-token show     # → open http://localhost:8100/?tkn=<that>
```

**Isolation between containers.** A bridge network per container does not isolate on Docker Desktop:
another container's IP, and its published port through `host.docker.internal`, both answer. So with
`CAP_NET_ADMIN` (which `dt start container` adds) the entrypoint applies `dt-local-egress`, an nft policy
for the workspace user `node` only: no new connection to private, CGNAT or link-local IPv4 (`10/8`,
`172.16/12`, `192.168/16`, `100.64/10`, `169.254/16`), IPv6 ULA or link-local, or the host gateways
(`host.docker.internal`, `gateway.docker.internal` and the default gateway, resolved at start). The
resolvers in `/etc/resolv.conf` on port 53, loopback and the internet stay open. Root and `dtproxy` are not
filtered; the proxy only listens.

- `DT_LOCAL_EGRESS=open` skips the policy and logs a warning. Use it to reach something on this computer or
  its LAN, such as a database on the laptop or a git server on a private address.
- Without `CAP_NET_ADMIN` (an engine older than 0.6's), the container starts anyway and logs that local
  isolation is off. Hosted mode still refuses to start without it.

Started as a non-root user (`docker run -u node`), there is no supervisor and no proxy, so there is no
token: the container serves code-server on loopback only, and refuses `DT_LOCAL_BIND=0.0.0.0` unless
`DT_LOCAL_AUTH=off`.

`dt-new` (both modes) refuses to create a workspace under a root that is not a real mount (`findmnt`:
`overlay`, `tmpfs` and `ramfs` are refused), because a workspace on the container's own layer is deleted
with the container. The message names the mount to add (`--mount <volume>:/workspaces`).

## Agents and trust

A cloned repository can carry hooks and MCP servers that run code. Each agent CLI is set up image-wide so
that, where the CLI offers a setting for it, the repository's hooks and servers wait until the person
trusts the folder. Where a CLI has no such setting, this section says so.

| CLI | what the image sets | what that covers | gap |
|---|---|---|---|
| Claude Code (`hq`, `hq-agents`) | `/etc/claude-code/managed-settings.json`: `enableAllProjectMcpServers: false`; `claude` on PATH is a front (`/usr/local/bin/claude`) for the npm binary | Managed settings sit above every user and project file. In an interactive session a folder's hooks, `.mcp.json` servers and allow rules wait for the trust dialog, and a repository cannot approve its own servers. The managed `false` also stops a user-level `true` from approving every repository's servers. `claude -p` never shows the dialog and, measured on 2.1.281, runs an untrusted folder's hooks and `.mcp.json` servers anyway. So for a non-interactive run (`-p`/`--print`, or stdout not a terminal) in a folder with no `hasTrustDialogAccepted` in `~/.claude.json` (for it, or an ancestor up to its repository root), the front adds `--setting-sources user`. That skips the folder's `.claude/settings*.json` (hooks, permissions, plugins), its `.mcp.json` servers, and also its `CLAUDE.md` and skills; user settings, the user's MCP servers and managed settings still apply. The front says so on stderr. | Only `claude` on PATH goes through the front. The Agent SDK, and the Claude Code extension in the editor, start their own copy of the binary: an SDK session in an untrusted folder still runs its hooks and servers. A workspace made from the template is not pre-trusted, so `claude -p` in it skips its `CLAUDE.md` and skills until it is trusted once interactively. An explicit `--setting-sources` on the command line wins. `allowManagedHooksOnly` and `allowManagedMcpServersOnly` would block project hooks and servers even after trust, so the image leaves both unset. Trusting a parent folder also trusts plain subfolders, but not git repositories nested inside it (each `/workspaces/<name>` made from the template is its own repository). |
| Codex (`hq-agents`) | nothing: no switch is needed | Codex loads a project's `.codex/` layers (its `config.toml` and the MCP servers in it, hooks, rules) only once the project is trusted. The image marks no path trusted. | none known |
| Gemini CLI (`hq-agents`) | `/etc/gemini-cli/settings.json`: `security.folderTrust.enabled: true` | The system settings file overrides user and project settings. In an untrusted folder `.gemini/settings.json` (and the hooks and MCP servers in it), `.env`, custom commands and tool auto-accept are ignored. A headless run in an untrusted folder exits instead of trusting it. | `--skip-trust` or `GEMINI_CLI_TRUST_WORKSPACE=true` trusts a folder for that run; the image sets neither. |
| Antigravity CLI (`agy`, `hq-agents`) | nothing | It asks whether to trust a folder before it opens it. | Antigravity documents no image-wide setting that holds a folder's hooks or MCP servers until trust. |

## Hosted mode (behind the dreamteamer gateway)

The same `hq` image serves the hosted service when the platform sets:

- `DT_MODE=hosted` — required; nothing public listens without it.
- `DT_GATEWAY_PUBLIC_KEY` — the gateway's Ed25519 public key (JWK `x`), and/or
  `DT_GATEWAY_PUBLIC_KEYS`, a JSON array of them for rotation (an assertion from any key verifies).
  Without a key that imports the container exits non-zero within a second and never listens.
- `DT_ORIGIN_HOST` — required; the audience every assertion must name.
- `DT_PERSIST_HOME` — a directory on the workspace volume that becomes node's WHOLE home (layout 2,
  0.5.0): logins, editor state, git credentials, shell history, caches. A Fly machine's own filesystem is
  rebuilt on every stop/start, so nothing else in `~` would survive. A layout-1 volume is migrated once.

Several workspaces per machine (hosted, 0.5.0): a bare machine URL opens the **machine home**
(`/opt/dt-launcher`, the "This machine" view): every folder under `/workspaces`, **New workspace from
template**, **Clone a repository**, **Empty folder**, open in a new tab or this one, and a status-bar
switcher in every tab. Each workspace is its own tab (`?folder=/workspaces/<name>`), so it gets its own
`CLAUDE.md`, skills and chat history. `dt-new <name> [--empty | --clone <url> [--install]]` does the same
from a terminal. All workspaces on a machine share one home and one set of logins; separation between
clients or people is a second machine. Workspace trust stays on: a clone opens in Restricted Mode, and a
cloned dreamteamer repo is installed and compiled only when asked (that runs code the repo chose).
- `DT_EGRESS_MBIT` — egress bandwidth cap, default 20. `DT_EGRESS_POLICY=off` skips the egress policy,
  with a loud log line; debugging only.

What runs, and as whom:

| process | user | notes |
|---|---|---|
| `dt-entrypoint` (PID 1) | root | applies the egress policy, chowns the two mount points, supervises; the workspace user cannot signal it |
| `dt-origin-proxy` on `:8080` | `dtproxy` | `node --disable-sigusr1`, clean env, no new privileges, no capabilities; refuses every request or WebSocket upgrade without a valid `x-dreamteamer-gateway` assertion (401); `/healthz` is 200 only while code-server answers |
| code-server on `127.0.0.1:8081` | `node` | no new privileges, no capabilities; every terminal inherits that |

The egress policy (`/etc/dt/egress.nft`, plus a `tc tbf` cap) needs `CAP_NET_ADMIN` in the root phase;
without it a hosted container exits non-zero. A Fly Machine's init runs the entrypoint as root inside
the microVM. If either child exits, the supervisor stops the other and exits non-zero so the platform
restarts the machine.

Test a built image with `npm run test:image` (`HQ_IMAGE=<ref>`, default `hq:sec`): the container tests and
`tests/smoke.sh`, which CI runs on every pull request and tag.
