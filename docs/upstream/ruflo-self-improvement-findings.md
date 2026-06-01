# ruflo self-improvement: findings, upstream reconciliation & carry-forward

This documents what we learned investigating whether ruflo is *self-improving* (not just
self-learning), **which of our findings have since landed upstream (ruflo 3.10.6–3.10.9)**,
and **what remains as the carry-forward scope for this branch/PR**. Plain-language primer
first; findings, the upstream reconciliation, and the remaining-issue text follow.

> **Status (2026‑05‑29):** original investigation ran against ruflo **3.10.5**; latest is
> **3.10.10**. Upstream shipped four releases in one day that absorb most of this — **F1/F2
> are fixed (#2222, 3.10.6; @pacphi credited)**, a deeper follow-up bug (negative‑reward
> inversion) was fixed in 3.10.7, route cache + `--explore false` in 3.10.8, and ADR‑142's
> model-router bandit in 3.10.9. **F3 and F4 remain open and are now filed as two separate,
> independently-reproduced upstream issues:**
>
> - **F3** (route Q-state encoder collapse) → **[ruvnet/ruflo#2239](https://github.com/ruvnet/ruflo/issues/2239)**
> - **F4** (SONA learn→inference loop unwired at the JS/WASM boundary) → **[ruvnet/ruvector#519](https://github.com/ruvnet/RuVector/issues/519)**
> - Kit carry-forward (the live RL statusline panel, gated on both) → tracking issue **[pacphi/ruflo-machine-ref#8](https://github.com/pacphi/ruflo-machine-ref/issues/8)**
>
> The filed issues are the authoritative write-ups; **F4's framing was corrected during that
> verification** (see F4 below). Details in the reconciliation table.

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

### F4 — SONA learn→inference loop is unwired at the JS/WASM boundary → **FILED: [ruvnet/ruvector#519](https://github.com/ruvnet/RuVector/issues/519)**
The ruflo-bundled view was: every `SonaCoordinator` call is training/recording, the coordinator
exposes no `predict`/`forward`, and the trained `Δ LoRA` changes no decision (written, never
read); 3.10.9 documented the WASM MicroLoRA `apply()` as *"empirically inert (Δ=0 after 200
adapts)"* and refused to fake a gradient.

**Corrected against actual `ruvnet/ruvector` source (`c2089c4`), before filing** — the bundled
wording was imprecise and was *not* carried over verbatim:
- Inference seams **do exist and work**: `applyLora`, `MicroLoRA::forward`, `LoraAdapter.forward`.
  So this is **not** "no forward path."
- The real gap is the **learn→adapt loop is unwired through the bindings consumers actually call**:
  - `WasmSonaEngine::learn_from_feedback` is a **no-op** — it `console.log`s a reward and returns
    (`crates/sona/src/wasm.rs:183-192`).
  - The JS `@ruvector/ruvllm` `SonaCoordinator.processInstantLearning` is an **empty stub**
    (`sona.js:449-452`, "In full implementation, this updates LoRA weights").
  - The Rust trajectory path adapts **only on multi-step, varying-reward trajectories** — a
    single-step "one outcome per task" feedback has REINFORCE advantage 0 → **Δ=0 exactly**
    (reproduced over 200 adapts).
  - `accumulate_gradient` only writes `up_proj`; `down_proj` is **never** updated (rank-deficient).
  - Bonus smell: `estimate_gradient` L2-normalizes a near-zero gradient → **amplifies f32 residue
    into a unit-norm update** for a no-information signal.
- Reproduced with a `cargo test` against the real crate (`crates/sona/tests/repro_delta_zero.rs`,
  included verbatim in #519). Consuming a *working* adapter downstream in ruflo is a follow-up
  gated on ruvector exposing a non-inert seam — not a kit patch. **[Open — filed at ruvector.]**

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

## Upstream issues (filed 2026‑05‑29)

F3 and F4 were each filed as a **separate, independently-reproduced** issue in the repo that
owns the code (not an omnibus), keeping #2222's evidence-first, reproducible tone:

| Finding | Repo (owns the code) | Issue | Reproduction |
|---|---|---|---|
| **F3** — route Q-state encoder discards the keyword block (31-bit hash-fold truncation); keyword-distinct tasks collapse to one Q-state | `ruvnet/ruflo` (`q-learning-router.js`) | [#2239](https://github.com/ruvnet/ruflo/issues/2239) | `ruflo-improvement-eval --probe-states`; group-survival + zero-keyword-groups probe |
| **F4** — SONA learn→inference loop unwired at the JS/WASM boundary (`learn_from_feedback` no-op; single-step REINFORCE Δ=0; up-only adaptation) | `ruvnet/ruvector` (`crates/sona`, `@ruvector/ruvllm`) | [#519](https://github.com/ruvnet/RuVector/issues/519) | `cargo test -p ruvector-sona --test repro_delta_zero` (4 cases, included in the issue) |

The downstream kit carry-forward — a **live RL statusline panel** (route ε/δ̄/|Q| from the
persisted Q-model, eval verdict, SONA signal gated on F4) — is tracked separately in
[pacphi/ruflo-machine-ref#8](https://github.com/pacphi/ruflo-machine-ref/issues/8) and is gated
on both upstream fixes landing.

Environment: ruflo 3.10.10, Node 26, `ruvnet/ruvector@c2089c4`. Repro tool:
`ruflo-improvement-eval` (https://github.com/pacphi/ruflo-machine-ref).
