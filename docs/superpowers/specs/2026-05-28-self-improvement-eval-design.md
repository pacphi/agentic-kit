# Design: Proving (and surfacing) self-improvement — `ruflo-improvement-eval` + RL status-line telemetry

- **Status:** Draft (awaiting user review)
- **Branch:** `feat/self-improvement-eval`
- **Date:** 2026-05-28
- **Author:** Chris Phillipson (with Claude)
- **Builds on:** the merged self-learning/agentic-qe/security work (PR #1)

## 0. Plain-language primer (read this first — no ML background needed)

Use a **delivery company** as the analogy. ruflo has *three different* learning systems
that people often conflate:

1. **The Q-learner = the dispatcher.** Its job: "which specialist should handle this
   task?" (coder, tester, reviewer…). It keeps a scorecard of which agent tends to do
   well on which kind of task and updates it from results. "Q-learning" is just the
   textbook name for *try → see if it worked → nudge the preference*.
   - **ε (epsilon)** — how often it gambles on a random pick vs. its current favorite.
     Starts at **1.0 (100% random)**; should **shrink** as it learns to trust itself.
     Stuck at 1.0 = "still guessing, hasn't committed to anything learned."
   - **TD error (δ)** — "how surprised it was": the gap between expectation and outcome.
     Shrinking toward 0 = its expectations now match reality (it has converged).
   - **|Q| (Q-table size)** — how many distinct task-types it has opinions about.

2. **SONA = a driver's real-time muscle memory.** A fast engine that nudges itself after
   each action based on whether it went well. It banks **trajectories** (sequences of
   what it did) and **patterns** (distilled "this worked" recipes) — the counts in the
   status line.

3. **LoRA = the *format* SONA stores its tweaks in.** "Low-Rank Adaptation" — instead of
   rewriting the whole brain, it keeps a small **diff sheet of sticky-note corrections**
   on a frozen base. **Δ LoRA** = "how big was the *last* tweak" (≈0 = barely adjusted).

**The crux (the Tier-2 gap):** the LoRA sticky-notes *are being written* (they pile up),
**but when ruflo decides which agent to use it never *reads* them** — it reads a simpler
"confidence" number instead. So the notes accumulate yet change no decision. Wiring the
decision to read them is a change *inside ruflo* (Tier 2), which we don't own.

**Why this work is worth doing now, without the Tier-2 fix** — there are two learning
loops, in very different shape:

| Loop | Learns? | Does its learning change decisions today? |
|---|---|---|
| **Q-learner (dispatcher)** | Yes | **Yes — wired end-to-end** |
| **SONA/LoRA (driver notes)** | Yes | **No — not consumed (Tier-2 gap)** |

This work proves the **Q-learner loop** self-improves — a loop that genuinely drives
behavior today. It (1) answers "is it self-improving?" with measured evidence instead of
a hand-wave, (2) shows that proof on the status line in credible terms, (3) documents the
two real bugs (CLI feedback never saves; LoRA never read), and (4) builds the exact
measuring stick Tier-2 will need (re-run the same A/B once LoRA-consumption is fixed
upstream). We prove what's true (the dispatcher improves) and clearly label what isn't yet
(the driver-notes path). That honesty *is* the value.

## 1. Problem

The kit proved the system is **self-learning** (experience accumulates and persists). It
did **not** prove **self-improving** — that accumulated experience measurably changes
behavior for the better. A peer review (Ciprian Melian) reached the same verdict:
*self-improving is not proven* — routing confidence is flat, the trained LoRA isn't
consumed at inference, and there is no held-out/A-B instrument showing quality trending
up. This work builds that instrument for the loop that *is* consumed, and surfaces the
result on the status line in terms an AI/ML audience recognizes.

### 1.1 Source-validated findings (ruflo 3.10.5)

Verified by reading ruflo source and probing in isolation:

| # | Finding | Evidence | Consequence for design |
|---|---|---|---|
| F1 | The route Q-learner genuinely learns **in-process** | 200 in-process `update()`s → `updateCount 200`, `qTableSize 4`, `epsilon 1.0→0.913`, `avgTDError 0.125` | Drive the eval **in one Node process** using ruflo's real `createQLearningRouter`. |
| F2 | **CLI `route feedback` cannot accumulate** (a genuine bug) | `q-learning-router.js`: `autoSaveInterval: 100`; `route.js` `feedbackCommand` calls `update()` but never `saveModel()` → each one-update process exits without persisting → `route stats` permanently `updateCount 0 / ε 1.0` | Do **not** drive via repeated CLI calls; do **not** source any status-line signal from `route stats`. File/document upstream. |
| F3 | The router is **tabular** Q-learning over discrete keyword-hash states (`FEATURE_KEYWORDS` → state; 8 `ROUTE_NAMES` actions) | `q-learning-router.js:42-72` | "Held-out" = held-out task *instances/phrasings from the same state distribution*, evaluated greedily — not novel unseen states. Frame the proof honestly. |
| F4 | `routing_outcomes` records `quality_score`, `success`, `followed_recommendation` per decision | `.schema routing_outcomes` | Available as a secondary, ruflo-native metric (AQE path); the primary metric is in-process accuracy vs known-best. |
| F5 | The trained LoRA `B` matrix is **not consumed at inference** for routing | `forward_array` (B path) only in `ruvector-training.js`; routing consumes pattern-confidence scalars (`intelligence.js:188`) | Proving the LoRA path self-improves is **out of scope (Tier 2)** — documented, not built. |

## 2. Goals / Non-goals

**Goals**
- G1. Build `ruflo-improvement-eval`: an in-process, held-out, ablated experiment that
  proves (or refutes) that ruflo's route Q-learner self-improves from experience.
- G2. Use a falsifiable, pre-registered proof: held-out greedy accuracy rises with
  training and ≫ cold baseline; a no-update ablation stays flat; corroborated by ε decay
  and TD-error convergence; multi-seed to beat noise.
- G3. Emit a machine-readable result (`.claude-flow/improvement.json`) and a human ASCII
  learning curve + PASS/FAIL verdict.
- G4. Add an academically-literate **`📈 RL` telemetry line** to the status-line footer
  that renders the eval result (learning-curve sparkline, held-out accuracy, effect size
  + CI, ε decay, mean TD error, |Q|).
- G5. Document Tier 2 (proving the LoRA/SONA path) — what it requires and the expected
  outcomes — and document finding F2 as an upstream bug.

**Non-goals**
- N1. Do **not** patch ruflo source to consume the LoRA `B` at inference (Tier 2).
- N2. Do **not** run real LLM agents — the environment is synthetic-reward (deterministic,
  free, reproducible-in-aggregate).
- N3. Do **not** source any status-line signal from `route stats` (F2: broken).
- N4. No claim of generalization to *unseen states* (F3: tabular).

## 3. Architecture

```
ruflo-improvement-eval  (Node .mjs — in-process, per F1/F2)
  ├─ Environment      fixed task suite; each task → known-best agent; reward = match
  ├─ Protocol         cold baseline → train K → checkpoint eval (greedy) → ablation → N seeds
  ├─ Metrics          held-out accuracy, mean reward, ε, avgTDError, |Q|; effect size + CI
  ├─ Report           ASCII learning curve + PASS/FAIL to stdout
  └─ Result file      .claude-flow/improvement.json {curve[], coldAcc, warmAcc, deltaPP, ci,
                          epsilon0, epsilonF, tdError, qSize, seeds, verdict, ts}
                                   │
                                   ▼
shell/ruflo-functions.sh  (statusline footer helper — append-only, fs-only)
  └─ 📈 RL line: render improvement.json → sparkline · acc cold→warm · Δpp (CI) · ε↓ · δ̄↓ · |Q|
```

### 3.1 Component contracts

**`bin/ruflo-improvement-eval`** (new; Node, `#!/usr/bin/env node`)
- *Does:* runs the full experiment in one process against ruflo's real
  `createQLearningRouter` (resolved from the global `@claude-flow/cli`); prints the curve
  + verdict; writes `improvement.json` into `./.claude-flow/`.
- *Input:* flags `--episodes K` (default 300), `--seeds N` (default 5), `--checkpoints`
  (default `0,25,50,100,200,300`), `--json`, `--quiet`. `--check` to only print the last
  cached result.
- *Output:* exit 0 if self-improvement is demonstrated (PASS criteria in R4), 1 if not
  (flat/ablation-indistinguishable), 2 on env error.
- *Depends on:* global ruflo (`@claude-flow/cli` → `ruvector/index.js`), node.

**Synthetic environment** (inline in the harness)
- A fixed list of `{task, bestAgent}` where `bestAgent ∈ ROUTE_NAMES` and `task` contains
  the `FEATURE_KEYWORDS` that map to a distinct state (e.g. "write unit tests for the
  payment module" → tester). Split into TRAIN and EVAL instances (EVAL includes reworded
  phrasings mapping to trained states, to show it learned the state→agent map, not strings).
- Reward: `+1` if the router's chosen action == `bestAgent`, else `-1` (clamped to router's
  [-1,1]).

**Statusline `📈 RL` segment** (extends the existing footer helper in `ruflo-functions.sh`)
- *Does:* if `.claude-flow/improvement.json` exists, append one line:
  `📈 RL  <sparkline>  acc <cold%>→<warm%>  Δ<+pp> (95% CI ±<x>)  ·  ε <e0>→<ef>↓  ·  δ̄ <td>↓  ·  |Q| <n>`.
  Renders nothing if the file is absent.
- *Depends on:* `fs` only (cheap; no subprocess) — the heavy computation already happened
  in the eval.
- *Idempotent / upgrade-safe:* same marker-guarded injector as the existing footer.

## 4. Requirements

### Eval harness
- **R1.** MUST run entirely in one Node process using ruflo's shipped
  `createQLearningRouter` (not a reimplementation, not repeated CLI calls).
- **R2.** MUST measure **cold baseline** (fresh router, exploration off, greedy) accuracy on
  the EVAL split before any training.
- **R3.** MUST train K episodes on the TRAIN split (decide-with-exploration → reward →
  `update`), evaluating EVAL **greedily (exploration off, no updates)** at each checkpoint.
- **R4.** PASS criteria (pre-registered, all must hold): (a) mean held-out accuracy at final
  checkpoint ≥ cold baseline + a margin (default ≥ +20pp) and ≥ a floor (default ≥ 0.6);
  (b) the curve is non-decreasing across checkpoints within noise; (c) the **no-update
  ablation** stays within noise of chance (`1/numActions`); (d) results aggregated over
  N seeds with a reported CI. Fail otherwise.
- **R5.** MUST run a **no-update ablation** (same decisions, rewards withheld / `update`
  skipped) and assert it does **not** improve — proving gains are *caused* by learning.
- **R6.** MUST aggregate over N seeds (router uses unseedable `Math.random`) and report
  mean ± CI; MUST NOT claim improvement from a single run.
- **R7.** MUST write `.claude-flow/improvement.json` with the curve, cold/warm accuracy,
  effect size + CI, ε (initial/final), avgTDError, |Q|, seed count, verdict, timestamp.
- **R8.** MUST print an ASCII learning curve and a clear PASS/FAIL verdict; honor `--json`.

### Status line
- **R9.** The footer MUST gain a `📈 RL` line rendered **only** when
  `.claude-flow/improvement.json` exists, showing: learning-curve sparkline, held-out
  accuracy cold→warm, effect size Δpp with CI, ε decay, mean TD error, and |Q|.
- **R10.** The `📈 RL` line MUST be fs-only (no subprocess), marker-guarded, and injected by
  the existing upgrade-safe statusline patcher (so `ruflo-resync` maintains it).
- **R11.** The kit MUST NOT render any learning/improvement signal sourced from
  `route stats` (F2: permanently `0 / ε 1.0`); a code comment + docs MUST state why.

### Honesty / scope
- **R12.** Docs MUST state the proof covers the **route Q-learning loop only** (tabular,
  same-distribution held-out instances), not the LoRA/SONA path (Tier 2) and not unseen
  states (F3).
- **R13.** Docs MUST capture finding F2 (CLI `route feedback` non-persistence) as an
  upstream bug, with the one-line fix (call `saveModel()` after `update()`, or
  `autoSaveInterval: 1`).
- **R14.** All new shell remains bash 3.2-compatible; the harness is Node and degrades
  gracefully if the global ruflo router module can't be resolved (exit 2 with guidance).

## 5. Behavioral scenarios

- **S1 (proof passes):** cold acc ≈ 1/8 (~12%); after K=300 over 5 seeds, held-out greedy
  acc ≈ 75–90%; ablation stays ≈ 12%; ε decayed, δ̄ shrunk → verdict PASS; footer shows
  `📈 RL ▁▂▄▆▇ acc 12%→78% Δ+66pp (95% CI ±7) · ε1.0→0.12↓ · δ̄0.01↓ · |Q|24`.
- **S2 (honest failure):** if held-out acc does **not** beat the ablation beyond CI, verdict
  FAIL and the footer reads `◷ RL unproven` — we report the negative result truthfully.
- **S3 (no eval run yet):** `improvement.json` absent → footer omits the `📈 RL` line
  entirely (no false signal).
- **S4 (smoke run, this session):** a bounded run (small K, few seeds) demonstrates the
  mechanism end-to-end and writes a real `improvement.json` on this machine.
- **S5 (upgrade):** after `ruflo init`/upgrade regenerates the statusline, `ruflo-resync`
  re-injects the `📈 RL` segment (marker-guarded).

## 6. Testing

- The harness is largely self-testing (it *is* an experiment): the ablation (R5) is the
  internal control; the seed CI (R6) is the noise guard.
- Add a fast self-check mode (tiny K/seeds) used as the smoke test (S4).
- Manual acceptance on this machine: capture the before/after `improvement.json` + the
  rendered footer line in the branch.

## 7. Tier 2 (documented, not built): proving the LoRA/SONA path

To prove the *neural* self-improvement arm (Ciprian's open item), a future effort would:
1. **Close the integration gap (F5):** patch ruflo so the trained MicroLoRA `B` matrix is
   consumed at inference (the `forward_array` path feeds the routing/decision scalars),
   not just trained and stored.
2. **Re-run this same held-out A/B** with LoRA-consumption ON vs OFF — proof = the
   LoRA-on arm beats LoRA-off beyond CI on held-out tasks.
3. **Expected outcome if it works:** a measurable held-out lift attributable specifically
   to the consumed LoRA delta (today `Δ LoRA` grows but alters no decision).
This is an upstream source change (a ruflo PR), hence out of scope here.

## 8. Open questions / risks

- **Q1.** State granularity (F3): `qTableSize` was 4 for 5 tasks — some tasks share a
  keyword-hash state. The suite MUST be designed so each intended state is distinct and its
  best agent unambiguous; verify `|Q|` matches the number of intended states during
  implementation.
- **Q2.** Epsilon decay was slow (0.913 after 200). K and the decay schedule must be large
  enough that greedy eval actually exploits; tune during the smoke run.
- **Q3.** Determinism: unseedable `Math.random` → rely on multi-seed aggregation + CI, not
  exact reproducibility.
