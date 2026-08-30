# ADR-0039 — Prompts intelligence: fingerprints, coaching, and layer-3 enrichment

- **Status:** Accepted
- **Date:** 2026-08-30
- **Deciders:** agentic-kit maintainers
- **Related:** [ADR-0009](0009-usage-scorecard-local-transcript-analytics.md),
  [ADR-0038](0038-consistent-cross-host-session-metrics.md)

## Context

ADR-0009 established the usage scorecard as local transcript analytics answering what a window
cost. ADR-0038 answered how the work was run. Neither answers a third question the scan path was
already positioned to see: what the operator actually *typed*, as distinct from what a session's
turns collectively contain — tool results, agent-to-agent deliveries, headless adapter templates,
and slash-command records all reach a `user`-role entry without a person typing anything.

A prior research pass over a reference corpus (600 Claude transcripts, 900 Codex rollouts)
measured that only 27.6% of parser-visible user-role turns were typed by the operator, and found
recurring shapes in that 27.6% worth surfacing: short "supervision taps" (`yes`, `go ahead`) that
are the shape of watching a run rather than directing it; near-duplicate clusters that recur
across sessions because there is no canonical form to point at instead of retyping; and a
consistent asymmetry in how much gets retyped per host. None of that is visible to a
percentile-over-tokens metric, and none of it can be answered by re-reading prompt text into the
index — the masking contract this scorecard has kept since ADR-0009 forbids that outright.

The build this ADR records answers all of it from a *fingerprint*, not a copy: a hash, a token
count, a bounded sample of token hashes, and a provenance tag, computed once at scan time and
never a text a person typed. Three layers sit on top of that fingerprint — deterministic
detectors and a repetition projection (free, every scan), personal baselines (statistics, no
inference), and an opt-in model-invoked layer that names clusters and proposes coaching cards
(the first inference path this codebase has ever had). This is the first build in the kit to
spawn a subprocess specifically to read a model's answer, which is why its privacy and
anti-fabrication boundaries are described in more operational detail below than a typical
metrics decision needs.

## Decision

### 1. Provenance is a closed four-tag vocabulary, one-directional by design

`usage-provenance.mjs`'s `provenanceOf(text, {kind})` classifies every turn the scan path already
marks `kind: 'prompt'` into exactly one of `human | control | agent | adapter` — never a fifth
tag, and never a guess. Every rule is anchored at the start of the turn and carries its own
measured count in a comment; an unmatched shape reads as `human`, deliberately, because
over-stating what the operator typed is visible and self-correcting while silently attributing a
typed prompt to a machine is not. Two research-proposed `ak-adapter` rules
(`You are (?:a|the) (?:qe-court|court) (?:seat|reviewer)`, `<qe-court\b`) were measured against
the full corpus and dropped: neither matched anything, and admitting an unevidenced rule risks
the one error direction this taxonomy forbids. The measured residual — 51 harness turns
misrouted to `human` in schema 14 — was closed at the source in schema 15, not papered over with
a fifth tag: 33 `<in-app-browser-context>` blocks joined the harness gate outright (no longer
prompts at all) and 18 continuation-prose turns moved to `control`.

### 2. F1 fingerprints: the entry shape, the bottom-64 sketch, and what it actually costs

An entry is `{h, t, th, p}` plus two optional shape flags, `q`/`o`, added in schema 16 and
omitted (not written as `0`) when false. `th` — a bounded, sorted sample of token hashes — is
capped at 64 (`MAX_TOKEN_HASHES`). That number is not a tidiness constant: storing every token
hash, unbounded, cost 15 MB against a 2.1 MB base index on the reference corpus (a 68× overshoot
of the design estimate), because one pasted document outweighs a hundred real instructions. Kept
sorted, the retained 64 are a **bottom-k (KMV) sketch** — a deterministic, unbiased sample and
the standard input to a Jaccard estimate, not a truncation of the prompt's first 64 words — so
the median prompt on this corpus is stored complete and the tail costs a bounded ~700 bytes
instead of ~86 KB. Measured cost after the bound: the fingerprint layer runs ≈2.8 MB within a
5.1 MB index (60-day window) — 13× the original spec estimate, corrected in the spec rather than
left to contradict it, and a real, disclosed cost of the feature, not hidden in a rounding error.
Schema moved 14 → 15 (the harness-gate correction above) → 16 (the `q`/`o` shape flags), each
bump forcing a full re-derive rather than letting a partial-schema record read new fields as
`undefined`, the same discipline every prior schema bump in this kit has followed.

### 3. Personal baselines replace fixed percentages wherever history allows

`buildPromptBaselines` computes, per host, the p75 of the DAILY tap share over the
`BASELINE_TRAILING_DAYS` (90) days immediately BEFORE the displayed window — deliberately
excluding the displayed window itself, because a window that fed its own threshold could never
read as unusual. Under `BASELINE_MIN_ACTIVE_DAYS` (30) days of history it is `null`, not a
default: a p75 over a handful of days is a number, not a normal, and the detector's own evidence
names the fallback (a stated 10% absolute floor) rather than passing it off as a personal one. A
real gap was found and fixed mid-build: both production call sites (the dashboard's `/api/usage`
handler and `ak usage score`/`ak usage prompts`) originally requested only `windowDays * 2` of
lookback, which for a 7-day report reaches 14 days back — structurally under the 30-day floor no
matter how long the corpus has run. Both now request `windowDays + BASELINE_TRAILING_DAYS`. The
fix makes the baseline *reachable*; it does not make it *populated* — on this machine's own
corpus the baseline is still `null` for most window/host combinations today, which is the honest
state of a machine still building history, and is stated as measured fact rather than implied
success (§2b).

### 4. Three prompt detectors, on the existing adaptive-thresholds discipline

`supervision-tap-share` (trend/warn), `headless-share` (coach/info), and `host-prompt-asymmetry`
(coach/info) join the existing `DETECTORS` registry, all computed from fingerprint-derived
aggregates only. Every firing prints the threshold it was judged against, per ADR-0009's rule 2
("no fixed percentages where a personal baseline can exist") and rule 1 (a modelled token volume,
never a dollar figure, for the tap-cost caveat). `host-prompt-asymmetry`'s p90-length arm requires
**≥50 typed prompts on each host** before comparing them at all (`asymmetryMinTypedPerHost`) — a
gate the original design spec's own §4 table omitted and this build's own spec amendment restored
before the spec was archived (see below).

### 5. The pattern-clustering library: deterministic ordering, precision-first seeds

`usage-prompt-patterns.mjs` clusters near-duplicate fingerprints via a bottom-k Jaccard estimator
over the SAME 64-entry sketch F1 already stores — not a second, independently-tuned sketch — with
a rare-token-bucket comparison bound that cut candidate pairs from 379,146 to 902 on the
reference corpus (114 identical clusters found either way, proving the bound exact rather than
lossy) plus one additional filter: a prompt sharing no token with any other prompt is dropped from
comparison outright, since its Jaccard with everything is exactly 0. Every function orders its
output deterministically (size then key, never insertion order) so a rescan over an unchanged
corpus reproduces byte-identical evidence hashes — load-bearing for the outcome ledger's staleness
detection (§8 below). `usage-prompt-vocabulary.mjs`'s four seed patterns are keyed on shape (token
band, class, span) rather than on a fingerprint's `h`, because a hash is corpus-specific and would
match nothing on another machine; a mid-build audit against the research's own measured cluster
tables found and fixed one seed (`commit-and-push`) that would have mislabeled a real cluster,
narrowed another (`progress-check-in`) that was reading as "any recurring short question" rather
than the actual evidence, and widened a third (`release-ritual`) whose own predicate could not
match the very cluster it was cut from — the corrected rule is **a seed must be precise or
silent**: 5 of 39 measured clusters resolve to a seed name, 34 fall through to the generic,
honest `characterize()` descriptor, and 0 mislabel.

### 6. The opt-in `promptPatterns` projection: an aggregate seam, not a CLI-only cache read

An earlier draft of this build had the CLI open the raw index cache directly to build its
repetition tables — a coupling to an internal file format the dashboard would have inherited too.
The shipped design instead threads `prompts: true` through `aggregate()`/`readIndex()` the same
way the existing `previous` (previous-window) flag already works: `null` when not requested, and
folded into `scanKey` so the single-flight cache and its memo cannot serve a `{prompts:true}`
caller an answer built without the projection. `ak usage prompts` and the dashboard's Prompts view
(§21) therefore read the identical `agg.promptPatterns` object and cannot disagree about what a
cluster is — the coupling this ruling was written to prevent never ships.

### 7. The privacy split: three surfaces, three different trust boundaries

- **Dashboard**: aggregates and masked session links only. `agg.promptPatterns` carries counts,
  curated names, and at most three session ids per cluster into the existing masked `#usage/<id>`
  transcript route — never a fourth accessor onto raw fingerprints, and never exemplar text.
- **CLI deep pass** (`--deep`): terminal-only. Re-reads transcripts through the SAME per-host
  parsers the scan path uses, so a re-read turn re-fingerprints to the identical hash and joins
  back to the findings exactly; every exemplar is masked before it is printed. The text goes to
  stdout and is written nowhere — except under `--json`, which the help text states explicitly.
- **Inference** (`--enrich`): CLI-only, and this is why the dashboard's Coaching panel has **no
  live Recompute affordance** — a button there would trigger inference from a surface this split
  keeps read-only by design (§9 below). The stale-card hint points at the CLI command instead.

### 8. The outcome ledger: canonical-30d basis, the transition matrix, the materiality gate

Every ledger-facing evidence read — a new record's baseline, adoption-by-collapse's "current
count", and outcome measurement — is pinned to a FIXED 30-day aggregate
(`CANONICAL_WINDOW_DAYS`), independent of whatever window the operator's `--window` or the
dashboard's day selector is showing. This was not the original design: a review-caught defect
demonstrated that switching `--window` alone, with the corpus otherwise unchanged, could
fabricate an adoption, an outcome delta, and — 14 days later — a permanent retirement verdict,
none of it backed by anything the operator did. The fix makes every record carry `windowDays:
CANONICAL_WINDOW_DAYS`; a record loaded without it is discarded rather than migrated, a
legitimate simplification because this ledger had not shipped to a user. The transition matrix —
`proposed → adopted → retired`, `proposed → expired → proposed`, `dismissed →` (unchanged, or
re-proposed once, or permanent) — is documented in full at §22. The re-proposal path itself
needed a second fix: gating re-proposal on "the evidence hash changed" alone made a dismissal
survive only until the pattern's very next occurrence, since any one additional instance changes
the hash. The materiality gate (`DISMISS_MATERIALITY_RATIO = 0.5`) requires the canonical count to
have worsened by at least 50% relative to the count recorded AT DISMISSAL TIME, measured against
that frozen reference every pass rather than a creeping one.

### 9. The anti-fabrication gate

A layer-3 model call is reserved for two jobs deterministic rules cannot do: naming a cluster and
proposing a coaching card. Neither may state a number the aggregate did not produce. Every number
in a synthesized card's `finding`/`try`/`basis` text, and every entry in its own `basisNumbers`,
must be traceable to a number ACTUALLY present in the findings summary the model was shown; one
unmatched number voids the whole card. This is enforced against a summary that is itself
counts/labels/shares only — no exemplar text is present in it to leak, by construction, so there
is no path by which the gate could be satisfied by something other than genuine grounding. Live
verification on a real 30-day corpus (53 distinct numbers across 458 clusters) confirmed the gate
reliably rejects invented large/specific numbers; it is measurably weaker against a small integer
that happens to coincide with an unrelated field elsewhere in the same summary — recorded as a
disclosed limitation (§23) rather than an unproven "holds against genuine model output" claim.

### 10. The invocation seam: the first inference path in this kit

`llm-invoke.mjs` is deliberately small: it detects the `claude` binary through the kit's own host
registry (`HOST_REGISTRY`, never a hardcoded literal — a test proves this by swapping in a fake
registry entry with a different bin name), spawns it once per call with the prompt as a single
argv element (no shell, matching this kit's existing exec discipline), and states its billing
line plainly — `"Claude Code CLI — your subscription"`. No scheduling machinery lives here or
anywhere in this build; a periodic digest is documented as an opt-in recipe (§20) against the
kit's EXISTING governed scheduling surfaces, not shipped as code. This is v1: exactly one host,
`claude`, is wired. A provider-diverse invocation chain is explicitly out of scope here (see
Deferred).

### 11. The class-taxonomy ruling: `instruction` never reaches the wire

The prompt-shape rules can detect only one distinction with any confidence — interrogative or
not. An earlier iteration published the non-question side as `'instruction'`, which asserts a
confidence (that a non-question prompt is a directive rather than a declarative statement) the
rules do not support. The ruling: `classifyCluster` emits `'question' | 'other' | 'mixed' |
'unknown'` on the wire — `'instruction'` no longer exists as a value anywhere a client can read
it, in the library, the CLI, or the dashboard. `CLASS_NOUNS` maps `other` to the same noun,
`'prompt'`, that `'unknown'` already used, because the two are honestly indistinguishable at the
noun level. Both surfaces' render-time neutralization regexes are kept as a belt against a
label arriving in the pre-ruling shape from an out-of-band source, with a dedicated test proving
they still catch it — redundant by construction against a well-formed payload, not vestigial.

### 12. `labelFor`'s `{name, descriptor}` split

A characterized cluster's label used to be one string carrying both the identifying lead ("
Recurring 3-token prompt") and a descriptive tail ("· 21 sessions · both hosts"). The CLI's
cluster table only ever needed the lead; the dashboard's table needed both, and had to parse the
tail back out of the combined string to render its own columns without repeating them. `labelFor`
now returns `{name, source, firstSeen, seed, descriptor?}` — `name` is the bare lead, `descriptor`
(present only for a characterized result) carries the full string — both built once, from a
shared `characterizeParts` helper, so `characterize()` (used directly by 20+ pre-existing tests)
and `labelFor` can never independently drift on the same input. The CLI needed zero changes: it
already printed `label.name`, which is now naturally bare.

### 13. The `stripDisplayNames` hash trap — a lesson worth keeping on record

`findingsSummaryHash` — the signal that decides whether a second `--enrich` pass needs to spend a
synthesis call at all — originally hashed the WHOLE findings summary, including a cluster's
display `name`. Because a settled label is re-applied to `promptPatterns` before the summary is
rebuilt on every pass, the hash moved on a name-only change with nothing new to synthesize about —
meaning the pass immediately after ANY labeling round would always see "evidence changed", every
time, defeating the two-consecutive-runs delta-only guarantee this mechanism exists to provide.
The fix strips display names before hashing (`stripDisplayNames`), mirroring the anti-fabrication
gate's own established posture that a name is not evidence. Recorded here because the shape of
the bug — a cosmetic field silently entering a hash meant to answer "did evidence move" — is
exactly the kind of mistake a future cache-invalidation key on this codebase could reintroduce
without the reasoning attached.

### 14. The pipe-drain exit fix, found along the way

`ak usage prompts --json` on the reference corpus is 268 KB. `process.exit()` kills a process with
piped stdout still queued, and any payload over the OS pipe buffer (65,536 bytes for a non-TTY
consumer) was silently truncated for every command in this kit, not only this one — three
quarters of this particular document was lost to `| jq` before the fix. `bin/agentic-kit.mjs` now
exits from a zero-length `write()` callback on stdout, then stderr, which only fires after
everything queued ahead of it has actually reached the OS; hard-exit semantics for any lingering
handle are preserved. This is a kit-wide correctness fix that this build's own `--json` output
size was what exposed.

## Consequences

### Positive

- The scorecard can now answer a third question — what the operator actually typed, and what
  they retype — with the same graded-evidence discipline ADR-0009/0038 established: every figure
  traces to a fingerprint or a curated label, never to stored prompt text.
- The class-taxonomy and `labelFor` rulings (§11, §12) removed a real confidence over-claim from
  every surface that had shipped it, at the render layer, without touching the seed predicates or
  the library's own classification logic.
- The privacy split (§7) is structural in two of its three surfaces: the dashboard's coaching
  payload builder has no `saveLedger`/inference call anywhere in its call graph, so "read-only"
  and "CLI-only inference" are not conventions a future diff could silently violate.
- The pipe-drain fix (§14) is a genuine kit-wide correctness improvement that a narrower feature
  would not have surfaced.

### Negative, and honestly stated

- The fingerprint layer costs 13× its original design estimate (≈2.8 MB of a 5.1 MB 60-day
  index) — bounded and disclosed, but real weight on every scan and on `readCache`'s synchronous
  parse.
- The personal baseline is reachable in principle (§3) but is `null` for most host/window
  combinations on this machine today; the detectors that key on it fall back to their absolute
  floor far more often than the "no fixed percentages" design goal implies in practice, on a
  corpus this young.
- The anti-fabrication gate proves grounding, not provenance (§9): it cannot distinguish a
  genuinely-cited number from a coincidental match against an unrelated field, and is measurably
  weaker on small integers than on large, specific ones.
- `--enrich`'s consent-line exemplar count is ≤1 per cluster in practice, not the ≤2 the engine's
  own privacy cap allows for — today's exemplar-gathering can only produce one real exemplar per
  cluster without extending the deep-pass machinery, which this build's own brief said not to
  re-derive.
- A three-way import cycle (`usage.mjs → usage/coaching.mjs → usage/enrich.mjs → usage.mjs`) was
  introduced by a complexity-driven refactor mid-build and later closed on its larger arc (this
  wave: `usage/deep-pass.mjs` is now a shared leaf both `usage.mjs` and `usage/enrich.mjs` import,
  so `enrich.mjs` no longer imports from `usage.mjs`). The smaller arc — `usage.mjs ↔ usage/
  coaching.mjs`, via `promptReport` — remains, resolves cleanly today (every crossing binding is a
  hoisted function declaration), and is recorded here as a structural pattern worth a lint rule if
  it recurs elsewhere.

### Deferred, deliberately

- **Per-host re-ask split.** `promptPatterns.reAsks` publishes only window-wide `pairCount`/
  `sessionCount`; the `codex-completion-criteria` coaching card wanted a literal per-host re-ask
  comparison and instead fires on the same two signals `host-prompt-asymmetry` already computes.
  Adding a per-host breakdown to the published aggregate is a deliberate, separate wire-shape
  decision, not made in-band by a card that merely wanted to consume it.
- **The dashboard Recompute affordance.** No live button triggers `--enrich` from the dashboard —
  the privacy split (§7) keeps inference CLI-only by design, and the stale-card hint points at the
  CLI instead. Not a missing feature; a boundary.
- **M-9: `medianTokens` is invisible to the anti-fabrication gate.** `buildFindingsSummary` does
  not carry a cluster's median token length, so that genuine evidence dimension cannot be cited
  (or checked for fabrication, or tracked for staleness) by any layer-3 output today. Pre-existing
  before this wave's own changes; carrying it as a numeric field would close the gap in one edit.
- **Session-classification `--enrich`.** No such layer exists, and none was built — a stale claim
  to that effect in this document (§12) is corrected in place rather than a feature being added
  to make it true.
- **Cross-host mirror dedup.** Already tracked in ADR-0038's own deferred list; this build did not
  narrow it further. A genuinely human prompt mirrored verbatim from one host's transcript into
  another's can still be counted as typed on both.
- **The dashboard client split, and the two pre-existing `dashboard-server.mjs` complexity
  warnings.** Also already named in ADR-0038's deferred list (`client/usage.mjs` past the
  file-size point where its panel builders belong in one file — now 1,181 lines, one `max-lines`
  warning). This build added a NEW file (`usage-prompts.mjs`) for its own panels rather than
  growing the existing one further, but did not perform the split ADR-0038 already deferred.
  `dashboard-server.mjs`'s two pre-existing `complexity` warnings (`collectData`, `startDashboard`)
  are unrelated to this build and were left untouched by every wave that touched that file.
- **A provider-diverse invocation chain.** `llm-invoke.mjs` wires exactly one host (`claude`) in
  v1. Whether a future wave should extend it toward the kit's broader multi-provider fallback
  pattern (as `agentic-qe`'s own LLM router already does) is an open question this build does not
  answer.

## Verification

Every rule change is pinned by a mutation check (the source reverted in isolation, the suite
re-run, the file restored and diff-verified byte-identical) rather than a passing-test claim
alone — the bottom-k sketch bound, the estimator's both-complete branch, the re-ask size gate, the
class-taxonomy booleans, the anti-fabrication gate's per-field coverage, the materiality gate, and
the `stripDisplayNames` fix all carry a named mutant and a named killer test. Two integration
regression pins drive the REAL `aggregate()`/`nearDupClusters()`/`reconcile()` pipeline end to end
— never a hand-built fixture standing in for the real one — through `deriveCards` and the real
CLI/dashboard printers. The `--enrich` flow's every documented behavior (delta-only labeling,
synthesis skip on an unchanged corpus, the consent preamble, honest-unavailable, honest-failure,
output masking) was additionally verified against the real `claude` CLI on this machine's own
corpus, not only against a scripted shim, with the transcript retained as evidence.

Both citation-bearing reference documents are machine-checked: every `file:line` citation in
`USAGE-SCORECARD-METRICS.md` and `TRANSCRIPTS.md` is verified against the current source on every
test run by `tests/kit/doc-citations.test.mjs`, tightened during this same wave (§6 below) to
require a named identifier, not a word fragment, wherever a citation's surrounding prose names
one.

## References

- Research: prompt-repetition and provenance findings underlying this build's F1 layer and its
  three coaching-relevant detectors — the reference-corpus measurements quoted throughout §2a/§2b/
  §20–§23 of `USAGE-SCORECARD-METRICS.md`.
- Spec: `docs/archive/2026-08-29-superpowers-spec-prompts-view-design.md` (archived; the build-time
  interface contract — evidence contract, panel layout, the six coaching rules, the three-layer
  adaptive architecture, the outcome ledger) and
  `docs/archive/2026-08-28-superpowers-plan-scorecard-matrix-a.md` (archived; the originating
  plan). Both shipped on this branch; this ADR and `USAGE-SCORECARD-METRICS.md` are the living
  record — see `docs/archive/README.md` for why they are historical.
- `src/lib/usage-parsers.mjs`, `src/lib/usage-provenance.mjs` (fingerprints, provenance),
  `src/lib/usage-aggregate.mjs` (prompt stats, personal baselines, the `promptPatterns`
  projection), `src/lib/usage-insights.mjs` (the three detectors),
  `src/lib/usage-prompt-patterns.mjs`, `src/lib/usage-prompt-vocabulary.mjs` (clustering,
  seeds, `labelFor`)
- `src/lib/usage-coaching.mjs`, `src/lib/usage-coaching-rules.mjs`, `src/lib/usage-evidence-hash.mjs`,
  `src/lib/usage-outcome-ledger.mjs` (coaching cards and the outcome ledger)
- `src/lib/usage-enrich.mjs`, `src/lib/llm-invoke.mjs`, `src/lib/usage-label-store.mjs` (layer-3
  enrichment and its invocation seam)
- `src/commands/usage.mjs`, `src/commands/usage/coaching.mjs`, `src/commands/usage/enrich.mjs`,
  `src/commands/usage/deep-pass.mjs` (`ak usage prompts`)
- `src/lib/dashboard-server.mjs`, `src/lib/dashboard/client/usage.mjs`,
  `src/lib/dashboard/client/usage-prompts.mjs`, `src/lib/dashboard/page.mjs` (the Prompts
  dashboard view)
- [Usage scorecard metrics](../USAGE-SCORECARD-METRICS.md) §2a, §2b, §20–§23 — the per-metric
  formulas and sources
