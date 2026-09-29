# Remediation v2 develop execution plan

> **For agentic workers:** Use superpowers:subagent-driven-development after maintainer
> confirmation. Write each branch's code-level plan with superpowers:writing-plans against
> its actual starting revision. This document governs program sequencing and authority.

## Status

**Active and confirmed** — the maintainer approved this execution plan on 2026-09-28.
Bootstrap and V1–V6 are integrated; V7 is in final validation. Approval covers isolated implementation work,
unit commits, feature PRs into `develop`, and conditional squash integration; the final
`develop` → `main` PR will be left open for human review. Releases, installation, real-data
operations and cleanup remain separately gated. Baseline inspected: `main@94890a00`.

**2026-09-29 execution update:** Reviewed V1–V6 and main watcher reconciliation
are integrated through `develop@88ce597f444d487a34d9871a447cf8942f76f760` with all
13 develop CI checks passing. V7 guard and evidence units are independently accepted;
V7 shared integration, independent reviews and all nine local gates passed at
`795a0f7266de0bf6a04358359b75a1ad1b609e1d`; closeout PR CI and integration remain pending.
The [246-row scope matrix](../archive/2026-09-29-remediation-v2-scope-matrix.md),
[integration receipt](../archive/2026-09-29-remediation-v2-integration-evidence.md),
[ordered rulings](../archive/2026-09-29-remediation-v2-rulings.md),
[Windows evidence](../archive/2026-09-29-windows-ci-evidence.md) and
[AQE proof](../archive/2026-09-29-aqe-released-artifact-receipt.md) retain the limits.
The dated 19:20 UTC three-PR timing snapshot includes a 358-second Windows leg.
The controller will refresh that separate gate after closeout PR CI.
The final develop → main PR and human approval remain pending. This plan stays
active; no release, installation, real-store mutation, deletion or personal-memory
write follows from documentation completion. Attended time was not instrumented.

**Goal:** Complete all remaining v2 remediation through feature PRs into `develop`, then
open one aggregate `develop` → `main` PR for human review.

**Architecture:** One integration controller owns the merge queue and shared records.
Ruflo records coordination; bounded Codex workers implement in isolated worktrees.
Agentic QE supplies scoped quality work through its real installed tools.

**Tech stack:** Node.js ES modules, existing zero-runtime-dependency CLI, GitHub Actions.

**Spec:** [Remediation program v2](2026-09-28-remediation-program-v2.md), including every
Appendix A/B row and its referenced v1 plans, rulings and evidence.

## Confirmed decisions and authority

- Feature PRs target `develop`; the controller may squash-merge them after all required
  CI and independent review pass. The final `develop` → `main` merge is human-owned.
- Make one conventional unit commit per independently verifiable task on feature branches.
  Squashing deliberately produces one integration commit per PR. Preserve the unit commit
  list and evidence mapping in the PR and ledger before any eventual branch cleanup.
- Defer all new releases and global installation until final main approval and the release
  gate. The existing alpha.60 commit is already on main; publication and local installation
  were not verified in this planning pass. Do not repeat or overwrite that release.
- Use recommendations D-3 through D-19, subject to current evidence. D-3 and D-8's work has
  already landed. D-4 B uses successful version-bound memory-route evidence; D-5 A defers
  the four unscoped #239 items; D-6 A drafts the AQE init issue; D-7 A fixes stray discovery.
  D-9 A preserves both v5 branches and reserved ADR numbers. D-10–D-17 use recommended
  deferrals/acceptances; D-18 A remains conditional on totals being unchanged; D-19 A labels
  structured live events experimental.
- Real store merges, file deletion, upstream submissions and paid runs retain their
  approval gates. Upstream approval is for exact sanitized text. No automatic worktree
  deletion is inferred from approval to squash-merge PRs.
- Use program records for execution continuity. Updating Codex's personal memory requires
  a direct user request; the original V7 auto-memory line does not override that boundary.
- This plan replaces the original program's main-targeted branch flow, intermediate
  releases, unlimited Wave 2 fan-out, and cleanup-dependent pre-review completion criteria.
  All other scope and gates remain in force unless explicitly reconciled by evidence.

## Verified baseline and remaining uncertainty

| Item | Current observation | Treatment |
| --- | --- | --- |
| V1 | #267 merged as `ab2fc5cb` | Verify residual timing evidence; do not repeat implementation |
| Windows stability | #262 open; #267 documents two passing runs at its head | Recover current run history; retain missing ten-run evidence as an open gate |
| V2 A/B | #264 and #266 merged; taxonomy plan marked Implemented; #269 archived it | Verify layouts/links and reuse completed work |
| D-8 | #251 merged as `ec749717` | Complete by existing evidence |
| Release | `94890a00` is the alpha.60 release commit | Verify status only; defer further release actions |
| GitHub PR inventory | No open PRs returned by the API | Recheck immediately before dispatch |
| Develop | No local or remote `develop` at planning baseline | Create under confirmed Phase A authority; verify current refs first |
| Existing work | Separate docs archive worktree; untracked `.harness/` in main | Preserve; inspect ownership and changes before dispatch |
| CI | `pull_request` enabled; push branches are `main` and `npm-kit` | Add develop push validation in the bootstrap PR |
| Ruflo | Guidance and memory calls succeeded; active claims empty | Prove scoped claims/runtime behavior before worker dispatch |
| AQE | Fleet status reports healthy, zero active agents/tasks | Verify each requested tool's real output against exact source |

The original program's "not yet started" status and main-only flow are stale. Reconcile
them in the bootstrap PR, retaining historical evidence rather than replaying completed work.

ADR-0063 is **Accepted**, updated 2026-09-29, with CLI and V3 dashboard delivery
recorded; V4 A3's offline retry limitation was refined and integrated in #275.
ADR-0048 is **Accepted**, updated 2026-09-28, with human evaluation gates
outstanding; V3 records their approved v5 deferral.
ADR-0060 is **Accepted**, updated 2026-09-29, with its delivered V6 contracts recorded.
Dedicated Cowork storage remains uncovered under #257; observed provider metadata is not
network attestation.

## Phase A: establish the integration baseline

Owner: controller. Dependencies: plan confirmation. Size: S, high confidence.

- [x] Refresh GitHub and local refs; inventory worktrees, dirty paths, claims and open PRs.
  Preserve unrelated work. Check the ignored v1 reconciliation, N-5 list, reviews and ledger
  referenced by the spec are available; copy their relevant facts into scoped worker briefs.
- [x] Create `develop` from verified current main in a dedicated integration worktree.
  Record base commit, user authority, controller and allowed actions in the execution ledger.
- [x] Create a bootstrap feature branch from develop. Commit this plan and reconcile the
  source program's Status, decisions, branch targets and definition of done.
- [x] Add `develop` to `.github/workflows/ci.yml` push validation. Review other workflow
  filters and concurrency keys so develop integration is tested without enabling publishing.
  Check repository rules/check requirements; proposed changes to repository protection must
  be explicit. Enforce the same merge gate in the controller even if develop is unprotected.
- [x] Validate docs layout, Markdown, links and workflow syntax; open bootstrap PR to develop.
  Merge only after review and CI. Subsequent feature branches start at this integrated base.
- [x] Reconcile V1/V2 completion and #262 run evidence. Capture source revision, run URL,
  OS/Node, job duration and result. Do not substitute a two-run observation for ten runs or
  claim the old three-consecutive-PR-run rule was historically met without its evidence.

Acceptance: develop exists; bootstrap checks pass; source scope is reconciled; remaining
rows have owners; existing work is preserved. Rollback: close an unmerged bootstrap PR;
after merge, use a reviewed revert PR rather than resetting shared history.

## Phase B: execute independent workstreams

All feature branches start from current `develop`, not main. Each has one writing owner,
one absolute worktree path, a code-level plan, exact path claims, dependency list and
acceptance evidence. Each plan re-reads source and inherited task references before coding.

| Stream / branch | Deliverable | Dependencies and exclusive boundaries | Acceptance |
| --- | --- | --- | --- |
| V3 `feat/dashboard-refresh` | 6c-1–6c-5; POST refresh, single Refresh control, read-only GETs, vocabulary and client corrections; #256 decisions; #254 only with trace | Bootstrap; owns dashboard server/refresh contracts and client changes first | GETs cause no refresh side effects; refresh contracts, live-view behavior, UI and applicable contrast checks pass |
| V4 `fix/follow-ups-v2` | All A.1–A.4, B.1–B.13 and C.1–C.6, with evidence-based conditional dispositions | Bootstrap; CLI/status/setup/memory/discovery/upstream watch; shared dashboard or test helper paths require explicit handoff | JSON/exit contracts, offline retries, path handling, file IDs, cancellation on Windows, store discovery and upstream conformance proven |
| V5 `test/runner-hygiene` | Branch 9 Tasks 5, 7, 10–13; LQ-1/LQ-4; focused runner and reviewed cleanup inventory | V1 already integrated; bootstrap; owns `scripts/run-tests.mjs`, environment helpers and Chrome launch helper | Clean real-state tripwire and suite temp root; environment isolation, focused runner and cleanup ownership proven |
| V6 `fix/usage-accuracy` | Branch 7 items 1–5; B7-D1–D3; per-turn import exclusion; UA-5; all listed Branch 8 capture fixes; UA-4 | Bootstrap for core work; V3 integration for UI work; owns usage parsers/cache, session vocabulary and census counting | Reproductions using enumerated metadata/counts; imported turns excluded and later genuine turns counted; unknown provider stays unknown |

Each stream includes every item named in the source program, not just the table summary.
V4 conditional B.13 uses a read-only plan/preview or a disposable-copy reproduction before
proposing changes to the user's configuration. Product fixes need no real-store mutation.
V4's temporary busy-rule/memory-routing CI probe is sandboxed and removed before its PR merges.
V6 reads the actual cache schema before making exactly one migration; the old plan's 25 → 26
number must not overwrite a schema bump that has already landed.

V6 Unit 21 implements static `statusLine` command classification for direct helper
invocations and treats shell wrappers, inline programs, and chains as `custom`.
It and the V6 UI are independently reviewed and integrated through #282. Usage schema
25 → 26 and the bounded accounting/coverage contracts are documented in the usage guide.

### Scheduling and team shape

The session has four slots total: controller plus at most three workers. Ruflo or AQE
dispatch must not create a second, uncounted fleet or expand spend or delegation limits.

Start V3 and V6 core work, then V4 when exact file claims are disjoint. Queue V5 for the
next free slot. When a task is ready for review, release/pause that worker's writing scope
and use a free slot for an independent reviewer or AQE specialist. Do not keep three
implementers running while launching an additional reviewer. Queued streams may prepare
read-only briefs only when a slot is available.

Use the real Ruflo coordination tools for task ownership/dependencies and actual Codex
workers for implementation. Use AQE for scoped test planning, risk/coverage assessment and
quality-gate work when its verified tool schemas can bind the worktree and source state.
A registration, success envelope or numerical score alone is not execution evidence.
If routing or isolation cannot be demonstrated, report the limitation before using a fallback.

### Conflict prevention

- One writer per worktree. Claims are exact paths plus resources/ports, not broad overlapping
  globs. Recheck the work graph at each dispatch and integration boundary.
- V3 owns `src/lib/dashboard/client/*` first. V6 core excludes these files until V3 merges;
  then V6 incorporates develop, reacquires paths and runs its UI task/review cycle.
- V3/V4 serialize changes to `src/lib/dashboard-server.mjs`, any shared Discovery modules,
  shared tests and ADR-0063. V3 lands the refresh contract first wherever a consumer needs it.
- V1 → V5 orders `scripts/run-tests.mjs`. V5's helper changes require V4/V6 consumers to
  incorporate develop and rerun affected tests. Stop dependent work if a contract changes.
- The controller alone integrates `docs/adr/README.md`, the shared decision log, program
  ledger, manifests and lockfiles. Workers submit task-specific handoff text for these paths;
  claim transfer happens only after their writing session ends.
- User guides and ADR-0063 get a named owner per task; different sections do not count as
  separate file ownership. Update accepted ADR status/date/delivery notes in the same PR.
- Never message a running workflow agent. Use bounded task briefs and ledger handoffs.
  Stop dependents on failed gates; independent work may continue in its own scope.

## Phase C: integrate and finish V6's UI

- [x] Review every unit commit after its RED/GREEN evidence. Allow at most five task fix
  rounds, then raise the specific unresolved issue rather than looping indefinitely.
- [x] Freeze the candidate branch, integrate the latest develop and resolve conflicts in
  its own worktree with no other writer. Run required full gates and whole-branch review.
- [x] Queue one feature PR merge at a time. Required evidence covers exact head/base SHAs;
  a changed base invalidates the previous integration result and requires appropriate reruns.
- [x] Squash-merge only after required CI, including Windows, and independent review pass.
  Verify the squash commit's tree equals the reviewed, develop-integrated feature tree.
  Run/check develop CI before releasing dependent streams.
- [x] After V3 integrates, complete V6's labels across Usage, Projects, Maintenance and
  Intelligence plus imported-copy counts in UI and `ak system`; keep these in the V6 PR.

Task validation uses the narrowest meaningful tests first. Before V5 introduces `focus`,
use the existing guarded runner interface, for example
`node scripts/run-tests.mjs exec -- --test tests/kit/<owned-suite>.test.mjs`.
After its integration use the verified `focus` interface in new briefs.

Branch gates include the guarded unit/legacy suites, required UI suites, typecheck, lint,
complexity/Markdown/link checks, build and applicable policy/security checks. Use the
package scripts' actual underlying commands; no pnpm in symlinked-node_modules worktrees.
Keep 70/70/70 enforcement and report measured coverage against the 80% line target.
Fixtures and child processes use sandboxed homes and temp roots; state drift or leftovers
fail the gate. Preserve FORCE_COLOR scrubbing and platform redirects. Provider calls that
incur cost are excluded unless explicitly approved.

## Phase D: V7 close-out and final human review

This checkpoint records completed implementation and prepared issue drafts. The final
review PR will carry subsequent CI, timing and issue-action receipts; unchecked publication
gates below are deliberately not claimed ahead of those actions. A scheduled attempt at
`94890a00` returned seven HTTP 503 responses without parsed session URLs; successful routine
execution remains unverified. The later watcher fixes were validated synthetically and in
read-only PR preview, with no live trigger by this program.

Dependencies: V3–V6 merged and develop green. Branch: `chore/v2-close-out`. Size: S/M.

- [x] Apply the tree-wide comment-label guard after competing code edits finish.
- [x] Reconcile every original Appendix A/B row to an exact PR/evidence record, explicit
  declined/superseded ruling, named open issue, or approved post-merge operation. No row
  disappears because V1/V2 had already landed.
- [x] Complete #262's ten-run before/after analysis or keep its evidence gate visibly open.
  Classify source/runtime changes in samples; never cherry-pick green runs into a false series.
- [x] Verify upstream watch behavior on the applicable branch/runtime. A first real release
  dispatch may remain observation-pending until an actual release event; do not fabricate one.
- [x] Prepare issue updates (#239/#240/#254/#257/#262) with evidence. Distinguish integrated
  on develop from shipped on main; close only when the issue's own completion condition holds.
- [x] Run docs alignment and archive completed branch plans with `scripts/docs-relocate.mjs`.
  Keep this program's plan active while main approval and operational work remain pending.
- [ ] Open final `develop` → `main` PR with scope/decision matrix, feature PRs and unit commit
  mappings, exact final source, tests, Windows evidence, release notes and known limitations.
  Refresh main into develop first if necessary, review resulting changes, and rerun gates.
  Leave the final PR open for human review; do not merge it.

Review-ready means all code and documentation changes are integrated and validated, with
remaining human/external actions named. It does not claim publication, machine cleanup,
live-store consolidation or a future upstream event has happened.

## Phase E: separately gated operational completion

After human approval and merge to main, apply the independent release gate before tagging,
publishing or installing. Verify the existing published versions first; choose the next
version from current state, not this plan's stale alpha.61 schedule. Include breaking CLI
and dashboard changes in release notes.

Complete approved install/sync/footprint verification against the released artifact.
For the real AQE stray store: exact preview, holder checks, explicit seed/import decision,
backup, disposable-copy import rehearsal, approved application/archive and receipt.
V5 supplies the reviewed literal-path temp inventory; deletion awaits approval.
Remove only approved program-owned worktrees/branches after confirming integration and
preserving unit-commit/evidence records. Keep develop for final review and until its retention
is decided; do not enforce the old "only main and v5 branches" rule during this workflow.

## Review focus and failure handling

1. Shared helpers and dashboard contracts changing under a concurrent consumer: exact claims,
   explicit dependencies, serialized handoffs and consumer reruns.
2. A feature passing while its develop integration fails: latest-base validation, serialized
   merges and develop push CI; stop dependents on failure.
3. Tests or real probes touching user data: guarded runner, isolated stores/homes, read-only
   metadata/count observations and explicit operational gates.
4. Session relabeling or import fixes silently changing totals: fixture contracts plus
   counts-only real-data reproductions and one controlled cache migration.
5. Completion claims exceeding evidence: source-bound results, no score-only approval,
   explicit deferred human gates and a separate operational completion phase.

On an unmerged failure retain the branch and evidence. After an integrated regression,
stop downstream promotion and submit a corrective or revert PR to develop. Never force-reset
develop/main, delete unrelated work, or weaken a gate to keep the schedule moving.

## Planning receipt

The maintainer confirmed this execution plan on 2026-09-28 and authorized isolated
implementation, unit commits, feature PRs into `develop`, and conditional squash
integration after required checks and review. The final `develop` → `main` PR is for
human review and remains unmerged. Release, installation, real-data operations and
cleanup retain their separate gates. The planning worktree started from `94890a00`;
the statements below describe the planning pass, before bootstrap implementation.
Current-state evidence came from local source/history and read-only GitHub API queries.
Ruflo memory search returned historical commands, not a current ownership decision.
Ruflo guidance/claims and AQE fleet status responded; no workers were launched.
Source grounding included `ruflo/plugins/ruflo-swarm/agents/coordinator.md` and
`agentic-qe/kb/capability-cards.md#agentic-qe` (the latter is a summary card, not runtime proof).
