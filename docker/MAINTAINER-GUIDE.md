# First-use environment — maintainer guide

Audience: agentic-kit maintainers using this environment to validate releases,
reproduce first-install bugs, and test upgrade paths. For "how do I run it,"
see [USER-GUIDE.md](USER-GUIDE.md); this page is the *why* and the knobs.

## Design decisions

- **The kit is installed at container start, not image build.** The
  entrypoint runs `npm i -g @pacphi/agentic-kit@$AK_DIST_TAG` on first boot,
  so every ephemeral run exercises the true install path against the live
  dist-tag — publishing a new alpha requires **no image rebuild** to be
  covered. The image layers (apt, NodeSource) are pure cache.
- **Non-root `tester` user, user-owned npm prefix.** The claude CLI refuses
  permission-bypass modes as root, and a no-sudo `npm -g` is the realistic
  first-use shape. `NPM_CONFIG_PREFIX=/home/tester/.npm-global` is set in the
  image — the container's global root is always known and self-contained.
- **The dashboard needs a bridge, not a port mapping.** `ak dashboard`
  listens on a loopback literal with a per-session token
  ([ADR-0014](../docs/adr/0014-dashboard-auth-and-remediation.md)); Docker
  port publishing can't reach a container-loopback listener. The entrypoint
  runs `socat` (container `0.0.0.0:7432` → `127.0.0.1:7431`) and compose maps
  it back to **host-loopback only** (`127.0.0.1:7431:7432`) — the security
  envelope (local browsers + token) is preserved, and the printed `#token`
  URL works verbatim on the host because the host port mirrors 7431. Do not
  "fix" this by adding a bind flag to the dashboard; the loopback literal is
  deliberate.
- **Isolation is absolute, both directions.** No host path is mounted except
  `./artifacts`. Named volumes carry all persistent state, namespaced
  `agentic-kit-firstuse_*`. A host agentic-kit install (any version, any
  prefix) and this environment cannot see each other. Keep it that way when
  extending: auth material enters via `docker cp` or env, never a mount.
- **`--yes` in the default setup flags.** Compose `up` has no interactive
  stdin; `ak setup` prompts would either hang (TTY allocated) or silently
  default (no TTY). `--yes` makes the accept-defaults choice explicit and
  deterministic. Interactive prompt testing: `docker compose run --rm -e
  AK_SKIP_SETUP=1 ak bash`, then run setup by hand.

## Knobs

| Knob | Default | Purpose |
| --- | --- | --- |
| `AK_DIST_TAG` (env) | `next` | Which dist-tag/version the entrypoint installs — pin an exact alpha to bisect a regression |
| `AK_INSTALL_SPEC` (env) | `@pacphi/agentic-kit@$AK_DIST_TAG` | Full npm spec override — test an unpublished build: `npm pack` the checkout, drop the tarball in `./artifacts`, set `AK_INSTALL_SPEC=/artifacts/<name>.tgz` |
| `AK_SETUP_FLAGS` (env) | `--codex --opencode --yes` | Full setup surface; add `--no-ruvnet-brain` to skip the ~2 GB KB, `--minimal` for the smallest footprint |
| `AK_SKIP_SETUP` (env) | `0` | `1` = install the kit but stop before setup (bare-kit debugging) |
| `AK_SYNC_PASSES` (env) | `0` | Run this many post-setup `ak sync --yes` passes; use `2` to prove convergence/idempotence |
| `AK_ARTIFACT_PREFIX` (env) | `first-use` | Safe filename prefix for status/system evidence written under `/artifacts` |
| `AK_DASHBOARD_PORT` / `AK_BRIDGE_PORT` (env) | `7431` / `7432` | Only needed if you change the compose port mapping too |
| `UBUNTU_VERSION` (build arg) | `26.04` | OS matrix testing |
| `NODE_MAJOR` (build arg) | `24` | Node matrix testing (kit engines: `>=22`) |

## Standard maintainer workflows

```bash
# Validate the current `next` end-to-end (the release smoke)
docker compose up --build ak

# Bisect: does alpha.31 also fail?
AK_DIST_TAG=4.0.0-alpha.31 docker compose up ak

# Upgrade-path test: converge on alpha.N, then sync to alpha.N+1
docker compose --profile persistent run --rm -e AK_DIST_TAG=4.0.0-alpha.32 ak-persistent bash
#   … let setup converge, exit …
docker compose --profile persistent run --rm ak-persistent bash
#   inside: npm i -g @pacphi/agentic-kit@next && ak sync

# Architecture matrix (CI or a beefy host)
docker buildx build --platform linux/amd64,linux/arm64 .
```

The Linux ARM64 image is valid for setup convergence and capability-catalog
comparison, but Chrome for Testing has no ARM64 payload. Expect browser readiness
to remain degraded with an explicit external Chromium/Chrome requirement; prove
the downloadable browser path on a native Linux x64 runner.

## Regression artifacts

Each run that completes setup writes `artifacts/first-use-status.json` and
`artifacts/first-use-system.json` — `ak status --json` plus the deep, content-free
install/catalogue snapshot seen by a brand-new machine. Diff them across releases to
catch first-use regressions (a subsystem newly failing on clean install is
exactly the class of bug maintainers' converged machines can't see). This is
the seam for a future nightly job: GitHub Actions runs this same compose file
natively on Linux; compare the JSON against the previous run and alert on new
`fail` rows.

For an upgrade-cruft control, pack the current checkout, run two convergence
passes in an ephemeral container, and compare its catalogue with the host:

```bash
npm pack --pack-destination docker/artifacts
AK_INSTALL_SPEC=/artifacts/pacphi-agentic-kit-<version>.tgz \
AK_SYNC_PASSES=2 AK_ARTIFACT_PREFIX=clean-branch \
  docker compose -f docker/compose.yaml run --rm ak true
ak system --deep --json > docker/artifacts/upgraded-host-system.json
```

The difference is classification evidence, not deletion authority. A host-only
skill/plugin/MCP/package remains untouched unless Agentic Kit can prove an exact
receipt-owned path and unchanged digest.

The deep catalog includes user/plugin skill surfaces and each on-disk project's
Claude `.claude/skills` and Codex `.agents/skills` surfaces. This distinction is
load-bearing when diagnosing a Codex context warning caused by project history.

## Maintenance duties

- Keep `AK_SETUP_FLAGS` in step with `ak setup`'s option surface
  (`src/commands/setup.mjs`) — a renamed flag here fails loudly at entrypoint.
- Bump `NODE_MAJOR` when the kit's `engines` floor moves; bump
  `UBUNTU_VERSION` on new LTS. Both are build args — CI can matrix them
  without file edits.
- The healthcheck allows `start_period: 600s` because install + full setup
  precede the dashboard; if setup grows meaningfully slower, raise it rather
  than letting orchestrators flap the container.
- `docker/*.md` is deliberately outside the repo's markdownlint globs
  (`.markdownlint-cli2.jsonc` covers `docs/**`); keep these guides tidy by
  hand.
