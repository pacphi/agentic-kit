# Managed tools — the consistency contract

Every tool ak manages follows one contract for how it is installed, updated,
version-detected, and displayed. This doc states the contract's five
invariants, maps every managed tool onto them, and gives the checklist for
adding a new tool without breaking them.

The **host** rows here mean execution drivers such as Claude Code, Codex CLI, and OpenCode.
Inference **providers** such as OpenRouter and Ollama are not install-owned hosts. Provider intent
may use a **binding** and native configuration **projection**, while transcripts and catalogues
remain separate **observability** evidence. The shared lifecycle and value-precise ownership
design is Accepted in [ADR-0016](adr/0016-capability-driven-integration-adapters.md).

Each invariant traces to a live failure it prevents — the appendix records
them.

## The five invariants

1. **Disk-first installed versions.** The "installed" side of every drift
   check is read from what is actually on disk — never from a cached claim or
   a side-record that can go stale. If a tool can change outside ak (manual
   npm install, a hand-run updater), the reads still tell the truth.

2. **Single update owner, with honest disowning.** `ak sync` is the only
   updater for everything ak claims to manage. Where ak does *not* own the
   artifact, it says so instead of pretending: externally-installed hosts are
   filtered out of drift entirely, and a tool that ships its own self-updater
   (the RuvNet Brain's nightly LaunchAgent) is detected as drift and disabled
   by sync. One owner means the release stamp, the drift check, and the thing
   on disk can converge.

3. **Same-namespace comparisons.** Installed and latest are always compared
   in the same version namespace: npm semver vs npm semver, GitHub release
   tag vs release tag. A comparison across namespaces can never converge
   (the appendix records the live case). "Latest" is not always npm-latest
   either — agentdb's
   authority is ruflo's *bundled* version, because a latest-chasing agentdb
   is the store-corruption risk its coherence guard exists to prevent.

4. **One drift story across all surfaces.** `ak status` rows, the statusline
   footer chips, and the dashboard (subsystem cards *and* the update banner)
   derive from the same reads, so they cannot disagree. The dashboard banner
   is the easy one to miss: `driftReport()` only knows npm tools, so
   non-npm-managed tools (the brain, the kit itself) are folded into the same
   `{pkg, installed, latest, outdated}` array explicitly
   (`foldBrainDrift()` / the `selfDrift` fold in
   `src/lib/dashboard-server.mjs`).

5. **Exit status outranks artifact presence.** Every managed operation reports
   both an outcome (`ok`, `degraded`, `failed`, or `skipped`) and whether a
   usable artifact remains. A failed repair can therefore say that an older
   install is still usable, but it cannot render green or advance a release
   stamp. A fallback is `degraded`, never an implied native repair. Version
   stamps advance only after the installer exits successfully.

## The tools

| Tool | Install / update spec | Update owner | Installed version read from | Drift compared against | status / statusline / dashboard |
| --- | --- | --- | --- | --- | --- |
| **ruflo** | npm `ruflo@latest` | `ak sync` | disk: global `package.json` | npm `view latest` (TTL-cached) | row ✓ / upstream's own `RuFlo V<x>` header ✓ / card + banner ✓ |
| **agentic-qe** | npm `agentic-qe@latest` | `ak sync` | disk: global `package.json` (project-local fallback) | npm `view latest` (TTL-cached) | row ✓ / `Agentic QE V<x>` chip ✓ / card + banner ✓ |
| **hosts** (Claude, Codex, OpenCode; OpenCode routes explicitly through `ak run`) | npm `@latest` — only when npm-managed | `ak sync` if npm-installed; **explicitly disowned** if brew/mise/native | disk: global `package.json`, else `--version` probe | npm latest for npm-managed only; external → `outdated:false` | row ✓ (version + method) / n/a / card + banner (npm-managed only) ✓ |
| **agentdb** | npm, **pinned to ruflo's bundled version** — deliberately not latest | `ak sync` (repins on core skew) | disk: global `package.json` | ruflo's **bundled** copy (coherence), not npm latest — by design | row ✓ / n/a / card ✓; banner excluded (its authority isn't "latest") |
| **ruvnet-brain** | npm `ruvnet-brain@latest` + `--version v<tag>` pin (never `github:` HEAD) | `ak sync`; the installer's own nightly self-updater is suppressed at install (`--no-nightly-prompt`) and disabled by sync if found (`ruvnet-brain-nightly` subsystem) | disk: KB `SOURCE.json → releaseTag`, falling back to ak's kit.json stamp for pre-stamping bundles | GitHub `releases/latest` tag (TTL-cached) | row ✓ / `V<tag>` chip ✓ / card + banner ✓ |
| **deja-vu** (opt-in companion) | npm `@vshulcz/deja-vu@latest`; v0.19.0 is the accepted contract baseline | `ak sync` only for an ak-receipted npm install; external binary/plugin installs are disowned | disk: global package plus bounded `deja version`; plugin or binary presence does not prove ownership | npm latest for owned npm; external → installed-only | content-free row / n/a / card + banner for owned npm drift |
| **kit (self)** | npm, **pinned to the exact version drift saw** (`@pacphi/agentic-kit@<v>`) | `ak sync` (runs last — npm replaces the running code) | disk: running copy's `package.json` | npm `latest` (+ `next` for prereleases, TTL-cached) | row ✓ / n/a / header version + card + banner ✓ |

Statusline "n/a" cells are by design: the footer decorates the activation rows
it renders (ruflo / Agentic QE / brain) — hosts, agentdb, and the kit have no
footer row to decorate, and their versions live in `ak status` and the
dashboard.

## Managed companion lifecycle boundary

[ADR-0035](adr/0035-managed-deja-vu-companion.md) applies this contract to deja-vu without making
it a host, provider, routing target, or AgentDB replacement. Its lifecycle is narrower than package
presence:

1. **Opt-in intent precedes history access.** Detection may report an external install, but no
   transcript scan, index build, host wiring, or plugin adoption follows without consent.
2. **Package, target, plugin, and data ownership stay separate.** Ak updates or removes only its
   receipted npm package and exact per-host targets. Upstream `wiring.json`, binary presence, and
   host-plugin presence are observations, not ownership receipts.
3. **Enabled hosts select explicit targets.** Ak never delegates scope to deja-vu's `--all` or
   aggregate `--auto` discovery. MCP is the default; automatic event injection is a second,
   per-host consent.
4. **Indexing preserves guidance ownership.** Target installs use `--no-guidance --no-index`, then
   ak runs one bounded `deja index` when required. It does not call `deja warmup`, which also writes
   deja's CLI skill, and uses `index --rebuild` only for diagnosed corruption.
5. **Verification is schema- and evidence-driven.** Normal status parses
   `deja doctor --json --offline` schema version 2 and independently observes host wiring/plugin
   facts. Doctor exit zero alone is not health, and unknown additive fields remain compatible.
6. **Removal has three scopes.** Wiring removal is ordinary; owned package removal is explicit;
   data purge is separately previewed and confirmed. Source transcripts and primary notes,
   exclusions, tombstones, policy, peers, and imported history are preserved by default. An
   explicit index purge can still destroy imported-only material whose sole copy is in that index.

## Where each piece lives

- **npm tools** — `src/lib/versions.mjs` (`installedVersion`, `driftReport`,
  `selfDrift`), heals in `src/lib/heal.mjs` (`upgradePackage`, `selfUpdate`).
- **hosts** — `src/lib/providers.mjs` (`hostInstallState`, `installHost`,
  `updateHost`, `hostDrift`).
- **agentdb** — `src/lib/agentdb.mjs` (`coherence`), heal
  `healAgentdb` (pins to the bundled version).
- **ruvnet-brain** — `src/lib/ruvnet-brain.mjs` (`installedReleaseOnDisk`,
  `latestVersion`, `classifyDrift`, `drift`, nightly-agent detection), heals
  `installRuvnetBrain` / `disableRuvnetBrainNightly`. Full background on its
  three version namespaces and the installer's `--yes` gotcha: MAINTAINER.md.
- **deja-vu companion** — lifecycle and upstream-version boundary in
  [ADR-0035](adr/0035-managed-deja-vu-companion.md); implementation follows the common adapter and
  managed-version seams rather than adding a host/provider registry member.
- **display surfaces** — `src/commands/status.mjs` (rows),
  `src/templates/statusline-footer.cjs` (chips),
  `src/lib/dashboard-server.mjs` (cards from the same rows; banner =
  `driftReport` + `selfDrift` fold + `foldBrainDrift`).

## Adding a new tool: the checklist

1. **Install a published artifact** (npm release, tagged release asset) —
   never a moving branch head. If the installer takes a version, resolve the
   target version *first*, install it pinned, and only then record it.
2. **Decide the version authority** and keep both sides of the drift check in
   that one namespace. Document the authority if it isn't npm-latest.
3. **Read installed state from disk** in a way that survives out-of-band
   changes. If the tool stamps its own version on disk, prefer that stamp;
   keep any ak-side record as a fallback only.
4. **Make sync the only updater.** If the tool ships auto-update machinery,
   suppress it at install time and detect + disable it as drift (its own
   subsystem, so sync's fix is proportionate — never a forced reinstall).
   If ak can't own updates (external install), report installed-only and
   `outdated: false`.
5. **Wire all the surfaces**: a `status` row (with the fix named), the
   statusline only if the tool has a footer row, a dashboard card (free —
   cards render status rows), and the dashboard banner (fold into the drift
   array if the tool isn't in `driftReport`).
6. **Lock it with tests**: the install spec + suppression flags (regression
   lock), the disk-read parser's edge cases (missing / malformed / junk),
   and the display resolution order.

## Appendix — the observed failures behind the contract

Each invariant exists because its failure mode was observed live, not
hypothesized: a version stamp disagreeing with what was actually on disk; a
statusline showing a different version than `ak status`; a third-party
self-updater rewriting managed files behind ak's back; an "update available"
banner that stayed silent for tools it didn't know about; and the original
ruvnet-brain drift bug — a cross-namespace comparison (plugin semver
`0.5.0-dev` vs release tag `3.0.1`) that could never converge, the live case
behind invariant 3.
