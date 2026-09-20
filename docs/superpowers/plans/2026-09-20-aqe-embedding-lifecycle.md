# AQE Embedding Lifecycle Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans. Each writing worker
> has an isolated worktree; the integration worker alone combines changes.

**Goal:** Make embedding selection, provisioning, projection and diagnostics
agree with installed AQE without degrading existing users or altering memory.

**Architecture:** A pure intent resolver feeds a bounded local-model lifecycle,
owned host projections and an isolated upstream runtime probe. Setup/sync own
convergence; status reads evidence; verification qualifies each capability.

**Tech Stack:** Node.js 22+ ES modules, node:test, zero runtime dependencies.

**Spec:** [ADR-0055](../../adr/0055-aqe-embedding-lifecycle.md)

## Global constraints

- No releases, model relabelling or memory migration.
- Follow-up authorization on 2026-09-20 permits a fresh delivery branch, commit
  units, PR publication, CI repairs, squash merge and task-branch cleanup.
- User approved branch creation, implementation, model download and configuration.
- Root owns integration/configuration/manifests. Probe and projection workers
  write only their isolated worktrees and assigned modules/tests.
- Existing main worktree's untracked research remains untouched.
- Provisioning is local-only and explicitly selected; secrets stay in environment.

## Task 1 — Intent and local provisioning

- [x] Add resolver tests for legacy unmanaged, fresh local default, explicit
  endpoint preservation, invalid URLs, token rejection and in-process clearing.
- [x] Run `node --test tests/kit/aqe-embedding-config.test.mjs` and observe failures.
- [x] Implement `validateAqeEmbeddingIntent`, `selectAqeEmbeddingIntent`, and
  `resolveAqeEmbedding` in `src/lib/aqe-embedding-config.mjs`; validate on load/save.
- [x] Add HTTP fixture lifecycle tests for missing service, model download/alias,
  existing alias preservation and idempotence, then implement bounded provisioning.

## Task 2 — Owned projections

- [x] Probe project/user host configuration through conservative readers.
- [x] Test conflicts, stale preimages, symlinks, malformed files, repeated apply
  and exact ownership reversal before implementation.
- [x] Implement inspect/reconcile in `aqe-embedding-projection.mjs`; extend
  OpenCode's existing full-entry owner instead of adding another writer.

## Task 3 — Upstream semantic and provenance proof

- [x] Replace client-only fixtures with installed real-embeddings contract fixtures.
- [x] Test HTTP/Unix/local, no implicit downloads, private identity DB, timeout,
  missing model and redaction before changing `aqe-embedding-probe.mjs`.
- [x] Test corpus comparison against initialized identity, legacy provenance,
  missing DB/table and mixed spaces using read-only access.

## Task 4 — User lifecycle

- [x] Add `ak x aqe-embedding` configuration/status/provisioning entry point.
- [x] Setup selects and discloses defaults before mutation; passes resolved AQE
  environment and reconciles after upstream initialization.
- [x] Sync runs selected lifecycle after package changes and host projections;
  status exposes missing configuration and actionable repair without network.
- [x] Verification separates backend/corpus/storage facts and busy state.
- [x] Exercise fresh setup/upgrade decision paths with injected external boundaries.

## Task 5 — Documentation and qualification

- [x] Document initial experience, alternatives, explicit download boundaries,
  shell differences, recovery and model identity preservation.
- [x] Update ADR-0023, ADR index and this decision's implementation status.
- [x] Run focused tests then typecheck, lint, complexity, Markdown, build and full tests.
- [x] Review integrated diff independently; record source-bound evidence and limits.
