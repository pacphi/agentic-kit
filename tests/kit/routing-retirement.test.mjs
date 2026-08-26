// Automatic retirement overrides configured routing, so absence of a direct
// first-party withdrawal notice must be a no-op. Preferred successors and local
// host upgrade hints are recommendations, not dispatch facts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RETIRED_MODELS, retirementOf, migrateRetiredRoutes, resolveRoutes,
} from '../../src/lib/routing.mjs';
import { migrateRetiredRoutesInConfig } from '../../src/lib/providers.mjs';

test('automatic retirement map is empty until a direct withdrawal notice is recorded', () => {
  assert.deepEqual(RETIRED_MODELS, {});
  for (const model of ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
    assert.equal(retirementOf(model), null, `${model} must remain a configured choice without a notice`);
  }
});

test('resolveRoutes preserves a configured Codex model without an evidenced retirement', () => {
  const routes = resolveRoutes({
    implementation: { host: 'codex', model: 'gpt-5.4', provenance: 'user' },
  });
  assert.equal(routes.implementation.model, 'gpt-5.4');
  assert.equal(Object.hasOwn(routes.implementation, 'retiredFrom'), false);
});

test('retirement migration functions are pure no-ops without a cited rule', () => {
  const policy = { implementation: { host: 'codex', model: 'gpt-5.4', provenance: 'seeded' } };
  const snapshot = structuredClone(policy);
  assert.deepEqual(migrateRetiredRoutes(policy), { routes: policy, changes: [] });
  assert.deepEqual(policy, snapshot);

  const config = { routing: { routes: structuredClone(policy) } };
  assert.deepEqual(migrateRetiredRoutesInConfig(config), { changed: false, changes: [] });
  assert.deepEqual(config.routing.routes, policy);
});
