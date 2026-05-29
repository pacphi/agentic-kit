# ruflo self-improvement: findings, upstream reconciliation & carry-forward

This documents what we learned investigating whether ruflo is *self-improving* (not just
self-learning), **which of our findings have since landed upstream (ruflo 3.10.6–3.10.9)**,
and **what remains as the carry-forward scope for this branch/PR**. Plain-language primer
first; findings, the upstream reconciliation, and the remaining-issue text follow.

> **Status (2026‑05‑29):** original investigation ran against ruflo **3.10.5**. Latest is
> **3.10.9**. Upstream shipped four releases in one day that absorb most of this — **F1/F2
> are fixed (#2222, 3.10.6; @pacphi credited)**, a deeper follow-up bug (negative‑reward
> inversion) was fixed in 3.10.7, and **F4 is independently confirmed and deferred upstream**.
> **F3 is the one finding still entirely unaddressed.** Details in the reconciliation table.

## Plain-language primer (no ML background needed)

Picture a **delivery company**. ruflo has *three different* learning systems people conflate:

1. **The Q-learner = the dispatcher** — "which specialist handles this task?" It keeps a
   scorecard of which agent does well on which task and updates it from results.
   - **ε (epsilon)**: how often it gambles on a random pick vs its favorite (1.0 = all
     guessing; should shrink as it learns).
   - **TD error (δ)**: "how surprised it was" — shrinks toward 0 as it converges.
   - **|Q|**: how many task-types it has opinions about.
2. **SONA = a driver's muscle memory** — nudges itself after each action; banks
   *trajectories* and *patterns*.
3. **LoRA = the *format* SONA stores tweaks in** — a small "diff sheet" of corrections on a
   frozen base. **Δ LoRA** = how big the last tweak was.

**Self-learning** (banking experience) vs **self-improving** (using it to get measurably
better) are different claims. ruflo is clearly self-learning. Whether it's self-improving
required digging.

## Findings (verified against ruflo 3.10.5 source + experiment)

### F1 — The route Q-learner *does* learn (in-process)
ruflo's `createQLearningRouter` genuinely learns: 200 in-process updates → Q-table grows,
ε decays (1.0→0.91), TD error nonzero. The algorithm works. **[Still true on 3.10.9.]**

### F2 — CLI `route feedback` could not persist (BUG) → **FIXED UPSTREAM (3.10.6 #2222)**
`route.js` `feedbackCommand` called `update()` but **never `saveModel()`**, and
`q-learning-router.js` defaulted `autoSaveInterval: 100`. Each CLI call is a fresh process
that loads the model, applies **one** update, and exits before the %100 auto-save triggers —
so the persisted model never advanced and `route stats` stayed `Update Count 0 / ε 1.0`.
We reported this; **ruflo 3.10.6 (#2222) fixed it with an explicit `await router.saveModel()`
after feedback** (verified in installed source: `commands/route.js`). The kit's stopgap
(`autoSaveInterval: 1`, `ruflo-patch-route-learning`) is therefore **retired on ≥3.10.6** —
the script is now a version-gated no-op that only applies the legacy patch on installs <3.10.6.

### F2b — Negative-reward inversion → **FIXED UPSTREAM (3.10.7)**, we did *not* catch this
A deeper bug in the same area: `route feedback -r -1.0` was parsed as **+1.0** — the shared
flag parser dropped any `-`-prefixed value, so giving **negative** feedback actively
*reinforced* the bad agent. Fixed in `parser.ts` (3.10.7). We missed it because our
`ruflo-improvement-eval` drives the router **in-process** and bypasses the CLI flag parser.
Worth recording: any workflow doing `route feedback -r -<n>` before 3.10.7 trained backwards.

### F3 — The state encoder collapses semantically-distinct tasks → **STILL OPEN**
`featureVectorToKey`/`extractFeatures` key features 1–32 on keyword *presence* and 33–48 on
length/word-count buckets; tasks with different routing keywords but similar shape hash to the
**same** Q-state (verified: six keyword-distinct tasks → 1 state). **Confirmed still open in
3.10.9 (latest):** the entire `ruvector/q-learning-router.js` is **byte-identical** between the
installed 3.10.8 and the published 3.10.9 — `extractFeatures`, `featureVectorToKey`, and
`FEATURE_KEYWORDS` are all unchanged. Note: 3.10.9's ADR‑142 "per-task bandit priors" is a
**separate subsystem** — `ruvector/model-router.js`, a Thompson‑sampling bandit that selects the
*LLM model* (Haiku/Sonnet/Opus) by complexity bucket — and has **zero references** to the
agent-route encoder. So even with F2 fixed, task-specific routing is limited because distinct
tasks share a policy slot. **This is the carry-forward finding most worth a PR.**

### F4 — The matrix-LoRA / SONA path is never consumed at inference → **CONFIRMED UPSTREAM, DEFERRED**
Every `SonaCoordinator` call in ruflo is training/recording; the coordinator exposes **no
inference method** (`predict`/`forward`), and the matrix-LoRA `forward_array` has **no callers
in any decision path** (only `neural.js`, the manual training command). The "LoRA" in
`intelligence.js` is a scalar per-pattern confidence nudge merely *named* "LoRA-style". So the
trained LoRA (the climbing `Δ LoRA`/`B.sumAbs`) **changes no decision** — written, never read.
**Upstream independently reached the same conclusion:** 3.10.9 states the WASM MicroLoRA
`apply()` is *"empirically still inert (Δ=0 after 200 adapts)"* and **deliberately refuses to
synthesize a fake gradient**; it lives in the `@ruvector/ruvllm` dependency and needs an
upstream fix there. Consuming it is upstream R&D, not a kit patch. **[Open, acknowledged upstream.]**

### F5 — With F2 fixed, the route learner self-improves — significantly but modestly
Our held-out, ablated, multi-seed experiment (`ruflo-improvement-eval`) over a synthetic
environment engineered to occupy distinct Q-states (per F3) shows the learner beats a
no-learning ablation with a **statistically significant, monotone** gain — but a **modest**
one (it learns the optimal action for only part of the state space within practical episode
counts, plateauing well below 100%). Honest verdict: **self-improving = yes (proven for the
consumed loop), but weak.** This result is independent of the F2 fix mechanism and remains the
kit's reusable proof harness.

```
route Q-learner · 5 seeds · learning vs no-learning ablation
  cold 17% → warm 33%   Δ+16pp   permutation p=0.004   Cohen's d=∞   above-chance: yes
  (modest ceiling — partial learning; see F3 encoder collapse + slow ε decay)
```

## Upstream reconciliation (ruflo 3.10.6 → 3.10.9)

| Our finding / kit artifact | Upstream status | Verdict for this kit |
|---|---|---|
| **F2** route feedback never persists | **Fixed 3.10.6 (#2222)** — `await router.saveModel()`; @pacphi credited | `ruflo-patch-route-learning` **retired** (no-op ≥3.10.6) |
| **F2b** negative-reward inversion (we missed) | **Fixed 3.10.7** — parser accepts `-`-prefixed values | n/a (our eval is in-process) |
| Bug B — stale route cache hid learning | **Fixed 3.10.8** — per-state cache invalidation in `update()` | aligns with the "no effect" symptom |
| Bug C — `--explore false` ignored | **Fixed 3.10.8** — parser honors explicit boolean values | exploration knob now controllable |
| **F3** state encoder collapses tasks | **Still open in 3.10.9** (`q-learning-router.js` byte-identical 3.10.8→3.10.9; ADR‑142 is the separate `model-router.js`) | **carry-forward — offer a PR** |
| **F4** LoRA/SONA not consumed at inference | **Confirmed + deferred** (3.10.9: `apply()` inert, won't fake it) | upstream R&D in `@ruvector/ruvllm` |
| Fabricated Flash-Attention metric (RNG) | **Removed 3.10.7**; "150×–12,500× / 2.49–7.47×" marked unverified | update any kit docs that still quote those |

The most striking takeaway is **methodological convergence**: this kit, Ciprian Melian's
`ruflo-aqe-kit`, and upstream ruflo all adopted the same integrity discipline on the same day
— falsifiable verdicts, "self-learns but self-improvement unproven," and a refusal to fabricate
signals (the Flash RNG metric removed; the inert LoRA Δ not faked).

## Carry-forward scope for this branch / PR

What this PR still contributes, now that F1/F2 are upstream:

- **`ruflo-improvement-eval`** — the held-out, ablated, multi-seed proof harness (permutation
  p + Cohen's d). Still unique; complements upstream's `benchmark-intelligence.mjs`. The
  measuring stick for any future F4/Tier-2 work. `--cli-check` is now version-aware (recognizes
  the 3.10.6 `saveModel()` fix).
- **F3 (state-encoder collapse)** — the one finding entirely unaddressed upstream. Carry forward
  as a proposed encoder tweak / upstream PR.
- **F4 (LoRA/SONA inference gap)** — keep as a tracked upstream item; aligned with ruflo's own
  deferred punch-list (`docs/reviews/intelligence-system-audit-2026-05-29.md`).
- **`ruflo-patch-route-learning`** — retained only as a **version-gated legacy shim** for
  installs <3.10.6; no longer part of `ruflo-resync`.

## Remaining upstream issue (ruvnet/ruflo) — F3 + F4

> **Title:** Route Q-state encoder collapses keyword-distinct tasks; trained LoRA/SONA still not consumed at inference
>
> **Body:**
> Following the routing-learning fixes in 3.10.6–3.10.8 (thanks!), two items from our original
> investigation remain:
>
> **1. (F3) State encoder collapses distinct tasks.** `ruvector/q-learning-router.js`
> `extractFeatures`/`featureVectorToKey` keys features 1–32 on keyword presence and 33–48 on
> length/word-count buckets; routing-keyword-distinct tasks with similar shape collide to one
> Q-state (verified: six keyword-distinct tasks → one state; the encoder is byte-identical in
> 3.10.8 and 3.10.9). ADR‑142's per-task bandit priors address *model* routing
> (`model-router.js`), not this agent-route encoder. *Suggested direction:*
> give keyword categories their own state dimension (or hash the matched FEATURE_KEYWORD set)
> so task-distinct routing has distinct policy slots.
>
> **2. (F4) Trained LoRA/SONA is never consumed at inference.** `SonaCoordinator` exposes only
> recording/training methods (no `predict`/`forward`); `MicroLoRA.forward_array` has no callers
> in any decision path. We note 3.10.9 already documents `apply()` as inert in `@ruvector/ruvllm`
> and declines to fabricate a gradient — agreed. Tracking here so the inference seam isn't lost:
> the routing/recall scorer can't benefit from accumulated adaptation until a real `forward`
> path exists and is consumed.
>
> Environment: ruflo 3.10.8/3.10.9, Node 26. Repro: `ruflo-improvement-eval`
> (https://github.com/pacphi/ruflo-machine-ref).
