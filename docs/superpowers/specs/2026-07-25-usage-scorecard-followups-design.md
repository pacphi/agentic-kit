# Design — usage scorecard follow-ups (ADR-0009)

- **Date:** 2026-07-25
- **Status:** Approved, not yet implemented
- **Source:** [`docs/archive/2026-07-25-usage-scorecard-followups.md`](../../archive/2026-07-25-usage-scorecard-followups.md)
- **Governs:** [ADR-0009](../../adr/0009-usage-scorecard-local-transcript-analytics.md) §4, §4b, §5, §6

## Context

PR #56 (`dce1dc0`) shipped the Usage tab. Two QE reviews found five items that were
deliberately deferred rather than quietly dropped. Four are "computed, shipped, and
rendered nowhere"; the fifth is a coverage gap explicitly declared not-reached.

The unifying failure they describe is the one ADR-0009 exists to prevent: **the panel
knows something the reader cannot see.** A truncated turn that looks complete, a
classifier `basis` that justifies a category no one can inspect, a worktree that
distinguishes two rows that render identically — each is a small honesty debt in a
feature whose entire premise is graded evidence.

Every fix below is therefore a *surfacing* decision, not a new capability. No new
routes, no new fetches, no new data sources. Item 4 is a test, not a feature.

### Constraints inherited from ADR-0009

These are not up for renegotiation in this work:

- **§4** — `engagedSeconds ≤ spanUnionSeconds ≤ spanMinutes×60` is an asserted invariant,
  and `engagedSeconds` leads the UI. No change may promote a looser tier to the headline.
- **§4b** — project is the repo; worktree is kept separately because "which repo" and
  "which branch of it" are different questions.
- **§5** — classifier confidence is *displayed, not hidden*, and `Unclassified` is a
  first-class outcome.
- **§6** — a finding claims a dollar figure only when it can compute one. By extension,
  no element added here may state a quantity it did not measure.
- **§8** — transcripts are masked server-side; nothing added here may widen that surface.

## Decisions

### 1. `spanUnionSeconds` is retained and surfaced as a tooltip

**Chosen:** keep the field in `totals`; expose all three tiers in a `title=` on the
engaged-time KPI. The visible KPI is unchanged from what shipped.

**Rejected:** promoting the middle tier into the visible sub-line (costs a second line
of density on the hero row for a figure that is explicitly *not* the honest one), and
deleting the field (the invariant is the argument for why 7.2 h/day is trustworthy;
deleting its middle term makes the argument uncheckable from the running panel).

**Honest accounting:** hover is a weak channel. A tooltip is discoverable by accident at
best, and not at all on touch. This is accepted because the ladder is *supporting
evidence for a headline figure*, not a figure in its own right — the reader who never
hovers is not misled, only less informed. ADR §4 will record this trade-off in those
terms rather than implying the tier is prominently displayed.

**Where:** `dashboard-server.mjs:1821` (`kpi()`) and `:1839` (the engaged-time card).

`kpi(k, v, d, cls)` gains a fifth optional parameter `titleTxt`. When present it is
escaped and emitted as `title=` on the outer `.kpi` div — the whole card is the hover
target, not just the number.

Tooltip text, assembled from `totals`:

```text
engaged 100.7h ≤ open 230.8h ≤ summed 296.4h
engaged unions active sub-intervals split at 15-min silences;
open unions whole session spans; summed double-counts overlap.
```

The three figures are formatted with the existing `fmtHours()`. The prose half is a
constant. No figure in the tooltip is computed anywhere but from `totals`.

### 2. Turn truncation is announced, with both figures

**Chosen:** `usage-index.mjs` emits `originalChars` on truncated turns only; the
transcript turn header renders a badge stating how much of the turn is shown.

**Rejected:** a boolean-only badge ("truncated"). A reader who cannot tell 1% loss from
90% loss has been told that something is missing and nothing about whether it matters —
which is the shape of an evidence claim ADR §6 would refuse from a finding.

**Where — producer:** `usage-index.mjs:1051-1058`.

The slice at `:1055` currently discards `text.length`. It will be captured before the
slice and emitted alongside the existing flag:

- `truncated: true` and `originalChars: <int>` on turns exceeding `MAX_TURN_CHARS`.
- Neither key present on turns that were not truncated.

Emitting `originalChars` **only when truncated** makes the field's presence itself the
signal, so a consumer cannot misread a full-length turn as a truncated one. `truncated`
stays for backward compatibility with any cached payload.

`maskSecrets` runs *before* the length is taken (it already does, at `:1052`), so
`originalChars` is the length of the **masked** text. This is deliberate: it describes
what was withheld from the reader by *truncation*, not by masking, and masking is
already marked separately by `markRedactions`. The ADR note will say so — the number
must not be read as a raw-file length.

**Where — renderer:** `dashboard-server.mjs:2062` (the `meta` span in `renderTranscript`).

The `t-who` line renders, in order: the truncation badge (when present), then the
existing output-token count. Badge text uses the existing `fmtTok()` magnitude
formatter, which handles plain counts correctly (`40000 → "40.0K"`):

```text
you                    truncated · 40.0K of 128.4K · 84K out
```

The badge carries a `title=` with exact figures via `fmtNum()`
(`"40,000 of 128,412 characters shown; the rest was not sent to this page"`).

**Styling:** a new `.t-trunc` class in the `.masked` family — same "content was
withheld" vocabulary, muted rather than alarming. It is not an error state; truncation
is a designed limit.

### 3 + 5. A row expander carries the ten dark fields; worktree also gets a row chip

**Chosen:** a caret button in a new leading column of `.srow` toggles a detail strip
rendered from data already in the payload. Worktree *additionally* renders as a chip in
the title cell.

**Rejected:** folding the fields into the Transcript header (forces a reader to leave
the list to learn why a session was categorised — the comparison across sessions is the
question the Sessions view exists to answer); inverting the row gesture so row-click
expands (silently changes shipped behaviour); making the category chip the affordance
(it under-promises — nine of the ten fields have nothing to do with the category);
trimming the fields from the wire (would make `basis` uninspectable, contradicting §5).

**No new route, no new fetch.** All ten fields are already present on every
`projectTree[].rows` entry and every `/api/sessions` row. The expander is pure
client-side rendering of data the browser already holds. This is the whole reason the
"use them" branch is cheap.

**Where — layout:** `dashboard-server.mjs:1185` and the `≤560px` breakpoint at `:1243`.

```text
.srow  18px 58px minmax(150px,2.1fr) minmax(90px,1fr) 106px 46px 60px 62px 68px 20px
       ^^^^ new caret column
≤560px 18px 58px 1fr 68px 20px
       ^^^^ must be updated too — it currently drops to four columns
```

Forgetting the breakpoint is the specific way this change breaks: the desktop grid
would gain a column the mobile grid does not, silently shifting every mobile cell by
one. The plan must test both widths.

**Where — markup:** `dashboard-server.mjs:1964` (`sessionRow`).

- Leading `<button class="s-exp" type="button" aria-expanded="false" aria-controls="sd-<id>">›</button>`,
  where `<id>` is the session id — already validated against the closed alphabet
  `[A-Za-z0-9._-]{1,128}` by `parseSessionId`, so it is safe as a DOM id and unique
  within the page. A real button, so it is keyboard-reachable and screen-reader
  announced; the chevron rotates on expand, matching the existing `.phead .chev` idiom.
- Worktree chip inside the title cell, after the title text, rendered **only** when
  `sx.worktree` is non-null (~4% of sessions): `<span class="s-wt">⑂name</span>`.
- A sibling `<div class="sdetail" id="sd-<id>" hidden>` after each row — a block-level
  sibling inside `.pbody`, not a grid child of `.srow`, so it spans the full row width
  without participating in the column layout.

**Where — behaviour:** the panel click delegate at `dashboard-server.mjs:2096`.

The caret handler calls `stopPropagation()` before toggling, so the row's existing
click-to-open-transcript path is untouched. Expansion state is per-row and ephemeral —
it does not persist across a poll refresh or a view change, and is not part of the URL
hash. Deep-linking an expanded row is out of scope.

**Detail strip contents** — five labelled lines, in this order:

| Line | Fields | Rendering |
|---|---|---|
| `basis` | `basis`, `confidence` | Verbatim string + `(conf 0.82)`. `Unclassified` sessions show their basis too — usually `no signal` — rather than being blanked. |
| `models` | `models[]` | Comma-joined. Empty array renders `—`. |
| `tokens` | `input`, `output`, `cacheRead`, `cacheWrite` | `in 1.2M · out 84K · cache r 480M / w 14M`, via `fmtTok()`. |
| `tools` | `tools` | Object of `{name: count}`. Sorted by count desc, top 6, `name N` each. Empty renders `—`. |
| `flags` | `skill`, `plugin`, `sidechain`, `worktree` | `skill — · plugin — · sidechain no · worktree phase-1`. Nulls render `—`, never omitted, so the absence of a signal is itself visible. |

`basis` is a **string** contract. The expander renders it directly into the DOM through
`esc()`. If `classify()` ever returns an object there, the strip renders
`[object Object]` — the exact bug class the project-tree category chips already hit.
Decision 4 exists to make that impossible to ship unnoticed.

**Payload delta:** the ten fields are kept, so the follow-up's "measure the payload
delta either way" is answered by measuring what they cost and recording the figure in
ADR §5 — bytes for `/api/usage` and for a representative `/api/sessions` response, on
the reference corpus, with and without the fields.

### 4. A contract test runs the real modules through the `deps` seam

**Chosen:** a test in `tests/kit/` that imports the real `pricing.mjs`,
`usage-classify.mjs`, and `usage-insights.mjs`, injects them through
`usage-index.mjs`'s `deps` seam over a fixture corpus, and asserts the shapes the
production renderers depend on.

Today every `usage-index` test passes doubles. Nobody has executed the seam with both
sides real, so "two sides agreed on a shape neither executed" is currently the state of
the code — the same condition that produced the `[object Object]` chips.

**Assertions, at minimum:**

- `classify()` returns `{category: string, confidence: number, basis: string}`;
  `basis` is asserted to be a **string primitive**, not merely truthy.
- `costOf()` returns a finite non-negative number for every model id the fixture emits,
  including at least one model absent from the rate table.
- `detectInsights()` returns an array whose entries carry `title`/`finding`/`action` as
  strings, `severity` from the known set, and `impact` either a finite number or absent
   — never `null`, `NaN`, or a string, because `renderFindings` branches on
  `typeof f.impact === "number"` to decide between a dollar claim and `no $ claimed`.
- The aggregate produced through the real seam still satisfies §4's ordering invariant.

This is a **contract** test: it asserts shapes at the boundary, not analytic values. It
must not duplicate the pricing or classification unit tests, and must not become a
change-detector on category names.

## Testing

Every item gets a failing test written **first**.

**Unit** (`tests/kit/`, `node --test`):

- `originalChars` is emitted only on truncated turns, is the masked-text length, and is
  absent otherwise.
- The `kpi()` title parameter escapes its input and is omitted entirely when not passed.
- The tools-line projection sorts by count desc and caps at six.
- The `deps` contract test of decision 4.

**Browser** (`tests/ui/dashboard-ui.mjs`, `pnpm run test:ui`):

- The caret expands and collapses a row; `aria-expanded` tracks it.
- Expanding a row does **not** navigate to the transcript; clicking the row body still
  does.
- The detail strip is free of rendering artifacts — the harness's existing
  `artifactsIn()` net already fails on `[object Object]`, `undefined`, and `NaN`, which
  is precisely the failure mode `basis` invites.
- Both grids are exercised: desktop and a `≤560px` viewport, asserting cell alignment
  survives the new column.
- A truncated turn renders its badge (fixture corpus must contain one turn over
  `MAX_TURN_CHARS`).

**Gate:** `pnpm run check` and `pnpm run test:ui` both green, with command output shown
in the report. Then `pnpm run test:ui --real` against live transcripts, and the
`.ui-artifacts/` screenshots eyeballed before any completion claim. Four of the bugs in
the original build were invisible to green unit tests and obvious on screen.

## ADR-0009 amendments

- **§4** — record that `spanUnionSeconds` is retained and surfaced as a KPI tooltip,
  with the hover-is-weak trade-off stated plainly.
- **§5** — record that `basis` and confidence are inspectable per session via the row
  expander, and the measured payload cost of keeping the ten fields on the wire.
- **§8** — note that `originalChars` describes post-masking length, so it measures
  truncation loss only.

## Out of scope

- Persisting or deep-linking expander state.
- Any new API route, or moving fields off the wire.
- Re-litigating `MAX_TURN_CHARS`, `IDLE_GAP_MS`, or the confidence floor.
- LLM enrichment (`--enrich`), which remains opt-in and untouched.
- `ruflo-token-audit`, which stays an independent second opinion.
