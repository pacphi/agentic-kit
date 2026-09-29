# Graduation from Laboratory Evidence to agentic-kit Mainline

**Status:** Research-backed design amendment. No workflow, GitHub App, branch rule, environment, credential, or scheduled job is created by this document.

## Decision

Use the laboratory to discover and verify candidates, then graduate a candidate through GitHub as a normal protected pull request. A laboratory champion is eligible to become a proposal; it never receives permission to modify main.

~~~mermaid
flowchart LR
    A[Laboratory candidate] --> B[Independent acceptance and anchor checks]
    B --> C[Laboratory champion]
    C --> D[Signed graduation manifest and sealed patch]
    D --> E[Draft PR on a dedicated branch]
    E --> F[GitHub CI reruns exact checks]
    F --> G[Required review and protected merge]
    G --> H[Tag-triggered release workflow]
~~~

The separation is deliberate. Ruflo evaluates a candidate independently from the transaction that activates its own policy. Its promotion transaction accepts only an eligible, unconsumed receipt whose baseline, gate, policy schema, safety envelope, ledger head, and expiry all still match. [^1] Agentic-kit should copy that structure for source: laboratory selection may produce a candidate, but a protected PR merge remains the only transition into mainline.

## What the RuvNet projects do

### Ruflo separates evaluation from active-policy promotion

Ruflo records immutable evaluation receipts separately from its active-policy state. Evaluation can persist evidence but cannot change served policy. Promotion requires explicit confirmation and uses a compare-and-swap transaction that consumes a single eligible receipt, advances one lineage head and serving epoch, and fails closed on stale state. [^1]

For downstream projects, Ruflo requires a human-labelled, hash-pinned project anchor. A foreign repository without one fails closed rather than silently evaluating against Ruflo's development-history benchmark. [^2]

**Use here:** pin project evaluation tasks, make evidence stale when its source or gate changes, and use compare-and-swap when selecting a laboratory champion or proposal.

**Do not reuse as-is:** Ruflo's active champion is retrieval-policy state. It is neither a Git branch nor authority to merge agentic-kit code.

### MetaHarness makes promotion replayable

MetaHarness Flywheel signs promotion receipts and supports replay that checks signatures, lineage, pinned gate identity, and—when supplied—the gate's result on sealed scores. [^3] This makes a claimed improvement independently inspectable.

Its GitHub Actions host design uses a composite action with structured task and dry-run inputs, structured output, and workflow-selected GITHUB_TOKEN permissions. The ADR heading calls the host implemented, but its body retains older proposal text. Treat the package's released surface as a capability to probe rather than assuming every documented operation is available in every installed version. [^4]

Its publish workflow demonstrates a distinct release phase: exact tag-SHA binding, smoke tests, claim and publish-dry-run gates, then registry verification. [^5]

**Use here:** keep replayable evidence and an independent release pipeline. A Flywheel promoted node is only a laboratory result.

### Dream Machine automates research but does not merge

Dream Machine's optional nightly workflow performs research and hypothesis generation, files a witnessed issue, and creates a draft PR for its ledger. It explicitly labels the job research-only; candidate evaluation and promotion are outside that action, and the schedule is disabled by default. [^6]

Its human merge guard checks only base-branch policy with read-only permissions and explicitly says an eligible result still needs separate human review and merge. [^7]

**Use here:** a lab may automatically prepare a draft proposal. It must not merge the proposal.

### Autogenous binds promotion to exact evidence and rollback

Autogenous constructs a single-use VerifiedPromotion that binds candidate, parent, corpus, receipt, constitution, expiry, and rollback target. Its documented real traffic actuation and enforced isolation are still partly implemented or pending, so it is a source of graduation invariants rather than a ready agentic-kit deployment backend. [^8]

**Use here:** bind candidate and parent identity, require expiry and rollback preparation, and recover safely after interruption.

## Proposed agentic-kit graduation protocol

### 1. Seal a graduation bundle

After a laboratory champion clears the independent acceptance shard and frozen anchor, LAB emits one immutable bundle with:

- baseline and candidate source bindings, kit artifact, toolchain, corpus, verifier, gate, and evidence digests;
- expected main commit SHA;
- a binary-safe, path-restricted patch or branch-tree manifest;
- acceptance, anchor, cleanup, resource, freshness, and laboratory receipt references;
- a single-use nonce, expiry, signer, and revert-PR strategy.

The bundle excludes raw prompts, transcripts, credentials, arbitrary paths, and unknown costs represented as zero. A changed main SHA, verifier, corpus, gate, toolchain, patch digest, or expired nonce makes it stale and requires re-evaluation.

### 2. Publish a draft PR through a dedicated publisher

Only a separately approved publisher grant may create one branch named lab slash candidate ID and one draft PR. It re-verifies the bundle immediately before the remote call, records the manifest and receipt digests in the PR, and never force-pushes, merges, tags, publishes packages, changes branch rules, or edits user configuration.

The publisher should run in a protected GitHub environment, use a dedicated identity, and receive only contents and pull-request write access. GitHub environments can require reviewers, restrict branches, protect environment secrets, and apply custom protection rules. [^17]

### 3. Independently rerun verification in GitHub Actions

The PR workflow must build and verify the actual PR commit. It does not trust a local laboratory success or a downloaded result as proof.

| Job | Trigger and permission posture | Required result |
| --- | --- | --- |
| graduation validate | pull request and merge group; contents read | Validate bundle schema, digests, changed-path allowlist, and source binding |
| graduation verify | pull request; contents read; no secrets | Rebuild candidate, run relevant agentic-kit checks, and rerun deterministic verifiers and anchor checks |
| graduation attest | after verification; id-token, attestations, and contents read | Attest the verified build and evidence manifest |

Use pull_request—not pull_request_target—to execute candidate code. GitHub warns that privileged pull_request_target and workflow_run triggers become dangerous when they check out untrusted PR code or consume untrusted artifacts. [^9] Dream Machine's guard is a narrow safe use: it checks base-branch policy and does not execute PR code. [^7]

GitHub artifact attestations bind an artifact to its build workflow, repository, commit, environment, and triggering event. They prove provenance and integrity, not test adequacy or merge authorization. [^10]

### 4. Let GitHub's protected-mainline controls decide the merge

Require an up-to-date PR, at least one independent approval, named status checks, and no direct or force push to main. GitHub rulesets and branch protection can require reviews, status checks, signed commits, linear history, merge queue, deployment success, code scanning, and blocked force pushes. [^11]

Use unique required check names:

- ci / quality
- ci / test (ubuntu-latest, node 22)
- graduation / validate
- graduation / verify
- graduation / attest

GitHub documents that repeated check names across workflows can make required checks ambiguous. [^12] If a merge queue is enabled, required PR workflows must also listen for merge_group or GitHub will not create their checks for queued changes. [^13]

The protected PR merge is the mainline graduation point. It invalidates the old laboratory baseline and becomes the source snapshot for future experiments.

### 5. Release is a separate post-merge decision

Keep tag-triggered release independent of the laboratory. Agentic-kit's current release workflow starts from version tags and requests an OIDC identity for npm provenance. A laboratory champion does not create a tag, publish an npm package, create a GitHub Release, or deploy.

For a later release candidate, use a protected release environment, manual selection of the exact merged SHA or tag, exact-artifact packaging, provenance attestation, and post-publish installation smoke checks. This follows MetaHarness's exact-SHA publish gates and Autogenous radio-moe's pack, install, then provenance-publish workflow. [^5][^14]

## GitHub Actions automation to adopt

### Initial automation

- Keep LAB research on its qualified runner and send GitHub a sealed proposal only.
- Run validation and independent verification on each laboratory draft PR.
- Use workflow dispatch for an explicit maintainer request to create or refresh a proposal.
- Use a graduation candidate concurrency group with cancel-in-progress false. GitHub concurrency avoids overlapping runs but is not a durable transaction or a replacement for the LAB journal. [^15]
- Put shared verification in a reusable workflow using workflow call, typed inputs, and named secrets only. Do not use secrets inherit for graduation. [^16]
- Generate an attestation only after the independent verifier passes.

### Automation to defer

- Auto-merge of laboratory PRs.
- Privileged workflows that execute candidate code or consume candidate-controlled artifacts.
- Automatic changes to kit configuration, host projections, provider settings, route defaults, repository rules, or permissions.
- Use of GitHub Actions concurrency as the sole candidate lock.
- Release or tagging based on a laboratory champion.
- Secret-backed model calls from scheduled PR code.

GitHub organization workflow-execution protections can restrict who triggers manual workflows and which events are permitted. Where available, use them to limit workflow dispatch and tightly control or prohibit pull_request_target. [^18]

## Plan amendment: Task T18

T18 implements this graduation boundary after unattended qualification:

- LAB graduation bundle, validator, publisher, and re-verifier;
- agentic-kit graduation and reusable GitHub workflows;
- a branch-protection or ruleset configuration receipt;
- synthetic draft-PR, stale-baseline, duplicate-nonce, path-escape, untrusted-artifact, and protected-merge simulations.

T18 does not authorize a real merge. It is complete when GitHub independently verifies a synthetic proposal and normal protected PR review remains required.

## Sources

[^1]: Ruflo, [ADR-322A: Evaluation and promotion transaction model](https://github.com/ruvnet/ruflo/blob/1992ffb020fd461a7c2a3bb64f30476a0c5d2d26/v3/docs/adr/ADR-322A-evaluation-promotion-transaction.md), current main commit checked September 14, 2026.

[^2]: Ruflo, [ADR-331: Project-Local Flywheel Evaluation Anchors](https://github.com/ruvnet/ruflo/blob/1992ffb020fd461a7c2a3bb64f30476a0c5d2d26/v3/docs/adr/ADR-331-project-local-flywheel-anchors.md), current main commit checked September 14, 2026.

[^3]: MetaHarness, [Flywheel replay implementation](https://github.com/ruvnet/metaharness/blob/d5833dc6512ac1adeeef91a331c29055cd8a4dbb/packages/flywheel/src/replay.ts), checked September 14, 2026.

[^4]: MetaHarness, [ADR-033: GitHub Actions as a Harness Host](https://github.com/ruvnet/metaharness/blob/d5833dc6512ac1adeeef91a331c29055cd8a4dbb/docs/adrs/ADR-033-host-github-actions.md), checked September 14, 2026.

[^5]: MetaHarness, [publish workflow](https://github.com/ruvnet/metaharness/blob/d5833dc6512ac1adeeef91a331c29055cd8a4dbb/.github/workflows/publish.yml), checked September 14, 2026.

[^6]: Dream Machine, [nightly research workflow](https://github.com/ruvnet/dream-machine/blob/3edd426f6c9c4b1e80235f7447dc863e749345cc/.github/workflows/dream-nightly.yml), checked September 14, 2026.

[^7]: Dream Machine, [human merge policy guard](https://github.com/ruvnet/dream-machine/blob/3edd426f6c9c4b1e80235f7447dc863e749345cc/.github/workflows/automerge.yml), checked September 14, 2026.

[^8]: Autogenous, [ADR-403: The verifiable execution loop](https://github.com/ruvnet/autogenous/blob/7bf327a9754ce798364dbee8b2825af42a421fd4/docs/adr/ADR-403-verifiable-execution-loop.md), checked September 14, 2026.

[^9]: GitHub Docs, [Secure use reference](https://docs.github.com/en/actions/reference/security/secure-use), accessed September 14, 2026.

[^10]: GitHub Docs, [Artifact attestations](https://docs.github.com/en/actions/concepts/security/artifact-attestations), accessed September 14, 2026.

[^11]: GitHub Docs, [About protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches), accessed September 14, 2026.

[^12]: GitHub Docs, [About protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches), accessed September 14, 2026.

[^13]: GitHub Docs, [Troubleshooting required status checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks), accessed September 14, 2026.

[^14]: Autogenous, [radio-moe npm release workflow](https://github.com/ruvnet/autogenous/blob/7bf327a9754ce798364dbee8b2825af42a421fd4/.github/workflows/radio-moe-npm-release.yml), checked September 14, 2026.

[^15]: GitHub Docs, [Control the concurrency of workflows and jobs](https://docs.github.com/en/enterprise-cloud%40latest/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency), accessed September 14, 2026.

[^16]: GitHub Docs, [Reuse workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows), accessed September 14, 2026.

[^17]: GitHub Docs, [Deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments), accessed September 14, 2026.

[^18]: GitHub Docs, [Workflow execution protections](https://docs.github.com/en/organizations/managing-organization-settings/actions-policies/workflow-execution-protections), accessed September 14, 2026.
