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

**Pinned to.** commit `540be18` on branch `fix/codex-usage-scorecard-metrics`
(2026-07-25). Line numbers below will drift as the code changes; if a citation
no longer matches, `git log -p -L<line>,<line>:<file>` from this commit is the
fastest way to find where it moved.

**Scope.** This document covers the **Scorecard** tab only — the five hero KPIs
(Sessions, API-Equivalent, Tokens, Engaged Time, Cache Read) and the six
supporting panels (cost per day, by host, token composition bar, when you work,
models in play, projects, what you worked on). The **Findings**, **Sessions**,
and **Transcript** tabs are governed by separate rules (ADR-0009 §6 and §8) and
are out of scope here except where they share a data source with a Scorecard
metric.

**Companion document.** This is a *metrics reference*, not a design record. The
"why" behind each design choice — why three time tiers, why rules-based
classification, why cost is never called billing — is ADR-0009's job and is
cited, not repeated, below. Read
[`docs/adr/0009-usage-scorecard-local-transcript-analytics.md`](adr/0009-usage-scorecard-local-transcript-analytics.md)
first if you want motivation; read this document if you want to check an
arithmetic claim.

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
`(path, mtime, size)`; SCHEMA_VERSION `3` invalidates the whole cache on a
schema change — `src/lib/usage-index.mjs:39`):

| Provider | Store | Format |
|---|---|---|
| Claude Code | `~/.claude/projects/<project>/<sessionId>.jsonl` | one JSON object per line: `user`/`assistant` turns, each assistant turn carrying its own `usage` object |
| Codex CLI | `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<sessionId>.jsonl` | one JSON object per line: `session_meta`, `turn_context`, and `event_msg` records, the latter carrying **cumulative** `token_count` snapshots, not per-turn deltas |

The parsers are `parseClaude` (`usage-index.mjs:362-426`) and `parseCodex`
(`usage-index.mjs:443-510`). Both are pure functions over the raw file bytes —
no network, no clock dependency beyond the transcript's own timestamps — so
every downstream number traces back to bytes already on the user's disk.
Nothing in this pipeline calls a provider API or a billing endpoint; **no
metric on this tab is ever a copy of an actual invoice.** That is the whole
reason every dollar figure is labelled "API-equivalent."

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
  assistant turn → not a session" (`usage-index.mjs:691`) — and a record whose
  last activity falls outside the requested window is dropped too
  (`usage-index.mjs:692`).
- `responses` accumulation: Claude increments per assistant message
  (`usage-index.mjs:392`); Codex increments per `agent_message` event
  (`usage-index.mjs:481`).
- Totals: `totals.responses += s.responses` per included session
  (`usage-index.mjs:762`).
- Render: `kpi("sessions", fmtNum(t.sessions), fmtNum(t.responses)+" assistant
  turns", "")` (`dashboard-server.mjs:1916`).

**Worked example.** A session with 3 user turns and 2 assistant turns
contributes `sessions += 1, responses += 2` — prompts (user turns) are tracked
separately and never appear in this KPI. Verified in
`tests/kit/usage-index.test.mjs:330` (`s.responses === 2, s.prompts === 1` for
a fixture with exactly that shape).

**What this does not model:** a session that opened but received no assistant
reply (e.g. immediately abandoned) is invisible to every Scorecard number —
by design, not oversight, since a session with no response has nothing to
attribute cost or category to.

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

**Source:** `costOf()`, `src/lib/pricing.mjs:169-176`, reproduced verbatim:

```js
export function costOf(usage) {
  const { model, provider, input, output, cacheRead, cacheWrite } = usage ?? {};
  const { in: rin, out: rout } = priceFor(model, provider);
  const inputUnits = tokens(input)
    + tokens(cacheWrite) * CACHE_WRITE_MULTIPLIER
    + tokens(cacheRead) * CACHE_READ_MULTIPLIER;
  return (inputUnits * rin + tokens(output) * rout) / 1e6;
}
```

`CACHE_READ_MULTIPLIER = 0.1`, `CACHE_WRITE_MULTIPLIER = 1.25`
(`pricing.mjs:112-113`) — see §13 for why these two numbers are correct for
**both** Anthropic and OpenAI, which is why `costOf` needs no per-provider
branch on the multiplier (only on the base `rate_in`/`rate_out`, resolved by
`priceFor`, `pricing.mjs:141-152`).

Rate resolution is **longest-prefix match** on a normalized model id
(`pricing.mjs:121-130`), so a dated release (`claude-haiku-4-5-20251001`)
resolves to the same entry as its bare alias, and a more specific entry
(`gpt-5.6-sol`) is never shadowed by a shorter one (`gpt-5.6`). An id matching
nothing gets `FALLBACK_PRICE` — Sonnet-class rate, `$3`/`$15`
(`pricing.mjs:109`) — rather than `$0`, so an unrecognized model can never be
silently free; `matched: false` travels with the result so a maintainer can
find fallback-priced rows if the table needs a new entry.

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
subtitle says "list price · not plan billing" as a first-class UI element
(ADR-0009 §3), not a footnote. See §14 for the full list of pricing factors
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
`usage-index.mjs:706` (`rowTokens = row.input + row.output + row.cacheRead +
row.cacheWrite`) and rolled into `totals.tokens` via `addTo`
(`usage-index.mjs:661`). Rendered with `fmtTok()`
(`dashboard-server.mjs:1826-1832`): `≥1e9` → `"X.XB"`, `≥1e6` → `"X.XM"`,
`≥1e3` → `"X.XK"`, else the rounded integer.

The **token composition bar** immediately below the hero row (cache read /
cache write / output / input, as four coloured segments) is the same four
numbers as percentages of `t.tokens` (`dashboard-server.mjs:1952-1959`,
`pct(a,b) = b ? a/b*100 : 0`, `dashboard-server.mjs:1840`).

**What "input" excludes.** For both providers, the `input` counter recorded
per row is **gross input minus cached input** — Claude's parser reads
`cache_read_input_tokens` and `cache_creation_input_tokens` as separate fields
the provider already reports separately (`usage-index.mjs:399-402`); Codex's
parser subtracts `cached_input_tokens` from `input_tokens` explicitly
(`usage-index.mjs:496-500`, `input: Math.max(0, gross - cacheRead)`) because
Codex's own `input_tokens` field **includes** cached tokens and would
double-count them against the separately-reported `cacheRead` figure if left
as-is. This is asserted by test:
`tests/kit/usage-index.test.mjs:330-350` ("Codex tokens come from the LAST
token_count event, never the sum") pins a fixture where the naive sum of two
cumulative snapshots (4000/1600/400) would be wrong, and the correct
last-event-only answer (3000/1200/300, split into `input: 1800, cacheRead:
1200`) is what the assertion requires.

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

**Source:** `dashboard-server.mjs:1914` (`cacheShare = pct(t.cacheRead,
t.tokens)`), rendered `dashboard-server.mjs:1922`.

**Why this number matters more than it looks like it should.** ADR-0009's
own motivating data point: on the reference corpus, 96.3% of tokens were
cache reads, and pricing them as fresh input (rather than at the 0.1×
multiplier) would overstate cost by roughly 10× (`pricing.mjs:8-9`, ADR-0009
§Context point 2). A cache-read share this high is not an anomaly to be
suspicious of on its own — it is the expected steady state for any
long-running agentic session that resends a large, mostly-unchanged system
prompt and tool-result history on every turn, which both Claude Code and
Codex CLI do by default.

---

## 6. Engaged Time

**Displayed as:** `ENGAGED TIME` hero tile — `403h`, subtitle `3286h summed`
plus a `sessions overlap` note. Hovering the tile reveals a tooltip with all
three tiers (ADR-0009's "ladder," `dashboard-server.mjs:1904-1910`).

This is the single most heavily-caveated metric on the tab, because a naive
version of it was **wrong by roughly 3×** during ADR-0009's own design pass
(ADR-0009 §4) — worth understanding in full before trusting the number.

**Three tiers**, each a genuinely different question, computed as three
separate interval-union operations:

| Tier | Question it answers | Formula |
|---|---|---|
| `engagedSeconds` (**the headline figure**) | Time actually spent working, never double-counted, never inflated by idle time | union of every session's **active sub-intervals** |
| `spanUnionSeconds` (tooltip only) | Wall-clock time with *some* session open, overlap collapsed but idle time NOT split out | union of every session's **whole span** (first timestamp → last timestamp) |
| `spanMinutes×60` (subtitle, labelled "summed") | The naive, double-counting sum — kept and clearly labelled as the dishonest one, not hidden | **sum** of every session's span, no union at all |

The asserted invariant is `engagedSeconds ≤ spanUnionSeconds ≤
spanMinutes×60`, and it is checked directly by test
(`tests/kit/usage-index.test.mjs`, the `mergeIntervals` suite starting around
line 97, plus the aggregate-level tests around lines 495-509).

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
   exceeds `IDLE_GAP_MS` (15 minutes, `usage-index.mjs:45`), then union
   *those* sub-intervals — this is `engagedSeconds`.

**Source:**

- `mergeIntervals()` (`usage-index.mjs:72-97`) — the pure union primitive,
  sorts intervals and merges any two that overlap **or exactly touch**
  (`s <= curEnd`, `usage-index.mjs:88`), returning total covered seconds
  rounded to the nearest second.
- `activeIntervals()` (`usage-index.mjs:295-307`) — splits one session's
  sorted timestamp list into sub-intervals wherever a gap exceeds
  `IDLE_GAP_MS`; "a run of one timestamp yields a zero-length interval and so
  contributes nothing" (comment, `usage-index.mjs:293`).
- Aggregation: `totals.engagedSeconds = mergeIntervals(sessions.flatMap(s =>
  s._active))` (`usage-index.mjs:804`); `totals.spanUnionSeconds =
  mergeIntervals(sessions.map(s => s._span))` (`usage-index.mjs:803`);
  `totals.spanMinutes` is a running sum of `s._span[1] - s._span[0]` across
  the loop (`usage-index.mjs:765`, finalized `usage-index.mjs:802`).
- Render: `fmtHours()` (`dashboard-server.mjs:1833`, `≥10h` rounds to the
  nearest hour, else one decimal place) and `fmtMins()`
  (`dashboard-server.mjs:1834`, `≥60min` rounds to hours, else whole
  minutes).

**Worked example**, ADR-0009's own reference-corpus measurement (14-day
window, 582–584 sessions depending on exact cutoff), reproduced here as the
canonical sanity check of the three-tier design:

| Tier | Total | Per day |
|---|---|---|
| `engagedSeconds` | 100.7 h | 7.2 h |
| `spanUnionSeconds` | 230.8 h | 16.5 h |
| `spanMinutes×60` | 296.4 h | 21.2 h |

The naive sum (296.4 h / 21.2 h/day) implies a person working 21-hour days —
"not a rounding error, it is a false statement" (ADR-0009 §4). The
span-union fixes overlap but still implies 16.5 h/day, because 11 in-window
sessions individually spanned over 6 hours (the longest 27.4 h) without
splitting at idle gaps. Only the fully-split, unioned figure — 7.2 h/day — is
both overlap-corrected and idle-corrected, which is why it is the one
promoted to the hero tile; the other two are demoted to a subtitle and a
tooltip respectively, never deleted, so the invariant chain stays checkable
from the running panel (ADR-0009 §4, "Amendment (2026-07-25)").

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
a bar shows `day · cost · tokens · sessions`.

**Formula:**

```text
byDay[day].cost = Σ costOf(row) for every usage row whose day == that key
```

**Source:** the day key is the row's own `row.day`, computed once at parse
time as **local calendar day**, not UTC
(`usage-index.mjs:398`/`usage-index.mjs:499` call `localDay(at)`) — so a
session that runs from 23:58 local to 00:05 local is billed to the day its
*first* row landed on (test:
`tests/kit/usage-index.test.mjs:556`, "a session that opens before midnight
is counted on its first billed day"). Accumulation:
`byDay[row.day].cost += rowCost` (`usage-index.mjs:709`). Bar height:
`h = maxDay ? max(2, cost/maxDay*100) : 2` (`dashboard-server.mjs:1933`) —
every non-empty day gets a visually nonzero bar (floor of 2%), so a very
cheap day is never rendered as invisible.

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
(`dashboard-server.mjs:1945-1949`).

**Formula:** identical aggregation to every other bucket
(`byProvider[s.provider]`, populated via `addTo()`, `usage-index.mjs:657-666`,
called once per session at `usage-index.mjs:767`), keyed by the literal string
`"claude"` or `"codex"` assigned at parse time
(`blankSession(id, 'claude')` / `blankSession(id, 'codex')`,
`usage-index.mjs:274-280`, `parseClaude`/`parseCodex` entry points).

**Why this pairing is the one under the most scrutiny.** Both providers'
tokens are summed into the *same* `tokens`/`cost` fields using the *same*
formula (§3, §4) — the aggregation code has no branch that treats a Codex
session differently from a Claude session once `costOf()` has priced its
rows. Any divergence between the two hosts' per-session averages is
therefore either (a) a genuine usage-pattern difference, or (b) a defect in
how one provider's raw transcript is *parsed into rows* upstream of
aggregation — never a defect in the aggregation itself, since both hosts
share it. §15 documents two real defects of exactly that kind, found and
fixed on 2026-07-25 in `parseCodex` specifically.

**What this does not model:** the by-host cards do not distinguish a session
that used both providers (not currently possible in this data model — a
session record has exactly one `provider`) from one that used only one; a
workflow that hands off between Claude and Codex mid-task (e.g. `ak dual
run`) produces two separate session records, one per host, each correctly
priced on its own, rather than one blended record.

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
(`usage-index.mjs:405-406`, keyed by `punchKey(at)`) and once per Codex
`agent_message` (`usage-index.mjs:483-484`), merged into the window-level
`punchcard` object per session (`usage-index.mjs:782`). Cell intensity is
linear against the single busiest cell in the window:
`v = pcMax ? n/pcMax : 0` (`dashboard-server.mjs:1969`) — this is a
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
(`usage-index.mjs:696-713`); the `sessions` count is deliberately computed
**separately**, once per session over its `s.models` array
(`usage-index.mjs:775-780`) rather than inside the cost loop, precisely
**so that a model can appear in `byModel` — with a nonzero session count —
even in a session that contributed zero cost/tokens/responses for that
model.** This is not an edge case invented for this document: it is the
exact mechanism that makes §15's subagent-replay fix safe (a model used only
by an excluded subagent-replay session still shows up as "used," at zero
cost, rather than vanishing).

`byModel[...].responses` is populated from `row.responses`
(`usage-index.mjs:711`), which in turn comes from the `responses` field
passed into `addUsage()` at the call site — `1` per Claude assistant turn
(`usage-index.mjs:398-404`), or `rec.responses` (the session's whole response
count) once per Codex session, passed at the single point Codex calls
`addUsage` (`usage-index.mjs:499-506`; see §15 Bug A for why this field was
previously omitted for Codex and every Codex model showed 0 responses
regardless of real activity).

**Render:** `bar(name, fmtUsd(cost), fmtTok(tokens)+" · "+fmtNum(responses)+"
resp", pct(cost, topModelCost), false)` (`dashboard-server.mjs:1982-1985`),
list itself sorted cost-descending by the shared `entries()` helper
(`dashboard-server.mjs:1841-1846`).

---

## 11. Projects

**Displayed as:** a ranked bar list, top 8 shown, note reading `"top 8 of
N"` when more exist; each row shows `cost`, `N sess · minutes`.

**Formula:** identical shape to §10 (`byProject[project]`), plus a `project
= 'unknown'` fallback and a repo/worktree collapsing rule that is worth
citing precisely because it was itself the subject of an ADR-0009 amendment:
`projectLabel(cwd)` collapses `<repo>/<marker>/worktrees/<rest>` (marker ∈
`.autopilot`, `.claude`, `.git`) to `<repo>`, keeping `rest` as a separate
`worktree` field on the session rather than either discarding it or letting
it masquerade as a sibling project (ADR-0009 §4b). Before this fix, a git
worktree's *branch name* was reported as its own project, silently
undercounting the true repo's total by whatever work happened in the
worktree.

**Source:** ranking and truncation, `dashboard-server.mjs:1987-1994`
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
`dashboard-server.mjs:2001-2002`); `Unclassified` is always shown, never
hidden, and carries no confidence dot.

This is the only Scorecard metric that is **not** pure arithmetic over
token counts — it is a deterministic, rule-based classifier over each
session's title and tool-call mix. Because it is the metric most likely to
be second-guessed ("why did it call this a bug fix"), its full decision
procedure is reproduced here rather than summarized.

**Three layers, strictly ordered** (`src/lib/usage-classify.mjs:199-254`):

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
   untrustworthy, not just the residue (ADR-0009 §5).

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

**Worked example**, from ADR-0009's own reference-corpus measurement
(§5): signal coverage was `ai-title` 93%, tool mix 100%,
`attributionSkill`/`attributionPlugin` 8%, slash commands 13% (mostly
`/clear`/`/model`, not task-descriptive). This is why provenance alone
cannot classify most sessions and layer 2 (title + tool-mix rules) carries
the bulk of the load.

**Render:** `dashboard-server.mjs:1997-2008`, sorted cost-descending via the
shared `entries()` helper, with `$/sess = cost / max(sessions, 1)` guarding
the zero-session edge case (`dashboard-server.mjs:1999`).

**What this does not model:** the classifier reads only the session's
*title* (Claude's own `ai-title`, written by the model itself at session
end) and its *tool-call mix* — never the transcript body. A session with a
generic or misleading title and an atypical tool mix for its actual work
will be misclassified or land in `Unclassified`; the confidence figure and
`basis` string exist specifically so a reader can tell when that has
happened rather than trusting the category blindly (ADR-0009 §5 Amendment).
An **optional**, off-by-default LLM-labelling layer 3 exists for exactly
this residue (`--enrich`, applied only below the confidence floor, cached
permanently per session — ADR-0009 §5) but is out of scope for this document
since it is opt-in and not part of a default Scorecard render.

---

## 13. Provider pricing tables — verified rates

Every rate in `src/lib/pricing.mjs:30-80` as of `PRICES_AS_OF = '2026-07-25'`
(`pricing.mjs:18`), checked against the sources below on 2026-07-25.

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

Every value in `pricing.mjs`'s Anthropic entries (`pricing.mjs:32-50`) matches
this table's "Base input" and "Output" columns exactly. The cache-write and
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
`CACHE_READ_MULTIPLIER`/`CACHE_WRITE_MULTIPLIER` (`pricing.mjs:112-113`).

### 13.2 OpenAI (Codex) — hand-maintained, no canonical machine-readable source

`pricing.mjs`'s own comment (`pricing.mjs:52-66`) records that
`~/.codex/models_cache.json` was checked directly and contains **zero**
price-related keys — Codex CLI does not ship pricing data locally, unlike
Anthropic which publishes a fetchable pricing document. OpenAI's rates in
this table are therefore maintained by hand against OpenAI's own developer
documentation and are the most drift-prone entries in the file — this is
explicitly why `PRICES_AS_OF` is surfaced in the UI (`u-asof`,
`dashboard-server.mjs:1923`) rather than assumed current.

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

Recorded verbatim from `pricing.mjs:82-99` (`UNMODELLED_PRICING_FACTORS`,
`pricing.mjs:100-102`) because listing known gaps is what makes the
*modelled* factors credible:

- **Regional-processing uplift.** OpenAI charges +10% on data-residency
  endpoints for models released on/after 2026-03-05; Codex CLI does not use
  those endpoints by default and a transcript does not record which endpoint
  served a given request, so this cannot be detected from local data.
  (Anthropic's own equivalent — the `inference_geo: "us"` 1.1× multiplier,
  confirmed in **[C1]** §"Inference geography" — is likewise unmodelled for
  the same reason: a Claude transcript does not record which `inference_geo`
  value a request used.)
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
  pricing" — neither transcript store records which billing surface (plain
  Messages API, Batch, or Managed Agents) produced a given session, so none
  of these are modelled.

---

## 14. Known limitations, restated as a single checklist

For a reviewer who wants the "does this number lie to me" answer without
reading every section above:

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
  (`rates as of <PRICES_AS_OF>`) precisely because they *will* drift
  (ADR-0009 "Costs and risks").
- [x] The pricing formula applies identically to every provider; a
  cross-provider discrepancy in the by-host breakdown (§8) is diagnostic
  evidence of a **parsing** defect upstream, not a pricing defect — see §15
  for two real examples of exactly this kind of defect, found via this same
  reasoning.

---

## 15. Bugs found and fixed during this audit (2026-07-25)

This section exists because a user (via a friend using Codex) reported the
Codex side of the by-host breakdown (§8) "looked questionable" compared to
Claude's. Investigation traced two real defects — both in `parseCodex`
specifically, neither in the shared aggregation or pricing logic those two
parsers feed into (consistent with §8's claim that the aggregation code is
provider-agnostic). Fixed in commit `540be18` on this branch.

### Bug A — Codex model rows always showed 0 responses

`parseCodex`'s single `addUsage()` call never included a `responses` field —
Claude's parser passes `responses: 1` per assistant turn
(`usage-index.mjs:403`, as it existed before this fix), but Codex's call
passed no such field at all. Because `byModel[model].responses` is summed
directly from each usage row's `responses` field (`usage-index.mjs:711`,
`m.responses += row.responses`), **every** Codex model in §10's "Models in
Play" list displayed `0 resp` regardless of real token/cost volume or actual
`agent_message` count. **Fix:** `parseCodex` now passes `responses:
rec.responses` (the session's own tallied response count,
`usage-index.mjs:481`) on its `addUsage()` call.

### Bug B — subagent thread-replay could double-bill tokens

Codex CLI's `thread_spawn` subagent-delegation mechanism writes a rollout
file for the spawned subagent that **replays its parent thread's entire
prior cumulative token history as duplicate events**, re-timestamped to the
subagent's creation time, before the subagent's own new turns begin. This is
a documented, previously-reported Codex CLI behavior, not a hypothesis
invented for this audit — see **[C4]**, **[C5]**, **[C6]** below, the last
of which measured up to **91×** cost inflation in a real corpus from exactly
this mechanism (one parent session with 12 spawned subagents, each replaying
the parent's full history, so the parent's usage was counted 13 times over —
once for itself, once per subagent replay).

`parseCodex` took each rollout file's *last* cumulative `token_count` event
at face value (correctly avoiding the separate naive-summing bug **[C5]**
documents, since it already used last-event-only logic — see §4's worked
example) but performed **no de-duplication** against a parent session a
subagent file might be replaying. **Fix:** the parser now reads
`session_meta.thread_source` (`usage-index.mjs:458`, confirmed as a real
Codex rollout field by **[C7]**) and skips the `addUsage()` call entirely
when its value is `'subagent'` (`usage-index.mjs:495`, guard condition
`rec.threadSource !== 'subagent'`). The session record itself is **not**
dropped — it remains visible in the Sessions tab with `threadSource`
surfaced (mirroring the existing `sidechain` flag Claude sessions already
carry, `usage-index.mjs:277`), so a maintainer auditing the raw data can
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
  `ak dual run` / hierarchical-mesh swarm usage routing through Codex) should
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

---

## 16. Verification methodology for this document

Every code citation above was read directly from the source files at commit
`540be18` (not recalled from memory or summarized secondhand); every
external pricing claim was either fetched directly (Anthropic, §13.1) or
corroborated across multiple independent third-party sources with the
sourcing tier disclosed rather than implied (OpenAI, §13.2); every GitHub
issue cited (§15) was located and its content quoted or paraphrased from the
actual issue text, not inferred from its title. Where verification was
incomplete (the OpenAI primary-source fetch, the Bug B real-data check),
that incompleteness is stated in the relevant section rather than omitted —
a maintainer-facing document that hides the edges of its own verification is
exactly the failure mode this document exists to avoid in the metrics it
describes.

---

## 17. References

- **[C1]** Anthropic — *Pricing*. `https://platform.claude.com/docs/en/about-claude/pricing`. Fetched in full 2026-07-25; primary source for §13.1 (model rate table, prompt-caching multiplier table, worked cost example, Batch API discount, Managed Agents session-runtime billing, `inference_geo` multiplier).
- **[C2]** Anthropic — *Prompt caching*. `https://platform.claude.com/docs/en/build-with-claude/prompt-caching`. Fetched 2026-07-25; independent confirmation of the 1.25×/2×/0.1× cache multipliers in prose form.
- **[C3]** TLDL — *OpenAI API Pricing (July 2026)*. `https://www.tldl.io/resources/openai-api-pricing`. Accessed 2026-07-25; GPT-5.6 Sol/Terra/Luna tier pricing.
- **[C4]** OpenRouter — *GPT-5.6 Sol: API Pricing & Benchmarks*. `https://openrouter.ai/openai/gpt-5.6-sol`. Accessed 2026-07-25; context window (1.05M) and long-context (272K threshold) pricing corroboration.
- **[C5]** GitHub — `ccusage/ccusage#884`, *Parser overcounts duplicate token_count rows with unchanged total_token_usage*. `https://github.com/ccusage/ccusage/issues/884`. A Codex-usage-analytics tool (functionally the same job as this scorecard's Codex path) documenting that naive summation of cumulative `token_count` snapshots — rather than diffing or taking the last snapshot — matched only 131/732 real sessions correctly; delta/last-event logic matched 100%.
- **[C6]** GitHub — `openai/codex#14489`, *Change `TokenCount` to not re-emit `last_token_usage` on rate-limit-only updates*. `https://github.com/openai/codex/issues/14489`. Documents Codex CLI re-emitting a stale `last_token_usage` value on rate-limit-only updates with an unchanged cumulative total, which a parser reading `last_token_usage` naively double-counts.
- **[C7]** GitHub — `ccusage/ccusage#950`, *Bug: Massive token overcounting for Codex subagent sessions (91x inflation)*. `https://github.com/ccusage/ccusage/issues/950`. Source for Bug B (§15): documents `thread_spawn` subagent rollout files replaying the parent thread's entire token history as duplicate, re-timestamped events; measured a 91× real-world cost inflation (reported ~$9,041 against actual spend of ~$100) from a parent session with 12 spawned subagents. Also the source that identifies `session_meta.thread_source` / `source.subagent.thread_spawn` as the detectable field for this pattern.
- **[C8]** GitHub — `openai/codex#23001`, *Codex App upgrade can break opening older local threads when rollout session_meta lacks thread_source*. `https://github.com/openai/codex/issues/23001`. Confirms `thread_source` is a genuine, if not universally-present, `session_meta` field in real Codex rollout files (older/pre-upgrade rollouts may lack it entirely, which is why the fix in §15 Bug B treats an absent `thread_source` as `'user'`-equivalent — i.e. included — rather than excluded).
- **ADR-0009** — [`docs/adr/0009-usage-scorecard-local-transcript-analytics.md`](adr/0009-usage-scorecard-local-transcript-analytics.md). The design record this document's formulas implement; source of every reference-corpus figure quoted above (582–584 sessions, 96.3% cache share, 100.7h/230.8h/296.4h engaged-time ladder, 93%/100%/8%/13% classification signal coverage).
- **In-repo source files**, all pinned to commit `540be18`: `src/lib/usage-index.mjs`, `src/lib/pricing.mjs`, `src/lib/usage-classify.mjs`, `src/lib/dashboard-server.mjs`, `tests/kit/usage-index.test.mjs`.
