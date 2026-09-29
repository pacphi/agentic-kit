# Usage accuracy execution plan

- **Branch:** `fix/usage-accuracy`, based on `develop@e2f9dcae0554ff63921df618a819fd5e6afe80d2`
- **Scope sources:** [v2 V6](2026-09-28-remediation-program-v2.md),
  [v1 Wave 4](2026-09-26-remediation-program.md),
  [ADR-0060](../adr/0060-session-surface-initiator-and-product-names.md).

## Status

Active. Units 1–11, 20 and 21 are accepted. Unit 11 captures Claude Code's
latest valid cumulative `cost-state` checkpoint as a separate reconciliation
signal. It reports provable time or token scope differences while preserving
message-derived cost totals. The observed checkpoint has no end time or serving
provider attestation, so equal counters remain unverified. Unit 12 now retains
bounded, hashed Claude API message identities per cached file and reconciles
copied charges after discovery. Aggregate responses/tokens/cost count a shared
message once; each session's `responses` still counts what its transcript
recorded, with `accountedResponses` showing its aggregate share. Unit 12 is
accepted, including its bounded global-message-owner policy. The Claude identity pool always covers the
displayed window and its equal-length predecessor, regardless of the
`previous` or `lookbackDays` options. One owner is elected per identity across
that pool before either window is projected; a copied message therefore
contributes to at most one of the two windows. Explicit deeper lookback can
support other history views but cannot change an eligible owner's charge.
Eligibility requires both the file mtime and transcript session end to reach
the fixed horizon; older-mtime copies discovered by a deeper lookback cannot
steal or enlarge it. Distinct historical messages remain visible under that
explicit request, with out-of-pool coverage reported in source health. Claude
reads may reach twice the displayed window (capped at 730 days for the
dashboard's 365-day maximum), with the cap reported for wider callers.
Unit 13 records an entry-level local calendar context: the resolved full timezone
identity plus Node's tzdata and ICU versions. A mismatch or missing/invalid context
reparses available source records; no timestamp is inferred from a cached day.
Process memo and single-flight keys include that context. Degraded OpenCode entries
retain their original marker but cannot contribute incompatible day/punchcard rows;
source health reports `timezoneCacheEntriesExcluded`. Unset `TZ` uses the runtime's
resolved machine zone; an unresolved zone declines cache and aggregate-memo reuse.
Schema remains 26, preserving Unit 15's independent OpenCode cost marker. Unit 13
awaits independent review before Unit 14.

Pricing retains its existing local `row.day` contract (`usage-parsers.localDay`,
`pricing.costOf`, and the cache-saving probes documented in usage metrics). Cold
and warm reads within a zone must agree, including dated rates. A timezone change
can move a row across a dated rate boundary and therefore change its API-equivalent
estimate; this unit neither establishes a provider billing timezone nor freezes a
price from the old local day. Reported OpenCode cost stays observed, and token,
provider, model, Claude cost-state, Codex fields and duration semantics stay intact.

Unit 2 is limited to the agreed classifier interface, parser fields and one
usage-cache schema bump.
The maintainer approved retaining unfamiliar, bounded tokens from named origin
fields as raw evidence for local detail. The classifier now retains those tokens
without inferring a product or provider; malformed, oversized and non-string
values remain excluded. This narrow policy follow-up does not accept all of
ADR-0060 or add a UI. Later units still require separate dispatch, RED/GREEN
evidence and capture commits.

Unit 6 records Amazon Bedrock or Google Vertex AI only when a Claude assistant
message carries a provider-specific model ID. Conflicting or ordinary IDs leave
the provider unknown. Historical transcripts do not capture launch environment
or settings, so current configuration cannot identify their serving provider;
OpenRouter, other gateways and private endpoints remain unknown without bound
session evidence. The detail stays under `sessionOrigin.thirdPartyProvider` with
`thirdPartyProviderBasis: assistant-model-id` when known. Units 22/23 own display.

## Gates and ownership

Start production edits only after exact-head develop push CI succeeds. Use one RED fixture
before each source change, a focused GREEN run, and a unit commit for each item. Verify
typecheck, lint, relevant regressions and the state tripwire before review. The controller
owns shared manifests, ADR acceptance, integration, push, PR, merge and release. No real
personal transcript contents enter fixtures or reports; real-data reproductions report
enumerated values and counts only. The V4 XDG work owns `usage-opencode` and adjacent
footprint discovery files until integration; V6 task 1 owns only `session-surface.mjs`,
`footprint/session-origin.mjs` and their tests. V6 UI integrates develop after V3.

## Capture units

| Unit | Source boundary and acceptance | Focused evidence / dependency |
|---|---|---|
| 1 | Shared raw-value → surface → initiator → label vocabulary; bounded raw evidence, unknown and provider separate. Adapt footprint origin with legacy fields retained. | ADR table fixtures, first declaration, privacy, identity and imports regressions. This dispatch only. |
| 2 | Parser and usage cache integration, exactly one schema 25→26 bump. Carry new fields and rebuild old cache. | Parser, cache migration and aggregate tests; after unit 1. Footprint schema stays 8. |
| 3 | Full Codex `thread_source` classification, subagent/reviewer rollup and unpriced Auto-review models (X-7). | Per-value parser fixtures and counts; after unit 2. |
| 4 | Count Claude by `sessionId`, exclude subagent and bridge transcripts, and remeasure source-bound census. | Duplicate/session fixtures plus enumerated-count reproduction; after unit 2. |
| 5 | Runtime census symmetry for Claude.app and ChatGPT.app; attribute bundled CLIs to observed sessions. | Runtime fixtures on both app forms; after units 2–4. |
| 6 | Third-party Claude provider from observed environment, settings or model ID; unknown remains unknown and provider is a separate detail field. Cloud label renders only for observations. | Evidence-precedence and unknown fixtures; after unit 2. |
| 7 | Imported turn exclusion per turn; later genuine Codex turns count and establish an actual app origin (decision 12/B1-4). | Mixed import/real-turn fixture and enumerated-count reproduction; after unit 2. |
| 8 | Token-bearing Codex record with zero responses: count it or document exact unsupported shape (UA-5). | Minimal shape reproduction and reconciliation; after unit 2. |
| 9 | O-7 session `byProvider` last-wins repair. | Count-only reproduction, provider totals; after parser integration. |
| 10 | X-8 Codex effort, first-token time and compaction capture. | Field fixtures and aggregate reconciliation; after parser integration. |
| 11 | C-6 Claude `cost-state` reconciliation. | Cost-state fixture and count-only sample; after parser integration. |
| 12 | C-8 cross-file message-id dedup. | Duplicate message fixture and count-only sample; after parser integration. |
| 13 | C-9 local-timezone day bucketing frozen in cache. | Boundary-day fixtures in two zones; after cache integration. |
| 14 | C-11 unknown-record counter. | Known/unknown record fixtures; after parser integration. |
| 15–19 | O-6, O-9, O-10, O-11, O-12, each in a separate commit. | Recover the exact audit requirements first; then current count-only reproduction. Candidate topics are cost trust, database discovery, V2/legacy storage, compaction/reconciliation, and sidechain exclusion. These descriptions are hypotheses, not acceptance criteria. Wait for V4 ownership to clear. |
| 20 | StatusLine classifier reads local managed settings. | Settings fixture and classifier regression; independently reordered before V4 integration. Other managed policy channels remain unobserved. |
| 21 | Shell wrapper around footer helper is `custom` (UA-4). | Wrapper fixture; after unit 20. |
| 22 | Shared labels across Usage, System Projects, Maintenance and Intelligence; unknown has one label and designations use separate axes. | View assertions; **after V3 merges into develop**, then integrate develop. |
| 23 | Show imported exclusion count in Intelligence census, System Projects and `ak system`; disclose Cowork source coverage is absent. | Three render assertions and source-bound counts; after V3 and unit 7. |
| 24 | Accept ADR-0060 and align DDD/docs to verified implementation. | Docs links and drift checks; controller-owned shared edits after all prior units. |

## Source and test map for later units

These are the current source and regression entrypoints, not permission to edit a
file owned by another lane. Confirm each boundary against the integrated tree at
dispatch, especially after V4 and V3 land. Add a focused test when existing tests
do not cover the reproduced failure.

| Unit | Candidate source | Test entrypoint |
|---|---|---|
| 2 | `src/lib/usage-parsers.mjs`, `usage-project-evidence.mjs`, `usage-index.mjs` | `tests/kit/usage-index.test.mjs`, `usage-codex-attribution.test.mjs` |
| 3 | `src/lib/usage-parsers.mjs`, `usage-aggregate.mjs` | `tests/kit/usage-codex-attribution.test.mjs`, `usage-classify.test.mjs` |
| 4 | `src/lib/usage-parsers.mjs`, `footprint/project-sources.mjs` | `tests/kit/usage-claude-dedup.test.mjs`, `dashboard-project-identity.test.mjs` |
| 5 | `src/lib/footprint/runtime.mjs`, `project-census.mjs` | `tests/kit/footprint-collectors.test.mjs`, `system-summary.test.mjs` |
| 6 | `src/lib/usage-parsers.mjs`, `usage-local-provider.mjs` | `tests/kit/usage-provenance.test.mjs`, `usage-local-pricing.test.mjs` |
| 7 | `src/lib/codex-import-marker.mjs`, `usage-parsers.mjs`, `footprint/project-sources.mjs` | `tests/kit/project-sources-imports.test.mjs`, `usage-codex-attribution.test.mjs` |
| 8 | `src/lib/usage-parsers.mjs`, `usage-aggregate.mjs` | `tests/kit/usage-codex-attribution.test.mjs`, `usage-codex-large-rollout.test.mjs` |
| 9 | `src/lib/usage-opencode.mjs`, `usage-aggregate.mjs`; parser row identity already exists | `tests/kit/usage-opencode.test.mjs`, `usage-index-opencode.test.mjs`, `usage-index.test.mjs` |
| 10 | `src/lib/usage-parsers.mjs`, `usage-insights.mjs` | `tests/kit/usage-codex-attribution.test.mjs`, `usage-context.test.mjs` |
| 11 | `src/lib/usage-parsers.mjs`, `usage-cost.mjs`, `usage-aggregate.mjs`, `usage-index.mjs` | `tests/kit/usage-claude-cost-state.test.mjs`, `usage-claude-dedup.test.mjs`, `usage-index.test.mjs` |
| 12 | `src/lib/usage-parsers.mjs`, `usage-index.mjs` | `tests/kit/usage-claude-dedup.test.mjs`, `usage-index.test.mjs` |
| 13 | `src/lib/usage-index.mjs`, `usage-aggregate.mjs` | `tests/kit/usage-index.test.mjs`, `usage-claude-window-pairing.test.mjs` |
| 14 | `src/lib/usage-parsers.mjs`, `usage-aggregate.mjs` | `tests/kit/usage-index.test.mjs`, `usage-telemetry.test.mjs` |
| 15 O-6 | `src/lib/usage-opencode.mjs`, `usage-cost.mjs` | `tests/kit/usage-opencode.test.mjs`; recover requirement first |
| 16 O-9 | `src/lib/usage-opencode.mjs`, `usage-opencode-bounds.mjs` | `tests/kit/usage-index-opencode.test.mjs`; recover requirement first |
| 17 O-10 | `src/lib/usage-opencode.mjs`, `usage-index.mjs` | `tests/kit/usage-opencode.test.mjs`; recover requirement first |
| 18 O-11 | `src/lib/usage-opencode.mjs`, `usage-aggregate.mjs` | `tests/kit/usage-opencode.test.mjs`; recover requirement first |
| 19 O-12 | `src/lib/usage-opencode.mjs`, `usage-parsers.mjs` | `tests/kit/usage-opencode.test.mjs`; recover requirement first |
| 20 | `src/lib/quota.mjs` | `tests/kit/quota.test.mjs`, `usage-limits-empty-state.test.mjs` |
| 21 | `src/lib/quota.mjs` | `tests/kit/quota.test.mjs` |
| 22 | `src/lib/dashboard/client/usage.mjs`, `system-projects.mjs`, `intelligence.mjs`, `maintenance-filters.mjs` | `tests/kit/dashboard-project-groups.test.mjs`, `intelligence-table-groups.test.mjs`, `maintenance-dashboard-client-labels.test.mjs` |
| 23 | `src/lib/dashboard/client/intelligence.mjs`, `system-projects.mjs`, `src/commands/system.mjs` | `tests/kit/dashboard-intel-integration.test.mjs`, `system-command.test.mjs` |
| 24 | `docs/adr/0060-session-surface-initiator-and-product-names.md`, relevant DDD guide | `tests/kit/docs-layout.test.mjs` and Markdown lint |

Units 9–19 each require a current real-data reproduction before implementation; the
reference-machine numbers in ADR-0060 are historical, not current results. Unit 1 does
not read personal transcripts, change parser/cache schemas, or implement any view.
