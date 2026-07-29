import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routingPayload } from '../../src/lib/dashboard-server.mjs';

test('dashboard routing describes host assignment without manufacturing a provider', () => {
  const payload = routingPayload({
    providers: {
      primaryHost: 'claude',
      dualRouting: {
        implementation: {
          host: 'codex',
          model: 'gpt-5.4',
          source: 'user',
        },
      },
    },
  });
  const route = payload.routes.find((entry) => entry.activity === 'implementation');
  assert.deepEqual(route, {
    activity: 'implementation',
    host: 'codex',
    model: 'gpt-5.4',
    source: 'user',
    akOriginated: false,
    escalate: ['claude'],
  });
  assert.equal(Object.hasOwn(route, 'provider'), false);
});
