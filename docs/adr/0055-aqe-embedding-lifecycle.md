# ADR-0055 — AQE embedding lifecycle and qualified readiness

- **Status:** Implemented — not released
- **Date:** 2026-09-20
- **Updated:** 2026-09-20 — implemented explicit defaults, owned Claude/Codex/OpenCode projections and qualified runtime proof
- **Related:** [ADR-0023](0023-fail-closed-operations-and-explicit-degradation.md),
  [September repair](../audits/2026-09-09-aqe-integration-repair.md)

## Problem

AQE 3.13.1 made local transformers an explicit security opt-in. Kit's September
9 diagnostics required a live HTTP embedder, while setup/sync owned neither the
backend choice nor its projections. A machine-local Ollama repair succeeded,
but later the endpoint lacked MiniLM and ordinary shells lacked configuration.
The verifier also conflated concurrent RVF access with corruption and consumed
provenance from a process without an initialized embedding identity.

## Decision

Kit owns embedding intent, bounded provisioning and host projections. AQE owns
embedding computation, space identity, persistence and recovery. Ollama owns
the optional local service and its model store. Kit must not implement vectors,
substitute hashes, rewrite upstream packages, delete stores or relabel vectors.

Existing installations without intent remain unmanaged until explicit setup or
configuration. New setup recommends local Ollama with `all-minilm:22m` and the
AQE request alias `Xenova/all-MiniLM-L6-v2`, 384 dimensions. An explicit existing
endpoint takes precedence over this default. No API key or Docker is required:
the native Ollama application/service is sufficient. Setup explains the download
before consent; it downloads only when local provisioning was selected. Missing
Ollama is actionable incomplete setup, never a green result or a hash fallback.
Kit does not install a system daemon or overwrite an existing model alias.

Alternatives are an existing HTTP(S)/Unix endpoint, explicitly selected
in-process transformers, or unmanaged embeddings. In-process package installation
remains user-owned because AQE identifies it as a security opt-in. Unmanaged
does not disable AQE and does not imply semantic readiness.

`aqeEmbedding` stores `mode` (`unmanaged`, `endpoint`, `in-process`), an endpoint
only for endpoint mode, and `provisioning` (`external` or `ollama`). Tokens remain
environment-only. HTTP is loopback-only; remote endpoints require HTTPS and
explicit selection. Endpoint URLs cannot contain credentials, query strings or
fragments. Unix paths must be absolute. Local provisioning requires loopback HTTP.

One resolver feeds Kit-launched AQE commands and diagnostics. Owned host
projections update only recognized fields with preimage checks and recovery
copies; conflicting foreign values are reported and preserved. Switching to
in-process clears the inherited endpoint explicitly. Existing equal foreign
values do not become owned. Direct `aqe` outside Kit still uses its shell's
environment; the CLI coaching must state this distinction.

## Verification

The isolated probe calls installed AQE's real embedding implementation, uses a
private temporary identity database, sends synthetic text, validates finite
384-dimensional vectors and semantic ordering, and reports upstream space ID.
Read-only probes never download models. Explicit setup may warm an opted-in local
cache. HTTP, Unix and in-process paths have distinct availability evidence.

Corpus comparison opens only the selected SQLite database read-only, with
auto-restore disabled. It compares stored identities to the actual initialized
identity. Unknown legacy provenance remains unknown. No active identity means
comparison unavailable, not mismatched. This does not certify RVF/ANN indexes.

RVF contention reports busy/degraded independently of hard storage errors. A
synthetic backend pass is not corpus readiness, owner health, or fleet execution.
The command reports each dimension and fails when required evidence is absent.

## Acceptance

- Fresh setup selects, discloses, provisions and verifies the local default, or
  reports an exact missing prerequisite and endpoint alternative.
- Existing explicit endpoint and in-process choices survive setup and upgrades.
- Sync repairs owned projection drift and missing selected local models without
  silently enrolling previously unmanaged installations.
- Foreign configuration, tokens, memory stores and legacy vectors survive.
- Lifecycle tests cover clean install, repeated sync, missing models, host/env
  conflict, failed provisioning, unavailable backends and changed identities.
- Public health claims distinguish configuration, reachability, semantic probe,
  corpus compatibility, storage contention and fleet execution.

## Validation and remaining boundaries

The candidate passes 4,294 Node tests (six skipped), the legacy suites, typecheck,
lint, complexity lint, Markdown lint and build checks. Repository coverage is
92.19% lines, 81.54% branches and 91.61% functions. Live installed AQE produced
384-dimensional semantic embeddings; the existing corpus remained one different
space ID and 135 unverified legacy vectors. No corpus migration was attempted.

OpenCode has an immediate narrow update inside its full-entry owner; it does not
require a separate sync for an already owned registration. The packed clean-Mac
nightly now provisions native Ollama in disposable storage and checks the actual
backend, but that GitHub-hosted job has not run in this local session. Ollama copy
has no atomic create-if-absent operation: a fresh inventory check narrows, but does
not eliminate, the alias creation race with another writer.
