# Managed tools — the consistency contract

Every tool ak manages follows one contract for how it is installed, updated,
version-detected, and displayed. This doc states the contract's four
invariants, maps every managed tool onto them, and gives the checklist for
adding a new tool without breaking them.

The contract exists because the failure modes it prevents were all observed
live: a version stamp disagreeing with what was actually on disk, a statusline
showing a different version than `ak status`, a third-party self-updater
rewriting managed files behind ak's back, and an "update available" banner
that stayed silent for tools it didn't know about.

## The four invariants

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
   tag vs release tag. A comparison across namespaces (the original
   ruvnet-brain bug: plugin semver `0.5.0-dev` vs release tag `3.0.1`) can
   never converge. "Latest" is not always npm-latest either — agentdb's
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

## The tools

| Tool | Install / update spec | Update owner | Installed version read from | Drift compared against | status / statusline / dashboard |
| --- | --- | --- | --- | --- | --- |
| **ruflo** | npm `ruflo@latest` | `ak sync` | disk: global `package.json` | npm `view latest` (TTL-cached) | row ✓ / upstream's own `RuFlo V<x>` header ✓ / card + banner ✓ |
| **agentic-qe** | npm `agentic-qe@latest` | `ak sync` | disk: global `package.json` (project-local fallback) | npm `view latest` (TTL-cached) | row ✓ / `Agentic QE V<x>` chip ✓ / card + banner ✓ |
| **hosts** (claude, codex) | npm `@latest` — only when npm-managed | `ak sync` if npm-installed; **explicitly disowned** if brew/mise/native | disk: global `package.json`, else `--version` probe | npm latest for npm-managed only; external → `outdated:false` | row ✓ (version + method) / n/a / card + banner (npm-managed only) ✓ |
| **agentdb** | npm, **pinned to ruflo's bundled version** — deliberately not latest | `ak sync` (repins on core skew) | disk: global `package.json` | ruflo's **bundled** copy (coherence), not npm latest — by design | row ✓ / n/a / card ✓; banner excluded (its authority isn't "latest") |
| **ruvnet-brain** | npm `ruvnet-brain@latest` + `--version v<tag>` pin (never `github:` HEAD) | `ak sync`; the installer's own nightly self-updater is suppressed at install (`--no-nightly-prompt`) and disabled by sync if found (`ruvnet-brain-nightly` subsystem) | disk: KB `SOURCE.json → releaseTag`, falling back to ak's kit.json stamp for pre-stamping bundles | GitHub `releases/latest` tag (TTL-cached) | row ✓ / `V<tag>` chip ✓ / card + banner ✓ |
| **kit (self)** | npm, **pinned to the exact version drift saw** (`@pacphi/agentic-kit@<v>`) | `ak sync` (runs last — npm replaces the running code) | disk: running copy's `package.json` | npm `latest` (+ `next` for prereleases, TTL-cached) | row ✓ / n/a / header version + card + banner ✓ |

Statusline "n/a" cells are by design: the footer decorates the activation rows
it renders (ruflo / Agentic QE / brain) — hosts, agentdb, and the kit have no
footer row to decorate, and their versions live in `ak status` and the
dashboard.

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
