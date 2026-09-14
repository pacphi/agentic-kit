# Project Autonomous Companion Research

**Status:** Research and design input. This document does not add a setup flag, generate project files, install a companion, configure GitHub, or start an experiment.

## Question

Can agentic-kit offer an explicit project setup profile that gives downstream projects the same bounded laboratory and graduation path planned for agentic-kit itself?

**Recommendation:** yes. Implement an opt-in project companion profile, requested by a new setup flag named autonomous-lab. It should generate versioned project templates and lifecycle receipts, while a separately installed laboratory runtime executes experiments only after project-specific configuration is complete.

This is not a clone of agentic-kit's own laboratory. It is a consistent product shape with per-project ownership of evaluation, mutation scope, evidence, GitHub policy, and state.

## Existing agentic-kit seam

Current project setup already has the right ownership pattern. It runs when invoked in a Git project or forced with the project flag, captures guidance before upstream initializers run, reconciles only sentinel-owned project guidance, initializes Ruflo and Agentic QE, applies provider projections, and verifies project memory. [^1] The project guidance module explicitly preserves user-authored CLAUDE and AGENTS content while managing only bounded sentinel blocks. [^2]

That establishes four rules for the new profile:

1. It must be an explicit setup option, never enabled merely because a project has a Git directory.
2. It must support dry-run, detect, plan, apply, verify, and undo semantics.
3. It may update only files it owns, identified by a manifest, template version, and ownership receipt.
4. It must not create a provider credential, alter a project route, write GitHub repository settings, or enable a schedule by default.

The companion should reuse agentic-kit's existing lifecycle-adapter protocol and ownership records rather than inventing a second mutation convention. [^3]

## What should be common and what must remain project-specific

| Common agentic-kit template | Project-owned configuration |
| --- | --- |
| Manifest schema and template version | Build, test, benchmark, and verifier commands |
| Evidence, receipt, and graduation schemas | Human-labelled anchor and acceptance corpus |
| GitHub workflow structure and least-privilege permissions | Required checks, ruleset, reviewers, environment names |
| Lifecycle detect, plan, apply, verify, undo | Allowed mutation paths and experiment families |
| Status, drift, and migration behavior | Provider mode, budget, retention, schedule, publication policy |
| Safe draft-PR protocol | Whether a proposal may ever be created |

A generated profile begins in configured false state. Setup may offer a detected command candidate, but it may not schedule or evaluate until the project owner accepts a complete profile. This mirrors Ruflo's downstream anchor behavior: foreign projects need their own human-labelled, hash-pinned anchor rather than silently inheriting the upstream benchmark. [^4]

## RuvNet patterns worth reusing

MetaHarness has an implemented GitHub Actions host generator. Its tests show a default-deny permission model: a basic generated workflow receives contents read; PR creation adds only contents and pull-request write; unrelated allow tokens do not widen permissions. It emits a local composite action plus workflow and installation runbook. [^5]

Dream Machine shows the right autonomy boundary for project research. Its optional nightly workflow can create a witnessed issue and draft PR, while its own merge guard is read-only and states that a human still decides whether to merge. [^6][^7]

Ruflo's promotion model separates evaluation from activation and fails closed when the candidate baseline, anchor, gate, policy schema, ledger head, or receipt state is stale. [^8] This is the model for project companion graduation: a project profile can produce a laboratory proposal, but its protected GitHub PR merge remains the only mainline application step.

Autogenous supplies useful proposal invariants—candidate/parent binding, expiry, evidence and rollback—but its real enforcement and deployment portions remain partly pending. It should be an optional project observer/proposer integration, never a generated production promotion service. [^9]

## Proposed product shape

The user-facing entry point is:

    ak setup --project --autonomous-lab

The option is a local project projection. It is not a machine-wide setting, and it does not imply that every project using agentic-kit has a laboratory.

The first invocation produces a source-controlled profile plus an owner-private runtime-state location. The source-controlled files make the project policy reviewable in Git. The owner-private state holds journal rows, evidence objects, worktrees, caches, local receipts, and any granted secrets outside the project checkout.

    project root
    ├── .agentic-kit/
    │   └── autonomous/
    │       ├── manifest.json
    │       ├── profile.json
    │       ├── policy.json
    │       ├── anchors/
    │       │   └── development.example.json
    │       ├── evaluators/
    │       │   └── project.example.json
    │       └── README.md
    └── .github/
        └── workflows/
            ├── agentic-kit-autonomous-verify.yml
            └── agentic-kit-autonomous-graduate.yml

    owner-private state
    └── agentic-kit projects / project-hash / autonomous /
        ├── journal.sqlite
        ├── evidence/
        ├── worktrees/
        └── grants/

The example anchor and evaluator are intentionally not runnable. They are valid schema documents with an enabled false profile and no schedule or provider. A project owner completes them through a later configure command and commits the result through its normal review process.

## GitHub Actions role

Templates should create three separate trust planes.

| Plane | Generated workflow behavior | Permission ceiling |
| --- | --- | --- |
| PR verification | Runs on pull request and merge group; rebuilds the proposed commit; no secrets | Contents read |
| Manual graduation | Manual dispatch, protected environment, re-verifies bundle before creating one draft PR | Contents and pull-request write only |
| Release | Not generated or changed by this profile | Existing repository release policy |

GitHub Actions supports typed manual workflow inputs, explicit token scopes, reusable workflows, concurrency groups, environments, deployment protection rules, rulesets, and artifact attestations. [^10][^11][^12] The templates should use these as outer controls, not as a substitute for the per-project journal, source binding, and acceptance logic.

Do not run candidate code under pull request target or workflow run with privileged credentials. GitHub warns that those triggers are dangerous when they check out untrusted PR code or consume untrusted artifacts. [^13] Use pull request for candidate verification. A manually approved publisher is the only workflow that needs a protected environment and write permission.

GitHub artifacts are useful for bounded transfer of reports and build outputs, but their default retention is finite and deletion is irreversible. They cannot be the project's permanent evidence ledger. [^14]

## How a project graduates an improvement

The project companion follows the same states as the agentic-kit laboratory, but every identity is project-local:

1. The project profile admits an experiment only after its evaluator, anchor, mutation scope, budget, runtime qualification, and publication policy are configured.
2. LAB produces a source-bound candidate, independent baseline/candidate evidence, and a laboratory champion.
3. LAB seals a graduation bundle against the expected project main commit.
4. A separately approved project publisher creates one draft PR, or the project owner creates it manually from the sealed patch.
5. GitHub independently validates the PR commit, reruns project checks, and attests the verified artifact.
6. The project's ruleset and maintainers decide whether to merge.
7. A merge becomes the next laboratory baseline. Existing project release policy decides whether and when to publish.

No project gets automated merging, tag creation, release publication, default route changes, provider configuration, or scheduled model calls merely by using the setup flag.

## Automation availability and limits

The generated profile can safely automate:

- rendering and updating owned templates;
- drift detection and migration planning;
- local schema and ownership validation;
- PR verification after a candidate branch exists;
- report and evidence-artifact creation;
- manual, protected draft-PR publication after a project-specific grant;
- workflow dispatch for a maintainer-approved test run.

It must defer:

- project-specific command inference as execution authority;
- creation of GitHub secrets, environments, rulesets, or reviewer policy;
- unattended provider spend;
- automatic mainline merge or release;
- use of global or another project's corpus and journal;
- ownership of project AGENTS, CLAUDE, CI, or release documentation outside sentinel-owned sections and generated files.

## Recommended delivery sequence

1. Add profile schema, template registry, lifecycle adapter, dry-run, ownership, and undo behavior.
2. Add configure and validate commands that require an anchor and verifier before a profile can become runnable.
3. Add status and sync drift detection with migration receipts.
4. Add inert GitHub verification and graduation templates.
5. Add a separate laboratory runtime installation/probe and a project binding adapter.
6. Qualify one fixture project with synthetic evidence before enabling real host execution.
7. Add draft-PR graduation only after the shared graduation protocol passes its synthetic tests.
8. Treat each new project type as a compatibility profile, not as an excuse to weaken the generic contract.

## Sources

[^1]: Agentic-kit, [project setup implementation](../../src/commands/setup.mjs) and [setup tests](../../tests/kit/setup-command.test.mjs), inspected September 14, 2026.

[^2]: Agentic-kit, [project guidance ownership boundary](../../src/lib/project-guidance.mjs), inspected September 14, 2026.

[^3]: Agentic-kit, [lifecycle adapter contract](../../src/lib/adapters/lifecycle.mjs), inspected September 14, 2026.

[^4]: Ruflo, [ADR-331: Project-Local Flywheel Evaluation Anchors](https://github.com/ruvnet/ruflo/blob/1992ffb020fd461a7c2a3bb64f30476a0c5d2d26/v3/docs/adr/ADR-331-project-local-flywheel-anchors.md), current main commit checked September 14, 2026.

[^5]: MetaHarness, [GitHub Actions host tests](https://github.com/ruvnet/metaharness/blob/d5833dc6512ac1adeeef91a331c29055cd8a4dbb/packages/host-github-actions/__tests__/github-actions.test.ts), checked September 14, 2026.

[^6]: Dream Machine, [nightly research workflow](https://github.com/ruvnet/dream-machine/blob/3edd426f6c9c4b1e80235f7447dc863e749345cc/.github/workflows/dream-nightly.yml), checked September 14, 2026.

[^7]: Dream Machine, [human merge policy guard](https://github.com/ruvnet/dream-machine/blob/3edd426f6c9c4b1e80235f7447dc863e749345cc/.github/workflows/automerge.yml), checked September 14, 2026.

[^8]: Ruflo, [ADR-322A: Evaluation and promotion transaction model](https://github.com/ruvnet/ruflo/blob/1992ffb020fd461a7c2a3bb64f30476a0c5d2d26/v3/docs/adr/ADR-322A-evaluation-promotion-transaction.md), current main commit checked September 14, 2026.

[^9]: Autogenous, [ADR-403: The verifiable execution loop](https://github.com/ruvnet/autogenous/blob/7bf327a9754ce798364dbee8b2825af42a421fd4/docs/adr/ADR-403-verifiable-execution-loop.md), checked September 14, 2026.

[^10]: GitHub Docs, [Workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax), accessed September 14, 2026.

[^11]: GitHub Docs, [Reuse workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows), accessed September 14, 2026.

[^12]: GitHub Docs, [Deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments), accessed September 14, 2026.

[^13]: GitHub Docs, [Secure use reference](https://docs.github.com/en/actions/reference/security/secure-use), accessed September 14, 2026.

[^14]: GitHub Docs, [Workflow artifacts](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflow-artifacts) and [artifact retention](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/remove-workflow-artifacts), accessed September 14, 2026.
