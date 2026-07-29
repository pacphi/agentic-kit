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

test('ak run materializes an explicit OpenCode route', () => {
  const cfg = { providers: { dualRouting: { ...seedDualRouting(), 'security-scan': {
    host: 'opencode', model: 'openrouter/example', source: 'user',
  } } } };
  const { plan } = buildRunPlan(cfg, 'security', 'src/auth');
  const scanner = plan.workers.find((entry) => entry.activity === 'security-scan');
  assert.equal(scanner.host, 'opencode');
  assert.equal(scanner.configuredModel, 'openrouter/example');
});
