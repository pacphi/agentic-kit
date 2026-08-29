# Prompts View — Design Spec

Status: draft for maintainer review · 2026-08-29
Companions: research findings + surfacing analysis (session scratchpad, re-runnable scripts), visual mockup <https://claude.ai/code/artifact/fd08cc85-85dc-4125-9078-622c9135d9bf>, Matrix A ADR (docs/adr/0038).

## 1. Purpose

A new **Usage → Prompts** secondary view (plus three Findings detectors and a CLI companion) that tells the operator what they actually ask across every host, which prompt patterns repeat wastefully, and what to change to gain efficiency — with **coaching that is recalculable, adaptive to the operator's own history, and accountable for its own outcomes**. Nothing in the view is a stored report; everything on the page can be regenerated from the corpus at any moment.

## 2. Evidence contract

### 2.1 Provenance filter (load-bearing)

The 2026-08-29 research measured that **only 27.6% of parser-visible user-role turns were typed by the human** (1,524 of 5,527); the rest is agent-to-agent traffic, harness envelopes, and agentic-kit's own headless spawns. Every metric in this view therefore computes over provenance-filtered prompts only. The classification rules ship in the docs and their residual risk is one-directional by design: an unrecognized machine template counts as human (over-statement, never under-statement).

**As shipped (schema 15), the vocabulary is four tags, not the research's five.** The research's `harness` class folds in UPSTREAM rather than becoming a tag: the parsers' own gate already routes harness envelopes to `kind: 'context'`, so they never reach the fingerprint layer to be tagged. The remaining four are `human`, `control` (slash records, interrupts, bash-input, image-only, session-continuation prose), `agent` (cross-session and teammate deliveries), and `adapter` (tool-authored headless templates). Two harness shapes that *were* leaking past the gate were fixed at their source rather than tagged: `<in-app-browser-context>` joined `HARNESS_OUTPUT_RE` (33 turns, which had also been inflating `prompts`), and session-continuation prose became `control` (18 turns). Measured residual is now zero — which is not the same as zero: an unseen machine template still counts as human.

Rules are admitted on measurement, not plausibility. Three shapes that look like siblings of admitted rules — `<command-args>`, `<system-reminder>`, "Please continue the conversation…" — each measured zero turns reaching `kind: 'prompt'` and are deliberately absent, as are two qe-court patterns the research proposed but the corpus never showed.

The fingerprinted **population differs per host** and must be compared per tag, never in total: opencode gates on nothing, claude on `userTurnKind`, codex additionally on `CODEX_MACHINE_ENVELOPE_RE` (which is why `agent` fingerprints appear on claude and never on codex).

Prerequisite parser fixes (in flight on PR #186 at spec time): `parseCodex` first-`session_meta`-wins (155/318 subagent rollouts escaped the replay guard) and the codex harness/mirror envelope gate for prompt counting. The view must not build on pre-fix numbers.

### 2.2 Fingerprints, not text (the F1 layer)

On the existing scan path, each `kind === 'prompt'` turn contributes `{ h, t, th, p }` to the session record — `sha256(normalizedText)[0..16)`, the token count, a sorted set of **4-byte** token hashes (`sha256(token)[0..8)`), and the provenance tag. **Prompt text is never persisted in the index and never crosses a wire.** Exact repeats, near-duplicate clustering (token-set Jaccard over token hashes), tap detection, and length stats all compute from fingerprints alone.

**Two bounds, both counted rather than silent:** 2,000 fingerprints per session (`promptFPOverflow` carries the excess), and **64 token hashes per fingerprint**. The second was added on measurement during the build. Unique-token counts are heavy-tailed (p50 60, p95 1,035, max 7,873), so an unbounded `th` measured **15 MB against a 2.1 MB index** — capping only the entry count would have been no bound at all, since one pasted document outweighs a hundred real instructions. Because the hashes are sorted and a hash is uniform with respect to its token, the kept 64 are a **bottom-k sketch**: a deterministic, unbiased sample and the standard input to a similarity estimate, not a truncation of the first 64 words.

| k | `th` storage | prompts sketched | Jaccard s.e. at J≈0.6 |
|---|---|---|---|
| unbounded | 15.0 MB | 0% | exact |
| 256 | 6.3 MB | 23% | 0.031 |
| 128 | 4.1 MB | 34% | 0.043 |
| **64 (shipped)** | **2.5 MB** | **49%** | **0.061** |
| 32 | 1.5 MB | 60% | 0.087 |

**Measured size, correcting this spec's original ≈220 KB estimate:** for a 60-day window — 2,173 sessions, 5,635 fingerprints — the layer costs **2.8 MB**, taking the index from 2.1 MB to **5.1 MB**. The original estimate was low by roughly 13x even after bounding, and by 68x unbounded. `MAX_TOKEN_HASHES` is a single named export if a different tradeoff is wanted; changing it requires a re-scan.

`h` is exact and never sketched, so equality questions ("is this the same prompt?") are unaffected by the bound; only similarity between two *long* prompts is estimated.

**The title-clip boundary.** One text field predates this work and is unchanged by it: `session.title` is the model-written title, or failing that the first 100 characters of the session's first prompt, secret-masked (`maskSecrets`) and written to the index at 0600. It is disclosed here because it is the single place prompt-derived text reaches the index — the fingerprint layer adds no second one, and the acceptance criterion in §10 is about the fingerprint layer, not a claim that the title changed.

### 2.3 Privacy split

- **Dashboard**: aggregates, counts, shares, trends, and pattern names drawn from a **fixed curated vocabulary** (e.g. "Release ritual", "Commit-and-push instruction") — never raw prompt text. Where an exemplar is genuinely needed, the row links to the existing masked `GET /api/session/:id` surface.
- **CLI (`ak usage prompts`)**: the exemplar-bearing tables (top short prompts, re-ask pairs, cluster exemplars, role-scaffolding list). Opt-in deep pass (`withTurns` re-read, ~4 s on this corpus); output never leaves the terminal; nothing persisted.
- The research reports themselves stay local for the same reason; they are not published artifacts.

## 3. The view (per the mockup)

Rail placement: `#usage/prompts`, between Findings and Sessions. Window selector applies (7/14/30d) with an **All history** option this view uniquely needs (patterns are lifetime phenomena); every figure carries the window it was computed over.

### 3.1 KPI strip

| KPI | Formula | Does not model |
|---|---|---|
| Typed prompts | count(provenance=human) and share of all user-role turns | intent quality; only authorship |
| Questions : instructions | published rule split (interrogative / imperative / declarative-feedback) | rhetorical questions; the rules are printable |
| Supervision taps | prompts ≤4 normalized tokens; share of typed; per-host deltas vs trailing baseline | the tap's necessity — some taps are legitimate approvals |
| Repeated share | prompts inside clusters spanning ≥3 sessions or ≥2 days | whether repetition was deliberate |
| Headless share | sessions and responses with zero human prompts | value of headless work (it is a reframe, not a criticism) |

Tap cost, when stated, is always the labeled model: `taps × median ctxLastTokens`, order-of-magnitude, mostly cache-priced.

### 3.2 Panels

1. **How you steer** — prompt-type taxonomy (ranked bars; Unclassified first-class and dim). Lexicon fixed in v1, published in docs; user-editable lexicon explicitly rejected for now.
2. **Host interplay** — monthly tap-share trend per host (the divergence is the headline: measured Claude 16.8→12.5% vs Codex 7.7→15.2%); p90 typed-prompt length per host with the role-scaffolding annotation. Unequal-window caveats render on the panel (Claude history spans 32 days on this machine).
3. **Repeated patterns** — table: curated pattern name, type chip, n/sessions/days/hosts, suggested-move chip (`skill candidate` / `CLAUDE.md line` / `reporting gap` / `role library`), masked-session link. Clustering is deliberately loose (Jaccard ≈0.6) with the type filter doing precision — **phrasing variance is the signal**: eleven wordings of one request outrank eleven identical ones.
4. **Coaching** — cards per §5.
5. **Also in Findings** — the three detectors (§4) render in the Findings tab with the standard card grammar; this panel cross-links.

### 3.3 CLI

`ak usage prompts [--window 7|14|30|all] [--json] [--enrich]` — sections mirroring the panels plus the exemplar tables. `--enrich` runs the delta-inference pass (§6.3). `--json` emits the aggregate projection (fingerprint-derived only — no text).

## 4. Findings detectors (adaptive thresholds)

Three new detectors in the existing `DETECTORS` contract, all computable from fingerprints:

| id | kind/sev | Fires when | Evidence line carries |
|---|---|---|---|
| `supervision-tap-share` | trend/warn | current-window tap share > operator's trailing-90d p75 for that host AND ≥20 taps | per-host split; the modelled-cost caveat verbatim |
| `headless-share` | coach/info | headless response share > 25% (informational reframe; models on detectSubagentShare) | sessions + responses counts |
| `host-prompt-asymmetry` | coach/info | p90 length ratio between hosts ≥1.5× OR persona-opening prompts ≥10 in window | the ratio; persona count; "no text on the wire" basis |

**No fixed percentages where a baseline can exist**: thresholds compare against the operator's own rolling history (per host), persisted as small aggregates in the index and recomputed each scan. Every fired finding prints the baseline it compared against.

## 5. Coaching cards

Contract:

- A card = finding (evidence + counts) → **Try** (one concrete change) → labeled cost/win basis → optional **Draft →** affordance.
- **Draft-only, always**: Draft → produces a suggestion (CLAUDE.md line, skill skeleton, role-library entry) the operator edits and applies themselves. Nothing writes to CLAUDE.md, creates a skill, or changes config unprompted.
- Every card carries `generated-at` + the **evidence hash** of the findings it derives from (§6.2).
- Initial card set (from the measured baseline): Codex role library (sibling effort, see §8), `/release` skill, commit-and-push instruction, Codex completion-criteria prompting, re-ask delta coaching, unprompted progress reporting.

## 6. Adaptive architecture (the non-static guarantee)

Three layers with different refresh contracts, plus a feedback loop.

### 6.1 Layer 1 — recalculable metrics (deterministic, every scan, free)

All §3 numbers are pure functions of the current corpus, re-derived on the same incremental scan the scorecard uses. No stored reports. New sessions change every figure on the next scan by construction.

### 6.2 Layer 2 — adaptive baselines (statistics, no inference)

Per-host rolling baselines (trailing-window percentiles, EWMA trends) persisted as small aggregates and recomputed each scan. Detector thresholds and "unusual for you" comparisons key on these, so the definition of normal moves with the operator. Fully explainable; every threshold printable; no model calls.

### 6.3 Layer 3 — learned artifacts (inference, delta-only, cached)

Model calls are reserved for two jobs rules cannot do:

1. **Labeling**: naming newly-born clusters and classifying the Unclassified residue — the `--enrich` precedent: cached per fingerprint/cluster id, so inference touches only artifacts created since the last pass. Settled labels are never re-judged.
2. **Coaching synthesis**: generating/refreshing cards from current findings. Each card stores the evidence hash of its inputs; a rescan that reproduces the hash leaves the cached card standing (with its as-of stamp); a moved hash marks the card **stale — Recompute** rather than silently spending tokens.

**Purity contract:** metrics are functions of the corpus; thresholds are functions of the operator's history; recommendations are functions of current findings plus a learned ranking. Everything is regenerable from scratch; the only persistent learning is the outcome ledger.

### 6.4 The outcome ledger (self-improving loop)

`measure → recommend → adopt/dismiss → measure outcome → recalibrate`, persisted in a kit-owned store beside the index (no prompt text; versioned):

- Recommendation records: `{ id, evidenceHash, status: proposed|adopted|dismissed|expired, generatedAt, outcome }`.
- **Adoption detection is deterministic first**: a matching skill now exists, a CLAUDE.md line matches the draft, the target cluster's recurrence collapsed.
- **Outcome checks are measured**: "commit-and-push cluster: 24 → 2 since adoption; tap share on affected host −4 pts" — rendered on the card. Adopted-and-worked raises ranking of similar future recommendations; **dismissed is suppressed and decays (never re-nagged)**; adopted-but-didn't-help is **retired with the refutation shown**.
- Substrate: kit-local store in v1; ruflo/agentdb pattern memory is a candidate for cross-session substrate to be grounded and evaluated at build time (not asserted here).

### 6.5 Scheduling

- **On-demand default**: layers 1–2 at scan time (free). Layer-3 via the view's Recompute affordance or `ak usage prompts --enrich`.
- **Scheduled opt-in**: a periodic digest (e.g. weekly) running the delta-inference pass through existing governed machinery (daemon AI workers under the launch budget, or a scheduled routine). Always budget-capped, stamped "scheduled pass · $basis", never default-on. Unattended token spend stays opt-in on this machine by standing policy.
- Staleness is always visible: evidence-hash drift renders an explicit stale marker (System deep-scan freshness precedent).

## 7. Rejected / non-goals

- **Real-time re-ask nudging** (reading the user's prompt against history mid-session): surveillance-shaped; rejected.
- **Persisting normalized prompt text in the index** (F3): outside the masking contract; fingerprints + on-demand deep pass cover every need.
- **Static thresholds** for anything a personal baseline can govern.
- **Auto-applying any recommendation.**
- **User-editable lexicon in v1**; the Unclassified share is the honest signal for lexicon work.
- Exact/0.9-similarity boilerplate detection as a primary signal (measured: finds ≈471 tokens; the real signal is loose-cluster phrasing variance and host asymmetry).

## 8. Sibling effort (out of this spec's scope)

**Codex role library** — the single largest measured win (46 persona prompts, ≈76K tokens, one host) belongs to `ak host`/`ak run` (a managed prompt-fragment directory injected for Codex workers; the Codex analogue of `.claude/agents/`). This spec's coaching card links to it; its design is a separate spec.

Cross-host mirror dedup (exact-twin prompts counted once) remains a recorded follow-up in ADR-0038's deferred list.

## 9. Sequencing (build order)

1. Parser fixes (prerequisite; on PR #186).
2. F1 fingerprints + provenance tagging on the scan path (schema bump).
3. Baselines (layer 2) + the three detectors.
4. The Prompts view panels (dashboard) + `ak usage prompts` CLI.
5. Coaching cards with evidence hashes + the outcome ledger (deterministic adoption detection first).
6. Layer-3 enrichment (labeling + coaching synthesis, on-demand) and, last, the opt-in scheduled digest.

## 10. Acceptance criteria (sketch)

- Zero prompt text added to any index file or HTTP payload by this work (test-pinned, same tier as the live-snapshot field tests). The pre-existing masked 100-char `session.title` is the one prompt-derived text field and is explicitly out of scope — §2.2. Shipped: a parsed record serialized to JSON contains no fixture prompt string, and every fingerprint entry carries only keys from the allowed set `{h,t,th,p,q,o}` (`q`/`o` are the optional question/persona flags added with schema 16; omitted when falsy), verified structurally across the whole corpus.
- Every rendered figure reproducible by an exported script over the same corpus; every threshold printable with its baseline.
- A rescan with unchanged corpus reproduces identical metrics AND identical evidence hashes (determinism pin).
- Coaching cards regenerate only on hash change; dismissal persistence survives rescans and schema bumps.
- Detector/aggregate additions carry their metrics-doc sections (formula + what-this-does-not-model) and pass doc-citations.
