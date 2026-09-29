# Issue 211: Dashboard and usage documentation audit

Audit date: 2026-09-09. Implementation baseline: `67fb5c0` (PR #210 squash merge).
All three assigned files were read in full (3,804 baseline lines) and compared with
current server handlers, parser/aggregation contracts, browser renderers, and tests.
This audit changes documentation only; it does not silently repair product semantics.

## Findings and dispositions

| ID | Priority | Finding | Documentation disposition |
| --- | --- | --- | --- |
| DU01 | High | Dashboard local delivery described as globally offline/read-only despite status version probes, cache writes, and Limits host RPC. | Separate same-origin browser traffic, source-history preservation, derived state, provider/version lookups, and repair controls. |
| DU02 | High | Navigation/token wording hid query-token acceptance on every API GET. | State the actual header/query split and treat token-bearing URLs as credentials; mutation still requires header. |
| DU03 | High | Every dollar described as published-price arithmetic; OpenCode recorded cost wins and unknown models use fallback. | Document recorded-cost precedence, fallback estimates, and invoice limits. |
| DU04 | High | “In window” implied event clipping; aggregation selects by session end then folds complete records. | State whole-session population for totals, days, projects, Context, and previous comparisons. |
| DU05 | High | Codex cumulative row described without last-model/last-day attribution limits. | Explain no per-model/day delta reconstruction in long/resumed/model-switched sessions. |
| DU06 | High | Session context chip claimed paired evidence despite legacy-field division. | Describe its weaker implementation and direct readers to paired Context measurements; code follow-up. |
| DU07 | High | Transcript limits and meta parity described as shared across all hosts. | Separate OpenCode SQL path from JSONL containment/64 MiB cap; name narrower metadata fields. |
| DU08 | High | `humanPrompts` described as verified typed prompts and prompt kind as authorship. | Distinguish main-thread counts, fingerprint provenance, and unrecognized-template fallthrough. |
| DU09 | Medium | Only Codex described as recording inference provider; two stores and no Codex context turns. | Include OpenCode SQLite/provider/delegation/tool behavior and recognized Codex context turns. |
| DU10 | Medium | Models described private selectors as pseudonyms despite owner-visible-v2. | Match bounded exact model identity while retaining hidden sensitive joins and endpoints. |
| DU11 | Medium | Day counts claimed to sum to all sessions and “billed” implied positive measured spend. | Disclose empty-ledger sessions and zero-valued usage-row day buckets. |
| DU12 | Medium | Current schema/fingerprint docs still referred to 17/18, planned view, and exact keys without facets. | Record schema20 and optional controlled `i`/`d` fields; distinguish earlier schema history. |
| DU13 | Medium | Date growth described mtime bucketing as exact for append-only transcripts; platform census claimed always available. | Describe mtime size distribution and collector availability limitations. |
| DU14 | Medium | Checked citations were treated as proof of document semantics and current vendor evidence. | State locator-test scope; retain dated measurements and pricing-audit provenance. |
| DU15 | Medium | Cost example mixed $0.445 token arithmetic with $0.525/runtime narrative; cache multiplier copy overstated. | Keep independent $0.445 arithmetic and disclose UI multiplier overgeneralization. |
| DU16 | Medium | Broad host absence claims inferred no native interrupts/context APIs from parser omissions. | Describe normalized collector coverage, not native-host impossibility. |
| DU17 | Medium | Replay could be read as durable full transcript history and masking as total secret removal. | State bounded stream/ring behavior and best-effort pattern masking. |

## Per-file coverage

The source/test paths below are repository-relative. Test references identify relevant
coverage; only the commands in Validation claim execution in this pass.

| File | Source and test evidence | Findings | Remediation | Remaining limitations |
| --- | --- | --- | --- | --- |
| `docs/DASHBOARD.md` | `src/lib/dashboard-server.mjs` token gate/status/limits; `src/lib/dashboard/client/usage.mjs` score/session rendering; `src/lib/dashboard/client/usage-context-hooks.mjs`; `src/lib/model-inventory/read-model.mjs`; `tests/kit/dashboard-usage-telemetry.test.mjs`, `tests/kit/context-display-semantics.test.mjs` | DU01–04, DU06, DU08–11, DU13, DU16 | Corrected transport/state/privacy, host cost/provider facts, project populations, time selection, context chip, model identity and measurement copy. | No browser implementation changed; shared collectors and host-specific facts do not guarantee present machine health or complete coverage. |
| `docs/TRANSCRIPTS.md` | `src/lib/usage-index.mjs` `readSession`; `src/lib/usage-parsers.mjs`; `src/lib/usage-opencode.mjs`; `src/lib/usage-aggregate.mjs` `sessionPayload`; `src/lib/dashboard/session-security.mjs`; `src/lib/live/{transcript-streams,replay-stream}.mjs`; `tests/kit/usage-index.test.mjs`, `tests/kit/usage-opencode.test.mjs`, `tests/kit/doc-citations.test.mjs` | DU02–03, DU07–09, DU12, DU14, DU16–17 | Added SQLite path and boundaries, corrected identity/turn semantics and meta scope, qualified mask and replay claims, current cache version. | OpenCode query materialization lacks JSONL-equivalent session-byte bound. Prompt-kind `you` label remains weaker than verified authorship. |
| `docs/USAGE-SCORECARD-METRICS.md` | `src/lib/usage-aggregate.mjs` `buildSessionRows`, `foldSessionUsageRows`, `foldSessionTotals`; `src/lib/usage-parsers.mjs` `finalizeCodexUsage`; `src/lib/usage-opencode.mjs` `recordAssistantUsage`; `src/lib/pricing.mjs`; `src/lib/usage-provenance.mjs`; `tests/kit/usage-index-v6.test.mjs`, `tests/kit/pricing-revert.test.mjs`, `tests/kit/usage-git-projects.test.mjs` | DU01, DU03–05, DU08–09, DU11–12, DU14–16 | Corrected cost exceptions, whole-session and cumulative attribution, provenance denominators, schema facets, day counts, arithmetic and historical verification wording. | Numeric fallback pricing remains shipped; no unpriced/local-$0 fields introduced. ADR-0011's local-provenance proposal remains unimplemented. |

## Validation

- Baseline citation tests passed **before** edits despite the semantic issues above; this
  is why symbol/range checks are evidence of location, not a comprehensive audit verdict.
- `node --test tests/kit/usage-index.test.mjs tests/kit/usage-index-v6.test.mjs tests/kit/usage-opencode.test.mjs tests/kit/usage-git-projects.test.mjs tests/kit/context-display-semantics.test.mjs tests/kit/pricing-revert.test.mjs tests/kit/dashboard-usage-telemetry.test.mjs`: **319 passed**.
- `node --test tests/kit/doc-citations.test.mjs`: **2 passed** after corrections.
- Markdown lint: **109 configured files passed**, including this matrix.
  `git diff --check` passed.
- No new live-session/provider probe, invoice comparison, browser screenshot, or benchmark
  was performed for documentation-only corrections. Existing screenshots remain dated
  evidence for the implementation they captured.

## Product follow-ups, not silently fixed here

1. Consider an explicit event-clipped usage mode or visibly name the session-end population.
   `buildSessionRows` applies only session-end bounds before folding every usage row;
   Codex puts final cumulative counts under its last day/model.
2. Align the legacy `ctxChip` with paired `contextEvidence`; the current helper can combine
   independently captured values and caps the percentage at 100%.
3. Bound the OpenCode transcript query/materialization before constructing full turns;
   the JSONL 64 MiB cap does not apply to that SQL branch.
4. Preserve missing-cost coverage per OpenCode message: a row mixing recorded and missing
   costs uses only the recorded sum. `Number(data.cost)` also admits explicit null as zero.
5. Update cache tile's hardcoded “0.1×” and main-thread prompt wording where UI copy still
   overstates model-specific rates or independently verified human authorship.
6. Decide whether query-token GET support should be restricted to SSE; the current server
   accepts it for all API GETs. Do not describe an unimplemented restriction as protection.

The audit does not invent unknown-price states, a local-zero billing contract, a durable
replay archive, or absent host APIs to make the documents appear more uniform.
