# Project Autonomous Companion Design

**Status:** Proposed design. This design defines a future opt-in setup profile and does not modify the current agentic-kit CLI.

**Research:** [Project companion research](project-companion-research.md)

## Goal

Let a project explicitly opt into a repeatable autonomous-improvement companion through:

    ak setup --project --autonomous-lab

The profile creates reviewable project configuration and safe GitHub Actions templates. It remains inactive until the project owner configures a valid evaluator, anchor corpus, allowed mutation paths, runtime profile, and publication policy.

## Product boundary

Agentic-kit owns projection mechanics, template compatibility, ownership receipts, validation, upgrade planning, and status. The project owns all decisions that make experimentation meaningful or consequential.

| Agentic-kit owns | Project owner owns |
| --- | --- |
| CLI option, schemas, template versions, lifecycle adapter | Whether the profile is configured and enabled |
| Bounded template rendering and undo | Commands, corpus, verifier, mutation scope |
| Detection and drift report | Budget, provider, network and retention policy |
| GitHub workflow template structure | GitHub secrets, environment, reviewers, rulesets |
| Laboratory runtime discovery | Runtime installation, grants and scheduled execution |
| Read-only status projection | Draft-PR, merge and release authority |

This prevents a generic setup command from treating a guessed test command or inherited model credential as valid authorization.

## User experience

### Setup

The new profile is explicit. It is never inferred from a Git repository or a configuration file.

    ak setup --project --autonomous-lab
    ak setup --project --autonomous-lab --dry-run
    ak setup --project --autonomous-lab --yes

A normal project setup behaves exactly as it does today. The new flag is incompatible with minimal mode. Passing it produces an expanded project trust manifest before mutation, naming each projected file, the external companion probe, and any proposed GitHub template files. Dry-run performs no project, home, network, package, GitHub, or state-directory mutation.

Setup renders a disabled profile and verifies only local file ownership. It does not install the laboratory runtime, initialize an experiment, add secrets, call a model, create a GitHub environment or ruleset, start a daemon, add a schedule, or create a pull request.

### Configure

After setup, project maintainers complete configuration in source control:

    ak autonomous configure --project .
    ak autonomous validate --project .
    ak autonomous plan --project . --json

Configure reads a bounded project inventory and may propose command candidates. It requires an explicit selected evaluator command and a human-labelled, hash-pinned anchor before writing an enabled profile. The command stores no provider key. A successful validate result is an evidence statement about the checked configuration, not a runtime grant.

### Operate

A separate laboratory runtime is discoverable and opt-in:

    ak autonomous status --project .
    ak autonomous lab probe --project .
    ak autonomous run --project . --once
    ak autonomous graduation plan --project .

The first three commands are project-local control-plane operations. Run requires an active project grant and qualified runtime; it is unavailable in a generated-only profile. Graduation plan reads evidence and renders a proposal, but draft PR creation requires a distinct publisher grant.

## Source-controlled project profile

The following generated files are tracked so collaborators can review the companion policy.

    .agentic-kit/autonomous/
    ├── manifest.json
    ├── profile.json
    ├── policy.json
    ├── anchors/development.example.json
    ├── evaluators/project.example.json
    ├── workflows.json
    └── README.md
    .github/workflows/
    ├── agentic-kit-autonomous-verify.yml
    └── agentic-kit-autonomous-graduate.yml

The state directory is not in the repository. Default location is the agentic-kit data directory under a project identity derived from canonical project root and Git remote, with a collision-resistant digest. It contains the local journal, content-addressed evidence, worktrees, grants, cache, and runtime receipts. Setup neither adds an ignore rule nor stores secrets in the project profile.

## Manifest and profile contracts

Manifest:

    {
      "schema": "ak.project-autonomous-manifest/v1",
      "templateVersion": 1,
      "projectId": "sha256:<canonical-project-identity>",
      "managedFiles": [
        ".agentic-kit/autonomous/manifest.json",
        ".agentic-kit/autonomous/profile.json",
        ".agentic-kit/autonomous/policy.json",
        ".agentic-kit/autonomous/anchors/development.example.json",
        ".agentic-kit/autonomous/evaluators/project.example.json",
        ".agentic-kit/autonomous/workflows.json",
        ".agentic-kit/autonomous/README.md",
        ".github/workflows/agentic-kit-autonomous-verify.yml",
        ".github/workflows/agentic-kit-autonomous-graduate.yml"
      ],
      "state": "generated"
    }

Profile:

    {
      "schema": "ak.project-autonomous-profile/v1",
      "enabled": false,
      "runtime": { "mode": "unqualified", "receiptRef": null },
      "evaluation": {
        "anchorManifest": ".agentic-kit/autonomous/anchors/development.example.json",
        "evaluator": ".agentic-kit/autonomous/evaluators/project.example.json",
        "acceptance": "unconfigured"
      },
      "mutation": { "allowedPaths": [], "families": [] },
      "automation": {
        "schedule": "off",
        "providerMode": "off",
        "publication": "local-only"
      }
    }

Policy fields are closed vocabularies. A profile cannot contain arbitrary executable strings outside the selected evaluator contract, wildcard mutation paths, an absolute path, a parent traversal segment, a raw secret, a URL with embedded credentials, an enabled schedule with unqualified runtime, or draft publication without a project publisher grant.

## Template ownership and migration

The profile has a lifecycle adapter with detect, plan, apply, verify, and undo operations.

- Detect confirms schema version, file containment, sentinel ownership, current template digest, and any user modification.
- Plan renders exact create, update, preserve, or conflict actions.
- Apply writes only absent files or files whose existing manifest digest matches the last owned version.
- Verify validates every generated schema and workflow template against the manifest.
- Undo removes only files that still match the exact bytes agentic-kit last wrote. A modified file is preserved and reported.

Generated YAML includes a stable template header with schema, template version, source manifest digest, and ownership slug. Setup does not overwrite a changed workflow. It writes a conflict receipt and requires an explicit migration path. Sync reports drift but never turns an inactive profile on.

## Evaluator and anchor configuration

Each project defines one or more evaluator adapters, selected from a closed registry:

| Adapter type | Required project data | Result |
| --- | --- | --- |
| Node package | package manager, install command, focused test commands | Pass/fail plus normalized duration |
| Rust workspace | manifest location, fixed cargo commands | Pass/fail plus normalized duration |
| Generic command | exact argv array and working directory relative to root | Bounded process result |
| HTTP fixture | local fixture server command and health check | Contract response evidence |

No free-form shell fragment comes from an agent. The generic command format is an argv array with a relative working directory, hard timeout, maximum output, and expected exit codes. A project can have a detected candidate command but has no runnable evaluator until an owner selects it.

The anchor has at least four human-labelled tasks to satisfy the downstream Ruflo format. It also has a project-defined acceptance corpus outside candidate write access. A profile may run deterministic local validation with no provider. Model-backed work needs an explicit project grant that identifies eligible host routes, a global slot ceiling, execution deadline, budget and allowed network boundary.

## GitHub templates

The verify workflow is committed but inert until a candidate PR exists. It runs on pull request and merge group, has contents read permission, no secrets, a candidate-specific concurrency key, and calls a reusable workflow containing schema, path, source-binding, build, test and artifact-validation jobs.

The graduate workflow uses workflow dispatch and accepts a bundle reference, expected main SHA, and patch digest. It is configured with no write permission in the generated default. The project owner must separately configure a protected graduation environment and a publisher identity before a later lifecycle operation can render the write-capable variant.

The template never uses pull request target to execute candidate code. It never creates an automatic merge, release tag, GitHub environment, secret, ruleset, reviewer policy, or branch protection rule. Those are discovered and reported as prerequisites.

## Project graduation

The project companion consumes the shared laboratory graduation bundle defined in the agentic-kit self-improvement design. It adds project identity, project profile digest, evaluator digest, anchor digest, allowed-path decision and expected target main SHA.

A project draft PR is eligible only when:

1. The project profile is enabled, qualified, and current.
2. The source, evaluator, anchor, corpus and policy identities remain fresh.
3. The candidate patch touches only allowed paths.
4. The project acceptance and anchor evidence pass.
5. The project publisher grant is live and unconsumed.
6. The protected GitHub workflow independently verifies the PR commit.
7. The project maintainer and branch rules approve the merge.

A project merge is not automatic. Its merge commit becomes the project laboratory baseline after the next source observation.

## Compatibility profiles

A template must not assume every project is Node. Project kinds are discovered from files and CI metadata, then mapped to explicit compatibility profiles:

- node-pnpm;
- node-npm;
- rust-cargo;
- generic-command;
- unavailable.

Detection only proposes a profile. A project owner accepts it through configure. If no supported profile is confirmed, setup leaves a generated-only profile and reports unavailable rather than emitting a misleading workflow.

New project kinds are added as tested compatibility profiles with their own fixture repository and migration version. They do not broaden the generic command executor or change existing profile semantics.

## Security and operational constraints

- Candidate worktrees and owner-private state are isolated from the project checkout.
- Project guidance is never rewritten except through existing sentinel ownership rules.
- Project source, raw task prompts, acceptance content, secret values, and laboratory journals are absent from generated GitHub template inputs and reports.
- Artifacts are temporary transfer objects, not the permanent evidence store.
- GitHub concurrency limits duplicate jobs; the project journal remains the durable grant, nonce, reservation, and champion authority.
- A profile downgrade or runtime qualification failure pauses work and preserves evidence.
- A project can uninstall the projection without uninstalling agentic-kit or changing normal setup behavior.

## Success criteria

The first supported project can:

1. Run setup with the explicit flag and produce only owned, disabled templates.
2. Complete configure and validate with a real project anchor and deterministic evaluator.
3. Detect profile drift without overwriting user edits.
4. Run one synthetic laboratory candidate in a qualified runtime.
5. Create a synthetic sealed graduation proposal.
6. Verify that proposal on a draft PR without secrets.
7. Refuse stale source, altered template, modified owned file, expired grant, duplicate nonce, unqualified runtime and missing anchor.
8. Remove the companion projection while leaving ordinary project setup, source and CI unchanged.

## Non-goals

This profile does not turn every project into an autonomous agent, replace its CI, infer release approval, centralize all project evidence, or expose a generic remote code-execution API. It also does not make the agentic-kit self-laboratory a shared service for downstream projects.
