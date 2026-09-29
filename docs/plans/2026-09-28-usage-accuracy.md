# Usage accuracy execution plan

- **Branch:** `fix/usage-accuracy`, based on `develop@e2f9dcae0554ff63921df618a819fd5e6afe80d2`
- **Scope sources:** [v2 V6](2026-09-28-remediation-program-v2.md),
  [v1 Wave 4](2026-09-26-remediation-program.md),
  [ADR-0060](../adr/0060-session-surface-initiator-and-product-names.md).

## Status

Active. All 23 source units are independently accepted. Unit 24 documentation is a
candidate awaiting independent review. Final integration gates, whole-branch review and
archival remain controller-owned. Unit 11 captures Claude Code's
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
is accepted. Unit 14 adds count-only Claude record coverage for known handled,
known ignored, unknown, invalid-type and malformed JSON lines. A v26 cache entry
without those counters reparses; unknown or malformed records degrade source
health without changing message usage or cost. The bounded real-data sample and
focused verification are in the ignored task14 handoff report. Unit 14 and Units 15–19 are independently accepted.

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
values remain excluded. Units 22/23 delivered the local detail UI and count/coverage disclosures. Unit 24 records
ADR-0060 acceptance against those implemented contracts, subject to documentation review.

Unit 6 records Amazon Bedrock or Google Vertex AI only when a Claude assistant
message carries a provider-specific model ID. Conflicting or ordinary IDs leave
the provider unknown. Historical transcripts do not capture launch environment
or settings, so current configuration cannot identify their serving provider;
OpenRouter, other gateways and private endpoints remain unknown without bound
session evidence. The detail stays under `sessionOrigin.thirdPartyProvider` with
`thirdPartyProviderBasis: assistant-model-id` when known. Units 22/23 implement display.

## Gates and ownership

All source units have completed their assigned implementation and independent review. Unit 24
owns the affected ADR bodies and living guides in the assigned worktree. The controller owns
shared indexes/manifests, final integration gates, whole-branch review, plan archival and any
separately authorized publication. Unit 24 runs documentation gates only. No private transcript
content, raw identifiers, paths or observed costs enter public documentation.

## Capture units

| Unit | Source boundary and acceptance | Focused evidence / dependency |
|---|---|---|
| 1 | Shared raw-value → surface → initiator → label vocabulary; bounded raw evidence, unknown and provider separate. Adapt footprint origin with legacy fields retained. | ADR table fixtures, first declaration, privacy, identity and imports regressions. Accepted. |
| 2 | Parser and usage cache integration, exactly one schema 25→26 bump. Carry new fields and rebuild old cache. | Parser, cache migration and aggregate tests; after unit 1. Footprint schema stays 8. |
| 3 | Full Codex `thread_source` classification, subagent/reviewer rollup and unpriced Auto-review models (X-7). | Per-value parser fixtures and counts; after unit 2. |
| 4 | Count Claude by `sessionId`, exclude subagent and bridge transcripts, and remeasure source-bound census. | Duplicate/session fixtures plus enumerated-count reproduction; after unit 2. |
| 5 | Runtime census symmetry for Claude.app and ChatGPT.app; attribute bundled CLIs to observed sessions. | Runtime fixtures on both app forms; after units 2–4. |
| 6 | Third-party Claude provider from session-bound provider-specific assistant model ID; unknown remains unknown and provider is a separate detail field. Cloud label renders only for observations. | Evidence-precedence and unknown fixtures; after unit 2. |
| 7 | Imported turn exclusion per turn; later genuine Codex turns count and establish an actual app origin (decision 12/B1-4). | Mixed import/real-turn fixture and enumerated-count reproduction; after unit 2. |
| 8 | Token-bearing Codex record with zero responses: count it or document exact unsupported shape (UA-5). | Minimal shape reproduction and reconciliation; after unit 2. |
| 9 | O-7 session `byProvider` last-wins repair. | Count-only reproduction, provider totals; after parser integration. |
| 10 | X-8 Codex effort, first-token time and compaction capture. | Field fixtures and aggregate reconciliation; after parser integration. |
| 11 | C-6 Claude `cost-state` reconciliation. | Cost-state fixture and count-only sample; after parser integration. |
| 12 | C-8 cross-file message-id dedup. | Duplicate message fixture and count-only sample; after parser integration. |
| 13 | C-9 local-timezone day bucketing frozen in cache. | Boundary-day fixtures in two zones; after cache integration. |
| 14 | C-11 unknown-record counter. | Known/unknown record fixtures; after parser integration. |
| 15–19 | O-6, O-9, O-10, O-11, O-12, each in a separate commit. | Accepted: cost trust and cache semantics, explicit database selection, V2/legacy coverage warnings, bounded compaction/reconciliation and child fingerprint exclusion. |
| 20 | StatusLine classifier reads local managed settings. | Settings fixture and classifier regression; independently reordered before V4 integration. Other managed policy channels remain unobserved. |
| 21 | Shell wrapper around footer helper is `custom` (UA-4). | Wrapper fixture; after unit 20. |
| 22 | Shared labels across Usage, System Projects, Maintenance and Intelligence; unknown has one label and designations use separate axes. | View assertions; **after V3 merges into develop**, then integrate develop. |
| 23 | Show imported exclusion count in Intelligence census, System Projects and `ak system`; disclose Cowork source coverage is absent. | Three render assertions and source-bound counts; after V3 and unit 7. |
| 24 | Accept ADR-0060 and align DDD/docs to verified implementation. | Docs links and drift checks; assigned documentation writer after all prior units; controller owns shared indexes. |

## Source and test map

This table preserves the initial candidate boundaries. Exact delivered files and source-bound
results are in the private unit reports; the candidates grant no new edit authority. All source
units are accepted and only the documentation candidate remains under review.

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
| 15 O-6 | `src/lib/usage-opencode.mjs`, `usage-cost.mjs` | `tests/kit/usage-opencode.test.mjs`; accepted |
| 16 O-9 | `src/lib/usage-opencode.mjs`, `usage-opencode-bounds.mjs` | `tests/kit/usage-index-opencode.test.mjs`; accepted |
| 17 O-10 | `src/lib/usage-opencode.mjs`, `usage-index.mjs` | `tests/kit/usage-opencode.test.mjs`; accepted |
| 18 O-11 | `src/lib/usage-opencode.mjs`, `usage-aggregate.mjs` | `tests/kit/usage-opencode.test.mjs`; accepted |
| 19 O-12 | `src/lib/usage-opencode.mjs`, `usage-parsers.mjs` | `tests/kit/usage-opencode.test.mjs`; accepted |
| 20 | `src/lib/quota.mjs` | `tests/kit/quota.test.mjs`, `usage-limits-empty-state.test.mjs` |
| 21 | `src/lib/quota.mjs` | `tests/kit/quota.test.mjs` |
| 22 | `src/lib/dashboard/client/usage.mjs`, `system-projects.mjs`, `intelligence.mjs`, `maintenance-filters.mjs` | `tests/kit/dashboard-project-groups.test.mjs`, `intelligence-table-groups.test.mjs`, `maintenance-dashboard-client-labels.test.mjs` |
| 23 | `src/lib/dashboard/client/intelligence.mjs`, `system-projects.mjs`, `src/commands/system.mjs` | `tests/kit/dashboard-intel-integration.test.mjs`, `system-command.test.mjs` |
| 24 | `docs/adr/0060-session-surface-initiator-and-product-names.md`, relevant DDD guide | `tests/kit/docs-layout.test.mjs` and Markdown lint |

Units 9–19 recorded bounded source observations and synthetic affected-row evidence in their
unit reports. A sample without an affected row is not proof of current-user impact. Reference
counts in ADR-0060 remain historical. No new real-data probe runs in Unit 24.

## Unit 18 accepted: OpenCode compaction and reconciliation

The parser reads bounded compaction parts and selected session metadata. A user
compaction request plus an error-free assistant summary with a finish value and
that actual parent link establishes one completed observation per request.
Requests alone, orphan summaries and in-flight markers retain uncertainty in the
lower/upper bounds. Failed or aborted summaries do not establish completion.
The OpenCode aggregate projection now retains those bounds; Codex and Claude
projections retain their existing behavior.

Session counters are diagnostic only. Exact OpenCode v1.18.33 source shows that
session totals accumulate step-finish parts, but assistant tokens hold the latest
step. Reconciliation therefore requires completed valid messages, exactly one
matching valid step per assistant, populated valid session counters, and no V2
rows in that session. Multiple or missing steps, incomplete metadata, unsupported
versions/token bases and untrusted hosted zero costs remain unknown. Matching or
mismatching counters never replace or add to message usage. No steps are billed a
second time. The cache marker extends cost-trust-v2 with observations-v1; schema
26, source identity and timezone checks remain intact.

The bounded local metadata sample contained three sessions, no compaction parts,
no in-flight markers and no populated session counters. Its database digest was
unchanged. This is not positive affected-user evidence; synthetic fixtures cover
the supported and failure cases. Detailed commands and evidence are in the
ignored task18 report.

Unit 18 review fixes bind warm reuse to a SHA-256 digest of the selected session's
observation metadata, relevant message fields, compaction/step-finish parts, and
V2 scope presence. Both the probe and parser stay within the same per-session
acquisition ceilings and their own read snapshots; the persisted digest comes
from the parse snapshot. Unchanged inputs reuse the cache; same-count rewrites
and removals invalidate it even when upstream timestamps do not change. No
whole-database payload hash or prompt-body hash is used.

Response-free request evidence now remains in the current/previous compaction
bounds. Refused acquisitions contribute only their unknown bound, preserving the
existing rule that they do not become ordinary zero-cost session rows. Neither
path manufactures responses, tokens or billing. Unit 18 was accepted before
Unit 19 began.

## Unit 19 accepted: OpenCode child prompt fingerprints

OpenCode sessions with a nonempty `parent_id` retain prompts, turns, tokens,
provider costs and subagent classification, but produce no prompt fingerprints.
Both scan and selected-session parsing apply this rule. Aggregation also excludes
old cached child fingerprints from typed-prompt metrics, current prompt patterns
and historical baselines; the cached bytes remain until normal invalidation.
Main-session behavior and Unit 18 cache identity, timezone and observation marker
checks remain intact. Schema 26 is unchanged.

Synthetic native-schema tests cover matching and distinct parent/child text,
child-only historical windows, absent parent rows, scan/read parity, stale warm
cache consumption and retained provider usage. The prior bounded preflight found
no child sessions; it does not establish current-user impact. Unit 19 is independently accepted; Unit 24 is the documentation candidate. Commands and results are in the ignored
task19 report.
