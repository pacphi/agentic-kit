import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVITIES, AK_ORIGINATED, DEFAULT_ROUTES, HOST_PROVIDER, SUBSCRIPTION_PROVIDERS,
  AQE_CONSTRUCTIBLE_PROVIDERS, MODEL_CATALOG, MODEL_CATALOG_VERIFIED, modelChoices, formatModelHelp,
  resolveRoutes, seedDualRouting, policyToAgentOverrides, routedVendors, routingSummary,
  validateRoute, parseRouteSpecs,
  DUAL_RUN_TEMPLATE_NAMES, policyToDualRunConfig, escalatePolicy,
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

test('empty policy resolves every activity to source=default', () => {
  const routes = resolveRoutes({});
  assert.equal(Object.keys(routes).length, ACTIVITIES.length);
  assert.ok(Object.values(routes).every((r) => r.source === 'default'));
  assert.equal(routes.packaging.akOriginated, true);
  assert.equal(routes.architecture.akOriginated, false);
});

test('a persisted user route overlays defaults and keeps source=user', () => {
  const routes = resolveRoutes({ implementation: { host: 'claude', model: 'claude-opus-4-8', source: 'user' } });
  assert.equal(routes.implementation.host, 'claude');
  assert.equal(routes.implementation.model, 'claude-opus-4-8');
  assert.equal(routes.implementation.source, 'user');
});

test('a persisted entry with no explicit source is treated as a user edit', () => {
  const routes = resolveRoutes({ testing: { host: 'claude' } });
  assert.equal(routes.testing.source, 'user');
  assert.equal(routes.testing.model, DEFAULT_ROUTES.testing.model, 'unset field falls back to default');
});

// ── seedDualRouting (cost-safety gate) ──────────────────────────────────────

test('seeding both hosts stamps every route seeded and only subscription providers', () => {
  const policy = seedDualRouting({ hosts: ['claude', 'codex'] });
  assert.equal(Object.keys(policy).length, ACTIVITIES.length);
  for (const r of Object.values(policy)) {
    assert.equal(r.source, 'seeded');
    assert.ok(SUBSCRIPTION_PROVIDERS.has(HOST_PROVIDER[r.host]), 'never seeds a metered provider');
  }
});

test('seeding a single host omits the other host’s activities', () => {
  const policy = seedDualRouting({ hosts: ['claude'] });
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
  const ov = policyToAgentOverrides({ testing: { host: 'claude', model: 'claude-sonnet-5', source: 'user' } });
  assert.equal(ov['qe-test-architect'].provider, 'claude-code');
  assert.equal(ov['qe-test-architect'].model, 'claude-sonnet-5');
});

// ── Diversity + summary ─────────────────────────────────────────────────────

test('default routing spans at least two vendors (qe-court diversity)', () => {
  assert.ok(routedVendors({}).size >= 2);
});

test('routingSummary counts totals, provenance, and per-host tallies', () => {
  const s = routingSummary({ testing: { host: 'claude', source: 'user' } });
  assert.equal(s.total, ACTIVITIES.length);
  assert.equal(s.custom, 1);
  assert.ok(s.byHost.claude > 0 && s.byHost.codex > 0);
  assert.ok(s.vendors >= 2);
});

// ── Validation + spec parsing ───────────────────────────────────────────────

test('validateRoute accepts claude/codex and rejects an unknown host', () => {
  assert.deepEqual(validateRoute({ host: 'claude', model: 'claude-opus-4-8' }), []);
  assert.deepEqual(validateRoute({ host: 'codex' }), []);
  assert.ok(validateRoute({ host: 'gemini' }).length > 0);
});

test('parseRouteSpecs parses valid specs and warns on bad ones', () => {
  const { policy, warnings } = parseRouteSpecs([
    'implementation:claude:claude-opus-4-8',
    'testing:codex',
    'nonsense:claude',       // unknown activity
    'review:gemini',         // unknown host
  ]);
  assert.deepEqual(policy.implementation, { host: 'claude', model: 'claude-opus-4-8', source: 'user' });
  assert.deepEqual(policy.testing, { host: 'codex', source: 'user' });
  assert.equal(warnings.length, 2);
  assert.ok(!('nonsense' in policy) && !('review' in policy));
});

// ── Projection #2: dual-run config ──────────────────────────────────────────

test('policyToDualRunConfig(feature) builds the grounded worker DAG with policy host+model', () => {
  const { workers } = policyToDualRunConfig(seedDualRouting(), { template: 'feature', task: 'add auth' });
  assert.equal(workers.length, 4);
  const byId = Object.fromEntries(workers.map((w) => [w.id, w]));
  assert.equal(byId.architect.platform, 'claude');
  assert.equal(byId.coder.platform, 'codex');
  assert.deepEqual(byId.reviewer.dependsOn, ['coder', 'tester']);
  assert.ok(byId.coder.model, 'model comes from the route');
  assert.match(byId.architect.prompt, /add auth/, 'task is interpolated');
});

test('every dual-run template projects to platforms of claude|codex only', () => {
  for (const name of DUAL_RUN_TEMPLATE_NAMES) {
    const { workers } = policyToDualRunConfig(seedDualRouting(), { template: name, task: 'x' });
    assert.ok(workers.length >= 1, `${name} has workers`);
    assert.ok(workers.every((w) => w.platform === 'claude' || w.platform === 'codex'), `${name} platforms valid`);
  }
});

test('policyToDualRunConfig throws on an unknown template', () => {
  assert.throws(() => policyToDualRunConfig({}, { template: 'nope' }), /unknown template/);
});

test('escalatePolicy bumps ladder activities to their next (cross-vendor) rung', () => {
  const esc = escalatePolicy(seedDualRouting());
  // implementation & testing carry a codex→claude ladder in the defaults
  assert.equal(esc.implementation.host, 'claude');
  assert.equal(esc.testing.host, 'claude');
  // activities without a ladder are not escalated
  assert.ok(!('review' in esc));
});

test('escalatePolicy skips a rung that equals the current route (no same-model retry)', () => {
  // a user override to the ladder rung itself must not "escalate" to the same thing
  const policy = { implementation: { host: 'claude', model: 'claude-opus-4-8', source: 'user' } };
  assert.ok(!('implementation' in escalatePolicy(policy)));
});

test('parseRouteSpecs preserves a model id containing a colon', () => {
  const { policy } = parseRouteSpecs(['implementation:codex:vendor:model-x']);
  assert.equal(policy.implementation.model, 'vendor:model-x');
});
