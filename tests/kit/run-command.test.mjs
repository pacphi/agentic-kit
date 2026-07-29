import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRunPlan } from '../../src/commands/run.mjs';
import { seedDualRouting } from '../../src/lib/routing.mjs';

test('ak run materializes the host-neutral plan and keeps run-local route overrides ephemeral', () => {
  const cfg = { providers: { dualRouting: seedDualRouting() } };
  const { plan } = buildRunPlan(cfg, 'feature', 'add a queue', ['implementation:claude:claude-sonnet-5']);
  assert.equal(plan.template, 'feature');
  assert.equal(plan.workers.find((entry) => entry.id === 'coder').host, 'claude');
  assert.equal(cfg.providers.dualRouting.implementation.host, 'codex');
});

test('ak run rejects an OpenCode route until the capability proof is complete', () => {
  const cfg = { providers: { dualRouting: { ...seedDualRouting(), 'security-scan': {
    host: 'opencode', model: 'openrouter/example', source: 'user',
  } } } };
  assert.throws(() => buildRunPlan(cfg, 'security', 'src/auth'), /canRouteActivities/);
});
