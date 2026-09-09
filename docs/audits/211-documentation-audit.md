# Documentation implementation-alignment audit — issue 211

- **Date:** 2026-09-09
- **Reference implementation:** `67fb5c0a57400004a7f878780680a6e07834b264`, the PR #210 squash merge
- **Scope:** ADRs, DDD, operator/contributor guides, shipped references, field manual,
  historical evidence, diagrams, screenshots, and documentation check coverage
- **Status:** remediation complete; integration validation recorded below

## Outcome

The audit compared documented behavior with source, existing contract tests, safe command/help
output, selected current upstream documentation, and synthetic reproductions. It corrected
unsupported or stale claims while preserving genuine historical design/evidence records.
No pricing, collection, teardown, authentication, routing, or release logic was changed to make
an old claim true. Embedded CLI/model-help text, comments, and documentation-validation configuration were
updated as documentation surfaces.

The audit found problems that ordinary link/symbol checks did not detect: stale ADR status,
proposed local-cost and durable-archive features described as shipped, wrong host/source and
privacy boundaries, whole-session versus event-window semantics, outdated UI descriptions,
unsafe teardown/diagnostic sharing promises, and nonexistent contributor commands.

## Coverage and traceability

[The baseline inventory](211-inventory.csv) records path, classification, owner, byte size and
SHA-256 for **200 tracked documentation/artifact files**. It is a reference-state inventory,
not a hash of the final rewritten prose. Every baseline file has one review owner/disposition.
New audit reports and indexes are reviewed as outputs, not counted as pre-existing coverage.

| Scope | Baseline files | Evidence matrix |
| --- | ---: | --- |
| ADRs and decision index | 49 | [ADR matrix](211-adrs-matrix.md) |
| Domain documents and aligned Maintenance/language guides | 19 | [DDD matrix](211-ddd-matrix.md) |
| Host/model/setup and shipped reference/template guides | 29 | [Host matrix](211-hosts-matrix.md) |
| Dashboard, Transcripts and Usage Metrics | 3 | [Dashboard matrix](211-dashboard-matrix.md) |
| Root/deployment/core guides and public field manual | 12 | [Core matrix](211-core-matrix.md) |
| Historical records and supporting artifacts | 88 | [History matrix](211-history-matrix.md), [per-file CSV](211-history-files.csv) |

The first five streams used substantive source/contract review. The historical/artifact stream
states its different review levels per file: frozen-context and link review, XML/schema checks,
active diagram correction, and PNG integrity/scope checks. **This does not certify every historical
claim or replay every old experiment.** Historical screenshots remain unchanged. Two active
transcript diagrams were corrected; the field manual's older captures are explicitly labelled.

## Remediation themes

1. **Current versus proposed:** preserve ADR-0011's proposed local billing/fidelity work and
   ADR-0012's deferred durable archive; correct indexes and later superseding behavior.
2. **Evidence and authority:** distinguish registration/configuration/catalogs from actual
   runtime use, entitlement, billing, successful writes, and release authorization.
3. **Actual product semantics:** document OpenCode-reported costs, fallback estimates,
   session-end window admission, main-thread prompt denominators, separate transcript payloads,
   current schema20, and the latest project/context/learning presentation.
4. **Boundaries and privacy:** correct Dashboard server egress/cache effects, GET query-token
   compatibility, owner-visible model identifiers, Windows runtime observation, byte-bound gaps,
   and surface-specific teardown preservation.
5. **Usable instructions:** match real npm/pnpm/CLI commands, Docker lifecycle and `-e` forwarding,
   container setup/link behavior, release credential requirements, and branch cleanup.
6. **Package usability:** 88 links from selected npm-bundled documents now open
   repository documentation when their targets are not shipped locally.
7. **Durable maintenance:** extend Markdown/link checks to maintainer, Docker and shipped
   references, including offline anchor checks; give archives, audits, assets, evidence
   and schemas explicit authority indexes.

## Implementation defects recorded separately

[Eight follow-up groups](211-code-followups.md) remain outside documentation remediation.
Four were reproduced with synthetic fixtures against actual source:

- null/mixed OpenCode costs can undercount;
- a Sessions chip can calculate pressure from unpaired observations;
- legacy router undo can discard later user edits;
- the standalone diagnostic has pricing/replay divergence and prints a scan root while
  describing output as path-free.

The remaining source-inspected limitations cover acquisition bounds, the declared Node floor,
OpenCode's usage descriptor, and product/presentation semantics. The [reproduction script](211-repros.mjs)
and [results](211-repro-results.json) record the controls and observed differences. These are
not quietly closed by making the documentation truthful.

## Validation

- Agent streams ran 106 ADR-boundary, 199 domain, 154 host/reference, and 319 Usage contract tests;
  these overlap and are **not summed into a unique test total**.
- Integration command/help, guidance-budget/target, and citation checks passed 71 tests.
  An obsolete note-copying documentation assertion was replaced with checks for
  evidence-based selection guidance and the per-token/per-task distinction; behavioral
  routing assertions remain in place.
- Expanded link check with external requests: 1,653 references, 774 unique, zero
  errors, 14 excluded, and seven redirects at that pass. The separate offline gate
  also passed; excluded/accepted-rate-limit responses are not content-validation proof.
- Historical sweep separately identified 12 frozen relocation-link occurrences. Working successor
  mappings are recorded in the archive index; frozen historical bodies remain unchanged.
- All 21 historical PNGs passed integrity/dimension checks. SVGs parsed; corrected diagrams and
  the field manual were rendered in Chromium for desktop/narrow layout inspection.
- Full integration `npm test` passed: 3,829 tests passed, six skipped, followed by all
  legacy script suites. Typecheck, lint, complexity and build checks passed. Final
  CI results are recorded in the pull request for the exact candidate.

## Explicit limits

No host installation, inference call, real-user memory canary, destructive procedure, provider
teardown, release, or account entitlement probe was executed. The only mutating reproductions
used temporary synthetic fixtures. External documentation checks are dated observations; web
failures/rate limits are reported separately from broken local links. Container and release
instructions were compared with their definitions, not executed as a new clean-room release.
The full documentation audit is complete at these stated review levels; remaining implementation
work is intentionally separate.
