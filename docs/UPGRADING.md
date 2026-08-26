# Upgrading `ak` & adopting new capabilities

New `ak` features almost always ship **opt-in**. That means moving your machine to the
latest capability is *two* motions, not one: get the newer code, then turn the feature on.
This page exists because those two are easy to conflate — and `ak sync`, despite its name,
only does the first.

## The one rule

> **`ak sync` converges to the choices already recorded in `kit.json`.** It updates the
> `ak` binary and heals whatever has drifted, but it **never makes a new opt-in decision for
> you.** Adopting a capability that shipped after your install = run that capability's own
> opt-in command.

So a feature can be *installed* (the code is on disk) without being *enabled* (your
`kit.json` never asked for it). `ak sync` will faithfully keep re-applying claude-only if
that's what you recorded — the same way it won't pick an LLM provider or exclude an MCP
family on your behalf.

## `sync` vs `setup` vs `host pick`

| Command              | What it's for                                   | Changes your `kit.json` choices? |
| -------------------- | ----------------------------------------------- | -------------------------------- |
| `ak sync`            | update the binary + heal to your recorded state | **no** — converges, never decides |
| `ak host pick` | opt into or retune execution hosts and host routing | **yes** — this is the switch |
| `ak x statusline codex native\|extended` | opt into a user-wide Codex status-line preset | **yes** — records the preset |
| `ak setup`           | first-time bootstrap of absent tooling          | only via explicit flags (`--codex`, `--opencode`, `--primary-host`, `--with-deja-vu`, `--no-deja-vu`) |

## Installation method and self-update scope

The package installation method and the command's operational scope are
independent. A project-local or `npm exec` copy of `ak` can still upgrade global
Ruflo/AQE/host packages, write current-user configuration, and heal the current
project. Conversely, globally installing the runner does not initialize any
repository until a project-scoped command is run there.

`ak sync` always evaluates the version of the running package. If that version is
outdated, its final self-update step runs `npm install -g` for the exact version it
just resolved. Consequently, a sync launched from a local dependency, Git checkout,
or one-shot npm cache can create or replace a global agentic-kit installation. Use
`ak sync --no-upgrade` when a lockfile, tarball, or checkout must remain the only
version authority.

See [Installation and scope](INSTALLATION.md) for global, local, one-shot,
tarball, Git, source-link, multi-user, and CI guidance.

## Running `ak sync` while sessions are live

`ak sync` is plan-based: on a converged machine it prints "nothing to do" and touches
nothing. The blast radius comes entirely from what's in the plan — and the widest heals are
the ones a **`versions`** row triggers. If you have Claude Code, Codex, or OpenCode sessions
open in other terminals, here is what can actually reach them, worst first:

1. **All ruflo daemons stop, machine-wide.** Before any package upgrade, sync runs
   `ruflo daemon stop --all` (upgrades wipe native modules, so daemons must not hold them) —
   and upstream defines that as *every* workspace and worktree
   ([ruflo #2661](https://github.com/ruvnet/ruflo/issues/2661)), not just the current
   project. In-flight background work in other sessions is lost; daemons restart lazily on
   the next ruflo command in each project, so the damage is interrupted work, not lasting
   state.
2. **The npm swap window.** While `npm install -g` replaces `ruflo` / `agentic-qe` (and
   npm-managed `claude` / `codex` / `opencode` CLIs), the global tree is mid-replacement for
   up to ~30s+. Live sessions touch that tree constantly — hooks on every edit, statusline
   ticks every few seconds, MCP tool spawns — and an invocation landing in the window can
   fail once. Statusline failures degrade gracefully (the command chains fallbacks); hook
   failures surface as one-off errors. A live session's `claude-flow` MCP server keeps
   running its already-loaded code but sees a mixed-version tree for anything loaded
   lazily afterward — if its tools start misbehaving, restart that session.
3. **Footer wipes get armed in your *other* projects.** A ruflo upgrade makes every
   project's `.claude/helpers/.helpers-version` stamp lag. Sync heals the **current**
   project (refresh-then-inject); in other open projects the first ruflo command — in
   practice a hook — pristine-copies `statusline.cjs` and wipes the kit footer there.
   Cosmetic; `ak sync` in that project restores it, and `ak status` flags the armed state
   before it fires.
4. **A narrow race on `~/.claude.json`.** MCP registration shells out to
   `claude mcp add -s user`, which rewrites the same file live Claude sessions persist
   state into — last writer wins. Rare, but real; re-run `ak sync` if the registration
   doesn't stick.
5. **A stale npx-cache env can vanish mid-use.** The prune only removes envs strictly
   older than the installed baseline; a statusline/hook fallback executing from one at that
   moment fails once, then npx re-fetches.

What does **not** break, by design: running binaries keep executing their old code
(replaced files don't affect a running process's open inodes). Agentic-kit's managed
settings and guidance writers are atomic and fail closed when the one-time backup cannot
be created or validated. Settings env keys, `~/.codex/config.toml` edits (Ruflo/AQE MCP,
`[tui]` status line), OpenCode wiring, `.agentic-qe/llm-config.json`, and the managed
guidance blocks are all **read at session start** — a live session simply doesn't see
them until its next launch. The kit's own self-update runs last and applies from the next
`ak` invocation.

> [!TIP]
> If other sessions are mid-task: `ak sync --dry-run` first. No `versions` row → the plan
> is local heals and config convergence; run it freely. A `versions` row → either let the
> other sessions reach a stopping point, or run `ak sync --no-upgrade` now (heals only —
> skips the daemon stop and the npm swaps entirely) and do the full sync later. The armed
> footer wipe in other open projects follows from the upgrade itself, not from sync — expect
> it after any ruflo upgrade regardless of how you apply it.

## 4.0 GA surface migration

Version 4.0 removes the pre-GA compatibility surfaces in one direction:

- Replace `ak dual` with `ak run`. The stable executor applies `--escalate` per failed worker and
  records the attempt trail. The removed `--parallel` switch has no direct replacement because
  `ak run` is concurrent by default; use `--max-concurrent 1` for sequential execution.
  Templates, repeatable `--route` overrides, `--timeout`, and `--json` continue on `ak run`.
- Replace `ak provider` with `ak host`, and replace `ak x provider` with `ak x host`. Removed
  commands fail as unknown commands; provider bindings remain a separate domain concept.
- On first load, host enablement moves from `providers.hosts` to `integrations.hosts`,
  `providers.primaryHost` moves to `routing.primaryHost`, and `providers.dualRouting` moves to
  `routing.routes`. Within each route, `source` becomes `provenance` and `escalate` becomes
  `escalation`. `providers.bindings` merges without loss into `integrations.bindings`;
  conflicting binding ids stop with a readable configuration error.
- Adapter ownership markers such as Codex and OpenCode MCP/catalog fields move from `providers`
  to `integrations.ownership`. A successful write records versioned `routing` and `integrations`
  envelopes and removes the old fields; later loads use only the canonical shape.
- Older alphas could install the global `@claude-flow/codex` package and run
  `ruflo init --dual --force`. Those releases stored no ownership receipt, so GA cannot safely
  uninstall the package or delete generated project agents automatically. If you installed the
  package only for the removed executor, run `npm uninstall -g @claude-flow/codex`; review any
  generated project agent files before removing them.

The migration preserves user-pinned hosts, models, escalation order, and provenance. Review the
result with `ak host status`, then use `ak run --dry-run` to inspect the materialized plan.
`--json` emits machine-readable output while executing; combine it with `--dry-run` when
execution must not start.

A **host** runs the work; a **provider** serves inference. A binding can connect one provider to
several hosts through separate native configuration **projections**, while **observability**
sources establish facts with observed, configured, inferred, or unknown provenance. Upgrading does
not silently create, adopt, or rewrite these bindings, and credentials remain environment-only.
See [ADR-0016](adr/0016-capability-driven-integration-adapters.md).

## `ak system --json` fields removed in 4.0.0-alpha.41

Two fields left the runtime census. If you parse `ak system --json` (or `GET /api/system`), read
them defensively or drop them:

| Removed | Where | Why |
|---|---|---|
| `runtime.daemons.budget` | daemon census | No local source exists for ruflo's launch budget — not circumstantially, structurally — so the field could only ever read `unknown`. A permanently unknowable quantity is removed rather than reported as degraded ([ADR-0023](adr/0023-fail-closed-operations-and-explicit-degradation.md) §9). `ruflo daemon budget` remains the way to ask. |
| `runtime.childProcessCount` | runtime census | Still counted by the process survey — it is what makes the per-host rows correct — but no longer republished. As a rendered figure it was a bare number with no denominator, no history and no action attached. |

Nothing else was removed. `storage.topSessions` rows **gained** `projectLabel` and
`projectResolved`; the raw `project` key is unchanged. `catalog.items` now also covers
project-scoped `.claude/skills|agents|commands` across every project on disk, so the list is
longer — the shape is identical and deduplication by `(kind, name)` is unchanged.

## QE-Court configs created before agentic-qe 3.13.3

`agentic-qe` 3.13.3 fixed its shipped QE-Court default and made configuration validation
mandatory before a court convenes. New configs seat `defense` on `claude-code`, `jury` on
`cognitum-high`, and `deeperReviewer` on `codex`, preserving three distinct vendors.

An existing `.claude/skills/qe-court/config.json` is project-owned and is not overwritten by
an agentic-qe or `ak` upgrade. If `ak status` reports `writerIsNeverJuror`, regenerate the
config with agentic-qe 3.13.3+ or change `routing.defense.provider` from `cognitum-low` to
`claude-code`. `ak` reports this state read-only; `ak sync` no longer changes QE-Court roles.

The local anti-collusion check is not a runtime-readiness proof. Current consumer projections can
reference source-only referee/oracle assets, and `primaryHost` does not reverse court seats. Use
`pnpm test:qe-court-live` in a source checkout for one bounded Claude-led and one bounded
Codex-led **participant-transport** trial; do not record it as a court verdict.

If you already have `ak` working, you almost never need `ak setup` again — it's the
installer. Enabling a shipped-but-opt-in host feature is a `host pick` (or an `x mcp pick`,
etc.), not a re-`setup`. Project setup calls `ruflo init --full --force`, so review the
[setup scope and project mutation contract](SETUP.md) before deliberately rerunning it in
an existing project.

Codex status-line management is deliberately not enabled merely because an
upgrade adds support for it. Run `ak x statusline codex native` once to opt in;
later `ak sync` runs converge that recorded choice. Use
`ak x statusline codex off` to relinquish ownership. See
[Managed Codex status line](CODEX-STATUSLINE.md).

## Adopting the deja-vu companion

An upgrade never opts a machine into transcript indexing. Adopt it in two motions:

```bash
ak sync                                  # install the newer Agentic Kit
ak setup --minimal --with-deja-vu       # record MCP mode without rerunning project setup
ak x verify deja-vu                     # prove package, doctor, wiring, and index state
```

Use `--deja-vu-mode auto` on the setup command only after reviewing the per-host
automatic event differences and privacy implications in the
[deja-vu runbook](DEJA-VU.md). Run from outside a repository or retain `--minimal`
when the machine-level opt-in is the only intended change; project setup otherwise
keeps its normal `ruflo init --full --force` contract.

The integration requires deja-vu 0.19.0 or newer. That release resolved an earlier
machine-contract risk by adding `schema_version: 2` to doctor JSON. Agentic Kit accepts
additive fields within schema 2 and degrades rather than guessing when the schema is
missing, malformed, or newer. It wires only explicit enabled-host targets and builds
once with `deja index`; it does not invoke upstream discover-all modes.

After opt-in, `ak sync` maintains only the recorded mode and receipt-owned artifacts.
It updates an owned package through npm, preserves external/native installations and
Codex plugins, and indexes only when missing or stale. Returning to an explicit
disabled choice uses `ak setup --minimal --no-deja-vu`; removal scopes remain separate
and are documented in the runbook.

## Worked example: adopting ambidextrous dual-host

You have an older `ak` and both the `claude` and `codex` CLIs installed, and you want the
ambidextrous dual-host experience (per-activity routing across Claude + Codex). Two motions:

```bash
ak sync                              # 1. update the binary (+ heal everything)
ak host pick --host claude,codex   # 2. opt in → wires dual-host
ak host status                 # 3. verify: hosts "enabled, wired" + routing table
```

Step 1 gets the newer code onto disk. Step 2 is what actually turns dual-host on — it
records `codex` in `kit.json` and does the wiring: writes `ENABLE_CODEX` into
`.claude/settings.local.json`, seeds the per-activity routing policy, registers the
workspace-aware Ruflo MCP in Codex, retires any agentic-kit-owned legacy `codex mcp-server`
project entry, and generates the dual-host guidance.
Add `--primary-host codex` if you want Codex to lead (Claude becomes the alternate).

> [!NOTE]
> `ak sync` self-updates **last** in its pass, so the newer code applies from your *next*
> `ak` invocation — which is exactly `ak host pick` in the sequence above. Running the
> two in this order is correct; the pick runs under the freshly-installed version.

From then on, `ak sync` **maintains** the choice — it re-applies your recorded dual-host
config idempotently on every run. `ak status` flags drift; `ak host off` reverts to
the claude-only default, reversibly.

The full menu of host/provider levels — QE provider selection, deterministic fallback
chains, per-activity routing defaults, undo — lives in [PROVIDERS.md](PROVIDERS.md). This
page is only about the *upgrade motion*. The cross-host support and limitations
matrix lives in [HOST-SUPPORT.md](HOST-SUPPORT.md).

## How drift surfaces (you don't have to go looking)

Every `ak` command ends with a best-effort, never-blocking drift nudge. It has two halves:

- **Version drift** (npm-managed tools; TTL-cached network check):
  `↑ ruflo 4.1.0 available (installed 4.0.0) — run: ak sync`
- **Local artifact drift** (spawn-light file compares, evaluated on every run):
  `↻ drifted: 2 CLAUDE.md block(s) · deprecated codex MCP registered — run: ak sync`

The second half covers the artifacts `ak` *renders*: managed guidance blocks in the
machine-wide guidance files (`~/.claude/CLAUDE.md`, and `~/.codex/AGENTS.md` on codex
machines), Codex's independent Ruflo/AQE access, legacy MCP retirement, and the statusline
footer. These can drift with **no version change at all** —
a kit update (or, on an npm-linked dev checkout, merely merging a PR that edits a
`claude/*.md` template) revises the source of truth, and the rendered copies lag until the
next `ak sync`. The nudge closes that window, using the exact drift definitions `ak status` uses (the two
can never disagree) and stays quiet after `status`, `sync`, and `ak x reference`, which
already show the same information.

## Why `ak sync` pulled a prerelease

The `4.0.0-alpha.*` train publishes to npm's **`next`** dist-tag, not `latest` (`latest`
stays pinned at the last stable-ish release). A naive "is there a newer version?" check
reads `latest` and would conclude your alpha is already ahead — so it would never offer the
upgrade.

`ak` handles this: when your **installed** version is itself a prerelease, the self-drift
check consults **both** the `latest` and `next` dist-tags and takes the higher of the two.
That's why `ak sync` on `alpha.19` correctly pulls `alpha.20` even though `latest` points
further back. (If you'd rather move it by hand: `npm i -g @pacphi/agentic-kit@next`.)

## Appendix — design references

The *why* behind primary-host selection and ambidextrous mirroring is captured as an ADR —
[docs/adr/0006-primary-host-and-ambidextrous-mirroring.md](adr/0006-primary-host-and-ambidextrous-mirroring.md).
The per-activity routing model spans ADR-0001..0005 (see [docs/adr/](adr/)). This page
deliberately links rather than restates them, so the ADRs stay the source of truth.
