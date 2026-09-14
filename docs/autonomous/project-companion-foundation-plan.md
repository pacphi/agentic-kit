# Project Autonomous Companion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task by task. Steps use checkbox syntax for tracking.

**Goal:** Add an explicit project setup profile that projects versioned autonomous-laboratory templates into a project without enabling experiments or changing project authority by default.

**Architecture:** Agentic-kit adds an opt-in setup flag and a lifecycle-owned project projection. A separate laboratory runtime, discovered rather than silently installed, reads the project profile after the project owner configures an anchor, evaluator, mutation policy, runtime grant, and publication policy. GitHub workflows independently verify proposals but never merge them.

**Tech Stack:** Existing JavaScript ESM and JSDoc, Node built-ins, agentic-kit lifecycle adapters and file ownership, optional external LAB runtime, GitHub Actions YAML templates, Ruflo/AgentDB/AQE integration through existing installed surfaces.

**Spec:** [Project companion research](project-companion-research.md) and [project companion design](project-companion-design.md).

## Global Constraints

- Preserve existing setup behavior when autonomous-lab is absent.
- The new flag is explicit and incompatible with minimal mode.
- Preserve agentic-kit's zero-runtime-dependency package and current lockfile unless a core implementation dependency is independently justified.
- Create no GitHub resource, provider credential, schedule, experiment, draft PR, branch, tag, release, environment, ruleset, secret, or model call during setup.
- Render only owned project files listed in the manifest; do not overwrite modified owned files.
- Keep owner-private journal, evidence, worktrees, grants and secrets outside the project root.
- Use literal argv arrays for configured commands. No model supplies a shell fragment, path outside root, or provider credential.
- Generated workflows execute candidate code only on pull request, never pull request target or privileged workflow run.
- Normal protected PR review and release processes retain their authority.
- Follow existing project guidance and lifecycle ownership conventions.
- Each task ends with focused tests. Do not commit, push, or publish without separate authorization.

---

## Task P01: CLI flag and project-profile selection

**Files:**

- Modify: AK src/commands/setup.mjs
- Modify: AK bin/agentic-kit.mjs
- Create: AK src/lib/autonomous-project/options.mjs
- Test: AK tests/kit/setup-command.test.mjs
- Test: AK tests/kit/autonomous-project-options.test.mjs

**Interfaces:**

- Produces parseAutonomousProjectOptions(flags) returning an object with requested, mode, and error.
- Consumes existing setup flags and project-scope detection.
- Adds the boolean autonomous-lab option only to setup.

- [ ] **Step 1: Write failing option tests**

~~~js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAutonomousProjectOptions } from '../../src/lib/autonomous-project/options.mjs';

test('requires project scope for autonomous-lab', () => {
  assert.deepEqual(parseAutonomousProjectOptions({ 'autonomous-lab': true, project: false, minimal: false }, { inProject: false }), {
    requested: true, mode: 'invalid', error: 'autonomous-lab requires project scope',
  });
});
~~~

- [ ] **Step 2: Run the focused test**

Run: node --test tests/kit/autonomous-project-options.test.mjs

Expected: failure because the options module is absent.

- [ ] **Step 3: Implement the closed option state**

Create the options module. Accept only absent or boolean autonomous-lab values. Return generated-only for an explicit project profile, disabled for an absent flag, and invalid for minimal or no project scope. Do not read or write config in this module.

- [ ] **Step 4: Wire setup**

Add autonomous-lab to setup options and help. Pass its parsed state to the project setup phase only after existing trust disclosure. Extend the project trust manifest with generated-file projections and owner-private state location as planned operations. Dry-run prints the exact profile plan.

- [ ] **Step 5: Verify compatibility**

Run: node --test tests/kit/autonomous-project-options.test.mjs tests/kit/setup-command.test.mjs

Expected: focused tests pass; existing minimal and ordinary project setup tests remain unchanged.

## Task P02: Manifest, profile and policy schema

**Files:**

- Create: AK src/lib/autonomous-project/schema.mjs
- Create: AK src/lib/autonomous-project/manifest.mjs
- Create: AK src/lib/autonomous-project/templates/manifest.json
- Create: AK src/lib/autonomous-project/templates/profile.json
- Create: AK src/lib/autonomous-project/templates/policy.json
- Test: AK tests/kit/autonomous-project-schema.test.mjs

**Interfaces:**

- validateProjectManifest(value), validateProjectProfile(value), validateProjectPolicy(value)
- initialManifest(projectIdentity, templateVersion)
- initialProfile()
- initialPolicy()

- [ ] **Step 1: Write a manifest containment test**

~~~js
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProjectManifest } from '../../src/lib/autonomous-project/schema.mjs';

test('rejects a managed file outside the project profile root', () => {
  const manifest = {
    schema: 'ak.project-autonomous-manifest/v1',
    templateVersion: 1,
    projectId: 'sha256:' + 'a'.repeat(64),
    managedFiles: ['../outside.json'],
    state: 'generated',
  };
  assert.throws(() => validateProjectManifest(manifest), /managedFiles/);
});
~~~

- [ ] **Step 2: Run the focused test**

Run: node --test tests/kit/autonomous-project-schema.test.mjs

Expected: failure because schema exports are absent.

- [ ] **Step 3: Implement closed schemas**

Validate all fields in the design examples. Require exact schema versions, project IDs, relative contained paths, unique managed files, disabled initial runtime, empty mutation paths, off schedule and provider mode, and local-only publication. Reject unknown keys, absolute paths, parent traversal, NUL, wildcard paths, URLs containing credentials, non-finite limits and enabled state without a complete profile.

- [ ] **Step 4: Generate stable project identity**

Derive identity from canonical project root plus normalized Git remote when available. Record the digest, not the raw private path. A missing remote is a supported local identity mode and must produce a stable digest across repeat setup.

- [ ] **Step 5: Verify schemas**

Run: node --test tests/kit/autonomous-project-schema.test.mjs

Expected: valid initial documents pass; malformed, unknown-field and containment cases fail.

## Task P03: Template registry and ownership-aware rendering

**Files:**

- Create: AK src/lib/autonomous-project/template-registry.mjs
- Create: AK src/lib/autonomous-project/render.mjs
- Create: AK src/lib/autonomous-project/templates/README.md
- Create: AK src/lib/autonomous-project/templates/development.example.json
- Create: AK src/lib/autonomous-project/templates/project.example.json
- Create: AK src/lib/autonomous-project/templates/verify.yml
- Create: AK src/lib/autonomous-project/templates/graduate.yml
- Test: AK tests/kit/autonomous-project-templates.test.mjs

**Interfaces:**

- autonomousTemplateEntries() returns immutable template metadata.
- renderAutonomousTemplates(context) returns path, bytes, digest and ownership slug for each generated file.
- templatePlan(root, existing, context) returns create, update, preserve or conflict actions.

- [ ] **Step 1: Write a modified-workflow preservation test**

~~~js
import test from 'node:test';
import assert from 'node:assert/strict';
import { templatePlan } from '../../src/lib/autonomous-project/render.mjs';

test('preserves a workflow whose owned bytes have changed', () => {
  const plan = templatePlan('/project', {
    '.github/workflows/agentic-kit-autonomous-verify.yml': 'user change',
  }, { projectId: 'sha256:' + '1'.repeat(64) });
  assert.equal(plan.find((entry) => entry.path.endsWith('verify.yml')).action, 'conflict');
});
~~~

- [ ] **Step 2: Run the focused test**

Run: node --test tests/kit/autonomous-project-templates.test.mjs

Expected: failure because template rendering is absent.

- [ ] **Step 3: Render all owned templates**

Use sentinel headers containing ownership slug, schema, template version and manifest digest. The verification workflow has pull request and merge group triggers, contents read permission and no secrets. The graduation workflow has workflow dispatch only, contents read permission and a disabled publisher job. Do not generate write-capable GitHub permissions in initial templates.

- [ ] **Step 4: Implement conflict-safe planning**

An absent file creates. A file exactly matching the previous owned digest updates. A modified or malformed sentinel is preserved with a conflict action. A path not in the manifest is never touched. All file writes go through the existing backup-capable writer.

- [ ] **Step 5: Verify templates**

Run: node --test tests/kit/autonomous-project-templates.test.mjs tests/kit/blocks.test.mjs

Expected: template output is stable, workflow permissions are least privilege, and user edits are preserved.

## Task P04: Project companion lifecycle adapter

**Files:**

- Create: AK src/lib/autonomous-project/lifecycle.mjs
- Create: AK src/lib/adapters/autonomous-project.mjs
- Modify: AK src/lib/adapters/companion-lifecycle-registry.mjs
- Test: AK tests/kit/autonomous-project-lifecycle.test.mjs
- Test: AK tests/kit/autonomous-project-undo.test.mjs

**Interfaces:**

- AUTONOMOUS_PROJECT_LIFECYCLE implements detect, plan, apply, verify and undo.
- projectAutonomousPaths(root) returns exact source-controlled paths and owner-private state descriptor.
- projectAutonomousFacts(root) returns schema, drift, conflict and runtime-probe facts.

- [ ] **Step 1: Write a dry-run non-mutation test**

~~~js
import test from 'node:test';
import assert from 'node:assert/strict';
import { runLifecycle } from '../../src/lib/adapters/lifecycle.mjs';
import { AUTONOMOUS_PROJECT_LIFECYCLE } from '../../src/lib/adapters/autonomous-project.mjs';

test('plans autonomous project setup without writing in dry-run mode', async () => {
  const result = await runLifecycle({ adapter: AUTONOMOUS_PROJECT_LIFECYCLE, action: 'apply', dryRun: true, root: '/fixture' });
  assert.equal(result.dryRun, true);
});
~~~

- [ ] **Step 2: Run the focused test**

Run: node --test tests/kit/autonomous-project-lifecycle.test.mjs

Expected: failure because the adapter is absent.

- [ ] **Step 3: Implement lifecycle operations**

Detect reads only contained regular files. Plan uses P03. Apply writes source-controlled files after all planned targets pass containment and ownership checks. Verify re-renders and compares every owned digest. Undo removes only exact owned bytes and never removes owner-private state, worktrees, evidence or user edits.

- [ ] **Step 4: Integrate lifecycle registration**

Register only the built-in adapter. It is invoked by setup and future autonomous commands; it is not a host adapter, execution adapter or default managed companion.

- [ ] **Step 5: Verify lifecycle and recovery**

Run: node --test tests/kit/autonomous-project-lifecycle.test.mjs tests/kit/autonomous-project-undo.test.mjs tests/kit/lifecycle-registry.test.mjs

Expected: repeat apply is idempotent; modified files survive undo; malformed files fail closed.

## Task P05: Setup trust, projection and status

**Files:**

- Modify: AK src/commands/setup.mjs
- Create: AK src/commands/autonomous.mjs
- Modify: AK bin/agentic-kit.mjs
- Create: AK src/commands/status/sections/autonomous-project.mjs
- Test: AK tests/kit/autonomous-command.test.mjs
- Test: AK tests/kit/status-autonomous-project.test.mjs
- Test: AK tests/kit/setup-command.test.mjs

**Interfaces:**

- autonomous command supports status, validate, plan and configure subcommands.
- setup invokes the lifecycle adapter only when requested.
- status projection is read-only and labels inactive, conflict, unqualified, configured and runnable distinctly.

- [ ] **Step 1: Write a no-flag compatibility test**

~~~js
import test from 'node:test';
import assert from 'node:assert/strict';
import { run_project } from '../../src/commands/setup.mjs';

test('ordinary project setup does not invoke the autonomous lifecycle', async () => {
  const calls = [];
  await run_project({ flags: { 'autonomous-lab': false, 'dry-run': true }, cfg: {}, autonomousLifecycle: { plan: () => calls.push('plan') } });
  assert.deepEqual(calls, []);
});
~~~

- [ ] **Step 2: Run the focused test**

Run: node --test tests/kit/setup-command.test.mjs

Expected: failure until dependency injection and flag handling exist.

- [ ] **Step 3: Integrate explicit projection**

Extend project setup dependency injection for testability. Add lifecycle planning after existing project initialization only when requested. Add a dedicated trust-manifest section naming exact generated files and the owner-private state location. A declined trust confirmation exits before project changes.

- [ ] **Step 4: Add read-only command behavior**

Status reads facts and prints next steps. Validate checks profile, anchor and evaluator schemas without executing evaluator commands. Plan prints no write action until a profile is configured. Configure is a separate explicit interactive or file-driven action and refuses to write an enabled profile without complete project inputs.

- [ ] **Step 5: Verify CLI surface**

Run: node --test tests/kit/autonomous-command.test.mjs tests/kit/status-autonomous-project.test.mjs tests/kit/setup-command.test.mjs tests/kit/dispatch-surface.test.mjs

Expected: setup help describes the flag, ordinary setup is unchanged, and all autonomous commands are read-only except explicit configure/apply operations.

## Task P06: Evaluator, anchor and profile configuration

**Files:**

- Create: AK src/lib/autonomous-project/evaluators.mjs
- Create: AK src/lib/autonomous-project/anchors.mjs
- Create: AK src/lib/autonomous-project/configure.mjs
- Test: AK tests/kit/autonomous-project-evaluators.test.mjs
- Test: AK tests/kit/autonomous-project-anchors.test.mjs
- Test: AK tests/kit/autonomous-project-configure.test.mjs

**Interfaces:**

- detectEvaluatorCandidates(root) returns observations only.
- validateEvaluator(value, root) returns a normalized literal argv evaluator.
- validateProjectAnchor(manifest, tasks, root) returns a hash-pinned anchor.
- configureProjectProfile(input, root) writes only through P04 ownership plan.

- [ ] **Step 1: Write an argv-only evaluator test**

~~~js
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEvaluator } from '../../src/lib/autonomous-project/evaluators.mjs';

test('rejects a generic evaluator that contains a shell operator', () => {
  assert.throws(() => validateEvaluator({ kind: 'generic-command', argv: ['sh', '-c', 'npm test && curl x'] }, '/project'), /argv/);
});
~~~

- [ ] **Step 2: Run the focused test**

Run: node --test tests/kit/autonomous-project-evaluators.test.mjs

Expected: failure because evaluator validation is absent.

- [ ] **Step 3: Implement supported evaluators**

Support node package, Rust workspace, generic literal argv and local HTTP fixture modes. Validate relative working directory, executable allowlist, bounded output, timeout and expected exit codes. Detection proposes a candidate from package or CI metadata but never makes it active.

- [ ] **Step 4: Implement anchor validation**

Require the project-local manifest and anchor file, at least four labelled tasks, canonical bytes and matching SHA-256. Reject symlink escapes, duplicate task IDs and content mismatch. Acceptance corpus references are owner-private and unavailable to candidate writers.

- [ ] **Step 5: Verify configure behavior**

Run: node --test tests/kit/autonomous-project-evaluators.test.mjs tests/kit/autonomous-project-anchors.test.mjs tests/kit/autonomous-project-configure.test.mjs

Expected: incomplete profile remains disabled; a validated evaluator and anchor can produce configured state but cannot enable a runtime or schedule.
