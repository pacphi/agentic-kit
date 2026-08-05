# MetaHarness as an Optional Assurance Companion

- **Status:** Proposed
- **Date:** 2026-08-04
- **Decision record:**
  [ADR-0022](adr/0022-metaharness-as-optional-assurance-companion.md)
- **Replaces:** branch-only MetaHarness retrieval proposal in commit
  [`8dcad80`](https://github.com/pacphi/agentic-kit/commit/8dcad806c015e3de42f46b8fa4858edf9dd439c1)

## Executive decision

Use MetaHarness primarily **around** agentic-kit, as an optional assurance and optimization
companion. Keep agentic-kit responsible for installing, configuring, routing, and supervising the
user's agent stack. Let MetaHarness observe bounded `ak run` outcomes, evaluate quality/cost/safety,
compare policies, and produce evidence or recommendations without becoming another execution or
configuration authority.

A small integration **inside** agentic-kit can still be valuable, but only as a capability-aware,
read-only projection over upstream evidence: availability, health, recent evaluations, and a safe
next command. It must not embed a second harness, reproduce gates, promote policies, or add another
routing surface.

This gives a reason for both forms:

| Form | Value | Authority |
| --- | --- | --- |
| MetaHarness around agentic-kit | Independent measurement, experiments, red/blue exercises, and cost-quality learning | Advises; does not operate agentic-kit |
| Thin MetaHarness projection in agentic-kit | Discoverability, status, repair guidance, and consistent evidence display | Reads upstream state; does not recreate it |

The external companion is the higher-value starting point. The internal projection is justified
only after the companion proves that users repeatedly need those results in the normal `ak`
experience.

## The three systems that must not be conflated

The name “MetaHarness” currently appears at three different boundaries:

1. **Standalone MetaHarness** is a factory and deterministic control plane for generated agent
   harnesses. Its worker contract is a function, and its packages cover repo scoring, policy,
   auditing, receipts, red/blue testing, and Darwin evolution.
2. **Ruflo's MetaHarness surface** is an upstream CLI bridge and, in particular releases, a
   retrieval-flywheel integration. Ruflo remains authoritative for its own receipt, ledger,
   champion, and promotion semantics.
3. **Agentic-kit** is the lifecycle and execution product. It owns supported-host setup, sync,
   status, configuration projections, activity routing, and the supervised `ak run` contract.

“Incorporating MetaHarness” is ambiguous unless it identifies which boundary it means. This
proposal uses **companion** for standalone MetaHarness around agentic-kit and **projection** for any
read-only agentic-kit UX over Ruflo or MetaHarness evidence.

## Product thesis

Agentic-kit makes an agent stack operable. MetaHarness can make that operation measurable.

The combined value proposition is:

> Run a bounded multi-host workflow through agentic-kit; independently measure whether it was good,
> safe, and cost-effective; learn from labeled outcomes; and require a separate explicit decision
> before any learned policy influences future execution.

The separation matters. A harness that both selects the route, executes it, defines success, and
promotes itself cannot provide strong independent evidence. A companion can compare agentic-kit
versions or routing policies while agentic-kit remains usable when the companion is absent.

## Explicit use cases

### 1. Pre-adoption repository fit analysis

**User:** an agentic-kit maintainer or adopter considering a MetaHarness workflow.

**MetaHarness does:** statically score harness fit, compile confidence, inferred task coverage,
recommended mode, and scaffold constraints without executing repository code.

**Helpful because:** it quickly identifies whether generating a harness is plausible and which
shape MetaHarness would recommend.

**Boundary:** this score describes the **recommended generated harness**, not the current
repository's security, correctness, or production readiness. For example, “tool safety” is computed
from the proposed policy posture; it is not proof that existing MCP configuration is safe.

### 2. Read-only tool and MCP posture review

**User:** a maintainer reviewing the trust boundary before allowing agent execution.

**MetaHarness does:** inventory exposed MCP/tool surfaces, produce a threat model, and run an OIA
audit in dry-run/read-only mode.

**Helpful because:** `ak run` intentionally inherits the user's CLI trust posture in the target
repository. A separate review can expose unexpected tools, broad permissions, or missing policy
before execution.

**Boundary:** a finding such as “no `.harness/mcp-policy.json`” means the repository is not governed
as a generated MetaHarness harness. It is not automatically an agentic-kit vulnerability. Findings
must be interpreted against the product that owns the configuration.

### 3. Shadow evaluation of `ak run`

**User:** a maintainer comparing execution templates, routes, versions, or escalation policies.

**MetaHarness does:** invoke a dedicated adapter that treats one complete `ak run` pipeline as a
candidate worker, records bounded outcome evidence, and scores the result against an external task
and verifier suite.

**Helpful because:** it can compare “did this workflow solve the task?” across policies without
changing the policy used by normal users.

**Boundary:** start at the whole-pipeline level. MetaHarness must not reschedule individual
agentic-kit workers or replace the runner's readiness, timeout, cancellation, escalation, and
cleanup lifecycle.

**Required correction before implementation:** today's `ak run --json` emits `{plan, results}` but
has no explicit top-level schema version or companion-safe export profile. The adapter needs a
versioned, sanitized result contract that states provenance, redaction, terminal status, and which
fields are stable. Raw prompts, task text, repository content, secrets, handoffs, and host protocol
streams must not become training data by accident.

### 4. Cost-quality routing advice

**User:** a team with repeated, labeled executions and multiple eligible host/model routes.

**MetaHarness does:** compare quality, latency, and cost evidence and recommend the cheapest route
that meets a declared quality floor.

**Helpful because:** agentic-kit's current routing is explicit intent and subscription-aware;
MetaHarness can add empirical outcome evidence once a representative labeled dataset exists.

**Boundary:** recommendations run in shadow/advisory mode first. They do not rewrite `kit.json`,
change `routing.routes`, enable a host/provider, spend against a new metered provider, or claim
vendor diversity. Agentic-kit applies only a user-approved route through its existing canonical
surface.

### 5. Harness-policy evolution with Darwin

**User:** an advanced maintainer optimizing the companion itself.

**MetaHarness does:** evolve its approved harness policy surfaces—planner, context builder,
reviewer, retry policy, tool policy, memory policy, and score policy—inside a bounded sandbox and
score variants against fixed tasks.

**Helpful because:** it can improve how the companion evaluates and conducts work without turning
agentic-kit into self-modifying product code.

**Boundary:** Darwin does not mutate agentic-kit core, `kit.json`, host projections, credentials,
permissions, provider access, or the `ak run` supervisor. A winning variant remains an evaluation
artifact until a maintainer separately reviews and promotes it.

### 6. Red/blue evaluation of LLM and tool surfaces

**User:** a maintainer of an LLM-facing workflow built on agentic-kit.

**MetaHarness does:** use `@metaharness/redblue` to test prompt-injection, data-exfiltration, tool
misuse, and related scenarios against a bounded test target.

**Helpful because:** conventional code tests do not fully exercise adversarial model/tool behavior.

**Boundary:** red/blue runs target only systems the user owns or is authorized to test. They use
fixtures or isolated environments, no production credentials or live third-party targets, fixed
budgets, and explicit network/tool allowlists. This complements rather than replaces agentic-qe's
code, integration, security, and regression testing.

### 7. Release and regression evidence

**User:** agentic-kit maintainers preparing a release.

**MetaHarness does:** run the same held-out task suite against two agentic-kit commits or two routing
policies and emit comparable receipts or scorecards.

**Helpful because:** ordinary tests prove deterministic contracts; outcome evaluation can detect a
quality or cost regression in otherwise passing agent workflows.

**Boundary:** the evidence informs a release decision. It does not publish, tag, deploy, or bypass
the repository's existing release and QE gates.

### 8. Read-only improvement status in agentic-kit

**User:** an operator who wants to know whether an upstream Ruflo evaluation exists or needs
attention.

**Agentic-kit does:** capability-probe the installed upstream CLI, render its provenance and state,
and provide a copyable next command. A future dashboard projection may display the same evidence.

**Helpful because:** it makes an upstream capability discoverable in the normal operational
experience.

**Boundary:** status and dashboard stay read-only. Ruflo owns its receipt, ledger, active champion,
and promotion transaction. This use case does not by itself justify a new top-level `ak improve`
command.

## What MetaHarness should not do

MetaHarness is not helpful when it becomes a second owner of agentic-kit. It must not:

- install, update, enable, sync, or uninstall supported hosts and providers;
- own or rewrite agentic-kit's routing envelope, projections, or ownership receipts;
- schedule agentic-kit's internal worker DAG or weaken its deadlines and cleanup proof;
- infer inference-provider identity or vendor diversity from a host/model label;
- copy project memory into a second canonical store;
- replace agentic-qe for deterministic code, integration, and security verification;
- promote retrieval, routing, tool, permission, model, or spending policy unattended;
- generate over checked-in `AGENTS.md`, `CLAUDE.md`, `.mcp.json`, `.codex`, or `.claude` state;
- become a runtime dependency required for `ak setup`, `ak sync`, `ak status`, or `ak run`;
- treat its self-score as proof that agentic-kit is secure or production-ready.

## Corrective disposition of the earlier proposal

The 2026-07-28 branch proposal contains useful safety instincts—especially separate evaluation and
promotion, explicit confirmation, capability probing, and Ruflo authority—but its product boundary
needs correction.

| Earlier direction | Correction |
| --- | --- |
| Call the workflow “MetaHarness retrieval improvement” | Name Ruflo's retrieval flywheel as a Ruflo capability; use MetaHarness for the separate factory/harness project |
| Add a full top-level `ak improve` lifecycle | Start with an external companion and read-only capability/status projection; require evidence and a follow-up decision before expanding the GA command surface |
| Make agentic-kit generate and own signing keys | Keep signing semantics and key-provider ownership with the system that verifies receipts; expose references only if a later key-lifecycle design proves install, rotation, redaction, and uninstall safety |
| Persist MetaHarness preferences and key paths in `kit.json` | Do not add state until a stable upstream contract and an agentic-kit ownership model exist |
| Treat Ruflo version facts as the capability contract | Probe supported verbs and structured schemas; command availability has changed across branches/releases |
| Present MetaHarness score dimensions as repository facts | Label them as static pre-scaffold estimates derived from repository signals and the recommended policy |
| Use current `ak run --json` as the adapter boundary | First version and sanitize a companion result envelope; the current payload is machine-readable, not yet a public interop contract |
| Let Darwin improve “agentic-kit” | Limit mutation to MetaHarness's seven harness-policy surfaces; agentic-kit product changes remain normal reviewed code changes |
| Treat MetaHarness routing as a replacement | Use learned routing only as evidence/advice; agentic-kit retains explicit route and provider authority |
| Treat generated harness policy as repository policy | Generate in a sibling, temporary, or dedicated companion workspace and never overwrite user/project configuration |

The branch-only ADR used number 0016, which now belongs to the accepted capability-adapter ADR on
`main`. It must not be merged under that number. ADR-0022 records the revised decision.

### Branch asset disposition

The old branch must not be merged or rebased as a unit. Its unique MetaHarness commit
(`8dcad80`) has the following disposition:

| Branch asset | Disposition on `main` | Reason |
| --- | --- | --- |
| `docs/METAHARNESS-INTEGRATION-PROPOSAL.md` | Replace with this proposal | The old document makes a full internal retrieval workflow the product center; this proposal makes the external assurance companion primary |
| `docs/adr/0016-curated-retrieval-improvement-workflow.md` | Replace with ADR-0022; do not copy or renumber mechanically | Number 0016 is already assigned on `main`, and the decision boundary changed materially |
| `docs/ddd/retrieval-improvement.md` | Retire; do not port | Its aggregates and commands assume agentic-kit owns `ak improve`, signing identity, preferences, review, and promotion UX—responsibilities ADR-0022 does not authorize |
| Branch `docs/adr/README.md` edit | Discard; use the current `main` index entry for ADR-0022 | The branch index predates ADRs 0017–0021 and would regress living-plan history |

The branch also contains an earlier Codex-statusline commit, but `git cherry` identifies it as
patch-equivalent to work already on `main`. It is not part of the MetaHarness migration.

### Documentation-only path to `main`

1. Create a fresh documentation branch from current `main`; do not build on or merge the old
   proposal branch.
2. Commit only this proposal, ADR-0022, and the current ADR index update.
3. Open a pull request that links commit `8dcad80` as replaced history and includes the asset
   disposition table above.
4. Review the PR as a **Proposed architecture decision**, not as implemented functionality. The PR
   must not claim that a companion adapter, result schema, status projection, or `ak improve`
   command exists.
5. Run Markdown lint and internal/external link checks. No runtime, package, configuration, or test
   implementation change is expected from this documentation PR.
6. Merge the documentation PR into `main` after maintainers accept the boundary.
7. After merge, and after confirming no pull request or worktree depends on it, delete the
   unprotected remote and local `docs/metaharness-integration-proposal` branch. The merged proposal
   preserves the old decision's material rationale and exact commit identifier.

Until step 6, keep the old branch as reviewable source history. Deleting it earlier creates no
technical advantage and makes the replacement harder to audit. Branch deletion makes the old
commit unreachable from normal Git refs; if exact long-term patch recovery matters, retain an
explicit archival tag instead of assuming a hosting provider will preserve an unreachable object.

## Integration contract

The first companion adapter should have one narrow shape:

```text
external task + verifier suite
          │
          ▼
MetaHarness candidate worker
          │ spawn with explicit cwd, limits, and sanitized environment
          ▼
      ak run <template> <task> --json
          │
          ▼
versioned companion result → external scorer/receipt
```

The contract must define:

- a schema version independent of internal plan/result object shapes;
- one correlation ID and honest host/model/provider provenance per observed fact;
- terminal categories, escalation evidence, timing, and cleanup/orphan status;
- redaction and maximum-size rules for task text, paths, failures, and outputs;
- no raw protocol streams, dependency handoffs, credentials, environment, or repository files;
- explicit cost evidence (`observed`, `estimated`, `unpriced`, or `unknown`);
- an opt-in retention location with a deletion policy;
- no network or model spend unless the command declares a budget and the user opts in.

MetaHarness's current worker API accepts a function; it does not supply an agentic-kit subprocess
adapter. That adapter is new integration work and must be tested as an anti-corruption layer, not
described as already available.

## Delivery sequence

### Phase 0 — freeze the boundary

- Accept or revise ADR-0022.
- Define representative tasks, external verifiers, data classification, budgets, and retention.
- Specify the versioned companion result envelope; do not change routing behavior.

### Phase 1 — read-only companion

- Run MetaHarness score/genome and dry-run tool/MCP audits from a separate workspace.
- Publish interpretation guidance that distinguishes generated-policy estimates from live findings.
- Record baseline evidence for at least two agentic-kit versions or policies.

### Phase 2 — shadow `ak run` adapter

- Implement the subprocess adapter and sanitized result envelope.
- Evaluate whole pipelines only; leave agentic-kit's internal DAG under its supervisor.
- Collect labeled quality, safety, latency, and cost evidence without writing configuration.

### Phase 3 — advisory optimization

- Produce cost-quality recommendations only after the dataset is representative.
- Show provenance, sample size, confidence, unknowns, and expected budget impact.
- Require explicit application through agentic-kit's existing routing surface.

### Phase 4 — gated companion evolution

- Evolve only approved MetaHarness policy surfaces in an isolated workspace.
- Use held-out tasks and independent QE/review before adopting a variant.
- Keep promotion and rollback deliberate and auditable.

### Optional later phase — internal projection

Add read-only status/dashboard integration only if companion usage demonstrates a recurring user
need and the upstream schema is stable. Any new mutating command, key ownership, route application,
or promotion flow requires a separate ADR or an explicit amendment to ADR-0022.

## Success criteria

- Removing MetaHarness leaves every core agentic-kit lifecycle and execution command functional.
- MetaHarness can compare bounded `ak run` outcomes without controlling its worker lifecycle.
- No companion run mutates `kit.json`, host projections, routing, permissions, or upstream ledgers.
- Every retained artifact has a schema, provenance, redaction policy, budget, and deletion path.
- Score output is labeled as fit/recommendation evidence, not a live security verdict.
- Learned route advice remains shadow-only until a user applies it through the canonical surface.
- Darwin variants cannot write outside the dedicated companion policy workspace.
- Agentic-qe and repository tests remain the release authority for deterministic product behavior.
- No new runtime dependency is added to the zero-dependency agentic-kit package.

## Open questions that require evidence

1. Which result fields can be exported without leaking task or repository content?
2. What verifier suite predicts useful agentic-kit outcomes rather than merely test pass/fail?
3. How many labeled runs are needed before a routing recommendation is statistically useful?
4. Where should companion artifacts live, and what is their retention/deletion contract?
5. Which upstream MetaHarness/Ruflo schemas are stable enough to capability-probe and consume?
6. Does repeated usage justify an internal status projection, or are standalone reports sufficient?

## Sources

- [MetaHarness repository](https://github.com/ruvnet/metaharness)
- [MetaHarness harness worker contract](https://github.com/ruvnet/metaharness/blob/main/packages/harness/src/types.ts)
- [MetaHarness repo scorecard](https://github.com/ruvnet/metaharness/blob/main/packages/create-agent-harness/src/repo-scorecard.ts)
- [MetaHarness Darwin mutation surfaces](https://github.com/ruvnet/metaharness/blob/main/packages/darwin-mode/src/types.ts)
- [Ruflo MetaHarness CLI bridge](https://github.com/ruvnet/ruflo/blob/main/v3/%40claude-flow/cli/src/commands/metaharness.ts)
- [Ruflo ADR-322 at v3.32.26](https://github.com/ruvnet/ruflo/blob/v3.32.26/v3/docs/adr/ADR-322-metaharness-flywheel-integration.md)
- [ADR-0016 — capability-driven adapters](adr/0016-capability-driven-integration-adapters.md)
- [ADR-0018 — generalized host-worker execution](adr/0018-generalized-host-worker-execution.md)
- [ADR-0020 — one stable GA surface](adr/0020-ga-stable-surfaces.md)
- RuvNet Brain source:
  `ruflo/v3/@claude-flow/cli/src/commands/metaharness.ts`
