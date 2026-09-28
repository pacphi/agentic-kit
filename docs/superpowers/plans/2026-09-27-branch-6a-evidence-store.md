# Branch 6a code-level plan — `refactor/evidence-store`

> Drafted by a read-only planning pass against the `refactor/evidence-store` worktree at
> `f3106a8c` (main tip, v4.0.0-alpha.58). Executed with superpowers:subagent-driven-development.

**Spec:** [docs/superpowers/plans/2026-09-26-remediation-program.md](2026-09-26-remediation-program.md)
(Wave 3, Branch 6a), the
[237-239 audit record](../../audits/2026-09-26-issues-237-238-239-verification-and-decisions.md)
(Decision 9; Addendum 3 Item 4), [ADR-0062](../../adr/0062-aqe-project-store-integrity.md),
ADR-0048 §§5-8, ADR-0055 (both 2026-09 amendments), ADR-0025 §5,
`.superpowers/sdd/2026-09-26-remediation-program/reports/b3-adversarial.md` (F6/F7, out of scope
here — Branch 9).

Code read in the worktree: `src/commands/status.mjs`, all 33 files under
`src/commands/status/sections/`, `src/commands/status/deja-vu.mjs`, `src/commands/x/verify.mjs`,
`src/commands/x/aqe-embedding.mjs`, `src/commands/sync.mjs`, `src/lib/dashboard-server.mjs`,
`src/lib/dashboard/client/poll.mjs`, `src/lib/dashboard/client/maintenance-workspace.mjs`,
`src/lib/dashboard/client/system-maintenance.mjs`, `src/lib/dashboard/system-summary.mjs`,
`src/lib/live-check-evidence.mjs`, `src/lib/host-health-evidence.mjs`, `src/lib/host-readiness.mjs`,
`src/lib/host-readiness-probes.mjs`, `src/lib/ruflo-components/{evidence,apply,snapshot}.mjs`,
`src/lib/natives.mjs`, `src/lib/providers.mjs`, `src/lib/versions.mjs`, `src/lib/ruvector.mjs`,
`src/lib/ruvnet-brain.mjs`, `src/lib/adapters/deja-vu.mjs`,
`src/lib/maintenance/management/preferences.mjs`, `src/lib/exec.mjs`, `src/lib/paths.mjs`, and
existing tests (`tests/kit/live-check-evidence.test.mjs`, `ruflo-components-evidence.test.mjs`,
`host-readiness*.test.mjs`).

## Global Constraints

- Commits carry no `Co-Authored-By` or other attribution trailer.
- Nothing is pushed, opened as a pull request, merged, posted upstream, or created as a cloud
  routine without the maintainer's explicit go-ahead for that action.
- Upstream publication follows the constraint registry's `issuePublication:
  explicit-user-approval-required`.
- Never run `pnpm` in a worktree whose `node_modules` is a symlink; use `node --test`,
  `npx eslint`, `npx tsc -p tsconfig.json`, `npx markdownlint-cli2` and `node scripts/build-check.mjs`.
- Disposable environments use `env -u XDG_CONFIG_HOME -u XDG_DATA_HOME -u XDG_CACHE_HOME
  -u XDG_STATE_HOME` (or `env -i`), a `mktemp -d <template>` inside the scratch area, and assert
  every created path lies inside it.
- Tests never write real user state: not the repository's `.claude`/`.swarm`, not
  `~/.config/agentic-kit`, not `~/.local/state/agentic-kit`, not any real memory store.
- Runtime assets live under `src/` and are proven shipped with `npm pack --dry-run`.
- User-facing docs describe the current state only; history lives in ADRs and audit records;
  every branch passes the six-class documentation gate.
- An ADR a branch changes gets its status, an `Updated` date and a one-line note in the same
  branch. **This branch touches ADR-0048, ADR-0025, ADR-0055, ADR-0058 and ADR-0053** (ADR-0058
  owns the ruflo-components evidence cache this branch relocates; ADR-0053 owns the host
  setup-evidence concept this branch persists).
- Ruflo support window: n-5, at least 30 days, rolling.
- Never message a running workflow or background agent; start a fresh one instead.
- Review Focus, carried into this branch's own tests: **"Dashboard cost. The 30-second poll must
  not start more processes or transfer more data than before a branch"** — Task 9's assertion
  pins both processes and bytes.

## The evidence-record contract (used by every task below)

One **envelope**, shared by every kind; kinds differ only in their `result` payload. New module
`src/lib/evidence.mjs`:

```js
/** @typedef {{
 *   version: 1,
 *   kind: string,           // 'live-check' | 'ruflo-component' | 'host-setup' | 'native-runtime'
 *                           // | 'companion-lifecycle'
 *   id: string,             // kind-scoped: 'aqe-embedding' | 'machine' | 'claude' | '@claude-flow/memory'
 *   source: string,         // 'sync' | 'verify' | 'status-live' | 'status-refresh' | 'setup'
 *   checkedAt: string,      // ISO
 *   inputsKey: string,      // stable hash — see stableInputsKey()
 *   inputs: object,         // the plain object the hash covers (not just the hash)
 *   result: object,         // kind-specific payload
 * }} EvidenceRecord */

export function evidenceFile(kind, id) { /* evidenceDir()/<kind>/<sanitized id>.json */ }
export function writeEvidence(kind, id, { source, inputsKey, inputs, result }, { now } = {}) { /* writePrivateFileAtomic; returns boolean like recordLiveCheck */ }
export function readEvidence(kind, id, { inputsKey, maxAgeMs, now } = {}) { /* returns null or {..., ageMs, stale, invalidated} */ }
export function stableInputsKey(parts) { /* generalizes live-check-evidence.mjs's stable()+digest() */ }
export function describeAge(ms) { /* generalizes formatLiveCheckAge */ }
```

`inputs` is stored **alongside** `inputsKey`, not only the hash — this is what lets Branch 6b
answer "which host setting was in effect when this was recorded" (the `readLimits`/
`codex app-server` decision) without a schema change: a host-setup record's `inputs` includes
`{codexEnabled: cfg.integrations.hosts.codex}` even though 6a does not yet act on it.

Storage: `paths.mjs` gains `export const evidenceDir = () => path.join(stateBase(), 'agentic-kit',
'evidence');` (same pattern as the existing `maintenanceControlDir`/`hookHealingTransactionsDir`/
`aqeStoreMergeDir` exports). One file per `(kind, id)`, so two producers writing different ids at
once (a sync and a `status --refresh` in another shell) never clobber each other.

**Age rule, one rule:** `stale = ageMs > maxAgeMs` (kind supplies `maxAgeMs`; no kind gets a
second, hidden threshold — see Task 3 for how the ruflo-components 15-minute "skip re-probe"
window is reconciled into a producer-side option, not a second display threshold).
`invalidated = inputsKey mismatch` (configuration changed since the check ran).

**What is deliberately NOT folded into this store** (stated in ADR-0063 so a reviewer does not
read it as an oversight):

- **Version drift** (`versions.mjs` `versionCheck.seen/self`, `ruvector.mjs` `versionCheck.ruvector`,
  `ruvnet-brain.mjs`'s own cache) keeps its existing `kit.json`-embedded TTL cache. Only its
  **gating** changes (Task 6).
- **The paid host connection-check proof** (`host-readiness.mjs`'s `proofs`/`tokens` Maps) stays
  in-process, unpersisted, 15-minute-capped, consent-gated — Decision 9's explicit design.
- **Maintenance scans** (`scan-store.mjs`'s `asOf`, footprint's deep snapshot) stay in their own
  files — `--refresh=machine`'s domain (6b). `describeAge`/`isStale` are written kind-agnostic
  enough that a later branch *can* point scan-store's `asOf` through them; 6a does not move it.
- **Health-history's ring** (`health-history.mjs`) is a trend log, not current evidence; out of
  scope.

## The classification (the crux)

| Check | Where today | Spawns on plain `ak status`? | Kind | 6a treatment |
|---|---|---|---|---|
| AQE embedding, MCP init, providers, security, deja-vu structural, memory round-trip | `live-check-evidence.mjs`, `x/verify.mjs` `LIVE_CHECKS` | No — already gated (`ak status --live` only) | live-check | Generalize storage onto `evidence.mjs` (Task 2), behavior unchanged |
| Ruflo component doctor/route/intelligence/neural/funnel (one joint probe) | `ruflo-components/evidence.mjs` `collectEvidence` | No — gated on `--refresh` in `status/sections/ruflo-components.mjs:68` | ruflo-component | Generalize storage (Task 3), behavior unchanged |
| Native runtime load test (`node -e` per memory context) | `natives.mjs` `probeBsq3Runtime`, called unconditionally from the `natives` section | **Yes — every call, no gate at all** | native-runtime | New evidence kind, gate behind `--refresh` (Task 4) |
| Host install state / `--version` launch | `providers.mjs` `hostInstallState`/`hostExecutable` | **Yes — every call, no gate at all** | host-setup | New evidence kind, gate behind `--refresh` (Task 5) |
| Deja-vu `doctor --json --offline` | `adapters/deja-vu.mjs:214` | **Yes — every call, no gate at all** | companion-lifecycle | Folded into Task 5's sweep (Task 5b) |
| `npm view` for ruflo/self/ruvector, GitHub release check for the Brain | `versions.mjs driftReport`, `ruvector.mjs drift`, `ruvnet-brain.mjs` release cache | **Yes, whenever the TTL window has elapsed** | version-drift (kept in `kit.json`) | Add a `probe` gate so plain status never crosses the TTL boundary into a live call (Task 6) |
| Maintenance scan (`asOf`, coverage) | `maintenance/scan-store.mjs`, footprint deep snapshot | No — already `?refresh=deep`/`--deep` only | scan | Untouched; out of scope |
| Paid host connection check | `host-readiness.mjs` in-process Maps | No — consent-gated | connection-proof | Untouched by design |

The `natives`/`hosts`/`deja-vu`/`versions`/`ruvector`/`ruvnet-brain` row is exactly Addendum 3
Item 4's complaint, confirmed by code read rather than restated from prose.

## Tasks

### 1. `refactor(evidence): add the shared evidence envelope and age rule`

- Create: `src/lib/evidence.mjs` — `evidenceFile`, `writeEvidence`, `readEvidence`,
  `stableInputsKey`, `describeAge` (contract above).
- Modify: `src/lib/paths.mjs` — add `evidenceDir()`.
- Test: `tests/kit/evidence.test.mjs` (new) — round-trip write/read, `stale` past `maxAgeMs`,
  `invalidated` on inputsKey mismatch, unwritable directory returns `false` from `writeEvidence`
  rather than throwing (mirrors `recordLiveCheck`'s existing contract), per-id file isolation.
- No call sites replaced yet — pure new module, proven standalone.

### 2. `refactor(evidence): move live-check storage onto the shared envelope`

- Modify: `src/lib/live-check-evidence.mjs` — `recordLiveCheck`/`readLiveCheck` become thin
  wrappers over `writeEvidence('live-check', id, …)`/`readEvidence('live-check', id, …)`;
  `LIVE_CHECK_TTL_MS` becomes the `maxAgeMs` passed through. Every exported name
  (`recordLiveCheck`, `readLiveCheck`, `rememberLiveCheck`, `describeLiveCheck`, `liveCheckLevel`,
  `formatLiveCheckAge`, `LIVE_CHECK_IDS`, `liveCheckInputsKey`, `embeddingCheckOutcome`,
  `embeddingProbeOutcome`) is preserved so every existing call site
  (`x/verify.mjs`, `sync.mjs:672`, `status/sections/{aqe,live-checks}.mjs`) needs zero changes.
- Storage moves from `<stateBase>/agentic-kit/live-checks/<id>.json` to
  `<stateBase>/agentic-kit/evidence/live-check/<id>.json`. No migration shim: a cold cache on
  upgrade just means the next sync/verify/`--live` run repopulates it.
- Test: `tests/kit/live-check-evidence.test.mjs` (existing) passes unmodified against the new
  internals; add one assertion that the file lands under `evidence/live-check/`.

### 3. `refactor(evidence): move ruflo-component evidence onto the shared envelope`

- Modify: `src/lib/ruflo-components/evidence.mjs` — `readEvidenceCache`/`writeEvidenceCache`
  become thin wrappers over `readEvidence('ruflo-component', 'machine', …)`/
  `writeEvidence('ruflo-component', 'machine', …)`. `collectEvidence` stays a **single record with
  id `'machine'`** (one joint probe, not six independent ones).
- Modify: `src/lib/ruflo-components/apply.mjs:198-208` (`classify`) — `EVIDENCE_STALE_MS` (24h)
  becomes the shared `maxAgeMs`. `EVIDENCE_TTL_MS` (15 min) stays a **producer-side** parameter:
  `classify()` still skips a re-probe under `--refresh` when the existing record is fresher than
  15 minutes (unless `o.changed`) — a "don't re-probe if we just did" optimization inside the
  refresh path, not a second reader-facing staleness tier. State this in the module's own comment.
- Storage moves from `<stateBase>/agentic-kit/ruflo-components-evidence.json` to
  `<stateBase>/agentic-kit/evidence/ruflo-component/machine.json`. No migration shim.
- Test: `tests/kit/ruflo-components-evidence.test.mjs` (existing) passes unmodified; add coverage
  for the reconciled `classify()` behavior.

### 4. `perf(status): stop spawning a native load test on every plain status call`

- Modify: `src/lib/natives.mjs` — `rufloRuntimeNatives` no longer calls `probeBsq3Runtime`
  unconditionally. New shape: `rufloRuntimeNatives({ refresh = false })` — when `refresh` is
  false, read `evidence.mjs`'s `readEvidence('native-runtime', context, { inputsKey, maxAgeMs })`
  for each memory context (`inputsKey` = the resolved `dir` path + `bsq3IsNative(dir)` boolean);
  when true, probe and `writeEvidence` per context.
- Modify: `src/commands/status/sections/natives.mjs` — `collect({ refresh })` threads the flag
  through; when no evidence exists yet, the row reads "native runtime unchecked; run
  `ak status --refresh`" (`info`, matching the existing "no verdict" convention).
- Modify: `src/lib/heal.mjs`'s native heal path to also `writeEvidence` after it repairs.
- Test: `tests/kit/natives.test.mjs` (existing, extend) — plain `collect()` with a fake
  `readEvidence` shows the last record and spawns nothing; `collect({ refresh: true })` spawns
  and records; a changed `bsq3IsNative` result invalidates a stale record even under
  `refresh:false`.

### 5. `perf(status): stop spawning host --version and deja doctor on every plain status call`

Split into 5a (host install/executable) and 5b (deja-vu detect), same pattern, landed together
because both feed Task 8's "zero spawns" guarantee.

**5a — hosts:**

- Modify: `src/lib/providers.mjs` — `hostInstallState(host, { refresh = false })`: when `refresh`
  is false, read `readEvidence('host-setup', host.id, { inputsKey, maxAgeMs })` (inputsKey covers
  the host's resolved PATH binary path + mtime); when true, run the existing probe and
  `writeEvidence`.
- Modify: `collectIntegrationFacts({ cwd, cfg, env, refresh = false })` (status.mjs:89's call site
  becomes `collectIntegrationFacts({ cwd, cfg, refresh })`) — thread `refresh` into `detectHosts`
  → `hostInstallState`.
- Modify: `src/commands/status/sections/hosts.mjs` — `installedHostRows` stops calling
  `deps.executable(h)` directly; it reads the evidence record `collectIntegrationFacts` already
  populated (via `ctx.integrationFacts`), removing the section's own redundant second probe.
- Modify: `src/commands/status.mjs:89-90` — pass `refresh` into `collectIntegrationFacts`.
- Test: `tests/kit/providers.test.mjs` and `tests/kit/status-sections/hosts.test.mjs` (existing,
  extend) — plain collect spawns nothing; `--refresh` spawns once per enabled host, not twice.

**5b — deja-vu:**

- Modify: `src/lib/adapters/deja-vu.mjs` — the `detect` action's `doctor --json --offline` spawn
  (line 214) becomes conditional: `detect({ cfg, refresh = false })` reads
  `readEvidence('companion-lifecycle', 'deja-vu', …)` when `refresh` is false, probes and records
  when true. The install-presence portion of `detect` stays unconditional (config/file kind).
- Modify: `src/commands/status/deja-vu.mjs` — `collectDejaVuRows({ cfg, adapter, planOptions,
  refresh = false })` threads `refresh` to `adapter.detect`.
- Modify: `src/commands/status.mjs:94-96` — pass `refresh` into `collectDejaVuRows`.
- Test: `tests/kit/deja-vu-adapter.test.mjs` (existing, extend) — plain `detect()` spawns nothing
  when evidence exists; `refresh:true` spawns and records.

### 6. `fix(versions): never cross the network from plain status`

- Modify: `src/lib/versions.mjs` — `driftReport({ probe = false } = {})`: when `probe` is false,
  every package read is cache-only (no `npm view`, however stale the TTL); the returned row still
  carries `outdated`/`latestSource: 'cache'|'cache-fallback'`, just never triggers the network
  branch. When `probe` is true (today's unconditional behavior), unchanged.
- Modify: `src/lib/ruvector.mjs` `drift({ probe = false } = {})` and `src/lib/ruvnet-brain.mjs`'s
  release-check function — same `probe` parameter, mirroring the existing `force` parameter's
  shape (`force` = bypass TTL and hit network even if fresh; `probe` = hit network at all).
- Modify: `src/commands/status/sections/versions.mjs`, `ruvector.mjs`, `ruvnet-brain.mjs` — each
  threads `ctx.refresh` into its `drift`/`driftReport` call as `probe`.
- Note: this changes what plain `ak status` reports when the TTL has elapsed (last known value +
  age, not a fresh network answer) — exactly Addendum 3 Item 4's recommended design, not a
  regression.
- Test: `tests/kit/versions.test.mjs`, `tests/kit/ruvector.test.mjs`, `tests/kit/ruvnet-brain.test.mjs`
  (existing, extend) — plain collect with a stale kit.json TTL entry does not invoke the injected
  network runner; `--refresh` does.

### 7. `refactor(status): thread refresh through collect() and close the spawn gap`

- Modify: `src/commands/status.mjs` — `collect({ pkgRoot, cwd, dejaVuAdapter, dejaVuPlanOptions,
  refresh = false })` already accepts `refresh`; this task is the integration pass plus a sweep of
  every other section module not individually verified in the research pass (`agent-browser.mjs`,
  `codex-mcp.mjs`, `codex-plugins.mjs`, `codex-context.mjs`, `qe-court.mjs`, `scaffold-agents.mjs`,
  `memory-pin.mjs`, `providers-*.mjs`, `models.mjs`, `learning.mjs`, `daemons.mjs`, `routing.mjs`,
  `context.mjs`, `mcp.mjs`, `user-memory.mjs`, `project-memory.mjs`, `statusline.mjs`, `self.mjs`,
  `blocks.mjs`, `npx.mjs`).
- This sweep is **test-first, not read-first**: Task 8's spawn-ledger assertion is written and run
  against `collect({ refresh: false })` *before* this task's fixes; whatever it reports as a
  nonzero spawn beyond the five already-fixed offenders becomes this task's remaining checklist.
- Any newly discovered offender gets the identical treatment as Tasks 4-6: read evidence when
  `refresh` is false, probe and record when true, using whichever evidence kind fits (a new kind
  if none fits).
- Test: extend whatever module-level test each newly-fixed section already has; no new test file
  unless a genuinely new evidence kind is introduced.

### 8. `test(status): assert zero subprocess spawns and stable payload size on plain status`

- Create: `src/lib/spawn-ledger.mjs` (new, tiny) — when `process.env.AK_SPAWN_LEDGER` is set,
  `exec.mjs`'s `run()` appends one line (`{cmd, args, at}`) to that path before resolving; when
  unset, zero overhead, zero behavior change.
- Modify: `src/lib/exec.mjs` — `run()` calls `spawn-ledger.mjs`'s `recordSpawn()` (no-op unless
  the env var is set) right before `pexecFile`/`spawn`.
- Test: `tests/kit/spawn-ledger.test.mjs` (new) — silent with the env var unset; one line per
  `run()` call when set, in a disposable temp file.
- Test: `tests/kit/status-zero-spawn.test.mjs` (new) — runs `status.collect({ refresh: false,
  pkgRoot })` inside a disposable home with `AK_SPAWN_LEDGER` pointed at a scratch file; asserts
  the file is empty/absent after collection. Written **before** Tasks 4-6 land (fails first,
  naming the offenders), turns green once they and Task 7's sweep are complete. Sequenced last
  because it depends on `evidence.mjs` (Task 1) existing.
- Test: `tests/kit/dashboard-status-cost.test.mjs` (existing or new, extend) — the Review Focus
  assertion: after Task 9, `/api/status` served twice in a row starts zero child processes (via
  the same ledger, dashboard server started as a child) and the second response's byte size is
  within a fixed budget of the first.

### 9. `perf(status): compute dashboard status in-process instead of shelling out`

- Modify: `src/lib/dashboard-server.mjs` — replace `shellOutStatus(cwd)` (the `execFile` of
  `bin/agentic-kit.mjs status --json`) with a direct call: `() => status.collect({ pkgRoot:
  PKG_ROOT, cwd, refresh: false }).then(rows => ({ overall: worstOf(rows), rows }))`, reusing
  `status.mjs`'s own worst computation (extracted as an exported `worstLevel(rows)`). The
  `fetchStatus` injection seam name is unchanged, so every existing dashboard test that injects a
  fake `fetchStatus` keeps working untouched.
- Safe **only because** Tasks 4-7 already made `collect({ refresh: false })` spawn nothing.
- Remove: the `execFile`/spawning plumbing in `dashboard-server.mjs` that only existed to run that
  child process (keep `PKG_ROOT` itself).
- Update the module's own header comment — it currently documents the shell-out as the design;
  that paragraph must describe the in-process call instead.
- Test: `tests/kit/dashboard-server.test.mjs` (existing, extend) — `/api/status` returns the same
  shape with the injection seam unchanged; the zero-spawn and payload-size assertions from Task 8
  now run against the real server.

### 10. `fix(dashboard): stop writing Maintenance preferences on every poll tick`

Root cause: `maintenance-workspace.mjs:397-402`'s `loadMaintenanceWorkspace(force)` calls
`mntSavePreferences({lastView: {...}})` unconditionally at the end of every call, and
`poll.mjs:155` calls `loadMaintenance(true)` on every tick while the Maintenance tab is open.

- Modify: `src/lib/dashboard/client/maintenance-workspace.mjs` — track the last-saved `lastView`
  in module state (`var mntLastSavedView = null`); the final `.then()` compares the current
  `{scope,view,sort,facets,search}` against it with a plain deep-equal and calls
  `mntSavePreferences` only on a difference, updating `mntLastSavedView` after a successful save.
- Modify: `src/lib/maintenance/management/preferences.mjs` — server-side guard: `savePreferences(partial)`
  computes `next` (as today) and skips the `writeAll` call (returns `next` unchanged) when `next`
  deep-equals `current`.
- Test: `tests/kit/maintenance-preferences.test.mjs` (new) — `savePreferences` with an identical
  `lastView` does not call the injected `fsImpl.writeFileSync`/`writePrivateFileAtomic`; a
  genuinely different `lastView` does.
- Test: `tests/ui/maintenance-focus.mjs` or a new UI spec — polling the Maintenance tab twice with
  an unchanged view issues exactly one `POST /api/maintenance/v2/preferences`.

### 11. `perf(dashboard): measure, then slim, /api/system/summary`

Branch 0's real-machine pass recorded `/api/system/summary` still at ~2.26 MB after the
Decision 8 allow-list fix (`progress.md:34`, ledger-assigned to 6a). This must be measured, not
assumed, before deciding what (if anything) to cut.

- Step 1 (no product change): a disposable, read-only measurement — import `systemSummaryPayload`
  and run it over a **non-deep** footprint collector read (confirm first, by reading
  `src/lib/footprint/index.mjs`'s exported reader, that the non-deep path performs no writes) on
  the real machine, then report: total byte size, size per top-level key, average bytes per
  `items[]` entry, and the count of `items[]`. This must run on the real machine before Step 2 is
  scoped.
- Step 2 (conditional on Step 1's finding): if per-item bytes dominate, narrow `summaryItem`'s
  fields further, cross-checked against what `system-projects.mjs`/`system-maintenance.mjs`
  (the client modules that read `/api/system/summary`) actually reference. If `items[]` *count*
  dominates instead, the fix is page-side (out of this branch's scope; revisiting ADR-0025's
  "paging is more work than needed" call is a decision, not a task) — in that case this task's
  deliverable is the measurement plus a paragraph in ADR-0063 explaining the figure, with the
  number, not a code change.
- Test: whichever branch Step 2 takes gets a `tests/kit/system-summary.test.mjs` (existing,
  extend) byte-budget assertion — a fixture-shaped payload above a fixed threshold fails the test.

### 12. `docs(adr): ADR-0063 — one evidence store and the refresh vocabulary`

- Create: `docs/adr/0063-evidence-store-and-refresh-vocabulary.md`. Status: Proposed → Accepted
  within this branch, split explicitly into "Delivered in 6a" vs. "Pending 6b" so a reviewer does
  not read it as claiming the flag/dashboard-control/`ak x verify`-folding pieces shipped.
- Content: the envelope + age rule; the classification table; the explicit "not folded" list
  (version-drift, connection-proof, scans) with rationale; the interim `--refresh` boolean's
  behavior today vs. `--refresh[=live|machine]`'s eventual 6b shape (name it, don't build it); a
  placeholder note that `inputs` (not just `inputsKey`) is stored precisely so 6b's
  `readLimits`/Codex-host-setting decision has something to read later.
- **Supersedes**: ADR-0048's two scan controls ("Refresh evidence" / "Re-measure machine") —
  supersession is of their *evidence semantics* (now unified), not their UI (unchanged until 6b).
- **Amends**: ADR-0025 §5 (records this branch's `/api/system/summary` measurement result and any
  Task-11 field change) and ADR-0055 (records that live-check evidence storage relocated under the
  shared envelope; the amendment is purely mechanical — the live-check *behavior* ADR-0055
  documents is unchanged).
- Modify (Updated line only, one sentence each): ADR-0048, ADR-0025, ADR-0055, ADR-0058 (its
  evidence cache is now `evidence.mjs`-backed), ADR-0053 (host setup checks are now persisted
  evidence, not process-memory-only).
- Docs six-class gate: also touch `docs/DASHBOARD.md` (the poll-cost paragraph) and
  `ak status --help` text in `status.mjs` (the `--refresh` description should note it now covers
  hosts/natives/deja-vu/version checks, not only ruflo components).

## Rulings folded in after an advisor pass (before Tasks 4/5/8a were dispatched)

- **Ruling A — plain status/dashboard DOES re-collect an expired process-shaped check, on a long
  age window; it does not wait forever for `--refresh`.** Item 4's own table says plain status
  "re-collects quick local evidence only when it has expired"; Decision 9's "status never probes"
  and guardrail 5's "the dashboard's regular refresh stays non-live" are both about *live* (network
  round-trip) checks, not quick local subprocess checks. Tasks 4, 5a, 5b therefore do **not** gate
  the native-runtime/host-setup/companion-lifecycle probe behind `refresh` alone: the read path is
  "use cached evidence when `!stale && !invalidated`; otherwise probe and record, whether or not
  `refresh` was requested." `refresh: true` (from `ak status --refresh`, sync, heal, verify, setup)
  always forces a fresh probe; `refresh: false` (plain status/dashboard) only skips the probe when
  the existing record is still within its `maxAgeMs` and its `inputsKey` still matches. Each kind's
  `maxAgeMs` is measured in hours (native-runtime and host-setup: 6h; companion-lifecycle: 6h) —
  long enough that a 30-second poll never re-probes twice in the same sitting, short enough that a
  newly installed host or a rebuilt native binding resolves itself within the same working session
  without requiring `--refresh`. Task 8's zero-spawn assertions become: **zero spawns when
  evidence is fresh; exactly one spawn per kind when its evidence is stale, invalidated, or
  missing; a second consecutive poll immediately after the first spawns zero.** This still clears
  the Review Focus bar (today every poll spawns every kind, unconditionally).
- **Ruling B — the new `{ refresh }`/`{ probe }` parameters default to today's always-probe
  behavior, so no existing caller changes without an explicit code change.** `rufloRuntimeNatives`,
  `hostInstallState`, `driftReport` (and the `ruvector.mjs`/`ruvnet-brain.mjs` equivalents) default
  their new parameter to `true` — sync, heal, `ak x verify`, `ak setup`, and the post-command nudge
  call these functions with no changes and keep spawning exactly as before. Only `status.mjs`'s
  `collect()` and `dashboard-server.mjs`'s in-process call (Task 9) pass the parameter explicitly
  as `false`, which (per Ruling A) still probes when evidence is stale/invalidated/missing. Tasks
  4, 5, 6 each enumerate and confirm their non-status callers (`sync.mjs`, `heal.mjs`,
  `x/verify.mjs`, `setup.mjs`) still probe unconditionally, as an explicit review-checklist item.
- **Ruling C — the spawn-ledger seam moves out of `src/lib/exec.mjs`.** A repo-wide check
  (`grep -rln "child_process" src/`) found ~30 files spawning directly (`host-health-connected.mjs`,
  `quota.mjs`, `daemons.mjs`, `mcp-probe.mjs`, `execution/subprocess.mjs`, `execution/opencode.mjs`,
  the template `.cjs`/`.js` files run inside hooks, and more) — a ledger seam inside `exec.mjs`'s
  `run()` would under-count and let the zero-spawn test pass vacuously on any check that spawns a
  different way. Task 8a therefore has **no product-code change**: `spawn-ledger.mjs` is dropped
  entirely, and Task 9's `src/lib/exec.mjs` note about `spawn-ledger.mjs` is removed. Instead,
  `tests/kit/status-zero-spawn.test.mjs` runs `status.collect()` inside a child Node process
  launched with `--import` of a test-only preload module (`tests/helpers/spawn-guard.mjs`, new)
  that monkey-patches `node:child_process`'s `spawn`, `execFile`, `execFileSync` and `spawnSync` to
  append `{cmd, args, at}` to a ledger file named by an env var the test sets. This catches every
  spawn path regardless of which module makes it, needs no production code, and works identically
  for Task 8b's dashboard-as-child assertion (start the dashboard server itself as the child with
  the same preload).
- **Ruling D — never commit a red test.** The gate-every-2-3-tasks ruling above means a committed,
  currently-failing `status-zero-spawn.test.mjs` would break every gate run between 8a and the
  point Task 7's sweep turns it green, and would break bisect. Task 8a commits the test as
  `test.todo(...)` (or behind an opt-in env var, e.g. only asserted when
  `process.env.AK_EXPECT_SPAWN_FREE === '1'`), with the RED run's actual output (naming every
  offender: native-runtime, host-setup ×N hosts, companion-lifecycle, version-drift ×3) captured
  verbatim in the implementer's report, not in a committed failing test. Task 7 flips it to a real,
  enforced assertion once the sweep is complete. This mirrors Branch 5's own precedent for the
  #655 conformance test (`todo`, per `progress.md`'s Branch 5 entries).

### Non-blocking notes folded in for task dispatch prompts / reviewer lenses

- **Program-plan item 1 coverage gap.** Item 1 says every check records, "including
  `ak x aqe-embedding verify`, setup proofs and sync." No task above yet touches
  `src/lib/host-health-evidence.mjs` (ADR-0053's setup proofs) or confirms `src/commands/x/
  aqe-embedding.mjs` writes through the shared envelope. Task 2 (or a small Task 2b) must either
  fold `host-health-evidence.mjs` onto `evidence.mjs` the same way live-checks and ruflo-components
  were, or add it explicitly to the "deliberately not folded in" list in ADR-0063 with a stated
  reason — not silence. Confirm `x/aqe-embedding.mjs verify` already goes through
  `live-check-evidence.mjs` (Task 2's move covers it) before assuming it's covered.
- **Task 5a's `inputsKey`.** "Resolved PATH binary path + mtime" must be computed with a pure
  `fs`/`path` PATH scan (mirroring however `have()` already resolves a binary, or a new pure
  helper) — if computing the key itself shells out to `which`/`command -v`, plain status can never
  compute the key without spawning, which defeats the whole point.
- **Task 9 hazards**, now that `collect()` runs inside a long-lived server process instead of a
  disposable child: wrap each section's call with try/catch and a timeout (a thrown section used
  to only kill a short-lived child; it must not crash the dashboard server); assert every path
  computation actually honors the passed `cwd` and never falls back to `process.cwd()`; no section
  may call `process.chdir` or set `process.exitCode`, and no section may cache module-level state
  across requests for a different `cwd`/project. Add a fixture test asserting the in-process JSON
  is byte-for-byte identical to `ak status --json`'s CLI output for the same fixture (`run()` may
  post-process beyond what `collect()` returns).
- **Decided spawns on other dashboard routes are the poll's real baseline, not zero.** Decision 1's
  automatic tool-level checks for an unmanaged host, and `readLimits` starting `codex app-server`
  regardless of the Codex host setting, are existing, decided behavior on other routes. Task 8b's
  dashboard-cost assertion pins *this branch's* poll route's spawn count against its own prior
  baseline; Task 9 must not remove or alter those other routes' behavior.
- **Task 12's doc list also needs `docs/UPGRADING.md`**: a cold evidence cache right after an
  upgrade (rows read "unchecked" until the next `ak sync`/`--refresh`) and the now-orphaned
  `<stateBase>/agentic-kit/live-checks/` and `ruflo-components-evidence.json` files (no migration
  shim, per Tasks 2/3) both belong in the upgrade notes, not only the ADR.
- **Task 10**: confirm `lastView`'s shape carries no timestamp field before relying on deep-equal —
  a timestamp in the compared object would make the equality check never match and silently
  reintroduce the every-tick write it's meant to remove.
- **Task 11 Step 1** runs on the real machine, so the controller runs it directly (not a dispatched
  agent) per the real-state rules, with a tripwire snapshot before and after.
- **Model selection is mandatory per dispatch** (per the skill): Task 1 and same-shape mechanical
  edits (2, 3, 10) → cheap/fast model; Tasks 4, 5, 6, 7, 9 (multi-file integration, the spawn-guard
  seam, in-process hazards) → standard model with judgment; the final whole-branch review →
  the most capable available model.

## Open decisions to ask the maintainer first

None block this branch. One planner call is recorded here rather than escalated:

- **The interim `--refresh` boolean's scope.** Today `--refresh` only re-probes ruflo components.
  This plan extends it, within 6a, to also re-probe host setup, native runtime, deja-vu, and
  version drift — "refresh everything process/network-shaped" rather than inventing a second
  interim flag. Forward-compatible with 6b's `--refresh=live`/`--refresh=machine` split (today's
  `--refresh` becomes the no-suffix tier); costs nothing to reverse.

## Interfaces

- `src/lib/evidence.mjs`: `evidenceFile(kind, id)`, `writeEvidence(kind, id, record, opts)`,
  `readEvidence(kind, id, opts)`, `stableInputsKey(parts)`, `describeAge(ms)`.
- `src/lib/paths.mjs`: `evidenceDir()`.
- `src/lib/natives.mjs`: `rufloRuntimeNatives({ refresh })` (additive).
- `src/lib/providers.mjs`: `hostInstallState(host, { refresh })`, `collectIntegrationFacts({ cwd,
  cfg, env, refresh })` (additive).
- `src/lib/adapters/deja-vu.mjs`: `detect({ cfg, refresh })` (additive).
- `src/lib/versions.mjs`: `driftReport({ probe })` (additive, alongside existing `force`).
- `src/lib/ruvector.mjs`: `drift({ probe })`; `src/lib/ruvnet-brain.mjs`'s release-check
  equivalent (additive).
- `src/commands/status.mjs`: exported `worstLevel(rows)` (new, extracted from `run()`'s inline
  computation, consumed by `dashboard-server.mjs`).
- `src/lib/spawn-ledger.mjs`: `recordSpawn(cmd, args)` (internal to `exec.mjs`).
- `src/lib/dashboard-server.mjs`: `shellOutStatus` removed; `fetchStatus`'s call-site contract
  (zero-arg async function returning `{overall, rows}`) is unchanged.
