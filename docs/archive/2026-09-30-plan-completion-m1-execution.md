# Completion M1 execution

## Status

**Active**, authorized 2026-09-30: isolated M1 fixes, guarded tests and local unit commits.
Base source main 0511d575; preserved planning commits e5f9842 and 9c352ba.
Existing worktree: agentic-kit-completion-plan; implementation branch: fix/completion-m1.
The maintainer confirmed one branch per milestone: finish M1 here, then provide the
new-session handoff prompt before beginning the next milestone. Related repository issue
closeout is authorized only after its criteria pass; exact upstream contributions remain gated.
The [completion program](https://github.com/pacphi/agentic-kit/blob/9c352baecb38371835571e2e491c740d43ae7b6f/docs/plans/2026-09-29-completion-program.md) governs the full milestone;
this document defines the first locally authorized slice, not a waiver of other M1 gates.

## Authority and ownership receipt

The maintainer explicitly approved starting isolated M1 fixes/tests and then local unit commits.
Allowed here: owned source/tests/docs, private test fixtures under the guarded runner, read-only
GitHub/package metadata, local branches and commits. No pushes, PR/public comments, releases,
package/global installation, real-machine sync, live AQE/MCP probes, real-store operations,
metered providers or worktree/branch cleanup. This records the conversation's authorization;
an editable receipt does not grant new authority or prove an upstream runtime is healthy.

Root is the only writer. Fresh read-only researchers share this checkout for Windows/AQE
evidence; neither edits nor executes live/stateful conformance. No existing workflow agent
is contacted. No distributed collaboration harness is tracked in this checkout; unrelated
untracked primary-checkout .harness state is preserved.

Exact writer claims for the initial slice:

- Brain hold state: src/lib/ruvnet-brain.mjs, its status section and related tests.
- One-shot retry integration: src/commands/sync.mjs and, only as needed, status collection/
  documented help and dedicated retry tests.
- AQE conformance preparation: tests/live/aqe-live-lock-process.mjs, shared lock fixtures,
  MCP session/lock conformance and their kit tests; .github/workflows/aqe-m1-conformance.yml
  is a dispatch-only proposal. Root alone owns workflow integration; no dispatch authorized.
- Upstream registration handoff: root claims only the new AQE #801 watch entry in
  src/lib/hook-audit/agentic-dependency-constraints.json and its M1 publication receipt.
  Registration preserves the separate shutdown finding and grants no retirement authority.
- Windows experiment: tests/kit/aqe-store-merge-fixture.test.mjs; original assertions stay.
- Brain contract: ADR-0061, troubleshooting and current CLI guidance.
- Controller-only integration: this plan, completion program/ledger and contribution drafts.
  Manifest/registry/workflow changes need a new exact claim and evidence before integration.

## P00 boundary and inherited proof

- [x] Original staged hashes verified before committing the baseline unchanged.
- [x] Approved planning refinements committed separately; M3 research parked.
- [x] Live main and open issue inventory rechecked: main 0511d575, 13 open issues.
- [x] Documentation baseline: 17 guarded tests, Markdown and full offline links passed.
- [ ] Map original plan gates and retained 246-row remediation scope matrix to merged,
  inherited, upstream-blocked and approval-pending evidence without repeating completed work.
  All identifiers now have a disposition in the
  [M1 successor ledger](2026-09-30-plan-completion-m1-closeout-ledger.md); final gate receipts remain.
- [ ] Carry release/install, real-data and cleanup gates as open until separately approved.

The original eight source plans and snapshots are preserved. P00's entire reconciliation is
not claimed complete by this initial boundary check. Neither M3 policies nor #213's strict
upstream-release closure becomes an artificial prerequisite for unrelated local repairs.

## P04 first: Brain hold recovery #271

ADR-0061 is Accepted, dated 2026-09-27, with a recorded implementation subset. Its historical
fresh-install claim does not prove the full held-sync path: activeHeldRefresh currently matches
only release pairs at the baseline. Committed M1 units now add bounded expiry and explicit
retry. Verify the kit path with disposable fixtures; upstream behavior stays
unverified until a separately authorized released-artifact conformance run.

1. Add failing recovery tests before production edits: configured/default TTL boundaries,
   missing/malformed/future hold timestamps, fresh holds and changed releases.
2. Add truthful missing-KB versus surviving-plugin/stale-stamp evidence. A retry refusal must
   produce a fresh hold rather than allow every subsequent sync to loop.
3. Add a one-shot sync retry option. Dry-run remains non-mutating; no-upgrade, explicit skip
   and disabled management cannot be bypassed. Postcondition collection never repeats retry.
4. Keep installer safety checks, pinned release/required asset and private snapshot preservation.
5. Update current help and ADR recovery wording from demonstrated kit behavior, retaining
   historical observations and upstream limits. No retired-command aliases.
6. Focused recovery/sync/CLI tests, affected regressions, types/lint/build and guarded full
   units. Record unavailable dependency/platform gates separately from passing checks.

Rollback: revert recovery behavior/configuration projection only; preserve source stores,
private snapshots and recorded refusals. Never delete the KB or edit live kit.json here.

## P02 measured Windows experiment #262

Approved gate is ten consecutive-run per-leg medians plus three consecutive PR runs with every
Windows leg under 300 seconds; retain failures/cancellations, full matrix, assertions, EBUSY,
coverage/tripwire and 30-minute timeout. Do not require ten entirely green qualifying runs.

Read-only refresh: Node 22/24/26 medians 247.5/247.5/253.5 seconds. Latest PR runs:
36627279218 (253/310/261), 36625700956 (201/311/230), 36616775739 (245/227/254).
The streak gate remains unmet. Spec reporter timestamps can be buffered; no final-file
critical-path claim follows from output order.

One bounded experiment: the independent sequentialStore migration oracle still auto-commits
schema DDL. Its two parity cases cost 28.48/23.70 seconds in job 109607393092,
24.76/19.67 in 109601987511 and 18.49/15.72 in 109641942337.
Batch only that oracle's schema in one transaction; keep its independently executed statements
and all parity/integrity/FTS/witness assertions. Existing fixture tests verify behavior.
Local timing is not Windows proof; saving serial duration does not prove equal job savings.

CI/push approval remains required to measure the candidate. Until then #262 stays open;
prepare the experiment and a exact-source measurement request rather than manufacture a streak.

## P03 AQE closure preparation #240

ADR-0055 is Implemented, amended through 2026-09-29; ADR-0062 is Accepted, updated 2026-09-29.
Existing macOS/Linux receipts prove only their qualified holder/startup paths; Windows and
combined real-MCP-holder/packed-kit proof remain open. AQE 3.14.6 is a candidate, not locally
validated here. Strict storage-error failure behavior must remain.

- [ ] Prepare exact issue wording reconciliation using the current supported command,
  ak status --refresh=live --only aqe, without aliases or a invented universal version floor.
- [ ] Identify/prepare disposable real-MCP-holder and packed-CLI proof; startup busy must be
  distinguished from overall embedding/corpus-check exit status.
- [ ] Prepare cooperative Windows-compatible holder shutdown and failure-path verification.
EOF/forced-stop fixtures and real MCP protocol/lock-PID/packaged-command harness are now
  prepared. Capture is bounded; forced stop and watchdog cannot count as graceful proof.
  Committed as 03bb230 (process/fixture bounds) and 40c2707 (real MCP/packed-kit harness
  plus dispatch-only workflow). Live execution remains separately gated.
- [ ] Prepare bounded Windows conformance invocation using existing workflow conventions,
  preserving ordinary CI job timing. Installation and dispatch remain approval gates.
- [ ] Refresh candidate adoption/attention rows; #535 successor #786/#787 remain visible.

No live conformance, workaround retirement, issue publication or closure is claimed.

Read-only watcher refresh on 2026-09-30 established three actual `fired` session records,
ledger commit 4704a58 and notice read-back; see the M1 successor ledger. Routine completion
and resulting PRs remain unverified. No new trigger was executed by this session.

### Exact upstream reply drafts, unpublished

These address the three live report reply items. Each requires the maintainer's approval
of its exact text before posting; silence and milestone authority do not authorize publication.

**AQE #528:**
Thanks for confirming the closure. Agentic-kit records the in-process MCP entry from 3.14.4.
We have prepared a bounded 3.14.6 conformance harness for a real MCP holder plus the packed
kit command, with native Windows proof still pending. We will share the artifact-bound
results after execution; transport discovery alone will not be reported as provider readiness.

**AQE #532:**
Thanks for confirming the closure. Agentic-kit documents the 3.14.4 exclusive-platform
initialization option. We retain the Codex guidance constraint until the selected released
artifact passes full/compact/none, foreign-text preservation, repeated-init and platform
verification checks. Closure of the upstream issue is recorded separately from that proof.

**AQE #535:**
We have recorded #535 as closed and will retain #786/#787 as separate open follow-ups.
The released 3.14.6 candidate is not yet an agentic-kit conformance verdict. Our references
will distinguish the confirmed fixes from test-generation quality and coherence-text limits;
we have no fresh goap_execute proof to claim.

Manual #756 refresh: PR #767 merged c2ca85185c7cb4aea29dd52939ac913887388edf on
2026-09-28. GitHub compare proves this commit is an ancestor of v3.14.5 (behind=0,
ahead=29); npm confirms 3.14.5 publication/integrity metadata. This resolves source/tag
ancestry, not distribution behavior. Keep its conformance constraint until the actual
package passes; no retirement or automatic dispatch was performed here.

### Prepared acquisition and proof request

**Executed with Option A approval:** acquisition and named rebuild passed; stock native
macOS proof established busy startup/preservation but failed its shutdown-marker gate.
The [dated receipt](2026-09-30-aqe-m1-mcp-lock-proof.md) distinguishes released
artifact results from a passing matched source-module proposal control. No installed
artifact was patched, and no release/platform-wide fix or issue closure is claimed.
The subsequent Option A approved issue publication only: AQE #801 was posted at
2026-10-01T00:22:49Z with exact title/body read-back. The source patch remains private;
normal rebuilt-package and supported-platform proof stay open.

Selected candidate: published agentic-qe 3.14.6, rechecked at npm on 2026-09-30.
Expected tarball integrity:
`sha512-ObNw+nFHj4Kz7JYulAdBSJ5/QP5lmFeRTvwBRalUXeQSQZu5PoN4Xp3ZTug3q5EoHWXVd3+xdBdlbtgqq+8+bg==`.
Acquire only in a disposable private prefix with private HOME/config/cache; verify tarball
bytes and record the resolved dependency tree. Disable lifecycle scripts; the only proposed
native preparation is an explicitly approved better-sqlite3 rebuild. This executes third-party
code; private paths are isolation, not a filesystem/network sandbox. Do not run AQE postinstall.

Pack and hash the exact kit checkout, extract separately, then run the checkout harness:
`node scripts/run-tests.mjs focus tests/live/aqe-mcp-lock-conformance.test.mjs` with
AK_AQE_MCP_LOCK_LIVE=1, exact package/version/prefix roots and the extracted kit root.
The harness discovers initialize/tools-list without model/tool execution, requires the MCP
PID to own patterns.rvf.lock, checks unchanged bytes and ordinary busy startup, and records
semantic readiness separately. Require EOF/server-stop/no-watchdog/owned-lock release proof.
Local acquisition/native execution and hosted dispatch each remain approval gates.

The manual workflow performs the same version/integrity-bound proof on Linux/macOS/Windows,
outside #262's ordinary timing legs. Any missing native payload or unmet ownership boundary
fails conformance; it never becomes an inferred pass or an automatic broader install.

## Integration and handoff

### Local checkpoint, 2026-09-30

Preserved planning baseline e5f9842; approvals/research 9c352ba; execution scope 3a666ea.
Local implementation units: b535975 (bounded hold expiry), fb48cb3 (missing/unreadable KB
classification), dfb5609 (guarded one-shot retry), 6ab1c5e (schema-oracle optimization).
The schema-oracle optimization is a
separate test-only unit; it changes no assertions and remains a Windows measurement candidate.

Integrated focused verification: 191/191 tests passed through scripts/run-tests.mjs with
clean real-state tripwire and own-root hygiene. Types, affected ESLint checks (including
the repository's complexity ceiling of 50), Markdown across 245 files, full offline links
(0 errors) and guarded build/package dry-run passed. Build checked 498 shipped files and
552 package entries. Read-only review found no retry source defect; the requested real
status-collector integration and retry safety cases were added and passed.

The earlier full-unit gate failed four Playwright-dependent tests because this worktree
has no installed development dependencies; coverage floors passed, but the full gate did
not. The maintainer approved worktree-only locked development dependencies on 2026-09-30,
with isolated caches, scripts disabled and no browser downloads; the full rerun follows.
Other installation gates remain unchanged. An earlier focused run
also failed its tripwire when the real Codex config changed concurrently/unattributed;
no real config was restored or edited. Sandbox path assertions and subsequent clean guarded
runs provide usable local proof without attributing or waiving that earlier incident.

Subsequent dependency-resolved full rerun passed: 6,464 unit tests, seven platform skips,
all legacy suites; coverage 94.18% lines / 83.85% branches / 93.50% functions.
Browser verification passed 514 assertions plus 16 tests using existing Chrome, with no
browser download. Types, lint (0 errors; 78 existing warnings), complexity, Markdown,
offline links, guarded build and manual-workflow actionlint passed. Native AQE conformance
remains gated; its two opt-in tests were skipped, while 13 transport/process fixtures passed.
These fixture passes do not validate a released AQE package or Windows native behavior.

No Windows timing acceptance, real AQE-holder conformance, issue closure, release or upstream
recovery is claimed. Continue P00 reconciliation and P03 preparation from this branch.

One logical unit commit per independently verifiable change; no attribution trailers.
An independent review precedes handoff. Revalidate exact integrated source when new findings
change it. Local green results do not authorize a merge/release or establish Windows runtime
proof. Archive original plans only when their own accepted closure gates pass.
