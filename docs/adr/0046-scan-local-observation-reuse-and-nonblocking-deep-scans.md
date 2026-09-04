# ADR-0046 — Scan-local observation reuse and nonblocking deep scans

- **Status:** Accepted
- **Date:** 2026-09-03
- **Deciders:** agentic-kit maintainers
- **Related:** [issue #200](https://github.com/pacphi/agentic-kit/issues/200),
  [ADR-0023](0023-fail-closed-operations-and-explicit-degradation.md),
  [ADR-0025](0025-machine-footprint-metrics.md),
  [ADR-0027](0027-shared-project-census.md),
  [ADR-0044](0044-receipt-aware-maintenance-control-plane.md), and
  [ADR-0045](0045-artifact-consumer-bindings-and-explicit-maintenance-scans.md)

## Context

The issue #200 Maintenance work made scans more valuable and exposed the cost hidden by the
Machine Footprint tier boundary. A warm-cache profile of the production collectors on the deciding
machine took 217,847 ms, invoked the bounded walker 1,385 times, and examined 9,672,727 directory
entries:

| Phase | Time | Share | Walks | Entries |
|---|---:|---:|---:|---:|
| Projects | 100,820 ms | 46.3% | 423 | 4,362,756 |
| Consumers | 72,809 ms | 33.4% | 72 | 3,501,233 |
| Storage | 20,731 ms | 9.5% | 232 | 1,104,438 |
| Catalog | 12,193 ms | 5.6% | 592 | 44,514 |
| Install | 10,110 ms | 4.6% | 64 | 656,156 |
| Discovery | 1,184 ms | 0.5% | 2 | 3,630 |

The cost is predominantly repeated acquisition, not project discovery. Projects traverses a
working tree for bytes, again to find `node_modules`, again for stack/LOC, and then traverses every
found module root. Consumers knows which roots contain others but still measures every descriptor.
Install measures the whole npx cache and each environment separately; Storage measures those
environments again. Catalog can acquire one physical skill tree once per host binding even though
ADR-0045 deliberately separates one physical artifact from its consumers.

The profile also exposed a semantic mismatch. The documented Projects table contains hosted
repositories and characterises excluded directories, but collection fully measured every on-disk
session cwd before presentation filtered it. Two passes over the user home alone cost 35.2 seconds
and both stopped at the 400,000-entry cap.

Finally, deep collection and native Maintenance provider probes use synchronous filesystem and
process APIs in the dashboard process. `setImmediate` between phases lets scan startup return, but
a 100-second Projects phase prevents the browser from fetching that progress. The accepted claim
that progress makes a scan read as working therefore does not hold during a long phase.

## Decision

### One physical observation may feed many semantic projections

Each explicit deep scan owns one ephemeral `DeepScanCapture`. It contains the scan timestamp,
project-source census, compatible physical observations, and bounded diagnostics. It is never a
persisted cross-scan cache and never becomes mutation authority.

An observation can be reused only when its named path, read/filter/pruning contract, allocation
basis, freshness, and completeness are compatible with the new question. A partial or degraded
observation may be reused only for the identical contract and retains its partial state and reason.
A named symlink root is never realpath-collapsed merely to create a cache hit.

Collectors continue to own their output models. The capture shares acquisition, not domain
meaning. Examples are one physical Catalog read producing several ConsumerBindings, one project
walk producing working-tree totals and dependency-root discovery, and one complete parent
measurement producing contained Consumer or npx-environment rows.

When a broad observation is incomplete, the collector keeps its lower-bound parent result and
falls back to the existing narrower measurement for descendants. Optimization must not make an
exact child become partial merely because its parent hit a broader cap.

### Measure the population the product names

The lifetime project census retains its `everSeen`, `onDisk`, and `gitRepos` scopes. Full project
footprints are produced only for hosted repositories that the Projects surface presents. Session
locations such as a user home, transient worktree, or repository subdirectory remain counted and
are reported as excluded with a reason; they are not silently discarded or recursively measured
as peer projects.

This changes persisted ProjectFootprint semantics and therefore advances the FootprintSnapshot
schema. An older snapshot is rejected and replaced by the next explicit scan rather than being
reinterpreted.

### Isolate the synchronous engine from dashboard delivery

Production deep collection runs in one supervised Node worker thread. This is an event-loop
responsiveness boundary, not a claim that worker threads accelerate filesystem I/O. The dashboard
process owns the single-flight activity, cheap reads, and final publication; the worker owns the
mixed synchronous walk, hashing, and LOC engine and sends bounded phase/progress events.

Injected collectors and filesystem implementations remain inline for deterministic unit tests.
The production worker exits naturally after returning its result. Closing the dashboard does not
claim cancellation: an in-flight worker may finish and persist the requested measurement before
the process exits. Explicit mid-phase cancellation is deferred because the synchronous bounded
walker has no honest checkpoint contract yet. A worker failure never replaces the last successful
snapshot.

Maintenance provider checks remain a separate application workflow. Their native probes move from
`spawnSync` to bounded asynchronous process execution. Plain report reads remain passive, explicit
provider checks remain explicit, and one successful dashboard deep scan still chains exactly one
provider check after snapshot publication.

### Do not add an authoritative cross-scan tree cache

The dated FootprintSnapshot remains the cross-scan read cache. A directory's own timestamp does not
prove that nested content is unchanged, and filesystem watcher delivery is not a portable
completeness proof. Watchers may make stale evidence visible sooner; they cannot let an explicit
scan replay an old tree as newly measured.

## Consequences

### Positive

- Dashboard reads and progress polling remain responsive during deep collection.
- The scan stops paying repeatedly for the same physical evidence within one capture.
- Project and Catalog semantics align with their documented populations and identities.
- Previous snapshots remain usable throughout long, running, or failed scans.
- Work-count tests provide a deterministic performance gate alongside noisier wall-clock evidence.

### Negative

- The deep engine gains a worker protocol and lifecycle tests.
- Scan-local compatibility keys and fallback rules become an audited maintenance surface.
- Project eligibility requires a snapshot-schema migration.
- A full scan still performs real I/O; this decision reduces duplicate work but does not hide the
  remaining cost behind stale data.

## Verification

The implementation must prove:

1. initiating a deep scan returns promptly and cheap authenticated endpoints remain responsive;
2. concurrent refreshes share one worker, one result, and one snapshot publication;
3. optimized and reference collectors produce equal evidence, except for documented project
   eligibility and bounded diagnostics;
4. partial, degraded, absent, symlink, cap, worker-failure, and persistence-failure
   paths preserve their existing honesty rules and the previous snapshot;
5. plain Maintenance reads invoke no provider and explicit scans invoke each provider once;
6. the representative fixture's walk and entry counts cannot regress silently; and
7. the same-corpus median deep-scan time improves by at least 30 percent before this ADR becomes
   Implemented.

## References

- [Node.js filesystem APIs](https://nodejs.org/api/fs.html) — synchronous APIs block the event loop
- [Node.js worker threads](https://nodejs.org/api/worker_threads.html) — workers isolate JavaScript
  execution but are not themselves an I/O throughput optimization
- [Node.js child processes](https://nodejs.org/api/child_process.html) — asynchronous process
  creation does not block the event loop; synchronous variants do
- `src/lib/footprint/index.mjs`
- `src/lib/footprint/walk.mjs`
- `src/lib/footprint/projects.mjs`
- `src/lib/footprint/consumers.mjs`
- `src/lib/maintenance/native-command.mjs`
