# ADR-0040 — Codex hook audit and conservative remediation

- **Status:** Implemented (Codex Wave 1); extended by ADR-0041 and ADR-0042
- **Date:** 2026-09-01
- **Updated:** 2026-09-01
- **Deciders:** agentic-kit maintainers
- **Related:** [ADR-0016](0016-capability-driven-integration-adapters.md),
  [ADR-0023](0023-fail-closed-operations-and-explicit-degradation.md),
  [ADR-0027](0027-shared-project-census.md),
  [ADR-0029](0029-host-adapter-extension-point.md)
- **Evidence:** [2026-09-01 hook audit](../audits/codex-hooks-audit-2026-09-01.md)
- **Extended by:** [ADR-0041](0041-host-neutral-hook-configuration-assurance.md),
  [ADR-0042](0042-transactional-hook-healing.md)

## Context

Codex composes hook definitions from global, project, and enabled-plugin sources. Those
sources merge; one does not override another. Each non-managed definition also has a
separate exact-definition trust state.

The 2026-09-01 machine audit found 161 selected occurrences across 14 source files and
45 behavior fingerprints. Ten source files currently request a `SessionEnd` timeout above
Codex's documented and implemented three-second maximum. Nine are generated project
projections whose timeout values originated in a Claude-oriented generator and were
copied without unit translation; one is an installed plugin-cache generation whose
authoritative repair belongs upstream.

The same audit found generated project files with no ownership receipt, stale behavior
duplicating current plugin ownership, an exact Beads duplicate, no-op handlers, a hook
presented as enforcement despite using the wrong Codex blocking contract, and a RuvNet
Brain manifest/runtime version skew that silently drops two actions. A timeout-only patch
would suppress one warning while leaving the larger ownership and security failures
untouched.

Agentic-kit already has pieces of the necessary boundary:

- `codex-plugins.mjs` inspects enabled cache generations without adopting ownership;
- the project census provides one bounded set of known Git projects;
- adapters use `detect → plan → apply → verify → undo`;
- ownership logic preserves later user drift;
- file writers use backup-first atomic replacement.

It does not yet have a normalized hook domain, version-aware hook schemas, occurrence
deduplication, provenance resolution, or transaction receipts for multi-file hook healing.

The initial dual-host architecture gate was degraded because Claude Code was not signed
in. The follow-up Ruflo architecture/test/review lanes and Agentic-QE gates are recorded
by ADR-0041; Codex Wave 1 is therefore implemented while host-neutral extension is owned
by the later decision.

## Decision

### 1. Hook audit is a separate bounded context

Runtime hook discovery is not a host lifecycle adapter and is not a setup trust manifest.
The first public surface is:

```text
ak audit hooks
```

Its default is read-only. It performs no hook execution and no file writes. The first
implemented wave discovers direct global hooks, selected project hooks, and enabled
plugin hook files; records source hashes and JSON pointers; normalizes behavior; and
classifies remediations.

Future providers implement three distinct contracts:

```js
HookDiscoveryProvider.discover(context) -> HookSource[]
HookSchemaProfile.select(runtimeFacts) -> rules
HookRemediator.detect/plan/apply/verify/undo
```

External providers remain declarative plus bounded subprocesses under ADR-0029. Their
code is never imported into the agentic-kit process, and plugin-cache code is never
executed for discovery.

### 2. Every occurrence survives deduplication

A normalized occurrence records host, scope, event, matcher, group/hook indexes, type,
raw and parsed command, timeout declaration/units/effective bound, source path and JSON
pointer, digest, owner/authority/generated status, runtime versions, side-effect hints,
risk, trust recommendation, diagnostics, raw fingerprint, and behavior fingerprint.

Behavior fingerprints normalize event/matcher, implementation target, material arguments,
cwd/environment policy, and side effects. Timeout and presentation fields remain
diagnostics and do not erase behavioral identity. Deduplication links occurrences; it
never drops their provenance.

### 3. Schemas are version-aware and evidence-bearing

Each schema profile records supported events/fields/matchers, timeout units and
event-specific bounds, output/blocking rules, version range, evidence source, and
verification date. The verified three-second `SessionEnd` maximum belongs in the Codex
profile rather than an ad hoc string check.

Unknown/future versions receive syntax-only validation. Agentic-kit must not automatically
rewrite compatibility values unless authoritative local implementation or current primary
documentation proves the selected rule.

Diagnostics remain separate categories:

- compatibility;
- trust;
- security;
- provenance;
- ownership;
- duplicate;
- performance;
- runtime.

Trust never suppresses compatibility, and compatibility never establishes trust.

### 4. Healing has three action classes

An action is **automatic** only when all of the following are true:

- the canonical source is proven;
- it is agentic-kit-owned or covered by an exact ownership receipt;
- the change is semantics-preserving;
- the selected version schema is authoritative;
- the preimage digest still matches;
- trust state is untouched;
- no generated/cache target is written directly.

An action is **approval required** when it changes a user-owned source, generator,
behavior, matcher, order, environment, side effect, timeout, or more than one project.
Approval names a specific action ID and does not broaden the plan.

An action is **never automatic** when it writes plugin cache, staging, generated copies
instead of canonical sources, trust hashes/project trust, unknown-ownership commands,
unknown schemas, symlinks, or special files. Duplicate/stale/expensive appearance alone
never authorizes deletion.

No current finding qualifies for automatic mutation.

### 5. Trust remains user-owned

The auditor may report observed trust evidence and one of:

- `TRUST`
- `TRUST AFTER CHANGE`
- `DO NOT TRUST`
- `HUMAN REVIEW REQUIRED`

Those are review recommendations, not authorization. Agentic-kit will not set
`trusted_hash`, modify project `trust_level`, invoke a bypass, or equate a successful
benchmark with trust.

### 6. Apply is transactional

ADR-0042 adds one approval-required apply surface and implements these invariants:

1. plan includes canonical owner, action ID, target, expected preimage digest, desired
   digest, mode, unified diff, behavior impact, trust impact, and rollback description;
2. apply rechecks regular non-symlink targets and every preimage before the first write;
3. exact bytes/modes are backed up in a unique transaction directory;
4. temporary files use random exclusive creation and atomic rename;
5. post-write bytes, schema, and effective behavior are verified;
6. receipts bind pre/post digests, backups, actions, modes, and verification;
7. rollback proceeds only while current digest equals the receipt postimage;
8. a complete second audit must clear the targeted plan without changing trust;
9. a third plan must leave bytes and mtimes unchanged.

Partial failures report exact state. Already-written targets are rolled back only when
their postimage digest still matches, preserving later user drift.

### 7. Benchmarks are explicit evidence, never status-time behavior

Future benchmark mode parses and classifies a command before execution. It refuses
network, package-manager, credential, trust, process-control, mutation, model, detached,
and unbounded-shell candidates unless the user approves that exact action. It never
blindly passes a raw hook string to `sh -c`.

Safe candidates run with synthetic input, isolated temporary home/cwd, minimal
environment, absolute timeout, process-group cleanup, and bounded stdout/stderr. Five
samples report min/median/max; p95 is reported only with at least 20 samples. Skips and
refusals are first-class results.

## Consequences

### Positive

- Timeout clamping and trust can no longer be conflated in agentic-kit output.
- The cache boundary remains read-only and upstream ownership remains visible.
- Behavior duplication becomes measurable without losing source occurrences.
- Unknown provenance fails closed to a plan rather than becoming a guessed mutation.
- Hook auditing is reusable across projects and can later admit other hosts through an
  explicit provider contract.
- Future healing has an auditable backup/rollback/no-op proof rather than best-effort
  edits.

### Negative

- The first wave reports problems it deliberately cannot heal.
- Occurrence-level inventory is larger than a deduplicated list.
- Version/source resolution adds complexity and can return unknown rather than advice.
- Canonical owner repairs must land in Ruflo, Agentic-QE, RuvNet Brain, Beads, or OpenAI
  sources before installed copies become clean.
- A full all-project audit is too expensive and nuanced for normal `ak status`/`ak sync`.

### Deferred

- additional provider apply recipes beyond ADR-0042's narrow Codex exact-profile action;
- safe benchmark execution;
- declarative external hook providers;
- cheap status summary;
- narrowly scoped sync integration for proven automatic actions;
- independent Claude-led architecture review and acceptance decision.

## Compliance

Wave 1 is additive: `src/lib/hook-audit/index.mjs`, `src/commands/audit.mjs`, CLI dispatch,
tests, a structured hook-versus-skill plugin issue channel, and durable audit artifacts.
Discovery rejects traversal references, canonical cache escapes, symlink ancestors,
broken symlinks, malformed nested groups, non-string matchers, and invalid timeout values.
It does not modify setup/sync, current hooks, trust, plugin cache, or user state. This
preserves existing dirty work in integration modules and keeps the behavioral repair gate
explicit.

ADR-0042 preserves this read-only audit while adding a separate planner and transaction
port. It does not retroactively authorize cache, project, generated-source, or trust
mutation.
