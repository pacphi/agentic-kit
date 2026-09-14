# Project Autonomous Companion Operations Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task by task. Steps use checkbox syntax for tracking.

**Goal:** Add project runtime probing, inert GitHub workflow templates, graduation planning, lifecycle migration, and fixture qualification after the project companion foundation is complete.

**Architecture:** These tasks consume the explicit project profile and ownership adapter from the foundation plan. They preserve the generated-only default and introduce no automatic project merge, release, provider spend, or GitHub administration.

**Tech Stack:** Existing JavaScript ESM and JSDoc, optional LAB runtime probe, GitHub Actions templates, agentic-kit sync/status/uninstall surfaces.

**Spec:** [Project companion research](project-companion-research.md), [project companion design](project-companion-design.md), and [foundation plan](project-companion-foundation-plan.md).

## Global Constraints

All constraints in the [foundation plan](project-companion-foundation-plan.md#global-constraints) apply. P07–P11 begin only after P01–P06 pass their focused gates.

---

## Task P07: Runtime probe and project binding

**Files:**

- Create: AK src/lib/autonomous-project/runtime.mjs
- Create: AK src/lib/autonomous-project/project-binding.mjs
- Create: AK src/commands/autonomous-lab.mjs
- Test: AK tests/kit/autonomous-project-runtime.test.mjs
- Test: AK tests/kit/autonomous-project-binding.test.mjs

**Interfaces:**

- probeLabRuntime(root) returns installed, compatible, qualified and authorized facts separately.
- createProjectBinding(profile, projectIdentity) returns an immutable binding request.
- autonomous lab probe never installs packages or launches a worker.

- [ ] **Step 1: Write a no-runtime fallback test**

~~~js
import test from 'node:test';
import assert from 'node:assert/strict';
import { probeLabRuntime } from '../../src/lib/autonomous-project/runtime.mjs';

test('reports unavailable runtime without installing one', async () => {
  const result = await probeLabRuntime('/project', { have: async () => false });
  assert.deepEqual(result, { installed: false, compatible: false, qualified: false, authorized: false });
});
~~~

- [ ] **Step 2: Run the focused test**

Run: node --test tests/kit/autonomous-project-runtime.test.mjs

Expected: failure because runtime probe is absent.

- [ ] **Step 3: Implement probe and binding**

Probe a separately installed laboratory executable through its exact version/help contract. Do not shell out with arbitrary user arguments. Binding supplies project profile digest, root identity and owner-private state location. It is a request; an active runtime grant is created only by the LAB control plane after project-specific authorization.

- [ ] **Step 4: Add optional installation plan**

The command may render an exact install recommendation and compatibility requirements. It must not install a runtime as a side effect of project setup. If an explicit install command is added later, it needs its own trust manifest and separate test suite.

- [ ] **Step 5: Verify runtime facts**

Run: node --test tests/kit/autonomous-project-runtime.test.mjs tests/kit/autonomous-project-binding.test.mjs

Expected: unavailable, incompatible, unqualified and unauthorized states remain distinct.

## Task P08: GitHub Actions template verification

**Files:**

- Create: AK src/lib/autonomous-project/workflows.mjs
- Modify: AK src/lib/autonomous-project/template-registry.mjs
- Test: AK tests/kit/autonomous-project-workflows.test.mjs
- Test: AK tests/kit/autonomous-project-templates.test.mjs

**Interfaces:**

- validateAutonomousWorkflow(text) returns workflow facts.
- graduationWorkflowTemplate(context) returns inert manual-dispatch YAML.
- verificationWorkflowTemplate(context) returns pull-request and merge-group YAML.

- [ ] **Step 1: Write a permission ceiling test**

~~~js
import test from 'node:test';
import assert from 'node:assert/strict';
import { verificationWorkflowTemplate } from '../../src/lib/autonomous-project/workflows.mjs';

test('does not grant write permissions to candidate verification', () => {
  const text = verificationWorkflowTemplate({ manifestDigest: 'sha256:' + '1'.repeat(64) });
  assert.match(text, /contents: read/);
  assert.doesNotMatch(text, /contents: write|pull-requests: write|secrets:/);
});
~~~

- [ ] **Step 2: Run the focused test**

Run: node --test tests/kit/autonomous-project-workflows.test.mjs

Expected: failure because workflow template code is absent.

- [ ] **Step 3: Implement workflow templates**

Verification workflow uses pull_request and merge_group, explicit contents read permission, unique check names, bounded concurrency and no secret context. It calls a reusable local workflow with typed inputs. Graduation workflow uses workflow_dispatch with inputs for bundle reference, expected main SHA and patch digest, but starts without write permission or a publisher step.

- [ ] **Step 4: Validate generated YAML structurally**

Use the repository's existing YAML parsing approach or a dependency-free structural checker. Assert triggers, required job names, explicit permissions, no pull_request_target, no workflow_run, no inherited secrets, no checkout of attacker-controlled reference in a privileged job and no unbounded artifact retention.

- [ ] **Step 5: Verify templates**

Run: node --test tests/kit/autonomous-project-workflows.test.mjs tests/kit/autonomous-project-templates.test.mjs

Expected: templates are generated, inert and least privilege by default.

## Task P09: Project graduation bridge

**Files:**

- Create: AK src/lib/autonomous-project/graduation.mjs
- Create: AK src/commands/autonomous-graduation.mjs
- Test: AK tests/kit/autonomous-project-graduation.test.mjs
- Test: AK tests/kit/autonomous-project-graduation-workflow.test.mjs

**Interfaces:**

- validateProjectGraduationBundle(bundle, profile, currentSource)
- planProjectGraduation(bundle, profile, currentSource)
- project graduation plan remains read-only.

- [ ] **Step 1: Write a stale-main test**

~~~js
import test from 'node:test';
import assert from 'node:assert/strict';
import { planProjectGraduation } from '../../src/lib/autonomous-project/graduation.mjs';

test('refuses a bundle based on an old project main commit', () => {
  const result = planProjectGraduation({ expectedMainSha: 'a'.repeat(40) }, { enabled: true }, { mainSha: 'b'.repeat(40) });
  assert.equal(result.state, 'stale');
});
~~~

- [ ] **Step 2: Run the focused test**

Run: node --test tests/kit/autonomous-project-graduation.test.mjs

Expected: failure because graduation planning is absent.

- [ ] **Step 3: Validate project-local graduation**

Require active profile, exact project identity, allowed patch paths, current main SHA, fresh evaluator/anchor/acceptance evidence and an unconsumed LAB bundle. A plan returns required GitHub prerequisites and a draft PR preview, never a GitHub mutation.

- [ ] **Step 4: Add publisher boundary design hook**

Expose a publisher request object with project identity, bundle digest, branch name and expected SHA. It has no token or merge operation. A future separate publisher implementation requires protected environment configuration, ruleset receipt and its own authorization.

- [ ] **Step 5: Verify graduation planning**

Run: node --test tests/kit/autonomous-project-graduation.test.mjs tests/kit/autonomous-project-graduation-workflow.test.mjs

Expected: modified patch, missing anchor, stale source, unqualified runtime and missing ruleset receipt are denied.

## Task P10: Sync, status, migration and uninstall

**Files:**

- Modify: AK src/commands/sync.mjs
- Modify: AK src/commands/status.mjs
- Modify: AK src/commands/uninstall.mjs
- Create: AK src/lib/autonomous-project/migration.mjs
- Test: AK tests/kit/autonomous-project-sync.test.mjs
- Test: AK tests/kit/autonomous-project-uninstall.test.mjs
- Test: AK tests/kit/autonomous-project-migration.test.mjs

**Interfaces:**

- inspectAutonomousProjectDrift(root)
- planAutonomousProjectMigration(facts, targetVersion)
- removeAutonomousProjectProjection(root)

- [ ] **Step 1: Write an uninstall preservation test**

~~~js
import test from 'node:test';
import assert from 'node:assert/strict';
import { removeAutonomousProjectProjection } from '../../src/lib/autonomous-project/migration.mjs';

test('preserves a workflow changed after setup', () => {
  const result = removeAutonomousProjectProjection('/project', {
    '.github/workflows/agentic-kit-autonomous-verify.yml': 'user edit',
  });
  assert.equal(result.preserved.length, 1);
});
~~~

- [ ] **Step 2: Run the focused test**

Run: node --test tests/kit/autonomous-project-uninstall.test.mjs

Expected: failure because migration support is absent.

- [ ] **Step 3: Implement detect-only sync**

Sync and status report generated, configured, runnable, conflict, drift, migration-required and unavailable states. They do not enable the profile, install a runtime or alter a workflow. A proposed migration has exact file actions and template versions.

- [ ] **Step 4: Implement safe removal**

Remove only exact owned bytes. Preserve user-modified workflow/profile files and all owner-private LAB state. Provide an explicit separate cleanup plan for state with retention information; do not delete state automatically.

- [ ] **Step 5: Verify migrations**

Run: node --test tests/kit/autonomous-project-sync.test.mjs tests/kit/autonomous-project-uninstall.test.mjs tests/kit/autonomous-project-migration.test.mjs

Expected: ordinary sync and uninstall behavior is unchanged for projects without the profile.

## Task P11: Fixture project, integration qualification and documentation

**Files:**

- Create: AK tests/fixtures/autonomous-project-node/
- Create: AK tests/fixtures/autonomous-project-rust/
- Create: AK tests/kit/autonomous-project-integration.test.mjs
- Create: AK docs/AUTONOMOUS-PROJECTS.md
- Modify: AK docs/SETUP.md
- Modify: AK docs/MAINTENANCE.md
- Modify: AK docs/autonomous/README.md

**Interfaces:**

- Fixture projects have a checked evaluator, anchor, policy and generated projection.
- Integration harness exposes a fake external LAB runtime with no provider/network capability.
- Documentation distinguishes generated-only from configured, runnable and graduation-ready.

- [ ] **Step 1: Write an end-to-end generated-only test**

~~~js
import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../../src/commands/setup.mjs';

test('generates an inactive project companion without external execution', async () => {
  const code = await run({ flags: { project: true, 'autonomous-lab': true, yes: true }, pkgRoot: '/fixture' });
  assert.equal(code, 0);
});
~~~

- [ ] **Step 2: Run the focused test**

Run: node --test tests/kit/autonomous-project-integration.test.mjs

Expected: failure until all prior tasks are complete.

- [ ] **Step 3: Build fixtures and test path**

Use a Node fixture and Rust fixture with deterministic commands, no provider keys, no network and synthetic anchors. Assert setup render, repeat setup, validate, drift conflict, sync report, undo and no-runtime probe. Capture project and home snapshots before dry-run.

- [ ] **Step 4: Document operating model**

Document profile generation, configure, runtime probe, status, migration, emergency pause, removal, GitHub prerequisites and project-owner responsibilities. Link the research, design, project plan, graduation design and self-laboratory plan without implying implementation exists before it ships.

- [ ] **Step 5: Run quality gates**

Run: pnpm run typecheck
Run: pnpm run lint
Run: pnpm run lint:cc
Run: pnpm run lint:md
Run: pnpm run build
Run: node --test tests/kit/autonomous-project-*.test.mjs
Run: pnpm test

Expected: all focused and repository checks pass. Report actual coverage and any platform or GitHub capability limitation.

## Plan self-review

| Requirement | Tasks |
| --- | --- |
| Explicit opt-in setup flag | P01 and P05 |
| Versioned project templates and ownership | P02 through P04 |
| Project-owned evaluator and anchor | P06 |
| Separate LAB runtime and state | P07 |
| Inert GitHub workflows | P03 and P08 |
| Project-local graduation planning | P09 |
| Migration, status and removal | P10 |
| Fixture qualification and docs | P11 |

This plan intentionally omits automatic project merge, release, GitHub administration, secrets, provider spend and source mutation. Those remain project-owner decisions after the profile and shared graduation protocol are implemented and qualified.
