# Discovery and scan policy

- **Design status:** Proposed
- **Governing decision:** [ADR-0048](../../adr/0048-inventory-led-maintenance-resource-management.md)
- **Extends:** [ADR-0046](../../adr/0046-scan-local-observation-reuse-and-nonblocking-deep-scans.md)
  and [ADR-0047](../../adr/0047-streaming-observation-forest.md)

Discovery must remain friendly on a new installation without making a large source permanently
partial. This policy separates where Agentic Kit may look, how it budgets responsive work, and when
the resulting inventory is complete enough to support negative or destructive conclusions.

## Source types

### Automatic source

A built-in host, adapter, project-census, runtime, provider, or package-manager source whose
documented default locations Agentic Kit can inspect under the current user's permissions. Each
automatic source has an independent toggle. Disabling it removes its current placements from the
active inventory after preview while retaining bounded history.

### Exact project

One user-selected repository or worktree. The source binds an opaque project identity,
environment, canonical lexical root, and inclusion policy. Moving the directory creates a path
change; verified Git/worktree identity may preserve the logical project relationship without
putting a remote URL into the public projection.

### Bounded collection root

A user-selected directory under which discovery searches for projects subject to explicit depth,
filesystem, exclusion, and safety limits. A collection root does not make every descendant a
project and does not authorize reading arbitrary file content.

## Configuration ownership

V1 persists automatic-source toggles, exact projects, collection roots, and exclusions as
user-level `kit.json` intent. It does not add project configuration or cross-machine import/export.

Owner-private operational state stores:

- opaque source and environment identities;
- checkpoints and scan epochs;
- last complete snapshots and coverage;
- last-view and filter preferences;
- preferred shell per environment; and
- retention overrides.

Operational state is not copied into a repository and may not contain credential values, private
registry URLs, or raw provider configuration.

## Add-source preview

Nothing is saved until the preview identifies:

- environment and requested source type;
- normalized lexical root and filesystem boundary;
- projects found so far with distinguishing breadcrumbs;
- automatic, exact, and recursive exclusions;
- traversal depth;
- symlinks encountered and skipped;
- mount, removable-media, cloud-placeholder, and WSL boundaries;
- estimated entries, bytes, and time range when measurement supports an estimate;
- required permissions; and
- hard safety ceilings.

The preview is advisory and states when estimation is incomplete. Saving a source confirms its
root and policy, not a mutable list of previewed projects.

## Exclusions

V1 supports:

- host-level automatic-source toggles;
- exact path exclusions; and
- recursive parent exclusions.

A recursive exclusion displays an indicator and previews affected projects. Newly discovered
children remain excluded until the rule is removed. Exclusions are applied before content parsing
and are included in coverage evidence.

Curated exclusions cover dependency, build, VCS-internal, cache, and vendor directories only when
the relevant collector contract names them. A user may add the resolved target of a symlink as a
separate exact source; scanners never follow the link itself.

Network shares, removable media, cloud placeholders, and host/WSL boundary paths are excluded by
default. Opt-in is per exact root and does not weaken timeouts, privacy, or traversal safety.

## Repository identity

- Linked Git worktrees are distinct project placements grouped under one logical repository.
- Nested standalone repositories are distinct projects.
- Initialized submodules are dependency edges and are scanned only when explicitly included.
- Vendor or dependency directories do not become projects through incidental VCS metadata.
- Equal basenames use the shortest distinguishing path breadcrumb in the UI.

A remote URL may participate only through a keyed owner-private fingerprint where an existing
identity contract permits it. It is never a display fallback or URL filter value.

## Scan classes

### Passive local scan

Runs at application start or first Maintenance open, coalesced by freshness. It reads bounded local
metadata and saved provider facts. It does not recursively deep-scan a collection root, invoke a
host or package-manager executable, contact a network endpoint, validate credentials, or mutate a
resource.

### Explicit local scan

Traverses configured sources and may run disclosed read-only executable probes. It uses the
streaming observation forest where contracts are compatible and preserves independent virtual-walk
truth where they are not.

### Explicit network refresh

Runs only through a separately labeled operation. Endpoints, redirects, response sizes, publisher,
signature, digest, and allowlist are provider-fixed. Network results never activate a new operation
or privilege requirement without user acceptance.

### Interruption audit

Uses receipt-bound provider inspection. It is a read class even when several receipt inspections
are acquired together; recording an outcome is a separate single-receipt write.

## Completion-oriented work model

A scan budget has two meanings that must not be conflated:

1. **Work-slice budget** — bounds continuous CPU/I/O work so progress and cancellation remain
   responsive. Reaching it checkpoints and yields; it does not end the source scan.
2. **Safety ceiling** — bounds pathological depth, entries, file size, memory, output, process time,
   or external response size. Reaching it stops the affected virtual query and records the exact
   ceiling.

No small cumulative wall-clock timeout declares a valid source incomplete forever. A stable,
finite, readable source continues across work slices while the application is open and resumes from
its owner-private checkpoint on a later launch.

Defaults are established by source-bound macOS, Linux, Windows, WSL, local-disk, large-monorepo,
network-root, and low-resource benchmarks. A user may lower a limit. Raising a safety ceiling
requires an explicit source-level preview and never weakens path or permission constraints.

## Scan state machine

```text
configured
    |
    v
queued -> scanning -> checkpointed -> scanning
              |                         |
              +-------> paused ---------+
              |
              +-------> complete -> published
              |
              +-------> stopped
              |
              +-------> failed
```

- `checkpointed` means a work slice completed and continuation is valid.
- `paused` preserves continuation state but performs no more work until resumed.
- `stopped` removes the source from active Inventory after preview and retains bounded history.
- `failed` names a concrete acquisition failure. Reaching a routine work slice is never failure.
- `complete` requires every required partition and final source validation.
- `published` atomically advances the complete source snapshot.

## Checkpoint contract

A checkpoint contains only the bounded operational state required to resume:

```text
ScanCheckpoint
  schemaVersion
  scanId
  sourceId
  environmentId
  scanEpoch
  observationContractVersions
  completedPartitions[]
  pendingPartitions[]
  boundedTraversalCursors[]
  workCounts
  sourceStamps[]
  createdAt
  updatedAt
  integrity
```

It is owner-only, integrity-protected, schema-versioned, and rejected after source-identity,
environment, exclusion, contract, or safety-policy drift. It does not persist millions of path
records or restamp old measurements as current.

The implementation must use ADR-0047's observation specifications, trie planning, reducers, and
independent virtual budgets. Journal-backed continuation is an orchestration layer over that
forest—not a competing crawler.

## Filesystem change during a scan

Filesystems do not provide an atomic recursive snapshot. Completion therefore means the scan
finished its declared observation contract and final validation found no invalidating source drift.

When drift is detected:

- invalidate the smallest affected partition that can be proven;
- preserve unaffected completed partitions;
- requeue affected work;
- record the drift count and paths only in owner-private diagnostics; and
- stop with a factual changing-source result after a bounded retry policy.

The UI says that the source changed during measurement. It does not claim that the filesystem is
unhealthy or that the resource needs attention.

## Truthful partial results

The last completed snapshot remains the authoritative baseline until a new complete snapshot is
published. Individually verified resources observed during an incomplete run may be rendered as
current-run additions with **Source scan incomplete** in technical details.

An incomplete source cannot establish:

- absence or removal;
- complete inventory totals;
- uniqueness or complete duplicate sets;
- complete conflict sets;
- complete reverse dependencies or blast radius;
- total reclaimable storage; or
- Managed action eligibility that depends on any of those claims.

UI progress reports measured work and scope, for example:

> Scanned 84,231 entries. Seven of ten sources are complete. This source is paused and will resume;
> its inventory is not yet complete.

## Stop, remove, and historical evidence

Stopping a source is distinct from deleting history. Before confirmation, preview active resources
and projects that will leave Inventory. On confirmation:

- cancel or checkpoint active work safely;
- remove the source from active discovery configuration;
- exclude its placements from the next active management projection; and
- retain bounded scan records, action receipts, dispositions, and audit relationships.

Receipts remain intelligible after their source is stopped. A stopped source does not authorize
cleanup of the resources it once observed.

## Retention

- Completed scan summaries retain at most 32 per environment and no summary older than 90 days by
  default, matching the implemented model-inventory precedent.
- Active checkpoints persist until completion, stop, invalidation, or seven days without a valid
  continuation; the exact default is benchmarked before acceptance.
- The last complete source snapshot is retained regardless of a newer partial or failed run.
- Users can clear nonessential terminal scan history and override defaults globally or per
  environment.
- Open scan continuation, action receipts, recovery evidence, undo-eligible receipts, active
  dispositions, and recipe acceptance records are not ordinary scan history.

## Security and privacy

- Roots are absolute internally and validated against traversal and special-node escape.
- Lexical identity is preserved; named symlinks are never realpath-collapsed to manufacture reuse.
- Checkpoints, paths, errors, and work cursors are owner-private.
- Public progress contains bounded counts, phases, source labels, and opaque IDs—not paths.
- Content reads are type-, size-, and parser-bounded and occur only for a named resource contract.
- Executable probes use provider-fixed identities, neutral working directories, minimal
  environments, bounded output, deadlines, and process-group cleanup.
- Credential validity and network checks require explicit separate operations.

## Performance evidence required before acceptance

The candidate must be compared with exact source-bound baselines on all launch OS families. Report:

- first saved-inventory paint;
- scan initiation and cancellation latency;
- progress polling responsiveness;
- time and work counts to complete representative small, large, and 50,000-placement inventories;
- pause/resume overhead;
- checkpoint size and write amplification;
- median, range, p95, CPU, peak RSS, filesystem operations, and peak concurrency;
- equality against the portable walker and independent collector oracles; and
- repeated-source-change behavior without infinite restart.

Optimization cannot weaken completeness, symlink, degradation, or privacy semantics.

## Invariants

1. A work-slice budget cannot terminate a valid scan.
2. A partial run cannot replace the last complete baseline.
3. Resume never treats old observations as current without validating their scan epoch and sources.
4. A broad partial query cannot make an exact narrow query partial.
5. Read batching never merges source scopes or completeness.
6. Watchers, if considered later, may mark evidence stale but cannot prove completeness.
7. A scan result always states which sources and contracts it completed.
