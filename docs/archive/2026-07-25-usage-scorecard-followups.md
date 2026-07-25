# Follow-ups — usage scorecard (ADR-0009)

Open items left after PR #56 merged. None is security-relevant; all were found
by review and recorded rather than quietly dropped. Copy the prompt below into a
fresh session.

---

## Prompt

> Context: `agentic-kit` shipped the usage scorecard in PR #56 (ADR-0009, merged
> as `dce1dc0`). Two QE reviews found items that were deliberately deferred.
> Read `docs/adr/0009-usage-scorecard-local-transcript-analytics.md` and
> `docs/archive/2026-07-25-superpowers-spec-usage-scorecard.md` first — the ADR's
> §6 evidence rules constrain what any finding is allowed to claim, and §4 and
> §4b constrain how time and projects may be reported. Do not relax those.
>
> Work through the items below. For each: write the failing test first, fix, then
> run `pnpm run check` **and** `pnpm run test:ui`. Both must be green. Do not
> claim an item is done without showing the command output.
>
> **1. `spanUnionSeconds` is computed, shipped, and rendered nowhere.**
> `usage-index.mjs` emits three time tiers but the Scorecard only shows
> `engagedSeconds` and `spanMinutes`. Either surface the middle tier in the
> engaged-time KPI (it is the honest bridge between 101h and 297h and makes the
> `engaged ≤ spanUnion ≤ summed` invariant visible), or drop it from the payload.
> Shipping a computed field nothing reads is dead weight either way. **Decide and
> justify in the ADR.**
>
> **2. `turns[].truncated` never reaches the reader.**
> `MAX_TURN_CHARS` (40 000) silently truncates a long turn and sets a `truncated`
> flag the Transcript view ignores. A reader currently cannot tell an abridged
> turn from a complete one — that is the same honesty failure the ADR exists to
> prevent, in the one view that shows raw content. Surface it inline.
>
> **3. Ten `Session` fields ship to the browser and render nowhere:**
> `basis`, `skill`, `plugin`, `sidechain`, `models`, `input`, `output`,
> `cacheRead`, `cacheWrite`, `tools`. They travel in every `/api/sessions`
> response and every `projectTree[].rows` entry. Either use them (a session-row
> detail popover is the obvious home — `basis` explains *why* a category was
> assigned, which ADR-0009 §5 says confidence should be inspectable) or trim
> them from the wire. Measure the payload delta either way.
>
> **4. The `deps` seam was never diffed against the real modules.**
> `usage-index.mjs` injects `{costOf, classify, detectInsights}` and tests pass
> doubles. Nobody verified the doubles' return shapes match what
> `pricing.mjs` / `usage-classify.mjs` / `usage-insights.mjs` actually return.
> This is the same "two sides agreed on a shape neither executed" class that
> produced the `[object Object]` chips. Add a contract test that runs the REAL
> modules through the seam.
>
> **5. `worktree` is captured but never displayed.**
> ADR-0009 §4b keeps the worktree name specifically so "which repo" and "which
> branch" stay distinguishable. 22 sessions carry one; the UI shows none of them.
> A chip on the session row is enough.
>
> Finally: re-run `pnpm run test:ui --real` and eyeball `.ui-artifacts/` before
> you call it done. The screenshots are the point — four of the bugs in the
> original build were invisible to green unit tests and obvious on screen.

---

## Provenance

| # | Source | Severity |
|---|---|---|
| 1 | `qe-quality` shape diff — "emitted but never consumed" | informational |
| 2 | `qe-quality` shape diff | informational |
| 3 | `qe-quality` shape diff | informational |
| 4 | `qe-quality` coverage gap — explicitly declared not-reached | informational |
| 5 | Implementation of ADR-0009 §4b | informational |

Both reviewers also confirmed clean: path traversal (28 payloads), the Host
guard on all new routes, `days=` clamping, deep-JSON recursion, XSS into the
panel, and the cache never persisting message bodies. Those need no follow-up.
