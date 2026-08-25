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
          // A CURRENT model on purpose: a retired one would be substituted by
          // resolveRoutes and this test is about the provider field, not that.
          model: 'gpt-5.6-terra',
          provenance: 'user',
        },
      },
    },
  });
  const route = payload.routes.find((entry) => entry.activity === 'implementation');
  assert.deepEqual(route, {
    activity: 'implementation',
    host: 'codex',
    model: 'gpt-5.6-terra',
    provenance: 'user',
    akOriginated: false,
    escalation: ['claude'],
  });
  assert.equal(Object.hasOwn(route, 'provider'), false);
});

test('a route keeps its exact configured model when no cited retirement exists', () => {
  const payload = routingPayload({
    routing: {
      primaryHost: 'claude',
      routes: {
        // A user pin is an operator fact. Without a direct first-party
        // withdrawal notice, the dashboard must not manufacture a replacement.
        implementation: { host: 'codex', model: 'gpt-5.4', provenance: 'user' },
      },
    },
  });
  const route = payload.routes.find((entry) => entry.activity === 'implementation');
  assert.equal(route.model, 'gpt-5.4', 'the panel must show the exact configured model');
  assert.equal(Object.hasOwn(route, 'retiredFrom'), false);
  assert.equal(Object.hasOwn(route, 'retiresOn'), false);
});

test('retirement and divergence are separate signals on the wire', () => {
  const payload = routingPayload({
    routing: {
      primaryHost: 'claude',
      // Seeded and pinned to a model that is superseded but NOT retired: this is
      // divergence only, so it must carry `diverged` and no retirement fields.
      routes: { architecture: { host: 'claude', model: 'claude-opus-4-8', provenance: 'seeded' } },
    },
  });
  const route = payload.routes.find((entry) => entry.activity === 'architecture');
  assert.equal(route.model, 'claude-opus-4-8', 'a superseded-but-live model is left alone');
  assert.equal(Object.hasOwn(route, 'retiredFrom'), false, 'not a retirement');
  assert.equal(route.diverged.defaultModel, 'claude-opus-5');
  assert.ok(route.diverged.currentNote && route.diverged.defaultNote,
    'both sides must carry their cost-per-task note so the trade is legible');
});
