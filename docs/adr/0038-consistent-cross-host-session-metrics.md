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

**The taxonomy takes strings; the Codex parser extracts them.** Codex writes `sandbox_policy` as an
object keyed `.type` — `{"type":"danger-full-access"}`, `{"type":"read-only"}`,
`{"type":"workspace-write", …}` — and a survey of the reference machine's rollouts (400 files,
2026-08-28) found 1,110 object occurrences and zero string ones. `normalizeMode` stays a
string-to-string mapping (one vocabulary, host-shape-agnostic); `handleCodexTurnContext` reads
`sandbox_policy.type` before calling it. An object carrying no `.type` contributes no sandbox
evidence rather than a guess.

This was shipped broken and caught by review: passing the object through matched no rule, so on live
data the `plan`, `auto-edit` and `unrestricted` arms of the Codex mapping could not fire at all —
only the approval-only `guarded` rule could — and `modeRaw` persisted the failed stringification
`"never/[object Object]"` into the cache, `/api/usage` and `ak usage score --json`. The consequence
that made this Important rather than cosmetic: `detectUnrestrictedMode` was blind to Codex's
riskiest posture, `never` + `danger-full-access`, which is the reference machine's own current
setting. The degradation direction was at least honest — not-recorded, never a guess. Schema v12
re-derives the affected records; a client-side band-aid that refused to render any spelling
containing `"[object "` was removed with the cause.

### 2. An unmapped value is `not-recorded`, and that is a first-class bucket

Every lookup is `?? null`. A raw value this taxonomy has not been taught — a future
`permissionMode`, a policy spelling that has not shipped yet — yields no mode, never a nearest
guess. The host's own spelling is retained beside the normalized value as `modeRaw`, precisely
because the mapping is a judgment and a reader auditing it needs the evidence it was made from.

`not-recorded` is a bucket key in the aggregate, not a display fallback: it is created before the
fold, offered as a row by the CLI table even at zero, and forced to the de-emphasis ink in the UI so
that spend with no posture evidence can never read as a posture.

**But "unmapped" and "unobserved" are different facts, and the session detail strip now says which
it is.** Rendering "no posture evidence in this transcript" over a row that carries a `modeRaw` is a
fabrication in the opposite direction from the usual one — denying data that exists, when the whole
point of retaining `modeRaw` is that the mapping is a judgment a reader may want to audit. So a row
with `mode: null` and a `modeRaw` present shows the host's own spelling, labelled *unrecognized* so
it can never be read as a classified posture. The aggregate still folds both cases into
`byMode['not-recorded']`; separating them there is a wire-shape change and is deferred below.

### 3. Response latency means prompt-to-response, and is never called time-to-first-token

The primary sample on every host is the gap between a human prompt and the completion that answered
it. Codex's host-measured `task_complete.duration_ms` is a **fallback**, used only when no
prompt-gap sample already covered that turn; the turn-start marker is cleared the moment a gap
sample fires, so a turn is never double-sampled. An aborted turn (`turn_aborted`) clears both
latency states, so an unanswered prompt is never timed against a later, unrelated response, and an
API-error placeholder is never a sample — its pending window is deliberately left open so the first
real completion that follows is what gets timed.

The `MAX_LATENCY_SAMPLE_SECONDS` ceiling of 3600s applies to **every** sampling path, the
host-measured fallback included.

*This reverses an earlier ruling on this same branch,* which exempted the fallback on the grounds
that a host-measured duration that large is a real turn the open-ended top bucket can absorb. That
reasoning does not survive contact with what `duration_ms` measures: it is turn wall-clock and
**includes time blocked on an approval prompt**, so under `approval_policy: on-request` a turn left
awaiting approval overnight is recorded as a ~26-hour turn. Through the prompt-gap path that same
wait is discarded; through the fallback it became a latency sample. Measured on the reference
corpus: 12 of 835 durations exceeded the cap, the largest 94,079,450 ms ≈ 26.1 hours, all of them
in the `≥60s` overflow bucket and dragging `latP95` into it — enough, on their own, to move
`detectLatencyRegression`'s relative and absolute gates. The cap's stated purpose ("an idle resume
is excluded from sampling **entirely**, rather than merely landing in the overflow bucket alongside
genuinely slow turns") applies with full force to a blocked approval. Cost of the original ruling:
none shipped — it was caught pre-merge.

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

### 8. There is no window bucket for the inference provider

Window cost is bucketed by execution host, not by the vendor that served the tokens. Only Codex
transcripts record an inference provider together with the provenance backing it; Claude and
OpenCode transcripts name none at all. An aggregate axis over that evidence would put most of a
window's spend in one unattributed row, which a reader takes as a finding about providers rather
than as what it is — an absence of provider evidence in two of the three formats.

Provider identity is therefore per-session evidence, reported on the session row beside its
provenance, which is where ADR-0021's rule already applies it. The legacy `byProvider` map is left
alone, keyed by transcript host as it always was.

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

### 11. Schema v11 (then v12), and nested subagent transcripts are ingested

`SCHEMA_VERSION` moves to 11 in one bump, adding `mode`/`modeRaw`, `latHist`/`latCount`,
`lenSeconds`, `ctxWindow`/`ctxLastTokens`, and `aborts` to every session record. A v10-cached record
carries none of them, so the whole cache is invalidated rather than letting new fields read back as
`undefined` and sum into totals as `NaN` — the same rule, and the same reason, as the v4 and v5
bumps ADR-0009 records.

A second bump to **v12** lands before merge, for a *wrong* cached value rather than a missing one:
v11 records persisted `modeRaw: "never/[object Object]"` and a null `mode` for every Codex session
(decision 1). Re-deriving is the only thing that clears them, and the one-time re-parse cost is
accepted for the same reason every earlier bump accepted it.

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

- `matchSubagentId` matches exactly `<parentId>/<stem>`, one slash, with the parent half reusing
  `VALID_ID`'s own charset — a namespaced id's parent segment can never be more permissive than a
  plain id already is — and the child half constrained to the real on-disk shape,
  `agent-[A-Za-z0-9_-]{1,100}`, derived from the corpus rather than invented. It **also rejects
  `.` and `..` as the parent segment**, which the charset alone does not: `.` is inside it, and the
  parent is the only place in that module where caller-shaped text becomes a path *segment* rather
  than a filename stem, so `readSession('../agent-x')` reached
  `<claudeRoot>/subagents/agent-x.jsonl` — still inside the transcript root, therefore invisible to
  the realpath containment check, but outside the shape the grammar exists to enforce. Never
  reachable over HTTP (the route tier rejected every encoding), but `readSession` is an exported
  library API whose doc block claimed parity with that tier. The two tiers now accept identical id
  sets, and discovery applies the same grammar so a transcript the API will not serve is never
  indexed as a clickable row.
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
- An earlier draft of this ADR shipped a provenance-gated `byInferenceProvider` bucket and a
  "served by" panel over it. The aggregate provider axis was removed on maintainer review before
  merge (§8): host-level attribution lives in `byHost`, and session-level provider provenance
  remains on the session rows.

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
- **Whether rhythm and the punchcard should filter or split main vs subagent sessions.** Once nested
  Claude subagent transcripts were ingested (decision 11), roughly a quarter of the sessions in a
  window — and on the reference corpus a *majority* of Claude responses, 17,863 subagent against
  11,480 main — became harness-driven. They flow into `rhythm.lenHist`, `rhythm.latHist`,
  `sessions / active day` and the punchcard, all of which sit under labels reading "Your rhythm" and
  "When you work". Every number is true as computed; the labels overclaim. This branch ships
  **disclosure** — one sentence in §15/§17/§9 and in the matching tooltips — because filtering or
  splitting is a behavior change that deserves its own ruling and its own RED tests, not a late
  patch in a fix wave. Note the asymmetry it leaves: prompt-based denominators already got a
  main-thread-only rule (decision 7) on exactly this reasoning, and length/latency/punchcard did
  not, because the T6 ruling predates the ingestion discovery and was never revisited. Resolving
  that asymmetry deliberately is the follow-up.
- **The `unclassified` posture bucket.** An observed-but-unmapped `modeRaw` now renders as such in
  the session detail strip, but the aggregate still folds it into `byMode['not-recorded']` beside
  sessions that recorded no posture at all — which overstates how much evidence is missing. A fourth
  bucket key (`unclassified`) would separate them, at the cost of a wire-shape change rippling
  through `byMode`'s consumers, the CLI table's key list and the docs. Rendering was fixed here;
  the bucket split is left to a deliberate data-shape decision.
- **`scanKey` omits `deps` and `codexState`.** Both hold live objects (functions, Maps) that do not
  serialize, so keying on them means minting identity tokens through a WeakMap. Two calls differing
  only by an injected pricer or ledger therefore coalesce in the single-flight map and the memo.
  Parked as a latent trap rather than a live bug — production never injects `deps`, and tests
  sandbox `roots`/`cachePath` per test — with the comment at `readIndex` corrected to state the
  omission instead of implying it was fixed.

## Verification

Every mapping row in §1 is asserted value-by-value against `normalizeMode`, including the rows the
first implementation left untested (`dontAsk`, `on-failure`, `untrusted`, and unrecognised Codex and
OpenCode values). The Codex arm is pinned a second time **end-to-end through `parseCodex` in the
real object wire shape**, because unit-testing `normalizeMode` alone is exactly what let the
`[object Object]` defect ship: the taxonomy was correct and the value reaching it was not. That
second pin is also what makes the raw `approval/sandbox` spelling a real claim — the Sessions detail
strip renders it, and before the extraction what it had to render was a failed toString. The latency
cap is pinned in both directions (a 26.1-hour `duration_ms` takes no sample at all; a 45-second one
still samples through the fallback), and the id grammar by a `readSession('../agent-x')` rejection
at the module's own tier. Bucket arithmetic is pinned at every edge and in the overflow slot, with the browser's
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
