# Sonnet 5.5 Routing & Pricing Refresh

**Goal:** Decide whether to swap `claude-sonnet-5` for `claude-sonnet-5-5` in `ak`'s
`balanced`-tier model catalog and per-activity `DEFAULT_ROUTES` (the policy `ak run` executes
and projects into AQE's `agentOverrides` for QE agents), and update pricing, model-inventory
discovery data, and docs to match.

**Status:** Implemented, 2026-09-28. `pnpm test`, `pnpm run typecheck`, `pnpm run lint`,
`pnpm run lint:md` all green.

## Evidence

Claude Sonnet 5.5 (`claude-sonnet-5-5`) released 2026-09-28, same day as this review. Findings
below are first-party (Anthropic) except where marked; the model shipped today, so there is no
independent (non-vendor) evaluation yet.

**Pricing — identical to Sonnet 5, no `ak` cost-model change needed.**
Base $2/$10 per MTok in/out, $2.50/$4 5m/1h cache writes, $0.20 cache read (the *standard* 0.1x
multiplier — unlike Opus 5.5's 0.05x override, Sonnet 5.5 needs none).
[platform.claude.com/docs/en/about-claude/pricing](https://platform.claude.com/docs/en/about-claude/pricing),
verified 2026-09-28.

**Capabilities — same envelope as Sonnet 5.** 1M-token context, 128K max output, `Jun 2026`
reliable knowledge cutoff, retirement commitment "not sooner than 2027-09-28."
[platform.claude.com/docs/en/models/overview](https://platform.claude.com/docs/en/models/overview).
Tool-use system-prompt overhead is *lower*: 286 tokens (auto/none) vs Sonnet 5's 354/474 — a
per-turn cost reduction on top of the unchanged per-token rate.

**Benchmarks — Sonnet 5.5 leads Sonnet 5 on every axis checked, first-party
(anthropic.com/claude-sonnet-5-5, verified 2026-09-28):**

| Benchmark | Sonnet 5 | Sonnet 5.5 | Opus 5.5 |
|---|---|---|---|
| GDPval-AA v2.1 (real-world occupational tasks) | 1449 | 1844 | 1846 |
| OSWorld 2.1 (computer use) | 57% | 80.1% | 81.8% |
| Terminal-Bench 4.0 | 10.3% | 70.6% | — |
| CursorBench 4.0 | 34.1% | 55.5% | 57.8% |
| Chartography (visual recognition) | 15.6% | 61.6% | 64.4% |

Sonnet 5.5 lands within ~2 points of Opus 5.5 on several axes at less than half the per-token
price ($2/$10 vs $4/$20), while Anthropic states Opus remains "clearly stronger at complex,
open-ended work."

**Cost-per-task, not just cost-per-token (caveat: vendor's own testing).** Anthropic reports
"30%+ faster generation" and "up to 30% lower cost per task." Press-relayed customer figures
(not independently verified by this review): Lovable cited "about one-third fewer tool calls and
roughly half as many shell executions"; Base44 cited 3.6 iterations per build vs 7.7 for the
prior generation
([VentureBeat](https://venturebeat.com/technology/anthropic-launches-claude-sonnet-5-5-with-30-cost-reduction-per-task-due-to-faster-speeds-and-fewer-tool-calls)).
Per this repo's own `COST_AXIS_NOTE` convention: per-token price ≠ per-task cost — these are
Anthropic's and its customers' claims, not an `ak`-measured result.

**Positioning.** Anthropic markets Sonnet 5.5 as "the best combination of speed and
intelligence" for "well-scoped everyday work: software debugging, coding, producing documents,
building presentations and spreadsheets, and designing or refining interfaces" — a close match
for the activities `ak` already routes to the `balanced` tier (specification, review, release).

**No retirement risk.** Sonnet 5 carries no deprecation notice and stays listed under Anthropic's
"Legacy models (still available)." This repo's `RETIRED_MODELS` rule — "we'd rather they used the
newer one" is never sufficient grounds — does not apply here; nothing needed retiring.

## Decision

Swap the `balanced`-tier default from `claude-sonnet-5` to `claude-sonnet-5-5` for `ak`'s
per-activity routing policy (`specification`, `review`, `release`), matching the precedent set by
the Opus 5 → Opus 5.5 move (PR #234): the new model becomes the catalog's `balanced` entry, the
prior model is demoted to `tier: 'prior'` and kept listed for user pins.

**Scope check — what does *not* change.** `git grep` found no `sonnet` reference in
`src/lib/qeCourt.mjs`, `providers.mjs`, or any qe-court config. QE-Court seat models remain
upstream/AQE-owned (`ak sync` never rewrites `.claude/skills/qe-court/config.json`), and ruflo's
own internal model router is untouched. What *does* change is `ak`'s own per-activity policy —
consumed directly by `ak run`, and projected into AQE's `agentOverrides` for the QE agents in
`AGENT_ACTIVITY_MAP` (`qe-code-reviewer`, `qe-integration-reviewer`, `qe-performance-reviewer` →
`review`; `qe-requirements-validator` → `specification`).

**Known consequence.** A user route still explicitly pinned to `claude-sonnet-5` now mirrors (via
`swapHostModel`, e.g. on a codex-primary flip) to `gpt-5.6-sol` instead of `gpt-6-sol` — the same
tier-demotion behavior the Opus 5 → Opus 5.5 move already established. The pin itself is
untouched; only its *mirror* target moves down a tier with it.

**Deferred, not part of this swap.** Sonnet 5.5's near-Opus-5.5 scores on some benchmarks could
argue for moving `debugging` or the `implementation`/`testing` escalation target off Opus 5.5.
That is a separate, larger decision (it touches the `reasoning` tier, not `balanced`) and is
intentionally out of scope here.

## Changes

- `src/lib/pricing.mjs` — new `claude-sonnet-5-5` price row (own key, so a future rate divergence
  from `claude-sonnet-5` is a one-line diff, not a silent mis-price via the prefix matcher).
- `src/lib/routing.mjs` — `MODEL_CATALOG.claude` balanced tier → `claude-sonnet-5-5`;
  `claude-sonnet-5` demoted to `tier: 'prior'`; `DEFAULT_ROUTES.specification/review/release` →
  `claude-sonnet-5-5`; `MODEL_CATALOG_VERIFIED` → `2026-09-28`.
- `src/lib/model-inventory/discovery/anthropic-catalog.mjs` — new `claude-sonnet-5-5` entry;
  `ANTHROPIC_PUBLIC_CATALOG_AS_OF` → `2026-09-28`.
- `docs/providers.md`, `docs/adr/0006-primary-host-and-ambidextrous-mirroring.md`,
  `src/commands/x/host.mjs`, `README.md` — model-id references and the tier-pairing table/example.
- `tests/kit/pricing.test.mjs` — new pricing-row test mirroring the existing Opus 5.5 one.
- `tests/kit/routing-primary.test.mjs`, `tests/kit/model-discovery-claude-codex.test.mjs` —
  updated hardcoded expectations that followed the default/catalog move.

## Verification

`pnpm test` (full suite, coverage-enforced), `pnpm run typecheck`, `pnpm run lint`,
`pnpm run lint:md` all pass with no new warnings or errors.
