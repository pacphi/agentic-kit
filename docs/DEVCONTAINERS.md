# Dev containers (Codespaces and compatible tools)

Two dev container configurations ship in `.devcontainer/`, for two different
audiences. Both work in GitHub Codespaces and in any tool that reads the
[dev container spec](https://containers.dev) (VS Code's Dev Containers
extension, JetBrains Gateway, `devcontainer` CLI).

| Config | Audience | What it gives you |
| --- | --- | --- |
| `.devcontainer/devcontainer.json` | Contributors to this repo | Node + pnpm, `pnpm install`, `ak`/`agentic-kit` linked to **this checkout** via `npm link` — edit source, run `ak` immediately, no reinstall |
| `.devcontainer/consumer/devcontainer.json` | Anyone who wants to try `ak` without cloning | Installs the **published** `@pacphi/agentic-kit` npm package into a disposable container, same image [docker/](../docker/) uses |

The top-level config is the default: "Create codespace on main" from the
GitHub UI uses it. To get the consumer config instead, use the "..." menu →
"New with options" → pick "agentic-kit (try the published release)" (or, with
the `devcontainer` CLI, pass `--config .devcontainer/consumer/devcontainer.json`).

## CI

[.github/workflows/devcontainers.yml](../.github/workflows/devcontainers.yml)
builds and smoke-tests both configs with the
[`devcontainers/ci`](https://github.com/devcontainers/ci) action — the same
`devcontainer` CLI Codespaces uses, not a hand-rolled approximation. A
`changes` job (via `dorny/paths-filter`) narrows each config's job to the
files it actually depends on, so, for example, a `docker/Dockerfile` edit
only rebuilds the consumer config, not the maintainer one:

| Job | Runs when | Proves |
| --- | --- | --- |
| `maintainer` | `.devcontainer/devcontainer.json`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `bin/**`, or `src/**` changes | `npm link` resolves `ak` to the checked-out source (version string match), then `pnpm run test:surface` |
| `consumer` | `.devcontainer/consumer/**` or `docker/Dockerfile` changes | The published package installs and `~/sandbox` is seeded |

Both jobs also run monthly (`23 6 1 * *`, no path filter — that's the point:
catch a base-image tag disappearing or a published-package install breaking
even when nothing here changed) and on demand via `workflow_dispatch`.

## Maintainer container

```bash
# GitHub UI: Code -> Codespaces -> Create codespace on main
# VS Code:   Dev Containers: Reopen in Container
```

`postCreateCommand` runs `corepack enable && pnpm install && npm link`.
`packageManager` in `package.json` pins the pnpm version, so corepack
resolves it without a separate install step. `npm link` registers the
`ak`/`agentic-kit` bins globally, pointing at `bin/agentic-kit.mjs` in the
container's copy of your checkout — so `ak status` (or any `ak` command)
exercises your live edits, not a published version.

Base image: `mcr.microsoft.com/devcontainers/typescript-node:22-bookworm`
(Node 22, the `engines` floor in `package.json`; CI additionally matrixes
Node 24 and 26 — see [.github/workflows/ci.yml](../.github/workflows/ci.yml)).
Features: GitHub CLI (`gh`) and Docker-outside-of-Docker, so you can drive
`gh pr`/`gh issue` and run the [docker/](../docker/) first-use environment
from inside the codespace.

Standard checks, unchanged from local development:

```bash
pnpm test          # unit suite + statusline/dashboard/admin tests
pnpm run check      # typecheck + lint + markdown lint + build + test
```

The `claude` CLI (required for `ak setup`) is deliberately **not**
auto-installed — it needs an interactive device-flow login tied to your own
Anthropic account, which doesn't belong in `postCreateCommand`. Install it
yourself when you want to exercise setup end to end:

```bash
npm install -g @anthropic-ai/claude-code
claude  # complete the login flow, then:
ak setup
```

## Consumer container ("try the published release")

Reuses [docker/Dockerfile](../docker/Dockerfile) — the same image the
[first-use docker-compose environment](../docker/USER-GUIDE.md) builds — so a
Codespace and a local `docker compose up` install the kit the same way, on
the same base. It does **not** build agentic-kit from source; the repo
checkout is present in the editor for reference only.

`postCreateCommand` runs
[`.devcontainer/consumer/postCreate.sh`](../.devcontainer/consumer/postCreate.sh):
it installs `@pacphi/agentic-kit@next` globally, then creates
`~/sandbox` — a throwaway git repo outside the mounted workspace — so
`ak setup`'s project-scope work (`ruflo init --full --force`, statusline,
project config) never touches the agentic-kit repo you're browsing.
When it finishes, the terminal shows the next commands:

```bash
cd ~/sandbox
ak setup --yes                        # drop --yes to see the interactive prompts
ak status
ak dashboard --no-open --port 7431    # open the printed #token URL via the Ports tab
```

Pin a specific release instead of `next` by editing `AK_DIST_TAG` in
`.devcontainer/consumer/devcontainer.json`'s `remoteEnv` before creating the
container, or after creation:

```bash
npm install -g @pacphi/agentic-kit@4.0.0-alpha.41 && ak sync
```

### The dashboard port

`ak dashboard` binds `127.0.0.1` only, by design
([ADR-0014](adr/0014-dashboard-auth-and-remediation.md)). Unlike a plain
`docker compose up` on your host — which needs the `socat` bridge documented
in [docker/MAINTAINER-GUIDE.md](../docker/MAINTAINER-GUIDE.md) to reach a
container-loopback listener — a dev container's port forwarding runs from
*inside* the container (VS Code Server attaches there directly), so
forwarding container port 7431 works without a bridge. Open the "Ports" tab
and use the forwarded URL, appending the `#token=...` fragment printed by
`ak dashboard`.

## Choosing between a dev container and `docker compose`

Both routes end up running the published package in a disposable container;
they exist for different workflows:

- **This directory's consumer config** — editor-attached (files, terminal,
  extensions, port forwarding through the VS Code UI), one container per
  Codespace/window, `ak setup` run by hand so you see the real prompts.
- **[docker/](../docker/)** — a scripted, fully non-interactive
  (`--yes`) environment meant for release smoke-testing, bisecting a
  regression across dist-tags, and upgrade-path testing; no editor
  attachment. See [docker/USER-GUIDE.md](../docker/USER-GUIDE.md) and
  [docker/MAINTAINER-GUIDE.md](../docker/MAINTAINER-GUIDE.md).

## Limitations

- `ak setup --codex --opencode` (the flag set a maintainer might reach for)
  offers the ~2 GB RuvNet Brain download; on a metered or slow Codespaces
  network, pass `--no-ruvnet-brain` or accept the default prompt to skip it.
- Codespaces machine types with less than the default disk/CPU may time out
  during `pnpm install` (maintainer container) or during `ak setup`
  (consumer container, if you opt into RuvNet Brain); pick a larger machine
  type from the Codespaces creation options if you hit this.
- Docker-outside-of-Docker in the maintainer container shares the host
  Codespace's Docker daemon; containers you start from `docker/` there are
  visible to (and stoppable from) the Codespace host, same as any
  Docker-outside-of-Docker setup.
