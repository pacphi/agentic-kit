# Managed Ruflo Components Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** agentic-kit turns on, verifies, and explains a catalogue of opt-in ruflo components
(typesafe and MiniLM agent pickers, MCP governance, learning profile, turn-credit, the #2887
memory fix, funnel off) and shows each one's state with its meaning in setup, status, sync and
the dashboard.

**Architecture:** A pure catalogue (`src/lib/ruflo-components/`) describes each component. A
resolver computes the environment a project needs; a multi-key owned-environment engine,
generalized from ADR-0055's AQE projection, writes it into Claude settings with receipts, while
the Codex launcher and OpenCode generated files read it at launch. Evidence probes (ruflo
`doctor`, a routing probe, learning stats, funnel status, the MCP audit log) are cached and
classified into one state per component. Status, sync, setup, uninstall and a dashboard panel
all read the same snapshot.

**Tech Stack:** Node.js ≥ 22 ES modules, `node:test`, zero runtime dependencies, existing
`run()` subprocess helper (`src/lib/exec.mjs`), existing dashboard classic-script bundle
(`src/lib/dashboard/client.mjs`).

**Spec:** [ADR-0058](../../adr/0058-managed-ruflo-components.md)

## Global Constraints

- Zero runtime dependencies; plain ESM; files under ~500 lines; `pnpm run lint:cc` complexity ≤ 50.
- Minimum ruflo per component, verbatim from ADR-0058: typesafePicker 3.43.0, minilmPicker
  3.44.0, mcpGovernance 3.42.0, learningProfile 3.42.1, turnCredit 3.36.0, memoryFix2887 3.36.0.
- Managed values: typesafe on, MiniLM on, governance on with `maxToolCallsPerTurn` 120 per
  `turnWindowMs` 60000 and `auditLog` true, learning profile `balanced`, turn-credit on, memory
  fix on, funnel off.
- Allowed learning profiles: `real-time`, `balanced`, `research`, `edge`, `batch`.
- Environment keys: `CLAUDE_FLOW_ROUTER_TYPESAFE=1`, `CLAUDE_FLOW_ROUTER_EMBEDDER=minilm`,
  `RUFLO_MCP_ENFORCE_POLICY=1`, `RUFLO_INTELLIGENCE_MODE=<profile>`.
- `RUFLO_MCP_ENFORCE_POLICY` is projected only for a project whose `.harness/mcp-policy.json`
  exists and parses. Never at user scope.
- A value ak did not write is never adopted or overwritten (ADR-0016 §4), except the legacy
  memory pin that equals ak's own computed value (Task 4).
- Every state is rendered with its meaning; never a bare label.
- The dashboard stays read-only.
- Tests never touch the real home directory: use temporary directories and inject every path.
- Commits: the user's global rules forbid committing without explicit authority. Each task's
  "Commit" step runs only if the user has authorized commits for this execution; otherwise stage
  nothing and continue. Never push, open PRs, or file upstream issues without explicit approval.
- Writers work in an isolated git worktree (repo `CLAUDE.md`).

## Review Focus

1. **A project with ruflo but no `.harness/` directory at all, after governance is enabled
   elsewhere** — a reasonable person expects that project to keep working; ruflo must never see
   `RUFLO_MCP_ENFORCE_POLICY=1` there. Pinned by the "no policy file → no variable" tests in
   Tasks 2, 4 and 5.
2. **A user who already has `CLAUDE_FLOW_ROUTER_TYPESAFE` or `RUFLO_INTELLIGENCE_MODE` in
   `~/.claude/settings.json`** — expected: ak reports `user-managed`, leaves the value, and sync
   does not loop trying to fix it. Pinned in Task 3 (engine conflict) and Task 7 (classifier).
3. **ruflo older than 3.44.0** (MiniLM) or than 3.43.0 (typesafe) — expected: `needs ruflo ≥ X`,
   no environment variable written, no package installed. Pinned in Task 6.
4. **`ruflo doctor` output in a new format, or the command timing out** — expected: `unknown`
   with the reason, never `active`, and status still completes. Pinned in Task 6 (parser
   fixtures including garbage and timeout).
5. **Existing machines with the unreceipted `CLAUDE_FLOW_DB_PATH` pin** — expected: after
   upgrade, `ak uninstall` removes the pin and the project keeps its memory in the meantime.
   Pinned in Task 4 (legacy adoption test).

---

## File structure

| File | Responsibility |
|---|---|
| `src/lib/ruflo-components/catalogue.mjs` | Component descriptors: ids, minimum versions, managed values, explain text, options |
| `src/lib/ruflo-components/states.mjs` | State vocabulary with meaning and action; `classify()` |
| `src/lib/ruflo-components/config.mjs` | `rufloComponents` defaults and validation |
| `src/lib/ruflo-components/env.mjs` | `componentEnv(projectRoot, cfg)` and `machineComponentEnv(cfg)` |
| `src/lib/ruflo-components/policy.mjs` | Governance policy file: render, validate, receipted write, removal |
| `src/lib/ruflo-components/evidence.mjs` | Probes and text parsers; evidence cache |
| `src/lib/ruflo-components/apply.mjs` | Package install, funnel, projection reconcile; `reconcileRufloComponents` |
| `src/lib/ruflo-components/snapshot.mjs` | `componentSnapshot()` combining config, version, projection, evidence |
| `src/lib/owned-env-projection.mjs` | Multi-key receipt engine generalized from ADR-0055 |
| `src/lib/claude-env-projection.mjs` | Claude user/project settings `env` targets on the engine (components + memory pin) |
| `src/commands/status/sections/ruflo-components.mjs` | Status rows |
| `src/lib/dashboard/client/ruflo-components.mjs` | Dashboard panel renderer |
| Modified: `aqe-embedding-projection.mjs`, `ruflo-memory.mjs`, `opencode-core.mjs`, `src/templates/opencode-ruflo-gateway.js`, `src/templates/opencode-ruflo-hooks.js`, `mcp.mjs`, `config.mjs`, `setup.mjs`, `sync.mjs`, `uninstall.mjs`, `trust-manifest.mjs`, `status/sections/index.mjs`, `dashboard-server.mjs`, `dashboard/client.mjs`, `dashboard/page.mjs`, `dashboard/client/about.mjs`, `dashboard/client/boot.mjs`, docs | integration |

---

### Task 0: Spike — which environment reaches ruflo in each host

Investigation only. Output is a written finding plus an ADR-0058 update. No product code.

**Files:**

- Modify: `docs/adr/0058-managed-ruflo-components.md` (§3 and the Implementation status table)
- Create (throwaway, delete after): `$SCRATCH/env-echo-mcp.mjs`

- [ ] **Step 1: Build an MCP server that records its environment**

```js
// $SCRATCH/env-echo-mcp.mjs — minimal stdio MCP server; writes its env once, then answers initialize.
import fs from 'node:fs';
fs.writeFileSync(process.env.ENV_ECHO_OUT ?? '/tmp/env-echo.json', JSON.stringify(process.env, null, 2));
process.stdin.on('data', (buf) => {
  for (const line of String(buf).split('\n').filter(Boolean)) {
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
        protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'env-echo', version: '0' } } }) + '\n');
    } else if (msg.id !== undefined) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } }) + '\n');
    }
  }
});
```

- [ ] **Step 2: Test Claude Code**

In a throwaway git repository, write `.claude/settings.local.json` with
`{"env":{"AK_SPIKE_SETTINGS":"yes","ENV_ECHO_OUT":"<scratch>/claude-env.json"}}`, then run
`claude mcp add env-echo -s local -- node <scratch>/env-echo-mcp.mjs` and
`claude -p "say ok" --max-turns 1`.
Expected evidence: `<scratch>/claude-env.json` exists. Record whether it contains
`AK_SPIKE_SETTINGS=yes`. Remove the registration with `claude mcp remove env-echo -s local`.

- [ ] **Step 3: Test Claude hooks**

Add a `UserPromptSubmit` hook in the same `.claude/settings.local.json` running
`node -e "require('fs').writeFileSync('<scratch>/hook-env.json', JSON.stringify(process.env))"`,
rerun `claude -p "say ok" --max-turns 1`, and record whether `AK_SPIKE_SETTINGS` is present.

- [ ] **Step 4: Test Codex hooks**

Run `codex --help` and read `~/.codex/config.toml` documentation for any hook or
`shell_environment_policy` setting that injects environment into hook commands. Run one Codex
session in a throwaway repo with the ruflo Codex hooks installed (`ruflo init --codex` output)
and a `CLAUDE_FLOW_ROUTER_EMBEDDER=minilm` export only in the ak launcher environment. Record
whether hook processes see it (add a temporary hook that writes `process.env` to a file).

- [ ] **Step 5: Record the decision in ADR-0058 §3**

Write exactly one of these for Claude MCP, with the date the spike ran:

- **Inherits:** "Verified <spike date>: Claude Code passes the settings `env` block to stdio MCP
  servers; the ruflo MCP registration is unchanged."
- **Does not inherit:** "Verified <spike date>: Claude Code does not pass the settings `env`
  block to stdio MCP servers. The user-scoped `claude-flow` registration now launches
  `ak x ruflo-mcp`, the same workspace-aware launcher Codex uses."

and one for Codex hooks: "reachable via <mechanism>" or "not reachable; Codex hooks report
`partial`". Update the ADR's Implementation status row "Spike: environment reach" to Done.

Task 4 Step 6 and Task 5 branch on this record.

- [ ] **Step 6: Delete the scratch server and throwaway repository**

---

### Task 1: Catalogue, states and `kit.json` configuration

**Files:**

- Create: `src/lib/ruflo-components/catalogue.mjs`
- Create: `src/lib/ruflo-components/states.mjs`
- Create: `src/lib/ruflo-components/config.mjs`
- Modify: `src/lib/config.mjs` (DEFAULTS, `withDefaults`, `assertLoadableEnvelopes`, `saveKitConfig`)
- Test: `tests/kit/ruflo-components-catalogue.test.mjs`

**Interfaces:**

- Produces:
  - `COMPONENTS: readonly Component[]` where `Component = { id, label, minRuflo: string|null,
    scope: 'machine'|'project'|'none', explain: { does, benefit, cost, change }, options?: Array<{value, detail}> }`
  - `componentById(id): Component | undefined`
  - `STATES: Record<StateId, { label, meaning, action }>`, `StateId` one of `active`,
    `applied-unverified`, `needs-ruflo`, `not-applied`, `drifted`, `user-managed`, `partial`,
    `blocked`, `unknown`
  - `describeState(stateId, { minRuflo, hosts, reason }) → { id, label, meaning, action }`
  - `RUFLO_COMPONENT_DEFAULTS` and `validateRufloComponents(value)` (throws `TypeError`)
  - `managedIntent(cfg, id) → false | true | string | { maxCallsPerMinute: number }`

- [ ] **Step 1: Write the failing tests**

```js
// tests/kit/ruflo-components-catalogue.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPONENTS, componentById } from '../../src/lib/ruflo-components/catalogue.mjs';
import { STATES, describeState } from '../../src/lib/ruflo-components/states.mjs';
import { RUFLO_COMPONENT_DEFAULTS, validateRufloComponents, managedIntent }
  from '../../src/lib/ruflo-components/config.mjs';

test('catalogue lists the eight ADR-0058 components with minimum versions', () => {
  assert.deepEqual(COMPONENTS.map((c) => [c.id, c.minRuflo]), [
    ['typesafePicker', '3.43.0'], ['minilmPicker', '3.44.0'], ['mcpGovernance', '3.42.0'],
    ['learningProfile', '3.42.1'], ['turnCredit', '3.36.0'], ['memoryFix2887', '3.36.0'],
    ['funnel', null], ['encryptionAtRest', null],
  ]);
});

test('every component explains itself in plain language', () => {
  for (const c of COMPONENTS) {
    for (const key of ['does', 'benefit', 'cost', 'change']) {
      assert.ok(c.explain[key]?.length > 10, `${c.id}.explain.${key}`);
    }
  }
});

test('learning profile lists all five profiles with their budgets', () => {
  assert.deepEqual(componentById('learningProfile').options.map((o) => o.value),
    ['real-time', 'balanced', 'research', 'edge', 'batch']);
  assert.match(componentById('learningProfile').options[1].detail, /18 ms.*50 MB/);
});

test('every state carries a meaning and an action', () => {
  assert.deepEqual(Object.keys(STATES), ['active', 'applied-unverified', 'needs-ruflo',
    'not-applied', 'drifted', 'user-managed', 'partial', 'blocked', 'unknown']);
  for (const [id, s] of Object.entries(STATES)) {
    assert.ok(s.meaning.length > 10 && typeof s.action === 'string', id);
  }
});

test('describeState fills version, hosts and reason into the meaning', () => {
  assert.match(describeState('needs-ruflo', { minRuflo: '3.44.0' }).label, /needs ruflo ≥ 3\.44\.0/);
  assert.match(describeState('partial', { hosts: ['codex hooks'] }).meaning, /codex hooks/);
  assert.match(describeState('blocked', { reason: 'npm offline' }).meaning, /npm offline/);
});

test('defaults match ADR-0058 managed values', () => {
  assert.deepEqual(RUFLO_COMPONENT_DEFAULTS, {
    typesafePicker: true, minilmPicker: true, mcpGovernance: { maxCallsPerMinute: 120 },
    learningProfile: 'balanced', turnCredit: true, memoryFix2887: true, funnel: false,
  });
});

test('validation rejects unknown profiles, bad budgets and unknown keys', () => {
  assert.throws(() => validateRufloComponents({ learningProfile: 'turbo' }), /learningProfile/);
  assert.throws(() => validateRufloComponents({ mcpGovernance: { maxCallsPerMinute: 0 } }), /maxCallsPerMinute/);
  assert.throws(() => validateRufloComponents({ typesafePicker: 'yes' }), /typesafePicker/);
  assert.throws(() => validateRufloComponents({ bogus: true }), /bogus/);
  assert.doesNotThrow(() => validateRufloComponents({ mcpGovernance: false, funnel: true }));
  assert.doesNotThrow(() => validateRufloComponents(undefined));
});

test('managedIntent: false opts out; funnel true means leave funnel alone', () => {
  const cfg = { rufloComponents: { ...RUFLO_COMPONENT_DEFAULTS, minilmPicker: false, funnel: true } };
  assert.equal(managedIntent(cfg, 'minilmPicker'), false);
  assert.equal(managedIntent(cfg, 'funnel'), false);
  assert.equal(managedIntent(cfg, 'learningProfile'), 'balanced');
  assert.deepEqual(managedIntent(cfg, 'mcpGovernance'), { maxCallsPerMinute: 120 });
  assert.equal(managedIntent({}, 'typesafePicker'), true);
});
```

`funnel` is the one inverted key: the managed value is "off", so `funnel: false` means
"ak keeps the funnel off" and `funnel: true` means "ak leaves the funnel alone".

- [ ] **Step 2: Run to confirm it fails**

Run: `node --test tests/kit/ruflo-components-catalogue.test.mjs`
Expected: FAIL — `Cannot find module .../ruflo-components/catalogue.mjs`.

- [ ] **Step 3: Implement the catalogue**

```js
// src/lib/ruflo-components/catalogue.mjs
// ADR-0058: the one list of ruflo components ak manages. Every surface reads this.
const c = (id, label, minRuflo, scope, explain, extra = {}) =>
  Object.freeze({ id, label, minRuflo, scope, explain: Object.freeze(explain), ...extra });

export const COMPONENTS = Object.freeze([
  c('typesafePicker', 'Typesafe agent picker', '3.43.0', 'machine', {
    does: 'Chooses which agent handles a task by comparing what the task means with what each agent is for, using @ruvector/typesafe.',
    benefit: 'Fewer misroutes from spelling matches such as "latest" going to the tester; it abstains when unsure and falls back.',
    cost: 'One global npm package; a few milliseconds per prompt. Ruflo has not yet made it the default.',
    change: 'Set rufloComponents.typesafePicker to false in kit.json, then run ak sync.',
  }),
  c('minilmPicker', 'MiniLM agent picker', '3.44.0', 'machine', {
    does: 'Lets ruflo\'s semantic picker use the MiniLM language model it already ships for memory search.',
    benefit: 'Routes by meaning instead of word fragments.',
    cost: 'About 5 ms per prompt and a one-time 0.3 s model load. Ruflo has not yet made it the default.',
    change: 'Set rufloComponents.minilmPicker to false in kit.json, then run ak sync.',
  }),
  c('mcpGovernance', 'MCP tool governance', '3.42.0', 'project', {
    does: 'Makes ruflo\'s MCP server audit every tool call and cap calls per rolling minute, using .harness/mcp-policy.json.',
    benefit: 'An audit trail of which ruflo tools ran, and a stop for runaway loops.',
    cost: 'A small file in each ruflo repository; calls beyond the cap are refused until the minute rolls over.',
    change: 'Set rufloComponents.mcpGovernance to false, or change maxCallsPerMinute, then run ak sync.',
  }),
  c('learningProfile', 'Learning profile', '3.42.1', 'machine', {
    does: 'Sets the SONA learning profile every ruflo session uses by default (RUFLO_INTELLIGENCE_MODE).',
    benefit: 'One explicit, visible setting instead of an implicit default.',
    cost: 'Higher profiles use more time and memory per learning step; the engine must be loaded for any profile to matter.',
    change: 'Set rufloComponents.learningProfile to real-time, balanced, research, edge or batch, then run ak sync.',
  }, { options: Object.freeze([
    { value: 'real-time', detail: '0.5 ms per step, 25 MB, LoRA rank 2' },
    { value: 'balanced', detail: '18 ms per step, 50 MB, LoRA rank 4 (ruflo default)' },
    { value: 'research', detail: '100 ms per step, 100 MB, LoRA rank 16 (most capacity)' },
    { value: 'edge', detail: '1 ms per step, 5 MB, LoRA rank 1' },
    { value: 'batch', detail: '50 ms per step, 75 MB, LoRA rank 8' },
  ]) }),
  c('turnCredit', 'MetaHarness turn-credit', '3.36.0', 'none', {
    does: 'Ruflo bundles @metaharness/turn-credit; ak confirms it is present and loadable.',
    benefit: 'Turn-level credit assignment for MetaHarness scoring works without extra setup.',
    cost: 'None; ruflo installs it.',
    change: 'Set rufloComponents.turnCredit to false to stop reporting it.',
  }),
  c('memoryFix2887', 'Memory durability fix (#2887)', '3.36.0', 'none', {
    does: 'Confirms @claude-flow/memory is at least 3.0.0-alpha.22, which stops hierarchical memory writes from reporting success when nothing was saved.',
    benefit: 'Memory writes that claim success are really stored.',
    cost: 'None; ak only checks the version ruflo resolves.',
    change: 'Set rufloComponents.memoryFix2887 to false to stop reporting it.',
  }),
  c('funnel', 'Ruflo funnel (promotions)', null, 'machine', {
    does: 'Turns off ruflo\'s Cognitum tips, enrollment prompts and statusline promotions (ruflo funnel disable).',
    benefit: 'No promotional content in your statusline or CLI output.',
    cost: 'You will not see ruflo\'s educational tips.',
    change: 'Set rufloComponents.funnel to true to let ruflo decide, then run ak sync; ak re-enables only what it disabled.',
  }),
  c('encryptionAtRest', 'Encryption at rest', null, 'project', {
    does: 'Keeps ruflo\'s project data encrypted on disk (ADR-0059).',
    benefit: 'Memory and learning data are not readable by other local processes, backups or accidental commits.',
    cost: 'Defined by ADR-0059.',
    change: 'Defined by ADR-0059.',
  }),
]);

export const componentById = (id) => COMPONENTS.find((entry) => entry.id === id);
```

- [ ] **Step 4: Implement the states**

```js
// src/lib/ruflo-components/states.mjs
export const STATES = Object.freeze({
  active: { label: 'active', meaning: 'Applied and confirmed by ruflo\'s own evidence.', action: '' },
  'applied-unverified': { label: 'applied, not verified',
    meaning: 'Set, but not yet confirmed — usually the hosts have not restarted since the change.',
    action: 'Restart Claude Code, Codex and OpenCode.' },
  'needs-ruflo': { label: 'needs ruflo', meaning: 'The installed ruflo is too old for this component.',
    action: 'Run ak sync to upgrade ruflo.' },
  'not-applied': { label: 'not applied', meaning: 'ak has not applied the managed value yet.', action: 'Run ak sync.' },
  drifted: { label: 'drifted', meaning: 'Something changed a value ak set.',
    action: 'Run ak sync to restore it, or set the component to false in kit.json to keep your value.' },
  'user-managed': { label: 'user-managed',
    meaning: 'You set your own value or opted out; ak reports it and leaves it alone.', action: '' },
  partial: { label: 'partial', meaning: 'Applied for some hosts only.', action: 'See which hosts are missing.' },
  blocked: { label: 'blocked', meaning: 'Applying failed.', action: 'Follow the reason shown, then run ak sync.' },
  unknown: { label: 'unknown', meaning: 'No current evidence, so ak does not claim this component is on.',
    action: 'Run ak status --refresh to collect evidence.' },
});

export function describeState(id, { minRuflo, hosts, reason } = {}) {
  const base = STATES[id];
  if (!base) throw new TypeError(`unknown ruflo component state ${id}`);
  let { label, meaning, action } = base;
  if (id === 'needs-ruflo' && minRuflo) label = `needs ruflo ≥ ${minRuflo}`;
  if (id === 'partial' && hosts?.length) meaning = `Applied for some hosts only; missing: ${hosts.join(', ')}.`;
  if ((id === 'blocked' || id === 'unknown' || id === 'drifted') && reason) meaning = `${meaning} ${reason}`;
  return { id, label, meaning, action };
}
```

- [ ] **Step 5: Implement configuration defaults and validation**

```js
// src/lib/ruflo-components/config.mjs
export const LEARNING_PROFILES = Object.freeze(['real-time', 'balanced', 'research', 'edge', 'batch']);
export const RUFLO_COMPONENT_DEFAULTS = Object.freeze({
  typesafePicker: true, minilmPicker: true, mcpGovernance: Object.freeze({ maxCallsPerMinute: 120 }),
  learningProfile: 'balanced', turnCredit: true, memoryFix2887: true, funnel: false,
});
const BOOLEAN_KEYS = ['typesafePicker', 'minilmPicker', 'turnCredit', 'memoryFix2887', 'funnel'];
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function validateRufloComponents(value) {
  if (value === undefined) return;
  if (!plain(value)) throw new TypeError('rufloComponents must be an object');
  for (const key of Object.keys(value)) {
    if (!(key in RUFLO_COMPONENT_DEFAULTS)) throw new TypeError(`rufloComponents.${key} is not a known component`);
  }
  for (const key of BOOLEAN_KEYS) {
    if (key in value && typeof value[key] !== 'boolean') throw new TypeError(`rufloComponents.${key} must be true or false`);
  }
  if ('learningProfile' in value && value.learningProfile !== false && !LEARNING_PROFILES.includes(value.learningProfile)) {
    throw new TypeError(`rufloComponents.learningProfile must be false or one of ${LEARNING_PROFILES.join(', ')}`);
  }
  const gov = value.mcpGovernance;
  if (gov !== undefined && gov !== false) {
    if (!plain(gov) || !Number.isInteger(gov.maxCallsPerMinute) || gov.maxCallsPerMinute < 1 || gov.maxCallsPerMinute > 10_000) {
      throw new TypeError('rufloComponents.mcpGovernance must be false or { maxCallsPerMinute: 1..10000 }');
    }
  }
}

/** The managed intent for one component; false means "ak does not manage it". */
export function managedIntent(cfg, id) {
  const merged = { ...RUFLO_COMPONENT_DEFAULTS, ...(cfg?.rufloComponents ?? {}) };
  if (id === 'funnel') return merged.funnel === false ? 'off' : false;
  return merged[id] ?? false;
}
```

Adjust the funnel assertion in Step 1 accordingly: `managedIntent(cfg, 'funnel')` with
`funnel: true` returns `false`; with the default returns `'off'`. Replace the test line with:

```js
  assert.equal(managedIntent(cfg, 'funnel'), false);
  assert.equal(managedIntent({}, 'funnel'), 'off');
```

- [ ] **Step 6: Wire into `src/lib/config.mjs`**

Add the import and the default, merge, and validation:

```js
import { RUFLO_COMPONENT_DEFAULTS, validateRufloComponents } from './ruflo-components/config.mjs';
```

In `DEFAULTS`, after `harvest: false,`:

```js
  rufloComponents: structuredClone(RUFLO_COMPONENT_DEFAULTS), // ADR-0058 managed ruflo components
```

In `withDefaults`'s `merged` object, after `statusline: ...`:

```js
    rufloComponents: { ...structuredClone(RUFLO_COMPONENT_DEFAULTS), ...config.rufloComponents },
```

In `assertLoadableEnvelopes`, first line, and in `saveKitConfig` beside the other validators:

```js
  validateRufloComponents(config.rufloComponents);
```

(`saveKitConfig` uses `cfg`: `validateRufloComponents(cfg.rufloComponents);`.)

- [ ] **Step 7: Add a config round-trip test to the same test file**

```js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadKitConfig, saveKitConfig } from '../../src/lib/config.mjs';

test('kit.json keeps partial rufloComponents overrides and fills defaults', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-rc-cfg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'kit.json');
  fs.writeFileSync(file, JSON.stringify({ rufloComponents: { learningProfile: 'research' } }));
  const cfg = loadKitConfig(file);
  assert.equal(cfg.rufloComponents.learningProfile, 'research');
  assert.equal(cfg.rufloComponents.typesafePicker, true);
  cfg.rufloComponents.learningProfile = 'turbo';
  assert.throws(() => saveKitConfig(cfg, file), /learningProfile/);
});
```

- [ ] **Step 8: Run the tests**

Run: `node --test tests/kit/ruflo-components-catalogue.test.mjs tests/kit/config*.test.mjs`
Expected: PASS, and existing config tests unchanged.

- [ ] **Step 9: Commit (only if authorized)**

```bash
git add src/lib/ruflo-components/ src/lib/config.mjs tests/kit/ruflo-components-catalogue.test.mjs
git commit -m "feat(ruflo-components): catalogue, states and kit.json intent (ADR-0058)"
```

---

### Task 2: Environment resolver and governance policy file

**Files:**

- Create: `src/lib/ruflo-components/env.mjs`
- Create: `src/lib/ruflo-components/policy.mjs`
- Test: `tests/kit/ruflo-components-env.test.mjs`

**Interfaces:**

- Consumes: `managedIntent(cfg, id)` (Task 1); `cmpVersions(a, b)` (`src/lib/versions.mjs`).
- Produces:
  - `RC_KEYS = { typesafe: 'CLAUDE_FLOW_ROUTER_TYPESAFE', embedder: 'CLAUDE_FLOW_ROUTER_EMBEDDER', enforce: 'RUFLO_MCP_ENFORCE_POLICY', mode: 'RUFLO_INTELLIGENCE_MODE' }`
  - `machineComponentEnv(cfg, rufloVersion) → Record<string,string>`
  - `componentEnv(projectRoot, cfg, rufloVersion) → Record<string,string>` (machine keys plus enforce when the policy is valid)
  - `supports(rufloVersion, minRuflo) → boolean`
  - `POLICY_RELATIVE = '.harness/mcp-policy.json'`
  - `renderPolicy({ maxCallsPerMinute }) → string`
  - `readPolicy(projectRoot) → { state: 'absent'|'invalid'|'valid', policy?, source? }`
  - `reconcilePolicy(projectRoot, intent, receipts, { dryRun }) → { status, changed, receipt }` where `receipts` is the plain object persisted at `cfg.integrations.ownership.rufloComponents.policies[projectRoot]`

- [ ] **Step 1: Write the failing tests**

```js
// tests/kit/ruflo-components-env.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { componentEnv, machineComponentEnv, supports } from '../../src/lib/ruflo-components/env.mjs';
import { readPolicy, renderPolicy, reconcilePolicy, POLICY_RELATIVE } from '../../src/lib/ruflo-components/policy.mjs';

const cfg = (over = {}) => ({ rufloComponents: { typesafePicker: true, minilmPicker: true,
  mcpGovernance: { maxCallsPerMinute: 120 }, learningProfile: 'balanced', turnCredit: true,
  memoryFix2887: true, funnel: false, ...over } });
const project = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-rc-env-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('machine env on 3.44.0 carries pickers and profile, never enforcement', () => {
  assert.deepEqual(machineComponentEnv(cfg(), '3.44.0'), {
    CLAUDE_FLOW_ROUTER_TYPESAFE: '1', CLAUDE_FLOW_ROUTER_EMBEDDER: 'minilm', RUFLO_INTELLIGENCE_MODE: 'balanced',
  });
});

test('too-old ruflo drops only the components it cannot run', () => {
  assert.deepEqual(machineComponentEnv(cfg(), '3.43.0'), {
    CLAUDE_FLOW_ROUTER_TYPESAFE: '1', RUFLO_INTELLIGENCE_MODE: 'balanced' });
  assert.deepEqual(machineComponentEnv(cfg(), '3.42.0'), {});
  assert.deepEqual(machineComponentEnv(cfg(), null), {});
});

test('opted-out components produce no variables', () => {
  assert.deepEqual(machineComponentEnv(cfg({ typesafePicker: false, learningProfile: false }), '3.44.0'),
    { CLAUDE_FLOW_ROUTER_EMBEDDER: 'minilm' });
});

test('no policy file means no enforcement variable', (t) => {
  const dir = project(t);
  assert.equal('RUFLO_MCP_ENFORCE_POLICY' in componentEnv(dir, cfg(), '3.44.0'), false);
});

test('invalid policy file means no enforcement variable', (t) => {
  const dir = project(t);
  fs.mkdirSync(path.join(dir, '.harness'));
  fs.writeFileSync(path.join(dir, POLICY_RELATIVE), '{ not json');
  assert.equal(readPolicy(dir).state, 'invalid');
  assert.equal('RUFLO_MCP_ENFORCE_POLICY' in componentEnv(dir, cfg(), '3.44.0'), false);
});

test('valid policy file plus managed governance adds enforcement', (t) => {
  const dir = project(t);
  fs.mkdirSync(path.join(dir, '.harness'));
  fs.writeFileSync(path.join(dir, POLICY_RELATIVE), renderPolicy({ maxCallsPerMinute: 120 }));
  assert.equal(componentEnv(dir, cfg(), '3.44.0').RUFLO_MCP_ENFORCE_POLICY, '1');
  assert.equal('RUFLO_MCP_ENFORCE_POLICY' in componentEnv(dir, cfg({ mcpGovernance: false }), '3.44.0'), false);
});

test('rendered policy is exactly what ruflo enforces', () => {
  const policy = JSON.parse(renderPolicy({ maxCallsPerMinute: 120 }));
  assert.deepEqual({ auditLog: policy.auditLog, maxToolCallsPerTurn: policy.maxToolCallsPerTurn, turnWindowMs: policy.turnWindowMs },
    { auditLog: true, maxToolCallsPerTurn: 120, turnWindowMs: 60000 });
});

test('policy reconcile writes, converges, preserves user edits, and removes only its own file', (t) => {
  const dir = project(t);
  const receipts = {};
  const first = reconcilePolicy(dir, { maxCallsPerMinute: 120 }, receipts);
  assert.equal(first.status, 'written');
  assert.equal(reconcilePolicy(dir, { maxCallsPerMinute: 120 }, receipts).changed, false);
  fs.writeFileSync(path.join(dir, POLICY_RELATIVE), JSON.stringify({ auditLog: true, maxToolCallsPerTurn: 5 }));
  const edited = reconcilePolicy(dir, { maxCallsPerMinute: 120 }, receipts);
  assert.equal(edited.status, 'user-managed');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, POLICY_RELATIVE))).maxToolCallsPerTurn, 5);
  assert.equal(reconcilePolicy(dir, false, receipts).status, 'user-managed');
  assert.ok(fs.existsSync(path.join(dir, POLICY_RELATIVE)));
});

test('policy removal deletes an unchanged ak-written file', (t) => {
  const dir = project(t);
  const receipts = {};
  reconcilePolicy(dir, { maxCallsPerMinute: 120 }, receipts);
  assert.equal(reconcilePolicy(dir, false, receipts).status, 'removed');
  assert.equal(fs.existsSync(path.join(dir, POLICY_RELATIVE)), false);
});

test('a pre-existing foreign policy file is never overwritten', (t) => {
  const dir = project(t);
  fs.mkdirSync(path.join(dir, '.harness'));
  fs.writeFileSync(path.join(dir, POLICY_RELATIVE), JSON.stringify({ auditLog: true, maxToolCallsPerTurn: 50, defaultDeny: true }));
  const result = reconcilePolicy(dir, { maxCallsPerMinute: 120 }, {});
  assert.equal(result.status, 'user-managed');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, POLICY_RELATIVE))).defaultDeny, true);
});

test('supports compares prerelease-aware versions', () => {
  assert.equal(supports('3.44.0', '3.44.0'), true);
  assert.equal(supports('3.43.9', '3.44.0'), false);
  assert.equal(supports(null, '3.36.0'), false);
  assert.equal(supports('3.1.0', null), true);
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `node --test tests/kit/ruflo-components-env.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the policy module**

```js
// src/lib/ruflo-components/policy.mjs
// ADR-0058 §5. Ruflo reads <cwd>/.harness/mcp-policy.json and FAILS CLOSED when it is
// missing or invalid under RUFLO_MCP_ENFORCE_POLICY=1 (policy-enforcer.js), so validity is
// the gate for projecting that variable.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writePrivateFileAtomic } from '../file-write.mjs';

export const POLICY_RELATIVE = path.join('.harness', 'mcp-policy.json');
const sha = (text) => createHash('sha256').update(text).digest('hex');
const policyFile = (root) => path.join(root, POLICY_RELATIVE);

export function renderPolicy({ maxCallsPerMinute }) {
  return JSON.stringify({
    _about: 'Managed by agentic-kit (ADR-0058). Ruflo enforces auditLog and maxToolCallsPerTurn per rolling turnWindowMs.',
    auditLog: true, maxToolCallsPerTurn: maxCallsPerMinute, turnWindowMs: 60000,
  }, null, 2) + '\n';
}

export function readPolicy(root) {
  let source;
  try {
    const stat = fs.lstatSync(policyFile(root));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) return { state: 'invalid' };
    source = fs.readFileSync(policyFile(root), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { state: 'absent' };
    return { state: 'invalid' };
  }
  try {
    const policy = JSON.parse(source);
    if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) return { state: 'invalid', source };
    return { state: 'valid', policy, source };
  } catch { return { state: 'invalid', source }; }
}

/** receipts: mutable map keyed by resolved project root → { sha256 } of the file ak wrote. */
export function reconcilePolicy(root, intent, receipts, { dryRun = false } = {}) {
  const key = path.resolve(root);
  const owned = receipts[key];
  const current = readPolicy(root);
  const ownedAndUnchanged = owned && current.source !== undefined && sha(current.source) === owned.sha256;
  if (!intent) {
    if (!owned) return { status: current.state === 'absent' ? 'absent' : 'user-managed', changed: false };
    if (current.state === 'absent') { delete receipts[key]; return { status: 'absent', changed: false }; }
    if (!ownedAndUnchanged) { delete receipts[key]; return { status: 'user-managed', changed: false }; }
    if (!dryRun) { fs.rmSync(policyFile(root)); delete receipts[key]; }
    return { status: 'removed', changed: true };
  }
  const desired = renderPolicy(intent);
  if (current.state !== 'absent' && !owned) return { status: 'user-managed', changed: false };
  if (owned && current.state !== 'absent' && !ownedAndUnchanged) return { status: 'user-managed', changed: false };
  if (current.source === desired) return { status: 'converged', changed: false };
  if (!dryRun) {
    fs.mkdirSync(path.dirname(policyFile(root)), { recursive: true });
    writePrivateFileAtomic(policyFile(root), desired);
    receipts[key] = { sha256: sha(desired) };
  }
  return { status: 'written', changed: true };
}
```

`writePrivateFileAtomic` writes mode 0600. That is acceptable for a policy file ruflo reads as
the same user.

- [ ] **Step 4: Implement the environment resolver**

```js
// src/lib/ruflo-components/env.mjs
import { cmpVersions } from '../versions.mjs';
import { componentById } from './catalogue.mjs';
import { managedIntent } from './config.mjs';
import { readPolicy } from './policy.mjs';

export const RC_KEYS = Object.freeze({
  typesafe: 'CLAUDE_FLOW_ROUTER_TYPESAFE', embedder: 'CLAUDE_FLOW_ROUTER_EMBEDDER',
  enforce: 'RUFLO_MCP_ENFORCE_POLICY', mode: 'RUFLO_INTELLIGENCE_MODE',
});

export function supports(version, minRuflo) {
  if (!minRuflo) return true;
  if (!version) return false;
  return cmpVersions(version, minRuflo) >= 0;
}

const on = (cfg, id, version) => managedIntent(cfg, id) && supports(version, componentById(id).minRuflo);

export function machineComponentEnv(cfg, rufloVersion) {
  const env = {};
  if (on(cfg, 'typesafePicker', rufloVersion)) env[RC_KEYS.typesafe] = '1';
  if (on(cfg, 'minilmPicker', rufloVersion)) env[RC_KEYS.embedder] = 'minilm';
  if (on(cfg, 'learningProfile', rufloVersion)) env[RC_KEYS.mode] = managedIntent(cfg, 'learningProfile');
  return env;
}

export function componentEnv(projectRoot, cfg, rufloVersion) {
  const env = machineComponentEnv(cfg, rufloVersion);
  if (projectRoot && on(cfg, 'mcpGovernance', rufloVersion) && readPolicy(projectRoot).state === 'valid') {
    env[RC_KEYS.enforce] = '1';
  }
  return env;
}
```

- [ ] **Step 5: Run the tests**

Run: `node --test tests/kit/ruflo-components-env.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit (only if authorized)**

```bash
git add src/lib/ruflo-components/env.mjs src/lib/ruflo-components/policy.mjs tests/kit/ruflo-components-env.test.mjs
git commit -m "feat(ruflo-components): per-project env resolver and governance policy file"
```

---

### Task 3: Multi-key owned environment engine (generalized from ADR-0055)

**Files:**

- Create: `src/lib/owned-env-projection.mjs`
- Modify: `src/lib/aqe-embedding-projection.mjs` (delegate `targetPlan`/`applyPlan` to the engine)
- Test: `tests/kit/owned-env-projection.test.mjs`; existing `tests/kit/aqe-embedding-projection.test.mjs` must pass unchanged

**Interfaces:**

- Produces:
  - `planOwnedEnv(target, desired, { receiptSuffix, format, editorFor }) → Plan`
    - `target = { file, boundary, enabled }`
    - `desired: Record<string, { present: boolean, value?: string }>` — one entry per managed key
    - `format: 'multi' | { single: KEY }` — `single` reads and writes ADR-0055's v1 receipt shape for exactly one key
    - `editorFor(source, target) → { missing?: true, get(key) → State, render(nextStates) → string }`
    - `Plan = { file, status: 'unmanaged'|'converged'|'drift'|'absent'|'missing-registration', changed, ...private }`
    - throws `Error` with a user-readable reason on conflict (callers record `status: 'conflict'`)
  - `applyOwnedEnv(plan, { backupTag })`
  - `jsonTopLevelEnvEditor(source) → editor` for files whose `env` object is at the top level (Claude settings)
  - `readRegularConfig(file) → string | null` (moved from AQE, re-exported by it)

- [ ] **Step 1: Write the failing engine tests**

```js
// tests/kit/owned-env-projection.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planOwnedEnv, applyOwnedEnv, jsonTopLevelEnvEditor } from '../../src/lib/owned-env-projection.mjs';

const opts = { receiptSuffix: '.test-receipt.json', format: 'multi', editorFor: (source) => jsonTopLevelEnvEditor(source) };
const want = (map) => Object.fromEntries(Object.entries(map).map(([k, v]) => [k, v === null ? { present: false } : { present: true, value: v }]));
function fixture(t, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-owned-env-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json');
  if (content !== undefined) fs.writeFileSync(file, JSON.stringify(content));
  return { dir, file, target: { file, boundary: dir, enabled: true } };
}
const run = (target, desired) => { const plan = planOwnedEnv(target, desired, opts); if (plan.changed) applyOwnedEnv(plan, { backupTag: 'test' }); return plan; };
const env = (file) => JSON.parse(fs.readFileSync(file, 'utf8')).env;

test('writes several keys with one receipt and converges', (t) => {
  const { file, target } = fixture(t, { env: { KEEP: 'x' }, other: 1 });
  assert.equal(run(target, want({ A: '1', B: 'minilm' })).status, 'drift');
  assert.deepEqual(env(file), { KEEP: 'x', A: '1', B: 'minilm' });
  assert.equal(planOwnedEnv(target, want({ A: '1', B: 'minilm' }), opts).changed, false);
});

test('changing one managed value leaves the others', (t) => {
  const { file, target } = fixture(t, {});
  run(target, want({ A: '1', MODE: 'balanced' }));
  run(target, want({ A: '1', MODE: 'research' }));
  assert.deepEqual(env(file), { A: '1', MODE: 'research' });
});

test('removing all managed keys restores exactly the prior document', (t) => {
  const { file, target } = fixture(t, { env: { KEEP: 'x' } });
  run(target, want({ A: '1' }));
  run(target, want({ A: null }));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { env: { KEEP: 'x' } });
  assert.equal(fs.existsSync(`${file}.test-receipt.json`), false);
});

test('a foreign value for a managed key is preserved and reported', (t) => {
  const { file, target } = fixture(t, { env: { A: 'user' } });
  assert.throws(() => planOwnedEnv(target, want({ A: '1' }), opts), /A.*preserved/);
  assert.equal(env(file).A, 'user');
});

test('a user edit after ak wrote is preserved and reported', (t) => {
  const { file, target } = fixture(t, {});
  run(target, want({ A: '1' }));
  const doc = JSON.parse(fs.readFileSync(file, 'utf8')); doc.env.A = 'mine';
  fs.writeFileSync(file, JSON.stringify(doc));
  assert.throws(() => planOwnedEnv(target, want({ A: null }), opts), /A.*user-edited/);
  assert.equal(env(file).A, 'mine');
});

test('an interrupted write blocks further changes', (t) => {
  const { file, target } = fixture(t, {});
  fs.writeFileSync(`${file}.test-receipt.json`, JSON.stringify({ version: 2, keys: {}, pending: true }));
  assert.throws(() => planOwnedEnv(target, want({ A: '1' }), opts), /interrupted/);
});

test('dry run plans without writing', (t) => {
  const { file, target } = fixture(t, {});
  const before = fs.readFileSync(file, 'utf8');
  assert.equal(planOwnedEnv(target, want({ A: '1' }), opts).changed, true);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('symlinked config is preserved', (t) => {
  const { dir, target } = fixture(t);
  const real = path.join(dir, 'real.json'); fs.writeFileSync(real, '{}');
  fs.symlinkSync(real, target.file);
  assert.throws(() => planOwnedEnv(target, want({ A: '1' }), opts), /non-regular/);
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `node --test tests/kit/owned-env-projection.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the engine**

```js
// src/lib/owned-env-projection.mjs
// ADR-0058 §3: ADR-0055's single-key AQE receipt engine, generalized to a set of keys.
// Same guarantees: regular files only, preimage check, backup copy, atomic replace,
// pending-receipt guard, foreign and user-edited values preserved.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writePrivateFileAtomic } from './file-write.mjs';

const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const validState = (s) => plain(s) && typeof s.present === 'boolean' && (!s.present || typeof s.value === 'string');
const ABSENT = Object.freeze({ present: false });

export function readRegularConfig(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('non-regular configuration preserved');
    if (stat.size > 4 * 1024 * 1024) throw new Error('configuration exceeds inspection bound');
    return fs.readFileSync(file, 'utf8');
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function checkDirectories(file, boundary) {
  let dir = path.dirname(file);
  while (dir === boundary || dir.startsWith(boundary + path.sep)) {
    try {
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('non-regular configuration directory preserved');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (dir === boundary) break;
    dir = path.dirname(dir);
  }
}

/** Normalize either receipt format to { keys: {K: {before, after}} }. */
function parseReceipt(source, format) {
  if (source === null) return null;
  let value;
  try { value = JSON.parse(source); } catch { throw new Error('invalid ownership receipt preserved'); }
  if (value?.pending === true) throw new Error('interrupted projection requires reconciliation; receipt retained');
  if (format.single) {
    if (value.version !== 1 || !validState(value.before) || !validState(value.after)) throw new Error('invalid ownership receipt preserved');
    return { keys: { [format.single]: { before: value.before, after: value.after } } };
  }
  if (value.version !== 2 || !plain(value.keys)) throw new Error('invalid ownership receipt preserved');
  for (const entry of Object.values(value.keys)) {
    if (!validState(entry?.before) || !validState(entry?.after)) throw new Error('invalid ownership receipt preserved');
  }
  return { keys: value.keys };
}

function serializeReceipt(keys, format, pending) {
  if (format.single) {
    const entry = keys[format.single];
    return JSON.stringify({ version: 1, before: entry.before, after: entry.after, pending }) + '\n';
  }
  return JSON.stringify({ version: 2, keys, pending }) + '\n';
}

export function planOwnedEnv(target, desired, { receiptSuffix, format = 'multi', editorFor }) {
  const fmt = format === 'multi' ? {} : format;
  const { file } = target;
  const receiptFile = `${file}${receiptSuffix}`;
  checkDirectories(file, target.boundary);
  const source = readRegularConfig(file);
  const receiptSource = readRegularConfig(receiptFile);
  const receipt = parseReceipt(receiptSource, fmt);
  const wanted = Object.fromEntries(Object.entries(desired).map(([k, v]) => [k, target.enabled ? v : ABSENT]));
  const ownedKeys = new Set(Object.keys(receipt?.keys ?? {}));
  if (!Object.values(wanted).some((s) => s.present) && ownedKeys.size === 0) return { file, status: 'unmanaged', changed: false };
  const editor = editorFor(source, target);
  if (editor.missing) {
    if (ownedKeys.size) throw new Error('owned environment container is missing; receipt retained');
    return { file, status: target.required ? 'missing-registration' : 'absent', changed: false };
  }
  const nextStates = {};
  const nextReceipt = {};
  for (const key of new Set([...Object.keys(wanted), ...ownedKeys])) {
    const current = editor.get(key);
    const owned = receipt?.keys?.[key];
    const want = wanted[key] ?? ABSENT;
    if (owned && !same(current, owned.after)) throw new Error(`${key}: user-edited value preserved`);
    if (!owned && current.present && !(want.present && same(current, want))) throw new Error(`${key}: conflicting unmanaged value preserved`);
    if (!owned && current.present) continue; // equal foreign value: never adopted (ADR-0055)
    const next = want.present ? want : (owned ? owned.before : ABSENT);
    nextStates[key] = next;
    if (want.present) nextReceipt[key] = { before: owned?.before ?? current, after: next };
  }
  const changed = Object.entries(nextStates).some(([key, next]) => !same(editor.get(key), next));
  if (!changed) return { file, status: 'converged', changed: false };
  return { file, boundary: target.boundary, status: 'drift', changed: true, source, receiptSource, receiptFile,
    after: editor.render(nextStates), nextReceipt, format: fmt };
}

function assertCurrent(file, source) {
  if (readRegularConfig(file) !== source) throw new Error('configuration changed after inspection; retry');
}

export function applyOwnedEnv(plan, { backupTag }) {
  const { file, source, after, receiptFile, nextReceipt, format } = plan;
  checkDirectories(file, plan.boundary);
  assertCurrent(file, source);
  assertCurrent(receiptFile, plan.receiptSource);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (source !== null) fs.copyFileSync(file, `${file}.ak-${backupTag}-backup.${randomUUID()}`, fs.constants.COPYFILE_EXCL);
  const hasKeys = Object.keys(nextReceipt).length > 0;
  // Mark the write in flight: the new keys when adding, else the prior keys being released.
  const pendingKeys = hasKeys ? nextReceipt : (plan.receiptSource ? parseReceipt(plan.receiptSource, format).keys : {});
  if (Object.keys(pendingKeys).length) writePrivateFileAtomic(receiptFile, serializeReceipt(pendingKeys, format, true));
  const tmp = `${file}.ak-${backupTag}-tmp.${randomUUID()}`;
  try {
    fs.writeFileSync(tmp, after, { flag: 'wx', mode: source === null ? 0o600 : fs.statSync(file).mode & 0o777 });
    assertCurrent(file, source);
    fs.renameSync(tmp, file);
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  if (hasKeys) writePrivateFileAtomic(receiptFile, serializeReceipt(nextReceipt, format, false));
  else if (fs.existsSync(receiptFile)) fs.unlinkSync(receiptFile);
}

/** Claude settings files: `env` is a top-level object. */
export function jsonTopLevelEnvEditor(source) {
  let doc;
  try { doc = source === null ? {} : JSON.parse(source); } catch { throw new Error('invalid JSON configuration preserved'); }
  if (!plain(doc)) throw new Error('configuration is not an object');
  if (doc.env !== undefined && !plain(doc.env)) throw new Error('environment is not an object');
  return {
    get: (key) => (doc.env && Object.hasOwn(doc.env, key) ? { present: true, value: doc.env[key] } : { present: false }),
    render(nextStates) {
      doc.env ??= {};
      for (const [key, next] of Object.entries(nextStates)) {
        if (next.present) doc.env[key] = next.value; else delete doc.env[key];
      }
      if (Object.keys(doc.env).length === 0) delete doc.env;
      return JSON.stringify(doc, null, 2) + '\n';
    },
  };
}
```

The "prior document restored exactly" test compares parsed JSON, not bytes, because
`render` normalizes indentation. That matches ADR-0055's behaviour.

- [ ] **Step 4: Run the engine tests**

Run: `node --test tests/kit/owned-env-projection.test.mjs`
Expected: PASS.

- [ ] **Step 5: Delegate AQE to the engine**

In `src/lib/aqe-embedding-projection.mjs`:

1. Replace the local `readRegular`, `checkDirectories`, `parseReceipt`, `targetPlan`,
   `assertCurrent` and `applyPlan` with imports:

```js
import { planOwnedEnv, applyOwnedEnv, readRegularConfig as readRegular } from './owned-env-projection.mjs';
```

1. Adapt the existing editors to the engine's `get/render` interface:

```js
function aqeEditor(target) {
  return (source) => {
    const editor = target.kind === 'toml' ? aqeTomlEnvironment(source) : jsonEnvironment(source, target);
    if (editor.missing) return { missing: true };
    return {
      get: (key) => (key === AQE_ENDPOINT_KEY ? editor.current : { present: false }),
      render: (next) => editor.replace(next[AQE_ENDPOINT_KEY] ?? { present: false }),
    };
  };
}
const AQE_OPTS = (target) => ({ receiptSuffix: '.agentic-kit-aqe-embedding.json',
  format: { single: AQE_ENDPOINT_KEY }, editorFor: aqeEditor(target) });
```

1. In `reconcileAqeEmbeddingProjections`, replace the loop body with:

```js
      const plan = planOwnedEnv(target, { [AQE_ENDPOINT_KEY]: desired }, AQE_OPTS(target));
      if (plan.changed && !dryRun) applyOwnedEnv(plan, { backupTag: 'aqe' });
      findings.push({ file: plan.file, status: plan.status, changed: plan.changed });
```

1. Keep `receiptPath` for `targets()`'s "existing receipt" check.

Two error messages differ between the old code and the engine ("user-edited endpoint
preserved" vs "`AQE_EMBEDDER_ENDPOINT: user-edited value preserved`"). If any AQE test asserts
the exact old text, update only the regular expression, e.g. `/user-edited/`. Do not change
assertions about behaviour.

- [ ] **Step 6: Run AQE's suites**

Run: `node --test tests/kit/aqe-embedding-projection.test.mjs tests/kit/opencode-aqe-embedding.test.mjs tests/kit/aqe-embedding-setup.test.mjs tests/kit/owned-env-projection.test.mjs`
Expected: PASS.

- [ ] **Step 7: Commit (only if authorized)**

```bash
git add src/lib/owned-env-projection.mjs src/lib/aqe-embedding-projection.mjs tests/kit/owned-env-projection.test.mjs tests/kit/aqe-embedding-projection.test.mjs
git commit -m "refactor(projection): multi-key owned env engine shared by AQE (ADR-0055, ADR-0058)"
```

---

### Task 4: Claude projection, memory pin receipt, MCP registration

**Files:**

- Create: `src/lib/claude-env-projection.mjs`
- Modify: `src/commands/setup.mjs:539-548` (`pinProjectMemoryDbPath`)
- Modify: `src/lib/mcp.mjs:119-127` (`replaceableRufloRegistration`), `register()`
- Test: `tests/kit/claude-env-projection.test.mjs`

**Interfaces:**

- Consumes: `planOwnedEnv`, `applyOwnedEnv`, `jsonTopLevelEnvEditor` (Task 3); `machineComponentEnv`, `componentEnv`, `RC_KEYS` (Task 2); `paths.claudeSettingsPath()`, `paths.projectSettingsLocal(root)`, `paths.projectMemoryDb(root)`.
- Produces:
  - `reconcileClaudeComponentEnv(cfg, { projectRoot, rufloVersion, userSettingsFile, dryRun }) → { ok, changed, findings: Array<{ file, status, changed, reason? }> }`
  - `reconcileMemoryPin(projectRoot, { enabled, dryRun }) → { ok, changed, status }`
  - `CLAUDE_RC_RECEIPT = '.agentic-kit-ruflo-components.json'`, `MEMORY_PIN_RECEIPT = '.agentic-kit-memory-pin.json'`

- [ ] **Step 1: Write the failing tests**

```js
// tests/kit/claude-env-projection.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reconcileClaudeComponentEnv, reconcileMemoryPin } from '../../src/lib/claude-env-projection.mjs';
import { renderPolicy } from '../../src/lib/ruflo-components/policy.mjs';

const cfg = (over = {}) => ({ rufloComponents: { typesafePicker: true, minilmPicker: true,
  mcpGovernance: { maxCallsPerMinute: 120 }, learningProfile: 'balanced', turnCredit: true,
  memoryFix2887: true, funnel: false, ...over } });
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-claude-rc-home-'));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ak-claude-rc-proj-')));
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(root, '.git'));
  return { root, userSettingsFile: path.join(home, 'settings.json') };
}
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('machine keys go to user settings; enforcement only to the project with a valid policy', (t) => {
  const { root, userSettingsFile } = fixture(t);
  fs.mkdirSync(path.join(root, '.harness'));
  fs.writeFileSync(path.join(root, '.harness', 'mcp-policy.json'), renderPolicy({ maxCallsPerMinute: 120 }));
  const result = reconcileClaudeComponentEnv(cfg(), { projectRoot: root, rufloVersion: '3.44.0', userSettingsFile });
  assert.equal(result.ok, true);
  assert.deepEqual(read(userSettingsFile).env, { CLAUDE_FLOW_ROUTER_TYPESAFE: '1', CLAUDE_FLOW_ROUTER_EMBEDDER: 'minilm', RUFLO_INTELLIGENCE_MODE: 'balanced' });
  assert.deepEqual(read(path.join(root, '.claude', 'settings.local.json')).env, { RUFLO_MCP_ENFORCE_POLICY: '1' });
});

test('project without a policy file never receives enforcement', (t) => {
  const { root, userSettingsFile } = fixture(t);
  reconcileClaudeComponentEnv(cfg(), { projectRoot: root, rufloVersion: '3.44.0', userSettingsFile });
  assert.equal(fs.existsSync(path.join(root, '.claude', 'settings.local.json')), false);
  assert.equal('RUFLO_MCP_ENFORCE_POLICY' in read(userSettingsFile).env, false);
});

test('deleting the policy file later removes enforcement on the next reconcile', (t) => {
  const { root, userSettingsFile } = fixture(t);
  const policy = path.join(root, '.harness', 'mcp-policy.json');
  fs.mkdirSync(path.dirname(policy)); fs.writeFileSync(policy, renderPolicy({ maxCallsPerMinute: 120 }));
  reconcileClaudeComponentEnv(cfg(), { projectRoot: root, rufloVersion: '3.44.0', userSettingsFile });
  fs.rmSync(policy);
  reconcileClaudeComponentEnv(cfg(), { projectRoot: root, rufloVersion: '3.44.0', userSettingsFile });
  assert.equal(fs.existsSync(path.join(root, '.claude', 'settings.local.json')), false);
});

test('a user-set learning profile is preserved and reported', (t) => {
  const { root, userSettingsFile } = fixture(t);
  fs.writeFileSync(userSettingsFile, JSON.stringify({ env: { RUFLO_INTELLIGENCE_MODE: 'research' } }));
  const result = reconcileClaudeComponentEnv(cfg(), { projectRoot: root, rufloVersion: '3.44.0', userSettingsFile });
  assert.equal(result.ok, false);
  assert.match(result.findings.find((f) => f.status === 'conflict').reason, /RUFLO_INTELLIGENCE_MODE/);
  assert.equal(read(userSettingsFile).env.RUFLO_INTELLIGENCE_MODE, 'research');
});

test('legacy unreceipted memory pin equal to the computed value is adopted and later removed', (t) => {
  const { root } = fixture(t);
  const local = path.join(root, '.claude', 'settings.local.json');
  const pin = path.join(root, '.swarm', 'memory.db');
  fs.mkdirSync(path.dirname(local), { recursive: true });
  fs.writeFileSync(local, JSON.stringify({ env: { CLAUDE_FLOW_DB_PATH: pin, KEEP: 'x' } }));
  assert.equal(reconcileMemoryPin(root, { enabled: true }).status, 'adopted');
  assert.equal(reconcileMemoryPin(root, { enabled: false }).changed, true);
  assert.deepEqual(read(local).env, { KEEP: 'x' });
});

test('a foreign memory pin is never adopted', (t) => {
  const { root } = fixture(t);
  const local = path.join(root, '.claude', 'settings.local.json');
  fs.mkdirSync(path.dirname(local), { recursive: true });
  fs.writeFileSync(local, JSON.stringify({ env: { CLAUDE_FLOW_DB_PATH: '/elsewhere/memory.db' } }));
  const result = reconcileMemoryPin(root, { enabled: true });
  assert.equal(result.ok, false);
  assert.equal(read(local).env.CLAUDE_FLOW_DB_PATH, '/elsewhere/memory.db');
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `node --test tests/kit/claude-env-projection.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the Claude projection**

```js
// src/lib/claude-env-projection.mjs
// ADR-0058 §3 (Claude): machine keys in the user settings env; project enforcement and the
// memory pin in the project's settings.local.json env. Receipted by the shared engine.
import fs from 'node:fs';
import path from 'node:path';
import * as paths from './paths.mjs';
import { planOwnedEnv, applyOwnedEnv, jsonTopLevelEnvEditor, readRegularConfig } from './owned-env-projection.mjs';
import { machineComponentEnv, componentEnv, RC_KEYS } from './ruflo-components/env.mjs';
import { writePrivateFileAtomic } from './file-write.mjs';

export const CLAUDE_RC_RECEIPT = '.agentic-kit-ruflo-components.json';
export const MEMORY_PIN_RECEIPT = '.agentic-kit-memory-pin.json';
const MACHINE_KEYS = [RC_KEYS.typesafe, RC_KEYS.embedder, RC_KEYS.mode];
const editorFor = (source) => jsonTopLevelEnvEditor(source);
const asStates = (keys, env) => Object.fromEntries(keys.map((k) => [k, k in env ? { present: true, value: env[k] } : { present: false }]));

function reconcileTarget(target, desired, receiptSuffix, dryRun) {
  try {
    const plan = planOwnedEnv(target, desired, { receiptSuffix, format: 'multi', editorFor });
    if (plan.changed && !dryRun) applyOwnedEnv(plan, { backupTag: 'ruflo-components' });
    return { file: target.file, status: plan.status, changed: plan.changed };
  } catch (error) { return { file: target.file, status: 'conflict', changed: false, reason: error.message }; }
}

export function reconcileClaudeComponentEnv(cfg, {
  projectRoot = null, rufloVersion, userSettingsFile = paths.claudeSettingsPath(), dryRun = false,
} = {}) {
  const enabled = cfg?.integrations?.hosts?.claude !== false;
  const findings = [reconcileTarget(
    { file: userSettingsFile, boundary: path.dirname(userSettingsFile), enabled },
    asStates(MACHINE_KEYS, machineComponentEnv(cfg, rufloVersion)), CLAUDE_RC_RECEIPT, dryRun)];
  if (projectRoot) {
    const local = paths.projectSettingsLocal(projectRoot);
    const wanted = asStates([RC_KEYS.enforce], componentEnv(projectRoot, cfg, rufloVersion));
    if (wanted[RC_KEYS.enforce].present || fs.existsSync(`${local}${CLAUDE_RC_RECEIPT}`)) {
      findings.push(reconcileTarget({ file: local, boundary: projectRoot, enabled }, wanted, CLAUDE_RC_RECEIPT, dryRun));
    }
  }
  const ok = findings.every((f) => f.status !== 'conflict');
  return { ok, changed: findings.some((f) => f.changed), findings };
}

/** ADR-0016 drift fix: the memory pin gains a receipt. A legacy unreceipted pin equal to the
 *  value ak itself computes was written by earlier ak versions and is adopted once. */
export function reconcileMemoryPin(projectRoot, { enabled = true, dryRun = false } = {}) {
  const local = paths.projectSettingsLocal(projectRoot);
  const receiptFile = `${local}${MEMORY_PIN_RECEIPT}`;
  const pin = paths.projectMemoryDb(fs.realpathSync(projectRoot));
  const target = { file: local, boundary: projectRoot, enabled };
  const desired = { CLAUDE_FLOW_DB_PATH: { present: true, value: pin } };
  let legacy = false;
  try {
    const source = readRegularConfig(local);
    legacy = source !== null && readRegularConfig(receiptFile) === null
      && jsonTopLevelEnvEditor(source).get('CLAUDE_FLOW_DB_PATH').value === pin;
  } catch (error) { return { ok: false, changed: false, status: 'conflict', reason: error.message }; }
  if (legacy) {
    if (!dryRun) {
      writePrivateFileAtomic(receiptFile, JSON.stringify({ version: 2, pending: false,
        keys: { CLAUDE_FLOW_DB_PATH: { before: { present: false }, after: { present: true, value: pin } } } }) + '\n');
    }
    if (enabled) return { ok: true, changed: !dryRun, status: 'adopted' };
  }
  try {
    const plan = planOwnedEnv(target, desired, { receiptSuffix: MEMORY_PIN_RECEIPT, format: 'multi', editorFor });
    if (plan.changed && !dryRun) applyOwnedEnv(plan, { backupTag: 'memory-pin' });
    return { ok: true, changed: plan.changed || legacy, status: plan.status };
  } catch (error) { return { ok: false, changed: false, status: 'conflict', reason: error.message }; }
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/kit/claude-env-projection.test.mjs`
Expected: PASS.

- [ ] **Step 5: Replace `pinProjectMemoryDbPath` in setup**

In `src/commands/setup.mjs`, replace the body of `pinProjectMemoryDbPath(root)` with:

```js
function pinProjectMemoryDbPath(root) {
  const result = reconcileMemoryPin(root, { enabled: true });
  if (result.ok) ok(`CLAUDE_FLOW_DB_PATH pinned (${result.status}) → ${paths.projectMemoryDb(fs.realpathSync(root))}`);
  else warn(`CLAUDE_FLOW_DB_PATH pin preserved: ${result.reason} — memory may use a different store`);
}
```

and add `import { reconcileMemoryPin } from '../lib/claude-env-projection.mjs';`.
Remove `writeJsonWithBackup` from this function only; it is still used elsewhere in the file.

- [ ] **Step 6: MCP registration — branch on the Task 0 record**

Always, in `src/lib/mcp.mjs`, let the replaceability check accept keys ak projects:

```js
const AK_REGISTRATION_ENV_KEYS = new Set(['AGENT_BROWSER_CONFIG',
  'CLAUDE_FLOW_ROUTER_TYPESAFE', 'CLAUDE_FLOW_ROUTER_EMBEDDER', 'RUFLO_INTELLIGENCE_MODE']);
function replaceableRufloRegistration(entry) {
  if (!canonicalRufloRegistration(entry) || entry.scope !== 'user') return false;
  return Object.keys(entry.env ?? {}).every((key) => AK_REGISTRATION_ENV_KEYS.has(key));
}
```

**If Task 0 recorded "Inherits":** `register()` is otherwise unchanged; the MCP server gets the
variables from the settings `env` block.

**If Task 0 recorded "Does not inherit":** the registration keeps `ruflo mcp start` (so
`canonicalRufloRegistration` and ruflo's own duplicate detection keep working) and carries the
machine keys as `-e` values. In `register(cfg, …)` change `desired.env` to:

```js
    env: {
      ...managedAgentBrowserEnv({ enabled: cfg?.agentBrowser !== false }),
      ...machineComponentEnv(cfg, installedVersion('ruflo')),
    },
```

importing `machineComponentEnv` from `./ruflo-components/env.mjs` and `installedVersion` from
`./versions.mjs`. Project enforcement cannot travel in a user-scoped registration, so in this
branch the governance component is reported `partial` for Claude MCP by Task 7 until a
per-project launcher is adopted; record that in ADR-0058 §3 in the same step.

Add a test to `tests/kit/claude-env-projection.test.mjs` (or the existing MCP register tests)
asserting `replaceableRufloRegistration`'s behaviour through `register()` with an injected
`inspect` that returns a user registration carrying `RUFLO_INTELLIGENCE_MODE`: `register`
must replace it, not return `false`.

- [ ] **Step 7: Run the MCP and setup suites**

Run: `node --test tests/kit/claude-env-projection.test.mjs tests/kit/mcp*.test.mjs tests/kit/setup*.test.mjs`
Expected: PASS.

- [ ] **Step 8: Commit (only if authorized)**

```bash
git add src/lib/claude-env-projection.mjs src/commands/setup.mjs src/lib/mcp.mjs tests/kit/claude-env-projection.test.mjs
git commit -m "feat(ruflo-components): receipted Claude env projection and memory pin (ADR-0016 drift)"
```

---

### Task 5: Codex launcher and OpenCode projection

**Files:**

- Modify: `src/lib/ruflo-memory.mjs` (`rufloMcpLaunch`)
- Modify: `src/lib/opencode-core.mjs` (`mcpEntriesFor` gains `componentEnv` option; both call sites pass it)
- Modify: `src/templates/opencode-ruflo-gateway.js` (`configure`)
- Modify: `src/templates/opencode-ruflo-hooks.js` (`projectHookEnv`)
- Test: `tests/kit/ruflo-components-hosts.test.mjs`; existing OpenCode artifact/hash tests updated for the regenerated templates

**Interfaces:**

- Consumes: `machineComponentEnv`, `componentEnv`, `RC_KEYS` (Task 2); `installedVersion` (`versions.mjs`).
- Produces:
  - `rufloMcpLaunch(cwd, env, { cfg, rufloVersion })` — env now includes `componentEnv(root, cfg, rufloVersion)`
  - `mcpEntriesFor({ ..., rufloComponentEnv = {} })` — merged into the `claude-flow` entry's `environment`
  - OpenCode `claude-flow` entry environment gains `AK_RUFLO_GOVERNANCE: 'managed'` when governance is managed and supported
  - gateway and hooks set `RUFLO_MCP_ENFORCE_POLICY=1` per project only when `AK_RUFLO_GOVERNANCE === 'managed'` and `<project>/.harness/mcp-policy.json` parses

- [ ] **Step 1: Write the failing tests**

```js
// tests/kit/ruflo-components-hosts.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rufloMcpLaunch } from '../../src/lib/ruflo-memory.mjs';
import { mcpEntriesFor } from '../../src/lib/opencode-core.mjs';
import { renderPolicy } from '../../src/lib/ruflo-components/policy.mjs';

const cfg = { agentBrowser: false, rufloComponents: { typesafePicker: true, minilmPicker: true,
  mcpGovernance: { maxCallsPerMinute: 120 }, learningProfile: 'balanced', turnCredit: true, memoryFix2887: true, funnel: false } };
function repo(t, withPolicy) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ak-rc-hosts-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.git'));
  if (withPolicy) {
    fs.mkdirSync(path.join(root, '.harness'));
    fs.writeFileSync(path.join(root, '.harness', 'mcp-policy.json'), renderPolicy({ maxCallsPerMinute: 120 }));
  }
  return root;
}

test('Codex launcher adds machine keys and project enforcement only with a policy', (t) => {
  const withPolicy = rufloMcpLaunch(repo(t, true), {}, { cfg, rufloVersion: '3.44.0' });
  assert.equal(withPolicy.env.RUFLO_MCP_ENFORCE_POLICY, '1');
  assert.equal(withPolicy.env.CLAUDE_FLOW_ROUTER_EMBEDDER, 'minilm');
  const without = rufloMcpLaunch(repo(t, false), {}, { cfg, rufloVersion: '3.44.0' });
  assert.equal('RUFLO_MCP_ENFORCE_POLICY' in without.env, false);
  assert.equal(without.env.RUFLO_INTELLIGENCE_MODE, 'balanced');
});

test('launcher managed values override inherited shell values', (t) => {
  const spec = rufloMcpLaunch(repo(t, false), { RUFLO_INTELLIGENCE_MODE: 'edge' }, { cfg, rufloVersion: '3.44.0' });
  assert.equal(spec.env.RUFLO_INTELLIGENCE_MODE, 'balanced');
});

test('OpenCode claude-flow entry carries machine keys and the governance marker', async () => {
  const entries = await mcpEntriesFor({ brainShim: '/nonexistent', nestedPath: '/nonexistent', includeAqe: false,
    agentBrowserEnabled: false,
    rufloComponentEnv: { CLAUDE_FLOW_ROUTER_TYPESAFE: '1', AK_RUFLO_GOVERNANCE: 'managed' } });
  assert.equal(entries['claude-flow'].environment.CLAUDE_FLOW_ROUTER_TYPESAFE, '1');
  assert.equal(entries['claude-flow'].environment.AK_RUFLO_GOVERNANCE, 'managed');
});
```

The hooks template is directly importable (`tests/kit/opencode-hooks.test.mjs` already imports
`projectHookEnv`). Add to `tests/kit/ruflo-components-hosts.test.mjs`:

```js
import { projectHookEnv } from '../../src/templates/opencode-ruflo-hooks.js';

test('OpenCode hooks enforce governance only with the marker and a valid policy', (t) => {
  const withPolicy = repo(t, true);
  const without = repo(t, false);
  assert.equal(projectHookEnv(withPolicy, { AK_RUFLO_GOVERNANCE: 'managed' }).RUFLO_MCP_ENFORCE_POLICY, '1');
  assert.equal('RUFLO_MCP_ENFORCE_POLICY' in projectHookEnv(without, { AK_RUFLO_GOVERNANCE: 'managed' }), false);
  assert.equal('RUFLO_MCP_ENFORCE_POLICY' in projectHookEnv(withPolicy, {}), false);
});
```

The existing assertion in `opencode-hooks.test.mjs` (`projectHookEnv(directory, { KEEP: 'yes' })`
deep-equals `{ KEEP, CLAUDE_FLOW_DB_PATH }`) must still pass unchanged: with no marker, the
helper adds nothing. If Step 5 bakes `RUFLO_COMPONENT_ENV` into the template, that constant is
empty in the unsubstituted source file, so this stays true.

For the gateway, extract `managedEnforcement` into a named export of
`opencode-ruflo-gateway.js` alongside its existing exports and test it the same way:

```js
import { managedEnforcement } from '../../src/templates/opencode-ruflo-gateway.js';

test('OpenCode gateway enforcement helper mirrors the hooks rule', (t) => {
  assert.deepEqual(managedEnforcement(repo(t, true), { AK_RUFLO_GOVERNANCE: 'managed' }), { RUFLO_MCP_ENFORCE_POLICY: '1' });
  assert.deepEqual(managedEnforcement(repo(t, false), { AK_RUFLO_GOVERNANCE: 'managed' }), {});
});
```

If the gateway template has no export statement today, add
`export { managedEnforcement }` at its end, and confirm the generated artifact text
(`gatewayDesiredText`) is still valid for OpenCode's plugin loader by running the OpenCode
artifact tests.

- [ ] **Step 2: Run to confirm it fails**

Run: `node --test tests/kit/ruflo-components-hosts.test.mjs`
Expected: FAIL — `RUFLO_MCP_ENFORCE_POLICY` undefined / `rufloComponentEnv` ignored.

- [ ] **Step 3: Launcher**

```js
// src/lib/ruflo-memory.mjs — rufloMcpLaunch
import { installedVersion } from './versions.mjs';
import { componentEnv } from './ruflo-components/env.mjs';

export function rufloMcpLaunch(cwd = process.cwd(), env = process.env, {
  cfg = loadKitConfig(), rufloVersion = installedVersion('ruflo'),
} = {}) {
  const root = memoryProjectRoot(cwd);
  return {
    command: 'ruflo',
    args: ['mcp', 'start'],
    cwd: root,
    env: projectMemoryEnv(root, {
      ...env,
      ...managedAgentBrowserEnv({ enabled: cfg.agentBrowser !== false }),
      ...componentEnv(root, cfg, rufloVersion),
    }),
  };
}
```

- [ ] **Step 4: OpenCode entry**

In `mcpEntriesFor`, add `rufloComponentEnv = {}` to the destructured options and spread it last
into the `claude-flow` `environment`. At both call sites (`opencode-core.mjs:349` and `:625`)
pass:

```js
    rufloComponentEnv: {
      ...machineComponentEnv(cfg, installedVersion('ruflo')),
      ...(managedIntent(cfg, 'mcpGovernance') && supports(installedVersion('ruflo'), '3.42.0')
        ? { AK_RUFLO_GOVERNANCE: 'managed' } : {}),
    },
```

importing `machineComponentEnv`, `supports` from `./ruflo-components/env.mjs` and
`managedIntent` from `./ruflo-components/config.mjs`. `opencodeConverged` compares the
environment exactly, so convergence follows automatically.

- [ ] **Step 5: Gateway and hooks templates**

Both templates are plain JS without imports from ak. Add one self-contained helper to each:

```js
function managedEnforcement(directory, env) {
  if (env.AK_RUFLO_GOVERNANCE !== "managed") return {}
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(directory, ".harness", "mcp-policy.json"), "utf8"))
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? { RUFLO_MCP_ENFORCE_POLICY: "1" } : {}
  } catch { return {} }
}
```

Gateway `configure(entry)`:

```js
    const base = entry.environment && typeof entry.environment === "object" ? entry.environment : {}
    this.environment = {
      ...base,
      ...managedEnforcement(this.directory, base),
      CLAUDE_FLOW_DB_PATH: path.join(this.directory, ".swarm", "memory.db"),
    }
```

Hooks `projectHookEnv(directory, env)`:

```js
  return {
    ...env,
    ...managedEnforcement(root, env),
    CLAUDE_FLOW_DB_PATH: path.join(root, ".swarm", "memory.db"),
  }
```

The hooks process receives `AK_RUFLO_GOVERNANCE` and the machine keys only if OpenCode passes
the MCP entry environment to plugins. It does not, so in `opencode-core.mjs` also write the
machine keys and marker into the generated hooks artifact the same way the gateway's managed
set is baked in (`gatewayDesiredText`, `opencode-artifacts.mjs:98-118`): add a
`RUFLO_COMPONENT_ENV` constant substitution to the hooks template text and spread it before
`...env` in `projectHookEnv`. Update the artifact content-hash expectations in the OpenCode
artifact tests; the hash change is the intended regeneration.

- [ ] **Step 6: Run the host suites**

Run: `node --test tests/kit/ruflo-components-hosts.test.mjs tests/kit/opencode*.test.mjs tests/kit/codex*.test.mjs`
Expected: PASS.

- [ ] **Step 7: Codex hooks — branch on the Task 0 record**

If Task 0 found a supported mechanism, implement it here with a test mirroring Step 1. If not,
no code: Task 7's classifier reports `partial` with missing host "Codex hooks" for the pickers
and learning profile when Codex is enabled.

- [ ] **Step 8: Commit (only if authorized)**

```bash
git add src/lib/ruflo-memory.mjs src/lib/opencode-core.mjs src/lib/opencode-artifacts.mjs src/templates/opencode-ruflo-gateway.js src/templates/opencode-ruflo-hooks.js tests/kit/
git commit -m "feat(ruflo-components): Codex launcher and OpenCode projections"
```

---

### Task 6: Evidence probes and parsers

**Files:**

- Create: `src/lib/ruflo-components/evidence.mjs`
- Create: `tests/fixtures/ruflo-components/` text fixtures (content below)
- Test: `tests/kit/ruflo-components-evidence.test.mjs`

**Interfaces:**

- Consumes: `run(cmd, args, opts)` (`src/lib/exec.mjs`), `paths.rufloNodeModules()`, `componentEnv` (Task 2), `cmpVersions`.
- Produces:
  - `parseDoctor(text) → Array<{ status: 'pass'|'warn'|'fail', name, detail }>`
  - `parseRouteEmbedder(text) → string | null`
  - `parseIntelligence(text) → { mode, lastTrainingSeconds, trajectories } | null`
  - `parseNeuralStatus(text) → { sonaEngineLoaded: boolean } | null`
  - `parseFunnel(text) → { enabled: boolean, decidedBy: string } | null`
  - `auditStats(file, now) → { audited, refused, reasons: string[] } | null`
  - `moduleVersionFromRuflo(pkg) → string | null`
  - `collectEvidence({ projectRoot, cfg, rufloVersion, runner, now }) → Evidence`
    - `Evidence = { capturedAt: ISOString, rufloVersion, typesafe: {resolves, doctor}, minilm: {embedder}, learning: {mode, engineLoaded, lastTrainingSeconds, trajectories}, turnCredit: {present}, memoryFix: {version}, funnel: {enabled, decidedBy}, governance: {audit}, errors: Record<string,string> }`
  - `readEvidenceCache(file) / writeEvidenceCache(file, evidence)`; `EVIDENCE_TTL_MS = 15 * 60_000`; `EVIDENCE_STALE_MS = 24 * 3600_000`

- [ ] **Step 1: Add fixtures captured from ruflo 3.43.0 on 2026-09-23**

`tests/fixtures/ruflo-components/doctor-typesafe-3.43.0.txt`:

```text
RuFlo Doctor
System diagnostics and health check
──────────────────────────────────────────────────
... Running health checks in parallel...                                              ✓ @ruvector/typesafe router: Not installed; disabled (set CLAUDE_FLOW_ROUTER_TYPESAFE=1) — hooks_route uses the built-in router
──────────────────────────────────────────────────
Summary: 1 passed
All checks passed! System is healthy.
```

`tests/fixtures/ruflo-components/doctor-metaharness-3.43.0.txt`:

```text
... Running health checks in parallel...                                              ✓ MetaHarness (ADR-150): v0.4.2 — run `npx ruflo metaharness score` for the full scorecard
✓ MetaHarness declared packages (ADR-150): 4 declared package(s) resolve: @metaharness/darwin, @metaharness/flywheel, @metaharness/radio, @metaharness/turn-credit
✓ MetaHarness integration (ADR-150): plugin scripts intact, _similarity.mjs + parseMcpScanText load, smoke OK
Summary: 3 passed
```

`tests/fixtures/ruflo-components/intelligence-stats-3.43.0.txt`:

```text
| Mode: balanced                                                                     |
| Status: active                                                                     |
| Last Training: 170300s ago                                                         |
| Trajectories     |   13649 |
| Patterns Learned |   13586 |
```

`tests/fixtures/ruflo-components/neural-status-3.43.0.txt`:

```text
| SONA Coordinator    | Active     | Adaptation: 0.97μs avg           |
| SONA Engine         | Not loaded | Optional, enable with --sona     |
| ReasoningBank       | Active     | 13586 patterns stored            |
```

`tests/fixtures/ruflo-components/funnel-status-3.43.0.txt`:

```text
Funnel: enabled (decided by: package-default)
Disclosure: disclosed_enabled
State dir: /Users/example/.ruflo
Consents: none recorded
```

Task 11 adds the 3.44.0 fixtures (`route-minilm-3.44.0.txt`, `doctor-typesafe-installed-3.44.0.txt`,
`funnel-status-disabled-3.44.0.txt`) captured from the real machine.

- [ ] **Step 2: Write the failing tests**

```js
// tests/kit/ruflo-components-evidence.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseDoctor, parseRouteEmbedder, parseIntelligence, parseNeuralStatus, parseFunnel, auditStats, collectEvidence }
  from '../../src/lib/ruflo-components/evidence.mjs';

const fixture = (name) => fs.readFileSync(new URL(`../fixtures/ruflo-components/${name}`, import.meta.url), 'utf8');

test('doctor parser reads a spinner-prefixed line and plain lines', () => {
  const rows = parseDoctor(fixture('doctor-typesafe-3.43.0.txt'));
  assert.deepEqual(rows, [{ status: 'pass', name: '@ruvector/typesafe router',
    detail: 'Not installed; disabled (set CLAUDE_FLOW_ROUTER_TYPESAFE=1) — hooks_route uses the built-in router' }]);
  assert.equal(parseDoctor(fixture('doctor-metaharness-3.43.0.txt')).length, 3);
});

test('doctor parser strips ANSI colour and ignores unrelated lines', () => {
  assert.deepEqual(parseDoctor('\u001b[32m⚠\u001b[0m Encryption at Rest: Off\nSummary: 0 passed'),
    [{ status: 'warn', name: 'Encryption at Rest', detail: 'Off' }]);
  assert.deepEqual(parseDoctor('totally different format'), []);
});

test('route embedder, intelligence, neural and funnel parsers', () => {
  assert.equal(parseRouteEmbedder('... routedBy=semantic embedder=minilm ...'), 'minilm');
  assert.equal(parseRouteEmbedder('no marker'), null);
  assert.deepEqual(parseIntelligence(fixture('intelligence-stats-3.43.0.txt')),
    { mode: 'balanced', lastTrainingSeconds: 170300, trajectories: 13649 });
  assert.deepEqual(parseNeuralStatus(fixture('neural-status-3.43.0.txt')), { sonaEngineLoaded: false });
  assert.deepEqual(parseFunnel(fixture('funnel-status-3.43.0.txt')), { enabled: true, decidedBy: 'package-default' });
  assert.equal(parseIntelligence('garbage'), null);
});

test('audit stats count the last 24 hours only and keep recent refusal reasons', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-audit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'audit.jsonl');
  const now = Date.parse('2026-09-23T12:00:00Z');
  const line = (iso, allowed, reason) => JSON.stringify({ timestamp: iso, sessionId: 's', toolName: 'memory_store', allowed, reason });
  fs.writeFileSync(file, [
    line('2026-09-21T12:00:00Z', false, 'old'),
    line('2026-09-23T11:00:00Z', true),
    line('2026-09-23T11:30:00Z', false, 'maxToolCallsPerTurn (120) exceeded within the last 60000ms for this session'),
    'not json',
  ].join('\n') + '\n');
  assert.deepEqual(auditStats(file, now), { audited: 2, refused: 1,
    reasons: ['maxToolCallsPerTurn (120) exceeded within the last 60000ms for this session'] });
  assert.equal(auditStats(path.join(dir, 'missing.jsonl'), now), null);
});

test('collectEvidence survives probe failures and records them', async () => {
  const runner = async (cmd, args) => {
    if (args.includes('funnel')) return { code: 1, stdout: '', stderr: 'boom' };
    if (args.includes('doctor')) return { code: 0, stdout: fixture('doctor-typesafe-3.43.0.txt'), stderr: '' };
    return { code: 124, stdout: '', stderr: 'timed out' };
  };
  const evidence = await collectEvidence({ projectRoot: null, cfg: {}, rufloVersion: '3.43.0', runner, now: Date.now() });
  assert.equal(evidence.funnel, null);
  assert.match(evidence.errors.funnel, /boom/);
  assert.equal(evidence.learning.mode, null);
  assert.match(evidence.errors.intelligence, /timed out/);
});
```

- [ ] **Step 3: Run to confirm it fails**

Run: `node --test tests/kit/ruflo-components-evidence.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement parsers, probes and cache**

```js
// src/lib/ruflo-components/evidence.mjs
// ADR-0058: ruflo's own evidence. Text parsing is tolerant; anything unreadable is null,
// which the classifier turns into `unknown` — never `active`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../exec.mjs';
import * as paths from '../paths.mjs';
import { componentEnv } from './env.mjs';
import { writePrivateFileAtomic } from '../file-write.mjs';

export const EVIDENCE_TTL_MS = 15 * 60_000;
export const EVIDENCE_STALE_MS = 24 * 3600_000;
export const AUDIT_LOG = () => path.join(os.tmpdir(), 'ruflo-mcp-audit.jsonl');
const ANSI = /\u001b\[[0-9;]*m/g;
const STATUS = { '✓': 'pass', '⚠': 'warn', '✗': 'fail' };

export function parseDoctor(text) {
  const rows = [];
  for (const raw of String(text).replace(ANSI, '').split('\n')) {
    const m = raw.match(/([✓⚠✗])\s+([^:]+?):\s*(.*)$/);
    if (m) rows.push({ status: STATUS[m[1]], name: m[2].trim(), detail: m[3].trim() });
  }
  return rows;
}

export const parseRouteEmbedder = (text) => String(text).match(/embedder=([a-z0-9-]+)/i)?.[1] ?? null;

export function parseIntelligence(text) {
  const t = String(text).replace(ANSI, '');
  const mode = t.match(/Mode:\s*([a-z-]+)/i)?.[1];
  if (!mode) return null;
  const last = t.match(/Last Training:\s*(\d+)s ago/i)?.[1];
  const traj = t.match(/Trajectories\s*\|\s*(\d+)/i)?.[1];
  return { mode, lastTrainingSeconds: last ? Number(last) : null, trajectories: traj ? Number(traj) : null };
}

export function parseNeuralStatus(text) {
  const m = String(text).replace(ANSI, '').match(/SONA Engine\s*\|\s*([^|]+)\|/i);
  return m ? { sonaEngineLoaded: !/not loaded/i.test(m[1]) } : null;
}

export function parseFunnel(text) {
  const m = String(text).replace(ANSI, '').match(/Funnel:\s*(enabled|disabled)\s*\(decided by:\s*([^)]+)\)/i);
  return m ? { enabled: m[1].toLowerCase() === 'enabled', decidedBy: m[2].trim() } : null;
}

export function auditStats(file, now = Date.now()) {
  let text;
  try {
    const { size } = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    const length = Math.min(size, 5 * 1024 * 1024);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, size - length);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch { return null; }
  let audited = 0; let refused = 0; const reasons = [];
  for (const line of text.split('\n')) {
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    const at = Date.parse(rec?.timestamp);
    if (!Number.isFinite(at) || now - at > 24 * 3600_000) continue;
    audited += 1;
    if (rec.allowed === false) { refused += 1; if (rec.reason) reasons.push(String(rec.reason)); }
  }
  return { audited, refused, reasons: reasons.slice(-5) };
}

export function moduleVersionFromRuflo(pkg) {
  for (const base of [path.join(paths.rufloNodeModules(), '@claude-flow', 'cli', 'node_modules'), paths.rufloNodeModules(), path.dirname(paths.rufloRoot())]) {
    try { return JSON.parse(fs.readFileSync(path.join(base, pkg, 'package.json'), 'utf8')).version; } catch { /* next */ }
  }
  return null;
}

async function probe(runner, args, env, errors, key) {
  try {
    const r = await runner('ruflo', args, { env, timeout: 90_000 });
    if (r.code === 0) return r.stdout;
    errors[key] = (r.stderr || r.stdout || `exit ${r.code}`).trim().slice(0, 200);
  } catch (error) { errors[key] = String(error?.message ?? error).slice(0, 200); }
  return null;
}

export async function collectEvidence({ projectRoot, cfg, rufloVersion, runner = run, now = Date.now(), cwd = projectRoot ?? process.cwd() }) {
  const env = { ...process.env, ...componentEnv(projectRoot, cfg, rufloVersion) };
  const errors = {};
  const call = (args, key) => probe((c, a, o) => runner(c, a, { ...o, cwd }), args, env, errors, key);
  const [typesafeDoc, metaDoc, route, intel, neural, funnel] = await Promise.all([
    call(['doctor', '--component', 'typesafe'], 'typesafe'),
    call(['doctor', '--component', 'metaharness'], 'metaharness'),
    call(['hooks', 'route', '--task', 'sync and review latest issues'], 'route'),
    call(['hooks', 'intelligence', 'stats'], 'intelligence'),
    call(['neural', 'status'], 'neural'),
    call(['funnel', 'status'], 'funnel'),
  ]);
  const typesafeRow = typesafeDoc ? parseDoctor(typesafeDoc).find((r) => /typesafe/i.test(r.name)) ?? null : null;
  const intelligence = intel ? parseIntelligence(intel) : null;
  return {
    capturedAt: new Date(now).toISOString(),
    rufloVersion,
    typesafe: { resolves: moduleVersionFromRuflo('@ruvector/typesafe') !== null, doctor: typesafeRow },
    minilm: { embedder: route ? parseRouteEmbedder(route) : null },
    learning: {
      mode: intelligence?.mode ?? null,
      engineLoaded: neural ? parseNeuralStatus(neural)?.sonaEngineLoaded ?? null : null,
      lastTrainingSeconds: intelligence?.lastTrainingSeconds ?? null,
      trajectories: intelligence?.trajectories ?? null,
    },
    turnCredit: { present: metaDoc ? parseDoctor(metaDoc).some((r) => /turn-credit/.test(r.detail)) : null },
    memoryFix: { version: moduleVersionFromRuflo('@claude-flow/memory') },
    funnel: funnel ? parseFunnel(funnel) : null,
    governance: { audit: auditStats(AUDIT_LOG(), now) },
    errors,
  };
}

export function readEvidenceCache(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
export function writeEvidenceCache(file, evidence) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writePrivateFileAtomic(file, JSON.stringify(evidence) + '\n');
}
```

`paths.rufloRoot()` exists (`paths.mjs:180`). Check that it does before relying on it; if its
name differs, use the function `rufloNodeModules()` is built from.

- [ ] **Step 5: Run the tests**

Run: `node --test tests/kit/ruflo-components-evidence.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit (only if authorized)**

```bash
git add src/lib/ruflo-components/evidence.mjs tests/fixtures/ruflo-components tests/kit/ruflo-components-evidence.test.mjs
git commit -m "feat(ruflo-components): evidence probes, tolerant parsers and cache"
```

---

### Task 7: Snapshot and state classification

**Files:**

- Create: `src/lib/ruflo-components/snapshot.mjs`
- Test: `tests/kit/ruflo-components-snapshot.test.mjs`

**Interfaces:**

- Consumes: `COMPONENTS`, `describeState` (Task 1); `managedIntent` (Task 1); `supports`, `machineComponentEnv` (Task 2); `readPolicy` (Task 2); `EVIDENCE_STALE_MS` (Task 6); `cmpVersions`.
- Produces:
  - `classifyComponent(component, { cfg, rufloVersion, evidence, projection, now }) → ComponentView`
    - `projection = { claude: { conflicts: string[], changed: boolean } | null, missingHosts: string[], policy: 'absent'|'invalid'|'valid'|null, blocked?: Record<id,string> }`
    - `ComponentView = { id, label, managed, value, state: { id, label, meaning, action }, explain, options, evidence: Array<{ source, capturedAt, detail }> }`
  - `componentSnapshot({ cfg, rufloVersion, evidence, projection, now }) → { rufloVersion, capturedAt, components: ComponentView[], summary: { active, total } }`

- [ ] **Step 1: Write the failing tests**

```js
// tests/kit/ruflo-components-snapshot.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { componentSnapshot } from '../../src/lib/ruflo-components/snapshot.mjs';

const now = Date.parse('2026-09-23T12:00:00Z');
const cfg = { rufloComponents: { typesafePicker: true, minilmPicker: true, mcpGovernance: { maxCallsPerMinute: 120 },
  learningProfile: 'balanced', turnCredit: true, memoryFix2887: true, funnel: false } };
const evidence = (over = {}) => ({
  capturedAt: new Date(now - 60_000).toISOString(), rufloVersion: '3.44.0',
  typesafe: { resolves: true, doctor: { status: 'pass', name: '@ruvector/typesafe router', detail: 'installed; enabled' } },
  minilm: { embedder: 'minilm' },
  learning: { mode: 'balanced', engineLoaded: false, lastTrainingSeconds: 170300, trajectories: 13649 },
  turnCredit: { present: true }, memoryFix: { version: '3.0.0-alpha.25' },
  funnel: { enabled: false, decidedBy: 'user' }, governance: { audit: { audited: 10, refused: 0, reasons: [] } },
  errors: {}, ...over });
const projection = (over = {}) => ({ claude: { conflicts: [], changed: false }, missingHosts: [], policy: 'valid', ...over });
const byId = (snap, id) => snap.components.find((c) => c.id === id);

test('everything confirmed is active and the summary counts it', () => {
  const snap = componentSnapshot({ cfg, rufloVersion: '3.44.0', evidence: evidence(), projection: projection(), now });
  for (const id of ['typesafePicker', 'minilmPicker', 'mcpGovernance', 'learningProfile', 'turnCredit', 'memoryFix2887', 'funnel']) {
    assert.equal(byId(snap, id).state.id, 'active', id);
  }
  assert.deepEqual(snap.summary, { active: 7, total: 8 });
});

test('old ruflo reports needs-ruflo with the version in the label', () => {
  const snap = componentSnapshot({ cfg, rufloVersion: '3.43.0', evidence: evidence({ minilm: { embedder: 'hash' } }), projection: projection(), now });
  assert.equal(byId(snap, 'minilmPicker').state.label, 'needs ruflo ≥ 3.44.0');
});

test('opted-out component is user-managed with its meaning', () => {
  const snap = componentSnapshot({ cfg: { rufloComponents: { ...cfg.rufloComponents, minilmPicker: false } },
    rufloVersion: '3.44.0', evidence: evidence(), projection: projection(), now });
  assert.equal(byId(snap, 'minilmPicker').state.id, 'user-managed');
  assert.match(byId(snap, 'minilmPicker').state.meaning, /leaves it alone/);
});

test('a preserved conflicting value is user-managed, not drifted', () => {
  const snap = componentSnapshot({ cfg, rufloVersion: '3.44.0', evidence: evidence({ learning: { mode: 'research', engineLoaded: false } }),
    projection: projection({ claude: { conflicts: ['RUFLO_INTELLIGENCE_MODE'], changed: false } }), now });
  assert.equal(byId(snap, 'learningProfile').state.id, 'user-managed');
});

test('applied but evidence disagrees → applied-unverified', () => {
  const snap = componentSnapshot({ cfg, rufloVersion: '3.44.0', evidence: evidence({ minilm: { embedder: 'hash' } }), projection: projection(), now });
  assert.equal(byId(snap, 'minilmPicker').state.id, 'applied-unverified');
});

test('stale or missing evidence is unknown, never active', () => {
  const stale = componentSnapshot({ cfg, rufloVersion: '3.44.0', evidence: evidence({ capturedAt: new Date(now - 48 * 3600_000).toISOString() }),
    projection: projection(), now });
  assert.equal(byId(stale, 'typesafePicker').state.id, 'unknown');
  const none = componentSnapshot({ cfg, rufloVersion: '3.44.0', evidence: null, projection: projection(), now });
  assert.equal(byId(none, 'turnCredit').state.id, 'unknown');
});

test('governance with an invalid policy is blocked with the lockout reason', () => {
  const snap = componentSnapshot({ cfg, rufloVersion: '3.44.0', evidence: evidence(), projection: projection({ policy: 'invalid' }), now });
  assert.equal(byId(snap, 'mcpGovernance').state.id, 'blocked');
  assert.match(byId(snap, 'mcpGovernance').state.meaning, /refuse every tool call/);
});

test('missing hosts make a component partial and name them', () => {
  const snap = componentSnapshot({ cfg, rufloVersion: '3.44.0', evidence: evidence(), projection: projection({ missingHosts: ['Codex hooks'] }), now });
  assert.equal(byId(snap, 'typesafePicker').state.id, 'partial');
  assert.match(byId(snap, 'typesafePicker').state.meaning, /Codex hooks/);
});

test('learning profile evidence says when the engine is not loaded', () => {
  const snap = componentSnapshot({ cfg, rufloVersion: '3.44.0', evidence: evidence(), projection: projection(), now });
  assert.ok(byId(snap, 'learningProfile').evidence.some((e) => /engine not loaded/i.test(e.detail)));
});

test('memory fix older than alpha.22 is blocked with upgrade guidance', () => {
  const snap = componentSnapshot({ cfg, rufloVersion: '3.44.0', evidence: evidence({ memoryFix: { version: '3.0.0-alpha.21' } }), projection: projection(), now });
  assert.equal(byId(snap, 'memoryFix2887').state.id, 'blocked');
});

test('encryption is reported as not yet managed (ADR-0059)', () => {
  const snap = componentSnapshot({ cfg, rufloVersion: '3.44.0', evidence: evidence(), projection: projection(), now });
  assert.equal(byId(snap, 'encryptionAtRest').state.id, 'not-applied');
  assert.match(byId(snap, 'encryptionAtRest').state.meaning, /ADR-0059/);
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `node --test tests/kit/ruflo-components-snapshot.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// src/lib/ruflo-components/snapshot.mjs
import { cmpVersions } from '../versions.mjs';
import { COMPONENTS } from './catalogue.mjs';
import { describeState } from './states.mjs';
import { managedIntent } from './config.mjs';
import { supports, RC_KEYS } from './env.mjs';
import { EVIDENCE_STALE_MS } from './evidence.mjs';

const KEY_OF = { typesafePicker: RC_KEYS.typesafe, minilmPicker: RC_KEYS.embedder, learningProfile: RC_KEYS.mode };
const ev = (source, capturedAt, detail) => ({ source, capturedAt, detail });

/** Returns true (confirmed), false (contradicted) or null (no evidence). */
function confirmed(id, intent, e) {
  switch (id) {
    case 'typesafePicker': return e.typesafe?.doctor ? (e.typesafe.resolves && !/not installed|disabled/i.test(e.typesafe.doctor.detail)) : null;
    case 'minilmPicker': return e.minilm?.embedder ? e.minilm.embedder === 'minilm' : null;
    case 'learningProfile': return e.learning?.mode ? e.learning.mode === intent : null;
    case 'turnCredit': return e.turnCredit?.present ?? null;
    case 'memoryFix2887': return e.memoryFix?.version ? cmpVersions(e.memoryFix.version, '3.0.0-alpha.22') >= 0 : null;
    case 'funnel': return e.funnel ? e.funnel.enabled === false : null;
    case 'mcpGovernance': return e.governance?.audit ? true : null;
    default: return null;
  }
}

function evidenceLines(id, e) {
  if (!e) return [];
  const at = e.capturedAt;
  switch (id) {
    case 'typesafePicker': return e.typesafe?.doctor ? [ev('ruflo doctor', at, e.typesafe.doctor.detail)] : [];
    case 'minilmPicker': return e.minilm?.embedder ? [ev('hooks route probe', at, `embedder=${e.minilm.embedder}`)] : [];
    case 'learningProfile': {
      const l = e.learning ?? {};
      const engine = l.engineLoaded === false ? 'SONA engine not loaded — the profile has nothing to tune yet'
        : l.engineLoaded ? 'SONA engine loaded' : 'engine state unknown';
      return [ev('hooks intelligence stats', at, `mode ${l.mode ?? 'unknown'}; ${engine}; last training ${l.lastTrainingSeconds ?? '?'}s ago; ${l.trajectories ?? '?'} trajectories`)];
    }
    case 'mcpGovernance': {
      const a = e.governance?.audit;
      return a ? [ev('MCP audit log (last 24 h)', at, `${a.audited} calls audited, ${a.refused} refused${a.reasons.length ? `; latest: ${a.reasons.at(-1)}` : ''}`)]
        : [ev('MCP audit log', at, 'no audit records yet')];
    }
    case 'funnel': return e.funnel ? [ev('ruflo funnel status', at, `${e.funnel.enabled ? 'enabled' : 'disabled'} (decided by ${e.funnel.decidedBy})`)] : [];
    case 'memoryFix2887': return e.memoryFix?.version ? [ev('@claude-flow/memory', at, e.memoryFix.version)] : [];
    case 'turnCredit': return e.turnCredit?.present === null ? [] : [ev('ruflo doctor', at, e.turnCredit?.present ? '@metaharness/turn-credit resolves' : 'turn-credit not found')];
    default: return [];
  }
}

function stateFor(component, { cfg, rufloVersion, evidence, projection, now }) {
  const { id, minRuflo } = component;
  if (id === 'encryptionAtRest') return describeState('not-applied', { reason: 'Managed by ADR-0059, not yet implemented.' });
  const intent = managedIntent(cfg, id);
  if (!intent) return describeState('user-managed');
  if (!supports(rufloVersion, minRuflo)) return describeState('needs-ruflo', { minRuflo });
  if (projection?.blocked?.[id]) return describeState('blocked', { reason: projection.blocked[id] });
  if (id === 'mcpGovernance' && projection?.policy === 'invalid') {
    return describeState('blocked', { reason: 'The policy file is invalid, so ruflo would refuse every tool call; ak removed enforcement for this project.' });
  }
  if (id === 'mcpGovernance' && projection?.policy === 'absent') return describeState('not-applied');
  if (KEY_OF[id] && projection?.claude?.conflicts?.includes(KEY_OF[id])) return describeState('user-managed');
  if (!evidence || now - Date.parse(evidence.capturedAt) > EVIDENCE_STALE_MS) return describeState('unknown');
  const result = confirmed(id, intent, evidence);
  if (id === 'memoryFix2887' && result === false) {
    return describeState('blocked', { reason: 'Run npm install -g ruflo@latest so ruflo resolves @claude-flow/memory 3.0.0-alpha.22 or newer.' });
  }
  if (result === null) return describeState('unknown', { reason: evidence.errors?.[id] ?? '' });
  if (result === false) return describeState('applied-unverified');
  if (KEY_OF[id] && projection?.missingHosts?.length) return describeState('partial', { hosts: projection.missingHosts });
  return describeState('active');
}

export function classifyComponent(component, ctx) {
  const intent = managedIntent(ctx.cfg, component.id);
  return {
    id: component.id, label: component.label, managed: Boolean(intent),
    value: intent === true ? 'on' : intent === 'off' ? 'off' : typeof intent === 'object' && intent ? `${intent.maxCallsPerMinute} calls/min, audit on` : intent || 'not managed',
    state: stateFor(component, ctx), explain: component.explain, options: component.options ?? null,
    evidence: evidenceLines(component.id, ctx.evidence),
  };
}

export function componentSnapshot({ cfg, rufloVersion, evidence, projection, now = Date.now() }) {
  const components = COMPONENTS.map((c) => classifyComponent(c, { cfg, rufloVersion, evidence, projection, now }));
  return { rufloVersion, capturedAt: evidence?.capturedAt ?? null, components,
    summary: { active: components.filter((c) => c.state.id === 'active').length, total: components.length } };
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/kit/ruflo-components-snapshot.test.mjs`
Expected: PASS. If `pnpm run lint:cc` flags `confirmed` or `evidenceLines` over complexity 50,
split each `switch` into a lookup table of per-id functions.

- [ ] **Step 5: Commit (only if authorized)**

```bash
git add src/lib/ruflo-components/snapshot.mjs tests/kit/ruflo-components-snapshot.test.mjs
git commit -m "feat(ruflo-components): snapshot and state classification with meanings"
```

---

### Task 8: Apply actions — typesafe package, funnel, reconcile

**Files:**

- Create: `src/lib/ruflo-components/apply.mjs`
- Test: `tests/kit/ruflo-components-apply.test.mjs`

**Interfaces:**

- Consumes: `globalInstallArgs(spec)` (`npm-global-install.mjs`); `run`; `managedIntent`, `supports`; `reconcilePolicy` (Task 2); `reconcileClaudeComponentEnv` (Task 4); `moduleVersionFromRuflo`, `parseFunnel`, `collectEvidence`, cache helpers (Task 6); `componentSnapshot` (Task 7); `installedVersion`; `paths.repoRoot`.
- Produces:
  - `ensureTypesafePackage(cfg, { runner }) → { ok, changed, detail }` — records `cfg.integrations.ownership.rufloComponents.typesafePackage = { owner: 'agentic-kit', package: '@ruvector/typesafe', version }`
  - `removeTypesafePackage(cfg, { runner }) → { ok, detail }` — receipt-gated
  - `ensureFunnel(cfg, { runner }) → { ok, changed, detail }` — records `…rufloComponents.funnelDisabled = true`
  - `releaseFunnel(cfg, { runner })`
  - `reconcileRufloComponents(cfg, { cwd, dryRun, runner, userSettingsFile, evidenceFile, refresh }) → { ok, changed, results: Array<{ id, ok, detail }>, snapshot }`
  - `rufloComponentsEvidenceFile() → path` under `paths.maintenanceControlDir()`'s parent state dir: `path.join(stateBase, 'agentic-kit', 'ruflo-components-evidence.json')` — use the same base `maintenanceControlDir()` uses

- [ ] **Step 1: Write the failing tests**

```js
// tests/kit/ruflo-components-apply.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureTypesafePackage, removeTypesafePackage, ensureFunnel, releaseFunnel }
  from '../../src/lib/ruflo-components/apply.mjs';

const cfg = () => ({ integrations: { ownership: {} }, rufloComponents: { typesafePicker: true, funnel: false } });
function recorder(responses) {
  const calls = [];
  const runner = async (cmd, args) => { calls.push([cmd, ...args].join(' ')); return responses(cmd, args) ?? { code: 0, stdout: '', stderr: '' }; };
  return { calls, runner };
}

test('typesafe installs globally with the reviewed policy and records a receipt', async () => {
  const c = cfg();
  const { calls, runner } = recorder(() => null);
  const result = await ensureTypesafePackage(c, { runner, resolveVersion: () => '0.1.0', rufloVersion: '3.44.0' });
  assert.equal(result.ok, true);
  assert.match(calls[0], /^npm install -g .*--allow-scripts=.* @ruvector\/typesafe$/);
  assert.deepEqual(c.integrations.ownership.rufloComponents.typesafePackage,
    { owner: 'agentic-kit', package: '@ruvector/typesafe', version: '0.1.0' });
});

test('typesafe install is skipped when already resolvable and never on old ruflo', async () => {
  const { calls, runner } = recorder(() => null);
  assert.equal((await ensureTypesafePackage(cfg(), { runner, resolveVersion: () => '0.1.0', rufloVersion: '3.44.0', preinstalled: true })).changed, false);
  assert.equal((await ensureTypesafePackage(cfg(), { runner, resolveVersion: () => null, rufloVersion: '3.42.0' })).ok, true);
  assert.equal(calls.length, 0);
});

test('install that does not resolve from ruflo afterwards is blocked', async () => {
  const { runner } = recorder(() => null);
  const result = await ensureTypesafePackage(cfg(), { runner, resolveVersion: () => null, rufloVersion: '3.44.0' });
  assert.equal(result.ok, false);
  assert.match(result.detail, /does not resolve from ruflo/);
});

test('package removal requires ak\'s receipt', async () => {
  const { calls, runner } = recorder(() => null);
  assert.match((await removeTypesafePackage(cfg(), { runner })).detail, /not installed by agentic-kit/);
  assert.equal(calls.length, 0);
});

test('funnel disable is recorded and release re-enables only what ak disabled', async () => {
  const c = cfg();
  const { calls, runner } = recorder((cmd, args) => (args[1] === 'status'
    ? { code: 0, stdout: calls.some((x) => x.endsWith('funnel disable')) ? 'Funnel: disabled (decided by: user)' : 'Funnel: enabled (decided by: package-default)', stderr: '' }
    : null));
  assert.equal((await ensureFunnel(c, { runner })).changed, true);
  assert.equal(c.integrations.ownership.rufloComponents.funnelDisabled, true);
  await releaseFunnel(c, { runner });
  assert.ok(calls.includes('ruflo funnel enable'));
});

test('funnel already disabled by the user is not recorded as ak-owned', async () => {
  const c = cfg();
  const { calls, runner } = recorder((cmd, args) => (args[1] === 'status' ? { code: 0, stdout: 'Funnel: disabled (decided by: user)', stderr: '' } : null));
  assert.equal((await ensureFunnel(c, { runner })).changed, false);
  assert.equal(c.integrations.ownership.rufloComponents?.funnelDisabled, undefined);
  await releaseFunnel(c, { runner });
  assert.equal(calls.includes('ruflo funnel enable'), false);
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `node --test tests/kit/ruflo-components-apply.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// src/lib/ruflo-components/apply.mjs
import path from 'node:path';
import { run } from '../exec.mjs';
import * as paths from '../paths.mjs';
import { installedVersion } from '../versions.mjs';
import { globalInstallArgs } from '../npm-global-install.mjs';
import { reconcileClaudeComponentEnv } from '../claude-env-projection.mjs';
import { managedIntent } from './config.mjs';
import { supports } from './env.mjs';
import { reconcilePolicy, readPolicy } from './policy.mjs';
import { moduleVersionFromRuflo, parseFunnel, collectEvidence, readEvidenceCache, writeEvidenceCache, EVIDENCE_TTL_MS } from './evidence.mjs';
import { componentSnapshot } from './snapshot.mjs';

const TYPESAFE = '@ruvector/typesafe';
const owned = (cfg) => {
  cfg.integrations ??= {};
  cfg.integrations.ownership ??= {};
  cfg.integrations.ownership.rufloComponents ??= {};
  return cfg.integrations.ownership.rufloComponents;
};
export const rufloComponentsEvidenceFile = () => path.join(path.dirname(paths.maintenanceControlDir()), 'ruflo-components-evidence.json');

export async function ensureTypesafePackage(cfg, {
  runner = run, rufloVersion = installedVersion('ruflo'), resolveVersion = () => moduleVersionFromRuflo(TYPESAFE), preinstalled,
} = {}) {
  if (!managedIntent(cfg, 'typesafePicker') || !supports(rufloVersion, '3.43.0')) return { ok: true, changed: false, detail: 'not required' };
  if (preinstalled ?? resolveVersion() !== null) return { ok: true, changed: false, detail: `${TYPESAFE} present` };
  const r = await runner('npm', globalInstallArgs(TYPESAFE), { timeout: 600_000 });
  if (r.code !== 0) return { ok: false, changed: false, detail: `npm install failed: ${(r.stderr || r.stdout).trim().slice(0, 160)}` };
  const version = resolveVersion();
  if (!version) return { ok: false, changed: true, detail: `${TYPESAFE} installed but does not resolve from ruflo's module tree` };
  owned(cfg).typesafePackage = { owner: 'agentic-kit', package: TYPESAFE, version };
  return { ok: true, changed: true, detail: `installed ${TYPESAFE}@${version}` };
}

export async function removeTypesafePackage(cfg, { runner = run } = {}) {
  const receipt = cfg?.integrations?.ownership?.rufloComponents?.typesafePackage;
  if (receipt?.owner !== 'agentic-kit') return { ok: true, detail: `${TYPESAFE} not installed by agentic-kit; kept` };
  const r = await runner('npm', ['uninstall', '-g', TYPESAFE], { timeout: 300_000 });
  if (r.code !== 0) return { ok: false, detail: `npm uninstall failed: ${(r.stderr || r.stdout).trim().slice(0, 160)}` };
  delete owned(cfg).typesafePackage;
  return { ok: true, detail: `removed ${TYPESAFE}` };
}

async function funnelStatus(runner) {
  const r = await runner('ruflo', ['funnel', 'status'], { timeout: 60_000 });
  return r.code === 0 ? parseFunnel(r.stdout) : null;
}

export async function ensureFunnel(cfg, { runner = run } = {}) {
  if (managedIntent(cfg, 'funnel') !== 'off') return { ok: true, changed: false, detail: 'funnel not managed' };
  const before = await funnelStatus(runner);
  if (!before) return { ok: false, changed: false, detail: 'ruflo funnel status unreadable' };
  if (!before.enabled) return { ok: true, changed: false, detail: `funnel already disabled (${before.decidedBy})` };
  const r = await runner('ruflo', ['funnel', 'disable'], { timeout: 60_000 });
  const after = await funnelStatus(runner);
  if (r.code !== 0 || after?.enabled !== false) return { ok: false, changed: false, detail: 'ruflo funnel disable did not take effect' };
  owned(cfg).funnelDisabled = true;
  return { ok: true, changed: true, detail: 'funnel disabled' };
}

export async function releaseFunnel(cfg, { runner = run } = {}) {
  if (!cfg?.integrations?.ownership?.rufloComponents?.funnelDisabled) return { ok: true, detail: 'funnel not changed by agentic-kit' };
  const status = await funnelStatus(runner);
  if (status && !status.enabled && /user/i.test(status.decidedBy)) await runner('ruflo', ['funnel', 'enable'], { timeout: 60_000 });
  delete owned(cfg).funnelDisabled;
  return { ok: true, detail: 'funnel returned to ruflo\'s default' };
}

export async function reconcileRufloComponents(cfg, {
  cwd = process.cwd(), dryRun = false, runner = run, userSettingsFile, evidenceFile = rufloComponentsEvidenceFile(), refresh = true, now = Date.now(),
  rufloVersion = installedVersion('ruflo'),
} = {}) {
  const projectRoot = paths.repoRoot(cwd);
  const results = [];
  const blocked = {};
  if (!dryRun) {
    const pkg = await ensureTypesafePackage(cfg, { runner, rufloVersion });
    results.push({ id: 'typesafePicker', ...pkg }); if (!pkg.ok) blocked.typesafePicker = pkg.detail;
    const fun = await ensureFunnel(cfg, { runner });
    results.push({ id: 'funnel', ...fun }); if (!fun.ok) blocked.funnel = fun.detail;
  }
  let policy = null;
  if (projectRoot && supports(rufloVersion, '3.42.0')) {
    const receipts = (owned(cfg).policies ??= {});
    const p = reconcilePolicy(projectRoot, managedIntent(cfg, 'mcpGovernance'), receipts, { dryRun });
    results.push({ id: 'mcpGovernance', ok: true, changed: p.changed, detail: `policy ${p.status}` });
    policy = readPolicy(projectRoot).state;
  }
  const claude = reconcileClaudeComponentEnv(cfg, { projectRoot, rufloVersion, userSettingsFile, dryRun });
  results.push({ id: 'claude-env', ok: claude.ok, changed: claude.changed, detail: claude.findings.map((f) => `${f.file}: ${f.status}${f.reason ? ` (${f.reason})` : ''}`).join('; ') });
  const cached = readEvidenceCache(evidenceFile);
  const fresh = cached && cached.rufloVersion === rufloVersion && now - Date.parse(cached.capturedAt) < EVIDENCE_TTL_MS;
  let evidence = cached;
  if (refresh && !dryRun && (!fresh || results.some((r) => r.changed))) {
    evidence = await collectEvidence({ projectRoot, cfg, rufloVersion, runner, now, cwd });
    writeEvidenceCache(evidenceFile, evidence);
  }
  const conflicts = claude.findings.filter((f) => f.status === 'conflict').map((f) => (f.reason ?? '').split(':')[0]);
  const snapshot = componentSnapshot({ cfg, rufloVersion, evidence, now,
    projection: { claude: { conflicts, changed: claude.changed }, missingHosts: [], policy, blocked } });
  return { ok: results.every((r) => r.ok), changed: results.some((r) => r.changed), results, snapshot };
}
```

`missingHosts` stays empty unless Task 0 recorded an unreachable host; if it did, fill it here
from the recorded list when that host is enabled in `cfg.integrations.hosts`
(e.g. `cfg.integrations.hosts.codex ? ['Codex hooks'] : []`).

`paths.maintenanceControlDir()` returns `<stateBase>/agentic-kit/maintenance`; its parent is the
agentic-kit state directory, so the evidence file lives beside it.

- [ ] **Step 4: Run the tests**

Run: `node --test tests/kit/ruflo-components-apply.test.mjs`
Expected: PASS.

- [ ] **Step 5: Add a hermetic reconcile test**

```js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reconcileRufloComponents } from '../../src/lib/ruflo-components/apply.mjs';

const fx = (name) => fs.readFileSync(new URL(`../fixtures/ruflo-components/${name}`, import.meta.url), 'utf8');
const fullCfg = () => ({ integrations: { hosts: { claude: true }, ownership: {} }, rufloComponents: { typesafePicker: false,
  minilmPicker: true, mcpGovernance: { maxCallsPerMinute: 120 }, learningProfile: 'balanced', turnCredit: true, memoryFix2887: true, funnel: true } });
const fakeRuflo = async (cmd, args) => {
  const a = args.join(' ');
  if (a.startsWith('doctor --component typesafe')) return { code: 0, stdout: fx('doctor-typesafe-3.43.0.txt'), stderr: '' };
  if (a.startsWith('doctor --component metaharness')) return { code: 0, stdout: fx('doctor-metaharness-3.43.0.txt'), stderr: '' };
  if (a.startsWith('hooks intelligence')) return { code: 0, stdout: fx('intelligence-stats-3.43.0.txt'), stderr: '' };
  if (a.startsWith('neural status')) return { code: 0, stdout: fx('neural-status-3.43.0.txt'), stderr: '' };
  if (a.startsWith('hooks route')) return { code: 0, stdout: 'routed embedder=minilm', stderr: '' };
  if (a.startsWith('funnel status')) return { code: 0, stdout: fx('funnel-status-3.43.0.txt'), stderr: '' };
  return { code: 0, stdout: '', stderr: '' };
};

test('reconcile: dry run writes nothing; real run writes policy and env and classifies', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-rc-reconcile-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'proj'); fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  const opts = { cwd: root, runner: fakeRuflo, rufloVersion: '3.44.0',
    userSettingsFile: path.join(tmp, 'home', 'settings.json'), evidenceFile: path.join(tmp, 'state', 'evidence.json') };
  const before = fs.readdirSync(root);
  const dry = await reconcileRufloComponents(fullCfg(), { ...opts, dryRun: true });
  assert.equal(dry.changed, true);
  assert.deepEqual(fs.readdirSync(root), before);
  assert.equal(fs.existsSync(opts.userSettingsFile), false);
  const cfg = fullCfg();
  const real = await reconcileRufloComponents(cfg, opts);
  assert.ok(fs.existsSync(path.join(root, '.harness', 'mcp-policy.json')));
  assert.equal(JSON.parse(fs.readFileSync(opts.userSettingsFile, 'utf8')).env.CLAUDE_FLOW_ROUTER_EMBEDDER, 'minilm');
  const byId = (id) => real.snapshot.components.find((c) => c.id === id);
  assert.equal(byId('minilmPicker').state.id, 'active');
  assert.notEqual(byId('mcpGovernance').state.id, 'blocked');
  assert.equal(byId('typesafePicker').state.id, 'user-managed');
});
```

- [ ] **Step 6: Commit (only if authorized)**

```bash
git add src/lib/ruflo-components/apply.mjs tests/kit/ruflo-components-apply.test.mjs
git commit -m "feat(ruflo-components): typesafe install, funnel control and reconcile"
```

---

### Task 9: Status section, sync step, setup disclosure and results, uninstall

**Files:**

- Create: `src/commands/status/sections/ruflo-components.mjs`
- Modify: `src/commands/status/sections/index.mjs` (register after `ruvector`)
- Modify: `src/commands/sync.mjs` (`SYNC_STEPS` entry)
- Modify: `src/lib/trust-manifest.mjs` (`setupTrustManifest` group)
- Modify: `src/commands/setup.mjs` (`run_machine` after ruflo install; `run_project` after `pinProjectMemoryDbPath`; results table; restart reminder)
- Modify: `src/commands/uninstall.mjs` (`UNINSTALL_STEPS` entry before `mcp`)
- Modify: `src/commands/status.mjs` if needed to pass `--refresh`
- Test: `tests/kit/ruflo-components-status.test.mjs`

**Interfaces:**

- Consumes: `reconcileRufloComponents`, `releaseFunnel`, `removeTypesafePackage` (Task 8); `componentSnapshot` (Task 7); evidence cache (Task 6); `row()`; `reconcileClaudeComponentEnv`, `reconcileMemoryPin` (Task 4).
- Produces:
  - `rufloComponentRows(snapshot) → Row[]` — first row is the summary `ruflo components: N of M active (ruflo X)`; one row per component `"<label> — <state label>: <meaning> <action>"`; level `ok` for active and user-managed, `info` for unknown, `warn` otherwise; `fix` only for states `not-applied`, `drifted`, `needs-ruflo`, `blocked`
  - `rufloComponentsTrustGroup(cfg) → TrustGroup`
  - `formatComponentResults(snapshot) → string[]`

- [ ] **Step 1: Write the failing tests**

```js
// tests/kit/ruflo-components-status.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rufloComponentRows, formatComponentResults } from '../../src/commands/status/sections/ruflo-components.mjs';
import { rufloComponentsTrustGroup } from '../../src/lib/trust-manifest.mjs';
import { trustManifestLines } from '../../src/lib/trust-manifest.mjs';

const view = (id, label, stateId, stateLabel, meaning, action = '') => ({ id, label, state: { id: stateId, label: stateLabel, meaning, action } });
const snapshot = { rufloVersion: '3.44.0', summary: { active: 1, total: 3 }, components: [
  view('typesafePicker', 'Typesafe agent picker', 'active', 'active', 'Applied and confirmed by ruflo\'s own evidence.'),
  view('minilmPicker', 'MiniLM agent picker', 'needs-ruflo', 'needs ruflo ≥ 3.44.0', 'The installed ruflo is too old for this component.', 'Run ak sync to upgrade ruflo.'),
  view('learningProfile', 'Learning profile', 'user-managed', 'user-managed', 'You set your own value or opted out; ak reports it and leaves it alone.'),
] };

test('rows lead with a summary and always carry the meaning', () => {
  const rows = rufloComponentRows(snapshot);
  assert.equal(rows[0].message, 'ruflo components: 1 of 3 active (ruflo 3.44.0)');
  assert.ok(rows.every((r) => r.subsystem === 'ruflo-components'));
  assert.match(rows[2].message, /MiniLM agent picker — needs ruflo ≥ 3\.44\.0: The installed ruflo is too old/);
  assert.equal(rows[2].level, 'warn');
  assert.match(rows[2].fix, /ak sync/);
  assert.equal(rows[3].level, 'ok');
  assert.equal(rows[3].fix, null);
});

test('setup results table lists state and meaning per component', () => {
  const lines = formatComponentResults(snapshot);
  assert.ok(lines.some((l) => /Learning profile.*user-managed.*leaves it alone/.test(l)));
});

test('trust group discloses every managed change with benefit, cost and opt-out', () => {
  const group = rufloComponentsTrustGroup({ rufloComponents: { typesafePicker: true, minilmPicker: true,
    mcpGovernance: { maxCallsPerMinute: 120 }, learningProfile: 'balanced', turnCredit: true, memoryFix2887: true, funnel: false } });
  const text = trustManifestLines([group]).join('\n');
  for (const needle of ['@ruvector/typesafe', 'CLAUDE_FLOW_ROUTER_TYPESAFE=1', 'CLAUDE_FLOW_ROUTER_EMBEDDER=minilm',
    '.harness/mcp-policy.json', 'RUFLO_INTELLIGENCE_MODE=balanced', 'ruflo funnel disable', 'rufloComponents']) {
    assert.ok(text.includes(needle), needle);
  }
});

test('trust group omits opted-out components', () => {
  const group = rufloComponentsTrustGroup({ rufloComponents: { typesafePicker: false, minilmPicker: false, mcpGovernance: false,
    learningProfile: false, turnCredit: false, memoryFix2887: false, funnel: true } });
  assert.equal(group, null);
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `node --test tests/kit/ruflo-components-status.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Status section**

```js
// src/commands/status/sections/ruflo-components.mjs
// ADR-0058 §7: every row carries state + meaning + action. Evidence comes from the cache;
// `ak status --refresh` re-probes.
import { installedVersion } from '../../../lib/versions.mjs';
import { row } from '../row.mjs';
import * as paths from '../../../lib/paths.mjs';
import { componentSnapshot } from '../../../lib/ruflo-components/snapshot.mjs';
import { readEvidenceCache, collectEvidence, writeEvidenceCache } from '../../../lib/ruflo-components/evidence.mjs';
import { readPolicy } from '../../../lib/ruflo-components/policy.mjs';
import { reconcileClaudeComponentEnv } from '../../../lib/claude-env-projection.mjs';
import { rufloComponentsEvidenceFile } from '../../../lib/ruflo-components/apply.mjs';

const FIXABLE = new Set(['not-applied', 'drifted', 'needs-ruflo', 'blocked']);
const LEVEL = (id) => (id === 'active' || id === 'user-managed' ? 'ok' : id === 'unknown' ? 'info' : 'warn');

export function rufloComponentRows(snapshot) {
  const rows = [row('ruflo-components', snapshot.summary.active === snapshot.summary.total ? 'ok' : 'info',
    `ruflo components: ${snapshot.summary.active} of ${snapshot.summary.total} active (ruflo ${snapshot.rufloVersion ?? 'not installed'})`)];
  for (const c of snapshot.components) {
    const text = `${c.label} — ${c.state.label}: ${c.state.meaning}${c.state.action ? ` ${c.state.action}` : ''}`;
    rows.push(row('ruflo-components', LEVEL(c.state.id), text,
      FIXABLE.has(c.state.id) ? `sync applies ${c.label} (${c.state.action || 'reconcile'})` : null));
  }
  return rows;
}

export function formatComponentResults(snapshot) {
  return snapshot.components.map((c) => `  ${c.label.padEnd(30)} ${c.state.label.padEnd(24)} ${c.state.meaning}`);
}

export default {
  id: 'ruflo-components',
  async collect({ cfg, cwd, refresh = false }) {
    const rufloVersion = installedVersion('ruflo');
    if (!rufloVersion) return [row('ruflo-components', 'info', 'ruflo components: ruflo not installed; nothing managed')];
    const projectRoot = paths.repoRoot(cwd);
    let evidence = readEvidenceCache(rufloComponentsEvidenceFile());
    if (refresh) { evidence = await collectEvidence({ projectRoot, cfg, rufloVersion, cwd }); writeEvidenceCache(rufloComponentsEvidenceFile(), evidence); }
    const claude = reconcileClaudeComponentEnv(cfg, { projectRoot, rufloVersion, dryRun: true });
    const conflicts = claude.findings.filter((f) => f.status === 'conflict').map((f) => (f.reason ?? '').split(':')[0]);
    const snapshot = componentSnapshot({ cfg, rufloVersion, evidence,
      projection: { claude: { conflicts, changed: claude.changed }, missingHosts: [], policy: projectRoot ? readPolicy(projectRoot).state : null } });
    return rufloComponentRows(snapshot);
  },
};
```

Register it in `sections/index.mjs`: `import rufloComponents from './ruflo-components.mjs';` and
add `rufloComponents` right after `ruvector` in `SECTIONS_BEFORE_HOST_DETAIL`.

Thread `refresh` through: in `src/commands/status.mjs`'s `collect`, accept
`refresh = false` and put it on `ctx` (`const ctx = { cfg, cwd, pkgRoot, integrationFacts, refresh };`);
in `run({ flags })` pass `refresh: !!flags.refresh`; add `refresh: { type: 'boolean' }` to the
status command's option list and one help line: `--refresh   re-probe ruflo component evidence`.

- [ ] **Step 4: Trust group**

In `src/lib/trust-manifest.mjs`:

```js
import { managedIntent } from './ruflo-components/config.mjs';

export function rufloComponentsTrustGroup(cfg) {
  const change = (id, kind, scope, value, effect) => ({ id, kind, scope, owner: 'agentic-kit', value, effect });
  const changes = [];
  if (managedIntent(cfg, 'typesafePicker')) {
    changes.push(change('rc-typesafe-package', 'npm-package', 'global', '@ruvector/typesafe',
      'semantic agent picker library; ruflo ≥ 3.43.0 only'));
    changes.push(change('rc-typesafe-env', 'env', 'user', 'CLAUDE_FLOW_ROUTER_TYPESAFE=1', 'route agents by meaning; falls back when unsure'));
  }
  if (managedIntent(cfg, 'minilmPicker')) changes.push(change('rc-minilm-env', 'env', 'user', 'CLAUDE_FLOW_ROUTER_EMBEDDER=minilm', 'MiniLM routing; ~5 ms per prompt; ruflo ≥ 3.44.0'));
  const gov = managedIntent(cfg, 'mcpGovernance');
  if (gov) {
    changes.push(change('rc-governance-file', 'project-file', 'project', '.harness/mcp-policy.json', `audit every ruflo MCP call; cap ${gov.maxCallsPerMinute} calls per minute`));
    changes.push(change('rc-governance-env', 'env', 'project', 'RUFLO_MCP_ENFORCE_POLICY=1', 'only where the policy file is valid'));
  }
  const profile = managedIntent(cfg, 'learningProfile');
  if (profile) changes.push(change('rc-learning-env', 'env', 'user', `RUFLO_INTELLIGENCE_MODE=${profile}`, 'explicit learning profile'));
  if (managedIntent(cfg, 'funnel') === 'off') changes.push(change('rc-funnel', 'cli-state', 'user', 'ruflo funnel disable', 'no promotional tips or statusline promos'));
  if (!changes.length) return null;
  changes.push(change('rc-opt-out', 'config', 'user', 'kit.json → rufloComponents', 'set any component to false to leave it alone'));
  return { componentId: 'ruflo-components', label: 'Managed ruflo components (ADR-0058)', approvalPolicy: 'managed', changes };
}
```

In `setupTrustManifest`, after the agent-browser group:

```js
    ...[rufloComponentsTrustGroup(cfg)].filter(Boolean),
```

- [ ] **Step 5: Setup**

In `src/commands/setup.mjs`:

1. Import `reconcileRufloComponents` from `../lib/ruflo-components/apply.mjs` and
   `formatComponentResults` from `./status/sections/ruflo-components.mjs`.
2. At the end of `run_machine`, after ruflo is installed (and after `saveKitConfig` of other
   receipts), run with no project:

```js
  const components = await reconcileRufloComponents(cfg, { cwd: paths.home, refresh: false });
  for (const r of components.results) (r.ok ? ok : warn)(`ruflo components: ${r.id} — ${r.detail}`);
  saveKitConfig(cfg);
```

   `paths.home` is not inside a repository, so only machine-scope changes happen.
3. In `run_project`, after `pinProjectMemoryDbPath(root);`:

```js
  const components = await reconcileRufloComponents(cfg, { cwd: root, refresh: true });
  heading('ruflo components');
  for (const line of formatComponentResults(components.snapshot)) console.log(line);
  if (components.changed) info('Restart Claude Code, Codex and OpenCode so the new ruflo component settings take effect.');
  saveKitConfig(cfg);
```

1. Update the `run_project` dry-run message to include "apply managed ruflo components".

- [ ] **Step 6: Sync**

In `src/commands/sync.mjs`, add to `SYNC_STEPS` immediately **after the `versions` step** (it
must run after ruflo is upgraded, so a `needs ruflo ≥ X` component can apply in the same sync):

```js
  {
    id: 'ruflo-components',
    when: (subs) => subs.has('ruflo-components'),
    run: async (ctx) => {
      const result = await ctx.step('ruflo components', () => reconcileRufloComponents(ctx.cfg, { cwd: ctx.cwd, refresh: true }));
      saveKitConfig(ctx.cfg);
      if (result?.changed) info('Restart Claude Code, Codex and OpenCode so the new ruflo component settings take effect.');
      return result;
    },
  },
```

Check how `ctx.step` reports the returned value; if it expects `{ ok, detail }`, return:

```js
{ ok: result.ok, detail: result.results.map((r) => `${r.id}: ${r.detail}`).join('; ') }
```

- [ ] **Step 7: Uninstall**

In `src/commands/uninstall.mjs`, add before `{ id: 'mcp', … }`:

```js
  { id: 'ruflo-components', when: () => true, run: async (ctx) => {
    if (ctx.dry) { info('[dry-run] remove ak-owned ruflo component settings, policy files and funnel change; keep @ruvector/typesafe unless --purge'); return; }
    const off = { ...ctx.cfg, rufloComponents: { typesafePicker: false, minilmPicker: false, mcpGovernance: false,
      learningProfile: false, turnCredit: false, memoryFix2887: false, funnel: true } };
    const env = reconcileClaudeComponentEnv(off, { projectRoot: paths.repoRoot(process.cwd()), rufloVersion: installedVersion('ruflo') });
    (env.ok ? ok : warn)(`ruflo component env: ${env.changed ? 'removed' : 'nothing owned'}`);
    const receipts = ctx.cfg.integrations?.ownership?.rufloComponents?.policies ?? {};
    for (const root of Object.keys(receipts)) {
      const r = reconcilePolicy(root, false, receipts);
      info(`policy ${root}: ${r.status}`);
    }
    const pin = reconcileMemoryPin(process.cwd(), { enabled: false });
    if (pin.changed) ok('CLAUDE_FLOW_DB_PATH pin removed');
    (await releaseFunnel(ctx.cfg)).ok && info('funnel returned to ruflo\'s default');
    if (ctx.flags.purge) {
      const pkg = await removeTypesafePackage(ctx.cfg);
      (pkg.ok ? ok : warn)(`typesafe: ${pkg.detail}`);
    }
    saveKitConfig(ctx.cfg);
  } },
```

`reconcileMemoryPin` needs a repository root; wrap in `if (paths.repoRoot(process.cwd()))` and
pass that root. Add the imports.

- [ ] **Step 8: Run the suites**

Run: `node --test tests/kit/ruflo-components-status.test.mjs tests/kit/status*.test.mjs tests/kit/sync*.test.mjs tests/kit/setup*.test.mjs tests/kit/uninstall*.test.mjs tests/kit/trust*.test.mjs`
Expected: PASS. Fix any existing test that snapshots the full status section list or trust
manifest by adding the new entries, not by weakening assertions.

- [ ] **Step 9: Commit (only if authorized)**

```bash
git add src/commands src/lib/trust-manifest.mjs tests/kit
git commit -m "feat(ruflo-components): status, sync, setup disclosure and uninstall"
```

---

### Task 10: Dashboard panel and About chip

**Files:**

- Modify: `src/lib/dashboard-server.mjs` (route `/api/ruflo-components`)
- Create: `src/lib/dashboard/client/ruflo-components.mjs`
- Modify: `src/lib/dashboard/client.mjs` (bundle the new split file)
- Modify: `src/lib/dashboard/page.mjs` (container inside `panel-runtime`)
- Modify: `src/lib/dashboard/client/boot.mjs` (fetch on runtime view show)
- Modify: `src/lib/dashboard/client/about.mjs` (`ABOUT_JOIN.ruflo` gains `subs:["ruflo-components"]`; link to the panel)
- Modify: `src/lib/dashboard/styles/*.mjs` (panel styles, reusing tokens)
- Test: `tests/kit/dashboard-ruflo-components.test.mjs`

**Interfaces:**

- Consumes: `componentSnapshot` (Task 7), evidence cache (Task 6), `reconcileClaudeComponentEnv` dry-run, `readPolicy`.
- Produces:
  - `GET /api/ruflo-components` → `{ rufloVersion, capturedAt, components: ComponentView[], summary }` (read-only; cache only; never probes)
  - `renderRufloComponents(payload)` in the client bundle

- [ ] **Step 1: Write the failing tests**

```js
// tests/kit/dashboard-ruflo-components.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JS } from '../../src/lib/dashboard/client.mjs';

const src = fs.readFileSync(new URL('../../src/lib/dashboard/client/ruflo-components.mjs', import.meta.url), 'utf8');

test('bundle includes the ruflo components renderer', () => {
  assert.match(JS, /function renderRufloComponents\(/);
});

test('each card renders the state label beside its meaning, never alone', () => {
  assert.match(src, /state\.label/);
  assert.match(src, /state\.meaning/);
  assert.match(src, /rc-meaning/);
});

test('renderer escapes every server string', () => {
  for (const field of ['c.label', 'c.state.label', 'c.state.meaning', 'c.value', 'e.detail', 'o.detail']) {
    assert.ok(src.includes(`esc(${field})`), field);
  }
});

test('dashboard stays read-only: no POST from the panel', () => {
  assert.doesNotMatch(src, /method:\s*["']POST/);
});
```

The route's logic lives in a pure function so it can be tested without starting the server.
Add to `src/lib/ruflo-components/snapshot.mjs`:

```js
import { readEvidenceCache } from './evidence.mjs';
import { readPolicy } from './policy.mjs';
import { reconcileClaudeComponentEnv } from '../claude-env-projection.mjs';

/** Read-only dashboard/status payload: cache + dry-run projection; never probes ruflo. */
export function rufloComponentsPayload({ cfg, rufloVersion, projectRoot, evidenceFile, userSettingsFile, now = Date.now() }) {
  const claude = reconcileClaudeComponentEnv(cfg, { projectRoot, rufloVersion, userSettingsFile, dryRun: true });
  const conflicts = claude.findings.filter((f) => f.status === 'conflict').map((f) => (f.reason ?? '').split(':')[0]);
  return componentSnapshot({ cfg, rufloVersion, evidence: readEvidenceCache(evidenceFile), now,
    projection: { claude: { conflicts, changed: claude.changed }, missingHosts: [], policy: projectRoot ? readPolicy(projectRoot).state : null } });
}
```

and test it:

```js
import os from 'node:os';
import path from 'node:path';
import { rufloComponentsPayload } from '../../src/lib/ruflo-components/snapshot.mjs';

test('dashboard payload has eight components and writes nothing', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-rc-dash-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const payload = rufloComponentsPayload({ cfg: { rufloComponents: {} }, rufloVersion: '3.44.0', projectRoot: null,
    evidenceFile: path.join(tmp, 'missing.json'), userSettingsFile: path.join(tmp, 'settings.json') });
  assert.equal(payload.components.length, 8);
  assert.equal(payload.components.find((c) => c.id === 'typesafePicker').state.id, 'unknown');
  assert.deepEqual(fs.readdirSync(tmp), []);
});

test('server registers the route', () => {
  assert.match(fs.readFileSync(new URL('../../src/lib/dashboard-server.mjs', import.meta.url), 'utf8'),
    /'\/api\/ruflo-components': handleRufloComponents/);
});
```

Use `rufloComponentsPayload` in both the server route (Step 3) and the status section (Task 9
Step 3) instead of repeating the dry-run projection code there.

- [ ] **Step 2: Run to confirm it fails**

Run: `node --test tests/kit/dashboard-ruflo-components.test.mjs`
Expected: FAIL — file not found.

- [ ] **Step 3: Server route**

In `dashboard-server.mjs`, next to `handleModels`:

```js
    async function handleRufloComponents(_req, res) {
      try {
        const [{ componentSnapshot }, { readEvidenceCache }, { rufloComponentsEvidenceFile }, { readPolicy }, { reconcileClaudeComponentEnv }] = await Promise.all([
          import('./ruflo-components/snapshot.mjs'), import('./ruflo-components/evidence.mjs'),
          import('./ruflo-components/apply.mjs'), import('./ruflo-components/policy.mjs'), import('./claude-env-projection.mjs')]);
        const cfg = loadKitConfig();
        const rufloVersion = installedVersion('ruflo');
        const projectRoot = repoRoot(cwd);
        const claude = reconcileClaudeComponentEnv(cfg, { projectRoot, rufloVersion, dryRun: true });
        sendJson(res, 200, componentSnapshot({ cfg, rufloVersion, evidence: readEvidenceCache(rufloComponentsEvidenceFile()),
          projection: { claude: { conflicts: claude.findings.filter((f) => f.status === 'conflict').map((f) => (f.reason ?? '').split(':')[0]), changed: claude.changed },
            missingHosts: [], policy: projectRoot ? readPolicy(projectRoot).state : null } }));
      } catch (e) { serverFault(res, '/api/ruflo-components', e, 'ruflo components unavailable'); }
    }
```

Register `'/api/ruflo-components': handleRufloComponents,` in the routes map. Import
`installedVersion` and `repoRoot` if not already imported; use the server's existing `cwd`
variable name (check the enclosing function's parameters).

- [ ] **Step 4: Client renderer**

```js
// src/lib/dashboard/client/ruflo-components.mjs
// @ts-nocheck — browser bundle source (never node-imported; client.mjs reads it as text).
import { esc } from './bootstrap.mjs';
import { formatLocalDateTimeLong } from './datetime.mjs';

  var RC_LEVEL={active:"ok","user-managed":"ok",unknown:"unknown","applied-unverified":"warn","needs-ruflo":"warn","not-applied":"warn",drifted:"warn",partial:"warn",blocked:"fail"};

  function rcCard(c){
    var options=c.options?'<ul class="rc-options">'+c.options.map(function(o){
      return '<li'+(o.value===c.value?' class="rc-current"':'')+'><b>'+esc(o.value)+'</b> — '+esc(o.detail)+'</li>';}).join("")+"</ul>":"";
    var evidence=c.evidence.length?c.evidence.map(function(e){
      return '<div class="rc-evidence"><b>'+esc(e.source)+'</b> · '+esc(formatLocalDateTimeLong(e.capturedAt)||"time unknown")+'<br>'+esc(e.detail)+'</div>';}).join("")
      :'<div class="rc-evidence">No evidence collected yet — run <code>ak status --refresh</code>.</div>';
    return '<article class="rc-card" data-level="'+esc(RC_LEVEL[c.state.id]||"unknown")+'">'
      +'<header><h3>'+esc(c.label)+'</h3><span class="rc-badge"><span class="dot" data-level="'+esc(RC_LEVEL[c.state.id]||"unknown")+'"></span>'+esc(c.state.label)+'</span></header>'
      +'<p class="rc-meaning">'+esc(c.state.meaning)+(c.state.action?' <span class="rc-action">'+esc(c.state.action)+'</span>':'')+'</p>'
      +'<p class="rc-value">Value: <b>'+esc(c.value)+'</b> · controlled by '+(c.managed?"agentic-kit":"you")+'</p>'
      +'<details><summary>What it does</summary><p>'+esc(c.explain.does)+'</p><p><b>Benefit:</b> '+esc(c.explain.benefit)+'</p>'
      +'<p><b>Cost:</b> '+esc(c.explain.cost)+'</p><p><b>Change it:</b> '+esc(c.explain.change)+'</p>'+options+'</details>'
      +evidence+'</article>';
  }

  export function renderRufloComponents(payload){
    var el=document.getElementById("ruflo-components");
    if(!el)return;
    if(!payload||!Array.isArray(payload.components)){el.innerHTML='<div class="empty">ruflo components unavailable.</div>';return;}
    el.innerHTML='<header class="rc-head"><h3>ruflo components</h3><span>'+esc(payload.summary.active)+' of '+esc(payload.summary.total)
      +' active · ruflo '+esc(payload.rufloVersion||"not installed")+' · evidence '+esc(formatLocalDateTimeLong(payload.capturedAt)||"not collected")+'</span></header>'
      +'<div class="rc-grid">'+payload.components.map(rcCard).join("")+"</div>";
  }

  export function loadRufloComponents(){
    return fetch("/api/ruflo-components",{credentials:"same-origin"}).then(function(r){return r.ok?r.json():null;})
      .then(renderRufloComponents).catch(function(){renderRufloComponents(null);});
  }
```

Adjust the test in Step 1 to the exact escaped expressions used (`esc(c.value)`,
`esc(e.detail)`, `esc(o.detail)`, `esc(c.label)`, `esc(c.state.label)`, `esc(c.state.meaning)`).
If the dashboard fetch helper in `poll.mjs` adds the session header, use it instead of
`fetch` directly; read `poll.mjs` and mirror how `/api/models` is fetched.

- [ ] **Step 5: Bundle, container, boot, About**

1. `client.mjs`: `const rufloComponentsSrc = readSplit('ruflo-components.mjs');` next to
   `modelLifecycleSrc`, and include it in the concatenation list at the same position as other
   Overview modules (before `bootSrc`).
2. `page.mjs`, inside `panel-runtime` before `<div id="cards-runtime"></div>`:
   `<div id="ruflo-components" class="rc-panel" aria-live="polite"></div>`
3. `boot.mjs`: where the Overview sub-tab switch handles `data-overview-view`, call
   `loadRufloComponents()` when the view becomes `runtime`, and once at boot if the runtime
   view is the initial one.
4. `about.mjs`: change `"ruflo":{versions:"ruflo"}` to
   `"ruflo":{versions:"ruflo",subs:["ruflo-components"]}`. In the ruflo card's rendering,
   when a `ruflo-components` summary row exists, append
   `<a href="#" class="rc-link" data-go="runtime">`+esc(summaryRow.message)+`</a>` and wire
   `data-go="runtime"` to click `#overview-tab-runtime` after activating the Overview tab.
5. Styles: add `.rc-panel, .rc-grid, .rc-card, .rc-badge, .rc-meaning, .rc-action, .rc-value,
   .rc-options, .rc-current, .rc-evidence, .rc-head, .rc-link` to
   `src/lib/dashboard/styles/base.mjs` using existing tokens (`--panel`, `--line`, `--ink`,
   `--ink-dim`, `--accent`). Cards in a responsive grid
   (`grid-template-columns: repeat(auto-fill, minmax(280px, 1fr))`).

- [ ] **Step 6: Run the dashboard suites**

Run: `node --test tests/kit/dashboard-ruflo-components.test.mjs tests/kit/dashboard*.test.mjs && node tests/dashboard.test.cjs`
Expected: PASS.

- [ ] **Step 7: Browser check**

Run `node bin/agentic-kit.mjs dashboard` (check `ak dashboard --help` for the port and token
flags), open the printed URL, go to Overview → Runtime, and confirm: eight cards; each badge
sits beside a meaning sentence; the learning card lists five profiles with `balanced` marked
current; the About → ruflo card shows the summary link and it opens the Runtime view. Check
both light and dark themes. Record what was checked in the task report; if a browser cannot be
driven in this environment, say so explicitly.

- [ ] **Step 8: Commit (only if authorized)**

```bash
git add src/lib/dashboard src/lib/dashboard-server.mjs tests/kit/dashboard-ruflo-components.test.mjs
git commit -m "feat(dashboard): ruflo components panel and About summary"
```

---

### Task 11: Real-machine verification, 3.44.0 fixtures, docs, ADR status

**Files:**

- Create: `tests/fixtures/ruflo-components/route-minilm-3.44.0.txt`, `doctor-typesafe-installed-3.44.0.txt`, `funnel-status-disabled-3.44.0.txt`
- Modify: `tests/kit/ruflo-components-evidence.test.mjs` (tests over the new fixtures)
- Modify: `docs/MANAGED-TOOLS.md`, `docs/SETUP.md`, `docs/DASHBOARD.md`, `docs/TROUBLESHOOTING.md`, `README.md` (current behaviour only)
- Modify: `docs/adr/0058-managed-ruflo-components.md` (Implementation status), `docs/adr/0016-capability-driven-integration-adapters.md` (Updated note for the memory pin receipt), `CHANGELOG.md`

- [ ] **Step 1: Disposable environment**

```bash
export AKV=$(mktemp -d)
export NPM_CONFIG_PREFIX="$AKV/npm"
npm install -g ruflo@3.44.0
export PATH="$AKV/npm/bin:$PATH"
mkdir -p "$AKV/proj" && cd "$AKV/proj" && git init -q && ruflo init --yes >/dev/null 2>&1 || true
```

Use `HOME="$AKV/home"` for every `ak` command below so the real `~/.claude` is never touched.

- [ ] **Step 2: Typesafe**

```bash
HOME="$AKV/home" node <repo>/bin/agentic-kit.mjs sync
ruflo doctor --component typesafe | tee <repo>/tests/fixtures/ruflo-components/doctor-typesafe-installed-3.44.0.txt
```

Expected: the doctor line no longer says "Not installed". Add a parser test asserting the
typesafe confirmation over this fixture.

- [ ] **Step 3: MiniLM**

```bash
CLAUDE_FLOW_ROUTER_EMBEDDER=minilm ruflo hooks route --task "sync and review latest issues" | tee <repo>/tests/fixtures/ruflo-components/route-minilm-3.44.0.txt
```

Expected: output contains `embedder=minilm`. If the marker text differs, update
`parseRouteEmbedder` and its test to the real format.

- [ ] **Step 4: Governance, with and without a policy file**

With `.harness/mcp-policy.json` present and `RUFLO_MCP_ENFORCE_POLICY=1`, start
`ruflo mcp start` over stdio, send `initialize` then a `tools/call` for `memory_store`, and
confirm a new line in `$TMPDIR/ruflo-mcp-audit.jsonl`. Remove the file and repeat: the call is
refused with "missing or invalid — failing closed". This proves the lockout guard is necessary.

- [ ] **Step 5: Funnel**

```bash
HOME="$AKV/home" ruflo funnel status | tee <repo>/tests/fixtures/ruflo-components/funnel-status-disabled-3.44.0.txt
```

after `ak sync`. Expected: `Funnel: disabled (decided by: user…)`. Adjust `parseFunnel` if
the source name differs and add a fixture test.

- [ ] **Step 6: Full status and uninstall round-trip**

```bash
HOME="$AKV/home" node <repo>/bin/agentic-kit.mjs status --refresh
HOME="$AKV/home" node <repo>/bin/agentic-kit.mjs uninstall --yes
```

Expected: status shows the ruflo components section with meanings; after uninstall,
`$AKV/home/.claude/settings.json` has no component keys, the project has no
`.harness/mcp-policy.json`, and `ruflo funnel status` is back to the package default.

- [ ] **Step 7: Repository gate**

Run: `pnpm run check && pnpm run lint:links:internal`
Expected: typecheck, lint, complexity, markdown lint, build and all tests pass.

- [ ] **Step 8: Docs — current behaviour only**

- `docs/MANAGED-TOOLS.md`: a "Ruflo components" section — the table of components, managed
  values, how to opt out in `kit.json`, and the state meanings table.
- `docs/SETUP.md`: the new disclosure group and the restart reminder.
- `docs/DASHBOARD.md`: the Runtime panel and the About summary link.
- `docs/TROUBLESHOOTING.md`: "Ruflo refuses every MCP tool call" → invalid policy file; "a
  component stays applied, not verified" → restart hosts, then `ak status --refresh`.
- `README.md`: one line in the features list.
- `CHANGELOG.md`: an Unreleased entry.

- [ ] **Step 9: ADR status**

Set each row of ADR-0058's Implementation status table to its real state. Change **Status** to
`Implemented` only if every row is done and Step 6 passed; otherwise keep `Accepted` with a dated
note of what remains. Add to ADR-0016's header:
`- **Updated:** 2026-MM-DD — the Claude memory pin is receipt-owned and removed by uninstall (ADR-0058).`

- [ ] **Step 10: Draft upstream requests (do not file)**

Write the four issue texts from ADR-0058 §8 (doctor JSON; audit log path, per-project, rotation;
doctor components for MiniLM and governance; Codex hook environment if Task 0 found the gap) into
the task report for the user. File them with `gh issue create --repo ruvnet/ruflo` only after
the user approves each one.

- [ ] **Step 11: Clean up and commit (only if authorized)**

```bash
rm -rf "$AKV"
git add tests/fixtures/ruflo-components tests/kit docs CHANGELOG.md README.md
git commit -m "docs(ruflo-components): verification fixtures, user docs, ADR status"
```
