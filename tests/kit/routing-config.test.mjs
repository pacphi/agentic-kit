import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ROUTING_SCHEMA_VERSION,
  legacyRoutesToCanonical,
  migrateRoutingConfig,
  routingIntent,
} from '../../src/lib/routing-config.mjs';
import { loadKitConfig, saveKitConfig } from '../../src/lib/config.mjs';

test('legacy routes migrate without resolving absence and preserve an explicit empty ladder', () => {
  const legacy = {
    architecture: { host: 'claude', model: 'claude:custom', source: 'seeded' },
    implementation: { host: 'codex', escalate: [] },
    testing: {
      host: 'codex',
      source: 'user',
      escalate: [
        { host: 'claude', model: 'claude-opus-5' },
        { host: 'codex', model: null },
      ],
    },
  };
  const input = structuredClone(legacy);
  const routes = legacyRoutesToCanonical(input);
  assert.deepEqual(input, legacy, 'conversion must be pure');
  assert.deepEqual(routes.architecture, {
    host: 'claude',
    model: 'claude:custom',
    provenance: 'seeded',
  });
  assert.deepEqual(routes.implementation, {
    host: 'codex',
    provenance: 'user',
    escalation: [],
  });
  assert.deepEqual(routes.testing.escalation, [
    { host: 'claude', model: 'claude-opus-5' },
    { host: 'codex', model: null },
  ]);
});

test('routing migration is one-way and idempotent', () => {
  const legacy = {
    providers: {
      primaryHost: 'codex',
      dualRouting: {
        implementation: {
          host: 'codex',
          model: 'gpt-5.4',
          source: 'user',
          escalate: [{ host: 'claude', model: 'claude-opus-5' }],
        },
      },
      aqeProvider: 'openai',
    },
  };
  const first = migrateRoutingConfig(legacy);
  assert.deepEqual(first.routing, {
    version: ROUTING_SCHEMA_VERSION,
    primaryHost: 'codex',
    routes: {
      implementation: {
        host: 'codex',
        model: 'gpt-5.4',
        provenance: 'user',
        escalation: [{ host: 'claude', model: 'claude-opus-5' }],
      },
    },
  });
  assert.equal(Object.hasOwn(first.providers, 'primaryHost'), false);
  assert.equal(Object.hasOwn(first.providers, 'dualRouting'), false);
  assert.equal(first.providers.aqeProvider, 'openai');
  assert.deepEqual(migrateRoutingConfig(structuredClone(first)), first);
});

test('equivalent canonical and legacy routing converges; disagreement is a hard conflict', () => {
  const routing = {
    version: ROUTING_SCHEMA_VERSION,
    primaryHost: 'claude',
    routes: {
      review: { host: 'claude', model: 'claude-sonnet-5', provenance: 'seeded' },
    },
  };
  const equivalent = migrateRoutingConfig({
    routing,
    providers: {
      primaryHost: 'claude',
      dualRouting: {
        review: { host: 'claude', model: 'claude-sonnet-5', source: 'seeded' },
      },
    },
  });
  assert.deepEqual(equivalent.routing, routing);
  assert.deepEqual(equivalent.providers, {});

  assert.throws(() => migrateRoutingConfig({
    routing,
    providers: {
      dualRouting: {
        review: { host: 'codex', model: 'gpt-5.4', source: 'user' },
      },
    },
  }), /routing conflict: providers\.dualRouting differs from routing\.routes/);
  assert.throws(() => migrateRoutingConfig({
    routing,
    providers: { primaryHost: 'codex' },
  }), /routing conflict: providers\.primaryHost differs from routing\.primaryHost/);
});

test('future routing versions remain opaque and retain compatibility state', () => {
  const future = {
    routing: {
      version: ROUTING_SCHEMA_VERSION + 4,
      routes: { future: ['opaque'] },
      futureField: { keep: true },
    },
    providers: {
      primaryHost: 'codex',
      dualRouting: { implementation: { host: 'codex' } },
    },
  };
  assert.deepEqual(migrateRoutingConfig(structuredClone(future)), future);
  assert.throws(() => routingIntent(future), /unsupported routing\.version/);
});

test('host-less legacy routes inherit the activity default host', () => {
  const migrated = migrateRoutingConfig({
    providers: {
      dualRouting: {
        review: { model: 'claude-opus-5', source: 'user' },
      },
    },
  });
  assert.deepEqual(migrated.routing.routes.review, {
    host: 'claude',
    model: 'claude-opus-5',
    provenance: 'user',
  });
});

test('load migrates raw legacy presence without writing; save persists only canonical state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-routing-config-'));
  const file = path.join(dir, 'kit.json');
  const legacy = {
    providers: {
      hosts: { codex: true },
      primaryHost: 'codex',
      dualRouting: {
        implementation: { host: 'codex', escalate: [], source: 'user' },
      },
      aqeProvider: 'openai',
    },
  };
  fs.writeFileSync(file, JSON.stringify(legacy));
  const before = fs.readFileSync(file, 'utf8');
  const loaded = loadKitConfig(file);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'load is read-only');
  assert.deepEqual(loaded.integrations.hosts,
    { claude: true, codex: true, opencode: false });
  assert.equal(loaded.routing.primaryHost, 'codex');
  assert.deepEqual(loaded.routing.routes.implementation.escalation, []);
  assert.equal(loaded.providers.aqeProvider, 'openai');
  for (const key of ['hosts', 'primaryHost', 'dualRouting']) {
    assert.equal(Object.hasOwn(loaded.providers, key), false);
  }

  saveKitConfig(loaded, file);
  const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(persisted.routing, loaded.routing);
  assert.deepEqual(persisted.integrations, loaded.integrations);
  assert.equal(persisted.providers.aqeProvider, 'openai');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an invalid existing config is reported instead of silently replaced with defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-routing-invalid-'));
  const file = path.join(dir, 'kit.json');
  fs.writeFileSync(file, '{ invalid json');
  assert.throws(() => loadKitConfig(file), (error) => {
    assert.equal(error.name, 'KitConfigError');
    assert.equal(error.configPath, file);
    assert.match(error.message, /invalid kit config/);
    return true;
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('load rejects unusable or future envelopes without mutating the file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-routing-unsupported-'));
  const file = path.join(dir, 'kit.json');
  for (const input of [
    { integrations: [] },
    { integrations: { version: 99 } },
    { routing: { version: 99, future: true } },
  ]) {
    const bytes = `${JSON.stringify(input, null, 2)}\n`;
    fs.writeFileSync(file, bytes);
    assert.throws(() => loadKitConfig(file), (error) => {
      assert.equal(error.name, 'KitConfigError');
      assert.equal(error.configPath, file);
      assert.match(error.message, /invalid kit config/);
      assert.doesNotMatch(error.message, /\n\s+at /);
      return true;
    });
    assert.equal(fs.readFileSync(file, 'utf8'), bytes, 'failed load is read-only');
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
