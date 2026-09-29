# Follow ups v2: V4 branch plan

## Status

**Active, implementation accepted; final V4 gates pending (2026-09-29).** B1 merged in
PR #273. The remaining V4 implementation units are accepted on
`fix/follow-ups-v2-rest` at `3448e25c`, which includes the green `develop@989c5e56`
C4 integration, the reviewed runner identity follow-up `f80bc55e`, and the
independently accepted temporary C1 job removal `257e6940`. V3 dashboard changes
merged in #276; the C3 trace and C4 watch changes merged in #277 and #278.
The A3 ADR handoff and final C6 evidence alignment are being documented in this
branch. B13 required no product fix after the approved conditional check.
B6's extra Codex hook fix line remains deferred pending a Ruflo-supported answer
to #3419. The temporary C1 job has been removed; macOS/Linux AQE live-lock
conformance passed, but native Windows AQE was not run. Native Windows Ruflo
3.48.0 memory visibility was observed with its native bridge disabled. Final
whole-branch review, full local gates, feature PR CI including Windows, and
integration remain pending. This plan stays active; it does not claim main merge,
release, installation, or operational cleanup.

The [remediation program V4](2026-09-28-remediation-program-v2.md#v4-fixfollow-ups-v2-every-small-product-cli-and-upstream-item) defines scope. The [archived Branch 9 plan](../archive/2026-09-28-superpowers-plan-branch-9-follow-ups.md) supplies task details. Paths below name current source seams and focused test targets. After an explicit directory prefix, subsequent bare filenames in the same cell use that directory. A new test named below is a proposed file. Later implementers must verify dependencies before editing.

| Row | Source or artifact mapping | Focused proof and prerequisite |
| --- | --- | --- |
| A1 | `bin/agentic-kit.mjs`; `src/commands/usage.mjs`, `models.mjs`, `audit.mjs`, `heal.mjs`, `telemetry.mjs`, `x/host.mjs` | `tests/kit/cli-json-honesty.test.mjs`, `usage-cli.test.mjs`, `models-command.test.mjs`, `telemetry-cli.test.mjs`, `status-command.test.mjs`; include unknown models verb and status positional |
| A2 | `src/commands/x/host.mjs`; `bin/agentic-kit.mjs` | `tests/kit/host-dry-run.test.mjs`, `host-cli-migration.test.mjs`; pick refusal, off, reset-routes under `--dry-run --json` |
| A3 | `src/lib/versions.mjs`; `docs/adr/0063-evidence-store-and-refresh-vocabulary.md` | Accepted in `175677a6`; `versionCheck.self.attempt` and `lastTags` scope offline retries. ADR-0063 item 1 is amended in this branch; final gates remain pending |
| A4 | `src/commands/status.mjs`; `src/lib/refresh.mjs` | `tests/kit/refresh.test.mjs`, `status-version-drift-refresh.test.mjs`; injected `refreshStages` plus `service` builds no collector |
| B1 | `src/lib/paths.mjs`; `src/lib/footprint/index.mjs`, `storage.mjs`, `consumers.mjs`, `storage-reclaim-detectors.mjs`, `install.mjs`; `src/lib/host-readiness-local.mjs`, `live/process-sessions.mjs`, `hook-audit/providers/opencode.mjs`, `usage-opencode.mjs`; `src/commands/uninstall.mjs` | `tests/kit/xdg-relative.test.mjs` and specified regressions; exact-head CI gate passed before edit; preserve nullable OpenCode fallback |
| B2 | `src/commands/x/daemon-gc.mjs`, `src/commands/x/host.mjs`, `src/commands/setup.mjs` | New `tests/kit/daemon-gc-rerecord.test.mjs`, `setup-host-rerecord.test.mjs`, `host-pick-rerecord.test.mjs`; Branch 9 Task 8 plus deferred host pick; compare `sync-host-repair.test.mjs` |
| B3 | `src/lib/ruflo-memory.mjs`, `paths.mjs` | `tests/kit/ruflo-memory-location.test.mjs`, `project-memory-status.test.mjs`; compose both unsuitable reasons and make `inside()` exclude equality |
| B4 | `src/commands/status/sections/project-memory.mjs`; `src/lib/live-check-evidence.mjs`, `live-checks.mjs` | **Accepted:** distinct `memory-routes` evidence binds installed CLI version and platform; generic `memory` cannot lower the row. Focused evidence, runner, status, and routing tests cover pass, upgrade, failure, timeout, and read-only render. |
| B5 | `src/lib/project-memory.mjs`; `src/commands/status/sections/user-memory.mjs`, `codex-mcp.mjs`; #757 registry entry | **Accepted:** bounded ordinary dot-folder discovery, read-only AQE home data row, and an AQE-owned init hint. `tests/kit/project-memory.test.mjs`, `project-memory-status.test.mjs`, `ruflo-memory-location.test.mjs`, `status-command.test.mjs` cover the three units. No real store was merged or moved. |
| B6 | `src/commands/status/sections/ruflo-components.mjs` | **Accepted:** applied-but-unverified keeps its state and meaning in the message and gives one restart/recheck instruction in its manual fix. Rendered-row and neighboring-state tests cover the contract. The Codex-hooks fix line remains conditional on a Ruflo-supported answer to #3419 and a pre-PR recheck. |
| B7 | `src/lib/ruflo-daemon-config.mjs`; `src/commands/sync.mjs`, `sync/plan-versions.mjs` | `tests/kit/sync-daemon-repair.test.mjs`, `sync-dry-run-preview.test.mjs`, `sync-skip-versions.test.mjs`; F6 hidden YAML keys and F7 versions-only preview parity |
| B8 | `src/lib/maintenance/discovery/orchestrator.mjs`, `history.mjs` | `tests/kit/maintenance-discovery-orchestrator.test.mjs`, `maintenance-recovery.test.mjs`; restart after pause shows paused history |
| B9 | `src/lib/exec.mjs`, `execution/process-tree.mjs` | `tests/kit/process-tree.test.mjs`; abort kills descendants; Windows CI required |
| B10 | `src/lib/maintenance/discovery/partitions.mjs`; inventory `src/lib/live/jsonl-tailer.mjs`, `live/transcript-streams.mjs`, `telemetry/store.mjs`, `maintenance/management/service-store.mjs` for additional persisted IDs | `tests/kit/file-identity-bigint.test.mjs`; distinguish IDs above `2^53`; enumerate the exact sites before edit |
| B11 | `src/lib/live-checks.mjs` | `tests/kit/live-checks.test.mjs`; skipped deja-vu check says skipped and check-created temp folders are cleaned |
| B12 | `src/commands/setup.mjs`; `src/lib/memory-probe-cleanup.mjs` unchanged | **Fixed:** `tests/kit/setup-memory-probe.test.mjs`; Ruflo 3.48.0 seeded reproduction created an unused native side file, and a disposable candidate run confirmed a private mirror leaves no canonical side file or probe row |
| B13 | `src/commands/sync.mjs`; `src/lib/aqe-project-pin.mjs` | Conditional check found the AQE pin converged across all four targets; no B13 product fix was made |
| C1 | `.github/workflows/ci.yml`; `src/lib/aqe-readiness.mjs`; `src/lib/hook-audit/agentic-dependency-constraints.json` | **Accepted; temporary CI job removed:** native macOS and Linux live-owner probes on released AQE 3.14.4 omitted `FsyncFailed`; the exact exception is retired. Ordinary `LockHeld` remains busy, while any `FsyncFailed` fails. The temporary CI job was removed in `257e6940` after its evidence was reviewed. #240 closure waits for the final main PR. No native Windows AQE conformance is claimed. |
| C2 | `docs/host-support.md`; `src/lib/hook-audit/agentic-dependency-constraints.json` | `tests/kit/ruflo-support-window.test.mjs` plus link check; verify AQE 3.14.4 #528/#532/#535 and Ruflo #2356/#420 first |
| C3 | `.github/workflows/nightly.yml`; `scripts/trace-ort.mjs` | Merged #277; native macOS trace run 36567908852. Exact approved comment posted and body verified at [Ruflo #2885](https://github.com/ruvnet/ruflo/issues/2885#issuecomment-5891510508). The post-heal trace is noncausal; the learning step remains nonblocking even though its outer command exited 1. |
| C4 | `scripts/upstream-watch/classify.mjs`, `fetch.mjs`, `ledger.mjs`, `dispatch.mjs`, `render.mjs`; `src/lib/hook-audit/agentic-dependency-constraints.json` | Merged #278 as `989c5e56`; develop CI 36578593054 passed all 13 jobs. M10 remained declined. |
| C5 | `src/lib/aqe-guidance.mjs`; `src/commands/setup.mjs`; ignored `.superpowers/sdd/2026-09-28-follow-ups-v2/c5-issue-draft.md` | Approved exact AQE repeated-init issue posted as [#778](https://github.com/proffesor-for-testing/agentic-qe/issues/778); the 3.14.4 disposable repro does not establish 3.14.5 behavior |
| C6 | `docs/host-support.md`; `src/lib/ruflo-support-window.mjs`, `aqe-readiness.mjs`; `src/lib/hook-audit/agentic-dependency-constraints.json` | 2026-09-29 13:42 UTC registry: Ruflo 3.48.0, AQE 3.14.5, Codex 0.159.0. Narrow disposable Ruflo one-file scan and integrity-verified native Codex read-only App Server initialize passed; AQE 3.14.4/3.14.5 live-lock proof passed on macOS/Linux. No provider turn or native Windows AQE proof. Final V4 gates and PR CI pending |

B1 used disposable homes, guarded focused tests, and the ignored B1 report at `.superpowers/sdd/2026-09-28-follow-ups-v2/b1-report.md`. No shared manifests, lockfiles, ADR index, or decision log change belongs to this plan update. The controller owns integration and the whole-branch gate.
