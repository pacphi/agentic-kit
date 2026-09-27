# ADR-0055 — AQE embedding lifecycle and qualified readiness

- **Status:** Implemented
- **Release target:** `4.0.0-alpha.53`
- **Date:** 2026-09-20
- **Updated:** 2026-09-20 — implemented explicit defaults, owned Claude/Codex/OpenCode projections and qualified runtime proof
- **Updated:** 2026-09-23 — project projections are scoped to the enclosing git repository root; outside a repository only the user Codex target applies (earlier project-scope values are relinquished by receipt), and the `.mcp.json` AQE registration is required only in an AQE-initialized project
- **Updated:** 2026-09-26 — incomplete local setup distinguishes an installed-but-stopped Ollama (refused loopback connection with `ollama` on PATH) from a missing one and asks the user to start it rather than install it (#237)
- **Updated:** 2026-09-26 — status shows the last remembered live embedding check with its age, and opt-in `ak status --live` runs the quick live checks; see [Amendment: remembered live checks](#amendment-2026-09-26-remembered-live-checks)
- **Updated:** 2026-09-26 — the Codex TOML editor decodes table and key names with one shared TOML key decoder; unrelated root and `[mcp_servers]` assignments no longer block the edit, and inline, dotted or quoted AQE registrations are reported as conflicts instead of absent (#237)
- **Updated:** 2026-09-27 — a preserved conflict is a hand fix (`repair: 'manual'`) naming the file, never a sync repair, so it no longer fails every `ak sync`; changes and missing registrations stay sync repairs in their own row (audit decision 13)
- **Updated:** 2026-09-26 — one AQE MCP transport recognizer for Claude, Codex and OpenCode now accepts all of AQE's own start commands; see the amendment below (#237, audit decision 3)
- **Updated:** 2026-09-26 — temporary: agentic-qe ≤ 3.14.3's live-owner contention sequence (lock warning, live-owner quarantine refusal, then `FsyncFailed` from its create attempt) classifies as busy, not a storage failure; removed when a released agentic-qe fixes agentic-qe#574 and that release is the kit floor (agentic-qe#719, in 3.14.4, is a partial fix and does not remove it) ([#240](https://github.com/pacphi/agentic-kit/issues/240), audit decision 7)
- **Updated:** 2026-09-27 — the recognizer accepts every plain npx spelling of AQE's server (optional `-y`/`--yes`; unversioned, `@latest` or an exact version), audit item 5 choice A
- **Updated:** 2026-09-27 — a passing embedding check reads "embedder verified"; status, `ak x verify aqe` and setup say AQE's pattern index binding stays unverified (agentic-qe#754) and corpus compatibility stays separate
- **Updated:** 2026-09-27 — the busy rule's removal condition is agentic-qe#574 fixed in a released agentic-qe that is the kit floor; agentic-qe#719 (carried by 3.14.4) is only a partial fix
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
backend. The [hosted live run](https://github.com/pacphi/agentic-kit/actions/runs/35526137263)
passed on source `2b13ade`, including clean macOS setup and live Linux/macOS checks.
The [PR matrix](https://github.com/pacphi/agentic-kit/actions/runs/35526119373) also
passed Linux, macOS and Windows on Node 22, 24 and 26. Ollama copy
has no atomic create-if-absent operation: a fresh inventory check narrows, but does
not eliminate, the alias creation race with another writer.

The pre-PR portability review added a conditional-export regression: the local
transformer probe now resolves the same ESM module instance as AQE, so disabling
remote model downloads cannot accidentally configure a separate CommonJS instance.

## Amendment 2026-09-26: remembered live checks

`ak status` reads configuration only, so it reported "configured-unverified" while
`ak sync` failed the live request (#237). Sync's embedding step, `ak x verify aqe`
and the other quick verify suites now record each live result (passed, failed or
inconclusive; a short reason; the source; the time) in a per-check evidence file
under the kit's state directory, keyed by a hash of the selected backend. Status
and the dashboard show that result with its age and never probe. A failed result
is a warning, as in sync, never `fail`; only a fresh pass is green. A pass older
than 24 hours is information labelled stale, while a stale failure stays a warning
until a new check shows otherwise. A different backend selection marks the result
as changed instead of presenting it as current. This follows ADR-0058's evidence
cache. A backend pass still does not certify the corpus.

Plain status stays probe-free. `ak status --live` is the explicit opt-in: before
collecting rows it runs the quick, free `ak x verify` checks (the same functions,
not a copy) in parallel: the embedding request without the corpus read (only for a
backend the kit manages, the same gate as sync), Codex MCP initialize/tools-list
when Codex is enabled, provider wiring, the security
packages, deja-vu's structural proof when enabled, and a memory round trip in a
temporary directory. Each has a timeout; a timeout or a check that cannot run is
`inconclusive`, never failed. The slow learning and harvest proofs and the paid
host connection check are excluded, and the dashboard refresh never runs them.
The provider check runs `aqe health` only where `.agentic-qe` already exists:
AQE 3.14.3 auto-initializes a store (memory.db, patterns.rvf, witness keys) in the
directory it runs in, and a diagnostic must not set AQE up in a project.

## Amendment — 2026-09-26: recognized AQE start commands

Kit edits the endpoint only inside an AQE registration whose start command is one of
AQE's own programs, started exactly as AQE starts its MCP server. One recognizer
(`src/lib/aqe-embedding-transport.mjs`) serves Claude, Codex and OpenCode:

- `aqe-mcp` with no arguments;
- `aqe`, `agentic-qe` or `aqe-v3` with exactly `mcp` (one CLI whose `mcp` command starts
  the same server);
- `npx` with an optional single `-y`/`--yes`, then `agentic-qe` unversioned, `@latest` or an
  exact version (`@3.14.4`, `@3.15.0-rc.1`), then exactly `mcp` (version ranges, other
  dist-tags, scoped look-alikes and `--package` forms are preserved);
- npm's `.cmd` shims of these, matched case-insensitively on Windows.

Any other command, extra flag, subcommand or wrapper is reported as an unrecognized
transport and preserved. A user program named like an AQE program that takes exactly
these arguments receives the loopback endpoint; that value is non-secret and
receipt-owned, and `aqe-mcp` was already trusted this way. Source: audit decision 3 in
[the #237–#239 record](../audits/2026-09-26-issues-237-238-239-verification-and-decisions.md).
