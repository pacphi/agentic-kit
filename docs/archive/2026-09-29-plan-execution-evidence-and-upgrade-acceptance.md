# Execution evidence and upgrade acceptance

> **For agentic workers:** this is a program plan. Execute it with
> superpowers:subagent-driven-development after the maintainer answers D-22 and D-23 and confirms the
> plan at the re-evaluation point in the
> [closure plan](2026-09-29-plan-issue-239-closure-and-v5-foundation.md). Write each workstream's code-level
> plan with superpowers:writing-plans against `main` as it stands when the workstream starts.

## Status

**Blocked** on the final `develop` → `main` PR of the
[remediation program v2](2026-09-28-plan-remediation-program-v2.md) and on the maintainer's answers to D-22
and D-23 (D-21 was answered A on 2026-09-29). Written 2026-09-29 against `origin/develop@bb2e7efe`.
The [closure plan](2026-09-29-plan-issue-239-closure-and-v5-foundation.md) **depends on this plan
completing**: it cannot start its release-level proof until §5 is met.

**Goal:** deliver the four #239 items that v2 deferred to "v5" (execution identity, terminal-outcome
recording, cancellation semantics, and the upgraded-install and positive/negative outcome matrix), and
the early-warning monitor (#255) that consumes them, so that agentic-kit can say truthfully what a worker
did.

**Scope note.** The monitor (#255) sits in this plan, not the closure plan, because it consumes the
contract (E1) and the fault-injection worker (E2) and is governed by the same decisions (D-21 to D-23).
If you would rather keep #255 separate, move E3 back without changing the others.

**Owner tags:** **[AK]** agentic-kit controls the path; **[UP]** waits on an upstream maintainer;
**[MAINT]** needs the maintainer.

## 1. Workstreams

| E | Deliverable | Owner | Depends on | Effort |
| --- | --- | --- | --- | --- |
| E1 | Execution evidence contract: spike, then ADR (identity, outcome, cancellation, generation ID, schema version) | [AK]; upstream asks [UP] | D-22 | M |
| E2 | Fault-injection worker and outcome matrix | [AK] | E1, D-23 | M |
| E3 | Early-warning monitor and alert store (#255) | [AK] | E1, E2, D-21 | L |
| E4 | Upgraded-install matrix, stopped-service and executable-ownership checks | [AK] | none | M |

E4 is independent of E1–E3 and can run beside them. Bounded concurrency follows v2: the controller plus at
most three workers, one writer per worktree, disjoint path claims.

**E1.** Spike first. Confirm whether ak can observe any AQE task state from outside the server process (P2),
and whether ak's subprocess adapters stream output events. Then the ADR: task and executor identity, an
outcome enum extending `src/lib/execution/schema.mjs`, separate records for accepted, started, progressed,
terminal, result-valid and result-persisted, cancellation states and a generation ID (D-22), and a schema
version. File upstream asks only where the spike proves a gap (closure plan D-32); upstream text needs the
maintainer's approval.

**E2.** The fake executor from D-23 with one mode per outcome. New runner work it forces: a `prepare`
cleanup path (P4), a late-completion record, and the absent statuses (P3). Matrix assertions go through the
packaged CLI, not imported source.

**E3.** Adds the alert store P6 found missing, per-phase deadlines and exit codes, pre-launch validation, and
the redaction rule: alerts carry task ID, state, elapsed and deadline, error category and a safe next action,
never prompts, transcripts, credentials or private paths.

**E4.** Adds the fixtures P8 found missing (foreign bin, disabled-but-installed host, existing data, a
concurrent process) and builds the stopped-service check and executable-ownership inventory P10 found
missing. Disposable environments must set every `XDG_*` variable to a sandbox path (P7) and assert resolution
before any write.

## 2. Feasibility results that shape this plan

The full ledger is §3 of the closure plan. The rows that matter here:

| Probe | Result | Effect on this plan |
| --- | --- | --- |
| P1 | AQE 3.14.4 exposes identity, coarse states, `cancellationResultPending` and late-result discard, but no per-task progress and no enforced queen timeout; a task with no handler stays `running` forever; results live in memory. Ruflo 3.48.0 `task_*` is an untrusted ledger (free-string status, cancel overwrites completed, empty-result completion, synthetic worker success). | E1 defines the contract at ak's boundary and reads upstream fields only where AQE provides them |
| P2 | Unverified, high risk: another process's in-memory AQE task map is probably not observable from ak | E1's spike settles it before E3 relies on it |
| P3 | The runner represents never-start, slow-valid, failed child, empty result, deadline, cancel refused and missing handler. It lacks a stall status, cancel-requested vs stopped, a late-completion record, live lock and an I/O category. | E1 and E2 extend `WORKER_STATUSES` (schema version bump) |
| P4 | A hung `prepare` gets no cancel or cleanup (read from code, not run) | E2 runs it first |
| P5 | One wall-clock budget per attempt; no progress deadline | E3 adds per-phase deadlines |
| P6 | No alert store; `ak run` persists nothing; any non-success exits 1 | E3 adds the store and distinct exit codes |
| P7 | `spawnEnv()` sets `XDG_*` to sandbox paths rather than unsetting them | E4 uses that helper and asserts resolution before writes |
| P8 | Only a preserved-custom-MCP fixture exists; no foreign-bin or disabled-but-installed fixture | E4 builds them |
| P9 | Two sandboxed dry-run syncs gave identical plans, exit 0, no ak state written | Stability only; E4 adds a real convergence assertion |
| P10 | No stopped-service detector and no pre-install executable inventory found | E4 builds both |

## 3. Decisions

Numbering continues the closure plan's. D-21 is answered; D-22 and D-23 need the maintainer. Sources are in
§6. Quotes were returned by the fetch tool's summarizer, so re-verify before publishing them outside this
repository.

### D-21 Monitor scope and stall signal (#255)

**Answered 2026-09-29: A.**

Research supports layered detection: hard per-phase deadlines as the safety net [S22], a start gate before
liveness-style checks [S18], and a progress signal that is best-effort and labelled. A heartbeat contract
proves the worker sent a ping, not that it did useful work [S3]. P2 removes AQE polling as a dependable
option.

- **A. Chosen.** Monitor only what ak launches (`ak run` host runs). Use hard deadlines per phase (queue,
  start, execution, progress) with distinct exit codes; a progress signal from host events where they
  exist, else output growth, labelled `reported` or `inferred`; a stall is a **warning** to the parent, and
  only a hard deadline kills [S18], [S21]. Log inter-activity gaps now to tune thresholds later. **Why:** it
  needs no upstream cooperation, matches #255's own definition of a worker, and limits false-positive
  kills. Adaptive (accrual) thresholds are deferred: the evidence is a secondary source (Akka's
  description of Hayashibara 2004) and agent workloads have bursty silences [S24].
- **B.** A heartbeat-with-progress contract as a hard requirement for every adapter [S2], [S3]. **Why not:**
  Claude Code, Codex and OpenCode do not promise it, so most adapters would be unmonitorable.
- **C.** Also poll AQE and Ruflo task ledgers. **Why not:** P2 (AQE state is in-process) and P1 (Ruflo's
  ledger is untrusted).

*Weakness:* no fetched source studies agent workers; every transfer is by analogy. "Useful progress" needs
an ak-defined criterion, for example changed files or completed tool calls.

### D-22 Cancellation and late-result fencing

- **A. Recommended.** A state machine (`requested` → `stopping` → `stopped` or `refused`) with a bounded
  grace period then a forced kill, **plus** a generation ID on every result so stale completions are
  rejected and logged. **Why:** .NET states cancellation "is cooperative and is not forced on the
  listener" [S7]; Kubernetes bounds the wait then kills [S1]; Kleppmann's storage server rejects a lower
  token [S4]; Go warns that cancel returning is not stopped [S6]. P3 shows ak has no `requested` or
  `stopped` today, so this is new schema.
- **B.** Fencing tokens only. **Why not:** rejects stale results but never stops the worker or frees its
  resources.
- **C.** Best-effort cancel, late results logged. **Why not:** a late result can overwrite newer state, the
  exact failure fencing prevents; this is Ruflo's present behaviour (P1).

*Weakness:* Kleppmann's argument concerns distributed locks; on a single-host supervisor it is an analogy.
Adding statuses changes `WORKER_STATUSES`, which today rejects unknown values as `protocol_error` (P3), so
the schema needs a version bump. AQE's own cancel does not stop the executor (agentic-qe#707, open), so
"stopped" must be confirmed against ak's own child process [UP].

### D-23 How to test the fault modes

- **A. Recommended.** A scripted fake executor with one mode per fault, run under `node:test` mock timers
  and an injected clock, asserting exit codes and parent-visible alerts; include a slow-but-valid case to
  guard against false positives. **Why:** Node's mock timers advance time without waiting [S25];
  deterministic simulation gives "perfect repeatability" [S26]; the nemesis pattern is a proven
  fault-injection shape [S28]. P3 already ran a fake adapter through the real runner.
- **B.** Record and replay sanitized real transcripts. **Why not alone:** it cannot express faults that never
  happened (cancel refused, persistence failure), and sanitizing is a security burden. Keep transcripts as
  fixtures.
- **C.** Full FoundationDB-style simulation with all I/O abstracted [S26], [S27]. **Why not:**
  disproportionate here; mock timers cover timers and `Date` but not child processes, so fakes are still
  needed.

## 4. Sentry tests still pending (need the maintainer's go-ahead or a write)

| Test | Why it is not yet run |
| --- | --- |
| Observe AQE task state from outside its server process (P2) | Needs a submit, which is a fleet write |
| Run a hung-`prepare` case through the real runner (P4) | Read from code only |
| Whether ak's subprocess adapters expose output events (D-21) | Not read in the probing pass |

## 5. Completion gate for the closure plan

The closure plan may start its release-level proof (its W6) only when every row holds:

- E1's ADR is Accepted, and the contract types and validators are merged with tests.
- E2's matrix passes for every outcome in #239's negative list: accepted-never-started, alive-without-progress,
  slow-valid, missing handler, failed child, empty result, persistence failure, deadline expiry,
  cancellation refused, late completion, live lock and real I/O failure.
- E3's monitor is on for the matrix, and a stalled fake worker produces a parent-visible alert and a
  non-zero exit within its deadline.
- E4's matrix is green on Linux, macOS and Windows CI, and `ak sync` run twice converges.
- Every upstream gap the spike found is either filed (exact text approved) or recorded as a disclosed
  limitation.
- Docs, ADR statuses and the decision log describe current state.

When the gate is met, archive this plan under the closure plan's §7 and update its Status.

## 6. Sources

All fetched 2026-09-29 through the fetch tool. Quotes are as returned; verify before external use.

- [S1] Kubernetes, Pod v1 API. `kubernetes.io/docs/reference/kubernetes-api/workload-resources/pod-v1/`.
  "after the grace period, the processes are forcibly killed with SIGKILL."
- [S2] Temporal, Activity Execution. `docs.temporal.io/activity-execution`. "Activities must heartbeat to
  receive cancellations from a Temporal Service."
- [S3] Temporal, Detecting Activity failures. `docs.temporal.io/encyclopedia/detecting-activity-failures`.
  "Each ping informs the Temporal Service that the Activity Execution is making progress."
- [S4] Kleppmann, "How to do distributed locking", 2016-02-08.
  `martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html`. "it rejects the request with token 33."
- [S6] Go, package context. `pkg.go.dev/context`. "The close of the Done channel may happen asynchronously,
  after the cancel function returns."
- [S7] Microsoft Learn, Cancellation in Managed Threads (2026-03-17). "Cancellation is cooperative and is not
  forced on the listener."
- [S18] Kubernetes, liveness, readiness and startup probes. "If a startup probe is configured, Kubernetes
  does not execute liveness or readiness probes until the startup probe succeeds."
- [S21] Erlang/OTP, Supervisor Behaviour. `erlang.org/doc/system/sup_princ.html`. A supervisor stops and
  monitors children and escalates to a kill.
- [S22] gRPC, Deadlines. `grpc.io/docs/guides/deadlines/`. "the client will give up and fail the RPC with the
  `DEADLINE_EXCEEDED` status."
- [S24] Akka, failure detector (describing Hayashibara et al. 2004). "Phi is calculated from the mean and
  standard deviation of historical inter arrival times." Secondary source.
- [S25] Node.js test runner, MockTimers. "simulate and control the behavior of timers … without actually
  waiting."
- [S26] FoundationDB, Simulation Testing. `apple.github.io/foundationdb/testing.html`. "Determinism is crucial
  in that it allows perfect repeatability of a simulated run."
- [S27] Wilson, "Testing Distributed Systems w/ Deterministic Simulation", Strange Loop 2014 (abstract).
- [S28] Jepsen, "The Nemesis: Introducing Faults". "The nemesis is a special client … which introduces
  failures across the cluster."

Not fetched, therefore not cited: the original Hayashibara φ-accrual paper, the Kubernetes pod-lifecycle
page, and the Chandra–Toueg paper beyond its abstract.
