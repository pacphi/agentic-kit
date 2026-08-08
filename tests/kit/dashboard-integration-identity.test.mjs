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

test('a route pinned to a retired model reports the substitution, not the dead id', () => {
  const payload = routingPayload({
    routing: {
      primaryHost: 'claude',
      routes: {
        // A `user` pin: never rewritten on disk, but still substituted for the
        // run, because honoring a pin into a withdrawn model just fails.
        implementation: { host: 'codex', model: 'gpt-5.4', provenance: 'user' },
      },
    },
  });
  const route = payload.routes.find((entry) => entry.activity === 'implementation');
  assert.equal(route.model, 'gpt-5.6-terra', 'the panel must show what will actually run');
  assert.equal(route.retiredFrom, 'gpt-5.4', 'and name the id it replaced');
  assert.equal(route.retiresOn, '2026-08-31');
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
