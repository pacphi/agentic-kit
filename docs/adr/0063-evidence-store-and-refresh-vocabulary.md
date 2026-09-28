# ADR-0063 — One evidence store and the refresh vocabulary

- **Status:** Accepted
- **Date:** 2026-09-28
- **Deciders:** agentic-kit maintainers
- **Related:** [ADR-0025](0025-machine-footprint-metrics.md) (`/api/system/summary` projection),
  [ADR-0048](0048-inventory-led-maintenance-resource-management.md) (Maintenance's own, separate
  scan controls), [ADR-0053](0053-host-setup-evidence-and-usage-diagnostics.md) (host setup
  checks), [ADR-0055](0055-aqe-embedding-lifecycle.md) (live-check evidence), [ADR-0058](0058-managed-ruflo-components.md)
  (ruflo-component evidence), the
  [issues 237–239 audit record](../audits/2026-09-26-issues-237-238-239-verification-and-decisions.md)
  (Review Focus: a 30-second dashboard poll spawning processes on every tick)
- **Amends:** [ADR-0025](0025-machine-footprint-metrics.md) §5 (cross-reference only — Task 11
  already recorded its own `Updated:` line), [ADR-0055](0055-aqe-embedding-lifecycle.md)
  (live-check evidence storage relocation, mechanical), [ADR-0053](0053-host-setup-evidence-and-usage-diagnostics.md)
  (host setup checks are now persisted evidence with an age rule)
- **Supersedes:** [ADR-0048](0048-inventory-led-maintenance-resource-management.md)'s use of the
  word "evidence" for its own, separate **Refresh evidence** / **Re-measure machine** scan
  controls — terminology only; see "Relationship to ADR-0048" below. Their UI, backing code
  (`scan-store.mjs`), and evidence semantics are unchanged by this branch.

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
  always-persist behavior, so no existing caller (heal, `ak x verify`, `ak setup`, the
  post-command drift nudge) needed a code change merely to keep working exactly as before. Only
  `status.mjs`'s `collect()` and `dashboard-server.mjs`'s in-process call (Task 9) pass `refresh`
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
paper over it. Every other caller (`ak status`, the dashboard poll, `ak status --refresh`, `ak x
verify`, `ak setup`) keeps `record: true` and persists as designed, unaffected by any of this.

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
  files, entirely their own system, `--refresh=machine`'s eventual domain (Branch 6b). Not moved,
  not touched.
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
live-check evidence row are `ak x verify`'s own `aqe-embedding` check
(`src/commands/x/verify.mjs:625,697`, `source: 'verify'`/`'status-live'`) and `ak sync`'s
post-sync check (`src/commands/sync.mjs:672`, `source: 'sync'`). `ak status`'s "last remembered
live check" row (which Task 2's storage move does cover, via the shared `evidence/live-check/`
directory) reflects whichever of those two last ran — `ak x aqe-embedding verify` run on its own
updates neither `kit.json` nor the evidence store; it is a one-shot, unpersisted probe. This is a
factual correction to the branch plan's own assumption, not a defect: `aqe-embedding.mjs`'s
`verify` action was never meant to be a persisted check (it exists for a synthetic backend proof
with no downloads or corpus writes), and nothing in this branch changed that.

### The interim `--refresh` boolean's scope

Today `--refresh` covers ruflo-component evidence (pre-existing, unchanged by this branch),
native-runtime/host-setup/companion-lifecycle (Tasks 4–5), version-drift (Task 6), and
npm-global-root/daemon-sweep/ak-launcher/the deduped host-presence check (Task 7's sweep). This is
the interim, no-suffix tier of Branch 6b's eventual `--refresh[=live|machine]` split; this branch
builds only the boolean groundwork that split will sit on, not the flag syntax itself.

`--refresh` and `--live` are separate flags, but not perfectly independent in effect. `--refresh`
never itself triggers a live (network-round-trip) check: `status.mjs`'s `run()` calls
`collect({ refresh: !!flags.refresh })` and the `--live` suite as two unrelated steps, and neither
threads into the other. The converse does not hold, though: `--live`'s own `providers` check
(`verifyProviders` in `x/verify.mjs`, unchanged by this branch) calls
`collectIntegrationFacts({ cwd, cfg })` with no `refresh` argument, so it defaults to `refresh:
true` (Ruling B) and always re-probes and persists `host-setup` evidence as a side effect of
`--live` — regardless of whether `--refresh` was also passed. This is pre-existing behavior this
branch did not change (Task 4/5's fix round found this exact call site and confirmed it already
defaulted correctly, so no code change was needed there); it means `--live` is not purely additive
to `--refresh`'s local-probe question the way the flag names might suggest.

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

## Delivered in 6a vs. pending 6b

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
- The interim, no-suffix `--refresh` boolean covering every kind above.

**Explicitly not built in this branch, still ahead in Branch 6b:**

- The `--refresh[=live|machine]` flag syntax itself (today there is only one boolean, covering the
  "live" tier's kinds).
- Any dashboard UI control naming this distinction.
- Folding Maintenance's `scan-store.mjs`/deep-snapshot system, or ADR-0048's **Refresh evidence** /
  **Re-measure machine** controls, into this evidence store — they remain their own system.
- `ak x verify`'s command surface being re-expressed in terms of this evidence store beyond what it
  already does today (recording the `live-check` rows it always has).

## Relationship to ADR-0048

ADR-0048's **Refresh evidence** and **Re-measure machine** dashboard controls predate this branch
and use the word "evidence" in the Maintenance-inventory sense (provider probes feeding the
Inventory/Guidance/Discovery/Activity workspace), which is conceptually adjacent to — but a
genuinely separate system from — the evidence store this ADR describes. This ADR's evidence store
is the eventual "live" tier's technical precursor and this branch's own interim `--refresh` boolean
is its no-suffix groundwork; ADR-0048's own controls, their backing code (`scan-store.mjs`), and
their UI are unchanged by this branch. No file under Maintenance's own scan system was touched by
Tasks 1–11. A reader should not infer that ADR-0048's controls now share code, storage, or an age
rule with this ADR's evidence store — they do not, yet.

## Known limitations (recorded, not fixed, by this branch)

1. **`ruvector.mjs`/`ruvnet-brain.mjs`'s `drift()` can silently drop a known update on a failed
   forced fetch.** Both unconditionally `saveKitConfig()` after any non-fresh attempt, including a
   failed one, overwriting a good cached `latest` with `null` (unlike `versions.mjs`'s
   `driftReport()`, which correctly falls back to the cached value on failure). This is a
   pre-existing defect in both library functions, not introduced by this branch — but Task 6's
   wiring fix makes it reachable, for the first time, from `ak status --refresh`: an offline or
   flaky-network `ak status --refresh` can now make a real "update available" row disappear from
   status for up to 24h, with no error surfaced. Queued as a follow-up fix (mirror
   `driftReport`'s cached-fallback-on-failure pattern in both libraries), out of this branch's
   scope, ledgered in `progress.md` for a later branch (Branch 9 or a small standalone fix).
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
- `ak status`, `ak sync --dry-run`, and `ak x verify` are no longer *literally* read-only in the
  strictest sense: a cold evidence cache means a first run under any of them writes a small,
  private, inert cache file under `<state>/agentic-kit/evidence/`. This is intended (the
  alternative is spawning on every dry-run/verify too, the exact problem this branch closes), and
  is now stated precisely in `ak status --help` (see the docs section below) rather than left as
  the previous, now-imprecise "it changes nothing" claim.
- The `record`-defaults-`false` exception for `npm-global-root` is a real asymmetry a future
  evidence-kind author needs to know about before assuming every kind defaults `record: true`.
