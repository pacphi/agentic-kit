import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routingPayload } from '../../src/lib/dashboard-server.mjs';

test('dashboard routing describes host assignment without manufacturing a provider', () => {
  const payload = routingPayload({
    routing: {
      primaryHost: 'claude',
      routes: {
        implementation: {
          host: 'codex',
          model: 'gpt-5.4',
          provenance: 'user',
        },
      },
    },
  });
  const route = payload.routes.find((entry) => entry.activity === 'implementation');
  assert.deepEqual(route, {
    activity: 'implementation',
    host: 'codex',
    model: 'gpt-5.4',
    provenance: 'user',
    akOriginated: false,
    escalation: ['claude'],
  });
  assert.equal(Object.hasOwn(route, 'provider'), false);
});
