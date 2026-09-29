# Dashboard Refresh delivery plan

## Status

**Active, implementation reviewed** — Tasks 6c-1 through 6c-5 and the scoped live-view follow-up passed independent review on `feat/dashboard-refresh`. The branch is not integrated: V5 integration, full gates, and whole-branch review remain. Source baseline: `develop@bd6b4f0fc33b68812497922ab9bc8467e3d4d443`.

Implement the deferred 6c work in order, with one reviewed task and unit commit at a time. The [remediation program](2026-09-28-remediation-program-v2.md) and [6b handoff](../archive/2026-09-28-superpowers-plan-branch-6b-one-refresh-flag.md) define the contracts. A passing exact-head develop CI gate precedes production edits. Tests use sandbox state and injected services; final branch gates and integration belong to the controller.

| Task | Dependency | Code and proof |
| --- | --- | --- |
| 6c-1: additive server operation | 6b Tasks 2 and 4 | Add `dashboard/refresh-api.mjs` with shared stage runner, single-flight state, validated POST and GET; wire it into `dashboard-server.mjs` without changing the client or poll cost. Add API, security, stage and cost tests. This dispatch only. |
| 6c-2: one Refresh control | 6c-1, 6b Tasks 2, 3 and 5 | Add `client/refresh-control.mjs`; wire page, boot and client views to POST once, poll only the page's operation, and reload the active view. Remove retired controls. Prove request counts, stage progress, blocked Maintenance writes, host consent and narrow-screen UI. |
| 6c-3: read-only GET routes | 6c-2 | Reject scan-starting GET query parameters, remove GET scan paths and `/api/host-health/local`; keep the 6c-1 stage's Maintenance and inventory refresh dependencies. Prove all GET routes have no scan side effects. |
| 6c-4: current vocabulary | 6c-1 through 6c-3, 6b Task 13 | Extend the vocabulary guard for retired dashboard strings and legacy refresh URLs; update dashboard, Maintenance, upgrading, DDD and installed guidance. Include the remaining README/dashboard noun and `maintenance-discovery.mjs` string. Check links and Markdown. |
| 6c-5: decisions and supersessions | 6c-1 through 6c-4, 6b Task 14 | Reconcile ADR-0063 with ADR-0048, ADR-0025, ADR-0045, ADR-0044 and ADR-0053, including index/status rows and the decision log; record actual POST behavior and read-only GETs. Run docs and final branch gates. |

V3 carry-ins from the program:

- **6c-2 client fixes:** B0-22 shows the Claude Code badge as "Unknown" when Configuration was not assessed. B0-23 measures the Codex header icon against WCAG's 3:1 non-text contrast minimum and changes it only if the measurement fails. B6a-12 makes `mntSyncHash` and `mntApplyHashState` re-derive state from `location.hash` if 6c-2 touches that code; otherwise open a small issue.
- **6c-5 decision record:** B6a-9 requires ADR-0063 to state that two dashboard tabs share one server process's module state. If 6c-1's tests build the `ruflo-components` path, cover its cwd case; otherwise record the ruling that drops that test case. ADR-0048's status line moves its human-evaluation gates to v5 under D-15.
- **Live view (#256):** Confirm the session re-read changes no total before documenting D-18; if it does, apply D-18's offset alternative. Label the structured live-events input experimental under D-19. Observe a plain-folder, non-Git bind on a real machine once and fix what the observation shows.
- **Live-view follow-up (2026-09-29):** A nonzero regression showed that bounded-window re-entry increased the accepted-record total, so D-18 now retains displaced native readers and offsets in a bounded in-memory map. A genuine Codex transcript kept accepted, session, and project totals stable across idle restart and window re-entry in an isolated service probe. Eviction can still replay old records, and a new service process has no persisted offset; this does not establish exactly-once delivery or unchanged historical token accounting. D-19's structured live-events input is experimental; no real producer was verified. See the V3 live-view report.
- **Plain-folder native proof (2026-09-29):** An independently reviewed, genuine Codex `0.159.0` native `thread/fork` created a new transcript in an isolated plain folder. The real process survey and `LiveSessionsService` joined the actual host PID/cwd to that new transcript, with observed presence. The copied parent retained its exact upstream bytes and remained presence-unknown. The five-session service snapshot included unrelated controllers; it does not show five plain-folder joins. This was an idle fork with no `turn/start`, inference, billing measurement, detailed activity proof, or browser journey. The fork's empty RPC `turns` field does not mean its copied history was empty. See the V3 plain-native report.
- **Evidence-gated issue #254:** Diagnose the "CONNECTING" stall only if the browser network trace specified by the program arrives; otherwise leave it to V7.
- **Pre-PR:** Re-check the `codex app-server` read-only flags against the newest Codex. The controller observed installed `0.158.0` and latest `0.158.0` at planning time; revalidate both versions and the flags at the gate.

Extend 6c-4's guard exclusions to `docs/plans/` and the current archive/proposal/ADR layout. Move this finished plan to `docs/archive/` in the completing pull request with an archive index row.
