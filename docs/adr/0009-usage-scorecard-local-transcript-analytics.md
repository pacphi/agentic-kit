# ADR-0009 — Usage scorecard: local transcript analytics with graded evidence

- **Status:** Accepted
- **Date:** 2026-07-25
- **Deciders:** agentic-kit maintainers

## Context

Claude Code and Codex both write complete session transcripts to disk — `~/.claude/projects/**/*.jsonl`
and `~/.codex/sessions/**/rollout-*.jsonl`. On a working machine that is a large corpus: **1.3 GB
across 3,108 files, 1,018 of them touched in the last 14 days**, carrying per-turn token usage, model
IDs, timestamps, tool calls, the full message bodies, and — for Claude — an `ai-title` the model wrote
for the session itself.

Nothing in the kit reads it. `ak x dashboard` (ADR-0005) reports subsystem *health*; it says nothing
about *usage*. The one existing reader, `claude/skills/ruflo-token-audit/scripts/ruflo-token-audit.py`,
is a standalone stdlib-Python engine that answers "where did my tokens go" as a one-shot report. It has
no per-session detail, no Codex, no durations, no cost, no transcript access, and takes tens of seconds
over the full corpus — it is a diagnostic command, not a live panel.

Users want a **scorecard**: sessions and tokens over a sliding window, cost, time, model and provider
breakdown, what the sessions were *about*, and the ability to open one and read it. And they want to
know **what to do about it** — the part a table of numbers never answers.

Three properties of the data force most of the design:

1. **Volume.** 1.3 GB cannot be re-parsed on a dashboard poll.
2. **Cache dominance.** 96.3% of the measured window's tokens are cache reads, which bill at 0.1× input.
   A naive `tokens × rate` overstates cost by roughly **10×**.
3. **Overlap.** 582 sessions summed to 300.4 h of span across a 14-day window — 21 h/day — because
   subagent and parallel sessions overlap in wall-clock. The union of those intervals is **164 h**.

## Decision

### 1. A tab on `dashboard`, not a third command — the split is egress, and this has none

ADR-0007 split `admin` from `dashboard` along **network egress**: `dashboard` promises silence,
`admin` promises reach. Usage analytics reads **local files only** and makes **zero network calls**.
It therefore sits squarely inside the dashboard's existing offline-first contract and ships as a
sixth tab (`#usage`), not a new server.

The tab carries four in-page views — **Scorecard → Findings → Sessions → Transcript** — deep-linked
as `#usage`, `#usage/findings`, `#usage/sessions`, `#usage/<sessionId>`, reusing the in-page reveal
idiom ADR-0005 established rather than adding navigation concepts.

`ruflo-token-audit` **stays** as an independent standalone reporter. It is the offline second opinion
and the fallback when the kit is not installed; the panel does not replace it and does not shell it.

### 2. An incremental on-disk index — the panel never parses the corpus on a poll

`src/lib/usage-index.mjs` walks both stores and writes an index to
`~/.config/agentic-kit/usage-index.json`, keyed per file by `(path, mtime, size)`. Only files whose
key changed are re-parsed. Cold build is a one-time cost (~1 min on the reference corpus); warm
refresh is near-instant because a finished transcript never changes again.

That immutability is load-bearing well beyond caching: **a completed session's derived facts —
totals, duration, category — are computed once and are correct forever.** It is what makes optional
LLM classification (§5) economically bounded rather than a recurring bill.

The Usage tab fetches **lazily on activation**, never on the shared status poll. Scans are
single-flight: a refresh already in progress is joined, not duplicated.

### 3. Cost is an API-list-price equivalent, stated as such, never plan billing

`src/lib/pricing.mjs` holds dated per-model rates and computes
`input×rate + cacheWrite×rate×1.25 + cacheRead×rate×0.1 + output×outRate`.

On a Max/Pro subscription the user is **not billed per token**, and Codex-via-ChatGPT likewise. The
panel therefore labels every figure **"API-equivalent — not your plan billing"** as a first-class UI
element, not a footnote. We do not model plan utilisation: Anthropic does not publish the limits that
would make such a percentage honest, and an invented denominator is worse than no number.

> **Amended by [ADR-0010](0010-provider-mediated-quota-reads.md) (2026-07-27):** the exclusion above
> was about denominators the kit would have to *invent*. Both vendors now hand over their own
> percentages through supported channels (Claude Code's statusLine `rate_limits` push; Codex's
> `app-server` RPC), and the Limits sub-view renders those vendor-reported figures — with
> provenance and freshness — under ADR-0010's provider-mediated rules. Locally *computed*
> plan percentages remain excluded, exactly as stated here.

OpenAI publishes no pricing in `~/.codex/models_cache.json` (verified), so Codex rates are a
maintained table and are **date-stamped** in the UI so staleness is visible rather than silent.

### 4. Engaged time is the union of *active* intervals — three tiers, and the honest one leads

Reporting summed spans would have claimed 21 h/day. Merging overlapping session spans fixes only
half of that: a session's span is first-to-last timestamp, so an idle-but-open session donates its
whole idle stretch. On the reference corpus 11 in-window sessions spanned over 6 h (longest **27.4 h**),
and the span-union still read 16.5 h/day — better than 21, still false.

Each session is therefore split into **active sub-intervals at silences longer than `IDLE_GAP_MS`**
(15 min, exported and named because it is a judgement call the numbers depend on, not a magic
constant), and `engagedSeconds` unions *those*. Three tiers are emitted, and the ordering
`engagedSeconds ≤ spanUnionSeconds ≤ spanMinutes×60` is an asserted invariant:

| Tier | Reference corpus | Per day |
|---|---|---|
| `engagedSeconds` — union of active sub-intervals (**leads the UI**) | 100.7 h | 7.2 h |
| `spanUnionSeconds` — union of whole spans | 230.8 h | 16.5 h |
| `spanMinutes×60` — summed spans (secondary, labelled) | 296.4 h | 21.2 h |

Calibration: only 85 splits fire across 584 sessions, so the ~130 h drop comes from a handful of
marathon idle sessions rather than broad deflation; and no session collapses to zero engaged time.
A metric implying a person worked 21-hour days is not a rounding error, it is a false statement —
and neither is 16.5.

**Amendment (2026-07-25).** `spanUnionSeconds` shipped computed but rendered nowhere. It is **retained
and surfaced as a tooltip** on the engaged-time KPI, carrying all three tiers, rather than dropped or
promoted into the visible sub-line. Promoting it would give hero-row density to a figure this section
argues is *not* the honest one; dropping it would delete the middle term of the invariant, leaving the
reader no way to check the ladder from the running panel — the ordering is the argument for why 7.2 h/day
is trustworthy, and an argument whose middle step is missing is not checkable. **Hover is a weak channel**:
undiscoverable by accident, absent on touch. That is accepted because the ladder is *supporting evidence
for a headline figure*, not a figure in its own right — a reader who never hovers is less informed, not
misled. This ADR records that trade-off rather than implying the tier is prominently displayed.

### 4b. A session's *location* is not its project — worktrees collapse to the repo

`path.basename(cwd)` was the whole project derivation, so a git worktree reported
its **branch** as a project. On the reference corpus that produced eight `phase-*`
rows sitting beside `keel` as if they were peer repositories, plus `slack-nav-…`
beside `tub-vault` and three `agent-<hash>` rows beside `tub-a2a-2026-library`.
**Every project total was short by whatever work happened in a worktree.**

`projectLabel(cwd)` now collapses `<repo>/<marker>/worktrees/<rest>` to `<repo>`
for the markers `.autopilot`, `.claude`, and `.git`, and **keeps `rest` as a
separate `worktree` field**. "Which repo" and "which branch of it" are different
questions; discarding the second would trade a wrong answer for a lossy one.
The reference corpus went from **18 projects to 10**, with `keel` gaining 11
sessions, and 22 sessions now carry a worktree.

The per-session scratchpad (`/tmp/claude-<pid>/…/scratchpad/…`) gets its own
`scratchpad` bucket rather than a guessed repo: the embedded path segment is
`/`-encoded, so a `-` may be a separator or part of a name and cannot be decoded
unambiguously. Guessing there would be the same class of error as the bug being
fixed. Cached records carry the old labels, so `SCHEMA_VERSION` went to **3**.

### 5. Classification is three-layer, and "Unclassified" is a first-class outcome

Measured signal coverage on the reference corpus: `ai-title` **93%**, tool mix **100%**,
`attributionSkill`/`attributionPlugin` **8%**, slash commands **13%** (and mostly meta — `/clear`,
`/model`).

- **Layer 1 — provenance.** When `attributionSkill`/`attributionPlugin` is present it *is* the
  category. Exact, free, no inference.
- **Layer 2 — rules.** Weighted keywords over the title plus a tool-mix prior (Edit/Write-heavy →
  building; Read/Grep-heavy → reviewing; Agent-heavy → orchestration). Deterministic, offline,
  explainable. Emits a **confidence**, and confidence is *displayed*, not hidden.
- **Layer 3 — optional LLM labelling.** Opt-in (`--enrich`), applied only to the low-confidence
  residue, cached permanently per session id per §2. Off by default so the panel stays offline-first.

Sessions below the confidence floor stay **Unclassified** and are shown as such. Force-fitting a label
to reach 100% coverage would make the categories untrustworthy everywhere, not just on the residue.

This replaces the word map from the first design pass. That map was not *wrong* — 492 of 558 titles
are distinct, so `review`/`security` was a genuine theme, not one job repeated — but it reported
vocabulary when the question was categories.

**Amendment (2026-07-25).** "Confidence is displayed, not hidden" was only half-true at ship: the
confidence *value* reached the category rows, but `basis` — the string saying **why** a category was
assigned — travelled to the browser and rendered nowhere, alongside nine other Session fields
(`skill`, `plugin`, `sidechain`, `models`, `input`, `output`, `cacheRead`, `cacheWrite`, `tools`).
All ten are now **surfaced in a per-session row expander** in the Sessions view, with `basis` placed
directly beneath the category chip it explains. The alternative — trimming them from the wire — was
rejected because it would make the classifier's reasoning uninspectable, which is this section's
claim inverted. `Unclassified` sessions show their basis too (usually `no signal`) rather than being
blanked: the absence of a signal is itself the explanation.

Keeping the fields on the wire has a measured cost, recorded here so the choice is not free-floating:
`/api/usage` grows by **41.4 kB — 67.4 kB to 108.8 kB, +61.4%** and a representative `/api/sessions`
response by **36.5 kB — 53.6 kB to 90.1 kB, +68.0%** on the reference corpus, versus the same
responses with the ten fields stripped. The `/api/sessions` figure is the largest project's *load all*
(`keel`, 176 rows), which is the biggest response the client ever asks for; the per-project spread is
59–72%, so the proportion is stable and the absolute cost scales with row count. **This is a large
relative cost on a small absolute one** — the ten fields are roughly two thirds of a session row
because the row is otherwise ids and integers, but the whole payload is still under 110 kB, fetched
once on tab activation over loopback, and never on the shared status poll (§2). Trading a tenth of a
megabyte for an inspectable classifier is the trade this section already argued for; recording the
number means a future reader can re-open it with evidence rather than intuition.

### 6. Findings are evidence-graded, and the panel refuses to market

The **Findings** view ranks detectors by estimated impact. Three rules govern what it may say:

- **No fabricated impact.** A finding claims a dollar figure only when it can compute one from the
  user's own data. Otherwise it displays *"no $ claimed."* On the reference corpus only 1 of 5
  findings carries a number.
- **Local measurement outranks vendor benchmark.** A controlled local A/B on the user's own workload
  is stronger evidence for that workload than any published benchmark.
- **Capability claims carry citations, or are not made.** Third-party "model X vs Y" blog comparisons
  are **not** admissible evidence.

This rule set was not theoretical. A first-pass detector observed 48% of spend on a
previous-generation model and recommended upgrading — asserting the newer model was "strictly more
capable." Grounding reversed it:

- Anthropic reports Opus 5 more than doubling Opus 4.8 per task on Frontier-Bench v0.1 — a
  **hard-task, vendor-reported** benchmark.
- A controlled A/B on a **routine** task ([`pacphi/retort`](https://github.com/pacphi/retort/blob/main/versions-blog.md))
  measured Opus 5 taking **3.4× the steps and 3.7× the cost** of Opus 4.8 for identical output.
- The literature reconciles both: reasoning models overspend on routine steps — the *Overthinking
  Tax* ([OckBench](https://arxiv.org/html/2511.05722),
  [Think Fast and Slow](https://arxiv.org/html/2602.12662),
  [Stop Overthinking](https://arxiv.org/pdf/2503.16419)).

The shipped detector therefore recommends **complexity-aware routing** and, on this corpus, explicitly
advises *against* a blanket upgrade. **A diagnostic panel that nudges toward the newest model by
default is an advertisement, not a diagnostic.**

### 7. Poll cadence becomes user-controlled; the 5 s default goes

The dashboard's hardcoded `setInterval(poll, 5000)` predates any expensive view. A poll control moves
into the header band, governing **every** tab: on/off, interval from 15 s to 24 h, **default 30 s**,
persisted to `localStorage` alongside theme and tab. Paused, the pulse greys and a manual refresh
stays available. Every refresh path — automatic or manual — passes a **cooldown (3 s)** and a
single-flight guard, so a double-click cannot stack concurrent scans.

### 8. Transcripts render locally, mask secrets by default, and cannot be exported

Transcripts contain whatever was pasted into a session. The reader inherits the dashboard's
loopback bind and DNS-rebinding `Host` guard, and adds: secret-shaped strings
**masked by default, server-side, before serialisation** — 21 shapes covering vendor prefixes
(`sk-`, `ghp_`, `github_pat_`, `AKIA`/`ASIA`, `glpat-`, `xox*`, `AIza`, `npm_`, `hf_`, `pypi-`,
`SG.`, `sk_live_`, `whsec_`), whole PEM blocks, JWTs, URI-inline credentials, `Basic`/`Bearer`
headers, Slack webhook URLs, and SCREAMING_CASE secret assignments — and **no download or
copy-all control**.

Redactions are **marked in the transcript** so the reader can see that something was removed rather
than silently reading altered text. **There is deliberately no click-to-reveal**, and it is not an
omission: masking happens server-side and the original never reaches the browser, so there is
nothing on the page to reveal. An earlier draft of this ADR promised a reveal, and the renderer
hunted for `***` / `[REDACTED]` sentinels the masker never emits — so no marking appeared either.
Both halves are now aligned on the `…redacted` marker the masker actually produces. And a **bare
40-character AWS secret with no prefix or assignment context is deliberately not masked**: it is
indistinguishable from a hash or base64 blob, so masking it would corrupt real transcript content.
Masking covers `meta` as well as turns; forwarding metadata around the gate was a real defect found
in review. The data is already on the user's disk; the panel's job is to
avoid *amplifying* it into a screenshare or a file, not to pretend it is secret from its owner.
`/api/session/:id` streams a single file by id and never triggers a full scan.

**Amendment (2026-07-25).** Marking redactions covered masking but not the *other* way content is
withheld: `MAX_TURN_CHARS` (40 000) silently abridged a long turn and set a `truncated` flag the
renderer ignored, so an abridged turn was indistinguishable from a complete one — the same honesty
failure this ADR exists to prevent, in the one view that shows raw content. A truncated turn now
**announces itself in the turn header**, stating how much of the turn is shown rather than a bare
"truncated": a reader who cannot tell 1% loss from 90% loss has learned that something is missing and
nothing about whether it matters, which is precisely the un-graded claim §6 refuses from a finding.

The producer emits `originalChars` **only on truncated turns**, so the field's presence is itself the
signal and a complete turn cannot be misread as an abridged one. That length is measured **after**
masking, because masking already runs before the slice — so `originalChars` describes loss due to
*truncation* alone, and must not be read as a raw-file length. Marking the two kinds of withholding
with different vocabulary keeps them distinguishable to the reader.

**Amendment (2026-07-26).** The reader labelled every `role: "user"` turn **"you"** — but the
Messages API records *tool results* and *harness context injections* under the user role, so in a
heavily agentic session the overwhelming majority of "you" turns were output the harness fed back to
the model, not anything the person typed (a measured real session: 20 human prompts against 276
tool results, every one attributed to the human). Misattributing the harness's work to the person is
the same honesty failure this section exists to prevent, in the attribution column instead of the
content column. The parser now stamps each user turn with a `kind` — `prompt` (the person, including
image-only pastes that carry no text block), `tool-result` (a `tool_result` block fed back after a
tool call), or `context` (`isMeta` harness injections) — and the renderer labels from *kind*, never
from role: `you` is reserved for `prompt`, tool results render as **tool result** and context as
**context**, both purple like the tool chips and carrying a hover title stating the harness — not
the person — sent them. The existing `prompt` boolean (which drives the prompt *counts*) is
unchanged; `kind` is deliberately broader on the image-only edge, because "not countable as a text
prompt" and "not the human" are different claims. Codex rollouts record only real prompts as
`user_message` events, so every Codex user turn is `kind: prompt` by construction. Full mechanics:
[`docs/TRANSCRIPTS.md`](../TRANSCRIPTS.md).

## Consequences

### Good

- The dashboard's offline-first contract (ADR-0005) is preserved exactly; no new server, no new port,
  no credential, no egress.
- Warm refreshes are near-instant, so a live panel over a 1.3 GB corpus is viable.
- Cost, time, and category figures are defensible under scrutiny: each either derives from the user's
  own data or carries a citation.
- The evidence rules make the panel *harder* to turn into a marketing surface later — a future
  detector cannot claim a capability win without a source.

### Costs and risks

- **Cold build is slow** (~1 min). Mitigated by lazy activation, a visible progress state, and the
  fact that it happens once.
- **Price tables drift.** Model rates are maintained by hand and *will* go stale; the UI date-stamps
  them, and a stale table produces a wrong equivalence — this is why the figure is never presented
  as billing.
- **Rule-based classification is imperfect.** Accepted deliberately: confidence is surfaced and
  `Unclassified` is shown rather than hidden.
- **Index location is machine-scoped** (`~/.config/agentic-kit/`), consistent with ADR-0008's
  machine-vs-repo scope line; the scorecard is machine-wide with project as a filter, so a
  repo-local index would be the wrong scope.
- **Codex coverage is thin in practice** (5 sessions on the reference machine, none in-window). The
  panel reports Codex as present-but-idle rather than inventing data, and the split UI is built now
  so dual-host users are not a later retrofit.

## References

- **[`docs/USAGE-SCORECARD-METRICS.md`](../USAGE-SCORECARD-METRICS.md)** — the maintainer-facing
  metrics reference: every Scorecard-tab figure's exact formula, source-line citation, worked
  example, and external pricing citation, added 2026-07-25 after a user-reported Codex-vs-Claude
  cost discrepancy traced to two real bugs in `parseCodex` (fixed same day). Read that document to
  verify or dispute a specific number; read this ADR for the design motivation behind it.
- ADR-0005 (dashboard as read-only offline-first diagnostic); ADR-0007 (egress split);
  ADR-0008 (machine vs repo scope).
- Spec (archived on completion, per `docs/archive/README.md`): [`docs/archive/2026-07-25-superpowers-spec-usage-scorecard.md`](../archive/2026-07-25-superpowers-spec-usage-scorecard.md).
- Existing reporter: `claude/skills/ruflo-token-audit/scripts/ruflo-token-audit.py`.
- Grounding for §6: [Anthropic — Introducing Claude Opus 5](https://www.anthropic.com/news/claude-opus-5);
  [`pacphi/retort` versions-blog](https://github.com/pacphi/retort/blob/main/versions-blog.md);
  [OckBench (arXiv 2511.05722)](https://arxiv.org/html/2511.05722);
  [Think Fast and Slow (arXiv 2602.12662)](https://arxiv.org/html/2602.12662);
  [Stop Overthinking (arXiv 2503.16419)](https://arxiv.org/pdf/2503.16419).
- ruflo swarm surface grounded via `search_ruvnet`: `ruflo/plugins/ruflo-swarm/commands/swarm.md`
  (topology init, then native Task-tool fan-out).
