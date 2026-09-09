# Issue 211 remediation

Date: 2026-09-09. Starting checkout: `9b75092`. Implemented as focused commits on
`fix/audit-211-status-remediation`.
The [original audit](211-code-followups.md) remains historical evidence.
[Fresh synthetic results](211-remediation-results.json) bind the first four
findings to source SHA-256 digests; every reported reproduction now passes.

## Decisions and behavior

| Finding | Implemented outcome |
| --- | --- |
| CODE-01 | Only finite nonnegative numeric costs are observed, including zero. Missing portions retain their tokens before coalescing and are priced by model/day. `costEvidence` exposes observed/estimated dollars and message counts in session rows and reader metadata. Cache schema 21 forces reconstruction. |
| CODE-02 | Session chips use normalized paired pressure, not independently observed legacy fields. Values above 100% remain visible; tooltip identifies the last paired measurement. |
| CODE-03 | Router teardown requires exact postimage and backup evidence. Unknown legacy ownership and drift fail closed with recovery guidance. Exact restores are atomic and retain backups. Provider environment teardown checks value-specific receipts; interrupted writes retain ambiguity across retries. |
| CODE-04 | Diagnostic preserves first metadata, recognizes current message forms, labels missing source unknown, shares maintained pricing, and emits no scan root or arbitrary transcript strings. It remains an independent cumulative-snapshot comparison, with limitations documented. |
| CODE-05 | JSONL acquisition uses 64 KiB chunks, 1 MiB per reconciliation, and a 1 MiB line ceiling. SQLite preflight bounds selected session bytes/rows at 64 MiB/100,000 in the same read transaction. Coverage survives live snapshots, playback, session metadata, and aggregate omission notices. |
| CODE-06 | Engine range and early CLI diagnostic require `>=22.13.0 <23 \|\| >=23.4.0`. CI adds exact minimum-runtime smoke/tests. |
| CODE-07 | OpenCode's built-in usage capability now advertises SQLite collection; contract regression covers descriptor and collector. Native live-transcript support remains a separate capability. |
| CODE-08 | UI explains whole retained sessions selected by end, model-specific cache rates, and host-dependent prompt provenance. Runtime Context uses locale defaults. GET query-token compatibility and existing relative-time helpers are deliberately retained. |
| Added policy-call scope | Live call failed because `identity.agentId` was supplied instead of required `identity.id` and `identity.type`. Corrected request succeeded; verified contract and diagnostics documented in Troubleshooting. Upstream MCP nested schema remains weak; no installed package was patched. |

## Research

- [OpenCode session cost handling](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/session.ts): finite, nonnegative numeric checks support strict cost validation.
- [Node SQLite history](https://nodejs.org/api/sqlite.html): unflagged in 22.13.0 and 23.4.0, so early Node 23 must also be excluded.
- [SQLite octet_length](https://www.sqlite.org/lang_corefunc.html#octet_length): stored byte lengths can be measured without loading complete text bodies.
- Installed Ruflo CLI `mcp-tools/policy-tools.js` and security `policy/types.d.ts` /
  `PolicyEngine.validateRequest`: nested request fields, not registration alone,
  define the actual contract. Live policy status reported legacy mode and a valid
  ledger. Corrected request receipt:
  `sha256:2c5747e7409f99b819a16e1b442fb4029f82e6efb7d5ff5d70524087fcaa1379`.

## Validation

- Focused regression suites cover absent/null/invalid/zero costs, mixed order,
  model/day allocation, paired/unpaired/over-window context, destructive teardown
  drift and interruption, bounded ingestion, diagnostic privacy, and runtime edges.
- Actual Node 22.13.0: 85 integrated tests passed.
- `pnpm test`: 3,906 unit tests passed, six platform skips, zero failures;
  all subsequent legacy renderer/server suites passed. Coverage: 92.01% lines,
  80.90% branches, 91.56% functions (above both enforced floors and 80% line target).
- Typecheck, lint, hard complexity ceiling, Markdown lint, build and diff whitespace
  checks passed. Lint retains existing advisory complexity warnings.
- `pnpm run test:ui`: 491 browser assertions and six browser suites passed.
- Ownership helper focused coverage: 100% lines, branches, and functions.

AQE's initial quality assessment returned 20/100 using metrics not bound to this
fresh source/test run. It is not a validated score for this change; no 98/100
repository-score claim is made. Measured test evidence above is the acceptance
basis. No live user transcripts or configuration were used in regression fixtures.
Publication is limited to the user-authorized branch and pull request; no merge,
release, or worktree deletion is authorized by this work.
