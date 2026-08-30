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
and the supporting panels — Cost per day, By host, the token composition bar,
Your rhythm, How you run, When you work, Models in play, Tool mix, Model mix
over time, Reliability, Projects, What you worked on. Two adjacent surfaces are
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
schema change — `src/lib/usage-index.mjs:10`, `:141`):

| Transcript host | Store | Format |
|---|---|---|
| Claude Code | `~/.claude/projects/<project>/<sessionId>.jsonl` | one JSON object per line: `user`/`assistant` turns, each assistant turn carrying its own `usage` object |
| Claude Code (subagent) | `~/.claude/projects/<project>/<sessionId>/subagents/agent-<hash>.jsonl` | the same per-line format. A session's own delegated work, written to its own file beside the parent — cost-bearing, and marked `sidechain` by its own entries |
| Codex CLI | `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<sessionId>.jsonl` | one JSON object per line: `session_meta`, `turn_context`, and `event_msg` records; the latter carry **cumulative** `token_count` snapshots plus legacy messages or newer `item_completed` envelopes |

Discovery is **one level of project directories plus that one nested shape**,
not a recursive walk: `listClaude` (`usage-index.mjs:337-351`) descends into a
session-id directory only through `listClaudeSubagents`
(`usage-index.mjs:312-317`), which reads exactly
`<projectDir>/<sessionId>/subagents/*.jsonl`. A directory that is not a
session-id dir with a `subagents` child — Claude Code's own `memory` dir, say —
contributes nothing rather than being crawled. Each subagent record takes a
**namespaced** id, `<sessionId>/<stem>` (`usage-index.mjs:317`), because Claude
Code names every such file `agent-<hash>.jsonl` and that stem is not guaranteed
unique across two parents; an unnamespaced id would silently collide two
unrelated subagent records into one. `locateSubagent`
(`usage-index.mjs:870-877`) resolves that id back to the nested path when a
reader opens the session, building the candidate path from the two validated
capture groups rather than from raw request input.

The parsers are `parseClaude` (`usage-parsers.mjs:602-631`) and `parseCodex`
(`usage-parsers.mjs:968-986`). Both are pure functions over the raw file bytes —
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
and response totals, warnings, and unknown kinds. Every field is counted — the
envelope reports what was read, never what a parser could read in principle.
That is narrower than what the hosts publish: Claude documents tool hooks and
OpenTelemetry tool spans ([hooks](https://code.claude.com/docs/en/hooks),
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
  assistant turn → not a session" (`usage-aggregate.mjs:844`) — and a record whose
  last activity falls outside the requested window is dropped too
  (`usage-aggregate.mjs:845`).
- `responses` accumulation: Claude increments per assistant message
(`usage-parsers.mjs:542-547`); Codex increments per `agent_message` event
(`usage-parsers.mjs:846-851`).
- Totals: `totals.responses += s.responses` per included session
(`usage-aggregate.mjs:917`).
- Render: `kpi("sessions", fmtNum(t.sessions), fmtNum(t.responses)+" assistant
  turns", "")` (`dashboard/client.mjs`).

**Worked example.** A session with 3 user turns and 2 assistant turns
contributes `sessions += 1, responses += 2` — prompts (user turns) are tracked
separately and never appear in this KPI. Verified in
`tests/kit/usage-index.test.mjs:387-388` (`s.responses === 2, s.prompts === 1` for
a fixture with exactly that shape).

**What this does not model:** a session that opened but received no assistant
reply (e.g. immediately abandoned) is invisible to every Scorecard number —
by design, not oversight, since a session with no response has nothing to
attribute cost or category to.

**What "prompts" excludes (Claude since SCHEMA_VERSION 5, Codex since
SCHEMA_VERSION 13, the browser-state block on both since 15):** user-role
entries whose text the harness wrote — task notifications,
`bash-stdout`/`local-command-stdout` dumps, caveats, the ambient
`in-app-browser-context` block — are not
human prompts and no longer count as such on Claude (`isHumanPrompt` +
`HARNESS_OUTPUT_RE`; the full envelope taxonomy is
[`TRANSCRIPTS.md`](TRANSCRIPTS.md) §3.2). A `! command` the person typed
(`bash-input`) still counts. Codex has no discipline of its own for the same
distinction — a `user_message`/`item_completed` `UserMessage` event is gated
for machine markers before it counts (`isCodexHumanMessage`), but not for the
full set Claude's `isHumanPrompt` checks: Claude's gate additionally excludes
`isMeta` entries, entries carrying a `tool_result` block, and empty text,
none of which `isCodexHumanMessage` inspects — it is markers-only. Reuses
`HARNESS_OUTPUT_RE` plus two Codex-specific markers for mirrored cross-host
envelopes: a `<teammate-message` wrapper and the literal `"Another Claude
session sent a message:"` prefix — see [`TRANSCRIPTS.md`](TRANSCRIPTS.md)
§1.2). (The correction this rule shipped with is recorded in
[Appendix A](#appendix-a--fix-history).)

### 2a. Prompt fingerprints and provenance (SCHEMA_VERSION 14, extended in 16)

**Displayed as** — nothing yet. This is a recorded field, not a rendered
number: the scan path derives it so the planned Usage → Prompts view can
compute repetition, length and authorship statistics without re-reading the
corpus. It is documented here because it lands on every cached session record.

**Formula** — each turn the parsers classify as `kind: 'prompt'` contributes
one entry to `session.promptFPs`:

```text
norm  = lowercase(text), whitespace collapsed, trailing .!?,;: stripped
h     = sha256(norm)[0..16)          16 hex chars
t     = |tokens(norm)|               token COUNT, repeats kept
th    = sorted set of sha256(tok)[0..8) for tok in tokens(norm), first 64
p     = provenanceOf(text, kind)     one of human | control | agent | adapter
q     = 1 when the turn is question-shaped        key OMITTED when it is not
o     = 1 when it opens with a persona assignment key OMITTED when it does not
```

`tokens` splits `norm` on everything outside `[a-z0-9#/_.+-]`, so a path or a
flag stays one distinctive token rather than becoming several common ones.

`th` is bounded at 64. Because the hashes are sorted and a hash is uniform with
respect to its token, those 64 are a **bottom-k sketch** — a deterministic,
unbiased sample of the token set, and the standard input to a set-similarity
estimate — not the first 64 words of the prompt. The bound is load-bearing, not
tidiness: measured on this machine's corpus (2026-08-29) unique-token counts run
p50 60, p95 1,035, max 7,873, and storing all of them cost **15 MB against a
2.1 MB index**. Capping the fingerprint COUNT without capping this would have
been no bound at all, since one pasted document outweighs a hundred real
instructions. At 64 the median prompt is stored complete and the tail costs a
bounded ~700 bytes instead of ~86 KB.

**The two shape flags (v16)** are decided while the text is still in hand,
because that is the last moment it exists — nothing downstream can re-derive
them. `q` is set when the turn ends with `?`, opens with a wh-word, or opens
with an auxiliary *and* contains a `?`; `o` when it opens with
`you are a|an|the …` or the `# Instructions (read first)` heading. Both keys
are **omitted when false** rather than written as `0`: an absent key means "not
that shape", never a measurement that came out zero, and the corpus carries
5,635 entries where two extra keys each would not be free.

**Prompt text is never stored.** A fingerprint entry's keys are exactly
`{h, t, th, p}` plus the two optional flags — nothing else, ever. No parser
writes prompt text to a session record and the index cache therefore carries
none. (`session.title` is a separate, pre-existing surface — masked and
clipped — with its own contract, §1.)

**Provenance** answers *who wrote this*, which is not the same question as the
prompt gate's *did the harness write this*. Measured on the reference corpus
(2026-08-29, 5,527 parser-visible user-role turns), only 27.6% were typed by
the person; the rest is agent-to-agent delivery, tool-authored headless
templates, and person-initiated control records. The closed vocabulary is:

| Tag | Means | Example opener |
|---|---|---|
| `human` | typed by the operator | anything unmatched |
| `control` | person-initiated, not a typed instruction | `<command-name>`, `[Request interrupted by user`, `<bash-input>`, `[Image #1]`, "This session is being continued…" |
| `agent` | delivered into the turn by another session | `Another Claude session sent a message:`, `<teammate-message` |
| `adapter` | a tool's own headless template | the security-guidance review hook, qe-court probes, `<!-- generated-by: agentic-kit` |

**Source** — one implementation, shared by all three transcript sources, so the
same sentence fingerprints identically whichever host recorded it:

- `normalizePromptText` — `src/lib/usage-parsers.mjs:237`
- `promptFingerprint` — `src/lib/usage-parsers.mjs:272`
- `promptShape` — `src/lib/usage-parsers.mjs:317`, over the anchored rules
  `QUESTION_WH_RE` / `QUESTION_AUX_RE` — `src/lib/usage-parsers.mjs:287-288` —
  and `PERSONA_OPENER_RE` — `src/lib/usage-parsers.mjs:294`
- `notePromptFingerprint` — `src/lib/usage-parsers.mjs:334`, bounded by
  `MAX_PROMPT_FPS` — `src/lib/usage-parsers.mjs:216` — and
  `MAX_TOKEN_HASHES` — `src/lib/usage-parsers.mjs:231`
- `PROVENANCE_TAGS` — `src/lib/usage-provenance.mjs:20`; the ordered rules —
  `src/lib/usage-provenance.mjs:33-77`; `provenanceOf` —
  `src/lib/usage-provenance.mjs:92`
- Wired on the Claude path at `userTurnKind` —
  `src/lib/usage-parsers.mjs:519-520`; on the Codex path inside
  `handleCodexUserMessage` — `src/lib/usage-parsers.mjs:832-839`; on the
  opencode path inside `recordUserMessage` — `src/lib/usage-opencode.mjs:157-170`

**What this does not model:**

- **Provenance is deliberately one-directional.** An unrecognized machine
  template counts as `human`. Over-stating what the operator typed is visible
  and self-correcting; silently attributing a typed prompt to a machine is not.
  The **measured** residual on the reference corpus is now zero: the 51 harness
  turns that used to land as `human` were resolved at their source in v15 — 33
  `<in-app-browser-context>` blocks joined the harness gate (so they are no
  longer prompts at all), and 18 session-continuation turns became `control`.
  Zero *measured* residual is not zero residual: a machine template nobody has
  seen yet still counts as `human`, by design.
- **The rules are openers, not classifiers.** Each pattern is anchored at the
  start of the turn, so a marker quoted mid-prompt does not reclassify it — and
  a machine template this list has never seen is simply not recognized.
- **A shape measured at zero gets no rule.** `<command-args>`,
  `<system-reminder>` and "Please continue the conversation…" all look like
  siblings of rules that exist, and all measured zero turns reaching
  `kind: 'prompt'`, so none of them is special-cased. Guessing would risk
  attributing a typed prompt away from the operator, which is the one error
  direction this taxonomy forbids.
- **Token hashes are 4 bytes**, so a large token vocabulary will collide
  occasionally. That is a tolerable error for set-similarity clustering and is
  not sound for proving two prompts were identical — `h` answers that.
- **`th` is a sketch above 64 unique tokens**, so similarity between two long
  prompts is *estimated*, with a standard error near 0.06 at the J≈0.6
  threshold the clustering is specified at. On the reference corpus 49% of
  prompts exceed the bound. Exact-equality questions never touch `th`.
- **The list is capped at 2,000 entries per session**, with the excess counted
  in `promptFPOverflow` rather than silently dropped. The prompt COUNT itself
  is never capped.
- **The shape flags are grammar, not intent.** `q` does not model a rhetorical
  question, and an auxiliary opener with no `?` anywhere ("can you run the
  tests") is read as the politeness form of an instruction rather than a
  question — deliberately, because that is what it is. `o` requires the article
  in `you are a|an|the`, so "you are right, revert it" is not a persona; the
  cost of that narrowness is that an unusual role phrasing goes uncounted, which
  is the same one-directional error the provenance rules accept.
- **The flags are provenance-blind.** A tool's own template that opens with a
  role still carries `o`. A consumer that only wants what the *operator* typed
  filters on `p === 'human'` itself.

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

`aggregate()` passes each usage row's own `day` (`usage-aggregate.mjs:714-717`), which
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
`usage-aggregate.mjs:722` (`rowTokens = row.input + row.output + row.cacheRead +
row.cacheWrite`) and rolled into `totals.tokens` via `addTo`
(`usage-aggregate.mjs:631-640`). Rendered with `fmtTok()`
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
(`usage-parsers.mjs:949-965`, `input: Math.max(0, gross - cacheRead)`) because
Codex's own `input_tokens` field **includes** cached tokens and would
double-count them against the separately-reported `cacheRead` figure if left
as-is. This is asserted by test:
`tests/kit/usage-index.test.mjs:368-397` ("Codex tokens come from the LAST
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
(the `mergeIntervals` suite, `tests/kit/usage-index.test.mjs:105-146`, plus the
aggregate-level engaged-time tests, `tests/kit/usage-index.test.mjs:476-536`).

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
   exceeds `IDLE_GAP_MS` (15 minutes, `usage-parsers.mjs:24`), then union
   *those* sub-intervals — this is `engagedSeconds`.

**Source:**

- `mergeIntervals()` (`usage-aggregate.mjs:39-64`) — the pure union primitive,
  sorts intervals and merges any two that overlap **or exactly touch**
  (`s <= curEnd`, `usage-aggregate.mjs:55`), returning total covered seconds
  rounded to the nearest second.
- `activeIntervals()` (`usage-parsers.mjs:388-400`) — splits one session's
  sorted timestamp list into sub-intervals wherever a gap exceeds
  `IDLE_GAP_MS`; "a run of one timestamp yields a zero-length interval and so
  contributes nothing" (comment, `usage-parsers.mjs:382-387`).
- Aggregation: `totals.engagedSeconds = mergeIntervals(sessions.flatMap(s =>
  s._active))` (`usage-aggregate.mjs:1011`); `totals.spanUnionSeconds =
  mergeIntervals(sessions.map(s => s._span))` (`usage-aggregate.mjs:1010`);
  `totals.spanMinutes` is a running sum of `s._span[1] - s._span[0]` across
  the loop (`usage-aggregate.mjs:928`, finalized `usage-aggregate.mjs:1009`).
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
(`usage-parsers.mjs:581`/`usage-parsers.mjs:955` call `localDay(at)`) — so a
session that runs from 23:58 local to 00:05 local is billed to the day its
*first* row landed on (test:
`tests/kit/usage-index.test.mjs:653`, "a session that opens before midnight
is counted on its first billed day"). Accumulation:
`byDay[row.day].cost += rowCost` (`usage-aggregate.mjs:723-728`). Bar height:
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
(`byHost[s.host]`, populated via `addTo()`, `usage-aggregate.mjs:631-640`,
  called once per session at `usage-aggregate.mjs:930`), keyed by the literal string
`"claude"` or `"codex"` assigned at parse time
(`blankSession(id, 'claude')` / `blankSession(id, 'codex')`,
`usage-parsers.mjs:603`, `:984`, `parseClaude`/`parseCodex` entry points).
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

**Two identity maps, and the axis that is deliberately not one.** The aggregate
buckets window spend by two identities, and reading one as the other is the
mistake this split exists to prevent (`usage-aggregate.mjs:902`,
`usage-aggregate.mjs:930-931`):

- **`byHost`** — the execution host: which CLI wrote the transcript
  (`claude`, `codex`, `opencode`). This is what the two cards above render.
  It is a fact about the file's provenance on disk, and it proves nothing
  about which vendor served the tokens.
- **`byProvider`** — the inference-provider string **as recorded**, ungated:
  `s.provider ?? 'unknown'`. This map keeps its historical name and its
  historical shape for callers that want the raw string, whatever its
  evidence. A session that recorded no provider keys to `'unknown'`.

There is deliberately **no window bucket for the observed inference provider**.
Only the Codex parser sets `rec.inferenceProvider` and `rec.providerProvenance`
together (`usage-parsers.mjs:654-657`, `:663-665`); Claude and OpenCode
transcripts name no provider at all. A window axis over that evidence would put
most of its spend in a single unattributed row, which reads as a finding about
providers rather than what it is — an absence of provider evidence in two of the
three transcript formats. Provider identity is therefore reported per session,
on the session row, beside the provenance that backs it (§16).

**What this does not model:** a workflow that hands off between Claude and
Codex mid-task (e.g. `ak run`) produces two separate session records, one per
host, each aggregated under its own host rather than blended into one record.
That API-equivalent estimate is still not proof of which provider served either
execution.

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
(`usage-parsers.mjs:545-547`, keyed by `punchKey(at)`) and once per Codex
`agent_message` (`usage-parsers.mjs:846-851`), merged into the window-level
`punchcard` object per session (`usage-aggregate.mjs:948`). Cell intensity is
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

It also **includes responses from delegated subagent sessions** (§16.2), which
are machine-driven: a long agentic run dispatching subagents at 3am fills those
cells even though nobody was typing. The panel is titled `When you work`, and
what it actually charts is when *work happened on your behalf* — on the
reference corpus, Claude subagent responses (17,863) outnumber main-thread ones
(11,480). The `How you run` panel carries the main/subagent split; whether the
punchcard should filter or split by source is recorded as an open question in
ADR-0038's deferred list.

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
(`usage-aggregate.mjs:713-740`); the `sessions` count is deliberately computed
**separately**, once per session over its `s.models` array
(`usage-aggregate.mjs:859-866`) rather than inside the cost loop, precisely
**so that a model can appear in `byModel` — with a nonzero session count —
even in a session that contributed zero cost/tokens/responses for that
model.** This is not an edge case invented for this document: it is the
exact mechanism that makes the subagent-replay exclusion
([Appendix A](#appendix-a--fix-history)) safe — a model used only by an
excluded subagent-replay session still shows up as "used," at zero cost,
rather than vanishing.

`byModel[...].responses` is populated from `row.responses`
(`usage-aggregate.mjs:737`), which in turn comes from the `responses` field
passed into `addUsage()` at the call site — `1` per Claude assistant turn
(`usage-parsers.mjs:581`), or `rec.responses` (the session's whole response
count) once per Codex session, passed at the single point Codex calls
`addUsage` (`usage-parsers.mjs:865-871`).

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
(`usage-parsers.mjs:561-570`): the turn still increments `rec.responses`
and the punchcard (`usage-parsers.mjs:544-547`) — it *is* real engaged
time, someone was genuinely waiting on it — but it is never pushed into
`rec.models` and `addUsage()` is never called for it, so it can no longer
create a `byModel` row of any kind. It increments a separate
`rec.exceptions` counter instead (`usage-parsers.mjs:562`), rolled up into
`totals.exceptions` (`usage-aggregate.mjs:922`) and surfaced per-session
(`usage-aggregate.mjs:796-797`, alongside the existing `sidechain`/`threadSource`
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

**The code is the authority for a rate; this section is a reading of it.** The
Anthropic transcription in §13.1 matches `pricing.mjs:67-89` value for value.
The OpenAI transcription in §13.2 does **not** currently match
`pricing.mjs:112-124`, and the sourcing note there is likewise out of step with
the file's own comment. Price a row from `pricing.mjs`, not from §13.2's table,
until the two are reconciled.

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
  (`quota.mjs:209`) and TTL-cached (`CODEX_TTL_MS`, `:43`) by
  `collectCodexLimits` (`:264`). Lanes come from `rateLimitsByLimitId` in
  `normalizeCodexLimits` (`:145`), including per-model pools and
  rate-limit reset credits. A pool reported under both a named lane and the
  legacy generic `codex` lane — same duration, reset instant, and utilization —
  is kept once, on the named lane (`dedupeGenericLane`, `:127-137`).

**The primary/secondary trap.** Codex's `primary` window is *not* reliably the
5-hour window — a live `prolite` account reported `primary` with
`windowDurationMins: 10080` (the weekly). Windows are therefore keyed and
labelled by duration (`windowLabel`, `quota.mjs:51`), never by slot name. The
same rule applies to the historical snapshots parsed out of rollouts: the
normalizer at `usage-parsers.mjs:726-739` keeps a flat `windows` list keyed by
`window_minutes`.

**Freshness is part of the number.** Both sides carry `fetchedAt`; the view
renders "as of Nm ago" and a `stale` badge (Claude's tee is push-only, so it
ages the moment sessions stop). The `/api/limits` route lives in
`dashboard-server.mjs`; `renderLimits` and `limRow` in `dashboard/client.mjs`
render and color each bar by proximity to its cap.

**Limit-aware findings.** `detectLimitInsights` (`usage-insights.mjs:966`)
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
`applyCodexLedger` (`usage-aggregate.mjs:1233-1245`) overlays that onto parsed
sessions: a ledger-identified subagent has its token usage stripped — its
rollout replays the parent's entire token history (ccusage/ccusage#950
measured up to 91× inflation) — while the session record stays visible.
**The parser is primary, the ledger is the fallback**: `rec.threadSource ??
t?.threadSource ?? fromEdges` (`usage-aggregate.mjs:1243`) reads the rollout's
own `session_meta.thread_source` first, and only consults the ledger when
that line is missing entirely. This is sound because `thread_source` is now
the FIRST session_meta line's value (§1.2) rather than whichever meta
happened to be last — identity read off the rollout's own first-written line
is a fact about that specific file, while the ledger's coverage depends on
the Codex build (`state_N.sqlite` first shipped in ≥0.140) and which
migration generation its `N` reflects; a rollout the ledger cannot resolve
(an older Codex build, a migrated-beyond-recognition state file) still gets
a correct `threadSource` straight from its own transcript rather than
falling through unclassified. Codex sessions also carry
`reasoningOutput` (`usage-parsers.mjs:965`) — reasoning tokens are a **subset**
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
- [x] Permission posture keeps `not-recorded` as a first-class bucket —
  unmapped evidence is never folded into a real posture — and the inference
  provider gets no window bucket at all, because two of three transcript
  formats never record one (§8, §16).
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

**Displayed as:** the `Your rhythm` strip — two cards side by side. `session
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

- Edges: `LAT_BUCKET_EDGES` and `LEN_BUCKET_EDGES` (`usage-aggregate.mjs:186`, `:189`).
  The parsers carry their own copies (`usage-parsers.mjs:345`, `:348`) and the
  browser bundle a third pair (`LAT_EDGES`/`LEN_EDGES`), because the payload
  ships bucket *counts* and never the edges they were binned on.
- Slotting: `bucketIndex` (`usage-parsers.mjs:353-356`) — one definition of a
  boundary, shared by every histogram built on these edges.
- Sampling: `noteLatencySample` (`usage-parsers.mjs:362-367`) allocates
  `latHist` lazily, so a session that never observed a latency keeps
  `latHist: null` — absent, not a fabricated row of zeroes.
- Session length: `seal` derives each session's `lenSeconds` from its own
  active intervals (`usage-parsers.mjs:405-410`) — the §6 engaged figure for
  one session, never its first-to-last span.
- Window merge: `buildRhythm` (`usage-aggregate.mjs:1031-1051`) adds the
  per-session `latHist` slot-wise and buckets each session's `lenSeconds`.
- Percentiles: `percentileFromBuckets` (`usage-aggregate.mjs:215-232`). The
  browser re-implementation `bucketPercentile` (`usage-rhythm.mjs:106-126`) is
  pinned to byte-identical output, and the browser's edge copies to the server
  constants, by `tests/kit/dashboard-usage-telemetry.test.mjs:1217-1235` and
  `:1325-1331`.
- Render: `lengthCard`/`latencyCard` and the `≥` prefix helper `fmtAtLeast` in
  `src/lib/dashboard/client/usage.mjs` (that bundle shares a basename with the
  CLI command module, so its render sites are cited by function name rather
  than by line); the CLI's own `fmtAtLeast` is `src/commands/usage.mjs:175-178`
  and `printScoreRhythm` (`src/commands/usage.mjs:244-251`) prints the pair.

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
`if (i >= edges.length) return round(lo, 2)` (`usage-aggregate.mjs:226`).
A p95 printed as `≥60s` therefore means *at least 60 seconds* — the counts
cannot say whether the real figure is 61 seconds or 61 minutes, and printing a
bare `60s` would state a precision they do not carry. Both renderers apply the
prefix by the same rule (`v >= lastEdge`), so a value that reaches the last
edge by interpolation and one that came from the overflow slot print
identically — the two are the same claim. An empty histogram is `null`, never
`0` (`usage-aggregate.mjs:218`): "nothing was measured" and "measured zero" are
different statements and only the first is true, so the cards print
`not measured` and the CLI prints `no samples`.

**Per-host measurement — the same axis, not the same instrument.** The window
merges every host's samples into one histogram, but they are not gathered the
same way, and the panel says so rather than implying a single clock:

| Host | How a latency sample is produced |
|---|---|
| codex | **Host-measured.** `task_started` remembers the turn's start (`usage-parsers.mjs:767-772`) and `task_complete` samples Codex's own `duration_ms` (`usage-parsers.mjs:774-792`) — but only if no prompt-gap already covered that turn (so a turn is never sampled twice) and only within the same 3600 s cap the derived paths apply. |
| codex | Also derives a prompt-gap when one is available: a `user_message` opens the window (`usage-parsers.mjs:832`) and the next `agent_message` closes it, clearing `turnStartedAt` so the `duration_ms` fallback cannot double-fire (`usage-parsers.mjs:852-858`). |
| claude | **Derived from event gaps.** A human prompt sets `latState.pendingMs` (`usage-parsers.mjs:505`); the first real assistant turn closes that gap into a `noteLatencySample` call (`usage-parsers.mjs:572-576`). |
| opencode | Derived the same way from its message stream — `rec.pendingPromptMs`, closed by `noteLatencySample` (`usage-opencode.mjs:235-239`). |

**Every** path is capped: a sample above `MAX_LATENCY_SAMPLE_SECONDS`
(3600 s, `usage-parsers.mjs:373`) is an idle resume — the person walked away
and came back — not a wait for a reply, so it is dropped from sampling
entirely rather than parked in the overflow bucket beside genuinely slow turns.
That includes Codex's host-measured `duration_ms`. An earlier ruling exempted
it on the grounds that a host's own turn duration is a different kind of figure
from a gap between two events; that was overturned (ADR-0038 §2). `duration_ms`
is turn wall-clock and **includes time blocked on an approval prompt**, so a
turn left awaiting approval overnight arrives as a multi-hour "response
latency" — the same idle stretch the prompt-gap path discards. Measured on the
reference corpus before the fix: 12 of 835 durations exceeded the cap, the
largest 94,079,450 ms ≈ 26.1 hours, all of them landing in the `≥60s` overflow
bucket and dragging `latP95` into it.
An interrupted turn contributes nothing at all — `turn_aborted` clears both
pending states (`usage-parsers.mjs:895-903`), so a prompt that was never
answered can never be timed against a later, unrelated reply. A dropped API
turn is likewise never a sample: the error branch returns before the latency
block and deliberately leaves `pendingMs` set, so the first real completion
that eventually follows is what gets timed (`usage-parsers.mjs:561-570`).

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

- **it includes delegated subagent sessions and responses.** The panel is
  titled `Your rhythm`, but both histograms are built from every session in
  the window — and since nested Claude subagent transcripts began being
  ingested (§16.2), a substantial share of them are harness-driven rather than
  typed by you: on the reference corpus, 178 Claude subagent sessions / 17,863
  responses against 265 main sessions / 11,480. So subagent session lengths
  shape `session length`, and subagent turn gaps are a large part of
  `response latency`. Every number is true as computed; the label is what
  overclaims. The `How you run` panel carries the main/subagent split.
  (Prompt-based denominators are the exception — they use a main-thread-only
  denominator, because a subagent's prompts are written by the harness, §17.)
  Whether rhythm should instead *filter* to main-thread sessions, or show the
  two side by side, is recorded as an open question in ADR-0038's deferred
  list; it is a behavior change that needs its own ruling and tests, and
  disclosure is what ships here;
- the samples' exact values are gone once bucketed; a percentile is a linear
  interpolation inside one bucket, which is the only assumption the surviving
  counts support. A distribution that is heavily skewed *within* a bucket will
  read slightly off, and no amount of arithmetic here can recover it;
- host-measured and gap-derived samples share one histogram. That is a
  deliberate choice to keep one distribution rather than two thin ones, and it
  means a window dominated by one host is really reporting that host's
  instrument;
- the bucketing *function* is implemented twice: the parsers export
  `bucketIndex` (`usage-parsers.mjs:353-356`) and the aggregate keeps a private
  copy of the same loop (`usage-aggregate.mjs:196-199`), because the dependency
  between the two modules is deliberately one-way. The *edges* they run on are
  pinned equal by test — `AGG_LAT_EDGES` against `LAT_BUCKET_EDGES`
  (`tests/kit/usage-index.test.mjs:1952-1958`) — but the two function bodies
  are not, so a boundary rule changed in one and not the other would go
  unnoticed.

---

## 16. How you run

**Displayed as:** the `How you run` strip, subtitled `permission posture · who
drove`. Two panels: `posture, by day` (api-equivalent cost stacked by posture,
one column per day) and `main vs subagent` (a two-slice donut whose centre reads
the main-thread share). `ak usage score` prints the matching
`Mode — permission posture` table.

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
(`usage-aggregate.mjs:732`) — in the usage-row pass, because only a row knows
which day its dollars landed on. The window bucket is
`addTo(bucket(byMode, s.mode ?? 'not-recorded'), s)` (`usage-aggregate.mjs:934`).
The evidence each parser reads: Claude's `permissionMode`, off the human prompt
only (`usage-parsers.mjs:506-507`); Codex's `approval_policy`/`sandbox_policy`
off each `turn_context`, last one wins since a session may renegotiate mid-run
(`usage-parsers.mjs:697-702`); OpenCode's `mode` off each assistant message
(`usage-opencode.mjs:240-241`). Render is `modeChart` in
`src/lib/dashboard/client/usage.mjs`; the CLI table is `printScoreModeTable`
(`src/commands/usage.mjs:266-268`).

**The mapping table**, in full (`usage-modes.mjs:6-17`), pinned value-by-value
by `normalizeMode` assertions in `tests/kit/usage-modes.test.mjs:9-52`, and the
Codex arm pinned again end-to-end through `parseCodex` in the **real object
shape** (`tests/kit/usage-index-v6.test.mjs`, the five
`the object form of sandbox_policy` cases):

| Host | Recorded evidence | Mode |
|---|---|---|
| claude | `permissionMode: default` | `guarded` |
| claude | `permissionMode: acceptEdits` / `auto` / `dontAsk` | `auto-edit` |
| claude | `permissionMode: plan` | `plan` |
| claude | `permissionMode: bypassPermissions` | `unrestricted` |
| codex | sandbox `.type` `read-only`, whatever the approval policy | `plan` |
| codex | approval `never` + sandbox `.type` `danger-full-access` | `unrestricted` |
| codex | approval `never` + sandbox `.type` `workspace-write` | `auto-edit` |
| codex | approval `on-request` / `on-failure` / `untrusted` | `guarded` |
| opencode | `build` | `auto-edit` |
| opencode | `plan` | `plan` |
| any | anything else, or no evidence at all | `null` → `not-recorded` |

**Codex writes `sandbox_policy` as an object, and the parser extracts its
`.type` before consulting that table.** The rollout carries
`"sandbox_policy":{"type":"danger-full-access"}` — or `{"type":"read-only"}`,
or `{"type":"workspace-write", …}` with sibling fields such as
`network_access` — never the bare string the taxonomy is written against. A
survey of this machine's rollouts (400 files, 2026-08-28) found 1,110 object
occurrences and **zero** string ones. `handleCodexTurnContext`
(`usage-parsers.mjs:703-716`) therefore reads `sandbox_policy.type` and passes
that to `normalizeMode`, which is unchanged and still accepts the string form.
Before this extraction the object reached `normalizeMode` intact, matched no
rule, and stringified into `modeRaw` as `"never/[object Object]"`: the `plan`,
`auto-edit` and `unrestricted` rows of the Codex arm below could not fire at
all on live data, only the approval-only `guarded` rule could, and
`detectUnrestrictedMode` (§18) was blind to Codex's most permissive posture.
An object carrying no `.type` yields no sandbox evidence rather than a guess.
Cached records from before the fix re-derive on the schema v12 bump (§1).

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
(`usage-parsers.mjs:198`) precisely because the mapping is a judgement call and
a reader checking it needs the evidence it was made from. `not-recorded` is a
first-class bucket key rather than a display fallback
(`usage-aggregate.mjs:933-935`), it is always offered as a row by the CLI table
even at zero (`printBucketTable`, `src/commands/usage.mjs:225-232`), and
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

**Source:** `sourceKey` (`usage-aggregate.mjs:881-883`). Both rows are created
before the fold (`usage-aggregate.mjs:913`) so "no subagent sessions" renders
as a zero rather than a row the UI silently drops. Claude's evidence is the
`isSidechain` flag on any entry in the file (`usage-parsers.mjs:616`, decoded at
`telemetry-records.mjs:244`); Codex's is the ledger-backed `thread_source`
(§13c). Render is `sourceDonut` in `src/lib/dashboard/client/usage.mjs`.

**The two hosts reach the `subagent` row by different routes, and only one of
them arrives at `$0`.** They are worth reading apart, because the same donut
slice is telling two different truths at once.

**Claude — real, priced, included.** A session's delegated work is written to
its own transcript under `<project>/<sessionId>/subagents/`, and those files are
discovered by `listClaudeSubagents` (`usage-index.mjs:312-317`, §1) and parsed
like any other. `parseClaude` already prices those bytes and marks the record
`sidechain` from its own `isSidechain` entries, so the cost is real, is included
in `totals.cost`, and the session opens in the Sessions tab like a main-thread
one. A `$0` Claude subagent slice would mean no delegated work in the window,
not delegated work that was free.

**Codex — structurally `$0`, by ledger design.** A ledger-identified subagent
has its usage rows removed outright (`applyCodexLedger`,
`usage-aggregate.mjs:1240-1243`) and `finalizeCodexUsage` never writes one in the
first place (`usage-parsers.mjs:949`), because a subagent rollout replays its
parent's entire cumulative token history and keeping it would bill the parent
twice (§13c, **[C7]**). The record stays visible and auditable; its cost is zero
because nothing was measured for it, not because the work was cheap — which is
also why §17 keeps such sessions out of the cost-per-session distribution.

**Worked example**, one machine's own 14-day window — every figure below taken
from a single aggregate generated 2026-08-29T00:00Z, so the parts add up. It is
one corpus, so the *shape* is the point, not the totals:

| Source | Host | Sessions | Api-equivalent cost | Responses |
|---|---|---|---|---|
| subagent | claude | 178 | $2,376.13 | 17,863 |
| subagent | codex | 156 | $0.00 | 1,356 |
| main | claude | 265 | $2,904.54 | 11,480 |
| main | codex | 682 | $802.97 | 56,543 |

`bySource` therefore reads `main` 947 sessions / $3,707.50 and `subagent` **334
sessions / $2,376.13**, which sum exactly to the window's $6,083.63 across 1,281
sessions. Delegated work is **39.1% of the window's cost, and every dollar of it
is Claude's.** The Codex row is the honest zero described above: 156 sessions and
1,356 responses are visible, and their cost is `$0.00` because their tokens were
stripped as a double-count. Both rows exist because both are pre-created before
the fold; neither is a row the UI invented. (The four host rows are each rounded
to the cent independently, so reading them as a column sums a cent high against
`bySource` — the buckets, not the display, are what the totals are built from.)

That a `subagent` slice is non-zero at all rests on one property of the store:
Claude writes a sidechain session to its **own** file. Measured over the 200
most recently modified local Claude transcripts on 2026-08-28, 50 files were
sidechain-only (6,924 assistant turns), 150 were main-only (2,738 turns), and
**none mixed the two** — which is what makes "any `isSidechain` entry marks the
whole record" safe, since there is no parent's spend in the file to mis-attribute.

**What §16 does not model:** who served the tokens. There is no window bucket
for the inference provider — §8 says why: two of the three transcript formats
record no provider at all, so an aggregate axis over that evidence would read
as a claim about providers rather than as the absence it is. A session's
provider and the provenance backing it stay on its own row in the Sessions
detail strip. Posture is likewise the last evidence a session recorded,
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
four under `Cadence`.

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

**Source:** the derived block is `finishTotals` (`usage-aggregate.mjs:1006-1024`),
which the previous-window projection calls too so a baseline is never derived a
second, drifting way. `median` and `percentile` are exact over the values
(`usage-aggregate.mjs:964-969`, `:974-979`), unlike §15's bucketed percentiles.
Active days come from `byDay`'s key count and the streak from `activeStreak` in
`src/lib/dashboard/client/usage.mjs`; the tiles are `cadenceCells` there, and
`printScoreCadence` (`src/commands/usage.mjs:187-211`) in the CLI.

**Autonomy divides by prompts a human typed, and only those.** The denominator
is `totals.humanPrompts`, accumulated under an explicit main-thread guard
(`usage-aggregate.mjs:921`): a subagent's prompts are written by the harness,
so counting them would report a person as having typed work nobody asked for by
hand — and would grow the denominator exactly in the windows where delegation
was heaviest, making autonomy fall as automation rose. `totals.prompts` still
records every prompt beside it (`usage-aggregate.mjs:917`); the two are
different questions and both are on the wire. Touch rate is those same human
prompts per engaged hour (`usage-aggregate.mjs:1014`), so both per-prompt figures
share one denominator. A rate whose denominator is zero is `null`, never `0`
— no engaged time means the rate was never measured, which is not what "zero
per hour" claims.

**Sessions per active day counts delegated subagent sessions too, and an
"active day" is a day that BILLED.** The numerator is every session in the
window, harness-dispatched subagent transcripts included (§16.2) — on the
reference corpus those are roughly a quarter of all sessions — so this is the
run rate of the whole system working on your behalf, not a count of times you
sat down. The `How you run` panel carries the main/subagent split. The
denominator is `byDay`'s key count, and `byDay`'s presence contract is
**days that billed tokens** — which is why the aggregate keeps a separate
`engagedByDay` map (§6): the two sets genuinely differ (a session running past
midnight, a day spent reading, a day worked entirely in stripped Codex
subagent sessions that billed nothing). A day worked but never billed is not
an active day here, and it breaks the streak. Both surfaces say so: the
browser in the tile's tooltip, `ak usage score` inline, since a terminal
reader has nothing to hover.

**Cost per session is a median over priced sessions only.** A session carries
`_priced` when it had any usage rows at all (`usage-aggregate.mjs:826`), and
only those costs enter the distribution (`usage-aggregate.mjs:927`). A session
with no usage rows costs `$0` *structurally* — nothing was ever measured for it,
the common case being a Codex subagent rollout whose tokens were stripped as a
double-count (§16.2) — and letting those in would report "the typical session
cost nothing" when the truth is "the typical session was not measured". The
median rather than the mean because session cost is heavy-tailed: one 12-hour
refactor can outweigh forty short sessions, and a mean would describe that one
session rather than the run of them. P90 rides beside it precisely so the tail
stays visible instead of being hidden by the choice of a robust centre. A
positive figure that rounds away at two decimals prints `<$0.01`, never
`$0.00` (`fmtUsdMin`, `src/commands/usage.mjs:128-132`) — "less than a cent" and
"nothing" are different claims.

**What the cache saved, asked as a difference.** `cacheSavingPerMillion`
(`usage-aggregate.mjs:691-700`) prices one million tokens twice through the
*injected* pricer — once as fresh input, once as cache reads — and takes the
gap; `cacheSavedFor` (`usage-aggregate.mjs:704-707`) scales that to the tokens
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
(`usage-aggregate.mjs:926`), carried on each session row as `cacheSavedUsd`
(`usage-aggregate.mjs:804`) so it is auditable a row at a time rather than only
in aggregate, and rendered in the cache tile's subtitle as `saved ≈ $X vs
uncached`.

**Deltas: what "the previous window" is, exactly.** For a displayed window of
`d` days ending at `now`, the baseline is the equal-length window immediately
before it — the half-open interval `[now − 2d, now − d)`
(`previousWindow`, `usage-aggregate.mjs:1113-1123`). Both bounds are derived from
`now` and `d`, the window the UI is *showing*, and never from the parse cutoff:
the caller widens that cutoff on purpose so older records survive to be
aggregated here, and deriving the baseline from a widened bound would silently
stretch it to whatever lookback the caller happened to pass. The dashboard route widens it to
the depth the personal tap-share baseline needs rather than to the previous
window alone: `days + BASELINE_TRAILING_DAYS` (`lookbackDays`,
`src/lib/dashboard-server.mjs:1437`); `ak usage score` applies the same rule
(`src/commands/usage.mjs:349`). One extra window would be a strict
subset — too shallow for `promptBaselines`, which needs
BASELINE_MIN_ACTIVE_DAYS of history BEFORE the displayed window and returns
null without it — while this depth is a strict superset of the previous window
at every supported width. A delta against an unknown-length window is not a delta. The upper bound
is exclusive so a session ending exactly at the boundary belongs to the current
window and is not counted in both (`usage-aggregate.mjs:846`). Asking for
`previous` without widening the lookback yields an all-zero baseline — the
older records were never read off disk — and every chip self-suppresses
against it rather than claiming a change it cannot measure. Leaving `previous`
off entirely leaves `agg.previous` as `null` — "not requested",
which a zeroed totals object would misreport as "measured nothing"
(`usage-aggregate.mjs:1213`). A chip self-suppresses when the baseline is null
or zero, and a magnitude that rounds to zero prints flat rather than drawing an
arrow the printed number does not support (`deltaChip`,
`usage-rhythm.mjs:36-53`; `fmtDelta`, `src/commands/usage.mjs:184-196`).

**Engaged time by day is a sibling map, not a `byDay` field.** `byDay`'s
presence contract is **billed days only** — a key exists exactly when tokens
landed on that day (`dayBucket`, `usage-aggregate.mjs:653-666`) — and that is
what the active-day count and the streak above are counted from. Engaged time
does not share that key set: a session that runs past midnight, or a day spent
reading, produces worked time on a day that billed nothing. So
`buildEngagedByDay` (`usage-aggregate.mjs:1087-1095`) keys its own map, cutting
each active interval at every local midnight it crosses
(`splitAtLocalMidnight`, `usage-aggregate.mjs:1065-1073`) and unioning the pieces
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

**Displayed as:** the `Reliability` strip, subtitled `turns that never landed`.
Two stats — `exceptions / 1k responses` (subtitle `N of M responses`, plus a
worded flag comparing it to the previous window) and `aborted turns` (subtitle
`X per 1k codex responses`, or an em dash when the window holds no Codex
session) — over an `exceptions by day` sparkline that names the single worst
day. `ak usage score` prints both under its
`Reliability — turns that never landed` heading, colouring the exception
line by whether any fired.

**Formula:**

```text
exceptionRate = totals.exceptions / totals.responses × 1000     null when no responses
abortRate     = totals.aborts / byHost.codex.responses × 1000   — and the count
                itself is shown only when byHost.codex.sessions > 0
byDay[day].exceptions += session.exceptions   attributed to the session's FIRST BILLED day
```

**Source:** `totals.exceptions` and `totals.aborts` accumulate together at
`usage-aggregate.mjs:922`; the per-day series lands on `byDay[s._day].exceptions`
(`usage-aggregate.mjs:943-946`). Render is
`relRate`/`relStat`/`relTrend` in `src/lib/dashboard/client/usage.mjs`;
`printScoreReliability` (`src/commands/usage.mjs:238-264`) prints the CLI pair.

**Evidence, per host.** An "exception" is a turn that never resolved to a
model, and each host signals that differently:

| Host | What is counted, and where |
|---|---|
| claude | The API-error placeholder — Claude Code synthesizes a local turn with no completion behind it when a connection drops, a rate limit rejects, or auth fails. The decoder sets `isApiError` from either `isApiErrorMessage` or the literal `<synthetic>` model marker (`telemetry-records.mjs:246`), because the flag is not set on every build that emits the placeholder; the parser counts it and returns before any model or usage attribution (`usage-parsers.mjs:561-570`). |
| codex | A `task_complete` event carrying a non-null `error` (`usage-parsers.mjs:791`). |
| codex | `turn_aborted` is counted **separately**, into `rec.aborts` (`usage-parsers.mjs:895-903`) — not into exceptions. |
| opencode | An assistant message carrying a non-null `error` (`usage-opencode.mjs:232-234`). |

**Aborts are held apart from exceptions on purpose.** An aborted turn is a
person pressing stop; an exception is the turn failing. Summing them would
report a deliberate interruption as a reliability problem and move a number
that is supposed to mean "how often did this break". They are counted, carried
(`aborts`, `usage-aggregate.mjs:779`) and displayed side by side, with the
distinction stated on the tile rather than left to the label.

**Aborts are CODEX-ONLY evidence, and both surfaces say so.** `turn_aborted` is
the only interrupt signal any transcript store writes: Claude Code and OpenCode
record nothing when you stop a turn (see the capability matrix in
`TRANSCRIPTS.md`). The field therefore defaults to `0` for those hosts, and a
plain `0` on the tile would read as a measurement — "you never interrupted a
turn" — when the truth is that nothing in the window could have recorded one.
So the count is rendered only when the window contains at least one Codex
session, and otherwise reads `—` with the reason beside it; the rate divides by
**Codex** responses, because dividing Codex aborts by every host's responses
dilutes the figure by an arbitrary amount that depends on host mix. The same
rule applies per row in the session detail strip, where a claude/opencode row
reads `aborts not recorded for this host`. This is the same absent-is-not-zero
treatment `latHist` (§15) and the context chip (§16) already get.

**Exceptions ride the session's first-billed day.** The per-day series uses the
same attribution as the session count — `byDay[s._day].exceptions += s.exceptions`
(`usage-aggregate.mjs:943-946`) — which is *not* the moment a turn dropped: a session spanning midnight lands all of its
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
the error branch returns, `usage-parsers.mjs:544`) — they were real engaged
time, someone was genuinely waiting on them. A retry that eventually succeeded
appears as one exception plus one successful response, not as a single
recovered turn; nothing in either transcript links the two. And the worst-day
flag names the day with the most exceptions without inventing a threshold for
what counts as a spike, because any constant chosen here would be a judgement
the data never made.

---

## 19. Tool mix & model families

**Displayed as:** two panels. `Tool mix` (`invocations · top 8, tail folded`)
is a ranked row list of tool names by invocation count, with a dimmed
`Other (N tools)` row folding the tail. `Model mix over time`
(`api-equivalent cost by model family`) is a per-day stacked bar of cost by
coarse model family, top four families coloured and the rest folded into a
de-emphasised `other` band.

**Formula:**

```text
byTool[name]                  += session.tools[name]      summed across sessions
byDay[day].byModelFamily[fam] += rowCost                  fam = modelFamily(row.model)
```

**Source:** the tool tally is folded into `byTool` at `usage-aggregate.mjs:949`;
the per-day family split is `addCost(d.byModelFamily, modelFamily(row.model),
rowCost)` (`usage-aggregate.mjs:733`), inside the usage-row pass because only a
row knows its day. Render is `toolRows`/`modelMix` in
`src/lib/dashboard/client/usage.mjs`.

**Tool names are the host's own, never renamed.** Claude's tally is keyed by
the `tool_use` block's own `name` (`collectClaudeToolNames`,
`usage-parsers.mjs:528-537`). Codex's four tallied item types —
`CommandExecution`, `McpToolCall`, `FileChange`, `CollabAgentToolCall`
(`CODEX_TOOL_ITEM_TYPES`, `usage-parsers.mjs:885`, tallied at `:916-917`) —
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
(`usage-aggregate.mjs:246-253`) lowercases the id, keeps only the segment after
the last `/` so a namespaced id still ends on the same tokens, then:

| Rule | Example id | Family |
|---|---|---|
| contains an Anthropic family name (`CLAUDE_FAMILIES`, `usage-aggregate.mjs:238`) | `claude-opus-5-20260401` | `opus` |
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

## 20. Prompt patterns (`ak usage prompts`)

**Displayed as:** a terminal-only report in six sections — `Typed prompts`
(count, provenance split, questions, persona openers), `Supervision taps`
(count, share, and a by-token-length table), `Host interplay` (per-host typed /
taps / tap share / p90 typed tokens / personas / the operator's own trailing
p75, then a per-host monthly tap-share series), `Recurring clusters`,
`Re-asks`, and `Headless share`. `--deep` appends four exemplar tables that
carry verbatim prompt text. `--json` emits the same numbers; `--deep --json`
adds an `exemplars` key that **contains prompt text**.

**Formula:**

```text
typedShare      = |{fp : fp.p = 'human'}| / |fingerprints|
tapLength[t]    = |{fp : fp.p = 'human' ∧ fp.t = t}|             for t ≤ TAP_MAX_TOKENS
monthTap[h][m]  = Σ promptStatsByDay[d].byHost[h].taps / Σ …typed   over d in month m
clusters        = crossSessionClusters(nearDupClusters(typed, J ≥ 0.6))
reAsks          = reAskPairs(typed, J ≥ 0.8, window ≤ 6 turns)
headlessShare   = Σ responses[typedPrompts = 0] / Σ responses[typedPrompts ≠ null]
```

**Source:** the repetition half of this report is not computed by the CLI at
all. `aggregate(records, { prompts: true })` builds `agg.promptPatterns`
(`buildPromptPatterns`, `usage-aggregate.mjs:570`) from the same records
`buildPromptBaselines` reads, and `ak usage prompts` renders it — so this
command and the dashboard's Prompts view cannot disagree about what a cluster
is. Raw fingerprints have no public accessor: the layer is 2.8 MB on the
reference corpus, and only aggregates ship, plus at most three session ids per
cluster as a link into the masked session surface.

`decoratePromptFP` (`usage-aggregate.mjs:474`) is the single place the
decoration semantics live — session id, first-billed day, host, and the
question/persona flags mapped to ALWAYS-SET booleans. That mapping is
load-bearing twice: the scan path stores them as the number 1 and omits them
when false, while the clustering library reads `=== true` / `=== false` and
treats absent as unclassified, so `1 !== true` made every cluster report
`unknown` and a never-written `false` left the `instruction` class unreachable.
Thresholds are named exports beside it — `PROMPT_CLUSTER_JACCARD`
(`usage-aggregate.mjs:437`) and `PROMPT_REASK_JACCARD` (`:442`) — so the panel,
the CLI captions and the arithmetic quote one number each.

The projection is OPT-IN and `null` when not requested, the same shape
`previous` uses. `usage-index.mjs` forwards the flag (`:728`) and folds it into
`scanKey` (`:501`), which decides both the single-flight identity and
readIndex's memo — without the fold a `{prompts:true}` caller inside the memo
TTL would be served an answer built without the projection.

The CLI adds the window (`ALL_WINDOW_DAYS`, `src/commands/usage.mjs:393` — 365
days, all the index can hold, since `KEEP_MS` prunes a cache entry at 366), the
per-host and monthly folds off `promptsByHost` / `promptStatsByDay`
(`monthlyTapShare`, `:490`), and the headless share, which is a property of the
session rows rather than of the prompts (`headlessShare`, `:643`).

The deep pass is the one tier that reads the index cache directly
(`readPromptEntries`, `src/commands/usage.mjs:739`): it needs the HASHES it owes
an exemplar for and the transcript PATH of a session holding one, and the cache
is the only place both exist together. That coupling is confined to this
text-bearing, CLI-only tier — a pass about to open the transcripts and print
what was typed already has strictly more access than a fingerprint. It re-reads
through the same per-host parsers the scan path uses (`reReadTurns`, `:809`) and
re-derives each turn's hash under the scan path's own two gates —
`kind === 'prompt'` and `provenanceOf` on the same text (`humanPromptTurns`,
`:794`) — which is what makes the join exact. `exemplarCandidates` (`:876`)
orders sessions by how many wanted exemplars each covers and `collectExemplars`
(`:913`) opens them only while something is unresolved, falling through to a
smaller sibling transcript when one is past `MAX_DEEP_FILE_BYTES` (`:723`).

**Worked example:** on the reference corpus at the all-history window, 5,684
fingerprinted prompt turns carry 2,656 tagged `human` — a typed share of 46.7%
— of which 322 run to `TAP_MAX_TOKENS` (4) tokens or fewer, a 12.1% tap share.
Per host that is 11.6% on Claude against 12.3% on Codex, and the monthly series
separates them: Claude 14.6% → 10.9% across 2026-07 → 2026-08 while Codex runs
7.7% → 15.5%. A `--deep` run over the same corpus opened 51 transcripts in
0.6 s and resolved 61 of the 62 exemplars it wanted; the one it did not, and
why, is printed rather than left blank.

**What this does not model:**

- **The typed share here is not the research's 27.6%.** That figure was
  measured over every parser-visible user-role turn; a fingerprint exists only
  for a turn the parsers already classed `kind: 'prompt'`, so this denominator
  excludes tool results and harness envelopes before the provenance split even
  runs. The two answer different questions and must not be compared.
- **Provenance error is one-directional by design** (spec §2.1): an
  unrecognized machine template counts as `human`, so the typed figure is an
  over-statement, never an under-statement.
- **The personal baseline is `n/a` at the all-history window**, not zero and not
  missing: a trailing 90-day baseline needs a window before the displayed one,
  and all history has none. At a bounded window it is still `null` until the
  corpus carries `BASELINE_MIN_ACTIVE_DAYS` (30) days of typed prompts in that
  trailing span — measured here, this machine has 22 before a 7-day report
  (16 before a 14-day one, and 1 Claude / 6 Codex before a 30-day one), so the
  honest answer is that there is not yet a personal normal to compare against.
- **Cluster names are provisional.** A seed is a shape predicate, not a
  reading of the text, so two different clusters can resolve to the same seed
  name; `source` on each row says whether the name came from a seed or from
  `characterize`, and a characterized row asserts only what its own counts say.
- **`--deep` prints whatever was typed.** Exemplars are run through
  `maskSecrets`, which catches key-shaped strings and not everything a person
  might have pasted — an address or a file path typed into a prompt is printed
  as typed. It is opt-in for that reason, it writes nothing, and with `--json`
  the text is in the payload.
- **The deep pass cost is measured, not estimated.** The header states the
  transcripts opened and the wall time for that run; another corpus will differ.
- **A cluster exemplar is the member its `key` names**, which is the
  lexicographically smallest hash in the cluster — a real member, stable across
  scans, and reachable without a membership list. It is not necessarily the
  most frequent phrasing, which is the cost of not re-running the clustering
  the projection already did.
- **The projection is opt-in because it is not free.** Measured on the
  reference corpus against a ~90 ms warm scan: +199 ms at 14 days (145
  clusters), +616 ms at 30 (483), +901 ms over all history (561).

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
(`usage-parsers.mjs:581`, the current equivalent), but Codex's call
passed no such field at all. Because `byModel[model].responses` is summed
directly from each usage row's `responses` field (`usage-aggregate.mjs:737`,
`m.responses += row.responses`), **every** Codex model in §10's "Models in
Play" list displayed `0 resp` regardless of real token/cost volume or actual
`agent_message` count. **Fix:** `parseCodex` now passes `responses:
rec.responses` (the session's own tallied response count,
`usage-parsers.mjs:870`) on its `addUsage()` call.

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
when its value is `'subagent'` — `finalizeCodexUsage` returns early on
`if (!lastUsage || rec.threadSource === 'subagent')`
(`usage-parsers.mjs:861`). The session record itself is **not**
dropped — it remains visible in the Sessions tab with `threadSource`
surfaced (mirroring the existing `sidechain` flag Claude sessions already
carry, `usage-parsers.mjs:616`), so a maintainer auditing the raw data can
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
  fresh parse. `SCHEMA_VERSION` went to `4` specifically to force the one-time
  re-parse; the constant now reads `16` (`usage-index.mjs:141`), each bump since
  having forced its own re-parse the same way.
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
