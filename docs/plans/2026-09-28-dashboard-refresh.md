# Dashboard Refresh delivery plan

Status: Active. Branch: `feat/dashboard-refresh`. Source: `develop@e2f9dcae0554ff63921df618a819fd5e6afe80d2`.

Implement the deferred 6c work in order, with one reviewed task and unit commit at a time. The [remediation program](2026-09-28-remediation-program-v2.md) and [6b handoff](../archive/2026-09-28-superpowers-plan-branch-6b-one-refresh-flag.md) define the contracts. A passing exact-head develop CI gate precedes production edits. Tests use sandbox state and injected services; final branch gates and integration belong to the controller.

| Task | Dependency | Code and proof |
| --- | --- | --- |
| 6c-1: additive server operation | 6b Tasks 2 and 4 | Add `dashboard/refresh-api.mjs` with shared stage runner, single-flight state, validated POST and GET; wire it into `dashboard-server.mjs` without changing the client or poll cost. Add API, security, stage and cost tests. This dispatch only. |
| 6c-2: one Refresh control | 6c-1, 6b Tasks 2, 3 and 5 | Add `client/refresh-control.mjs`; wire page, boot and client views to POST once, poll only the page's operation, and reload the active view. Remove retired controls. Prove request counts, stage progress, blocked Maintenance writes, host consent and narrow-screen UI. |
| 6c-3: read-only GET routes | 6c-2 | Reject scan-starting GET query parameters, remove GET scan paths and `/api/host-health/local`; keep the 6c-1 stage's Maintenance and inventory refresh dependencies. Prove all GET routes have no scan side effects. |
| 6c-4: current vocabulary | 6c-1 through 6c-3, 6b Task 13 | Extend the vocabulary guard for retired dashboard strings and legacy refresh URLs; update dashboard, Maintenance, upgrading, DDD and installed guidance. Include the remaining README/dashboard noun and `maintenance-discovery.mjs` string. Check links and Markdown. |
| 6c-5: decisions and supersessions | 6c-1 through 6c-4, 6b Task 14 | Reconcile ADR-0063 with ADR-0048, ADR-0025, ADR-0045, ADR-0044 and ADR-0053, including index/status rows and the decision log; record actual POST behavior and read-only GETs. Run docs and final branch gates. |

V3 carry-ins from the program: 6c-2 also resolves B6a-12 hash-state recomputation if it touches that code, or opens a small issue; it resolves B6a-9 via the tested `ruflo-components` cwd path when 6c-1 tests exercise that route, otherwise records the ruling. Confirm #256's plain-folder real-machine bind and the session re-read total before documenting D-18; describe the structured live-events input as experimental under D-19. Diagnose #254 only if a network trace arrives. Extend 6c-4's guard exclusions to `docs/plans/` and the current archive/proposal/ADR layout. Move this finished plan to `docs/archive/` in the completing pull request with an archive index row. ADR-0048 human-evaluation gates remain for v5 per D-15.
