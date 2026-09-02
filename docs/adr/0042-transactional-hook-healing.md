# ADR-0042 — Transactional host-neutral hook healing

- **Status:** Implemented for the narrow Codex exact-profile recipe; cross-host acceptance pending
- **Date:** 2026-09-01
- **Deciders:** agentic-kit maintainers
- **Extends:** [ADR-0041](0041-host-neutral-hook-configuration-assurance.md)
- **Related:** [ADR-0023](0023-fail-closed-operations-and-explicit-degradation.md),
  [ADR-0040](0040-codex-hook-audit-and-conservative-remediation.md)
- **DDD:** [Hook configuration assurance](../ddd/hook-configuration-assurance.md)
- **Runbook:** [Hook assurance and healing](../HOOKS.md)

## Context

ADR-0041 implemented a deterministic, host-neutral read model but deliberately
withheld mutation. The earlier audit demonstrated that host files compose rather
than replace one another, generated copies can obscure canonical ownership, trust
is independent of compatibility, and unknown host versions cannot inherit older
rules. A writer therefore cannot be a generic JSON patcher.

The smallest safe mutation found in the implemented audit is Codex `0.151.0`
normalizing a direct user-owned global `hooks.json` `SessionEnd` timeout to the
same three-second bound already enforced by that exact runtime. It changes the
reviewed definition and therefore remains approval-required even though effective
runtime behavior is unchanged.

The dual-host architecture gate was degraded during this decision because Claude
Code was not authenticated. Ruflo architecture/provider/QE lanes and a Codex
review were completed, but this record does not claim reciprocal Claude-led
acceptance. That limitation narrows the implemented recipe; it does not relax any
invariant.

## Decision

### 1. Remediation is a sibling write model

Hook Configuration Assurance remains the read aggregate. Hook Remediation is a
sibling write model that consumes an immutable `HookAudit` and produces a
content-bound `HookHealingPlan`. Provider-specific compilers are the anti-
corruption layer between normalized findings and host-native bytes.

No provider gains mutation merely by emitting a proposal. A recipe must prove an
exact schema, canonical owner, supported source kind, safe target type, preimage,
postimage, behavior/trust impact, activation, verification, and rollback.

### 2. Public commands separate observation, planning, and authority

- `ak hooks doctor` is read-only and JSON-compatible with `ak audit hooks`.
- `ak hooks heal --dry-run` computes a redacted plan and writes nothing.
- apply requires exact repeatable `--action` IDs, the exact `--expect-plan`
  digest, and interactive confirmation or `--yes`.
- `--yes` confirms only selected actions; it never broadens the plan.
- `ak hooks undo` selects exactly one receipt with `--receipt` or `--last` and
  uses the same confirmation boundary.

### 3. Transactions are backup-first and fail closed

All selected targets pass preflight before a transaction directory exists. Each
must remain a regular non-symlink file within its proven root and match its exact
digest and mode. Backups use random exclusive creation, are re-read and hashed,
and exist before the first target rename.

Receipts are private, integrity-sealed, atomically replaced, and durably synced.
They journal prepared, applying, verifying, committed, rolled-back, and partial
states. Target replacement uses a random exclusive sibling, preserves mode where
the platform supports it, fsyncs the file, atomically renames, and syncs the
directory where supported.

### 4. Verification proves both effect and idempotence

After writing, a complete second audit must remove every targeted diagnostic and
a newly compiled plan must contain no executable action for the target. A third
audit/plan cycle must leave target digests and mtimes unchanged. Otherwise the
transaction rolls back every still-matching postimage.

### 5. Undo preserves later drift

Undo validates receipt integrity, target containment, current postimage, backup
digest, and original mode. It restores only while the current digest equals the
receipt postimage. A later user or generator edit is preserved and reported as a
drift refusal. Repeating undo is a successful no-op when the exact preimage is
already present.

### 6. Provider boundary

The only executable recipe in this wave is Codex `0.151.0`, direct global JSON,
`SessionEnd` timeout normalization. Project files, Claude settings/plugins,
OpenCode configuration/modules, external adapters, generated projections, cache
files, trust state, unknown versions, symlinks, and special files are prohibited
or upstream-required.

No action is automatic-eligible, so hook healing is not integrated into `ak sync`.

## Consequences

### Positive

- The plan the user reviews is cryptographically bound to the plan applied.
- Failure before mutation leaves targets unchanged; failure after mutation uses
  exact postimage-guarded rollback.
- Receipts make interrupted work visible and guarded undo repeatable.
- Provider-specific write authority stays narrower than provider discovery.
- Existing `ak audit hooks --json` consumers retain their report shape.

### Negative

- A harmless stored timeout normalization still requires explicit approval and
  may trigger a new Codex trust review.
- Most audit proposals remain non-executable until canonical ownership and exact
  provider recipes are independently proven.
- Cross-host architectural acceptance remains pending until the Claude-led gate
  can run authenticated.

### Deferred

- Claude Code, OpenCode, external-adapter, generated-source, and project recipes;
- trust observation or mutation;
- safe hook benchmarking;
- automatic-eligible sync integration;
- remote upstream issue creation.

## Compliance

The implementation adds a pure planner, filesystem port, transaction store,
apply/verify/undo engine, CLI surface, and adversarial fixtures. Tests cover stale
and tampered plans, symlink refusal, backup failure, verification rollback,
receipt tampering, exact undo, drift refusal, deterministic dry-runs, JSON
compatibility, action approval, mode preservation, and idempotence.
