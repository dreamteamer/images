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
dt start container hq-dana --template hq          # → http://localhost:8100/?folder=/workspaces/hq-dana
dt start container hq-dana --template hq --repo https://github.com/example/hq-dana.git   # join an existing workspace instead
dt open container hq-dana --vscode                # attach the host's VS Code (Dev Containers) to the same container
```

## what a template is

An image carrying three labels — `dreamteamer.template`, `dreamteamer.ports`, `dreamteamer.modules` —
and a `devcontainer.metadata` label naming the extensions the host's VS Code installs on attach. `dt
list images` shows the templates present; `--template hq` resolves to `ghcr.io/dreamteamer/hq:latest`
(which CI no longer moves since 0.4.0, see Local mode)
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

With `DT_MODE` unset (or `local`), code-server serves port 8080 with no auth of its own, bound to
`127.0.0.1` inside the container. A Docker port mapping needs it on `0.0.0.0`, so a local run passes
the flag explicitly — the host side of the mapping stays on loopback:

```bash
docker run -d -p 127.0.0.1:8100:8080 -e DT_LOCAL_BIND=0.0.0.0 -e DT_WORKSPACE=hq-dana ghcr.io/dreamteamer/hq:0.4.0
```

⚠ `dt start container` does not pass `DT_LOCAL_BIND` yet, so it keeps resolving `:latest`, which CI
no longer moves; `:latest` follows again once the engine sends the flag.

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
