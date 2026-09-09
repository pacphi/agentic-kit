# Issue 211: implementation follow-ups found by the documentation audit

Implementation follow-up: [remediation and validation](211-remediation.md).
The findings below preserve the original audit baseline.

Reference baseline: `67fb5c0` (2026-09-09). These defects/limitations were **not
changed** by the documentation remediation. Documentation now states the existing
behavior. The first four findings have actual-source synthetic reproductions.

Run `node docs/audits/211-repros.mjs` from a maintained Node version in a checkout.
It uses and deletes only its own temporary SQLite/JSONL/router fixtures; it does not
read real transcripts, invoke an inference host, or mutate user configuration.
The [recorded output](211-repro-results.json) includes primary-source SHA-256 values.
The reference baseline names this audit; running the script later exercises that
checkout's current source, not a hidden copy of the old implementation. `pass:false`
in the output reproduces a defect and is not a failed documentation CI gate.

These are separate implementation work items, not implied authorization to change
pricing, teardown, telemetry, or runtime requirements in this documentation PR.

## CODE-01. OpenCode missing-cost handling fabricates zero and undercounts mixed rows

Priority: high data accuracy.
Source: `src/lib/usage-opencode.mjs` `recordAssistantUsage`;
`src/lib/usage-aggregate.mjs` `foldSessionUsageRow` / `sessionCost`.

The reader uses `Number.isFinite(Number(data.cost))`, so JSON `cost:null` becomes a
recorded zero. A `(day,model)` aggregate row also keeps `costObserved` as soon as any
message supplies a cost; later/earlier missing-cost messages contribute tokens but no
estimated dollars because the whole row bypasses pricing.

Synthetic actual-source results, model gpt-5.6-sol, 1,000,000 input tokens/message:

| Case | Expected under existing missing-cost fallback | Actual |
| --- | --- | --- |
| Cost absent | $4 estimate | $4 (control passes) |
| Cost null | $4 estimate or explicit missing-cost state | $0, `costObserved:0` |
| Same day/model: one message cost $0.25, one cost absent | $4.25 combined if retaining current estimate semantics; otherwise explicitly partial | $0.25 for 2,000,000 input tokens |

Acceptance suggestion: distinguish valid finite nonnegative number from null/undefined;
retain per-message missing-cost coverage before row coalescing. Preserve explicit numeric
zero as genuine recorded zero. Test all absent/null/zero, observed+missing both orders,
different models/days, negative/nonfinite/invalid shape. State estimates versus reported
values in payload rather than hiding missing portions under a complete-looking sum.

## CODE-02. Sessions context chip reports percentage without paired pressure evidence

Priority: high reporting consistency.
Source: `src/lib/dashboard/client/usage.mjs` `ctxChip`;
`src/lib/usage-parsers.mjs` `handleCodexTaskStarted`, `handleCodexTokenCount`, `noteContextSample`.

Synthetic Codex rollout records `task_started.model_context_window=200000`, then a
separate token_count with `last_token_usage.input_tokens=100000` and no window field.
The real parser produces `contextEvidence.state:'partial'` and `pressure:null`, while
legacy fields retain the separate input and window observations. Actual `ctxChip` emits:

`<span class="s-chip" title="context at the last turn: 100000 of 200000 tokens — both recorded by the transcript">ctx 50%</span>`

Expected: no pressure percentage when the normalized record has no paired pressure
observation, consistent with Usage > Context. Prefer current paired evidence and keep
legacy values as separately labelled values if useful. Test unpaired input/window,
changed window followed by numerator-only record, fully paired record, absent evidence,
and >100% values without hiding the actual numeric pressure.

## CODE-03. Legacy AQE router teardown discards post-setup user edits

Priority: high preservation.
Source: `src/lib/aqe-router.mjs` `undoAqeRouter`; dispatched by host teardown.

An isolated project has prior `.agentic-qe/llm-config.json.bak`:
`{"defaultProvider":"gemini","userKey":"original"}`.
Current managed file, representing a later user edit:
`{"_managedBy":"agentic-kit","defaultProvider":"openai","userKey":"edited-after-setup","newUserKey":"keep-me"}`.

Actual `undoAqeRouter(project)` succeeds with `restored pre-ak llm-config.json` and
replaces it with the old backup. `newUserKey` is gone and `userKey` is reverted. The
current-value managed marker authorizes whole-file restore; no postimage drift check
protects later edits. With no backup the same branch deletes the marked whole file.

Expected: preserve user-owned/modified fields or refuse unresolved drift with a clear
recovery path. Existing tests only cover pristine managed teardown and old backup
preservation, not edits after projection. Add edited owned/foreign keys, backup/no-backup,
exact unchanged projection, and interrupted restore cases; align with value-specific
ownership used by newer projections. Separate `undoProviders` named-env deletion deserves
related review but was not executed in this repro.

## CODE-04. Standalone Codex diagnostic disagrees with current parser and leaks scan root

Priority: medium diagnostic accuracy/privacy.
Source: `scripts/codex-usage-diagnostic.mjs` `parseRollout`, `RATES`, human output;
compare `src/lib/usage-parsers.mjs` `handleCodexMeta` and `src/lib/pricing.mjs`.

All three demonstrated with actual script execution over synthetic JSONL:

- One gpt-5.6-sol session, 1M input: current parser/table yields $4; diagnostic yields $5.
- First `session_meta` says child/subagent; later replayed parent metadata says user.
  Current parser keeps subagent and zero usage rows; diagnostic reports user=1,
  subagent=0, and 1M tokens in “afterFix_excludingSubagentReplays”.
- Human output says `No prompts, titles, session ids, file paths, or timestamps below.`
  and `This entire block is safe to paste back in full.`, then prints the actual
  `Rollout files scanned root: <temporary root>` line. JSON mode avoids that line.

Expected: either bring diagnostic parity current (while preserving explicit independent
comparison goal) or retire/relabel its legacy claims. Never describe root-bearing output
as path-free. Test first-meta precedence, current message response formats/rates, missing
thread source, and output absence of supplied distinctive path marker. The current main
parser is also string-only for thread_source: this report does NOT claim it supports
`source.subagent` shape where the standalone script does not.

## CODE-05. Acquisition byte bounds are weaker than retention bounds

Source review: `src/lib/live/jsonl-tailer.mjs` reads the appended byte range with
`Buffer.alloc(stat.size - this.#offset)` and retains an unterminated carry without
an explicit byte ceiling. `src/lib/usage-opencode.mjs` materializes a selected SQL
session without the JSONL reader's 64 MiB guard. Event-ring, field, and row limits
do not bound these earlier allocations.

Follow-up: bound acquisition/chunk/carry and SQL materialization before parsing;
preserve explicit truncation/coverage instead of silently dropping data. Test large
append, long incomplete line, burst growth, and oversized selected SQLite session.
No destructive or resource-exhaustion test was run during this audit.

## CODE-06. Declared Node range is broader than the SQLite runtime floor

`package.json` declares `>=22`, while `src/lib/sqlite.mjs` statically imports
`node:sqlite`. The module was added in 22.5 and unflagged in 22.13. CI exercises
maintained patch releases, not every version admitted by the engine range.

Follow-up: establish and test the actual minimum patch version, then reconcile
engines/install diagnostics/CI. Documentation recommends maintained patch releases
and names this limitation; this PR does not change supported runtime policy.

## CODE-07. OpenCode registry descriptor disagrees with Usage collection

`src/lib/adapters/registries.mjs` declares the built-in OpenCode usage capability
false while the Usage path reads its SQLite sessions through `usage-opencode.mjs`.
This can mislead descriptor-based consumers even when the dedicated UI has data.

Follow-up: define the descriptor's intended meaning, align it with collection, and
add a contract test across both surfaces. This is separate from OpenCode's absence
of native live-Observability transcript support or an AQE provider identity.

## CODE-08. Remaining presentation/product semantics require separate decisions

- The Usage timeframe admits sessions by their end and folds their whole retained
  rows; it is not an event-clipped billing window. Decide whether to add clipping
  or make that scope more visible in the UI without inventing unavailable splits.
- The cache tile's fixed `0.1×` wording and some human/typed-prompt labels exceed
  the model-specific pricing/provenance evidence.
- Runtime Context configuration uses an explicit `en-US` format, while the
  date/time design prefers browser locale; relative helpers also retain separate
  behavior. The audit identifies those gaps without changing formatting logic.
- API GET query-token compatibility extends beyond SSE. Any restriction requires
  an explicit compatibility/security implementation change, not a documentation
  claim that the restriction already exists.

See the [Dashboard matrix](211-dashboard-matrix.md), [host matrix](211-hosts-matrix.md),
and [DDD matrix](211-ddd-matrix.md) for precise source boundaries and tests.
