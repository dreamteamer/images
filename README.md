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
