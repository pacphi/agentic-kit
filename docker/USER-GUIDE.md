# First-use environment — user guide

You want to try `agentic-kit` the way a brand-new user would — on a clean OS,
with nothing pre-installed — without touching the tooling already on your
machine. This directory gives you that as one command, identically on macOS,
Windows (Docker Desktop / WSL2), and Linux.

**Isolation promise:** the container never mounts or reads your host's
`~/.claude`, `~/.codex`, `~/.npmrc`, npm prefix, or any installed CLI. A host
with any version of agentic-kit installed cannot conflict with these
containers, and the containers cannot alter your host install. Persistent
state lives only in Docker-managed named volumes; the single bind mount is
`./artifacts` inside this directory.

## Prerequisites

- Docker Desktop (macOS/Windows) or Docker Engine + Compose v2 (Linux).
- Nothing else — no Node, no npm, no agentic-kit on the host.

## Quick start

```bash
cd docker
docker compose up --build ak
```

What happens, in order (10–15 minutes on first run, network-dependent):

1. Ubuntu 26.04 + Node image builds (cached on later runs).
2. The container installs `@pacphi/agentic-kit@next` — the real first-install
   path, against whatever `next` currently is.
3. `ak setup --codex --opencode --yes` runs: installs ruflo, agentic-qe, and
   the claude/codex/opencode CLIs inside the container, wires everything.
4. The dashboard starts. **Watch the logs for a URL like:**

   ```text
   http://127.0.0.1:7431/#token=…
   ```

   Copy it into your **host** browser — it works verbatim. (The token is
   required; the bare URL without the `#token` fragment is turned away.)

Stop with Ctrl-C (or `docker compose down`). Because this service keeps no
volumes, the next `up` is a genuine first-use again.

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
restarts. Reset to factory: `docker compose down --volumes`. Don't run both
services at once — they share the host port.

## Signing in to the AI CLIs (optional)

Everything infrastructural — setup, status, sync, dashboard, statusline —
works with **no** AI login. This is verified, not assumed: a zero-credential
container completes `ak setup --codex --opencode --yes` (including both MCP
bridge registrations, `ruflo init`/memory/swarm/daemon with a verified memory
write, and `aqe init --with-codex`), and a follow-up `ak sync` reports
**converged — no failing subsystems**. You only need auth to actually drive
sessions:

| CLI | Headless-container strategy |
| --- | --- |
| `claude` | `claude` login supports a paste-a-code flow in the terminal — run it inside `docker compose run --rm ak bash`. |
| `codex` | Easiest: `export OPENAI_API_KEY=…` before starting. The OAuth flow's `localhost:1455` callback can't cross the container boundary without extra bridging. |
| `opencode` | API keys via `opencode auth login` in the container shell. |

Never bind-mount host credential dirs into the container — if you must reuse
a login, `docker cp` the specific file in, deliberately.

## Common issues

- **`⚠ claude mcp add failed` during first setup** — an ordering artifact on
  truly bare machines, not an auth problem: machine-level MCP registration
  runs before setup's own hosts step has installed the `claude` CLI. The next
  `ak sync` (or `ak x mcp pick`) registers it cleanly, still without any
  login. The same ordering can leave a couple of guidance blocks "drifted" on
  first status; the same sync heals those too.
- **Dashboard URL doesn't load** — use the exact printed URL (with `#token=`)
  and confirm the container is still up. Plain `docker run -p` without this
  compose file will *never* work: the dashboard binds loopback inside the
  container by design; the bridge in this setup is what makes it reachable.
- **Port 7431 busy on the host** — another dashboard (maybe your host ak!) is
  using it. Edit the left side of the port mapping in `compose.yaml`.
- **Apple Silicon vs Intel** — the image builds for your machine's native
  architecture automatically. Don't force `--platform linux/amd64` on an
  arm64 Mac; emulation breaks native Node modules and produces false
  failures.
- **`artifacts/` permission errors (Linux)** — if Docker created the dir
  root-owned, `sudo chown $USER docker/artifacts`.

Maintainers: design rationale, knobs, upgrade-path testing, and CI notes are
in [MAINTAINER-GUIDE.md](MAINTAINER-GUIDE.md).
