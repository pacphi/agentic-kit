# docs/archive — historical record

Documents in this directory are **frozen**: they describe investigations, incidents, and
design work that shaped this kit but whose subject matter has since been resolved —
mostly by upstream ruflo/agentic-qe releases (baseline: ruflo 3.28.0 / agentic-qe 3.12.2,
2026-07-14). They are kept verbatim as provenance for *why* the kit's surviving pieces
exist. Do not update them; the living docs are `../BACKGROUND.md`,
`../TROUBLESHOOTING.md`, and `../CONDITIONAL-BLOCKS.md`.

## Index

| File | Original location | What it was | Why it's historical |
|---|---|---|---|
| [2026-06-upstream-findings-f1-f6.md](2026-06-upstream-findings-f1-f6.md) | `docs/upstream/ruflo-self-improvement-findings.md` | The F1–F6 findings series: proofs/refutations of ruflo's self-improvement claims (Q-learning persistence, state-encoder collapse, SONA learn→inference wiring, native-training misreporting), with filed upstream issues. | Every finding is now fixed upstream: F2 in 3.10.6 ([#2222](https://github.com/ruvnet/ruflo/issues/2222)), F2b in 3.10.7, F3 in 3.10.11 ([#2239](https://github.com/ruvnet/ruflo/issues/2239)), F4 in `@ruvector/ruvllm` 2.5.6 ([RuVector#519](https://github.com/ruvnet/RuVector/issues/519)), F6 in 3.18.1/3.19.0 + ruvllm 2.5.7 ([#2549](https://github.com/ruvnet/ruflo/issues/2549), closed 2026-07-03). |
| [2026-06-token-consumption-incident.md](2026-06-token-consumption-incident.md) | `docs/usage/token-consumption-findings-and-mitigation-2026-06.md` | Root-cause report for the June 2026 token-burn incident: six immortal auto-started daemons consumed ~8.1B tokens over 7 days via headless worker sessions. Produced the opt-in daemon policy, TTL reaper, ⚙ statusline alarm, and `ruflo-token-audit`. | The root cause was fixed upstream in ruflo 3.27/3.28 ([#2661](https://github.com/ruvnet/ruflo/issues/2661)): AI workers are opt-in, launches are governed by a machine-wide budget with telemetry, one supervisor daemon per repo, native daemon TTL. The kit's daemon policy flipped back to default-on (local-only workers) on that baseline; the reapers and token-audit remain as an independent check. |
| [2026-06-11-token-consumption-recurrence.md](2026-06-11-token-consumption-recurrence.md) | `docs/usage/token-consumption-recurrence-and-cleanup-2026-06-11.md` | Follow-up audit 10 days later: 17 daemons had accumulated but the TTL auto-reaper had already contained them; cleanup of daemon-state files, logs, and two plugin MCP servers. | Same incident class as above — governed upstream since 3.27/3.28. Kept as evidence the TTL-reaper safety net worked. |
| [2026-05-28-superpowers-plan-ruvector-self-learning-aqe-security.md](2026-05-28-superpowers-plan-ruvector-self-learning-aqe-security.md) / [spec](2026-05-28-superpowers-spec-ruvector-self-learning-aqe-security.md) | `docs/superpowers/{plans,specs}/` | Plan + design for proving/repairing the ruvector stack (native better-sqlite3, RVF pattern store, solver) across ruflo and agentic-qe; produced `ruflo-enable-learning`, `ruflo-verify-aqe`, the RVF repair. | Implemented and shipped; the tools it produced live in `bin/` and `shell/`. Version targets in the text (ruflo 3.10.x) are frozen history. |
| [2026-05-28-superpowers-plan-self-improvement-eval.md](2026-05-28-superpowers-plan-self-improvement-eval.md) / [spec](2026-05-28-superpowers-spec-self-improvement-eval.md) | `docs/superpowers/{plans,specs}/` | Plan + design for `ruflo-improvement-eval`, the pre-registered causal test (permutation p, Cohen's d, ablation) that the route Q-learner actually self-improves. | Self-labeled HISTORICAL even before archiving: the F2/F3 bugs it was designed around were fixed upstream (3.10.6–3.10.11). The eval tool itself survives in `bin/ruflo-improvement-eval`. |
| [2026-05-29-superpowers-plan-daemon-statusline-resource-fix.md](2026-05-29-superpowers-plan-daemon-statusline-resource-fix.md) / [spec](2026-05-29-superpowers-spec-daemon-statusline-resource-fix.md) | `docs/superpowers/{plans,specs}/` | Plan + design for the daemon-hygiene suite (TTL reaper, auto-reap, ⚙ alarm) and statusline resource fixes. | Shipped; and the hazard it defended against is now bounded upstream (#2661). The surviving pieces were recalibrated for the daemon-default-on posture in July 2026. |
| [2026-05-29-superpowers-plan-install-onboarding-ux.md](2026-05-29-superpowers-plan-install-onboarding-ux.md) / [spec](2026-05-29-superpowers-spec-install-onboarding-ux.md) | `docs/superpowers/{plans,specs}/` | Plan + design for `install.sh` profiles, `ruflo-onboard`, `ruflo-resync`, and the conditional CLAUDE.md block system. | Implemented and shipped; `docs/CONDITIONAL-BLOCKS.md` is the living description of the block system. |

## Naming convention

`YYYY-MM[-DD]-<origin>-<topic>.md` — date of the original work, then its provenance
(`superpowers-plan` / `superpowers-spec` / `upstream` findings / incident reports),
then the topic. Internal links between archived files were rewritten to same-directory
targets when the tree was flattened (2026-07-14); quoted transcripts inside the
incident reports intentionally keep their original, now-dangling paths.

## Added 2026-07-14 — the shell-kit era ends (v4 npm cutover)

| File | Original location | What it was | Why it's historical |
|---|---|---|---|
| [2026-07-14-shell-kit-readme.md](2026-07-14-shell-kit-readme.md) | `README.md` | The shell-kit README (install.sh profiles, 16 shell commands, the full "what's actually wrong" story). | Replaced by the v4 npm kit (`ruflo-kit` — 4 verbs) and a rewritten README. |
| [2026-07-14-shell-kit-background.md](2026-07-14-shell-kit-background.md) | `docs/BACKGROUND.md` | Root-cause investigation behind every guard: Node-ABI/WASM memory loss, dormant self-learning, aqe's variant, the security surface, the Δ‖W‖ tracker design. | The guards live on inside `ruflo-kit` (`src/lib/`); the investigation is finished history. Still the best deep-dive on *why*. |
| [2026-07-14-shell-kit-troubleshooting.md](2026-07-14-shell-kit-troubleshooting.md) | `docs/TROUBLESHOOTING.md` | Symptom→fix runbook keyed to the shell commands (`ruflo-resync`, `ruflo-patch-native`, …). | Superseded by the much shorter npm-command runbook at `../TROUBLESHOOTING.md` (`status` to look, `sync` to fix). |
| [2026-07-14-shell-kit-conditional-blocks.md](2026-07-14-shell-kit-conditional-blocks.md) | `docs/CONDITIONAL-BLOCKS.md` | Design doc for the sentinel-block registry in shell (`_ruflo_cond_blocks`). | The mechanism ported to `src/lib/blocks.mjs` with a user-extensible registry (custom rows + declarative detectors in `kit.json`); sentinel format unchanged. |
