# Usage Scorecard — Metrics Reference & Research Backup

**Audience.** agentic-kit maintainers, contributors reviewing a PR that touches
`src/lib/usage-index.mjs` / `src/lib/pricing.mjs` / `src/lib/usage-classify.mjs` /
`src/lib/dashboard-server.mjs`, and anyone auditing a specific number a user has
questioned on the **Scorecard** tab of `ak x dashboard`'s Usage panel.

**Purpose.** Every figure on the Scorecard tab is either (a) an exact, checkable
arithmetic derivation from the user's own local transcripts, or (b) a published
provider rate. This document states, for each figure, which of those two it is,
cites the exact source line, cites the external rate where one is used, and
records what the figure deliberately does **not** model. The goal is that a
skeptical reader — a user who thinks a number "looks questionable," or a
maintainer reviewing a pricing-table change — can verify every claim here
against either the cited source code or the cited external page, without
having to trust this document on faith.

**Citations are machine-checked.** Every `file:line` citation below is
verified against the current source by the test suite
(`tests/kit/doc-citations.test.mjs`): an identifier named beside the citation
must appear at the cited lines. A passing build means the citations match the
code you have; upkeep is covered in
[Appendix B](#appendix-b--verification-methodology). One file is cited by
function name and no line number: the browser bundle
`src/lib/dashboard/client/usage.mjs` shares a basename with the CLI command
module `src/commands/usage.mjs`, and the checker keys on basenames, so a
`usage.mjs:NNN` citation would silently resolve to the wrong file.

**Scope.** This document covers the **Scorecard** tab — both the surface it
renders in the dashboard and the same figures printed offline by
`ak usage score`. That is the five hero KPIs (Sessions, API-Equivalent, Tokens,
Engaged Time, Cache Read); the second KPI row of cadence and unit economics
(sessions per active day, autonomy, cost per session, cost per engaged hour);
and the supporting panels — cost per day, by host, token composition bar, your
rhythm, how you run, when you work, models in play, tool mix, model mix over
time, reliability, projects, what you worked on. Two adjacent surfaces are
documented here because they answer questions the Scorecard raises: the Limits
view (§13b) and the Codex thread ledger (§13c). The **Findings**, **Sessions**,
and **Transcript** tabs are governed by separate rules and are out of scope
here except where they share a data source with a Scorecard metric.

**Companion document.** This is a *metrics reference*, not a design record.
The "why" behind each design choice — why three time tiers, why rules-based
classification, why cost is never called billing — lives with the design
records mapped in [Appendix C](#appendix-c--design-rationale-adr-map). Read
this document to check an arithmetic claim.

---

## 0. How to read an entry

Every metric section below follows the same shape:

- **Displayed as** — the exact label and format the browser renders.
- **Formula** — the arithmetic, in mathematical notation.
- **Source** — file:line citations for both the number's derivation (usually
  `src/lib/usage-index.mjs`) and its rendering (`src/lib/dashboard-server.mjs`).
- **Worked example** — a real or realistic set of inputs run through the
  formula by hand, cross-checked against a live test assertion where one
  exists.
- **What this does not model** — limitations stated up front rather than left
  for a user to discover.

---

## 1. Data provenance

Two transcript stores, read-only, parsed at most once per file (cache keyed by
`(path, mtime, size)`; `SCHEMA_VERSION` invalidates the whole cache on a
schema change — `src/lib/usage-index.mjs:10`, `:99`):

| Transcript host | Store | Format |
|---|---|---|
| Claude Code | `~/.claude/projects/<project>/<sessionId>.jsonl` | one JSON object per line: `user`/`assistant` turns, each assistant turn carrying its own `usage` object |
| Codex CLI | `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<sessionId>.jsonl` | one JSON object per line: `session_meta`, `turn_context`, and `event_msg` records; the latter carry **cumulative** `token_count` snapshots plus legacy messages or newer `item_completed` envelopes |

The parsers are `parseClaude` (`usage-parsers.mjs:440-469`) and `parseCodex`
(`usage-parsers.mjs:724-745`). Both are pure functions over the raw file bytes —
no network, no clock dependency beyond the transcript's own timestamps — so
every downstream number traces back to bytes already on the user's disk.
Nothing in this transcript pipeline calls a provider API or a billing endpoint; **no transcript
metric is ever a copy of an actual invoice.** That is the whole reason every transcript-derived
dollar figure is labelled "API-equivalent."

The built index also exposes `sourceHealth` for all four local sources: the
Claude and Codex transcript roots themselves (`claude`, `codex`), plus the two
secondary/corrective reads layered on top of them (`opencode`'s SQLite store,
`codexLedger`'s thread-attribution ledger). Each source is `ok`, `absent`,
`degraded`, or `not-read`, with a bounded reason such as an fs error code
(`ENOENT`, `EACCES`, `ENOTDIR`), `busy`, `corrupt`, `query`, or `schema`. A
degraded OpenCode read retains in-window last-good cached sessions rather than
turning an unreadable database into an observed zero. Source health is
diagnostic evidence; it is not added to token or cost totals. The dashboard
renders these states as branded host-icon pills in the sticky tabbar —
right-aligned, one per HOST rather than one per field. `codex` and
`codexLedger` are both Codex-only evidence, so they fold into a single Codex
pill (worse status leads; both sub-statuses live in the status side's
tooltip) rather than reading as a fourth, confusingly duplicate entry. Each
pill's icon reuses the same brand mark as the Observability Live view's
session list, so a host reads as the same glyph everywhere in the dashboard;
hovering the icon shows what it monitors, hovering the status word shows the
full detail. This placement — outside the Usage panel, in the persistent
tabbar — means a degraded, absent, or deliberately unread source stays
visible regardless of which tab is active, and cannot be mistaken for
healthy empty data. See [ADR-0023 §7](adr/0023-fail-closed-operations-and-explicit-degradation.md)
for why the four fields are tracked to different degrees of external documentation.
Codex diagnostics additionally record files scanned, parse yield, token-bearing
files, response-bearing files, and unknown item types; a readable root with
token-bearing files but zero normalized responses is degraded as
`parse-yield-zero`, and a root where only some token-bearing files yield
responses is degraded as `parse-yield-partial`, rather than reported as healthy
empty or complete usage.

The additive `sourceHealth.<host>.diagnostics.common` envelope makes coverage
comparable without pretending the hosts have the same wire format: it reports
discovered and parsed units, units with usage/prompts/responses, observed prompt
and response totals, warnings, and unknown kinds. The companion
`sourceHealth.<host>.capabilities` matrix distinguishes `supported`,
`unsupported`, and `unavailable`. This is intentionally the historical adapter
contract, not a claim that the hosts lack richer public APIs: Claude documents
tool hooks and OpenTelemetry tool spans ([hooks](https://code.claude.com/docs/en/hooks),
[monitoring](https://code.claude.com/docs/en/monitoring-usage)); Codex documents
typed command, file-change, MCP, and collaboration items in app-server
([protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md));
and OpenCode documents session `parts` and tool invocation parts ([SDK](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/sdk.mdx),
[message model](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/message.ts)).
Those richer activity categories remain unclaimed by the scorecard until a
cross-host taxonomy, nested-agent policy, and deduplication rule are accepted.

Unknown wire kinds are bounded to 32 distinct names; `unknownKindOverflow`
retains the number of additional occurrences without allowing transcript data
to expand the diagnostics payload without limit.

The current persisted field named `provider` identifies which host transcript parser produced a
session row; it is not sufficient evidence of the inference provider. The Proposed model in
[ADR-0016](adr/0016-capability-driven-integration-adapters.md) separates host, provider,
projection, observability source, and binding, with provenance attached per field. The migration is
now implemented. The Scorecard must not invent an OpenRouter host, infer provider identity from a
Claude/Codex transcript alone, or turn unknown billing into subscription, metered, local, or `$0`.

OpenRouter account analytics is a separate evidence class. An explicit
`ak usage refresh openrouter` fetches the supported 30-completed-UTC-day management view into a
mode-`0600` local cache; normal dashboard reads remain offline. `/api/usage` exposes that cache only
as `providerAnalytics.openrouter`, never by adding it to `totals`, `byHost`, `byProvider`,
`byModel`, projects, categories, findings, or sessions. The upstream response has no host/session/
project/task correlation key, so no join is attempted. OpenRouter-credit usage and BYOK external
inference estimates also remain separate rather than being presented as one spend number. See
ADR-0009 §9.

---

## 2. Sessions & Responses

**Displayed as:** `SESSIONS` hero tile — `4,981`, subtitle `693,964 assistant
turns`.

**Formula:**

```text
sessions = count of session records with responses > 0 AND end >= cutoff
responses = Σ over included sessions of session.responses
```

**Source:**

- Filter: a parsed record with zero assistant turns is dropped entirely — "no
  assistant turn → not a session" (`usage-aggregate.mjs:496`) — and a record whose
  last activity falls outside the requested window is dropped too
  (`usage-aggregate.mjs:497`).
- `responses` accumulation: Claude increments per assistant message
(`usage-parsers.mjs:380-385`); Codex increments per `agent_message` event
(`usage-parsers.mjs:595-600`).
- Totals: `totals.responses += s.responses` per included session
(`usage-aggregate.mjs:574`).
- Render: `kpi("sessions", fmtNum(t.sessions), fmtNum(t.responses)+" assistant
  turns", "")` (`dashboard/client.mjs`).

**Worked example.** A session with 3 user turns and 2 assistant turns
contributes `sessions += 1, responses += 2` — prompts (user turns) are tracked
separately and never appear in this KPI. Verified in
`tests/kit/usage-index.test.mjs:385-386` (`s.responses === 2, s.prompts === 1` for
a fixture with exactly that shape).

**What this does not model:** a session that opened but received no assistant
reply (e.g. immediately abandoned) is invisible to every Scorecard number —
by design, not oversight, since a session with no response has nothing to
attribute cost or category to.

**What "prompts" excludes (since SCHEMA_VERSION 5):** user-role entries whose
text the harness wrote — task notifications, `bash-stdout`/
`local-command-stdout` dumps, caveats — are not human prompts and no longer
count as such (`isHumanPrompt` + `HARNESS_OUTPUT_RE`; the full envelope
taxonomy is [`TRANSCRIPTS.md`](TRANSCRIPTS.md) §3.2). A `! command` the
person typed (`bash-input`) still counts. (The correction this rule shipped
with is recorded in [Appendix A](#appendix-a--fix-history).)

---

## 3. API-Equivalent Cost

**Displayed as:** `API-EQUIVALENT` hero tile — `$961,036`, subtitle `list
price · not plan billing`.

**Formula**, per `(session, day, model)` usage row:

```text
inputUnits = input + cacheWrite × 1.25 + cacheRead × 0.1
cost = (inputUnits × rate_in + output × rate_out) / 1,000,000
```

summed across every row in the window.

**Source:** `costOf()`, `src/lib/pricing.mjs:262-268`, reproduced verbatim:

```js
export function costOf(usage) {
  const { model, provider, input, output, cacheRead, cacheWrite, day } = usage ?? {};
  const { in: rin, out: rout } = priceFor(model, provider, day);
  const inputUnits = tokens(input)
    + tokens(cacheWrite) * CACHE_WRITE_MULTIPLIER
    + tokens(cacheRead) * CACHE_READ_MULTIPLIER;
  return (inputUnits * rin + tokens(output) * rout) / 1e6;
}
```

`CACHE_READ_MULTIPLIER = 0.1`, `CACHE_WRITE_MULTIPLIER = 1.25`
(`pricing.mjs:169-170`) — see §13 for why these two numbers are correct for
**both** Anthropic and OpenAI, which is why `costOf` needs no per-provider
branch on the multiplier (only on the base `rate_in`/`rate_out`, resolved by
`priceFor`, `pricing.mjs:229-242`).

Rate resolution is **longest-prefix match** on a normalized model id
(`pricing.mjs:178-187`), so a dated release (`claude-haiku-4-5-20251001`)
resolves to the same entry as its bare alias, and a more specific entry
(`gpt-5.6-sol`) is never shadowed by a shorter one (`gpt-5.6`). An id matching
nothing gets `FALLBACK_PRICE` — Sonnet-class rate, `$3`/`$15`
(`pricing.mjs:166`) — rather than `$0`, so an unrecognized model can never be
silently free; `matched: false` travels with the result so a maintainer can
find fallback-priced rows if the table needs a new entry.

### 3a. Rates are dated, and a row is priced on the day it was spent

Each table entry is a **schedule** — an ordered list of periods, each with the
day it takes effect. Nearly every entry has exactly one period that has always
applied (`anthropic(5, 25)` builds that shape); an entry whose rate the vendor
has *published* a change to carries more than one (`schedule`,
`pricing.mjs:41-55`). `periodOn` (`pricing.mjs:202`) picks the last period
already in effect on the given day, comparing ISO date strings
lexicographically so no `Date` parsing is involved and the module stays
clock-free.

`aggregate()` passes each usage row's own `day` (`usage-aggregate.mjs:368-371`), which
it already has because rows are keyed by `(day, model)`. **This is the whole
point:** tokens metered in August must still read as August's rate when the
panel is opened in December. Pricing by *today's* date instead would restate a
finished window the moment a published rate changed — a 50% jump in a
Sonnet-heavy August, with no session having changed. A panel whose claim is
"what these tokens would cost metered" cannot do that.

Two rules bound the mechanism:

- **Only published changes are encoded.** Anthropic announced that Sonnet 5's
  introductory rate ends 2026-08-31, so that boundary is a recorded fact.
  Encoding a *forecast* of some future repricing would fabricate data — the
  same error as an invented denominator (§14).
- **The mechanism is identical for both providers.** A date range is a fact
  about a price, not about a vendor. As of the verification date OpenAI
  publishes no promotional rates or expiry dates, so every OpenAI entry is a
  single always-applied period — but that is a fact about the *data*, not a gap
  in the table: `openai.dated([...])` exists and behaves identically, so a
  Codex promo would be a one-line edit rather than new machinery. Rates that
  vary by *how* a request was served — regional uplift, large-prompt surcharge,
  service tiers — are a different axis, are deliberately **not** expressible
  here, and remain in `UNMODELLED_PRICING_FACTORS` (`pricing.mjs:157-159`)
  because a transcript does not record the endpoint or tier.

A `priceFor` call with no day prices as of `PRICES_AS_OF`, the table's
verification date — **not** the newest period. "Newest" only means "current"
once every published change has landed, and deciding that requires a clock this
module does not read. Using the verification date also means the default can
never disagree with the `rates as of <date>` label the UI already prints.

Boundary behavior is pinned by `tests/kit/pricing-revert.test.mjs`, including
the property that matters most: a finished window is not restated when a later
rate change takes effect.

**Worked example** (from the Anthropic pricing page's own published example,
[C1] below — reproduced here because it is the cleanest independent check of
the formula's arithmetic, not because it is agentic-kit's number): a Claude
Opus 5 session with 10,000 uncached input tokens, 40,000 cache-read tokens,
and 15,000 output tokens:

```text
inputUnits = 10,000 + 0 × 1.25 + 40,000 × 0.1 = 10,000 + 4,000 = 14,000
cost       = (14,000 × $5 + 15,000 × $25) / 1e6
           = ($70,000 + $375,000) / 1e6
           = $0.445
```

Anthropic's own worked example ([C1]) reports uncached-input $0.05 +
cache-read $0.02 + output $0.375 = **$0.525** for a similar but not identical
split (their example has 10,000 uncached / 40,000 cached / 15,000 output at
the *same* per-token rate, computed line-by-line rather than via the combined
formula above) — the two computations are the same formula applied to the
same inputs; the $0.08 difference between $0.445 and $0.525 in this paragraph
is **session-runtime billing** ($0.08/hour), which is a Claude *Managed
Agents* billing dimension this scorecard does not model (see §14) — plain API
usage has no runtime component, so `$0.445` is the correct API-equivalent
figure for a plain Messages-API session with these token counts.

**What this does not model:** the panel prices every session as if it were
metered per-token API usage. On a Claude Max/Pro subscription, or Codex via a
ChatGPT plan, **the user is not billed this way at all** — this is why the
subtitle says "list price · not plan billing" as a first-class UI element,
not a footnote. See §14 for the full list of pricing factors
this cost figure does not include (regional-processing uplift, large-prompt
surcharges, service tiers, `inference_geo` multiplier, Batch API discount,
Managed Agents session-runtime billing).

---

## 4. Tokens

**Displayed as:** `TOKENS` hero tile — `1495.2B`, subtitle `3.0B out ·
1464.3B cached`.

**Formula:**

```text
tokens = input + output + cacheRead + cacheWrite   (summed across all rows in window)
```

**Source:** `t.tokens` from `totals`, accumulated per row at
`usage-aggregate.mjs:376` (`rowTokens = row.input + row.output + row.cacheRead +
row.cacheWrite`) and rolled into `totals.tokens` via `addTo`
(`usage-aggregate.mjs:285-294`). Rendered with `fmtTok()`
(`dashboard/client.mjs`): `≥1e9` → `"X.XB"`, `≥1e6` → `"X.XM"`,
`≥1e3` → `"X.XK"`, else the rounded integer.

The **token composition bar** immediately below the hero row (cache read /
cache write / output / input, as four coloured segments) is the same four
numbers as percentages of `t.tokens` (`dashboard/client.mjs`,
`pct(a,b) = b ? a/b*100 : 0`, `dashboard/client.mjs`).

**What "input" excludes.** For both providers, the `input` counter recorded
per row is **gross input minus cached input** — Claude's parser reads
`cache_read_input_tokens` and `cache_creation_input_tokens` as separate fields
the provider already reports separately (`telemetry-records.mjs:216-224`); Codex's
parser subtracts `cached_input_tokens` from `input_tokens` explicitly
(`usage-parsers.mjs:690-707`, `input: Math.max(0, gross - cacheRead)`) because
Codex's own `input_tokens` field **includes** cached tokens and would
double-count them against the separately-reported `cacheRead` figure if left
as-is. This is asserted by test:
`tests/kit/usage-index.test.mjs:366-395` ("Codex tokens come from the LAST
token_count event, never the sum") pins a fixture where the naive sum of two
cumulative snapshots (4000/1600/400) would be wrong, and the correct
last-event-only answer (3000/1200/300, split into `input: 1800, cacheRead:
1200`) is what the assertion requires.

![Figure: Claude sums per-turn usage deltas while Codex reports cumulative token_count snapshots where only the last one counts — summing snapshots would double-count](assets/usage-token-accounting.svg)

**What this does not model:** reasoning tokens (`reasoning_output_tokens`,
present in Codex's `token_count` payload) are not broken out as a separate
figure — they are folded into `output` implicitly via the provider's own
`output_tokens` field, which on OpenAI's reasoning-model line already
includes them.

---

## 5. Cache Read %

**Displayed as:** `CACHE READ` hero tile — `97.9%`, subtitle `priced at
0.1× input`.

**Formula:**

```text
cacheShare = cacheRead / tokens × 100
```

Note this is cache-read tokens **as a share of all tokens** (input + output +
cacheRead + cacheWrite), **not** as a share of input alone. On the reference
figures (`cacheRead = 1464.3B`, `tokens = 1495.2B`): `1464.3 / 1495.2 × 100 =
97.93%`, which rounds to the displayed `97.9%` — confirming the denominator.

**Source:** `dashboard/client.mjs` (`cacheShare = pct(t.cacheRead,
t.tokens)`), rendered `dashboard/client.mjs`.

**Why this number matters more than it looks like it should.** On the
reference corpus, 96.3% of tokens were cache reads — pricing them as fresh
input (rather than at the 0.1× multiplier) would overstate cost by roughly
10× (`pricing.mjs:8-9`). A cache-read share this high is not an anomaly to be
suspicious of on its own — it is the expected steady state for any
long-running agentic session that resends a large, mostly-unchanged system
prompt and tool-result history on every turn, which both Claude Code and
Codex CLI do by default.

---

## 6. Engaged Time

**Displayed as:** `ENGAGED TIME` hero tile — `403h`, subtitle `3286h summed`
plus a `sessions overlap` note. Hovering the tile reveals a tooltip with all
three tiers (the "ladder," `dashboard/client.mjs`).

This is the single most heavily-caveated metric on the tab, because a naive
version of it is **wrong by roughly 3×** on the reference corpus — worth
understanding in full before trusting the number.

**Three tiers**, each a genuinely different question, computed as three
separate interval-union operations:

| Tier | Question it answers | Formula |
|---|---|---|
| `engagedSeconds` (**the headline figure**) | Time actually spent working, never double-counted, never inflated by idle time | union of every session's **active sub-intervals** |
| `spanUnionSeconds` (tooltip only) | Wall-clock time with *some* session open, overlap collapsed but idle time NOT split out | union of every session's **whole span** (first timestamp → last timestamp) |
| `spanMinutes×60` (subtitle, labelled "summed") | The naive, double-counting sum — kept and clearly labelled as the dishonest one, not hidden | **sum** of every session's span, no union at all |

The asserted invariant is `engagedSeconds ≤ spanUnionSeconds ≤
spanMinutes×60`, and it is checked directly by test
(the `mergeIntervals` suite, `tests/kit/usage-index.test.mjs:103-144`, plus the
aggregate-level engaged-time tests, `tests/kit/usage-index.test.mjs:474-534`).

**Why three tiers instead of one.** Two independent distortions stack in raw
session data, and each needs its own fix:

1. **Overlap.** Subagent and parallel sessions run concurrently in wall-clock
   time. Summing their spans counts the same clock-minute once per concurrent
   session. Fix: union, not sum — this alone is the `spanUnionSeconds` tier.
2. **Idle time inside a session.** A session's span is first-timestamp to
   last-timestamp. A session left open for hours between turns (waiting on a
   human, or genuinely idle) donates its *entire* idle stretch to the span,
   even though no work happened during it. Fix: split each session into
   active sub-intervals wherever the gap between two consecutive timestamps
   exceeds `IDLE_GAP_MS` (15 minutes, `usage-parsers.mjs:22`), then union
   *those* sub-intervals — this is `engagedSeconds`.

**Source:**

- `mergeIntervals()` (`usage-aggregate.mjs:30-55`) — the pure union primitive,
  sorts intervals and merges any two that overlap **or exactly touch**
  (`s <= curEnd`, `usage-aggregate.mjs:46`), returning total covered seconds
  rounded to the nearest second.
- `activeIntervals()` (`usage-parsers.mjs:249-261`) — splits one session's
  sorted timestamp list into sub-intervals wherever a gap exceeds
  `IDLE_GAP_MS`; "a run of one timestamp yields a zero-length interval and so
  contributes nothing" (comment, `usage-parsers.mjs:243-248`).
- Aggregation: `totals.engagedSeconds = mergeIntervals(sessions.flatMap(s =>
  s._active))` (`usage-aggregate.mjs:666`); `totals.spanUnionSeconds =
  mergeIntervals(sessions.map(s => s._span))` (`usage-aggregate.mjs:665`);
  `totals.spanMinutes` is a running sum of `s._span[1] - s._span[0]` across
  the loop (`usage-aggregate.mjs:585`, finalized `usage-aggregate.mjs:664`).
- Render: `fmtHours()` (`dashboard/client.mjs`, `≥10h` rounds to the
  nearest hour, else one decimal place) and `fmtMins()`
  (`dashboard/client.mjs`, `≥60min` rounds to hours, else whole
  minutes).

**Worked example**, the reference-corpus measurement (14-day window, 582–584
sessions depending on exact cutoff), the canonical sanity check of the
three-tier design:

| Tier | Total | Per day |
|---|---|---|
| `engagedSeconds` | 100.7 h | 7.2 h |
| `spanUnionSeconds` | 230.8 h | 16.5 h |
| `spanMinutes×60` | 296.4 h | 21.2 h |

The naive sum (296.4 h / 21.2 h/day) implies a person working 21-hour days —
not a rounding error but a false statement. The
span-union fixes overlap but still implies 16.5 h/day, because 11 in-window
sessions individually spanned over 6 hours (the longest 27.4 h) without
splitting at idle gaps. Only the fully-split, unioned figure — 7.2 h/day — is
both overlap-corrected and idle-corrected, which is why it is the one
promoted to the hero tile; the other two are demoted to a subtitle and a
tooltip respectively, never deleted, so the invariant chain stays checkable
from the running panel.

**What this does not model:** `IDLE_GAP_MS = 15 min` is a judgement call, not
a measured constant — a maintainer who believes work with 20-minute pauses
should still count as one continuous stretch will get a lower
`engagedSeconds` than they'd expect, and the constant is exported and named
specifically so that disagreement is visible and adjustable in one place
rather than buried.

---

## 7. Cost per Day

**Displayed as:** the bar chart directly under the hero row, one bar per
calendar day in the window, height proportional to that day's cost. Hovering
a bar shows `day · cost · tokens · first-billed sessions · active sessions`.

**Formula:**

```text
byDay[day].cost = Σ costOf(row) for every usage row whose day == that key
byDay[day].sessions = count of sessions whose first billed usage row is that day
byDay[day].sessionsActive = count of distinct sessions with any usage row that day
```

**Source:** the day key is the row's own `row.day`, computed once at parse
time as **local calendar day**, not UTC
(`usage-parsers.mjs:419`/`usage-parsers.mjs:696` call `localDay(at)`) — so a
session that runs from 23:58 local to 00:05 local is billed to the day its
*first* row landed on (test:
`tests/kit/usage-index.test.mjs:651`, "a session that opens before midnight
is counted on its first billed day"). Accumulation:
`byDay[row.day].cost += rowCost` (`usage-aggregate.mjs:377-382`). Bar height:
`h = maxDay ? max(2, cost/maxDay*100) : 2` (`dashboard/client.mjs`) —
every non-empty day gets a visually nonzero bar (floor of 2%), so a very
cheap day is never rendered as invisible.

The existing `sessions` field remains first-billed-day attribution so its sum
continues to equal `totals.sessions`. `sessionsActive` is additive: a session
that has token-bearing rows on multiple days is counted once on each of those
days. Neither field claims that the session was continuously active for the
whole calendar day.

**What this does not model:** a day is only present in `byDay` if at least
one usage row landed on it — a day with zero activity produces no bar at all
(not a zero-height bar), which is why the chart in the reference screenshot
shows a long run of essentially-empty low bars at the start of the window
rather than a continuous 30-day series.

---

## 8. By Host (Claude vs Codex)

**Displayed as:** two cards, `claude` and `codex`, each showing cost,
session count, and total tokens; an idle host (`sessions == 0 && cost == 0`)
renders "no sessions in window" instead of zeroed figures
(`dashboard/client.mjs`).

**Formula:** identical aggregation to every other bucket
(`byHost[s.host]`, populated via `addTo()`, `usage-aggregate.mjs:285-294`,
  called once per session at `usage-aggregate.mjs:587`), keyed by the literal string
`"claude"` or `"codex"` assigned at parse time
(`blankSession(id, 'claude')` / `blankSession(id, 'codex')`,
`usage-parsers.mjs:441`, `:725`, `parseClaude`/`parseCodex` entry points).
OpenCode's SQLite reader builds the same record shape and contributes a third
host key.

**Why this pairing is the one under the most scrutiny.** Both providers'
tokens are summed into the *same* `tokens`/`cost` fields using the *same*
formula (§3, §4) — the aggregation code has no branch that treats a Codex
session differently from a Claude session once `costOf()` has priced its
rows. Any divergence between the two hosts' per-session averages is
therefore either (a) a genuine usage-pattern difference, or (b) a defect in
how one provider's raw transcript is *parsed into rows* upstream of
aggregation — never a defect in the aggregation itself, since both hosts
share it. [Appendix A](#appendix-a--fix-history) documents two real defects
of exactly that kind, both in `parseCodex`.

**Three identity maps, and why `byProvider` is not `byInferenceProvider`.** The
aggregate ships three separate bucket maps, and reading one as another is the
mistake this split exists to prevent (`usage-aggregate.mjs:560-561`,
`usage-aggregate.mjs:587-592`):

- **`byHost`** — the execution host: which CLI wrote the transcript
  (`claude`, `codex`, `opencode`). This is what the two cards above render.
  It is a fact about the file's provenance on disk, and it proves nothing
  about which vendor served the tokens.
- **`byProvider`** — the inference-provider string **as recorded**, ungated:
  `s.provider ?? 'unknown'`. This map keeps its historical name and its
  historical shape for callers that want the raw string, whatever its
  evidence. A session that recorded no provider keys to `'unknown'`.
- **`byInferenceProvider`** — the same identity, **provenance-gated**. Its key
  is the provider only when `s.providerProvenance === 'observed'`; anything
  else keys to `'not-recorded'` (`providerKey`, `usage-aggregate.mjs:538-540`).
  This is the map the "inference provider" panel and `ak usage score`'s
  `served by` table read.

The gate is the whole point: `'not-recorded'` is a first-class key, not a
display fallback, so spend whose provenance was never observed is held apart
instead of being attributed to an assumption. A provider string that was
merely *configured* is an assumption; only an *observed* one is evidence.
Today the Codex parser is the only source that sets `rec.inferenceProvider`
and `rec.providerProvenance` together
(`usage-parsers.mjs:492-495`, `:501-503`); Claude and OpenCode transcripts name
no provider at all, and so their spend lands in `'not-recorded'` — correctly,
since neither transcript records who served it.

**What this does not model:** a workflow that hands off between Claude and
Codex mid-task (e.g. `ak run`) produces two separate session records, one per
host, each aggregated under its own host rather than blended into one record.
That API-equivalent estimate is still not proof of the provider that served
either execution — which is exactly what `byInferenceProvider` declines to
guess.

---

## 9. When You Work

**Displayed as:** a 7×24 heatmap (day-of-week × local hour), cell intensity
proportional to response count in that bucket; the axis leads with `Mon`
(day index 0).

**Formula:**

```text
punchcard[dow + "-" + hour] += 1   per assistant/agent_message response, at its local timestamp
```

**Source:** incremented once per Claude assistant turn
(`usage-parsers.mjs:383-385`, keyed by `punchKey(at)`) and once per Codex
`agent_message` (`usage-parsers.mjs:598-600`), merged into the window-level
`punchcard` object per session (`usage-aggregate.mjs:605`). Cell intensity is
linear against the single busiest cell in the window:
`v = pcMax ? n/pcMax : 0` (`dashboard/client.mjs`) — this is a
**relative**, not absolute, scale, so the heatmap's brightest cell is always
"the busiest hour-of-week in *this* window," not a fixed response-count
threshold, and comparing brightness across two different date-range views is
not meaningful without checking the underlying counts (available via the
tooltip on each cell).

**What this does not model:** the heatmap counts *responses*, not elapsed
time — a hint at rhythm, not at engaged-time distribution (that's §6). A hint
that reads as heavy weekend activity, for instance, does not by itself imply
long weekend sessions, only frequent ones.

---

## 10. Models in Play

**Displayed as:** a ranked bar list, one row per model id seen in the
window, sorted by cost descending, bar width relative to the top model's
cost; each row shows `cost`, `tokens · N resp`.

**Formula:**

```text
byModel[model].cost      = Σ costOf(row) for every usage row with that model id
byModel[model].tokens    = Σ rowTokens for every usage row with that model id
byModel[model].responses = Σ row.responses for every usage row with that model id
byModel[model].sessions  = count of DISTINCT sessions whose s.models includes this model id
                            (a session using two models counts once under EACH)
```

**Source:** cost/tokens/responses accumulate inside the usage-row loop
(`usage-aggregate.mjs:367-394`); the `sessions` count is deliberately computed
**separately**, once per session over its `s.models` array
(`usage-aggregate.mjs:511-518`) rather than inside the cost loop, precisely
**so that a model can appear in `byModel` — with a nonzero session count —
even in a session that contributed zero cost/tokens/responses for that
model.** This is not an edge case invented for this document: it is the
exact mechanism that makes the subagent-replay exclusion
([Appendix A](#appendix-a--fix-history)) safe — a model used only by an
excluded subagent-replay session still shows up as "used," at zero cost,
rather than vanishing.

`byModel[...].responses` is populated from `row.responses`
(`usage-aggregate.mjs:391`), which in turn comes from the `responses` field
passed into `addUsage()` at the call site — `1` per Claude assistant turn
(`usage-parsers.mjs:419`), or `rec.responses` (the session's whole response
count) once per Codex session, passed at the single point Codex calls
`addUsage` (`usage-parsers.mjs:696-702`).

**Render:** `bar(name, fmtUsd(cost), fmtTok(tokens)+" · "+fmtNum(responses)+"
resp", pct(cost, topModelCost), false)` (`dashboard/client.mjs`),
list itself sorted cost-descending by the shared `entries()` helper
(`dashboard/client.mjs`).

**Exceptions — a turn that never resolved to a model is excluded here, not
shown as a $0 row.** A dropped connection, rate limit, or authentication
failure makes Claude Code synthesize a local placeholder turn — `model:
"<synthetic>"`, `isApiErrorMessage: true`, every usage field zero — rather
than a real completion (measured on the reference corpus: 33 such turns,
split `server_error` 27, `authentication_failed` 3, `rate_limit` 3 — three
distinct underlying causes, one placeholder shape).

The parser branches on `isApiErrorMessage === true`
(`usage-parsers.mjs:399-408`): the turn still increments `rec.responses`
and the punchcard (`usage-parsers.mjs:382-385`) — it *is* real engaged
time, someone was genuinely waiting on it — but it is never pushed into
`rec.models` and `addUsage()` is never called for it, so it can no longer
create a `byModel` row of any kind. It increments a separate
`rec.exceptions` counter instead (`usage-parsers.mjs:400`), rolled up into
`totals.exceptions` (`usage-aggregate.mjs:579`) and surfaced per-session
(`usage-aggregate.mjs:452-453`, alongside the existing `sidechain`/`threadSource`
flags — inspectable in the Sessions tab, never hidden). When
`totals.exceptions > 0`, the panel header shows a small `"· N
dropped/errored turns excluded"` note (`dashboard/client.mjs`);
when it's zero, the note renders empty rather than always claiming a
count of zero.

This is the same "never hide it, don't misrepresent it either" principle
as the Codex exclusions ([Appendix A](#appendix-a--fix-history)) and
Unclassified in §12 — the difference is *where* the exception surfaces: a
`$0`, `0`-token, real-looking model row would be actively misleading (it
implies a model ran and simply cost nothing), so it is excluded from the
ranking entirely rather than merely re-labelled in place.

---

## 11. Projects

**Displayed as:** a ranked bar list, top 8 shown, note reading `"top 8 of
N"` when more exist; each row shows `cost`, `N sess · minutes`.

**Formula:** identical shape to §10 (`byProject[project]`), plus a `project
= 'unknown'` fallback and a repo/worktree collapsing rule:
`projectLabel(cwd)` collapses `<repo>/<marker>/worktrees/<rest>` (marker ∈
`.autopilot`, `.claude`, `.git`) to `<repo>`, keeping `rest` as a separate
`worktree` field on the session rather than either discarding it or letting
it masquerade as a sibling project. (The mislabelling this rule corrected is
recorded in [Appendix A](#appendix-a--fix-history).)

**Source:** ranking and truncation, `dashboard/client.mjs`
(`shown = projects.slice(0,8)`); accumulation via the same `addTo()`/
`entries()` machinery as §10, keyed by `s.project` instead of `s.models`.

**What this does not model:** a session whose working directory could not be
determined (e.g. missing `cwd` in the transcript) lands in a literal
`"unknown"` bucket rather than being dropped — visible in the project list
rather than silently absent from the total.

---

## 12. What You Worked On

**Displayed as:** a ranked bar list of categories, bar width relative to
the top category's cost; each row shows `cost`, `N sess · $/sess`; a small
confidence dot on classified rows (opacity `0.5 + confidence×0.5`,
`dashboard/client.mjs`); `Unclassified` is always shown, never
hidden, and carries no confidence dot.

This is the only Scorecard metric that is **not** pure arithmetic over
token counts — it is a deterministic, rule-based classifier over each
session's title and tool-call mix. Because it is the metric most likely to
be second-guessed ("why did it call this a bug fix"), its full decision
procedure is reproduced here rather than summarized.

**Three layers, strictly ordered** (`classify()`, `src/lib/usage-classify.mjs:199-254`):

1. **Provenance (confidence = 1.0, unconditional).** If the session carries
   an `attributionSkill` or `attributionPlugin` matching a known prefix in
   `SKILL_CAT` (`usage-classify.mjs:45-62`, e.g. `superpowers:brainstorming`
   → `Design & planning`), that mapping **is** the category. This is not an
   inference — it is a recorded fact about which skill actually ran, so it
   overrides every other signal outright (`usage-classify.mjs:203-207`).

2. **Weighted keyword rules over the title, nudged by tool mix.**
   `RULES` (`usage-classify.mjs:76-150`) is a closed list of 14 categories,
   each with `strong` keywords (weight 3) and `weak` keywords (weight 1),
   matched as case-insensitive substrings of the session's title
   (`usage-classify.mjs:210-217`). A tool-mix prior then nudges — never
   solely decides — the ranking: an edit-heavy session (>30% of tool calls
   are `Edit`/`MultiEdit`/`Write`/`NotebookEdit`) adds weight to
   `Feature build`/`Refactor`/`Bug fix & debug`; a read-heavy, edit-light
   session (>45% `Read`/`Grep`/`Glob`, <10% edit) adds weight to `Code
   review`/`Security review`/`Research & exploration`; an agent-heavy
   session (>12% `Agent`/`Task` calls) adds weight to `Orchestration`
   (`TOOL_PRIOR`, `usage-classify.mjs:155-159`, applied
   `usage-classify.mjs:219-232`).

3. **The floor.** A category must clear `CONFIDENCE_FLOOR = 0.28`
   (`usage-classify.mjs:168`) or the session is reported `Unclassified`
   with `basis: 'weak signal'` — or `basis: 'no signal'` if no rule matched
   at all (`usage-classify.mjs:234`, `:252`). `Unclassified` is a **first
   class outcome**, not a failure state: forcing every session into a
   category to reach 100% coverage would make every category
   untrustworthy, not just the residue.

![Figure: the classifier's three layers — the provenance early exit at confidence 1.0, the all-rules scoring round with a worked title, and the 0.28 confidence floor below which a session stays Unclassified](assets/usage-classifier-layers.svg)

**Confidence formula** (`usage-classify.mjs:236-250`), for the top-scoring
category against its runner-up:

```text
strength = min(1, topScore / 7)                        // 7 ≈ two strong-keyword hits
margin   = 1 - min(runnerUpScore / topScore, 1)
grounded = 1 if the TITLE (not just the tool prior) contributed to the winning
             category's score, else 0 — a category that wins on tool-mix
             alone, with zero title evidence, is a guess, not a classification
confidence = round2( min(0.9, strength × (0.35 + 0.65 × margin)) × grounded )
```

The `0.35` floor on a dead-even tie (`TIE_FLOOR`, `usage-classify.mjs:174`)
means two equally-strong categories can never independently produce a
confident pick — the margin term earns the rest. The `0.9` cap
(`RULE_CONFIDENCE_CAP`, `usage-classify.mjs:177`) means confidence `1.0` is
reserved exclusively for provenance-layer matches, so a `1.0` in the UI is
always traceable to a specific attributed skill/plugin id, never to a lucky
keyword hit.

![Figure: confidence versus margin for four topScore levels, with the shaded Unclassified region below 0.28, the dashed 0.9 rules cap, and the lone 1.0 provenance point](assets/usage-classifier-confidence.svg)

**Worked example**, from the reference-corpus measurement: signal
coverage was `ai-title` 93%, tool mix 100%,
`attributionSkill`/`attributionPlugin` 8%, slash commands 13% (mostly
`/clear`/`/model`, not task-descriptive). This is why provenance alone
cannot classify most sessions and layer 2 (title + tool-mix rules) carries
the bulk of the load.

**Render:** `dashboard/client.mjs`, sorted cost-descending via the
shared `entries()` helper, with `$/sess = cost / max(sessions, 1)` guarding
the zero-session edge case (`dashboard/client.mjs`).

**What this does not model:** the classifier reads only the session's
*title* (Claude's own `ai-title`, written by the model itself at session
end) and its *tool-call mix* — never the transcript body. A session with a
generic or misleading title and an atypical tool mix for its actual work
will be misclassified or land in `Unclassified`; the confidence figure and
`basis` string exist specifically so a reader can tell when that has
happened rather than trusting the category blindly.
An **optional**, off-by-default LLM-labelling layer 3 exists for exactly
this residue (`--enrich`, applied only below the confidence floor, cached
permanently per session) but is out of scope for this document
since it is opt-in and not part of a default Scorecard render.

---

## 13. Provider pricing tables — verified rates

Every rate lives in the `PRICES` table (`src/lib/pricing.mjs:65-125`) and carries
the table's own last-verified date, `PRICES_AS_OF = '2026-08-25'`
(`pricing.mjs:18`). Each subsection below dates its own source check separately.

### 13.1 Anthropic — primary source, directly verified

Fetched in full from **[C1]** on 2026-07-25. The table below is Anthropic's
own published table, not a transcription from a secondary source:

| Model | Base input | 5m cache write | 1h cache write | Cache read (hit) | Output |
|---|---|---|---|---|---|
| Claude Fable 5 / Mythos 5 | $10/MTok | $12.50/MTok | $20/MTok | $1/MTok | $50/MTok |
| Claude Opus 5 | $5/MTok | $6.25/MTok | $10/MTok | $0.50/MTok | $25/MTok |
| Claude Opus 4.8 / 4.7 / 4.6 / 4.5 | $5/MTok | $6.25/MTok | $10/MTok | $0.50/MTok | $25/MTok |
| Claude Sonnet 5 (through 2026-08-31) | $2/MTok | $2.50/MTok | $4/MTok | $0.20/MTok | $10/MTok |
| Claude Sonnet 5 (from 2026-09-01) | $3/MTok | $3.75/MTok | $6/MTok | $0.30/MTok | $15/MTok |
| Claude Sonnet 4.6 / 4.5 | $3/MTok | $3.75/MTok | $6/MTok | $0.30/MTok | $15/MTok |
| Claude Haiku 4.5 | $1/MTok | $1.25/MTok | $2/MTok | $0.10/MTok | $5/MTok |

Every value in `pricing.mjs`'s Anthropic entries (`pricing.mjs:67-89`) matches
this table's "Base input" and "Output" columns exactly. Note that the two Sonnet
5 rows above are not a documentation convenience — they are exactly what the
code encodes, as the two periods of that entry's schedule (§3a), so the table
and the implementation state the same published change in the same shape. The cache-write and
cache-read *columns* in this table are provider-published absolute rates; the
kit's `pricing.mjs` instead stores the two **multipliers** (0.1× and 1.25×,
5-minute TTL only — the kit does not currently distinguish 5-minute from
1-hour cache TTL, since Claude Code transcripts do not record which TTL a
given cache write used) and applies them to the base input rate at cost-compute
time (`costOf()`, §3). Cross-checking one row: Opus 5's published $6.25
5-minute cache-write rate is exactly *$5 × 1.25*; its published $0.50 cache-read
rate is exactly *$5 × 0.1*. Every row in Anthropic's own table satisfies
`cache_write_5m = input × 1.25` and `cache_read = input × 0.1` — confirming
the multiplier approach is arithmetically identical to using the provider's
published absolute cache rates directly, for every current Anthropic model.

Anthropic's own prompt-caching documentation **[C2]** states the multipliers
in prose, independent of the pricing table: *"5-minute cache write tokens are
1.25 times the base input tokens price... Cache read tokens are 0.1 times the
base input tokens price."* This is the second, independent confirmation of
`CACHE_READ_MULTIPLIER`/`CACHE_WRITE_MULTIPLIER` (`pricing.mjs:169-170`).

### 13.2 OpenAI (Codex) — hand-maintained, no canonical machine-readable source

`pricing.mjs`'s own comment (`pricing.mjs:91-94`) records that
`~/.codex/models_cache.json` was checked directly and contains **zero**
price-related keys — Codex CLI does not ship pricing data locally, unlike
Anthropic which publishes a fetchable pricing document. OpenAI's rates in
this table are therefore maintained by hand against OpenAI's own developer
documentation and are the most drift-prone entries in the file — this is
explicitly why `PRICES_AS_OF` is surfaced in the UI (`u-asof`,
`dashboard/client.mjs`) rather than assumed current.

| Model (kit key) | Input | Output | Cache read (0.1×, derived) |
|---|---|---|---|
| `gpt-5.6-sol` | $5/MTok | $30/MTok | $0.50/MTok |
| `gpt-5.6-terra` | $2.50/MTok | $15/MTok | $0.25/MTok |
| `gpt-5.6-luna` | $1/MTok | $6/MTok | $0.10/MTok |
| `gpt-5.5` | $5/MTok | $30/MTok | $0.50/MTok |
| `gpt-5.5-pro` | $30/MTok | $180/MTok | $3/MTok |

Independently corroborated (aggregator sources, not OpenAI's own page —
see the sourcing-tier note below) on 2026-07-25: GPT-5.6 Sol short-context
pricing of $5 input / $30 output / $0.50 cache-read / $6.25 cache-write per
MTok, rising to $10/$45 above a 272K-input-token threshold **[C3, C4, C5]**;
OpenAI's cached-input discount is described industry-wide as "cached tokens
cost approximately 10% of regular input" and "automatic for all requests
containing 1,024+ tokens," and cache writes for the GPT-5.6+ model family
specifically are described as costing 1.25× the uncached input rate
**[C6]** — the same multiplier Anthropic publishes, which is why
`pricing.mjs` applies one multiplier pair to both providers rather than
maintaining two.

**Sourcing-tier disclosure, stated plainly rather than glossed over:** the
Anthropic table above (§13.1) was fetched directly from Anthropic's own
documentation domain and is a primary source. The OpenAI table was
corroborated via web search against multiple independent third-party
pricing aggregators (all citing the same figures independently, which is
reasonable but not equivalent evidence to a direct fetch of OpenAI's own
pricing page); an attempt to directly fetch OpenAI's developer pricing
documentation for this document was not completed. A maintainer updating
this table should fetch `https://platform.openai.com/docs/pricing` (or
whatever OpenAI's current canonical pricing URL is at the time) directly and
upgrade this citation to primary-source status. Until then, treat the OpenAI
rows in `pricing.mjs` — like the file's own comment already says — as
hand-maintained and drift-prone, not vendor-confirmed via automated fetch.

### 13.3 What the pricing table deliberately does not model

Recorded verbatim from `pricing.mjs:127-156` (`UNMODELLED_PRICING_FACTORS`,
`pricing.mjs:157-159`) because listing known gaps is what makes the
*modelled* factors credible:

- **Regional-processing uplift.** OpenAI charges +10% on data-residency
  endpoints for models released on/after 2026-03-05; Codex CLI does not use
  those endpoints by default and a Codex rollout carries no field naming the
  endpoint that served a given request, so this cannot be detected from local
  data. Anthropic's own equivalent is the `inference_geo` 1.1× multiplier on
  `"us"`-pinned inference, confirmed in **[C1]** §"Inference geography". A
  Claude transcript *does* carry `usage.inference_geo` on essentially every
  assistant turn (see the key-presence census below) — but the only value the
  local corpus records is the literal string `"not_available"`, which names no
  geography and so selects no multiplier. The key is present; the evidence
  is not.
- **Large-prompt surcharge.** A reported 2× input / 1.5× output surcharge
  above ~272K input tokens for the GPT-5.6 line is not restated on OpenAI's
  current canonical pricing page as far as this audit could confirm, so it
  is deliberately left unmodelled rather than encoded on one unconfirmed
  source.
- **`*-pro` models list no cached-input rate** in the maintained table
  (caching appears unsupported for that tier); their transcripts report
  zero cached tokens, so the 0.1× branch of `costOf()` is simply never
  exercised for them — not a bug, just an unreachable code path for that
  model family.
- **Service tiers.** Batch API, Flex, and Priority-tier multipliers (on
  both providers) are not applied. Anthropic's Batch API carries a
  documented 50% input/output discount **[C1]** §"Batch processing"; Claude
  Managed Agents sessions additionally bill **session runtime** at
  $0.08/session-hour on top of tokens **[C1]** §"Claude Managed Agents
  pricing". Neither transcript store records which **billing surface** (plain
  Messages API, Batch, or Managed Agents) produced a given session, so that
  distinction is undetectable. The narrower tier fields *are* recorded —
  `usage.service_tier` and `usage.speed` on Claude assistant turns, and a
  `thread_settings.service_tier` on newer Codex rollouts — and are
  nonetheless left unpriced, for the reasons below.

**Key-presence census.** Measured 2026-08-28 over the 200 most recently
modified of the 1,159 Claude transcripts under `~/.claude/projects` (file
mtimes 2026-08-26 → 2026-08-28; Claude Code CLI versions 2.1.245–2.1.251 in
that slice), and over 400 of the 1,026 rollouts under `~/.codex/sessions`:

| Field | Turns carrying it | Distinct values observed |
|---|---|---|
| Claude `usage.service_tier` | 9,661 of 9,662 (100.0%) | `"standard"` |
| Claude `usage.inference_geo` | 9,661 of 9,662 (100.0%) | `"not_available"` |
| Claude `usage.speed` | 3,002 of 9,662 (31.1%) | `"standard"` |
| Codex `thread_settings.service_tier` | 85 of 400 rollouts | `"default"` |

Codex rollouts carry no `inference_geo` or `speed` key at all; their
`token_count` payload is `input_tokens` / `cached_input_tokens` /
`output_tokens` / `reasoning_output_tokens` / `total_tokens` and nothing else.

**Why they stay unpriced.** Availability was never the blocker; *semantics*
is, on three counts. Each field's corpus holds exactly **one** distinct value,
so nothing here shows how a non-standard value would be spelled — a mapping
from a recorded string to a published multiplier could not be checked against
any evidence, only asserted. `inference_geo`'s single value is
`"not_available"`, so the field that would carry the 1.1× decision carries no
region. And the Codex field is a *thread setting* — configured intent — not a
record of the tier that actually served a request; only the second could price
a row. Encoding a multiplier on any of that would manufacture precision the
data does not support, the same failure §14 names as an invented denominator,
so the three factors remain listed in `UNMODELLED_PRICING_FACTORS` and
`costOf()` is unchanged. This is a scope note about *this* corpus and these
CLI versions, not a claim about every install.

---

## 13b. Limits view — vendor-reported plan utilization (ADR-0010)

Every other figure in this document is computed locally from transcripts. The
Limits sub-view is different by design: its percentages are **vendor-reported**
— the plan's own denominator, which ADR-0009 §3 correctly said local parsing
could never honestly invent. ADR-0010 defines the only two admissible channels,
both credential-free for ak:

- **Claude** — Claude Code pushes `rate_limits` (session/weekly/per-model
  `used_percentage` + `resets_at`) into every statusLine invocation on Pro/Max.
  The kit's managed statusline footer tees that JSON to
  `~/.config/agentic-kit/claude-rate-limits.json` (throttled, atomic, 0600) —
  the `quota tee` block in `statusline-footer.cjs:22`. The dashboard reads the
  tee via `normalizeClaudeLimits` (`quota.mjs:69`), which maps `five_hour` /
  `seven_day` / `seven_day_<model>` keys to duration-labelled windows.
- **Codex** — one `initialize` → `account/rateLimits/read` JSON-RPC exchange
  with a spawned `codex app-server`, implemented by `codexAppServerRateLimits`
  (`quota.mjs:176`) and TTL-cached (`CODEX_TTL_MS`, `:43`) by
  `collectCodexLimits` (`:231`). Lanes come from `rateLimitsByLimitId` in
  `normalizeCodexLimits` (`:113`), including per-model pools and
  rate-limit reset credits.

**The primary/secondary trap.** Codex's `primary` window is *not* reliably the
5-hour window — a live `prolite` account reported `primary` with
`windowDurationMins: 10080` (the weekly). Windows are therefore keyed and
labelled by duration (`windowLabel`, `quota.mjs:51`), never by slot name. The
same rule applies to the historical snapshots parsed out of rollouts: the
normalizer at `usage-parsers.mjs:511-530` keeps a flat `windows` list keyed by
`window_minutes`.

**Freshness is part of the number.** Both sides carry `fetchedAt`; the view
renders "as of Nm ago" and a `stale` badge (Claude's tee is push-only, so it
ages the moment sessions stop). The `/api/limits` route lives in
`dashboard-server.mjs`; `renderLimits` and `limRow` in `dashboard/client.mjs`
render and color each bar by proximity to its cap.

**Limit-aware findings.** `detectLimitInsights` (`usage-insights.mjs:771`)
applies the same evidence rules as every other detector — vendor percentages
are the user's own data; no dollar impact is ever claimed from a percentage;
"now" is the payload's `generatedAt`, never a clock. Detectors: pacing
against the window's own elapsed share, cross-host arbitrage between the two
plan pools, and expiring Codex reset credits (reported, never auto-consumed).

**What still has no supported channel:** Claude extra-usage credit balance and
subscription tier. They stay absent rather than approximated.

## 13c. Codex thread ledger — authoritative subagent attribution

Codex ≥0.140 maintains its own SQLite thread ledger (`~/.codex/state_N.sqlite`
— the `N` is a migration generation, so `codexStateDb` (`codex-state.mjs:41`)
globs and takes the newest). `readCodexState` (`:62`) reads per-thread
`thread_source` (`user` vs `subagent`) plus `thread_spawn_edges`, and
`applyCodexLedger` (`usage-aggregate.mjs:862-874`) overlays that onto parsed
sessions: a ledger-identified subagent has its token usage stripped — its
rollout replays the parent's entire token history (ccusage/ccusage#950
measured up to 91× inflation) — while the session record stays visible. The
rollout's own `session_meta.thread_source` sniff remains as the fallback when
the ledger is absent or migrated beyond recognition. Codex sessions also carry
`reasoningOutput` (`usage-parsers.mjs:706`) — reasoning tokens are a **subset**
of output tokens and are annotation only, never added to any sum.

## 14. Known limitations, restated as a single checklist

For a reviewer who wants the "does this number lie to me" answer without
reading every section — the panels documented in §15–§19 below are covered by
the same list:

- [x] Cost is always an **API-list-price equivalent**, never a claim about
  actual billing (§3, §14 pricing gaps above).
- [x] Engaged time leads with the most-corrected of three tiers; the other
  two remain visible (subtitle + tooltip), not deleted (§6).
- [x] `Unclassified` is always shown, never hidden or force-fit (§12).
- [x] An unrecognized model id is priced at a stated fallback rate, never
  silently zero (§3).
- [x] A day, project, or model with zero window activity is simply absent
  from its list — never rendered as a fabricated zero (§7, §11).
- [x] Price tables are hand-maintained and date-stamped in the UI
  (`rates as of <PRICES_AS_OF>`) precisely because they *will* drift.
- [x] The pricing formula applies identically to every provider; a
  cross-provider discrepancy in the by-host breakdown (§8) is diagnostic
  evidence of a **parsing** defect upstream, not a pricing defect — see
  [Appendix A](#appendix-a--fix-history) for two real examples found via
  this same reasoning.
- [x] A percentile taken from the overflow bucket of a histogram is printed
  with `≥`, and an unmeasured one is `null` rather than `0` (§15).
- [x] A latency figure is never called TTFT: it is a prompt-to-answer gap or
  a host-measured turn duration, and neither transcript records TTFT (§15).
- [x] Permission posture and inference provider both keep `not-recorded` as a
  first-class bucket — unmapped evidence is never folded into a real posture,
  and unobserved provenance is never attributed to a vendor (§8, §16).
- [x] Autonomy divides by prompts a human typed; the cost-per-session median
  excludes sessions that are `$0` by construction rather than by cheapness
  (§17).
- [x] Deltas compare equal-length adjacent windows, and a chip self-suppresses
  when there is no baseline to compare against (§17).
- [x] Aborted turns are counted apart from exceptions — an abort is a choice,
  not a failure (§18).
- [x] Tool names are the host's own and are never renamed across hosts; a
  top-N list folds its tail rather than dropping it (§19).

---

## 15. Rhythm & responsiveness

**Displayed as:** the `your rhythm` strip — two cards side by side. `session
length` heads with `median 9m · P90 ≥2h`; `response latency` with `p50 7.5s ·
p95 ≥60s · n 12,480`. Each card is a bar histogram with dashed percentile
markers laid over the bars, and reads `not measured` rather than a row of zero
bars when the window holds no samples. `ak usage score` prints the same two
figures as its `SESSION LENGTH` and `RESPONSE LATENCY` lines.

**Formula:**

```text
latHist[i] = number of latency samples in bucket i   edges (s) [2, 5, 10, 30, 60]
lenHist[i] = number of sessions in bucket i          edges (s) [300, 900, 2700, 7200]
bucket(v)  = first i where v <= edges[i], else edges.length      ← the OVERFLOW slot

p(q), over N samples, landing in bucket i (count n_i, running total `cum` before it):
    lo   = (i == 0) ? 0 : edges[i-1]
    p(q) = lo + (edges[i] - lo) × (q×N - cum) / n_i     when i <  edges.length
    p(q) = lo                                           when i == edges.length  ← FLOOR
    p(q) = null                                         when N == 0
```

**Source:**

- Edges: `LAT_BUCKET_EDGES` and `LEN_BUCKET_EDGES` (`usage-aggregate.mjs:177`, `:180`).
  The parsers carry their own copies (`usage-parsers.mjs:206`, `:209`) and the
  browser bundle a third pair (`LAT_EDGES`/`LEN_EDGES`), because the payload
  ships bucket *counts* and never the edges they were binned on.
- Slotting: `bucketIndex` (`usage-parsers.mjs:214-217`) — one definition of a
  boundary, shared by every histogram built on these edges.
- Sampling: `noteLatencySample` (`usage-parsers.mjs:223-228`) allocates
  `latHist` lazily, so a session that never observed a latency keeps
  `latHist: null` — absent, not a fabricated row of zeroes.
- Session length: `seal` derives each session's `lenSeconds` from its own
  active intervals (`usage-parsers.mjs:266-271`) — the §6 engaged figure for
  one session, never its first-to-last span.
- Window merge: `buildRhythm` (`usage-aggregate.mjs:682-702`) adds the
  per-session `latHist` slot-wise and buckets each session's `lenSeconds`.
- Percentiles: `percentileFromBuckets` (`usage-aggregate.mjs:206-223`). The
  browser re-implementation `bucketPercentile` (`usage-rhythm.mjs:106-126`) is
  pinned to byte-identical output, and the browser's edge copies to the server
  constants, by `tests/kit/dashboard-usage-telemetry.test.mjs:285-298` and
  `:387-388`.
- Render: `lengthCard`/`latencyCard` and the `≥` prefix helper `fmtAtLeast` in
  `src/lib/dashboard/client/usage.mjs` (that bundle shares a basename with the
  CLI command module, so its render sites are cited by function name rather
  than by line); the CLI's own `fmtAtLeast` is `src/commands/usage.mjs:143-146`
  and `printScoreRhythm` (`src/commands/usage.mjs:208-215`) prints the pair.

**Worked example**, latency, computable by hand. `latHist = [10, 30, 20, 25,
10, 5]`, so N = 100.

```text
p50: target 50. Running total is 10 after bucket 0, 40 after bucket 1;
     bucket 2 (n = 20) is where the 50th sample lands.
     lo = edges[1] = 5, edges[2] = 10
     p50 = 5 + (10 - 5) × (50 - 40)/20 = 5 + 2.5 = 7.5 s      → prints "7.5s"

p95: target 95. Running total is 85 after bucket 3; bucket 4 (n = 10) crosses.
     lo = edges[3] = 30, edges[4] = 60
     p95 = 30 + (60 - 30) × (95 - 85)/10 = 30 + 30 = 60.0 s   → prints "≥60s"
```

Session length behaves the same way: `lenHist = [40, 25, 15, 12, 8]`, N = 100,
median target 50 lands in bucket 1 (running total 40, n = 25), giving
`300 + (900 - 300) × (50 - 40)/25 = 540 s`, printed `9m`.

**Overflow floors, and why `≥` is not decoration.** The last bucket of either
histogram has no upper edge to interpolate towards, so a percentile landing in
it reports that bucket's **floor** and nothing more —
`if (i >= edges.length) return round(lo, 2)` (`usage-aggregate.mjs:217`).
A p95 printed as `≥60s` therefore means *at least 60 seconds* — the counts
cannot say whether the real figure is 61 seconds or 61 minutes, and printing a
bare `60s` would state a precision they do not carry. Both renderers apply the
prefix by the same rule (`v >= lastEdge`), so a value that reaches the last
edge by interpolation and one that came from the overflow slot print
identically — the two are the same claim. An empty histogram is `null`, never
`0` (`usage-aggregate.mjs:209`): "nothing was measured" and "measured zero" are
different statements and only the first is true, so the cards print
`not measured` and the CLI prints `no samples`.

**Per-host measurement — the same axis, not the same instrument.** The window
merges every host's samples into one histogram, but they are not gathered the
same way, and the panel says so rather than implying a single clock:

| Host | How a latency sample is produced |
|---|---|
| codex | **Host-measured.** `task_started` remembers the turn's start (`usage-parsers.mjs:558-563`) and `task_complete` samples Codex's own `duration_ms` (`usage-parsers.mjs:571-578`) — but only if no prompt-gap already covered that turn, so a turn is never sampled twice. |
| codex | Also derives a prompt-gap when one is available: a `user_message` opens the window (`usage-parsers.mjs:591`) and the next `agent_message` closes it, clearing `turnStartedAt` so the `duration_ms` fallback cannot double-fire (`usage-parsers.mjs:601-608`). |
| claude | **Derived from event gaps.** A human prompt sets `latState.pendingMs` (`usage-parsers.mjs:355`); the first real assistant turn closes that gap into a `noteLatencySample` call (`usage-parsers.mjs:410-414`). |
| opencode | Derived the same way from its message stream — `rec.pendingPromptMs`, closed by `noteLatencySample` (`usage-opencode.mjs:227-231`). |

Only the derived path is capped: a gap above `MAX_LATENCY_SAMPLE_SECONDS`
(3600 s, `usage-parsers.mjs:234`) is an idle resume — the person walked away
and came back — not a wait for a reply, so it is dropped from sampling
entirely rather than parked in the overflow bucket beside genuinely slow turns.
Codex's host-measured `duration_ms` needs no such cap: it is the host's own
turn duration, not a gap between two events that may have nothing between them.
An interrupted turn contributes nothing at all — `turn_aborted` clears both
pending states (`usage-parsers.mjs:644-654`), so a prompt that was never
answered can never be timed against a later, unrelated reply. A dropped API
turn is likewise never a sample: the error branch returns before the latency
block and deliberately leaves `pendingMs` set, so the first real completion
that eventually follows is what gets timed (`usage-parsers.mjs:399-408`).

**This figure is never labeled TTFT, in any surface.** Time-to-first-token
measures when a stream *starts*; every figure here measures when a turn
*finished* — a prompt-to-answer wall-clock gap, or the host's own turn
duration. The two differ by the whole generation, and on an agentic turn that
ran tools they differ by orders of magnitude. Both tooltips say so in words —
`LAT_TIP` and the session-drawer latency tip in
`src/lib/dashboard/client/usage.mjs` each carry the phrase "not streaming
TTFT" beside the per-host note it qualifies. A true
TTFT exists for Claude Code, but only as a span in its opt-in OpenTelemetry
beta ([monitoring](https://code.claude.com/docs/en/monitoring-usage)) — a
different, non-transcript evidence class that this scorecard does not read.
Neither transcript store records it, so no panel here may borrow the name.

**What this does not model:**

- the samples' exact values are gone once bucketed; a percentile is a linear
  interpolation inside one bucket, which is the only assumption the surviving
  counts support. A distribution that is heavily skewed *within* a bucket will
  read slightly off, and no amount of arithmetic here can recover it;
- host-measured and gap-derived samples share one histogram. That is a
  deliberate choice to keep one distribution rather than two thin ones, and it
  means a window dominated by one host is really reporting that host's
  instrument;
- the parsers' edge constants are a second, independent literal from the
  aggregate's. The browser copy is pinned to the server's by test; the parser
  copy is not, so a change made in one place and not the other would re-label
  buckets silently.

---

## 16. How you run

**Displayed as:** the `how you run` strip, subtitled `permission posture · who
drove · who served`. Three panels: `posture, by day` (api-equivalent cost
stacked by posture, one column per day), `main vs subagent` (a two-slice donut
whose centre reads the main-thread share), and `inference provider` (ranked
cost rows). `ak usage score` prints two tables, `mode — permission posture` and
`served by — inference provider`.

### 16.1 Permission posture

**Formula:**

```text
byMode[mode].cost         = Σ over sessions with that mode of session.cost
byDay[day].byMode[mode]  += rowCost   for each usage row, by the row's own day
mode                      = normalizeMode(host, raw evidence)  or 'not-recorded'
```

**Source:** `normalizeMode` (`usage-modes.mjs:23-35`) is the whole taxonomy;
`MODES` (`usage-modes.mjs:4`) is the closed four-value vocabulary. Per-day
folding is `addCost(d.byMode, rec.mode ?? 'not-recorded', rowCost)`
(`usage-aggregate.mjs:386`) — in the usage-row pass, because only a row knows
which day its dollars landed on. The window bucket is
`addTo(bucket(byMode, s.mode ?? 'not-recorded'), s)` (`usage-aggregate.mjs:591`).
The evidence each parser reads: Claude's `permissionMode`, off the human prompt
only (`usage-parsers.mjs:356-357`); Codex's `approval_policy`/`sandbox_policy`
off each `turn_context`, last one wins since a session may renegotiate mid-run
(`usage-parsers.mjs:505-508`); OpenCode's `mode` off each assistant message
(`usage-opencode.mjs:232-233`). Render is `modeChart` in
`src/lib/dashboard/client/usage.mjs`; the CLI table is `printScoreModeTable`
(`src/commands/usage.mjs:230-232`).

**The mapping table**, in full (`usage-modes.mjs:6-17`), pinned value-by-value
by `normalizeMode` assertions in `tests/kit/usage-modes.test.mjs:9-52`:

| Host | Recorded evidence | Mode |
|---|---|---|
| claude | `permissionMode: default` | `guarded` |
| claude | `permissionMode: acceptEdits` / `auto` / `dontAsk` | `auto-edit` |
| claude | `permissionMode: plan` | `plan` |
| claude | `permissionMode: bypassPermissions` | `unrestricted` |
| codex | sandbox `read-only`, whatever the approval policy | `plan` |
| codex | approval `never` + sandbox `danger-full-access` | `unrestricted` |
| codex | approval `never` + sandbox `workspace-write` | `auto-edit` |
| codex | approval `on-request` / `on-failure` / `untrusted` | `guarded` |
| opencode | `build` | `auto-edit` |
| opencode | `plan` | `plan` |
| any | anything else, or no evidence at all | `null` → `not-recorded` |

Two rulings in that table are worth reading twice. The **read-only sandbox
check runs first** (`usage-modes.mjs:10`), so `never` + `read-only` is `plan`,
not `unrestricted` — a session that cannot write is not permissive however its
approval policy is spelled. And **approval evidence alone is sufficient for
`guarded`** (`usage-modes.mjs:13-15`, the ADR-0038 ruling): human-in-the-loop
*is* the posture, so a Codex session that recorded an approval policy and no
sandbox policy still maps, rather than falling to `not-recorded` for want of a
second field.

**Unmapped is `not-recorded`, never a guess.** Every lookup is `?? null`
(`usage-modes.mjs:25`, `:32`), so an unrecognised raw value — a future
`permissionMode`, a policy this taxonomy has not been taught — yields no mode.
The raw string is kept beside the normalized one as `modeRaw`
(`usage-parsers.mjs:196`) precisely because the mapping is a judgement call and
a reader checking it needs the evidence it was made from. `not-recorded` is a
first-class bucket key rather than a display fallback
(`usage-aggregate.mjs:589-591`), it is always offered as a row by the CLI table
even at zero (`printBucketTable`, `src/commands/usage.mjs:221-228`), and
`segColor` forces it to the de-emphasis ink rather than letting a palette give
it a series colour (`usage-rhythm.mjs:183-186`) — spend with no posture
evidence must never read as a posture.

### 16.2 Delegation — main vs subagent

**Formula:**

```text
source              = (session.sidechain || session.threadSource == 'subagent')
                      ? 'subagent' : 'main'
bySource[k].cost    = Σ over sessions with that source of session.cost
centre of the donut = round(main / (main + subagent) × 100) %
```

**Source:** `sourceKey` (`usage-aggregate.mjs:544-546`). Both rows are created
before the fold (`usage-aggregate.mjs:570`) so "no subagent sessions" renders
as a zero rather than a row the UI silently drops. Claude's evidence is the
`isSidechain` flag on any entry in the file (`usage-parsers.mjs:454`, decoded at
`telemetry-records.mjs:244`); Codex's is the ledger-backed `thread_source`
(§13c). Render is `sourceDonut` in `src/lib/dashboard/client/usage.mjs`.

**Subagent cost can honestly read `$0`, and that is not a defect.** On the Codex
side it is the design: a ledger-identified subagent has its usage rows removed
outright (`applyCodexLedger`, `usage-aggregate.mjs:869-872`) and
`finalizeCodexUsage` never writes one in the first place
(`usage-parsers.mjs:692`), because a subagent rollout replays its parent's
entire cumulative token history and keeping it would bill the parent twice
(§13c, **[C7]**). The session record stays visible and auditable; its cost is
structurally zero, and §17 explains why such sessions are also kept out of the
cost-per-session distribution.

Whether the *Claude* side contributes any subagent spend is a property of the
corpus on the machine, not of the code — and on this one it does. In the census
of §13.3 (the 200 most recently modified local Claude transcripts, measured
2026-08-28), **50 files were sidechain-only** and carried 6,924 assistant turns
between them, against 150 main-only files carrying 2,738; **no file mixed the
two**. That last figure is what makes the rule sound: because Claude writes a
sidechain session to its own transcript, "any `isSidechain` entry marks the
whole record" cannot mis-attribute a parent's spend to a subagent. A window
drawn from that corpus therefore shows a genuinely non-zero subagent slice, and
a `$0` slice would be the surprising reading — the opposite of the Codex case,
where `$0` is expected.

### 16.3 Served by — inference provider

**Formula:** `byInferenceProvider[k].cost`, where `k` is the session's provider
string **only when its provenance was observed**, and `'not-recorded'`
otherwise (`providerKey`, `usage-aggregate.mjs:538-540`).

**Source:** the bucket is filled at `usage-aggregate.mjs:592`; render is
`providerRows` in `src/lib/dashboard/client/usage.mjs` (which prints
`not-recorded` as `Not recorded` and dims the row), and
`printScoreProviderTable` (`src/commands/usage.mjs:234-240`) adds
`'not-recorded'` to the CLI key set unconditionally, so the honest bucket
appears even in a window where every session was attributed.

This is the observed-provenance gate, and §8 states the rule and its
distinction from the legacy `byProvider` map in full. The short version: a
transcript host is not a vendor, a configured provider is not an observed one,
and spend is never bucketed under an assumption.

**What §16 does not model:** posture is the last evidence a session recorded,
not a timeline — a session that started in `plan` and ended in `auto-edit`
reports only the latter, and its whole cost stacks under it. The `main`/
`subagent` split is per session, so a main-thread session that dispatched
subagents still counts its own tokens as main-thread work; only the subagent's
own record is attributed to `subagent`.

---

## 17. Cadence & unit economics

**Displayed as:** the second hero row, four tiles — `sessions / active day`
(subtitle `N active days`, note `streak N days`), `autonomy` (`3.4×`, subtitle
`1.8 prompts / engaged hour`), `cost / session` (subtitle `median · excludes
$0-by-construction`, note `P90 $…`), and `cost / engaged hour`. Each of the
five KPI tiles above them additionally carries a footer: a delta chip against
the previous window and a per-day sparkline. `ak usage score` prints the same
four under `cadence`.

**Formulas:**

```text
sessionsPerActiveDay = totals.sessions / count(keys of byDay)
streak               = consecutive active days ending at the most recent one
autonomy             = totals.responses    / totals.humanPrompts
touchRate            = totals.humanPrompts / engagedHours
costPerEngagedHour   = totals.cost         / engagedHours       engagedHours = engagedSeconds/3600
costPerSessionMedian = median(cost of PRICED sessions)
costPerSessionP90    = nearest-rank P90 of the same set
cacheSavedUsd        = Σ rows  (costOf(1M as input) - costOf(1M as cacheRead)) × cacheRead / 1e6
```

**Source:** the derived block is `finishTotals` (`usage-aggregate.mjs:661-675`),
which the previous-window projection calls too so a baseline is never derived a
second, drifting way. `median` and `percentile` are exact over the values
(`usage-aggregate.mjs:619-624`, `:629-634`), unlike §15's bucketed percentiles.
Active days come from `byDay`'s key count and the streak from `activeStreak` in
`src/lib/dashboard/client/usage.mjs`; the tiles are `cadenceCells` there, and
`printScoreCadence` (`src/commands/usage.mjs:187-206`) in the CLI.

**Autonomy divides by prompts a human typed, and only those.** The denominator
is `totals.humanPrompts`, accumulated under an explicit main-thread guard
(`usage-aggregate.mjs:578`): a subagent's prompts are written by the harness,
so counting them would report a person as having typed work nobody asked for by
hand — and would grow the denominator exactly in the windows where delegation
was heaviest, making autonomy fall as automation rose. `totals.prompts` still
records every prompt beside it (`usage-aggregate.mjs:574`); the two are
different questions and both are on the wire. Touch rate is those same human
prompts per engaged hour (`usage-aggregate.mjs:669`), so both per-prompt figures
share one denominator. A rate whose denominator is zero is `null`, never `0`
— no engaged time means the rate was never measured, which is not what "zero
per hour" claims.

**Cost per session is a median over priced sessions only.** A session carries
`_priced` when it had any usage rows at all (`usage-aggregate.mjs:478`), and
only those costs enter the distribution (`usage-aggregate.mjs:584`). A session
with no usage rows costs `$0` *structurally* — nothing was ever measured for it,
the common case being a Codex subagent rollout whose tokens were stripped as a
double-count (§16.2) — and letting those in would report "the typical session
cost nothing" when the truth is "the typical session was not measured". The
median rather than the mean because session cost is heavy-tailed: one 12-hour
refactor can outweigh forty short sessions, and a mean would describe that one
session rather than the run of them. P90 rides beside it precisely so the tail
stays visible instead of being hidden by the choice of a robust centre. A
positive figure that rounds away at two decimals prints `<$0.01`, never
`$0.00` (`fmtUsdMin`, `src/commands/usage.mjs:96-99`) — "less than a cent" and
"nothing" are different claims.

**What the cache saved, asked as a difference.** `cacheSavingPerMillion`
(`usage-aggregate.mjs:345-354`) prices one million tokens twice through the
*injected* pricer — once as fresh input, once as cache reads — and takes the
gap; `cacheSavedFor` (`usage-aggregate.mjs:358-361`) scales that to the tokens
a row actually read from cache. Nothing in that path knows what the cache
multiplier is, so the saving cannot drift out of step with §3's table the way a
hard-coded "0.9 × input" would the day the multiplier changed. Both probes
carry the row's own model, provider and **day**, so the saving is priced from
the same schedule, at the same date, as the cost printed beside it.

**Worked example**, one row, hand-computable against §13.1's table. A
`claude-opus-5` row ($5/MTok in, $25/MTok out) that read 2,000,000 tokens from
cache:

```text
priced as fresh input:  1,000,000 × $5           / 1e6 = $5.00   per million
priced as cache reads:  1,000,000 × $5 × 0.1     / 1e6 = $0.50   per million
saved per million     =  $5.00 - $0.50                 = $4.50
this row              =  $4.50 × 2,000,000 / 1e6       = $9.00
```

The window total is the sum of those per-row figures
(`usage-aggregate.mjs:583`), carried on each session row as `cacheSavedUsd`
(`usage-aggregate.mjs:460`) so it is auditable a row at a time rather than only
in aggregate, and rendered in the cache tile's subtitle as `saved ≈ $X vs
uncached`.

**Deltas: what "the previous window" is, exactly.** For a displayed window of
`d` days ending at `now`, the baseline is the equal-length window immediately
before it — the half-open interval `[now − 2d, now − d)`
(`previousWindow`, `usage-aggregate.mjs:764-774`). Both bounds are derived from
`now` and `d`, the window the UI is *showing*, and never from the parse cutoff:
the caller widens that cutoff on purpose so older records survive to be
aggregated here (`lookbackDays: days * 2` at `src/commands/usage.mjs:288` and
`src/lib/dashboard-server.mjs:1356`), and deriving the baseline from a widened
bound would silently stretch it to whatever lookback the caller happened to
pass. A delta against an unknown-length window is not a delta. The upper bound
is exclusive so a session ending exactly at the boundary belongs to the current
window and is not counted in both (`usage-aggregate.mjs:498`). Asking for
`previous` without widening the lookback yields an all-zero baseline — the
older records were never read off disk — and every chip self-suppresses
against it rather than claiming a change it cannot measure. Leaving `previous`
off entirely leaves `agg.previous` as `null` — "not requested",
which a zeroed totals object would misreport as "measured nothing"
(`usage-aggregate.mjs:842`). A chip self-suppresses when the baseline is null
or zero, and a magnitude that rounds to zero prints flat rather than drawing an
arrow the printed number does not support (`deltaChip`,
`usage-rhythm.mjs:36-53`; `fmtDelta`, `src/commands/usage.mjs:152-163`).

**Engaged time by day is a sibling map, not a `byDay` field.** `byDay`'s
presence contract is **billed days only** — a key exists exactly when tokens
landed on that day (`dayBucket`, `usage-aggregate.mjs:307-320`) — and that is
what the active-day count and the streak above are counted from. Engaged time
does not share that key set: a session that runs past midnight, or a day spent
reading, produces worked time on a day that billed nothing. So
`buildEngagedByDay` (`usage-aggregate.mjs:738-746`) keys its own map, cutting
each active interval at every local midnight it crosses
(`splitAtLocalMidnight`, `usage-aggregate.mjs:716-724`) and unioning the pieces
per day, which makes the map sum exactly to `totals.engagedSeconds`. Folding it
into `byDay` would have forced one of two lies: inventing zero-token `byDay`
rows, or dropping real worked time. The consequence is visible on the tiles —
the engaged-time sparkline is drawn from a different day set than every other
trend, and the tile says so.

**What this does not model:** an active day is a *billed* day, so a day spent
entirely on work that never billed a token breaks the streak even though the
person worked. That follows from `byDay`'s contract rather than from a
judgement about what counts as a day of work, and the tile's tooltip states it
rather than leaving a reader to infer it from a broken streak.

---

## 18. Reliability

**Displayed as:** the `reliability` strip, subtitled `turns that never landed`.
Two stats — `exceptions / 1k responses` (subtitle `N of M responses`, plus a
worded flag comparing it to the previous window) and `aborted turns` (subtitle
`X per 1k responses`) — over an `exceptions by day` sparkline that names the
single worst day. `ak usage score` prints both under `reliability`, colouring
the exception line by whether any fired.

**Formula:**

```text
exceptionRate = totals.exceptions / totals.responses × 1000     null when no responses
abortRate     = totals.aborts     / totals.responses × 1000
byDay[day].exceptions += session.exceptions   attributed to the session's FIRST BILLED day
```

**Source:** `totals.exceptions` and `totals.aborts` accumulate together at
`usage-aggregate.mjs:579`; the per-day series lands on `byDay[s._day].exceptions`
(`usage-aggregate.mjs:601-604`). Render is
`relRate`/`relStat`/`relTrend` in `src/lib/dashboard/client/usage.mjs`;
`printScoreReliability` (`src/commands/usage.mjs:242-256`) prints the CLI pair.

**Evidence, per host.** An "exception" is a turn that never resolved to a
model, and each host signals that differently:

| Host | What is counted, and where |
|---|---|
| claude | The API-error placeholder — Claude Code synthesizes a local turn with no completion behind it when a connection drops, a rate limit rejects, or auth fails. The decoder sets `isApiError` from either `isApiErrorMessage` or the literal `<synthetic>` model marker (`telemetry-records.mjs:246`), because the flag is not set on every build that emits the placeholder; the parser counts it and returns before any model or usage attribution (`usage-parsers.mjs:399-408`). |
| codex | A `task_complete` event carrying a non-null `error` (`usage-parsers.mjs:577`). |
| codex | `turn_aborted` is counted **separately**, into `rec.aborts` (`usage-parsers.mjs:644-654`) — not into exceptions. |
| opencode | An assistant message carrying a non-null `error` (`usage-opencode.mjs:224-226`). |

**Aborts are held apart from exceptions on purpose.** An aborted turn is a
person pressing stop; an exception is the turn failing. Summing them would
report a deliberate interruption as a reliability problem and move a number
that is supposed to mean "how often did this break". They are counted, carried
(`aborts`, `usage-aggregate.mjs:435`) and displayed side by side, with the
distinction stated on the tile rather than left to the label.

**Exceptions ride the session's first-billed day.** The per-day series uses the
same attribution as the session count — `byDay[s._day].exceptions += s.exceptions`
(`usage-aggregate.mjs:601-604`) — which is *not* the moment a turn dropped: a session spanning midnight lands all of its
exceptions on the day its tokens first billed. That keeps the reliability trend
and the session trend drawn on one convention — the alternative, attributing
each exception to its own timestamp, would have made the two lines disagree
about which day a session belonged to. A session that never billed has no day
to attribute to and appears in neither the trend nor the per-day counts; it is
the same silence `byDay` keeps everywhere else, not a different one. The panel
says all of this in a note under the chart, because a reader will otherwise
read a spike as "something broke that afternoon".

**Worked example.** A window with 20 exceptions over 12,480 responses reports
`20 / 12,480 × 1000 = 1.6` exceptions per 1k responses. The reference-corpus
measurement behind §10 breaks 33 such placeholder turns down as `server_error`
27, `authentication_failed` 3, `rate_limit` 3 — three distinct causes, one
placeholder shape, which is why the panel counts them together and §10 excludes
them from the model ranking rather than showing a `$0` model row.

**What this does not model:** the rate's denominator is *responses*, which
includes the exception turns themselves (they increment `rec.responses` before
the error branch returns, `usage-parsers.mjs:382`) — they were real engaged
time, someone was genuinely waiting on them. A retry that eventually succeeded
appears as one exception plus one successful response, not as a single
recovered turn; nothing in either transcript links the two. And the worst-day
flag names the day with the most exceptions without inventing a threshold for
what counts as a spike, because any constant chosen here would be a judgement
the data never made.

---

## 19. Tool mix & model families

**Displayed as:** two panels. `tool mix` (`invocations · top 8, tail folded`)
is a ranked row list of tool names by invocation count, with a dimmed
`Other (N tools)` row folding the tail. `model mix over time`
(`api-equivalent cost by model family`) is a per-day stacked bar of cost by
coarse model family, top four families coloured and the rest folded into a
de-emphasised `other` band.

**Formula:**

```text
byTool[name]                  += session.tools[name]      summed across sessions
byDay[day].byModelFamily[fam] += rowCost                  fam = modelFamily(row.model)
```

**Source:** the tool tally is folded into `byTool` at `usage-aggregate.mjs:606`;
the per-day family split is `addCost(d.byModelFamily, modelFamily(row.model),
rowCost)` (`usage-aggregate.mjs:387`), inside the usage-row pass because only a
row knows its day. Render is `toolRows`/`modelMix` in
`src/lib/dashboard/client/usage.mjs`.

**Tool names are the host's own, never renamed.** Claude's tally is keyed by
the `tool_use` block's own `name` (`collectClaudeToolNames`,
`usage-parsers.mjs:366-375`). Codex's four tallied item types —
`CommandExecution`, `McpToolCall`, `FileChange`, `CollabAgentToolCall`
(`CODEX_TOOL_ITEM_TYPES`, `usage-parsers.mjs:634`, tallied at `:659-661`) —
keep those exact spellings in the ranking. Mapping `CommandExecution` onto
`Bash`, or `FileChange` onto `Edit`, would be a claim about equivalence that
neither host makes: the vocabularies are host-specific, the semantics do not
line up one-to-one, and a renamed row would quietly assert a correspondence no
evidence supports. Every other Codex item type is left to the unknown-item
diagnostic rather than tallied as a tool. The tail is **folded, never dropped**
— a top-8 list that silently loses the rest misstates the total every share
above it is read against — and the fold row is dimmed because `Other` is a
residue, not a tool.

**Model-family folding, with the rules pinned.** `modelFamily`
(`usage-aggregate.mjs:237-244`) lowercases the id, keeps only the segment after
the last `/` so a namespaced id still ends on the same tokens, then:

| Rule | Example id | Family |
|---|---|---|
| contains an Anthropic family name (`CLAUDE_FAMILIES`, `usage-aggregate.mjs:229`) | `claude-opus-5-20260401` | `opus` |
| — matched by containment, not position, since the id shape has moved | `claude-3-5-sonnet-20241022` | `sonnet` |
| — and after the last slash, so a namespaced id still folds | `openrouter/anthropic/claude-haiku-4-5` | `haiku` |
| otherwise matches `gpt-(\d+)` | `gpt-5.6-sol` | `gpt-5` |
| anything else | `some-local-model` | `other` |

`other` is a real bucket, not a discard: an unrecognised id's spend still has
to land somewhere, and it is never assigned a guessed family. In the chart it
is excluded from competing for a top-four colour slot regardless of size — it
is the residue bucket by definition — and painted in de-emphasis ink at the
base of the stack.

**What this does not model:** the tool tally counts *invocations*, not time or
cost, and a host that does not report tool calls contributes nothing here
rather than a zero — the telemetry-coverage surface (§1) says which hosts
report them at all, so an empty panel is readable as "not reported" rather than
"none happened". The family fold is coarse by design: it separates `opus` from
`sonnet` but not one Opus generation from another, and `gpt-5.6-sol` from
`gpt-5.6-luna` not at all. §10's per-model ranking is the surface that keeps
the full id.

---

## Appendix A — Fix history

The main body describes only current behavior; this appendix records what
was wrong before, for the curious.

### The 2026-07-25 Codex audit

A user (via a friend using Codex) reported the Codex side of the by-host
breakdown (§8) "looked questionable" compared to Claude's. Investigation
traced two real defects — both in `parseCodex` specifically, neither in the
shared aggregation or pricing logic those two parsers feed into (consistent
with §8's claim that the aggregation code is provider-agnostic). Fixed in
commit `540be18` on this branch.

#### Bug A — Codex model rows always showed 0 responses

`parseCodex`'s single `addUsage()` call never included a `responses` field —
Claude's parser passes `responses: 1` per assistant turn
(`usage-parsers.mjs:419`, the current equivalent), but Codex's call
passed no such field at all. Because `byModel[model].responses` is summed
directly from each usage row's `responses` field (`usage-aggregate.mjs:391`,
`m.responses += row.responses`), **every** Codex model in §10's "Models in
Play" list displayed `0 resp` regardless of real token/cost volume or actual
`agent_message` count. **Fix:** `parseCodex` now passes `responses:
rec.responses` (the session's own tallied response count,
`usage-parsers.mjs:701`) on its `addUsage()` call.

#### Bug B — subagent thread-replay could double-bill tokens

Codex CLI's `thread_spawn` subagent-delegation mechanism writes a rollout
file for the spawned subagent that **replays its parent thread's entire
prior cumulative token history as duplicate events**, re-timestamped to the
subagent's creation time, before the subagent's own new turns begin. This is
a documented, previously-reported Codex CLI behavior, not a hypothesis
invented for this audit — see **[C5]**, **[C6]**, **[C7]** below, the last
of which measured up to **91×** cost inflation in a real corpus from exactly
this mechanism (one parent session with 12 spawned subagents, each replaying
the parent's full history, so the parent's usage was counted 13 times over —
once for itself, once per subagent replay).

`parseCodex` took each rollout file's *last* cumulative `token_count` event
at face value (correctly avoiding the separate naive-summing bug **[C5]**
documents, since it already used last-event-only logic — see §4's worked
example) but performed **no de-duplication** against a parent session a
subagent file might be replaying. **Fix:** the parser now reads
`session_meta.thread_source` (`telemetry-records.mjs:101-110`, confirmed as a real
Codex rollout field by **[C7]**) and skips the `addUsage()` call entirely
when its value is `'subagent'` (`usage-parsers.mjs:692`, guard condition
`rec.threadSource !== 'subagent'`). The session record itself is **not**
dropped — it remains visible in the Sessions tab with `threadSource`
surfaced (mirroring the existing `sidechain` flag Claude sessions already
carry, `usage-parsers.mjs:454`), so a maintainer auditing the raw data can
still see it; it simply contributes zero tokens/cost, exactly as intended by
the "models still shows up in §10's list, with zero cost" mechanism §10
describes.

**Verification performed, and its limits, stated honestly:**

- Checked against **5 real local** `~/.codex/sessions/**/rollout-*.jsonl`
  files on the machine this fix was authored on. All 5 carried
  `thread_source: "user"` and unique `session_meta.id` values, with each
  file's *first* `token_count` event starting near its own system-prompt
  size (~12K tokens) rather than any elevated carryover value — i.e., **no
  resumed-session token-carryover was reproduced in this sample**, and no
  `thread_source: "subagent"` file was available to test the fix's guard
  condition against real replayed data.
- Regression coverage: a synthetic fixture reproducing the documented replay
  signature (a rollout whose very first `token_count` event already reports
  a large cumulative total, paired with `thread_source: "subagent"`) is
  asserted in `tests/kit/usage-index.test.mjs` ("a subagent-sourced Codex
  rollout (thread_spawn replay) is excluded from cost/token aggregation") to
  contribute zero tokens/cost/responses while remaining visible as a
  session.
- **This means Bug B's fix is grounded in cited public evidence and covered
  by synthetic regression tests, but has not yet been validated against a
  genuine `thread_source: "subagent"` file on real hardware.** Any
  maintainer whose machine accumulates such a file (most likely from heavy
  `ak run` / hierarchical-mesh swarm usage routing through Codex) should
  re-run this verification and update this note.

**Independent, third-party verification.**
[`docs/CODEX-USAGE-DIAGNOSTIC.md`](CODEX-USAGE-DIAGNOSTIC.md) is a
non-maintainer-facing companion to this section: a standalone, zero-dependency
script plus instructions for anyone with real Codex usage to compute the
same before/after comparison on their own machine, from a separate
reimplementation of the parsing logic, and report back an aggregate-only
result with no transcript content. Point anyone questioning their own
Codex numbers there first — it produces the real number instead of a
promise.

### Smaller corrections

- **Prompt counts included harness output (SCHEMA_VERSION 5).**
  `isHumanPrompt` counted harness-written user-role text — task
  notifications, stdout dumps — as human prompts: 32 claimed vs 20 real on
  the reference session (§2 states the current rule). Cached records carried
  the inflated counts, hence the v5 wholesale cache invalidation.
- **`<synthetic>` placeholder turns ranked as a model row.** Before §10's
  `isApiErrorMessage` branch, the placeholder's model id landed in
  `rec.models` like any other and surfaced as its own ranked row —
  `<synthetic> · $0.00 · 0 tok · N resp` — real-looking but meaningless,
  since no model ever ran.
- **The cache-schema gotcha behind SCHEMA_VERSION 4** — recorded exactly
  because a unit test could not have caught it: `exceptions` was a new
  required field on every session record, but the on-disk index caches
  previously-parsed records keyed by `(path, mtime, size)` — a session
  parsed before the change had no `exceptions` field at all. Summing
  `undefined` into `totals.exceptions` silently produced `NaN`, which
  `JSON.stringify` serialized as `null` over the wire — a live query against
  a real cached index (1,656 sessions, 90-day window) returned
  `totals.exceptions: null` and still showed the `<synthetic>` row in
  `byModel` on the first run after the change, purely because the cache
  predated it; every unit test still passed, since tests only exercise a
  fresh parse. `SCHEMA_VERSION` went to `4` (`usage-index.mjs:99`; since
  superseded by `5`, above) specifically to force the one-time re-parse.
  Re-querying the same live server after the bump returned
  `totals.exceptions: 20` with `<synthetic>` absent from `byModel` —
  measured, not projected.
- **Worktree branches masqueraded as projects.** Before §11's collapsing
  rule, a git worktree's *branch name* was reported as its own project,
  silently undercounting the true repo's total by whatever work happened in
  the worktree.

---

## Appendix B — Verification methodology

Every code citation above is read directly from the source files in the working
tree, and re-verified against them on every run of the suite (not recalled from
memory or summarized secondhand — see "Citation upkeep" below); every
external pricing claim was either fetched directly (Anthropic, §13.1) or
corroborated across multiple independent third-party sources with the
sourcing tier disclosed rather than implied (OpenAI, §13.2); every GitHub
issue cited (Appendix A) was located and its content quoted or paraphrased from the
actual issue text, not inferred from its title. Where verification was
incomplete (the OpenAI primary-source fetch, the Bug B real-data check),
that incompleteness is stated in the relevant section rather than omitted —
a maintainer-facing document that hides the edges of its own verification is
exactly the failure mode this document exists to avoid in the metrics it
describes.

**Citation upkeep.** `tests/kit/doc-citations.test.mjs` extracts every
`file:line` citation from this document (and from `TRANSCRIPTS.md`) and
asserts that an identifier or quoted string named beside the citation occurs
within the cited range (±10 lines) of the **current** source — so citation
rot fails `pnpm test` instead of accumulating silently. On failure, the error
names the citation and where its anchor now lives; update the line number (or
the named anchor, if the code was renamed). When the hint isn't enough,
`git log -p -L<start>,<end>:<file>` reconstructs where a range moved.

---

## Appendix C — Design rationale (ADR map)

The "why" behind the design is deliberately kept out of the main body; it
lives in
[`docs/adr/0009-usage-scorecard-local-transcript-analytics.md`](adr/0009-usage-scorecard-local-transcript-analytics.md).
Where a main-body section implements a recorded decision:

| Main-body topic | Design record |
|---|---|
| "API-equivalent, never billing" cost framing (§3) | ADR-0009 §3 |
| The three-tier engaged-time ladder (§6) | ADR-0009 §4 (and its 2026-07-25 amendment) |
| Worktree→repo project collapsing (§11) | ADR-0009 §4b |
| Rule-based classification; Unclassified as first-class; `--enrich` (§12) | ADR-0009 §5 (amendment: confidence/basis surfacing) |
| Findings / Sessions / Transcript tab rules (out of scope here) | ADR-0009 §6, §8 |
| Hand-maintained, date-stamped price tables (§13) | ADR-0009 "Costs and risks" |
| Reference-corpus figures quoted throughout (582–584 sessions, 96.3% cache share, the engaged-time ladder, signal coverage) | ADR-0009 |

---

## Appendix D — References

- **[C1]** Anthropic — *Pricing*. `https://platform.claude.com/docs/en/about-claude/pricing`. Fetched in full 2026-07-25; primary source for §13.1 (model rate table, prompt-caching multiplier table, worked cost example, Batch API discount, Managed Agents session-runtime billing, `inference_geo` multiplier).
- **[C2]** Anthropic — *Prompt caching*. `https://platform.claude.com/docs/en/build-with-claude/prompt-caching`. Fetched 2026-07-25; independent confirmation of the 1.25×/2×/0.1× cache multipliers in prose form.
- **[C3]** TLDL — *OpenAI API Pricing (July 2026)*. `https://www.tldl.io/resources/openai-api-pricing`. Accessed 2026-07-25; GPT-5.6 Sol/Terra/Luna tier pricing.
- **[C4]** OpenRouter — *GPT-5.6 Sol: API Pricing & Benchmarks*. `https://openrouter.ai/openai/gpt-5.6-sol`. Accessed 2026-07-25; context window (1.05M) and long-context (272K threshold) pricing corroboration.
- **[C5]** GitHub — `ccusage/ccusage#884`, *Parser overcounts duplicate token_count rows with unchanged total_token_usage*. `https://github.com/ccusage/ccusage/issues/884`. A Codex-usage-analytics tool (functionally the same job as this scorecard's Codex path) documenting that naive summation of cumulative `token_count` snapshots — rather than diffing or taking the last snapshot — matched only 131/732 real sessions correctly; delta/last-event logic matched 100%.
- **[C6]** GitHub — `openai/codex#14489`, *Change `TokenCount` to not re-emit `last_token_usage` on rate-limit-only updates*. `https://github.com/openai/codex/issues/14489`. Documents Codex CLI re-emitting a stale `last_token_usage` value on rate-limit-only updates with an unchanged cumulative total, which a parser reading `last_token_usage` naively double-counts.
- **[C7]** GitHub — `ccusage/ccusage#950`, *Bug: Massive token overcounting for Codex subagent sessions (91x inflation)*. `https://github.com/ccusage/ccusage/issues/950`. Documents `thread_spawn` subagent rollout files replaying the parent thread's entire token history as duplicate, re-timestamped events; measured a 91× real-world cost inflation (reported ~$9,041 against actual spend of ~$100) from a parent session with 12 spawned subagents. Also the source that identifies `session_meta.thread_source` / `source.subagent.thread_spawn` as the detectable field for this pattern. Source for Appendix A's Bug B.
- **[C8]** GitHub — `openai/codex#23001`, *Codex App upgrade can break opening older local threads when rollout session_meta lacks thread_source*. `https://github.com/openai/codex/issues/23001`. Confirms `thread_source` is a genuine, if not universally-present, `session_meta` field in real Codex rollout files (older/pre-upgrade rollouts may lack it entirely, which is why Appendix A's Bug B fix treats an absent `thread_source` as `'user'`-equivalent — i.e. included — rather than excluded).
- **ADR-0009** — [`docs/adr/0009-usage-scorecard-local-transcript-analytics.md`](adr/0009-usage-scorecard-local-transcript-analytics.md). The design record this document's formulas implement; source of every reference-corpus figure quoted above (582–584 sessions, 96.3% cache share, 100.7h/230.8h/296.4h engaged-time ladder, 93%/100%/8%/13% classification signal coverage).
- **In-repo source files**, cited against the working tree rather than a pinned commit (the citation test is what keeps them honest): `src/lib/usage-index.mjs`, `src/lib/usage-parsers.mjs`, `src/lib/usage-aggregate.mjs`, `src/lib/usage-modes.mjs`, `src/lib/pricing.mjs`, `src/lib/usage-classify.mjs`, `src/lib/usage-opencode.mjs`, `src/lib/telemetry-records.mjs`, `src/lib/quota.mjs`, `src/lib/codex-state.mjs`, `src/lib/dashboard/client/usage.mjs`, `src/lib/dashboard/client/usage-rhythm.mjs`, `src/commands/usage.mjs`, `tests/kit/usage-index.test.mjs`, `tests/kit/usage-modes.test.mjs`, `tests/kit/dashboard-usage-telemetry.test.mjs`.
