# First-use environment — user guide

You want to try `agentic-kit` the way a brand-new user would — on a clean OS,
with nothing pre-installed — without touching the tooling already on your
machine. This directory gives you that as one command, identically on macOS,
Windows (Docker Desktop / WSL2), and Linux.

**Default mount boundary:** the Compose file does not mount your host's
`~/.claude`, `~/.codex`, `~/.npmrc`, npm prefix, or any installed CLI. Package/configuration state is separate from the host install. The writable
`./artifacts` bind mount intentionally exports files to the host; ports, the Docker
daemon, and the host kernel remain shared infrastructure, not absolute isolation.
The persistent profile stores `/home/tester` in a Docker-managed volume.

Prefer an editor-attached environment (Codespaces, VS Code Dev Containers) over
a bare `docker compose` shell? The consumer dev container in
[`.devcontainer/consumer/`](../.devcontainer/consumer/devcontainer.json) builds
this same Dockerfile and installs the same published package — see
[docs/DEVCONTAINERS.md](../docs/DEVCONTAINERS.md) for the tradeoffs.

## Prerequisites

- Docker Desktop (macOS/Windows) or Docker Engine + Compose v2 (Linux).
- Nothing else — no Node, no npm, no agentic-kit on the host.

## Quick start

```bash
cd docker
docker compose up --build ak
```

On a newly created container, installation and setup can take several minutes
depending on the network and selected components. Restarting an existing
container reuses its writable layer: the entrypoint installs `ak` only when absent,
but runs setup again unless `AK_SKIP_SETUP=1`.

1. Ubuntu 26.04 + Node image builds (cached on later runs).
2. The container installs `@pacphi/agentic-kit@next` — the real first-install
   path, against whatever `next` currently is.
3. `ak setup --codex --opencode --yes` runs: installs ruflo, its compatible
   agent-browser executor, agentic-qe, and
   the claude/codex/opencode CLIs inside the container, wires everything.
4. The dashboard starts. **Watch the logs for a URL like:**

   ```text
   http://127.0.0.1:7431/#token=…
   ```

   Copy it into your **host** browser — it works verbatim. (The token is
   required for API data; the bare URL serves the page and its token gate.)

Ctrl-C stops the service but can leave its container for reuse. Run
`docker compose down` before the next `up` to recreate the ephemeral container.
The artifacts bind mount remains on the host.

## Interactive exploration instead of the dashboard

```bash
docker compose run --rm ak bash        # install + setup, then a shell
docker compose run --rm -e AK_SKIP_SETUP=1 ak bash   # skip setup, bare kit
```

Inside: a sandbox git repo at `~/work/sandbox` is the project ak operates on.
`ak status`, `ak sync --dry-run`, `ak x verify all` etc. all work there.

## Keeping state between runs

```bash
docker compose --profile persistent up ak-persistent
```

Same environment, but `/home/tester` lives in a named volume, so the
converged install (and the ~2 GB RuvNet Brain KB, if you enable it) survives
restarts. The package installation is reused, but setup still runs on each start unless
skipped; neither timing nor a converged status is guaranteed. Reset to factory:
`docker compose down --volumes`. Don't run both services at once — they
share the host port.

## Signing in to the AI CLIs (optional)

Installation, local configuration, and status inspection can run without an
inference login. Upstream installation/probe failures remain possible: the
entrypoint deliberately continues after a setup failure so its state can be
inspected. A started dashboard does not prove convergence. Model execution
requires the relevant host/provider authentication:

| CLI | Headless-container strategy |
| --- | --- |
| `claude` | `claude` login supports a paste-a-code flow in the terminal — run it inside `docker compose run --rm ak bash`. |
| `codex` | Check `codex login --help`; supported clients offer `codex login --device-auth` without a loopback callback. API-key login is a separate billing choice (`--with-api-key` reads stdin). A host environment variable is not passed through Compose unless explicitly forwarded with `-e`. |
| `opencode` | API keys via `opencode auth login` in the container shell. |

Never bind-mount host credential dirs into the container — if you must reuse
a login, `docker cp` the specific file in, deliberately.

## Common issues

- **Dashboard URL doesn't load** — use the exact printed URL (with `#token=`)
  and confirm the container is still up. Plain `docker run -p` without this
  compose file will *never* work: the dashboard binds loopback inside the
  container by design; the bridge in this setup is what makes it reachable.
- **Port 7431 busy on the host** — another dashboard (maybe your host ak!) is
  using it. Edit the left side of the port mapping in `compose.yaml`.
- **Apple Silicon vs Intel** — the image builds for your machine's native
  architecture automatically. A native ARM run is the right clean-room control
  for skills/plugins/MCP state. Chrome for Testing does not publish Linux ARM64
  builds, so agent-browser will report a compatible external Chromium/Chrome
  requirement there; use a native Linux x64 runner for the browser-payload
  smoke rather than treating emulated native-module failures as product evidence.
- **`artifacts/` permission errors (Linux)** — if Docker created the dir
  root-owned, `sudo chown "$USER" artifacts` from the `docker/` directory.

Maintainers: design rationale, knobs, upgrade-path testing, and CI notes are
in [MAINTAINER-GUIDE.md](MAINTAINER-GUIDE.md).
