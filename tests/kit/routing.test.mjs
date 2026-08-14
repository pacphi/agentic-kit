import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVITIES, AK_ORIGINATED, DEFAULT_ROUTES, HOST_PROVIDER, SUBSCRIPTION_PROVIDERS,
  AQE_CONSTRUCTIBLE_PROVIDERS, MODEL_CATALOG, MODEL_CATALOG_VERIFIED, modelChoices, formatModelHelp,
  resolveRoutes, seedActivityRoutes, policyToAgentOverrides, routedVendors, routingSummary,
  configuredPolicyToAgentOverrides, pruneRoutesForHosts, materializeRunPlan,
  validateRoute, parseRouteSpecs,
  RUN_TEMPLATE_NAMES,
} from '../../src/lib/routing.mjs';

// ── Vocabulary + defaults ────────────────────────────────────────────────────

test('every canonical activity has a default route', () => {
  for (const act of ACTIVITIES) assert.ok(DEFAULT_ROUTES[act], `missing default for ${act}`);
  assert.equal(Object.keys(DEFAULT_ROUTES).length, ACTIVITIES.length);
});

test('default hosts match rUv template grounding (architect→claude, coder/tester→codex, reviewer→claude)', () => {
  assert.equal(DEFAULT_ROUTES.architecture.host, 'claude');
  assert.equal(DEFAULT_ROUTES.implementation.host, 'codex');
  assert.equal(DEFAULT_ROUTES.testing.host, 'codex');
  assert.equal(DEFAULT_ROUTES.review.host, 'claude');
  assert.equal(DEFAULT_ROUTES['security-scan'].host, 'codex');
  assert.equal(DEFAULT_ROUTES['security-analysis'].host, 'claude');
});

test('packaging and release are the only ak-originated activities', () => {
  assert.deepEqual([...AK_ORIGINATED].sort(), ['packaging', 'release']);
});

test('every default route targets a constructible provider', () => {
  for (const [act, r] of Object.entries(DEFAULT_ROUTES)) {
    assert.ok(AQE_CONSTRUCTIBLE_PROVIDERS.includes(HOST_PROVIDER[r.host]), `${act} → non-constructible`);
  }
});

// ── Model catalog (the "offer choices" surface) ─────────────────────────────

test('model catalog lists choices for both hosts with no deprecated IDs', () => {
  assert.ok(modelChoices('claude').length >= 2);
  assert.ok(modelChoices('codex').length >= 2);
  const all = [...MODEL_CATALOG.claude, ...MODEL_CATALOG.codex].map((m) => m.id);
  assert.ok(!all.some((id) => id.startsWith('gpt-5.2')), 'must not offer deprecated gpt-5.2* models');
});

test('formatModelHelp names both hosts and cites a verified date', () => {
  const help = formatModelHelp();
  assert.match(help, /claude:/);
  assert.match(help, /codex:/);
  assert.ok(help.includes(MODEL_CATALOG_VERIFIED));
});

// ── resolveRoutes / provenance ──────────────────────────────────────────────

test('empty policy resolves every activity to provenance=default', () => {
  const routes = resolveRoutes({});
  assert.equal(Object.keys(routes).length, ACTIVITIES.length);
  assert.ok(Object.values(routes).every((r) => r.provenance === 'default'));
  assert.equal(routes.packaging.akOriginated, true);
  assert.equal(routes.architecture.akOriginated, false);
});

test('a persisted user route overlays defaults and keeps provenance=user', () => {
  const routes = resolveRoutes({ implementation: { host: 'claude', model: 'claude-opus-4-8', provenance: 'user' } });
  assert.equal(routes.implementation.host, 'claude');
  assert.equal(routes.implementation.model, 'claude-opus-4-8');
  assert.equal(routes.implementation.provenance, 'user');
});

test('a persisted entry with no explicit provenance is treated as a user edit', () => {
  const routes = resolveRoutes({ testing: { host: DEFAULT_ROUTES.testing.host } });
  assert.equal(routes.testing.provenance, 'user');
  assert.equal(routes.testing.model, DEFAULT_ROUTES.testing.model, 'same-host: unset field falls back to default');
});

test('a host-only override never inherits the previous host default model (qe-court B1)', () => {
  const foreign = Object.entries(DEFAULT_ROUTES).find(([, d]) => d.host !== 'claude');
  assert.ok(foreign, 'fixture needs a non-claude default route');
  const [activity] = foreign;
  const routes = resolveRoutes({ [activity]: { host: 'claude' } });
  assert.equal(routes[activity].host, 'claude');
  assert.equal(routes[activity].model, null,
    'cross-host override leaves the model to the adapter default, not the other host\'s default');
  // an explicit model on a cross-host override is still honored verbatim
  const pinned = resolveRoutes({ [activity]: { host: 'claude', model: 'claude-sonnet-5' } });
  assert.equal(pinned[activity].model, 'claude-sonnet-5');
});

// ── seedActivityRoutes (cost-safety gate) ──────────────────────────────────────

test('seeding both hosts stamps every route seeded and only subscription providers', () => {
  const policy = seedActivityRoutes({ hosts: ['claude', 'codex'] });
  assert.equal(Object.keys(policy).length, ACTIVITIES.length);
  for (const r of Object.values(policy)) {
    assert.equal(r.provenance, 'seeded');
    assert.ok(SUBSCRIPTION_PROVIDERS.has(HOST_PROVIDER[r.host]), 'never seeds a metered provider');
  }
});

test('seeding a single host omits the other host’s activities', () => {
  const policy = seedActivityRoutes({ hosts: ['claude'] });
  assert.ok(Object.values(policy).every((r) => r.host === 'claude'));
  assert.ok(!('implementation' in policy), 'codex activity not seeded when codex absent');
});

// ── Projection #1: agentOverrides ───────────────────────────────────────────

test('policyToAgentOverrides maps QE agents to their activity host+model', () => {
  const ov = policyToAgentOverrides({});
  assert.deepEqual(ov['qe-security-scanner'], { provider: 'codex', model: DEFAULT_ROUTES['security-scan'].model });
  assert.deepEqual(ov['qe-test-architect'], { provider: 'codex', model: DEFAULT_ROUTES.testing.model });
  assert.deepEqual(ov['qe-code-reviewer'], { provider: 'claude-code', model: DEFAULT_ROUTES.review.model });
});

test('overriding an activity flows through to its agent overrides', () => {
  const ov = policyToAgentOverrides({ testing: { host: 'claude', model: 'claude-sonnet-5', provenance: 'user' } });
  assert.equal(ov['qe-test-architect'].provider, 'claude-code');
  assert.equal(ov['qe-test-architect'].model, 'claude-sonnet-5');
});

test('configured projection never recreates a missing route from dual-host defaults', () => {
  const ov = configuredPolicyToAgentOverrides({ review: { host: 'claude', model: 'claude-sonnet-5', provenance: 'user' } });
  assert.equal(ov['qe-code-reviewer'].provider, 'claude-code');
  assert.equal(ov['qe-test-architect'], undefined);
});

test('pruning disabled hosts drops primary routes and only invalid escalation rungs', () => {
  const out = pruneRoutesForHosts({
    implementation: { host: 'codex', model: 'gpt-5.4', provenance: 'seeded' },
    testing: { host: 'claude', model: 'claude-sonnet-5', provenance: 'user', escalation: [{ host: 'codex', model: 'gpt-5.4' }] },
  }, { hosts: ['claude'] });
  assert.equal(out.policy.implementation, undefined);
  assert.deepEqual(out.policy.testing, { host: 'claude', model: 'claude-sonnet-5', provenance: 'user' });
  assert.equal(out.pruned.length, 2);
  assert.deepEqual(out.warnings, ["removed user escalation for 'testing' — host 'codex' is disabled"]);
});

// ── Diversity + summary ─────────────────────────────────────────────────────

test('default routing spans at least two vendors (qe-court diversity)', () => {
  assert.ok(routedVendors({}).size >= 2);
});

test('routingSummary counts totals, provenance, and per-host tallies', () => {
  const s = routingSummary({ testing: { host: 'claude', provenance: 'user' } });
  assert.equal(s.total, ACTIVITIES.length);
  assert.equal(s.custom, 1);
  assert.ok(s.byHost.claude > 0 && s.byHost.codex > 0);
  assert.ok(s.vendors >= 2);
});

// ── Validation + spec parsing ───────────────────────────────────────────────

test('validateRoute accepts claude/codex and rejects an unknown host', () => {
  assert.deepEqual(validateRoute({ host: 'claude', model: 'claude-opus-4-8' }), []);
  assert.deepEqual(validateRoute({ host: 'codex' }), []);
  assert.ok(validateRoute({ host: 'zz-not-a-registered-host' }).length > 0);
});

test('parseRouteSpecs parses valid specs and warns on bad ones', () => {
  const { policy, warnings } = parseRouteSpecs([
    'implementation:claude:claude-opus-4-8',
    'testing:codex',
    'nonsense:claude',       // unknown activity
    'review:zz-not-a-registered-host',         // unknown host
  ]);
  assert.deepEqual(policy.implementation, { host: 'claude', model: 'claude-opus-4-8', provenance: 'user' });
  assert.deepEqual(policy.testing, { host: 'codex', provenance: 'user' });
  assert.equal(warnings.length, 2);
  assert.ok(!('nonsense' in policy) && !('review' in policy));
});

// ── Host-neutral run plans ──────────────────────────────────────────────────

test('materializeRunPlan(feature) builds the grounded worker DAG with policy host+model', () => {
  const { workers } = materializeRunPlan(seedActivityRoutes(), { template: 'feature', task: 'add auth' });
  assert.equal(workers.length, 4);
  const byId = Object.fromEntries(workers.map((w) => [w.id, w]));
  assert.equal(byId.architect.host, 'claude');
  assert.equal(byId.coder.host, 'codex');
  assert.deepEqual(byId.reviewer.dependsOn, ['coder', 'tester']);
  assert.ok(byId.coder.configuredModel, 'model comes from the route');
  assert.match(byId.architect.prompt, /add auth/, 'task is interpolated');
});

test('every run template materializes a host-neutral worker plan', () => {
  for (const name of RUN_TEMPLATE_NAMES) {
    const { workers } = materializeRunPlan(seedActivityRoutes(), { template: name, task: 'x' });
    assert.ok(workers.length >= 1, `${name} has workers`);
    assert.ok(workers.every((w) => w.activity && w.host && !('platform' in w)), `${name} workers are host-neutral`);
  }
});

test('host-neutral run plan preserves dependencies, routes, and static prompts', () => {
  const plan = materializeRunPlan(seedActivityRoutes(), { template: 'feature', task: 'add auth' });
  assert.equal(plan.template, 'feature');
  assert.ok(plan.workers.every((worker) => worker.activity && worker.host && !('platform' in worker)));
  assert.deepEqual(plan.workers.find((worker) => worker.id === 'reviewer').dependsOn, ['coder', 'tester']);
  assert.ok(plan.workers.every((worker) => !/AK_HANDOFF|AK_DEPENDENCY_DATA/.test(worker.prompt)),
    'handoff protocol is appended only by the runtime runner; dry-run/materialization stays static');
});

test('an explicit OpenCode route materializes for ak run', () => {
  const policy = { implementation: {
    host: 'opencode', model: 'openrouter/example', provenance: 'user',
  } };
  const plan = materializeRunPlan(policy, { template: 'feature', task: 'x' });
  assert.equal(plan.workers.find((worker) => worker.activity === 'implementation').host, 'opencode');
});

test('host-neutral run plan rejects a host without activity-routing capability', () => {
  const policy = { implementation: { host: 'zz-not-a-registered-host', provenance: 'user' } };
  assert.throws(
    () => materializeRunPlan(policy, { template: 'feature', task: 'x' }),
    /route for "implementation" cannot materialize: host "zz-not-a-registered-host" requires canRouteActivities/,
  );
});

test('materializeRunPlan throws on an unknown template', () => {
  assert.throws(() => materializeRunPlan({}, { template: 'nope' }), /unknown template/);
});

test('parseRouteSpecs preserves a model id containing a colon', () => {
  const { policy } = parseRouteSpecs(['implementation:codex:vendor:model-x']);
  assert.equal(policy.implementation.model, 'vendor:model-x');
});
