# Usage accuracy execution plan

- **Branch:** `fix/usage-accuracy`, based on `develop@e2f9dcae0554ff63921df618a819fd5e6afe80d2`
- **Scope sources:** [v2 V6](2026-09-28-remediation-program-v2.md),
  [v1 Wave 4](2026-09-26-remediation-program.md),
  [ADR-0060](../adr/0060-session-surface-initiator-and-product-names.md).

## Status

Active. Unit 1 is implemented on this branch. Unit 20 is dispatched independently:
V4 has no planned `quota.mjs` edits, B1 is integrated, and the controller cleared
the classifier file boundary. Its managed-file precedence does not depend on the
pending raw-origin review decision or parser/cache migration. All other unit
dependencies remain in force; each later unit requires a separate dispatch,
RED/GREEN evidence and capture commit.

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
| 9 | `src/lib/usage-parsers.mjs`, `usage-aggregate.mjs` | `tests/kit/usage-telemetry.test.mjs`, `usage-index.test.mjs` |
| 10 | `src/lib/usage-parsers.mjs`, `usage-insights.mjs` | `tests/kit/usage-codex-attribution.test.mjs`, `usage-context.test.mjs` |
| 11 | `src/lib/usage-parsers.mjs`, `usage-cost.mjs` | `tests/kit/usage-telemetry.test.mjs`, `usage-claude-window-pairing.test.mjs` |
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
