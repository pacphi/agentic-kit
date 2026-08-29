# ADR-0038 — Consistent cross-host session metrics

- **Status:** Accepted
- **Date:** 2026-08-29
- **Deciders:** agentic-kit maintainers
- **Related:** [ADR-0009](0009-usage-scorecard-local-transcript-analytics.md),
  [ADR-0010](0010-provider-mediated-quota-reads.md),
  [ADR-0016](0016-capability-driven-integration-adapters.md),
  [ADR-0017](0017-opencode-host.md),
  [ADR-0021](0021-inference-provider-provenance.md)

## Context

ADR-0009 established the usage scorecard as local transcript analytics with graded evidence: it
answers what a window cost and what produced the cost. It does not answer how the work was *run* —
under what permission posture, how fast the model answered, how full its context window was, whether
a person or a delegated agent drove, and which vendor actually served the inference.

Two research passes established what the retained transcripts can and cannot answer. A metric
evidence matrix enumerated every candidate metric against the fields each host actually writes; a
scorecard mockup fixed which of the survivors earn panel space and what each panel must say when its
evidence is missing. The finding that shaped everything below is that **the three hosts record these
things asymmetrically, and with different strength of evidence**:

- Claude Code writes a `permissionMode` on user entries but no turn timing and no context-window
  size; latency and context pressure have to be *derived* from the entries themselves.
- Codex writes `approval_policy`/`sandbox_policy` per `turn_context`, a `model_context_window` on
  `task_started`, and its own host-measured `duration_ms` on `task_complete` — the only
  host-measured turn duration and the only recorded context-window denominator in the corpus.
- OpenCode writes a `mode` per assistant message and enough per-message timing to derive a latency,
  but no window size.

Folding that asymmetry into one number per metric would state a claim the evidence does not support.
Every decision below is a rule for keeping the shapes comparable *without* pretending the evidence
behind them is uniform.

One further problem surfaced during implementation rather than research, and is recorded here
because it changed what the delegation metric means. A delegation panel was built, reviewed, and
found to be reporting a subagent slice the pipeline could not produce. The root cause was in
discovery, not in the panel: `listClaude` walked exactly one level of project directories, while
Claude Code writes sidechain transcripts one level deeper, at
`<project>/<sessionId>/subagents/agent-*.jsonl`. Real, cost-bearing delegated work had never entered
the index at all. Three separate censuses had appeared to disagree about how much sidechain work
existed; they were measuring different things — 51 nested files on disk against 0 ingested by the
pipeline. Shipping a knowingly blind delegation metric behind a disclaimer was judged below the
standard for this work when the fix was one contained discovery function.

## Decision

### 1. Permission posture is one closed vocabulary; every mapping is a recorded judgment

`src/lib/usage-modes.mjs` holds the whole taxonomy and nothing else. `MODES` is exactly four values
— `guarded`, `auto-edit`, `plan`, `unrestricted` — and `normalizeMode({host, permissionMode,
approvalPolicy, sandboxPolicy, opencodeMode})` is the only mapping from a host's raw evidence into
them. Every row of that table is pinned value-by-value by tests, because each row is a judgment call
rather than a derivation.

Two of those judgments are load-bearing:

- **The read-only sandbox check runs first.** Codex `approval: never` + sandbox `read-only` is
  `plan`, not `unrestricted`: a session that cannot write is not permissive however its approval
  policy is spelled.
- **Approval evidence alone is sufficient for `guarded`, and only for `guarded`.** Human-in-the-loop
  *is* the posture, so a Codex session recording `on-request`/`on-failure`/`untrusted` and no
  sandbox policy maps to `guarded` rather than falling to not-recorded for want of a second field.
  The cost of this ruling is bounded and disclosed: a Codex session whose sandbox is genuinely
  unknown renders `guarded` rather than not-recorded. Every other Codex mapping still requires both
  fields.

### 2. An unmapped value is `not-recorded`, and that is a first-class bucket

Every lookup is `?? null`. A raw value this taxonomy has not been taught — a future
`permissionMode`, a policy spelling that has not shipped yet — yields no mode, never a nearest
guess. The host's own spelling is retained beside the normalized value as `modeRaw`, precisely
because the mapping is a judgment and a reader auditing it needs the evidence it was made from.

`not-recorded` is a bucket key in the aggregate, not a display fallback: it is created before the
fold, offered as a row by the CLI table even at zero, and forced to the de-emphasis ink in the UI so
that spend with no posture evidence can never read as a posture.

### 3. Response latency means prompt-to-response, and is never called time-to-first-token

The primary sample on every host is the gap between a human prompt and the completion that answered
it. Codex's host-measured `task_complete.duration_ms` is a **fallback**, used only when no
prompt-gap sample already covered that turn; the turn-start marker is cleared the moment a gap
sample fires, so a turn is never double-sampled. An aborted turn (`turn_aborted`) clears both
latency states, so an unanswered prompt is never timed against a later, unrelated response, and an
API-error placeholder is never a sample — its pending window is deliberately left open so the first
real completion that follows is what gets timed.

The `MAX_LATENCY_SAMPLE_SECONDS` ceiling of 3600s applies to the **derived prompt-gap path only**.
A derived gap that large is overwhelmingly a person who walked away, not a model that took an hour;
a host-measured duration that large is a real turn, and the open-ended top bucket absorbs it.

This figure is deliberately never labelled TTFT anywhere in the code, the docs, or the UI. No local
transcript records the arrival of a first token; conflating the two would misname a measurement that
is easy to misread as vendor-side latency.

### 4. Percentiles come from bucket histograms, and an overflow percentile reports its floor

Latency and session length are stored per session as fixed-edge histograms
(`LAT_BUCKET_EDGES = [2, 5, 10, 30, 60]` seconds, `LEN_BUCKET_EDGES = [300, 900, 2700, 7200]`
seconds) rather than as raw sample arrays, so a window merges slot-wise and the payload never
carries per-turn timings. `percentileFromBuckets` interpolates within a bounded bucket and returns
the bucket's **lower edge** when the percentile lands in the open-ended overflow slot.

Because that value is a floor rather than a point, every renderer of it — dashboard and CLI alike —
prefixes it with `≥`. Rendering `60s` where the honest claim is `≥60s` would be false precision.
A window with no samples reads `not measured`; a session that never observed a latency keeps a null
histogram rather than a fabricated row of zeroes.

### 5. `engagedByDay` is a sibling map, because `byDay` has a presence contract

Per-day engaged seconds do **not** become a field on `byDay` rows. `byDay`'s documented contract is
that a key exists only for a day that billed tokens, and detectors, sparklines, and the active-day
arithmetic all depend on that. Adding engaged time to it would have created keys for worked-but-
unbilled days and quietly changed what every existing consumer counts.

Engaged time instead ships as a top-level sibling map keyed the same way, with an invariant test
that its values sum to `totals.engagedSeconds`. The visible consequence is that the engaged-time
tile's trend covers a different set of days than its neighbours' trends, so the tile's tooltip says
so rather than implying comparability the data does not have.

### 6. Window arithmetic: deltas come from the display window, discovery from a widened one

The previous-window baseline is derived from the window the UI is **showing**: with
`windowStart = now − days`, the baseline is `[windowStart − days, windowStart)`. It is never derived
from the (possibly widened) discovery cutoff. Callers widen that cutoff — `lookbackDays: days * 2`
in both the dashboard route and `ak usage score` — precisely so records older than the displayed
window survive to be aggregated into the baseline; deriving the baseline from the widened bound
would make it silently stretch to whatever lookback the caller happened to ask for, and a delta
against an unknown-length window is not a delta. `buildIndex` therefore passes the aggregate a
display cutoff while discovery uses the lookback cutoff, and the scan cache key folds both — plus
`previous` — so two callers asking different questions cannot share one cached answer.

### 7. Cost distribution excludes structurally-$0 sessions; ratios use main-thread prompts

`costPerSessionMedian` and `costPerSessionP90` are computed over **priced sessions only**. A session
with no token evidence at all — a Codex subagent rollout whose tokens were stripped as a
double-count, say — is structurally zero rather than cheap, and folding it in would drag the median
toward zero for a reason that is not about spend. The exclusion is stated in the UI subtitle and its
tooltip, not just in the code; a real figure below a cent renders `<$0.01` rather than `$0.00`,
which beside an "excludes $0-by-construction" subtitle would read as a contradiction. Session
*length* percentiles stay inclusive — the length of a $0 session is honest.

Prompt-derived ratios use **main-thread prompts** as their denominator: a subagent's prompts are
written by the harness, not typed by a person, so counting them would inflate the denominator with
work nobody asked for by hand. `responsesPerPrompt` is all responses over main-thread prompts —
machine output per human touch — and `humanPromptsPerHour` is those same prompts per engaged hour.
`totals.humanPrompts` ships beside `totals.prompts` so the distinction is auditable rather than
implicit.

### 8. `byInferenceProvider` is gated on observed provenance; `byProvider` stays what it was

Cost is bucketed under a provider only when that session's provenance was **observed**; otherwise it
lands in `not-recorded`, which is added to the CLI's key set unconditionally so the honest bucket
appears even in a window where everything was attributed. This is the ADR-0021 rule applied to
spend: a transcript host is not a vendor, and a configured route is assignment intent rather than
evidence of what served a request.

The legacy `byProvider` map is left alone, keyed by transcript host as it always was. Two maps with
two contracts is clearer than one map that changes meaning.

### 9. Tool names are the host's own, never translated

Codex's four tallied `item_completed` kinds — `CommandExecution`, `McpToolCall`, `FileChange`,
`CollabAgentToolCall` — keep those exact spellings in every ranking. Mapping `CommandExecution` onto
`Bash`, or `FileChange` onto `Edit`, would assert an equivalence neither host makes: the
vocabularies are host-specific and the semantics do not line up one-to-one. Every other Codex item
type is left to the unknown-item diagnostic rather than tallied as a tool.

### 10. Cache savings are priced by differencing the pricer, never by a multiplier

`cacheSavedUsd` prices 1M tokens as fresh input and the same 1M as cache reads through the injected
pricer, and takes the gap. No cache multiplier constant exists in the aggregate, so the figure
cannot drift out of step with the pricing table the day that multiplier changes. Both probes carry
the row's own model, provider, and **day**, so a saving is priced from the same table at the same
date as the cost sitting beside it; the result is memoised per `(model, provider, day)`.

### 11. Schema v11, and nested subagent transcripts are ingested

`SCHEMA_VERSION` moves to 11 in one bump, adding `mode`/`modeRaw`, `latHist`/`latCount`,
`lenSeconds`, `ctxWindow`/`ctxLastTokens`, and `aborts` to every session record. A v10-cached record
carries none of them, so the whole cache is invalidated rather than letting new fields read back as
`undefined` and sum into totals as `NaN` — the same rule, and the same reason, as the v4 and v5
bumps ADR-0009 records.

Discovery gains exactly one nested shape: `listClaudeSubagents` reads
`<projectDir>/<sessionId>/subagents/*.jsonl` and nothing else. It is deliberately not a recursive
walk — a directory that is not a session-id directory with a `subagents` child contributes nothing
rather than being crawled — and an unreadable or absent nested directory degrades silently through
the same `readDirSafe` convention every other per-directory read in that module uses.

Each nested record takes a **namespaced** id, `<sessionId>/<stem>`, because Claude Code names every
such file `agent-<hash>.jsonl` and that stem is not unique across two parent sessions; an
unnamespaced id would silently collide two unrelated records into one. Admitting a slash into a
session id touches the transcript reader's path-traversal guard, so the gate is designed to
**narrow, not loosen**:

- `VALID_SUBAGENT_ID` matches exactly `<parentId>/<stem>`, one slash, with the parent half reusing
  `VALID_ID`'s own charset — a namespaced id's parent segment can never be more permissive than a
  plain id already is — and the child half constrained to the real on-disk shape,
  `agent-[A-Za-z0-9_-]{1,100}`, derived from the corpus rather than invented.
- Resolution builds the candidate path from the two **already-validated capture groups**, never by
  joining raw request input.
- Realpath containment, the size cap, masking, and truncation are unchanged and still apply; the new
  grammar is an additional accepted shape, not a bypass of any existing gate.

## Consequences

### Positive

- The scorecard can now answer how a window was worked, not only what it cost, with each answer
  carrying its own absence: `not-recorded` posture, an omitted context chip, `not measured` rhythm.
- Ingesting nested subagent transcripts made a large, previously invisible slice of real spend
  visible. On the reference machine's 14-day window at the time of the fix, 333 of 1,278 sessions
  (26%) and $2,339 of $6,026 (39%) had never entered the index. Totals moved upward, which is the
  honest direction, and delegation stopped being a metric the pipeline could not produce.
- Because posture, latency, and context are per-session record fields, the Sessions view gets them
  for free as row chips and detail lines, with no new route and no second fetch.

### Negative, and honestly stated

- A Codex session that records an approval policy and no sandbox policy renders `guarded` on
  approval evidence alone (§1). Bounded and disclosed, but it is a mapping on partial evidence.
- Posture is the **last** evidence a session recorded, not a timeline. A session that began in
  `plan` and ended in `auto-edit` reports only the latter, and its whole cost stacks under it.
- The `main`/`subagent` split is per session: a main-thread session that dispatched subagents still
  counts its own tokens as main-thread work; only the subagent's own record is attributed to
  `subagent`.
- The two hosts reach the `subagent` row by different routes and only one arrives at a real figure.
  Claude's delegated work is discovered, priced, and included. A Codex subagent rollout reads
  `$0.00` **by ledger design** — it replays its parent's cumulative token history, so keeping it
  would bill the parent twice — and its sessions and responses stay visible at zero cost. A `$0`
  Claude subagent slice means no delegated work in the window; a `$0` Codex one does not.
- Bucket histograms trade exactness for a bounded payload. A percentile inside a bucket is
  interpolated, and one in the overflow bucket is a floor. This is why the `≥` prefix is mandatory
  rather than cosmetic.
- Latency and length edge constants are stated in three places — the parsers, the aggregate, and the
  browser bundle — because the payload ships bucket *counts* and never the edges they were binned
  on, and the import direction forbids the aggregate importing from the parsers. Equality-pinning
  tests hold the three copies together.

### Deferred, deliberately

- **Limits history sparkline for both hosts.** Codex embeds quota snapshots in its own rollouts, so
  a utilization series is reconstructable offline; Claude's quota arrives only through the
  statusline push (ADR-0010) and has no retained local history to plot. A both-host history sparkline
  waits on a retention decision for that push, which is a quota-channel question rather than a
  scorecard one.
- **Splitting the dashboard usage client, and a shared format module.** `client/usage.mjs` has grown
  past the point where its panel builders belong in one file, and `fmtUsd`-family helpers are
  restated between the CLI and the browser bundle. Values agree today and both restatements are
  tested; the `usage-rhythm.mjs` dual bundle-and-import pattern shows a shared `usage-format.mjs` is
  feasible, and one coherent refactor is worth more than a cross-lane patch now.
- **Reconciling the OpenAI rate table (`USAGE-SCORECARD-METRICS.md` §13.2).** That section's dated
  rates and its primary-source claim disagree with `pricing.mjs`. It is a pre-existing
  discrepant-docs item, and it is explicitly **not** to be closed by editing one side to match the
  other: the mandate on that follow-up is to establish which is true and correct whichever is wrong.

## Verification

Every mapping row in §1 is asserted value-by-value against `normalizeMode`, including the rows the
first implementation left untested (`dontAsk`, `on-failure`, `untrusted`, and unrecognised Codex and
OpenCode values), and the raw `approval/sandbox` spelling is pinned because the Sessions detail strip
renders it. Bucket arithmetic is pinned at every edge and in the overflow slot, with the browser's
re-implementation asserted byte-identical to the server's. The `engagedByDay` invariant, the
display-window baseline, the priced-only cost distribution, and the main-thread ratio denominators
each carry their own regression test. The nested-ingestion change is covered by namespaced-id
uniqueness, an integration test asserting non-zero subagent cost, degrade-alone behavior, and
both-tier traversal rejection at the id gate.

Both citation-bearing reference documents are machine-checked: every `file:line` citation in
`USAGE-SCORECARD-METRICS.md` and `TRANSCRIPTS.md` is verified against the current source on every
test run by `tests/kit/doc-citations.test.mjs`.

## References

- Research: [Metric evidence matrix](https://claude.ai/code/artifact/1682c1ea-2bbd-4970-8cdd-2cc5e17efcdf)
  — every candidate metric against the fields each host actually writes.
- Research: [Scorecard additions](https://claude.ai/code/artifact/36adf798-625a-4d44-a84b-1dba7093e752)
  — the panel mockup and the absence rules each panel must honour.
- Plan: `docs/superpowers/plans/2026-08-28-scorecard-matrix-a.md`
- `src/lib/usage-modes.mjs` (the taxonomy), `src/lib/usage-parsers.mjs` and
  `src/lib/usage-opencode.mjs` (per-host evidence), `src/lib/usage-aggregate.mjs` (percentiles,
  buckets, window arithmetic, cache differencing), `src/lib/usage-index.mjs` (`SCHEMA_VERSION`,
  nested discovery, the id gates)
- `src/lib/dashboard/client/usage.mjs` and `src/lib/dashboard/client/usage-rhythm.mjs` (render),
  `src/commands/usage.mjs` (`ak usage score`)
- [Usage scorecard metrics](../USAGE-SCORECARD-METRICS.md) §15–§19 —
  the per-metric formulas and sources
- [Transcripts & session detail](../TRANSCRIPTS.md) §1 — the per-host evidence contract
- [Dashboard user guide](../DASHBOARD.md) — the shipped panels
