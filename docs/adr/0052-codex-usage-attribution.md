# ADR-0052 — Codex usage attribution: own usage, imports, segments, streaming

- **Status:** Accepted
- **Date:** 2026-09-19
- **Deciders:** agentic-kit maintainers
- **Related:** [ADR-0009](0009-usage-scorecard-local-transcript-analytics.md),
  [ADR-0038](0038-consistent-cross-host-session-metrics.md),
  [ADR-0042](0042-capability-aware-context-budget-intelligence.md),
  [ADR-0050](0050-dashboard-project-identity-and-context-reporting.md)

## Context

An audit of the Codex parser against a real corpus (1,498 rollouts, 7.9 GB, plus
`state_5.sqlite`, Codex's thread ledger) found that the scorecard's Codex figures
were wrong in both directions at once. Under-counted: a 4.2 GB active rollout
(188M tokens) vanished, every subagent read `$0`, and mid-file counter restarts
lost tokens. Over-counted: 796 Claude Code sessions Codex had imported were
counted as native Codex sessions, and forked subagents' replayed parent history
inflated their prompts, responses and context samples. Attribution to a day and a
model was also coarse. This ADR records the corrections and the evidence each rests on.
It leaves ADR-0038's decisions in force and amends the Codex arithmetic beneath them.

The raw sources are `~/.codex/sessions/**/rollout-*.jsonl` and the ledger. The
ledger's `tokens_used` equals a rollout's LAST cumulative snapshot, so it shares
that snapshot's blind spots (it includes a fork's replay and loses counter
restarts); it is a cross-check, not an oracle.

## Decisions

### 1. Oversized rollouts stream through a bounded-memory reader

`fs.readFileSync(file, 'utf8')` throws `ERR_STRING_TOO_LONG` above about 512 MB,
and the scan treated the failure as "unparsed" with no visible trace. Rollouts
above 128 MiB now read through `codex-rollout-reader.mjs`: a synchronous
(`openSync`/`readSync`) chunked line reader that splits on `\n` across chunk
boundaries and feeds the **same** parser one envelope at a time, so memory is one
chunk plus one line. It stays synchronous so the index needs no async refactor.
Smaller files keep the whole-string path unchanged; a test proves both paths
produce identical records.

A line over 16 MiB is never held or parsed. The largest real line measured is
1.5 MB, so this is a defensive bound: an oversized `event_msg` becomes a stub of
its identifying head (`clipped: true`: timestamp, ordinal, event type, item type),
and any other oversized line is dropped. Every one is counted
(`diagnostics.clippedLines`, warning `oversized-lines-clipped`).

A rollout that still cannot be read or parsed is now reported:
`diagnostics.unparsedFiles`, a per-reason `unparsedReasons` map (`read-error`,
`parse-error`) and the warning `unparsed-rollouts`.

Measured: the 4.2 GB rollout parses in about 7 s at about 180 MB resident and its
tokens (188,041,995) equal the ledger's exactly. It is an active file, so its
cache entry is re-parsed whenever it changes.

### 2. A subagent's own usage counts; only its replay is excluded

A forked subagent's rollout opens with its parent's history (messages, tool runs,
the parent's own `session_meta`, and the parent's cumulative `token_count`s) and
then records its own turns. The parser stripped **all** usage from any
`thread_source: subagent` rollout to avoid double-counting the replay, which
hid the subagent's own spend: about 2.3B tokens (roughly a third of all Codex
tokens) on the reference corpus.

The boundary is found by `codex-replay.mjs`. Every envelope carries an `ordinal`
and the child's `session_meta` carries `subagent_history_start_ordinal`. Measured
on the 409 subagent rollouts:

| Rollouts | `subagent_history_start_ordinal` | Boundary used |
|---|---|---|
| 176 | a real boundary (some event lies at or beyond it) | that ordinal |
| 132 | the file length (no event reaches it) | the parent's first `agent_message` addressed to this thread (`recipient` = the child's `agent_path`), 122 of them; the other 10 are guardian reviews with none and no replay |
| ~100 | absent (unforked) | none: nothing is replayed |

Read literally, the ordinal would have called the whole of the 132 files replay
and zeroed about 440M own tokens. Each boundary was cross-checked against the
parent rollout's own snapshots. A subagent whose envelopes carry **no ordinal at
all** (a pre-ordinal host) cannot have its replay separated, so it keeps the
conservative old behaviour of reporting no usage.

Events below the boundary count for nothing: no prompt, response, tool tally,
context sample, latency sample, abort, rate-limit snapshot or usage. A subagent's
own usage is what its own `token_count`s add (decision 4). It stays flagged
`threadSource: subagent`, so its prompts remain out of human-prompt figures and
it appears under the `subagent` source row with real cost.

The ledger overlay (`applyCodexLedger`) no longer strips a rollout that classified
itself as a subagent. It still strips a thread only the ledger names a subagent
(its rollout said nothing, so its usage is the unsubtracted cumulative total).

Diagnostics stay raw on purpose: `parseStats.responses`, `prompts` and
`tokenCountEvents` count everything a file carried, so the parse-yield warnings
mean what they did.

Verified against the ledger over the 408 subagent sessions: 299 match it exactly
(no replay, no restart); 84 are lower because the replayed history is
subtracted (ledger 1.55B, own 224M); 25 are higher because a counter restart lost tokens in the
ledger (decision 4).

**Hypothesis checked: a parent's cumulative total does not include its children's
usage.** Across 29,570 non-restart `token_count`s in 187 user/handoff rollouts
(46 of them parents of spawned subagents, 23,956 events; the 4.2 GB rollout excluded), the total never
advanced by more than that event's own `last_token_usage`. So counting a child's
own tokens does not double-count its parent.

### 3. Sessions Codex imported from Claude Code are not Codex sessions

Codex imports Claude Code transcripts as threads (`external_agent_session_imports.json`
lists them). Their turns are stamped `external-import-turn-N`, they have no
`turn_context` or `thread_source`, and their `token_count` carries
`input_tokens: 0`, only `total_tokens`. They supplied about 87% of Codex
"responses" and a large share of prompts, priced at model `unknown`, $0, while the
real data lives in the Claude transcript.

The in-rollout marker (the `turn_id` prefix) is the signal, so detection works
without the imports file. Parsing stops at the first such line; the record is kept
out of aggregation, out of every yield statistic, and counted in
`diagnostics.importedExcluded` (796 on the reference machine). Nothing is dropped
silently. The record itself is still cached, so a rescan is cheap.

### 4. Cumulative counter restarts are summed, per event

`total_token_usage` restarts from zero mid-file: 48 restarts across 33 files
(25 subagent, 7 user, 1 handoff). At each restart the new snapshot equals its own
`last_token_usage` (the counter began again), every restart falls on a turn
boundary, and no component drops without the total. **The cause was not
determined**: a model change accompanies only 1 of the 48 restarts and no
`compacted` record lies between the last pre-restart snapshot and the first
post-restart one. The evidence supports "counter restart,
not regression or replay" and the arithmetic below relies only on that.

`codex-usage-walk.mjs` turns each snapshot into a **delta** against the previous
one; a snapshot lower than its predecessor in any monotonic field (input, cached,
output, total) starts a new segment whose delta is the whole snapshot, which is
"sum the final total of each segment". Last-wins lost about 350M tokens
(about 156M on non-subagent sessions) and the ledger loses them too, which is why
25 subagent and 8 main-thread sessions now read higher than their ledger rows.

### 5. Each delta books on its own day and model

The session's whole total used to land on the last event's local day under the
last model. 42 multi-day sessions held 37.8% of Codex tokens and 23 sessions used
more than one model (the de-duplicated model list also reports the wrong "last"
model for a switch-back). Each delta now books on the local day of its event and
the model of the `turn_context` in effect; a delta before any `turn_context` takes
the session's first model. Assistant messages join the row of their own day and
model, and rows still sum to `responses`. A single-day, single-model, reset-free
session yields one row totalling its last snapshot, exactly as before.

### 6. Item types the host is known to emit are not "unknown"

Only four item types were tallied as tools, so `Reasoning`, `SubAgentActivity`,
`ImageView`, `Extension`, `WebSearch` and `ContextCompaction` filled the 32-kind
diagnostic cap and raised `unknown-item-types` on every scan. They are now a
known non-tool set; `DynamicToolCall` (a `codex_app` tool call) joins the tallied
tools and `FunctionCallOutput` the known set. Only a type in none of them warns.

## Consequences

- Cache schema **v23**: every cached Codex record and its `parseStats` re-derive.
  Earlier records carry the wrong imports, subagent usage, replay counts,
  last-wins totals, single-day/model rows and permanent diagnostics.
- Codex subagent sessions now have real tokens and cost. Cost totals, the
  `subagent` source row, the priced-session cost distribution and per-day and
  per-model views move; main-thread prompt figures do not.
- Codex totals can exceed the ledger's `tokens_used` for a thread with a counter
  restart. That is the correction, not drift.
- Prompts and responses drop where imports and replays were counted; the
  responses-per-prompt ratio drops with them.
- `codex-usage-diagnostic.mjs` is unchanged: it remains an independent
  cumulative-snapshot comparison and does not model any of this.

## Measured effect (reference machine, 365-day window; main at 6d57c8e versus this change)

| Figure | Before | After |
|---|---|---|
| Codex sessions | 1,468 | 673 (796 imports excluded, 1 large file recovered) |
| Codex tokens | 4.356 B | 7.023 B |
| of which subagent | 0 | 2.323 B |
| Codex responses | 77,486 | 9,711 |
| Codex prompts | 3,881 | 1,977 |
| List-price Codex cost | $2,604.78 | $4,759.33 |
| Rollouts unparsed | 1 | 0 |
| `unknown-item-types` warning | raised | not raised |

The default 14-day window: 138 sessions to 119, tokens 1.202 B to 1.813 B, cost
$1,191 to $2,005. Main-thread sessions equal their ledger row exactly in 257 of
265 cases (the 8 others are restarts). The cost figure rises mostly because
subagent and previously dropped usage is now priced.

## Not done (recorded follow-ups)

- Guardian-review classification, unread host fields, and the context-coverage
  denominator remain as audited; this ADR does not change them.
- A stream tee or push channel for live oversized rollouts is out of scope.
- The cause of counter restarts is unknown (decision 4).
- A subagent with no ordinals still reports no usage (decision 2).
- One rollout carries `token_count`s but no agent message, so the pre-existing
  `partial-response-yield` warning remains.

## Verification

`tests/kit/usage-codex-attribution.test.mjs` and
`tests/kit/usage-codex-large-rollout.test.mjs` build synthetic rollouts that
mirror the real structure (ordinals, `subagent_history_start_ordinal` both real
and degenerate, replayed parent history, imports, restarts, multi-day and
multi-model sessions, oversized lines) in temp directories only. A forged v22
cache is discarded. The real-corpus figures above came from a read-only run of
the parser over `~/.codex/sessions` and the ledger with a temporary cache.
