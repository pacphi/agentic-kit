# ADR-0047 — Streaming observation forest for deep scans

- **Status:** Accepted; Projects pilot implemented
- **Date:** 2026-09-03
- **Deciders:** agentic-kit maintainers
- **Related:** [issue #200](https://github.com/pacphi/agentic-kit/issues/200),
  [ADR-0023](0023-fail-closed-operations-and-explicit-degradation.md),
  [ADR-0025](0025-machine-footprint-metrics.md), and
  [ADR-0046](0046-scan-local-observation-reuse-and-nonblocking-deep-scans.md)

## Context

ADR-0046 removed several concrete duplicate traversals and moved synchronous deep collection out of
the dashboard event loop. Its exact source-bound candidate reduced the deciding machine from a
210,203 ms median and 1,395 walks to a 147,796 ms median and 817 walks. The remaining scan still
examines about 6.09 million directory entries: Projects and Consumers account for about 88 percent
of wall time.

Collector-local reuse has reached its architectural limit. A broad Project walk that reaches its
entry cap must currently restart Stack and dependency-root detection from the beginning. Consumer
containment routes each file through a linear list of descendant captures. Static Install, Consumer,
and Storage declarations name 95 paths that collapse to 76 unique paths and 49 outermost roots, but
the collectors cannot plan those observations together.

A persisted per-file JavaScript index is not the answer. Millions of retained path strings and
objects would impose large and data-dependent memory cost, while directory mtimes and ordinary file
watchers cannot prove that descendants stayed unchanged. More worker threads isolate CPU work but
do not inherently accelerate filesystem I/O. Native `du` and `find` do not reproduce the domain's
file counts, newest mtime, per-node degradation, caps, callback projections, or symlink contract.

## Decision

### Compile scan intents into one streaming forest

The deep-scan runner will collect immutable `ObservationSpec` values before acquisition. A spec
names a lexical root, independent depth/entry/degradation budgets, directory pruning, file
acceptance, required metadata, contract version, projection reducer, and the scan's shared `asOf`.

The planner inserts those roots into a lexical path trie and traverses each outermost compatible
named root once. Directory, file, symlink, and error events are routed only to virtual walks active
at that path. Each accepted physical entry is listed and statted once; semantic reducers remain
separate and receive events in deterministic directory-entry order.

The forest streams events into bounded reducers. It does not materialize or persist a file-record
index. Its memory bound is the compiled specs, traversal depth, trie, and each reducer's already
stated bounded result state.

### Preserve independent virtual-walk truth

Every virtual walk retains its own budgets and outcome:

- one query reaching a cap becomes partial without truncating compatible siblings;
- pruning excludes a subtree only from the query that requested the prune;
- an unreadable child degrades every query whose scope includes it;
- an unreadable named root is unknown for that query;
- symlinks are counted as skipped evidence and never followed;
- a separately named child that an ancestor cannot prove complete is acquired directly;
- callback or reducer failure aborts the scan rather than masquerading as filesystem degradation.

Roots remain lexical. The planner never realpath-collapses a named symlink merely to create a cache
hit. Contract-incompatible specs remain separate traversals. ADR-0046's fallback rule therefore
survives: uncertain shared acquisition cannot make an exact narrow result partial.

### Deliver in measured slices

1. **Projects pilot.** One project forest supplies working-tree totals, Stack/LOC, top-level
   dependency-root discovery, `.git`, and dynamically activated dependency subtrees. The existing
   independent collectors remain the executable oracle.
2. **Static cross-collector planning.** Prepare seams let Install, Consumers, Storage, discovery,
   and shallow Catalog reads declare specs before acquisition. Consumer descendant routing changes
   from a linear scan to trie lookup.
3. **Bounded asynchronous backend.** Only after traversal fusion, benchmark asynchronous directory
   and stat acquisition at concurrency 1/4/8/16. Reducers retain deterministic event order and
   content reads use a separate small bound. The existing worker remains the responsiveness
   boundary, not an assumed I/O accelerator.
4. **Optional native backend.** A platform adapter may be prototyped only if the fused scanner
   remains syscall-bound. On Darwin, `getattrlistbulk(2)` is the first candidate because it can
   return multiple directory entries' types, sizes, allocation, mtimes, and per-entry errors. It
   must produce the same observation contract and fall back to the portable walker on any gap.
5. **Journal-backed incremental mode.** This requires a separate decision and provenance model.
   Watch events may mark evidence stale, but never restamp old measurements as current.

## Consequences

### Positive

- Physical acquisition scales with unique compatible entries rather than the sum of every
  collector's recursive walk.
- A capped broad query no longer forces a narrower sibling query to reread already-seen entries.
- Each collector keeps its own vocabulary, budgets, completeness, and fail-closed semantics.
- The portable walker remains an oracle and fallback rather than being replaced in one risky step.

### Negative

- Collectors need prepare/reduce seams instead of owning acquisition end to end.
- Dynamic roots such as discovered `node_modules` require a bounded activation protocol.
- Multiple virtual budgets and failures make the planner a safety-critical domain component.
- Async or native backends add value only after equivalence and source-bound benchmarks prove it.

## Verification

The forest must prove:

1. deep equality with independent `walkTree()` results for overlapping/exact roots, distinct
   pruning and acceptance rules, and independent depth and entry caps;
2. identical absent, unreadable-root, degraded-child, symlink, special-node, placeholder, and
   callback-failure behavior;
3. exact narrow-child recovery when an ancestor is partial;
4. deterministic event order and dynamic-root activation;
5. one physical list/stat for every shared compatible entry, with physical and virtual work counts
   reported separately;
6. bounded memory measured alongside median, range, p95, CPU, and peak concurrency; and
7. no regression in ADR-0046's same-corpus wall-time gate or dashboard responsiveness.

### Projects pilot evidence

The pilot in `src/lib/footprint/observation-forest.mjs` fuses working-tree, Stack/LOC, and dependency
discovery for compatible default Project measurements. Custom walkers, detectors, and traversal
callbacks retain independent acquisition. A degraded shared query falls back; a query that reaches
its own deterministic cap keeps that exact partial result without rereading the same prefix.

At candidate `ad09c30`, the three-run Projects phase examined 1,731,134 physical entries per run,
down from 2,536,701 immediately before the pilot. The whole deep scan produced a 138,561.30 ms
median versus ADR-0046's 210,203 ms reference. Later static cross-collector, asynchronous, native,
and journal-backed phases remain unimplemented.

## References

- [Node.js filesystem APIs](https://nodejs.org/api/fs.html)
- [Node.js worker threads](https://nodejs.org/api/worker_threads.html)
- [Apple `getattrlistbulk(2)`](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/man/man2/getattrlistbulk.2)
- [Apple FSEvents programming guide](https://developer.apple.com/library/archive/documentation/Darwin/Conceptual/FSEvents_ProgGuide/UsingtheFSEventsFramework/UsingtheFSEventsFramework.html)
- `src/lib/footprint/walk.mjs`
- `src/lib/footprint/deep-scan-runner.mjs`
- `src/lib/footprint/projects.mjs`
- `src/lib/footprint/consumers.mjs`
