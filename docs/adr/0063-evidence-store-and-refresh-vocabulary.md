# ADR-0063 — One evidence store and the refresh vocabulary

- **Status:** Accepted
- **Updated:** 2026-09-29 — Branch 6c delivered the dashboard refresh operation and retired GET-started scans; 2026-09-29 V4 A3: self-version retry attempts and last freshness are scoped to checked channels
- **Earlier update:** 2026-09-28 — Branch 6b delivered the CLI refresh vocabulary
- **Date:** 2026-09-28
- **Deciders:** agentic-kit maintainers
- **Related:** [ADR-0025](0025-machine-footprint-metrics.md) (`/api/system/summary` projection),
  [ADR-0048](0048-inventory-led-maintenance-resource-management.md) (Maintenance's own, separate
  scan controls), [ADR-0053](0053-host-setup-evidence-and-usage-diagnostics.md) (host setup
  checks), [ADR-0055](0055-aqe-embedding-lifecycle.md) (live-check evidence), [ADR-0058](0058-managed-ruflo-components.md)
  (ruflo-component evidence), the
  [issues 237–239 audit record](../archive/2026-09-26-plan-issues-237-238-239-verification-and-decisions.md)
  (Review Focus: a 30-second dashboard poll spawning processes on every tick)
- **Amends:** [ADR-0025](0025-machine-footprint-metrics.md) §5 (cross-reference only — Task 11
  already recorded its own `Updated:` line), [ADR-0055](0055-aqe-embedding-lifecycle.md)
  (live-check evidence storage relocation, mechanical), [ADR-0053](0053-host-setup-evidence-and-usage-diagnostics.md)
  (host setup checks are now persisted evidence with an age rule)
- **Supersedes:** [ADR-0048](0048-inventory-led-maintenance-resource-management.md)'s separate
  **Refresh evidence** / **Re-measure machine** dashboard controls;
  [ADR-0025](0025-machine-footprint-metrics.md) §5's GET-started deep refresh rationale; and
  [ADR-0045](0045-artifact-consumer-bindings-and-explicit-maintenance-scans.md)'s
  `GET /api/maintenance?refresh=scan` trigger. Their underlying measurements and stores remain.

## Context

Before Branch 6a, a plain `ak status` or a 30-second dashboard poll re-ran every local probe on
every call: `which <host>` for each configured host, `npm view <pkg>@<tag> version` for every
tracked package, a native-binding load test per ruflo memory context, `npm root -g`, a full
process-table sweep, and more — unconditionally, every time, whether or not anything had changed.
This was the remediation program's own originating Review Focus item. Each check that did cache
anything invented its own ad hoc freshness rule (or none): `ruflo-components/evidence.mjs` had a
15-minute producer TTL plus a 24-hour display-staleness threshold; `live-check-evidence.mjs` had a
flat 24-hour TTL; `versions.mjs`/`ruvector.mjs`/`ruvnet-brain.mjs` had a `kit.json`-backed
TTL-with-`force`-override that was already correct but not reachable from `ak status --refresh`;
everything else had no caching at all. The dashboard's `/api/status` poll shelled out to the
installed CLI on every tick, and its Maintenance workspace poll wrote preferences to disk on every
tick regardless of whether the view had changed.

Branch 6a (Tasks 1–11, `refactor/evidence-store`) closed this. This ADR records what actually
shipped — not the original branch-plan's guesses, several of which changed materially during
implementation (Task 3's scope narrowed to a storage-location move only; Task 6 needed no library
changes at all; Task 7 added a `record` parameter and a `globalRoot()` design exception nobody
anticipated at planning time; Task 9 added a timeout/`cwd`-safety layer a subprocess boundary used
to absorb for free).

## Decision

### The envelope and age rule

`src/lib/evidence.mjs` (Task 1) is the shared envelope every new evidence kind in this branch uses:

```text
{ version, kind, id, source, checkedAt, inputsKey, inputs, result }
```

- `evidenceFile(kind, id)` → `<stateBase>/agentic-kit/evidence/<kind>/<sanitized-id>.json`.
- `writeEvidence(kind, id, { source, inputsKey, inputs, result }, { now })` writes atomically;
  returns `false` (never throws) if the directory is unwritable.
- `readEvidence(kind, id, { inputsKey, maxAgeMs, now })` returns `null` for missing/corrupt
  records, or `{ ...record, ageMs, stale, invalidated }`. `stale = ageMs > maxAgeMs`.
  `invalidated = inputsKey` mismatch against the record's own stored `inputsKey`.
- `stableInputsKey(parts)` and `describeAge(ms)` generalize helpers `live-check-evidence.mjs`
  already had, so every kind computes its cache key and its human-readable age the same way.
- The `inputs` field stores the actual object the key was hashed from, not just the hash, so a
  later branch can answer "what was the world like when this was recorded" without a schema
  change. Every kind populates it with the real object it hashed: `ak-launcher` stores
  `{PATH}`; `host-setup`/`host-install-method`/`host-launch` store `{PATH, bin}`; `native-runtime`
  stores `{dir, native}`; `companion-lifecycle` stores `{desired, PATH}`; `daemon-sweep` stores a
  fixed marker (`{kind: 'daemon-sweep'}`, since a process-table sweep has no natural per-call
  input); the hand-written `npm-global-root` envelope stores `{execPath}` (a narrower subset than
  the `PATH`/`npm_config_prefix`-inclusive object its own `inputsKey` is hashed from). The one
  exception is `live-check`, which passes `inputs: null` — Task 2 deliberately did not attempt to
  reconstruct per-check input objects from the old, hash-only shape it migrated from.

### The kind table (what is real today, not the plan's original guess)

| Kind | id shape | `maxAgeMs` | Task |
|---|---|---|---|
| `live-check` | fixed enum (`aqe-embedding`, `mcp`, `providers`, `security`, `deja-vu`, `memory`) | 24h | 2 |
| `ruflo-component` | `'machine'` (one joint probe) | producer-side 15min TTL + 24h display staleness (its own, pre-existing rule — **not** routed through the generic envelope; see below) | 3 |
| `native-runtime` | per memory context (`memory`, `cli`) | 6h | 4 |
| `host-setup` / `host-install-method` / `host-launch` | per host id | 6h | 5 |
| `companion-lifecycle` | `'deja-vu'` | 6h | 5 |
| version-drift (`versionCheck.*`) | n/a — stays in `kit.json`, not migrated | 24h (pre-existing `ttlHours`) | 6 (wiring only) |
| `npm-global-root` | `'machine'` | 24h, via a **hand-written local envelope in `paths.mjs`**, not `evidence.mjs` | 7 |
| `daemon-sweep` | `'machine'` | 5min | 7 |
| `ak-launcher` | `'machine'` | 6h | 7 |

Every kind above defaults `refresh: true` (Ruling B — see below) **except** `npm-global-root`,
which defaults both `refresh` and `record` to `false`; this is the one deliberate exception in
the branch, and it applies to the *default*, not to the mechanism — `status.mjs`'s `collect()`
still forces a real `refresh`/`record` when the user asked for one.

### The four rulings this branch's implementers worked under

- **Ruling A** — a plain `ak status`/dashboard poll re-collects an expired local check on a long
  age window; it does not wait forever for `--refresh`. The read path for every gated kind is:
  use cached evidence when `!stale && !invalidated`; otherwise probe and record, whether or not
  `refresh` was requested. `refresh: true` always forces a fresh probe.
- **Ruling B** — every new `refresh`/`record` parameter defaults to today's always-probe,
  always-persist behavior, so no existing caller (heal, the pre-6b verify checks folded into what
  is now `ak status --refresh=live`, the post-command drift nudge) needed a code change merely to
  keep working exactly as before. `ak setup` is not in that unaffected list: `setup.mjs`'s
  `installEnabledAbsentHosts` was separately extended, in the same final-review round, to re-probe
  and re-record `host-install-method`/`host-setup` evidence immediately after a successful install
  (`hostInstallState(h, { refresh: true, record: true, source: 'setup' })` and
  `collectIntegrationFacts({ cfg, refresh: true, record: true, source: 'setup' })`,
  `setup.mjs:398,407`) — see "The `record` parameter" below for the same pattern applied to sync's
  and `x/host.mjs`'s own install/repair/reap call sites. Only `status.mjs`'s `collect()` and
  `dashboard-server.mjs`'s in-process call (Task 9) pass `refresh`
  explicitly as `false`, to prefer a fast warm-cache read. `sync.mjs`'s two internal `collect()`
  calls (building its plan, and its post-heal convergence re-check) do NOT pass `refresh` at all —
  a blanket `refresh: true` on either was tried in a later final-branch review round and reverted;
  see "The `record` parameter" below for why, and for the narrower mechanism (`refreshPlanHosts`)
  that fixes the same underlying gap without it. They do differ from each other on `record`: the
  plan read passes `record: false` (still a read, never a write, as planning must be), while the
  converge proof passes `record: true`, so a cache-miss probe it triggers is worth keeping — a
  plain `ak status` immediately after `ak sync` reuses it instead of re-probing on its own.
- **Ruling C** — the zero-spawn test guards the real boundary (every `node:child_process` entry
  point: `spawn`, `execFile`, `execFileSync`, `spawnSync`, plus `execSync`/`fork` added defensively
  by Task 8a), not a single library's `exec.mjs` wrapper, since ~30 files spawn directly.
- **Ruling D** — a committed test never fails the suite while it names a real, outstanding gap.
  Task 8a's zero-spawn assertion shipped as `test.todo(...)` (with the RED baseline captured
  verbatim in its report) until Task 7's sweep closed every spawn path and flipped it to a real,
  enforced assertion (`todo 0` in the branch's final unit run).

### The `record` parameter

Every gated function accepts `record` (default `true` for every kind except `npm-global-root`),
controlling **only** whether a fresh probe's result gets persisted — never whether the probe
itself runs. This was added in a joint Task 4/5 fix round after `sync.mjs`'s `converge()` was
found to write evidence as a side effect of its own internal plan-computation `status.collect()`
calls (building its plan, and its post-heal convergence re-check), both before the `--dry-run`
early return — matching this ADR's own "sync doing work the plan didn't announce" theme. That
round made both of `sync.mjs`'s internal calls pass `record: false` and left their `refresh`
argument unset (the collector's own default, `false`), which closed the unannounced-write gap but
opened a different one: because neither call forced a fresh probe, `ak sync`'s own converge proof
could read back a cache written *before* a repair this same run had just applied, so a host or
daemon sync had just fixed could still show as failing — the exact defect a later final-branch
review round found and fixed.

That review round first tried adding `refresh: true` to **both** of `sync.mjs`'s internal
`collect()` calls, on the theory that it would parallel `refreshPlanDrift`'s existing unconditional
`force: true` for version drift. It was reverted: `collect()` threads one `refresh` flag into
*every* evidence-gated kind it reads, not just the host/daemon ones the bug was actually about, and
forcing all of them fresh from `sync.mjs` broke two things in practice — `ruflo-component` evidence
(which does not route through the generic envelope's `record` gate at all; see "What is
deliberately not folded into this store" below) got written even under `--dry-run` with
`record: false`, and several existing tests that inject a fixed `_globalRoot` via
`paths.mjs`'s `_setGlobalRootForTest` broke, because `refresh: true` bypasses `globalRoot()`'s
in-memory memo (`if (_globalRoot && !refresh) return _globalRoot;`) and forces a real `npm root -g`
regardless of what a caller had set. Both failures were real evidence the mechanism was wrong, not
just test friction to route around.

The shipped fix is narrower. `sync.mjs` gained `refreshPlanHosts(flags, cwd)`, a sibling to the
pre-existing `refreshPlanDrift`: before the plan is read, it force-refreshes ONLY the host-related
evidence (`hostInstallState`/`hostExecutable` for every enabled host, then one
`collectIntegrationFacts` call for `host-setup`), each with `record: true` and `source: 'sync'`,
and — like `refreshPlanDrift` — it is skipped entirely under `--dry-run` (same cache-staleness
trade-off `--dry-run` already accepts for version drift). The plan-read and converge-proof
`collect()` calls themselves keep `refresh` unset (the collector's own default, `false`); only
their `record` differs — the plan read stays `record: false` (still a read, never a write), and
the converge proof now passes `record: true`, so a cache-miss probe it triggers is worth keeping.
Separately, and doing most of the actual work: the direct host-management and daemon-reap call
sites that mutate machine state (`sync.mjs`'s `hosts` and `daemons` steps, `setup.mjs`'s
`installEnabledAbsentHosts`, `x/host.mjs`'s `installPickAbsentHosts`, `x/daemon-gc.mjs`'s `run`)
were extended in the same final-review round to re-probe and re-record their own evidence
immediately after a successful install/repair/reap — closing the "recorded before the repair,
never after" half of the bug at its source, rather than relying solely on a later forced re-read to
paper over it. Every caller not named above (`ak status`, the dashboard poll, `ak status
--refresh`, the pre-6b verify checks now folded into `ak status --refresh=live`) keeps
`record: true` and persists as designed, unaffected by this fix round; `ak setup` is named above,
not here, because `setup.mjs`'s `installEnabledAbsentHosts` is one of the call sites this fix round
extended.

### The `source` field

`status.mjs`'s `collect()` computes an accurate value (`refresh ? 'status-refresh' : 'status'`),
threaded into every evidence write it triggers, rather than a hardcoded literal — a plain status
call recording evidence no longer claims to be a refresh it never performed. This was part of the
same Task 4/5 fix round.

### The `npm-global-root` exception, and why it needed a different `record` default

`paths.mjs`'s `globalRoot()` — the `npm root -g` call behind `installedVersion()`, `rufloRoot()`,
`aqeRoot()`, `rufloCliPkgRoot()`, and dozens of their own transitive callers — is reached from a
far wider, unbounded set of call sites (setup, sync, uninstall, heal, audit, and every test that
touches any of them) than any other kind in this branch, all of which are reached only from
`status.mjs`'s own `collect()` tree. Task 7's first pass gave it `record: true` by default,
matching every other kind; this passed its own tests but the branch's real-state tripwire caught
seven separate, previously-green test files each newly writing a real evidence file as a side
effect of calling something that transitively reached `globalRoot()` with no sandbox of its own.
An advisor consultation correctly diagnosed this as an unbounded tail rooted in the design, not a
finite list to patch one file at a time. The fix that shipped: `globalRoot()` defaults both
`refresh` and `record` to `false`, and `status.mjs`'s `collect()` warms `globalRoot()`'s
in-process memo once, right after `loadKitConfig()`, with the real `refresh`/`record`/`source` —
every other bare `globalRoot()` call in the same process reuses that memo for free and never
itself decides whether to persist.

`paths.mjs` cannot import `evidence.mjs`'s `readEvidence`/`writeEvidence`: `evidence.mjs` itself
imports `paths.mjs` for `evidenceDir()` (`export const evidenceDir = paths.evidenceDir`), and
`paths.mjs` is almost always the first of the pair loaded by any real entry point — confirmed with
a minimal two-file ESM repro (whichever module is entered first throws `Cannot access '...' before
initialization` the moment the peer imports back). `paths.mjs` instead writes a local, hand-rolled
envelope in the identical on-disk shape (`evidence/npm-global-root/machine.json`, same record
fields) — verified byte-compatible with `evidence.mjs`'s own read/write in
`tests/kit/paths-global-root-evidence.test.mjs`, but genuinely different *code*.

A structural fragility this design carries, flagged by Task 7's own report and confirmed by a
regression test added in its review-fix round: the memo-hit path
(`if (_globalRoot && !refresh) return _globalRoot;`) returns before the `if (record) write` line,
so persistence silently stops for any hypothetical future caller that reaches bare `globalRoot()`
ahead of `status.mjs`'s warming call in the same process. This is a deliberate constraint of the
design (a new caller that wants evidence persisted from somewhere other than `status.mjs`'s
`collect()` must route through that warm, or accept it won't persist), not an oversight, but it is
the one piece of this ADR's design most likely to surprise a future reader.

### What is deliberately not folded into this store

- **Version-drift** (`kit.json`'s `versionCheck.*`) — already had a correct TTL-cache-with-`force`
  design before this branch (`driftReport`/`selfDrift` in `versions.mjs`, and the equivalents in
  `ruvector.mjs`/`ruvnet-brain.mjs`), confirmed by Task 6 reading all three libraries and every
  production call site. Only the *wiring* — whether `ak status --refresh` reached `{ force: refresh
  }` — needed a fix (four one-line-of-substance edits across the four status sections); the
  library storage itself was never migrated to `evidence.mjs`, and doesn't need to be.
- **The paid host connection-check proof** (`host-readiness.mjs`) — stays in-process, unpersisted,
  15-minute-capped, consent-gated. Untouched by this branch, by design (Decision 9).
- **Maintenance scans** (`scan-store.mjs`, the machine-footprint deep snapshot) — stay in their own
  files, entirely their own system. Branch 6b's `--refresh=machine` now drives them from the CLI
  (its `maintenance` and `inventory` stages call the same `service.scan()` and
  `management.rebuildAfterMeasurement()` this bullet names), but the storage itself is not moved
  and not touched — see "Delivered in 6b" below.
- **`ruflo-component` evidence** — does not route through the generic `readEvidence`/`writeEvidence`
  envelope at all; only its storage *location* moved under the shared `evidence/` directory (Task
  3). `apply.mjs`'s `classify()`, `snapshot.mjs`, and `status/sections/ruflo-components.mjs` access
  dozens of fields on the evidence object directly (`evidence.capturedAt`, `.rufloVersion`,
  `.typesafe`, `.funnel`, `.errors`, …); wrapping it in the generic `result` field would have
  forced a much larger rewrite of all three files than the branch's actual goal (one shared
  directory layout, one age rule per kind) required. This was Task 3's controller ruling, applied
  exactly as given.
- **`npm-global-root`** — see the exception above; separate code, same on-disk shape.
- **`src/lib/host-health-evidence.mjs`** — not touched by any task on this branch (`git log` on
  this file since Task 1's baseline commit shows zero commits from this branch). It is not itself a
  persisted evidence store: it is `createHostHealthSnapshot`, an HMAC-based input-fingerprint
  helper that `host-readiness.mjs` (the paid host connection-check proof named above) uses only to
  invalidate its own in-memory local-health cache — it never writes to disk. This is a known,
  deliberate gap for a later branch to decide whether it belongs in this store at all, not a silent
  omission: the original program-plan's item 1 named `ak x aqe-embedding verify`, setup proofs, and
  sync as things that "must record," and the branch plan explicitly flagged this file as needing
  either folding-in or an explicit stated-reason exclusion. No task folded it in; recording the
  exclusion here satisfies that requirement.

### `ak x aqe-embedding verify` — a correction to the original plan's assumption

The program plan and this task's own brief assumed `ak x aqe-embedding verify`
(`src/commands/x/aqe-embedding.mjs`'s `verify` action) writes through the shared live-check
envelope, since Task 2 moved `live-check-evidence.mjs`'s storage onto it. Reading the actual code
shows this is not the case: `aqe-embedding.mjs`'s `verify` action calls `prepareAqeEmbedding()`
directly and never calls `recordLiveCheck`/`rememberLiveCheck` — `prepareAqeEmbedding()` itself has
no live-check-evidence import at all. The only two call sites that record the `aqe-embedding`
live-check evidence row are, since Branch 6b folded `ak x verify` into `ak status --refresh=live`
and moved its checks into `src/lib/live-checks.mjs`, the quick `aqe-embedding` check and the full
`aqe` proof's own embedding request (`live-checks.mjs`'s `CHECKS` table and `verifyAqe()`,
`source: 'status-refresh-live'` by default) and `ak sync`'s post-sync check (`sync.mjs:711`,
`source: 'sync'`). `ak status`'s "last remembered live check" row (which Task 2's storage move
does cover, via the shared `evidence/live-check/` directory) reflects whichever of those two last
ran; an evidence row recorded before 6b under the retired `verify`/`status-live` source ids still
reads back, labelled "an earlier live check" (R13, `live-check-evidence.mjs`'s `SOURCE_LABEL`).
`ak x aqe-embedding verify` run on its own still updates neither `kit.json` nor the evidence
store; it is a one-shot, unpersisted probe. This is a factual correction to the branch plan's own
assumption, not a defect: `aqe-embedding.mjs`'s `verify` action was never meant to be a persisted
check (it exists for a synthetic backend proof with no downloads or corpus writes), and nothing in
this branch or 6b changed that.

### The `--refresh` flag's three strengths (delivered in 6b)

`--refresh` is no longer the interim boolean this ADR originally described. `src/lib/refresh.mjs`
now owns one flag, `--refresh[=live|machine]`, with three internal strengths
(`REFRESH_STRENGTHS`: `local` — the bare `--refresh` and its explicit spelling `--refresh=local`
— `live`, `machine`) and one ordered stage table (`REFRESH_STAGES`): `machine` (Measuring the
machine) → `maintenance` (Refreshing Maintenance evidence) → `inventory` (Rebuilding the
inventory) → `live` (Running live checks) → `local` (Re-checking local evidence and versions).
`stagesFor(strength)` selects which stages a strength runs: `local` runs `maintenance`,
`inventory`, `local` — the coverage this section used to enumerate flag-by-flag (ruflo-component
evidence, native-runtime/host-setup/companion-lifecycle, version-drift, npm-global-root,
daemon-sweep, ak-launcher, the deduped host-presence check) is now exactly what those three
stages' implementations (`cliRefreshStages` in the same file) do; `live` adds the `live` stage;
`machine` adds the `machine` stage and rebuilds the inventory with `rebuildAfterMeasurement`
instead of `refreshInventory`. `local` always runs last, so its status rows include any fresh
`live` results from the same invocation. A failed `machine` stage marks `maintenance` and
`inventory` skipped (`MEASUREMENT_DEPENDENTS`); any other stage failure does not stop later
stages.

`--refresh` and the old `--live` are no longer separate flags — `ak x verify` is retired, and its
checks run only as the `live` stage inside this one flag (`ak status --refresh=live`, `--only
<check>` to run exactly one). The residual quirk this section used to flag under the old two-flag
design still holds, just inside one invocation now: the `live` stage's own `providers` check
(`verifyProviders` in `src/lib/live-checks.mjs`, functionally unchanged by 6b in this respect)
calls `collectIntegrationFacts({ cwd, cfg, source: 'verify' })` with no `refresh` argument, so it
defaults to `refresh: true` (Ruling B) and independently re-probes and persists `host-setup`
evidence as a side effect of the `live` stage — before the `local` stage that runs after it
performs its own `collect({ refresh: true })`, which probes `host-setup` again. The second probe
finds fresh evidence and changes nothing, so this is harmless, but `--refresh=live` still triggers
two internal `host-setup` refreshes, not one; this branch did not change that.

### The dashboard poll's two cost fixes (Tasks 9 and 10)

**Spawn cost (Task 9).** `/api/status` now calls `status.mjs`'s own `collect({ refresh: false })`
in-process instead of shelling out to the installed CLI (`execFile` of `bin/agentic-kit.mjs status
--json`), made safe only because Task 7's sweep first made a warm-cache `collect()` genuinely
spawn-free. Two hazards a subprocess boundary used to absorb for free, now handled explicitly:

- A hand-rolled 30-second timeout (`setTimeout`/`clearTimeout` racing the `statusCollect()` promise
  chain by hand, with a `settled` flag rather than a naive `Promise.race`, so the winner clears the
  loser's timer and a still-pending call past the timeout can't itself keep the process alive) —
  Task 9's reviewer confirmed this is subtly better than a naive race. **Known limitation**: this
  timeout only bounds *async* hangs; nothing in today's `collect()` call graph makes a synchronous
  blocking subprocess call, but that is not structurally enforced — a future section that added one
  would silently defeat the bound.
- Per-request `cwd` threading, verified rather than assumed: `grep`-confirmed no bare
  `process.cwd()` read in the `status.collect()` call graph (every occurrence is a default-parameter
  fallback), no `process.chdir`/`process.exitCode` anywhere in it, and a dedicated regression test
  anchored to known-good content, mutation-tested against two real sections to confirm it actually
  catches a `cwd`-fallback bug (it found none — this branch's own section work already threaded
  `cwd` correctly everywhere checked).

Measured, real numbers (Task 9's `dashboard-status-cost.test.mjs`, folding in the plan's originally
separate "Task 8b"): a cold-cache `/api/status` poll spawned **14** processes and returned **11,581**
response bytes; a second, warm-cache poll spawned **zero** processes and returned an
**11,581-byte** payload — byte-identical on the machine that measured it. The test itself does not
enforce exact byte equality: it asserts the warm response stays within a budget of 10% of the cold
response's size or 2,048 bytes, whichever is larger (`tests/kit/dashboard-status-cost.test.mjs`),
generous enough to absorb in-process cache growth across polls without masking a real leak; the
byte-identical figure above is an observed data point on this run, not the guarantee the test
enforces. This is the branch's proof that the Review Focus item the whole remediation
program was scoped around — a 30-second dashboard poll spawning processes on every tick — is
closed. The "zero" figure is measured *after* filtering one documented, named exception: version-drift's
`npm view` lookups, whose own `kit.json`-based cache (unchanged by this branch, see above) only
persists after at least one *successful* live fetch, which this hermetic test's deliberately broken
`PATH` can never produce. On a real machine, that cache warms after one success and is 24h-TTL'd,
same as before this branch; it is proven correct elsewhere (`tests/kit/status-version-drift-refresh.test.mjs`),
not exercised warm inside this specific harness.

**Write cost (Task 10).** A separate, write-side cost the plan's original section list did not
name: the dashboard's Maintenance workspace poll called `savePreferences` on every tick regardless
of whether the current view had changed, writing `lastView` to disk every 30 seconds. Fixed with a
deep-equal guard on both ends — the client (`maintenance-workspace.mjs`) skips the POST when the
current view matches the last-saved one; the server (`preferences.mjs`'s `createPreferencesStore`)
independently skips the write when the computed next state deep-equals the current one, a generic
guard that also benefits `setPreferredShell`'s unrelated writes for free. This is the write-side
counterpart to Task 9's spawn-side fix, and belongs in the same "what the dashboard poll now costs"
story even though the original branch plan's content list omitted it.

### `/api/system/summary`'s measurement and fix (Task 11)

The controller's own measurement, against the real persisted snapshot on the machine that measured
it (schema v7): the full, unslimmed payload was ≈45.4 MB; the endpoint's existing `catalog`
allow-list projection already brought that down to ≈2.43 MB, of which the already-slimmed `catalog`
was 588 KB (24%) and the four then-unfiltered sections — `install`, `storage`, `projects`,
`consumers` — were 1,844,847 bytes (~76%), the dominant remaining bulk.

Task 11 added the same allow-list projection pattern to all four sections (`summaryStorage`,
`summaryInstall`, `summaryProjects`, `summaryConsumers` in `src/lib/dashboard/system-summary.mjs`),
confirmed field-by-field against a repo-wide grep of every dashboard client file that reads them —
dropping fields no client reads (`stack`, `nativeAddons`, `nodeModulesRoots`, `topFiles`,
`matchedPaths`, `absent`, and others) while keeping fields a client genuinely needs, including one
non-obvious retention: `projects[].loc.byLanguage` is kept alongside `languages` because
`read()`'s `carryForward` can surface an older, pre-`languages`-field snapshot verbatim, and the
client's fallback needs `byLanguage` for exactly that case. `/api/system` and `ak system --json`
are unchanged — only `/api/system/summary` was touched.

The measured *after* number is a fixture measurement, not a real-machine one: Task 11's own
byte-budget regression test (a hand-built, intentionally large fixture — 150 storage session nodes,
15 install tools × 5 native addons each, 60 measured + 200 discovery project rows, 100 consumer
rows) went from 3,887,926 bytes to 157,708 bytes, a 96% cut, which the test asserts stays under a
500,000-byte budget. The controller's real-machine numbers above are the only real-machine
measurement recorded; a follow-up real-machine remeasurement of `/api/system/summary` after this
fix would give an exact final figure for this specific machine, and was explicitly left to the
controller/whoever finishes the branch, not attempted by Task 11 itself (branch rule: real-machine
state is measured by the controller, not invented by a task).

## Delivered in 6a

**Delivered in this branch:**

- The shared evidence envelope, its age rule, and the `{refresh, record, source}` contract
  (`src/lib/evidence.mjs`).
- Eight evidence kinds using the generic envelope directly (`live-check`, `native-runtime`,
  `host-setup`, `host-install-method`, `host-launch`, `companion-lifecycle`, `daemon-sweep`,
  `ak-launcher`), plus two more kinds (`ruflo-component`, `npm-global-root`) whose storage moved
  under the same shared `evidence/` directory without routing through the generic envelope — ten
  evidence-kind directories in total — plus version-drift's pre-existing `kit.json` TTL cache
  correctly wired to `--refresh`.
- A plain `ak status`/dashboard poll that spawns zero processes on a warm cache (measured: 14 → 0
  spawns), a dashboard poll that writes zero preference-store bytes when the view hasn't changed,
  and a `/api/system/summary` endpoint with four newly-projected sections.
- The interim, no-suffix `--refresh` boolean covering every kind above — folded into Branch 6b's
  `local` strength; see "Delivered in 6b" below.

## Delivered in 6b

Branch 6b (`feat/one-refresh-flag`) replaced the interim boolean above with the flag syntax this
ADR originally deferred, folded `ak x verify` into it, and closed several vocabulary/wiring gaps
the [issues 237–239 audit](../archive/2026-09-26-plan-issues-237-238-239-verification-and-decisions.md)'s
Item 4 named. It closed CLI-only: the dashboard's own controls are untouched, and the dashboard
half of this work moved to the next remediation program — see
[the branch 6b plan](../archive/2026-09-28-superpowers-plan-branch-6b-one-refresh-flag.md)'s "Closing
this branch" section and "Delivered in 6c" below.

- **One flag, three strengths, one ordered stage table** — `--refresh[=live|machine]` across `ak
  status`, `ak system` and `ak maintain [report]`; see "The `--refresh` flag's three strengths"
  above for `REFRESH_STAGES`, its run order and the failed-`machine`-skips-`maintenance`/`inventory`
  dependency rule, and `runRefresh`/`cliRefreshStages` (`src/lib/refresh.mjs`) for the shared
  runner every one of the three commands calls.
- **`--only <check>,...` is `ak status`'s alone.** It selects exactly the named live checks or
  slow proofs instead of the quick default set, and is the only way a slow proof (`learning`,
  `harvest`, the full `aqe` proof, `memory-routes`) runs; a named check that does not apply to the
  configuration still runs and reports, but its result is not remembered. Without `--only`, a
  failed live check stays a warning and the exit code follows the rows and stages alone; with
  `--only`, the exit code is 1 when any named check did not pass — `failed`, `inconclusive`, or no
  result at all (its status was never `'passed'`) — else 0 (`status.mjs`'s `namedCheckFailed`).
  `ak system` and `ak maintain` both refuse a non-empty `--only` outright (exit 2): neither
  renders live-check results or reports their verdict, so accepting the flag would silently run
  past a failed named check.
  A refresh stage that fails makes `ak status`, `ak system` and `ak maintain` exit 1; a usage
  error is exit 2 everywhere the flag is accepted.
- **The live-check fold and its source labels.** `ak x verify` is retired; its checks
  (`aqe-embedding`, `mcp`, `providers`, `security`, `deja-vu`, `memory` — quick and free — and
  `learning`, `harvest`, `aqe`, `memory-routes` — slow, `--only`-only) now live in
  `src/lib/live-checks.mjs` and run as `--refresh=live`'s `live` stage. `memory` is the quick
  store/retrieve/purge round trip; `memory-routes` additionally observes whether the CLI and MCP
  see each other's writes. Its CLI result is remembered under `memory` and its routing result
  under `memory-routes`. A live-check evidence row carries the source id
  `status-refresh-live`, labelled "ak status --refresh=live"; a row recorded before this branch under the retired `verify` or
  `status-live` source ids still reads back, labelled "an earlier live check" — the label never
  names a retired command (`live-check-evidence.mjs`'s `SOURCE_LABEL`).
- **The Codex quota presence gate.** `/api/limits` asks `codex app-server` for its
  quota only when the last recorded `host-setup` evidence says Codex was found
  (`quota.mjs`'s `readLimits`, via `recordedHostPresence` in `providers.mjs`) — never by probing.
  `not-found` and `unconfirmed` (no record, older than 6h, or recorded under a different `PATH`)
  each skip the spawn and report `codexUnavailable.reason` as `host-not-found` or
  `host-unconfirmed`; the last cached Codex figure, if any, is still served with its age either
  way. See [ADR-0010](0010-provider-mediated-quota-reads.md)'s own `Updated:` line.
- **`ak sync --skip <part>` also skips that part's online version lookup.** `--skip versions`
  (or `self`/`ruvnet-brain`/`ruvector`) reports the recorded value with no network call and no
  write (`plan-versions.mjs`'s `skippedVersionEvidence`, `cacheOnly: true`), instead of silently
  performing the lookup anyway.
- **The `ak sync --dry-run` preview and its host-evidence limitation.** A dry run performs the
  same forced online version lookups a real sync performs before planning (`previewPlanVersions`
  in `src/commands/sync/plan-versions.mjs`), with `record: false` throughout and every `npm view`
  pointed at a per-run npm cache under the OS temp folder (`fs.mkdtempSync`), removed in a
  `finally` block once the lookups are done. When every lookup fails, it prints one line saying
  versions were not checked online and that the plan uses the recorded ones. This preview does
  **not** force host evidence fresh the way a real (non-dry-run) sync does:
  `refreshPlanHosts` — the function a real sync calls before reading its plan, to catch a host
  that changed since its 6h-TTL `host-setup` record last went stale — returns immediately under
  `--dry-run` (`sync.mjs:121`), so the dry-run plan reads host-install/host-setup evidence exactly
  as last recorded (probed fresh only if it is stale, invalidated, or missing, same as a plain `ak
  status`), never force-refreshed. A host repaired or broken since that evidence was last
  recorded can therefore be invisible to `--dry-run`'s preview even though a real sync would catch
  it (`tests/kit/sync-command.test.mjs`'s `'--dry-run prints a plan and then changes nothing at
  all'` and `'sync (non-dry) force-refreshes host evidence too, so a fresh-but-wrong cache cannot
  hide a host that changed'` cover the contrast).
- **The renames.** `ak host refresh` → `ak host reset-routes` (it only re-seeds routing, never a
  refresh); `ak usage prompts --deep` → `--show-text`; `ak status --deep`/`--live`, `ak system
  --deep` and `ak maintain scan`/`--deep`/`--refresh-inventory` are retired, with no alias and no
  hint (Ruling R17 of
  [the branch 6b plan](../archive/2026-09-28-superpowers-plan-branch-6b-one-refresh-flag.md)) — a
  retired spelling gets the parser's generic unknown-command/unknown-option error.
- **The recipe-refresh removal.** Every user-reachable path to a recipe-registry refresh (the
  `ak maintain recipes` sub-verb, its v2 route and allowlist entry, the facade method, and the
  service options that existed only for it) is removed; `ak maintain recipes` now supports only
  `list`, `accept` and `withdraw`. The recipe store's verified-staging function
  (`maintenance/management/recipes.mjs`'s `refreshRecipes`, with its allowlist/HTTPS/redirect/
  signature checks) and its tests stay, as the library a future registry calls — ADR-0048 already
  says so.
- **`ak host check-connection <claude|codex|opencode>`.** The CLI twin of the dashboard's paid
  connection-check dialog: it reuses `createHostReadinessReader` so it refuses for exactly the
  hosts and reasons the dashboard would, prints the target and the shared disclosure text, asks
  `[y/N]` on a TTY or refuses on a non-TTY without `--yes`, and `--dry-run` always stops before any
  request, even with `--yes`. It is never reachable from any `--refresh` strength — a static
  assertion in `tests/kit/refresh.test.mjs` pins that `refresh.mjs` never references
  `checkConnection`/`host-health-connected`. See [ADR-0053](0053-host-setup-evidence-and-usage-diagnostics.md)'s
  own `Updated:` line.
- **`ak host pick`, `off` and `reset-routes` all take `--dry-run`**, printing what they would do
  and stopping before any write; `ak host adapters` refuses `--dry-run` outright (exit 2) because
  its verbs have no preview.

## Delivered in 6c

Branch 6c adds one dashboard **Refresh** control. Its visible choices are **Refresh**,
**Refresh live**, and **Refresh machine**; the operation request calls their conceptual strengths
`local`, `live`, and `machine`. The separate header **Reload** re-reads the active view and
starts no checks. The former **Check again** local host-health button is folded into Refresh.

`POST /api/refresh` starts one explicit operation with a bounded JSON body: `strength` is
required; `projectTrees` is an optional boolean for `machine` only. The response is 202 with
`started: true` and the operation state, or 409 with the current state when work is already
running. The server requires the per-session `x-dash-token` header and same-origin mutation
metadata; a query token cannot authorize this POST. `GET /api/refresh` reads the latest state
without starting work. That state has an `operationId`, strength, timestamps, running/completion
fields, and sanitized stage progress, but no stage results. `GET /api/system`,
`GET /api/system/summary`, `GET /api/maintenance`, and the host-health read remain reads:
legacy refresh/scan query arguments are rejected, and `/api/host-health/local` was removed.
The separate consent-gated `POST /api/host-health/connection` remains.

The dashboard runs the shared `runRefresh` stage order from `src/lib/refresh.mjs`:

| Strength | Ordered stages |
|---|---|
| `local` (Refresh) | Maintenance evidence → inventory → local evidence and versions |
| `live` (Refresh live) | Maintenance evidence → inventory → live checks → local evidence and versions |
| `machine` (Refresh machine) | Machine measurement → Maintenance evidence → inventory → local evidence and versions |

A failed machine measurement skips its dependent Maintenance and inventory stages; the local
stage still runs. Other stage failures do not stop later stages. Machine measurement can include
project trees when explicitly selected. The Maintenance stage scans provider evidence; inventory
rebuilds after it; local collects status and forces the host-readiness check. These stages use
the existing Maintenance scan and footprint stores, not a merged evidence store.

`createRefreshOperation` holds one current operation in one dashboard server process.
Two tabs connected to that server share its single-flight state, so a concurrent POST gets 409.
This is volatile process state, with neither durable operation history nor distributed mutual
exclusion across servers. The client retains its accepted `operationId` and reports a result
only for that identity. If its POST response is lost or another operation supersedes the
server's latest state, the page may say its outcome is unavailable; it does not claim the
other operation's result.

## Relationship to ADR-0048

ADR-0048's separate **Refresh evidence** and **Re-measure machine** dashboard controls are
superseded by the single Refresh control above. Its Inventory/Guidance/Discovery/Activity
workspace, scan storage (`scan-store.mjs`), evidence semantics, and guarded management
actions remain. The CLI equivalents delivered in 6b are `ak maintain --refresh` and
`ak maintain --refresh=machine`. The control unifies the user's start path, not the
underlying storage or age rules. `src/lib/host-health-evidence.mjs` also remains outside the
shared evidence envelope.

## Known limitations (recorded, not fixed, by this branch)

1. **Resolved in Branch 6b, refined in V4 A3: failed version lookups retain recorded evidence without claiming a new observation.** A total failed lookup of managed packages, Brain, or ruvector keeps its cached candidate and restamps `last` for one retry per configured TTL; `observedAt` remains the time that candidate was actually seen. The kit follows that rule when its cached candidate is usable. A partial answer that leaves the kit's cached candidate winning, or a stable install whose cached `next` candidate is unusable, keeps `last`, `observedAt`, and `best` unchanged and separately records `versionCheck.self.attempt` with its time and exact channel tags. Successful and total-failure kit lookups record `lastTags`, the channel scope of `last`; changing from stable to prerelease therefore probes an untried `next` channel even within the prior TTL. Legacy records without `lastTags` are reused for the single `latest` channel or where a `next` winner proves it was checked; a legacy `latest` winner cannot suppress an untried `next`. Malformed or future attempt metadata cannot suppress retries. `force` bypasses freshness. `record: false` permits a lookup without saving its result or attempt, while `cacheOnly: true` performs neither a lookup nor a write.
2. **`globalRoot()`'s `record`-persistence structural fragility** — see "The `npm-global-root`
   exception" above.
3. **Task 9's dashboard timeout bounds async hangs only** — see "The dashboard poll's two cost
   fixes" above.
4. **`ak x aqe-embedding verify` does not persist evidence** — see the correction above; this was
   never actually true even before this branch, but the original program plan assumed otherwise.
5. **`src/lib/host-health-evidence.mjs` (ADR-0053's setup proofs) is not folded into this store** —
   a known, deliberate gap, not a silent omission; see "What is deliberately not folded into this
   store" above.

## Consequences

### Positive

- A plain `ak status` and the dashboard's 30-second poll no longer spawn processes on every call —
  the originating Review Focus item is closed and measured (14 → 0 spawns; the warm payload stayed
  within the cost test's byte-size budget of the cold one).
- One age rule, one directory layout, and one parameter contract (`refresh`/`record`/`source`) for
  every new local-probe evidence kind, instead of each check inventing its own caching (or none).
- `--refresh` now actually reaches every local probe `ak status` performs, not just
  ruflo-components (its only pre-branch scope).
- The `inputs`-alongside-the-hash design in the envelope means a later branch can add
  "what changed" diagnostics without a schema migration.

### Negative

- Two genuinely different evidence-storage code paths now exist under the same `evidence/`
  directory: the generic envelope (`evidence.mjs`) and `npm-global-root`'s hand-written,
  byte-compatible-but-separate local envelope in `paths.mjs`. A future reader who assumes every
  file under `evidence/` was written by `readEvidence`/`writeEvidence` will be wrong for two of the
  ten directories (`npm-global-root` and `ruflo-component`).
- A plain `ak status` is no longer *literally* read-only in the strictest sense: a cold evidence
  cache means a first run writes a small, private, inert cache file under
  `<state>/agentic-kit/evidence/`. This is intended (the alternative is spawning on every plain
  status call, the exact problem this branch closes), and is stated precisely in `ak status
  --help` rather than left as an imprecise "it changes nothing" claim. `ak sync --dry-run` is not
  an example of this: its plan-read `collect()` call and (as of Branch 6b) every online version
  lookup it previews all pass `record: false`, so a dry run writes no evidence under
  `<state>/agentic-kit/` — proven by a whole-HOME/whole-project byte-for-byte snapshot comparison
  in `tests/kit/sync-command.test.mjs`. It is not silent at the OS level, though: `previewPlanVersions`
  (`src/commands/sync/plan-versions.mjs`, Ruling R8) creates a per-run npm cache under the OS temp
  folder for its redirected `npm view` calls and removes it in a `finally` block once the lookups
  are done; a crash between those two points can leave one `ak-sync-preview-npm-*` folder behind.
  `ak x verify` is retired; its replacement,
  `ak status --refresh=live`, is an explicit refresh, not a read, and its writes are the point,
  not a surprise.
- The `record`-defaults-`false` exception for `npm-global-root` is a real asymmetry a future
  evidence-kind author needs to know about before assuming every kind defaults `record: true`.
