import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectIntegrationFacts, commandHosts } from '../../src/lib/providers.mjs';
import { HOST_REGISTRY } from '../../src/lib/adapters/index.mjs';

test('commands share one immutable normalized integration snapshot', async () => {
  const cfg = {
    providers: { hosts: { claude: true, codex: false } },
    integrations: {
      bindings: [{
        host: 'claude', provider: 'ollama', model: 'qwen3.6:latest',
        provenance: 'configured',
      }],
    },
  };
  const facts = await collectIntegrationFacts({
    cwd: process.cwd(), cfg, env: { OPENROUTER_API_KEY: 'present-only-in-memory' },
  });
  assert.equal(Object.isFrozen(facts), true);
  assert.equal(facts.hosts.claude.enabled, true);
  assert.equal(facts.providers.openrouter.keyPresent, true);
  assert.equal(facts.bindings[0].host, 'claude');
  assert.equal(facts.bindings[0].provider, 'ollama');
  assert.equal(JSON.stringify(facts).includes('present-only-in-memory'), false);
});

test('managed but non-routable OpenCode never enters legacy install/routing loops', () => {
  const opencode = HOST_REGISTRY.find(({ id }) => id === 'opencode');
  assert.ok(opencode);
  assert.equal(opencode.capabilities.canDriveSession, true);
  assert.equal(opencode.capabilities.canRouteActivities, false);
  assert.equal(commandHosts().some(({ id }) => id === 'opencode'), false);
});
