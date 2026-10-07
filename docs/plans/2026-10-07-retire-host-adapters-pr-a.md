# Retire the external host-adapter contract, PR A: close the door and detach routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

## Status

**Active** (2026-10-07). Plan for pull request A of three for card P0-04, issue
[#324](https://github.com/pacphi/agentic-kit/issues/324). Nothing is merged. Plans for pull requests B and
C are written when each starts, because their edit sites depend on what A leaves behind.

**Goal:** Remove `ak host adapters`, `ak x aqe-provider` and the `AK_EXPERIMENTAL_HOST_ADAPTERS`
bootstrap, detach routing, hosts and `ak run` from the admitted-host overlay, fix the unknown-host error
message, and delete the three guides, without changing how Claude Code, Codex and OpenCode behave.

**Architecture:** The external-adapter code stays compiled but unreachable. Callers use the built-in
registry directly. Each removed command takes its tests and docs with it in the same pull request. Tests of
the now-dead modules stay until pull request C deletes the modules.

**Tech Stack:** Node 22+ ES modules (`.mjs`), `node:test`, ESLint 10, markdownlint, lychee. Zero runtime
dependencies.

**Spec:** [2026-10-07-retire-host-adapters-design.md](2026-10-07-retire-host-adapters-design.md)

**How this plan was checked.** Every edit below comes from one machine-readable edit script. I replayed
that script in a fresh worktree from `main`, task by task, and ran each task's focused tests. The replayed
tree is byte-identical to the tree I first built and validated by hand (38 files, +116 / -6,600 lines).
The numbers in each "Expected" line are from those runs.

## Global Constraints

- One pull request, branch `refactor/324-pr-a-close-the-door`, cut from `main`. The pull request leaves
  `main` green. Individual commits may not be: after Task 1 alone, 18 tests fail until Task 2 deletes them
  (listed in Task 2). Run the focused suites each task names, and the full gate in Task 5.
- Claude Code, Codex and OpenCode behave exactly as before. `ak run`, `ak host pick`, `--aqe-provider` for
  built-in providers and the Maintenance discovery of Hermes are unchanged.
- `src/lib/execution/adapters.mjs` **stays**. It is the built-in registry that `ak run` uses.
- Keep the admission, grants, consent, manifest, sources, integrity, hook-runner, `admitted` and
  `aqe-provider` modules and their own tests. Pull request C deletes them.
- Files under `docs/archive/` are frozen. Change only the seven links that point at deleted files, and turn
  them into plain text.
- A saved `hostAdapters` list or an external host id in `kit.json` stays on disk as inert data. Do not add
  code that names it.
- No aliases or hints for the removed commands. The old-to-new mapping goes in the pull request body.
- Comments and `test(...)` titles must not carry transient labels such as "Task 3", "Step 2", "Fix round 2"
  or "Branch 6a". `pnpm run test:quality` enforces this.
- Commit messages are `<type>(<scope>): <description>`. Add no `Co-Authored-By` trailer.
- Run tests with `node scripts/run-tests.mjs focus <file>`, never bare `node --test`. A fresh worktree has
  no `node_modules`: run `pnpm install --frozen-lockfile` once in it. Never run `pnpm` in a worktree that has
  a symlinked `node_modules`.
- Within one file, apply edits in the order shown. A later edit can depend on an earlier one.
- Do not push or open the pull request without the maintainer's go-ahead.

## Review Focus

Inputs the spec implies and no obvious test covers. Each has a test in the task that owns the code:

1. A saved route that names a removed host (`hermes`) must fail at plan time with the new message, before
   any worker starts. Task 1 (`routing.test.mjs`, `run-command.test.mjs`).
2. `AK_EXPERIMENTAL_HOST_ADAPTERS=1` and `=0` must both leave `ak host adapters` an unknown subcommand.
   Task 2 (`cli-json-honesty.test.mjs`).
3. A registered admitted execution adapter and an applied admitted host overlay must no longer change
   routing or `executionAdapterFor`. Task 1 (`adapter-execution.test.mjs`).
4. The three built-in hosts must keep their execution adapters, and an unknown id must still return
   `null`, so the runner degrades with `cli_unavailable`. Task 1 (`execution-runner.test.mjs`, unchanged).
5. No live doc may name a removed command, and every link must resolve, archive included. Task 3 (lychee).

---

### Task 1: Detach routing, hosts and execution from the overlay, and fix the error message

**Files:**

- Modify:
  - `tests/kit/routing.test.mjs`
  - `tests/kit/run-command.test.mjs`
  - `tests/kit/adapter-execution.test.mjs`
  - `src/lib/routing.mjs`
  - `src/lib/hosts.mjs`
  - `src/lib/execution/adapters.mjs`
  - `src/lib/execution/runner.mjs`
  - `tests/kit/admitted-grants.test.mjs`

**Interfaces:**

- Consumes: nothing from an earlier task.
- Produces: `ineligibleHostReason(host, eligibility)` exported from `src/lib/routing.mjs`. It returns
  `unknown host "<id>" (expected: claude|codex|opencode)` when `eligibility.reason` is `'unknown-host'`,
  and `host "<id>" requires canRouteActivities` otherwise.

- [ ] **Step 1: Write the failing tests**

File: `tests/kit/routing.test.mjs`

In `tests/kit/routing.test.mjs`, replace:

```js
  validateRoute, parseRouteSpecs,
  RUN_TEMPLATE_NAMES,
} from '../../src/lib/routing.mjs';
```

with:

```js
  validateRoute, parseRouteSpecs, ineligibleHostReason,
  RUN_TEMPLATE_NAMES,
} from '../../src/lib/routing.mjs';
```

In `tests/kit/routing.test.mjs`, replace:

```js
test('host-neutral run plan rejects a host without activity-routing capability', () => {
  const policy = { implementation: { host: 'zz-not-a-registered-host', provenance: 'user' } };
  assert.throws(
    () => materializeRunPlan(policy, { template: 'feature', task: 'x' }),
    /route for "implementation" cannot materialize: host "zz-not-a-registered-host" requires canRouteActivities/,
  );
});
```

with:

```js
test('host-neutral run plan rejects an unknown host and names the valid hosts', () => {
  const policy = { implementation: { host: 'zz-not-a-registered-host', provenance: 'user' } };
  assert.throws(
    () => materializeRunPlan(policy, { template: 'feature', task: 'x' }),
    /route for "implementation" cannot materialize: unknown host "zz-not-a-registered-host" \(expected: claude\|codex\|opencode\)/,
  );
});

test('ineligibleHostReason separates an unknown host from a host without the routing capability', () => {
  assert.equal(
    ineligibleHostReason('hermes', { ok: false, reason: 'unknown-host' }),
    'unknown host "hermes" (expected: claude|codex|opencode)',
  );
  assert.equal(
    ineligibleHostReason('claude', { ok: false, reason: 'capability-canRouteActivities-required' }),
    'host "claude" requires canRouteActivities',
  );
});
```

File: `tests/kit/run-command.test.mjs`

In `tests/kit/run-command.test.mjs`, replace:

```js
test('materializeRunPlan rejects an escalation rung to a non-routable host', () => {
```

with:

```js
test('materializeRunPlan rejects an escalation rung to an unknown host', () => {
```

In `tests/kit/run-command.test.mjs`, replace:

```js
    /escalation rung for "implementation" cannot materialize: host "not-a-host" requires canRouteActivities/);
```

with:

```js
    /escalation rung for "implementation" cannot materialize: unknown host "not-a-host" \(expected: claude\|codex\|opencode\)/);
```

File: `tests/kit/adapter-execution.test.mjs`

In `tests/kit/adapter-execution.test.mjs`, replace:

```js
test('executionAdapterFor falls through to an admitted execution adapter for a non-built-in host', () => {
  assert.equal(executionAdapterFor('hermes'), null);
  const registered = registerAdmittedExecution(hermesManifest());
  assert.equal(executionAdapterFor('hermes'), registered);
});
```

with:

```js
test('executionAdapterFor ignores an admitted execution adapter for a non-built-in host', () => {
  registerAdmittedExecution(hermesManifest());
  assert.equal(executionAdapterFor('hermes'), null);
});
```

In `tests/kit/adapter-execution.test.mjs`, replace:

```js
test('with the host + execution overlay applied, executionAdapterFor resolves and validateRoute accepts', () => {
  const manifest = hermesManifest({ name: 'acme', host: validHost({ id: 'acme' }) });
  applyAdmitted([{ entry: manifest.host }]);
  registerAdmittedExecution(manifest);

  assert.equal(isRoutableHost('acme'), true);
  assert.deepEqual(validateRoute({ host: 'acme' }), []);
  assert.notEqual(executionAdapterFor('acme'), null);
});
```

with:

```js
test('with the host and execution overlay applied, routing still refuses a non-built-in host', () => {
  const manifest = hermesManifest({ name: 'acme', host: validHost({ id: 'acme' }) });
  applyAdmitted([{ entry: manifest.host }]);
  registerAdmittedExecution(manifest);

  assert.equal(isRoutableHost('acme'), false);
  assert.ok(validateRoute({ host: 'acme' }).length > 0);
  assert.equal(executionAdapterFor('acme'), null);
});
```

- [ ] **Step 2: Run them and confirm they fail**

```bash
node scripts/run-tests.mjs focus tests/kit/routing.test.mjs
node scripts/run-tests.mjs focus tests/kit/run-command.test.mjs
node scripts/run-tests.mjs focus tests/kit/adapter-execution.test.mjs
```

Expected: `routing.test.mjs` fails to load (`ineligibleHostReason` is not exported). `run-command.test.mjs`
reports 1 failure: `materializeRunPlan rejects an escalation rung to an unknown host`.
`adapter-execution.test.mjs` reports 2 failures: `executionAdapterFor ignores an admitted execution adapter
for a non-built-in host` and `with the host and execution overlay applied, routing still refuses a
non-built-in host`.

- [ ] **Step 3: Change the code**

File: `src/lib/routing.mjs`

In `src/lib/routing.mjs`, replace:

```js
  routableHostIds, primaryHostIds, validateActivityHost, effectiveHostRegistry, effectiveRoutableHostIds,
} from './adapters/index.mjs';
```

with:

```js
  routableHostIds, primaryHostIds, validateActivityHost, HOST_REGISTRY,
} from './adapters/index.mjs';
```

In `src/lib/routing.mjs`, replace:

```js
// Frozen at import time — built-ins only. Display strings and built-in
// listings ONLY (formatModelHelp, model catalogs below): every VALIDATION
// path (isRoutableHost, validateRoute, materializeRunPlan) consults the lazy
// effectiveRoutableHostIds()/effectiveHostRegistry() instead, so an admitted
// external host routes without this constant ever needing to change.
export const HOSTS = routableHostIds();
```

with:

```js
// Frozen at import time. Display strings and built-in listings (formatModelHelp,
// model catalogs below); the validation paths (isRoutableHost, validateRoute,
// materializeRunPlan) read the registry directly.
export const HOSTS = routableHostIds();
```

In `src/lib/routing.mjs`, replace:

```js
// Frozen at import time — built-ins only, deliberately (audited for the D2
// keystone wave, ADR-0031 §1). Every current reader of PRIMARY_HOSTS
// (providers.mjs's applySetupHostFlags `--primary-host` validation, and
// x/host.mjs's `ak host pick` primary-host flag + selection menu) is the
// primary-host SELECTION UX, not an eligibility-VALIDATION path — extending
// that picker surface to an admitted external host is explicitly out of
// scope this wave (the deferred pick surface), mirroring how HOSTS above
// stays display-only. hosts.mjs's drivingHost() does NOT use this constant —
// it consults admitted.mjs's effectivePrimaryHostIds() (fresh per call)
// instead, so the eligibility PRIMITIVE is live there. That said, no
// production path drives kit.json's routing.primaryHost to an admitted
// external id today (the picker that writes it stays built-in-only, as
// above), so this is a live primitive with no live privileged caller yet —
// not an active validation gate anything currently depends on.
export const PRIMARY_HOSTS
```

with:

```js
// Frozen at import time. Every reader of PRIMARY_HOSTS (providers.mjs's
// applySetupHostFlags `--primary-host` validation, and x/host.mjs's `ak host
// pick` primary-host flag and selection menu) is the primary-host selection UX.
// hosts.mjs's drivingHost() does not use this constant; it calls
// primaryHostIds() for its eligibility check.
export const PRIMARY_HOSTS
```

In `src/lib/routing.mjs`, replace:

```js
/** True when `host` is routable: a built-in, or an admitted external host
 *  whose manifest declared capabilities.canRouteActivities (P2, ADR-0031).
 *  Lazy — re-reads the effective registry on every call, so it reflects an
 *  overlay applied after this module first loaded. */
export function isRoutableHost(host) {
  return effectiveRoutableHostIds().includes(host);
}
```

with:

```js
/** True when `host` is a built-in host that can route activities. */
export function isRoutableHost(host) {
  return routableHostIds().includes(host);
}
```

In `src/lib/routing.mjs`, replace:

```js
  // Snapshot once per materialization (not per validateActivityHost call): an
  // admitted overlay applied mid-call must not be able to make one worker's
  // eligibility check see a different registry than another's in the same plan.
  const hosts = effectiveHostRegistry();
```

with:

```js
  const hosts = HOST_REGISTRY;
```

In `src/lib/routing.mjs`, replace:

```js
      throw new Error(`route for "${n.activity}" cannot materialize: host "${r.host}" requires canRouteActivities`);
```

with:

```js
      throw new Error(`route for "${n.activity}" cannot materialize: ${ineligibleHostReason(r.host, eligibility)}`);
```

In `src/lib/routing.mjs`, replace:

```js
          throw new Error(`escalation rung for "${n.activity}" cannot materialize: host "${rung.host}" requires canRouteActivities`);
```

with:

```js
          throw new Error(`escalation rung for "${n.activity}" cannot materialize: ${ineligibleHostReason(rung.host, rungEligibility)}`);
```

In `src/lib/routing.mjs`, replace:

```js
(expected: ${effectiveRoutableHostIds().join('|')})`);
```

with:

```js
(expected: ${routableHostIds().join('|')})`);
```

In `src/lib/routing.mjs`, replace:

```js
/**
 * Build a host-neutral execution plan. Each template node becomes a worker whose
 * host + model come from the policy's effective route for that node's activity.
 * Throws on an unknown template.
 */
export function materializeRunPlan(
```

with:

```js
/** Why a host cannot take a route. An unknown id lists the valid hosts; a known
 *  host without the capability names the capability. */
export function ineligibleHostReason(host, eligibility) {
  return eligibility.reason === 'unknown-host'
    ? `unknown host "${host}" (expected: ${routableHostIds().join('|')})`
    : `host "${host}" requires canRouteActivities`;
}

/**
 * Build a host-neutral execution plan. Each template node becomes a worker whose
 * host + model come from the policy's effective route for that node's activity.
 * Throws on an unknown template.
 */
export function materializeRunPlan(
```

File: `src/lib/hosts.mjs`

In `src/lib/hosts.mjs`, replace:

```js
import { HOST_REGISTRY, effectiveHostRegistry, effectivePrimaryHostIds } from './adapters/index.mjs';
```

with:

```js
import { HOST_REGISTRY, primaryHostIds } from './adapters/index.mjs';
```

In `src/lib/hosts.mjs`, replace:

```js
 * Always returns a host id HOST_ADAPTERS/adapterFor can resolve (a built-in,
 * canDriveSession host) — never an id that is merely eligible per
 * effectivePrimaryHostIds() (below) but that this module has no session-
 * driving descriptor for.
```

with:

```js
 * Always returns a host id HOST_ADAPTERS/adapterFor can resolve (a built-in,
 * canDriveSession host).
```

In `src/lib/hosts.mjs`, replace:

```js
  // effectivePrimaryHostIds() reads the EFFECTIVE (built-in + grant-overlaid
  // admitted) set for ELIGIBILITY, not HOST_REGISTRY directly (ADR-0031 §1) —
  // that primitive is live, so a hand-edited kit.json pointing
  // routing.primaryHost at a host that has since earned a canBePrimary grant
  // is recognized as eligible here. (No production path drives kit.json's
  // primaryHost to an admitted external id today — `ak host pick`'s
  // selection menu stays built-in-scoped this wave — so this is a live
  // primitive with no live caller yet, not an active privilege boundary.)
  //
  // Eligibility alone is not enough to RETURN the host, though: HOST_ADAPTERS
  // (built from HOST_REGISTRY, filtered by canDriveSession) is what this
  // module actually knows how to drive a session for — guidanceFile,
  // statusline, envMarkers, auth — and stays built-in-only; no admitted
  // external host has that wiring registered. Without the adapterFor(primary)
  // guard, an eligible-but-unresolvable host would be returned here and a
  // caller doing `adapterFor(drivingHost(...)).guidanceFile` would crash on
  // null. Both checks must agree, so this function's contract (always a
  // HOST_ADAPTERS-resolvable id) holds even once effectivePrimaryHostIds()
  // can name a host HOST_ADAPTERS doesn't.
  const primaryCapable = effectivePrimaryHostIds().includes(primary);
```

with:

```js
  // Eligibility (can this host lead?) and resolvability (does this module have a
  // session-driving descriptor for it: guidanceFile, statusline, envMarkers,
  // auth?) are separate checks. Both must pass, so a host the registry marks
  // primary-capable but HOST_ADAPTERS cannot drive never reaches a caller doing
  // `adapterFor(drivingHost(...)).guidanceFile`.
  const primaryCapable = primaryHostIds().includes(primary);
```

In `src/lib/hosts.mjs`, replace:

```js
 * Accepts a host id (resolved against `registry`, default
 * effectiveHostRegistry() so an admitted external host resolves too) or a raw
 * host-entry object directly (for a synthetic host not registered anywhere).
 * TRUE by construction for any capability combination validateHostAdapter
 * accepts, including a future built-in or admitted external adapter — the
 * label follows the flags, not a name.
```

with:

```js
 * Accepts a host id (resolved against `registry`, default HOST_REGISTRY) or a
 * raw host-entry object directly (for a synthetic host not registered
 * anywhere). TRUE by construction for any capability combination
 * validateHostAdapter accepts — the label follows the flags, not a name.
```

In `src/lib/hosts.mjs`, replace:

```js
export function hostTierLabel(hostIdOrEntry, { registry = effectiveHostRegistry(), builtins = HOST_REGISTRY } = {}) {
```

with:

```js
export function hostTierLabel(hostIdOrEntry, { registry = HOST_REGISTRY, builtins = HOST_REGISTRY } = {}) {
```

In `src/lib/hosts.mjs`, replace:

```js
export function hostAsymmetryNote(hostIdOrEntry, { registry = effectiveHostRegistry() } = {}) {
```

with:

```js
export function hostAsymmetryNote(hostIdOrEntry, { registry = HOST_REGISTRY } = {}) {
```

File: `src/lib/execution/adapters.mjs`

In `src/lib/execution/adapters.mjs`, replace:

```js
import { admittedExecutionAdapterFor } from './admitted.mjs';
```

with nothing (delete it):

In `src/lib/execution/adapters.mjs`, replace:

```js
/** Merge seam (W1-B): resolve one host's execution adapter without exposing
 *  the underlying Map. Built-ins resolve here today; a later wave admits
 *  externally-registered adapters into this same lookup. Returns null for a
 *  host with no adapter wired yet — never throws, so callers can degrade a
 *  single worker instead of failing an entire run. */
export function executionAdapterFor(hostId) {
  if (EXECUTION_ADAPTERS.has(hostId)) return EXECUTION_ADAPTERS.get(hostId);
  // P2 (ADR-0031): an admitted external host whose manifest declared an
  // execution block gets its adapter derived and registered at bootstrap
  // (admission.mjs) into execution/admitted.mjs's overlay. A routable host
  // with no execution block (or nothing admitted at all) still returns null
  // here — the runner's existing cli_unavailable degradation, unchanged.
  return admittedExecutionAdapterFor(hostId);
}
```

with:

```js
/** Resolve one host's execution adapter without exposing the underlying Map.
 *  Returns null for a host with no adapter wired — never throws, so callers can
 *  degrade a single worker (cli_unavailable) instead of failing an entire run. */
export function executionAdapterFor(hostId) {
  return EXECUTION_ADAPTERS.get(hostId) ?? null;
}
```

File: `src/lib/execution/runner.mjs`

In `src/lib/execution/runner.mjs`, replace:

```js
// W1-B: an omitted `adapters` option resolves through the built-in merge
// seam (executionAdapterFor) instead of a raw Map reference, so a future
// externally-admitted adapter joins this same lookup without callers here
// changing. Explicit injection
```

with:

```js
// W1-B: an omitted `adapters` option resolves through the built-in lookup
// (executionAdapterFor) instead of a raw Map reference. Explicit injection
```

- [ ] **Step 4: Delete the tests that pinned the overlay**

These two tests asserted that an admitted host earns a tier label. That behaviour is gone.

File: `tests/kit/admitted-grants.test.mjs`

In `tests/kit/admitted-grants.test.mjs`, replace:

```js
test('a granted canBePrimary lights up hostTierLabel — "drives sessions · can lead"', () => {
  applyAdmitted([{ entry: admittedHost() }], { grantsByName: { hermes: { canBePrimary: true } } });
  assert.equal(hostTierLabel('hermes'), 'drives sessions · can lead');
});

test('without the grant, hostTierLabel reflects the ungranted (routing-only external) tier', () => {
  applyAdmitted([{ entry: admittedHost() }]);
  assert.equal(hostTierLabel('hermes'), 'routing only · external adapter · not AQE');
});
```

with nothing (delete it):

In `tests/kit/admitted-grants.test.mjs`, replace:

```js
import { hostTierLabel } from '../../src/lib/hosts.mjs';
```

with nothing (delete it):

- [ ] **Step 5: Run the focused suites, the typecheck and the lint**

```bash
for f in routing run-command adapter-execution admitted-grants hosts execution-runner routing-primary; do
  node scripts/run-tests.mjs focus tests/kit/$f.test.mjs
done
node_modules/.bin/tsc -p tsconfig.json
node_modules/.bin/eslint --quiet src tests/kit
```

Expected: every suite passes (routing 28, run-command 10, adapter-execution 43, admitted-grants 12, hosts 29,
execution-runner 29, routing-primary 11 tests). `tsc` prints nothing. `eslint --quiet` prints nothing.

- [ ] **Step 6: Commit**

```bash
git add -A src tests
git commit -m "refactor(routing): use the built-in host registry and name an unknown host (P0-04)

routing, hosts and ak run no longer consult the admitted-host overlay. An
unknown host in a route now says so and lists the valid hosts, instead of
saying it lacks canRouteActivities."
```

---

### Task 2: Remove the CLI surface, the bootstrap and the external status sections

**Files:**

- Modify:
  - `tests/kit/cli-json-honesty.test.mjs`
  - `tests/kit/host-dry-run.test.mjs`
  - `src/commands/x/host.mjs`
  - `bin/agentic-kit.mjs`
  - `src/commands/status/sections/index.mjs`
  - `tests/kit/provider-cli.test.mjs`
  - `tests/kit/adapter-aqe-provider.test.mjs`
  - `tests/kit/status-aqe-drift.test.mjs`
- Delete:
  - `src/commands/x/host-adapters.mjs`
  - `src/commands/x/host-adapters-grants.mjs`
  - `src/commands/x/aqe-provider.mjs`
  - `src/lib/adapters/conformance.mjs`
  - `src/commands/status/sections/providers-external-intent.mjs`
  - `src/commands/status/sections/providers-external-projection.mjs`
  - `tests/kit/host-adapters-cli.test.mjs`
  - `tests/kit/adapter-conformance.test.mjs`
  - `tests/kit/conformance-tiers.test.mjs`

**Interfaces:**

- Consumes: Task 1's built-in-only routing. Without it the removed `pick` bootstrap would leave the
  overlay half connected.
- Produces: `ak host adapters` is `unknown host subcommand: adapters (status|pick|reset-routes|off|check-connection|align)`;
  `ak x aqe-provider` is `unknown plumbing command: aqe-provider`; both exit 2.

After Task 1 alone, 18 tests fail. They are the tests of the admitted overlay that this task deletes
(`adapter-conformance`, `conformance-tiers`, `host-adapters-cli`, and one external-provider test in
`provider-cli`). The suite is green again at the end of this task.

- [ ] **Step 1: Write the failing tests**

File: `tests/kit/cli-json-honesty.test.mjs`

In `tests/kit/cli-json-honesty.test.mjs`, replace:

```js
  [['host', 'adapters', '--dry-run', '--json'], /has no preview/],
  [['host', 'adapters', 'unknown', '--json'], /experimental host-adapter surface is disabled/],
```

with:

```js
  [['host', 'adapters', '--json'], /unknown host subcommand: adapters \(status\|pick\|reset-routes\|off\|check-connection\|align\)/],
```

In `tests/kit/cli-json-honesty.test.mjs`, replace:

```js
for (const enabled of ['0', '1']) {
  for (const verb of ['revoke', 'revoke-grant']) {
    test(`ak host adapters ${verb} --json without a name is JSON with feature flag ${enabled}`, () => {
      const child = ak(['host', 'adapters', verb, '--json'], { AK_EXPERIMENTAL_HOST_ADAPTERS: enabled });
      const out = oneJson(child);
      assert.equal(child.status, 2, child.stderr);
      assert.deepEqual(Object.keys(out), ['error', 'exitCode']);
      assert.equal(out.exitCode, 2);
      assert.match(out.error, new RegExp(`usage: ak host adapters ${verb} <name>`));
      assert.match(child.stderr, new RegExp(`usage: ak host adapters ${verb} <name>`));
    });
  }
}
```

with:

```js
for (const enabled of ['0', '1']) {
  test(`ak host adapters is an unknown subcommand even with the old feature flag set to ${enabled}`, () => {
    const child = ak(['host', 'adapters', 'revoke', 'acme', '--json'], { AK_EXPERIMENTAL_HOST_ADAPTERS: enabled });
    const out = oneJson(child);
    assert.equal(child.status, 2, child.stderr);
    assert.deepEqual(Object.keys(out), ['error', 'exitCode']);
    assert.equal(out.exitCode, 2);
    assert.match(out.error, /unknown host subcommand: adapters/);
  });
}

test('ak x aqe-provider is an unknown command', () => {
  const child = ak(['x', 'aqe-provider', 'acme']);
  assert.equal(child.status, 2, child.stderr);
  assert.match(child.stderr, /unknown command: x aqe-provider/);
});
```

In `tests/kit/cli-json-honesty.test.mjs`, replace:

```js
  assert.equal(child.status, 2, child.stderr);
  assert.match(child.stderr, /unknown command: x aqe-provider/);
});
```

with:

```js
  assert.equal(child.status, 2, child.stderr);
  assert.match(child.stdout, /unknown plumbing command: aqe-provider/);
});
```

File: `tests/kit/host-dry-run.test.mjs`

In `tests/kit/host-dry-run.test.mjs`, replace:

```js
test('ak host adapters list --dry-run refuses: adapters has no preview', (t) => {
  const sb = sandbox(t);
  const r = ak(sb, 'host', 'adapters', 'list', '--dry-run');
  assert.equal(r.status, 2, r.all);
  assert.match(r.all, /ak host adapters has no preview; run it without --dry-run/);
});
```

with nothing (delete it):

- [ ] **Step 2: Run them and confirm they fail**

```bash
node scripts/run-tests.mjs focus tests/kit/cli-json-honesty.test.mjs
```

Expected: 4 failures out of 54: `ak host adapters --json reports one command-level JSON usage error`,
`ak host adapters is an unknown subcommand even with the old feature flag set to 0`, the same with `1`, and
`ak x aqe-provider is an unknown command`. `host-dry-run.test.mjs` is a plain deletion and passes.

- [ ] **Step 3: Remove the commands, the bootstrap and the sections**

File: `src/commands/x/host.mjs`

In `src/commands/x/host.mjs`, replace:

```js
import { bootstrapHostAdapters } from '../../lib/adapters/admission.mjs';
```

with nothing (delete it):

In `src/commands/x/host.mjs`, replace:

```js
  routableHostIds, effectiveRoutableHostIds, defaultHostMap, validateBinding, HOST_REGISTRY, PROVIDER_REGISTRY,
```

with:

```js
  routableHostIds, defaultHostMap, validateBinding, HOST_REGISTRY, PROVIDER_REGISTRY,
```

In `src/commands/x/host.mjs`, replace:

```js
  'expect-hash': { type: 'string' }, // adapters trust: required sha256 pin when --yes resolves a non-file source
  timeout: { type: 'string' },       // adapters conformance: outer ms budget override (default: manifest's own execution.run.hook.timeoutMs, else 120000)
  dev: { type: 'boolean', default: false }, // adapters conformance: run without persisting evidence/grants
```

with nothing (delete it):

In `src/commands/x/host.mjs`, replace:

```js
built-in APIs = metered; external billing is adapter-declared and unverified';
```

with:

```js
built-in APIs = metered';
```

In `src/commands/x/host.mjs`, replace:

```js
  adapters record hash-pinned consent for external host-adapter manifests
             (experimental — set AK_EXPERIMENTAL_HOST_ADAPTERS=1; revoke
             always works, list/trust need the flag; --dry-run refused, exit
             2 — its verbs have no preview)
             list        show each configured adapter's trust state (default)
             trust <name> [--expect-hash <sha256>]   grant consent (required
                          with --yes against a non-file source); revoke <name>
             conformance <name> [--timeout <ms>] [--dev]
                          run the tiered black-box harness; --dev is a loud,
                          non-persistent self-test and never produces
                          graduation evidence
```

with nothing (delete it):

In `src/commands/x/host.mjs`, replace:

```js
                                 ollama/onnx = local ($0); external billing is
                                 adapter-declared and shown as unverified
```

with:

```js
                                 ollama/onnx = local ($0)
```

In `src/commands/x/host.mjs`, replace:

```js
  if (sub === 'adapters') {
    // Every adapters verb (list/trust/revoke/conformance/grant/gate/status)
    // mutates or executes something the moment it runs — there is no
    // read-only preview to give --dry-run, so it is refused outright
    // instead of silently behaving like a real run: a flag we declare is a
    // flag we honor, or refuse.
    if (flags['dry-run']) {
      const error = 'ak host adapters has no preview; run it without --dry-run';
      reportFailure({ json: flags.json, payload: { error, exitCode: 2 }, human: () => fail(error) });
      return 2;
    }
    return (await import('./host-adapters.mjs')).run({ flags, positionals: positionals.slice(1) });
  }
```

with nothing (delete it):

In `src/commands/x/host.mjs`, replace:

```js
(status|pick|reset-routes|off|check-connection|adapters|align)`;
```

with:

```js
(status|pick|reset-routes|off|check-connection|align)`;
```

In `src/commands/x/host.mjs`, replace:

```js
 *  intent, refresh host-adapter admission against that final intent,
 *  validate the aqe provider/fallback selections against the (possibly
 *  refreshed) selectable sets, and build the resulting providers/routing
 *  policy.
```

with:

```js
 *  intent, validate the aqe provider/fallback selections against the
 *  selectable sets, and build the resulting providers/routing policy.
```

In `src/commands/x/host.mjs`, replace:

```js
  const { ROUTING, EFFECTIVE_ROUTING, MANAGED_HOSTS } = registries;
```

with:

```js
  const { ROUTING, MANAGED_HOSTS } = registries;
```

In `src/commands/x/host.mjs`, replace:

```js
  const known = new Set([...MANAGED_HOSTS, ...EFFECTIVE_ROUTING]);
```

with:

```js
  const known = new Set([...MANAGED_HOSTS, ...ROUTING]);
```

In `src/commands/x/host.mjs`, replace:

```js
  // External host ids are not primary candidates, but they are first-class
  // integration intent. Retain every live admitted external id as an explicit
  // boolean so a provider-only pick cannot deactivate its own bridge; an
  // explicit --host set can still disable it by omission.
  for (const id of EFFECTIVE_ROUTING) {
    if (!MANAGED_HOSTS.has(id)) hostIntent[id] = enabled.includes(id);
  }
  cfg.integrations.hosts = hostIntent;

  // Admission ran once at process bootstrap against the persisted pre-pick
  // config. Re-run it against the final in-memory host intent before provider
  // validation/projection: an admitted+granted provider can then be enabled
  // and selected atomically, while a provider disabled by this command is
  // removed from the AQE bridge before applyAqeRouter computes its projection.
  let aqeProviderTypes = initialAqeProviderTypes;
  let aqeChainProviderTypes = initialAqeChainProviderTypes;
  if (process.env.AK_EXPERIMENTAL_HOST_ADAPTERS === '1') {
    const refreshed = await bootstrapHostAdapters({ cfg, env: process.env });
    for (const entry of refreshed.warnings) {
      warn(`host adapter '${entry.name}' refresh refused (${entry.reason}): ${entry.detail}`);
    }
    aqeProviderTypes = aqeSelectableProviderTypes();
    aqeChainProviderTypes = aqeSelectableChainProviderTypes();
  }

  ({ aqeProvider, aqeFallback } = validatePickAqeSelections({
    aqeProvider, aqeFallback, aqeProviderTypes, aqeChainProviderTypes,
  }));
```

with:

```js
  cfg.integrations.hosts = hostIntent;

  ({ aqeProvider, aqeFallback } = validatePickAqeSelections({
    aqeProvider, aqeFallback,
    aqeProviderTypes: initialAqeProviderTypes, aqeChainProviderTypes: initialAqeChainProviderTypes,
  }));
```

In `src/commands/x/host.mjs`, replace:

```js
  // Keep primary-host selection on the built-in routing set, but admit an
  // explicitly named external host when the live adapter overlay proves it is
  // routable. Provider-only retunes also carry already-enabled external ids
  // through unchanged instead of mistaking them for unknown host tokens.
  const registries = {
    ROUTING: new Set(routableHostIds()),
    EFFECTIVE_ROUTING: new Set(effectiveRoutableHostIds()),
```

with:

```js
  const registries = {
    ROUTING: new Set(routableHostIds()),
```

File: `bin/agentic-kit.mjs`

In `bin/agentic-kit.mjs`, replace:

```js
  'aqe-provider': () => import('../src/commands/x/aqe-provider.mjs'),
```

with nothing (delete it):

In `bin/agentic-kit.mjs`, replace:

```js
  // Experimental host-adapter bootstrap (Wave 4, adapter door) — the single
  // place every command passes through. Gated on the env var BEFORE anything
  // else runs so the default (flag unset) is truly zero calls, zero output,
  // zero behavior change: no dynamic import, no config read, nothing.
  // Refusals are warnings on stderr, never fatal — a bad external adapter
  // must never block a command that doesn't use it.
  if (cmd !== 'telemetry' && process.env.AK_EXPERIMENTAL_HOST_ADAPTERS === '1') {
    try {
      const { loadKitConfig } = await import('../src/lib/config.mjs');
      const { bootstrapHostAdapters } = await import('../src/lib/adapters/admission.mjs');
      const { warnings } = await bootstrapHostAdapters({ cfg: loadKitConfig(), env: process.env });
      for (const w of warnings) {
        console.error(dim(`⚠ host adapter '${w.name}' not admitted (${w.reason}): ${w.detail ?? ''}`.trimEnd()));
      }
    } catch { /* experimental surface — never blocks a command */ }
  }
```

with nothing (delete it):

In `bin/agentic-kit.mjs`, replace:

```js
'heal', 'maintain', 'ruflo-mcp', 'aqe-provider', 'aqe-embedding',
```

with:

```js
'heal', 'maintain', 'ruflo-mcp', 'aqe-embedding',
```

- Delete `src/commands/x/host-adapters.mjs`:

```bash
git rm src/commands/x/host-adapters.mjs
```

- Delete `src/commands/x/host-adapters-grants.mjs`:

```bash
git rm src/commands/x/host-adapters-grants.mjs
```

- Delete `src/commands/x/aqe-provider.mjs`:

```bash
git rm src/commands/x/aqe-provider.mjs
```

- Delete `src/lib/adapters/conformance.mjs`:

```bash
git rm src/lib/adapters/conformance.mjs
```

File: `src/commands/status/sections/index.mjs`

In `src/commands/status/sections/index.mjs`, replace:

```js
import providersExternalIntent from './providers-external-intent.mjs';
import providersExternalProjection from './providers-external-projection.mjs';
```

with nothing (delete it):

In `src/commands/status/sections/index.mjs`, replace:

```js
hosts, providersStatus, providersExternalIntent, providersExternalProjection,
```

with:

```js
hosts, providersStatus,
```

- Delete `src/commands/status/sections/providers-external-intent.mjs`:

```bash
git rm src/commands/status/sections/providers-external-intent.mjs
```

- Delete `src/commands/status/sections/providers-external-projection.mjs`:

```bash
git rm src/commands/status/sections/providers-external-projection.mjs
```

- [ ] **Step 4: Delete the tests of the removed commands**

Delete the three whole test files, then trim the tests that exercised the removed commands inside shared
files. Remove any import or helper that becomes unused.

- Delete `tests/kit/host-adapters-cli.test.mjs`:

```bash
git rm tests/kit/host-adapters-cli.test.mjs
```

- Delete `tests/kit/adapter-conformance.test.mjs`:

```bash
git rm tests/kit/adapter-conformance.test.mjs
```

- Delete `tests/kit/conformance-tiers.test.mjs`:

```bash
git rm tests/kit/conformance-tiers.test.mjs
```

File: `tests/kit/provider-cli.test.mjs`

In `tests/kit/provider-cli.test.mjs`, delete everything from the line that starts with `test('external provider selection accepts the effective host and provider-only retunes preserve its enablement'` up to, but **not including**, the line that starts with `test('host off clears the OpenCode catalog override`.

In `tests/kit/provider-cli.test.mjs`, delete everything from the line that starts with `function configureExternalAqeProvider(` up to, but **not including**, the line that starts with `test('pick --host claude,opencode enables + wires opencode`.

In `tests/kit/provider-cli.test.mjs`, replace:

```js
import { validateAdapterManifest } from '../../src/lib/adapters/manifest.mjs';
import { hashAdapterContent } from '../../src/lib/adapters/integrity.mjs';
import { recordConsent } from '../../src/lib/adapters/consent.mjs';
import { grantCapability, recordTierResult } from '../../src/lib/adapters/grants.mjs';
```

with nothing (delete it):

File: `tests/kit/adapter-aqe-provider.test.mjs`

In `tests/kit/adapter-aqe-provider.test.mjs`, delete the whole test that starts with `test('hidden CLI transport never emits failure or drift diagnostics on stdout'`, through its closing `});`.

In `tests/kit/adapter-aqe-provider.test.mjs`, replace:

```js
import { spawnSync } from 'node:child_process';
```

with nothing (delete it):

In `tests/kit/adapter-aqe-provider.test.mjs`, replace:

```js
import { sandboxConfigBase, spawnEnv } from './helpers/home-sandbox.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
```

with:

```js
import { sandboxConfigBase } from './helpers/home-sandbox.mjs';
```

In `tests/kit/adapter-aqe-provider.test.mjs`, replace:

```js
import { fileURLToPath } from 'node:url';
```

with nothing (delete it):

File: `tests/kit/status-aqe-drift.test.mjs`

In `tests/kit/status-aqe-drift.test.mjs`, delete the whole test that starts with `test('unavailable external intent names a manual remedy instead of an impossible sync loop'`, through its closing `});`.

- [ ] **Step 5: Run the focused suites, the typecheck and the lint**

```bash
for f in cli-json-honesty host-dry-run provider-cli adapter-aqe-provider status-aqe-drift status-command \
         dispatch-surface cli-help host-cli-migration host-management; do
  node scripts/run-tests.mjs focus tests/kit/$f.test.mjs
done
node_modules/.bin/tsc -p tsconfig.json
node_modules/.bin/eslint --quiet src bin tests/kit
```

Expected: every suite passes (cli-json-honesty 54, host-dry-run 20, provider-cli 20, adapter-aqe-provider 11,
status-aqe-drift 7, status-command 60, dispatch-surface 35, cli-help 12, host-cli-migration 15,
host-management 4 tests). `tsc` and `eslint --quiet` print nothing.

- [ ] **Step 6: Commit**

```bash
git add -A src bin tests
git commit -m "refactor(host)!: remove ak host adapters, ak x aqe-provider and the adapter bootstrap (P0-04)

Delete the adapters subcommand, the aqe-provider plumbing command, the
AK_EXPERIMENTAL_HOST_ADAPTERS bootstrap in bin and in pick, the conformance
harness only they reached, the two external status sections, and the tests of
all of them.

BREAKING CHANGE: ak host adapters and ak x aqe-provider fail as unknown commands."
```

---

### Task 3: Delete the guides and align the docs

**Files:**

- Modify:
  - `docs/README.md`
  - `docs/host-support.md`
  - `docs/providers.md`
  - `README.md`
  - `docs/archive/2026-08-16-artifact-host-extensibility-explainer.html`
  - `docs/archive/2026-09-04-design-maintenance-overhaul-experience-specification.md`
  - `docs/archive/2026-09-09-audit-211-adrs-matrix.md`
  - `docs/archive/README.md`
- Delete:
  - `docs/authoring-host-adapters.md`
  - `docs/hermes-host-adapter.md`
  - `docs/host-adapter-freeze-checklist.md`

**Interfaces:**

- Consumes: Task 2's removed commands. The docs must describe the world after Task 2.
- Produces: no live doc names a removed command, flag or guide.

- [ ] **Step 1: Delete the three guides**

- Delete `docs/authoring-host-adapters.md`:

```bash
git rm docs/authoring-host-adapters.md
```

- Delete `docs/hermes-host-adapter.md`:

```bash
git rm docs/hermes-host-adapter.md
```

- Delete `docs/host-adapter-freeze-checklist.md`:

```bash
git rm docs/host-adapter-freeze-checklist.md
```

- [ ] **Step 2: Edit the live docs**

Order matters inside `docs/host-support.md` and `docs/providers.md`: delete the two sections first, then the
sentences.

File: `docs/README.md`

In `docs/README.md`, replace:

```markdown
| [Hermes host adapter](hermes-host-adapter.md) | External host-adapter contract |
```

with nothing (delete it):

In `docs/README.md`, replace:

```markdown
| [Authoring host adapters](authoring-host-adapters.md) | Adding an agent CLI |
```

with nothing (delete it):

In `docs/README.md`, replace:

```markdown
| [Host-adapter freeze checklist](host-adapter-freeze-checklist.md) | Evidence for adapter contract freeze |
```

with nothing (delete it):

File: `docs/host-support.md`

In `docs/host-support.md`, delete everything from the line that starts with `Behind an experimental flag, agentic-kit can also admit **external host adapters**` up to, but **not including**, the line that starts with `Evidence cutoff: **2026-08-26**`.

In `docs/host-support.md`, delete everything from the line that starts with `## External host adapters` up to, but **not including**, the line that starts with `## Known contract discrepancies`.

In `docs/host-support.md`, replace:

```markdown
| No built-in id; an admitted external adapter may earn its own id |
```

with:

```markdown
| No built-in id |
```

In `docs/host-support.md`, replace:

```markdown
therefore does not infer an AQE provider from the built-in OpenCode host/model route.
An independently admitted adapter may declare a separate candidate under its own
`host.id`, pass the `aqe-provider` tier, and receive an `aqeProvider` grant; that is
earned provider support, not inference from the OpenCode name.
```

with:

```markdown
therefore does not infer an AQE provider from the built-in OpenCode host/model route.
```

In `docs/host-support.md`, replace:

```markdown
provider identity, and has no native Brain plugin or managed status line. A separately admitted
adapter may earn its own external provider id; that does not change the built-in descriptor. Operational risks
include
```

with:

```markdown
provider identity, and has no native Brain plugin or managed status line. Operational risks
include
```

In `docs/host-support.md`, replace:

```markdown
   provider identity. It does not mean AQE lacks OpenCode platform agents, skills,
   or MCP support, or that a separately admitted adapter cannot earn an external id.
```

with:

```markdown
   provider identity. It does not mean AQE lacks OpenCode platform agents, skills,
   or MCP support.
```

In `docs/host-support.md`, replace:

```markdown
[ADR-0021](https://github.com/pacphi/agentic-kit/blob/main/docs/adr/0021-inference-provider-provenance.md). For the external-adapter
section above, [ADR-0029](https://github.com/pacphi/agentic-kit/blob/main/docs/adr/0029-host-adapter-extension-point.md) is the
extension point and [ADR-0031](https://github.com/pacphi/agentic-kit/blob/main/docs/adr/0031-capability-graduation-and-upstream-requests.md)
amends it with capability graduation — replacing ADR-0029's permanent
capability caps with the earn-then-grant model, except for the permanent ban on
self-declaring them.
```

with:

```markdown
[ADR-0021](https://github.com/pacphi/agentic-kit/blob/main/docs/adr/0021-inference-provider-provenance.md).
```

In `docs/host-support.md`, replace:

```markdown
OpenCode, and Ollama have registry-selected explicit source adapters; an external host receives no
  inferred catalogue capability without an admitted descriptor and matching adapter.
```

with:

```markdown
OpenCode, and Ollama have registry-selected explicit source adapters.
```

File: `docs/providers.md`

In `docs/providers.md`, delete everything from the line that starts with `## External host adapters (experimental)` up to, but **not including**, the line that starts with `## Level 0 — do nothing (the point)`.

In `docs/providers.md`, delete everything from the line that starts with `### External-provider release proof` up to, but **not including**, the line that starts with `## Level 3.5 — seeded Claude + Codex defaults`.

In `docs/providers.md`, replace:

```markdown
activity-routing host through `ak run`, while remaining ineligible as a primary host or AQE
provider unless an independently admitted adapter for that host declares and earns the separate
AQE-provider capability. A configured selector alone never establishes provider, billing, or
vendor-diversity facts.
```

with:

```markdown
activity-routing host through `ak run`, while remaining ineligible as a primary host or AQE
provider. A configured selector alone never establishes provider, billing, or
vendor-diversity facts.
```

In `docs/providers.md`, replace:

```markdown
For built-ins, `ak` writes `AQE_LLM_PROVIDER` for you. An admitted external id is selectable by
the same flag, but its default is written only to the project `.agentic-qe/llm-config.json` — never
to user or project host-settings environment. This prevents a project-scoped adapter identity from
leaking into unrelated repositories. Add `OPENAI_API_KEY`
```

with:

```markdown
`ak` writes `AQE_LLM_PROVIDER` for you. Add `OPENAI_API_KEY`
```

In `docs/providers.md`, replace:

```markdown
Agentic-QE **3.13.12 or newer** is required for an external id. The same admitted id may be the
default, a fallback rung, or the provider projected from an explicit external-host activity route.
Agentic-kit merges `externalProviders` without replacing foreign declarations and also writes the
minimal compatibility activation AQE 3.13.12's MCP bootstrap requires:
`providers[id] = { "enabled": true }`. Both values have exact ownership receipts. Fallback-derived
defaults carry a separate exact receipt, so removing a managed chain preserves any user-selected
replacement even when that provider was another rung in the old chain. A same-id foreign
or user-edited declaration is preserved and reported as a conflict; an explicit foreign
`enabled:false` is refused rather than overridden. When a grant is revoked, a host is disabled, or
declared content changes, sync removes only a stale declaration/activation that still exactly
matches its receipt. A user-edited value is preserved and becomes user-owned.
```

with:

```markdown
Fallback-derived defaults carry an exact ownership receipt, so removing a managed chain preserves
any user-selected replacement even when that provider was another rung in the old chain.
```

In `docs/providers.md`, replace:

```markdown
| Select an admitted external AQE provider | `--aqe-provider hermes`        | project `llm-config.json` `externalProviders` + `defaultProvider` |
```

with nothing (delete it):

In `docs/providers.md`, replace:

```markdown
its fallback chain and curated overrides under `_managedBy`, and each external declaration under
an exact-value ownership receipt. A same-id foreign or edited external declaration is preserved and
reported as a conflict rather than overwritten or pruned. Keys always stay in the environment;
```

with:

```markdown
its fallback chain and curated overrides under `_managedBy`. Keys always stay in the environment;
```

In `docs/providers.md`, replace:

```markdown
- External host adapters (experimental): [ADR-0029](https://github.com/pacphi/agentic-kit/blob/main/docs/adr/0029-host-adapter-extension-point.md),
  amended by [ADR-0031](https://github.com/pacphi/agentic-kit/blob/main/docs/adr/0031-capability-graduation-and-upstream-requests.md) — capability
  graduation. Authoring guide: [authoring-host-adapters.md](https://github.com/pacphi/agentic-kit/blob/main/docs/authoring-host-adapters.md).
```

with nothing (delete it):

File: `README.md`

In `README.md`, replace:

```markdown
identity. A separate external adapter may earn its own AQE 3.13.12+ identity. Provider, model,
and billing claims
```

with:

```markdown
identity. Provider, model,
and billing claims
```

- [ ] **Step 3: Turn seven archive links into plain text**

The archive is frozen. Change only these links, which would otherwise point at deleted files.

File: `docs/archive/2026-08-16-artifact-host-extensibility-explainer.html`

In `docs/archive/2026-08-16-artifact-host-extensibility-explainer.html`, replace:

```html
<a href="../authoring-host-adapters.md">the authoring guide</a>
```

with:

```html
the authoring guide
```

In `docs/archive/2026-08-16-artifact-host-extensibility-explainer.html`, replace:

```html
<a href="../authoring-host-adapters.md"><code>docs/authoring-host-adapters.md</code></a>
```

with:

```html
<code>docs/authoring-host-adapters.md</code>
```

File: `docs/archive/2026-09-04-design-maintenance-overhaul-experience-specification.md`

In `docs/archive/2026-09-04-design-maintenance-overhaul-experience-specification.md`, replace:

```markdown
[Hermes external adapter guide](../hermes-host-adapter.md)
```

with:

```markdown
Hermes external adapter guide
```

File: `docs/archive/2026-09-09-audit-211-adrs-matrix.md`

In `docs/archive/2026-09-09-audit-211-adrs-matrix.md`, replace:

```markdown
[conformance.mjs](../../src/lib/adapters/conformance.mjs)
```

with:

```markdown
`conformance.mjs`
```

In `docs/archive/2026-09-09-audit-211-adrs-matrix.md`, replace:

```markdown
[conformance-tiers.test.mjs](../../tests/kit/conformance-tiers.test.mjs)
```

with:

```markdown
`conformance-tiers.test.mjs`
```

File: `docs/archive/README.md`

In `docs/archive/README.md`, replace **all 2 occurrences** of:

```markdown
[Current adapter authoring](../authoring-host-adapters.md)
```

with:

```markdown
Current adapter authoring (removed in 4.0.0-beta.1)
```

- [ ] **Step 4: Run the documentation checks**

```bash
node_modules/.bin/markdownlint README.md CLAUDE.md AGENTS.md "docker/*.md" "claude/**/*.md" "src/templates/**/*.md" \
  "docs/**/*.md" ".claude/skills/ak-*/SKILL.md" --ignore node_modules
lychee --offline --include-fragments --config lychee.toml README.md CLAUDE.md AGENTS.md 'docker/*.md' \
  'claude/**/*.md' 'src/templates/**/*.md' 'docs/**/*.md' 'docs/**/*.html'
node scripts/run-tests.mjs focus tests/kit/docs-layout.test.mjs
```

Expected: markdownlint prints nothing. lychee ends with `🚫 0 Errors`. `docs-layout` passes 7 tests.

- [ ] **Step 5: Commit**

```bash
git add -A README.md docs
git commit -m "docs: remove the host-adapter guides and sections with the commands (P0-04)

Delete the three guides, the adapter sections of host-support and providers,
the README rows, and turn seven archive links to the deleted files into plain
text."
```

---

### Task 4: Fix the upstream-watch registry

**Files:**

- Modify:
  - `src/lib/hook-audit/agentic-dependency-constraints.json`
  - `tests/kit/upstream-watch-registry.test.mjs`

**Interfaces:**

- Consumes: Tasks 2 and 3, which delete the files these entries name.
- Produces: a registry whose `kitImpact.files` name only files that exist. A `mapped` entry needs at least
  one ref or file, so `ruflo#2912` gets a ref sentence.

- [ ] **Step 1: Confirm the registry tests fail**

```bash
node scripts/run-tests.mjs focus tests/kit/upstream-watch-registry.test.mjs
```

Expected: 2 failures out of 27: `every kit file a watch entry names exists and still cites the thread` and
`every watched-repository thread cited in tracked source or user-facing docs is registered`.

- [ ] **Step 2: Fix the entries and the synthetic list**

File: `src/lib/hook-audit/agentic-dependency-constraints.json`

In `src/lib/hook-audit/agentic-dependency-constraints.json`, replace:

```json
"files": ["docs/troubleshooting.md", "src/lib/adapters/grants.mjs", "tests/kit/adapter-grants.test.mjs", "tests/kit/host-adapters-cli.test.mjs"]
```

with:

```json
"files": ["docs/troubleshooting.md", "src/lib/adapters/grants.mjs", "tests/kit/adapter-grants.test.mjs"]
```

In `src/lib/hook-audit/agentic-dependency-constraints.json`, replace:

```json
"files": ["docs/host-adapter-freeze-checklist.md", "docs/adr/0029-host-adapter-extension-point.md", "src/lib/adapters/admission.mjs"
```

with:

```json
"files": ["docs/adr/0029-host-adapter-extension-point.md", "src/lib/adapters/admission.mjs"
```

In `src/lib/hook-audit/agentic-dependency-constraints.json`, replace:

```json
"kitImpact": { "refs": [], "files": ["tests/kit/adapter-conformance.test.mjs"] },
```

with:

```json
"kitImpact": { "refs": [], "files": [] },
```

In `src/lib/hook-audit/agentic-dependency-constraints.json`, replace:

```json
"files": ["docs/providers.md", "src/commands/setup.mjs", "src/lib/adapters/grants.mjs", "tests/kit/adapter-grants.test.mjs", "tests/kit/host-adapters-cli.test.mjs"]
```

with:

```json
"files": ["docs/providers.md", "src/commands/setup.mjs", "src/lib/adapters/grants.mjs", "tests/kit/adapter-grants.test.mjs"]
```

In `src/lib/hook-audit/agentic-dependency-constraints.json`, replace:

```json
"files": ["docs/host-adapter-freeze-checklist.md", "docs/adr/0031-capability-graduation-and-upstream-requests.md"]
```

with:

```json
"files": ["docs/adr/0031-capability-graduation-and-upstream-requests.md"]
```

In `src/lib/hook-audit/agentic-dependency-constraints.json`, replace:

```json
"kitImpact": { "refs": [], "files": [] },
```

with:

```json
"kitImpact": { "refs": ["cited only by a test removed with the external host-adapter contract (P0-04)"], "files": [] },
```

File: `tests/kit/upstream-watch-registry.test.mjs`

In `tests/kit/upstream-watch-registry.test.mjs`, replace:

```js
const SYNTHETIC = new Map([
  ['ruvnet/ruflo#9001', ['tests/kit/conformance-tiers.test.mjs']],
  // A placeholder id in an example command, not a real thread.
  ['ruvnet/ruflo#1234', ['docs/authoring-host-adapters.md']],
]);
```

with:

```js
const SYNTHETIC = new Map();
```

- [ ] **Step 3: Run the registry and hook-audit suites**

```bash
for f in upstream-watch-registry hook-audit-hosts hook-read-model; do
  node scripts/run-tests.mjs focus tests/kit/$f.test.mjs
done
```

Expected: upstream-watch-registry 27, hook-audit-hosts 23, hook-read-model 8 tests pass.

- [ ] **Step 4: Commit**

```bash
git add -A src tests
git commit -m "fix(upstream-watch): drop registry entries that named the deleted adapter files (P0-04)"
```

---

### Task 5: Run the full gate and hand off

**Files:** none.

- [ ] **Step 1: Run every check**

```bash
node_modules/.bin/tsc -p tsconfig.json
node_modules/.bin/eslint .
node_modules/.bin/eslint src bin --rule 'complexity: [2, 50]'
node scripts/run-tests.mjs focus tests/quality/comment-label-guard.test.mjs
node scripts/build-check.mjs
node_modules/.bin/markdownlint README.md CLAUDE.md AGENTS.md "docker/*.md" "claude/**/*.md" "src/templates/**/*.md" \
  "docs/**/*.md" ".claude/skills/ak-*/SKILL.md" --ignore node_modules
lychee --offline --include-fragments --config lychee.toml README.md CLAUDE.md AGENTS.md 'docker/*.md' \
  'claude/**/*.md' 'src/templates/**/*.md' 'docs/**/*.md' 'docs/**/*.html'
node scripts/run-tests.mjs unit
```

Expected: `tsc` prints nothing. `eslint .` exits 0 with 0 errors (395 warnings). The complexity run exits 0.
The comment guard passes 12 tests. `build-check: OK`. markdownlint prints nothing. lychee reports 0 errors.
The unit run reports **6,456 tests, 0 failures, 8 skipped**, and exits 0.

- [ ] **Step 2: Check the change set**

```bash
git diff --stat main...HEAD | tail -1
git status --short | wc -l
```

Expected: `38 files changed, 116 insertions(+), 6600 deletions(-)` and `0`.

- [ ] **Step 3: Ask for the go-ahead, then push and open the pull request**

Do not push without the maintainer's yes. When it comes, use this body. It says "Part of", not "Closes",
because #324 closes when pull request C merges.

```markdown
## Summary

Part 1 of 3 for #324 (P0-04, epic #295). Closes the door on the external host-adapter contract and detaches
the built-in code from it. Claude Code, Codex and OpenCode behave as before.

## Removed (old to new)

| Old | New |
| --- | --- |
| `ak host adapters …` | `unknown host subcommand: adapters` |
| `ak x aqe-provider …` | `unknown plumbing command: aqe-provider` |
| `AK_EXPERIMENTAL_HOST_ADAPTERS=1` | no effect |
| a route naming an external host, for example `hermes` | exit 2 at plan time: `unknown host "hermes" (expected: claude\|codex\|opencode)` |

## What changed

- `routing`, `hosts` and `ak run` use the built-in host registry. `execution/adapters.mjs` stays, minus its
  fall-through to admitted adapters.
- The unknown-host error names the real reason. Before, it said the host lacked `canRouteActivities`.
- Deleted the three host-adapter guides and the adapter sections of `host-support.md` and `providers.md`.
  Seven archive links to the deleted guides became plain text.
- Deleted the two external status sections and the tests of every removed command.
- Fixed five upstream-watch registry entries that named deleted files.

## Not in this PR

The admission, grants, consent, manifest, sources, integrity, hook-runner, `admitted` and `aqe-provider`
modules and their tests stay until PR C. PR B removes their three consumers: AQE external-provider code,
the external hook-audit host, and the external lifecycle entries.

## Verification

- `node scripts/run-tests.mjs unit`: 6,456 tests, 0 failures, 8 skipped.
- `tsc`, `eslint` (0 errors), the complexity ceiling, the comment guard, `build-check`, markdownlint and
  lychee (0 errors) pass.
- Not run: `test:ui` (no dashboard change) and a Windows run.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```
