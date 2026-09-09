// MNT-MDL-001..007, J6: exact provider-owned Ollama model removal. One model
// per action, active-use and incomplete-consumer refusal, shared-blob
// accounting, provider-native removal with verified absence, redownload
// disclosure, and no elevation or implicit host crossing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';

import { createOllamaModelRemoveProvider } from '../../src/lib/maintenance/providers/ollama-model-remove.mjs';

function jsonResponse(body) {
  return { ok: true, arrayBuffer: async () => Buffer.from(JSON.stringify(body)) };
}

function stateBackedFetch(state) {
  return async (url) => {
    const key = new URL(url).pathname;
    if (key === '/api/tags') return jsonResponse({ models: state.tags });
    if (key === '/api/ps') return jsonResponse({ models: state.loaded });
    return { ok: false, arrayBuffer: async () => Buffer.alloc(0) };
  };
}

function stateBackedRun(state, calls) {
  return async (binary, args, options) => {
    calls.push({ binary, args, options });
    if (binary === 'ollama' && args[0] === 'rm') {
      const name = args[1];
      const before = state.tags.length;
      state.tags = state.tags.filter((row) => row.name !== name);
      return state.tags.length < before
        ? { ok: true, exitCode: 0, stdout: '', stderr: '' }
        : { ok: false, exitCode: 1, stdout: '', stderr: 'model not found' };
    }
    return { ok: false, exitCode: 1, stdout: '', stderr: 'unexpected command' };
  };
}

function modelFinding(name, overrides = {}) {
  return {
    resource: { id: name, kind: 'model', name, host: 'ollama', scope: 'user' },
    safetyClass: 'approval-required',
    nextAction: { operation: 'remove' },
    consumers: { complete: true, list: [] },
    ...overrides,
  };
}

test('J6: an exact inactive model with complete consumer and shared-blob evidence is Managed removable, verified absent', async () => {
  const state = {
    tags: [
      { name: 'llama3.2:3b', digest: 'aaaa1111', size: 2_000_000_000 },
      { name: 'qwen2.5-coder:7b', digest: 'bbbb2222', size: 4_000_000_000 },
    ],
    loaded: [{ name: 'qwen2.5-coder:7b' }],
  };
  const calls = [];
  const provider = createOllamaModelRemoveProvider({
    fetchImpl: stateBackedFetch(state), run: stateBackedRun(state, calls),
    modelSnapshot: { blobSharing: { 'aaaa1111': 1 } },
  });
  const facts = await provider.detect();
  assert.equal(facts.status, 'available');
  assert.equal(facts.complete, true);

  const action = provider.actionFor(modelFinding('llama3.2:3b'), facts);
  assert.ok(action);
  assert.equal(action.operation, 'remove');
  assert.equal(action.rollback, 'irreversible');
  assert.match(action.impact.summary, /redownload/i);
  assert.equal(action.impact.bytes, 2_000_000_000);

  const preflight = await provider.preflight(action);
  assert.equal(preflight.ok, true);

  const outcome = await provider.apply(action);
  assert.equal(outcome.status, 'applied');
  const runCall = calls.find((call) => call.binary === 'ollama');
  assert.deepEqual(runCall.args, ['rm', 'llama3.2:3b']);
  assert.equal(runCall.options.cwd, os.tmpdir(), 'a neutral cwd is used');
  assert.deepEqual(Object.keys(runCall.options.env).sort(), ['HOME', 'PATH'], 'only a minimal env is passed');

  const verified = await provider.verify(action, outcome);
  assert.equal(verified.ok, true);
  assert.equal(state.tags.some((row) => row.name === 'llama3.2:3b'), false);
});

test('active loaded/generating use refuses Managed removal', async () => {
  const state = {
    tags: [{ name: 'qwen2.5-coder:7b', digest: 'bbbb2222', size: 4_000_000_000 }],
    loaded: [{ name: 'qwen2.5-coder:7b' }],
  };
  const provider = createOllamaModelRemoveProvider({
    fetchImpl: stateBackedFetch(state), modelSnapshot: { blobSharing: { 'bbbb2222': 1 } },
  });
  const facts = await provider.detect();
  const action = provider.actionFor(modelFinding('qwen2.5-coder:7b'), facts);
  assert.equal(action, null);
});

test('an incomplete consumer enumeration refuses Managed removal', async () => {
  const state = { tags: [{ name: 'llama3.2:3b', digest: 'aaaa1111', size: 2_000_000_000 }], loaded: [] };
  const provider = createOllamaModelRemoveProvider({
    fetchImpl: stateBackedFetch(state), modelSnapshot: { blobSharing: { 'aaaa1111': 1 } },
  });
  const facts = await provider.detect();
  const incomplete = provider.actionFor(modelFinding('llama3.2:3b', {
    consumers: { complete: false, list: [] },
  }), facts);
  assert.equal(incomplete, null);
});

test('a live route consumer missing from the finding\'s enumerated list refuses removal', async () => {
  const state = { tags: [{ name: 'llama3.2:3b', digest: 'aaaa1111', size: 2_000_000_000 }], loaded: [] };
  const provider = createOllamaModelRemoveProvider({
    fetchImpl: stateBackedFetch(state), modelSnapshot: { blobSharing: { 'aaaa1111': 1 } },
    routes: [{ route: 'implementation', model: 'llama3.2:3b' }],
  });
  const facts = await provider.detect();
  const missingRoute = provider.actionFor(modelFinding('llama3.2:3b', {
    consumers: { complete: true, list: [] },
  }), facts);
  assert.equal(missingRoute, null, 'a live route not reflected in the finding blocks the Managed action');

  const covered = provider.actionFor(modelFinding('llama3.2:3b', {
    consumers: { complete: true, list: [{ kind: 'route', id: 'implementation' }] },
  }), facts);
  assert.ok(covered, 'once the live route is enumerated, removal is eligible');
});

test('MNT-MDL-004: without shared-blob evidence, physical reclaim cannot be proven and removal stays report-only', async () => {
  const state = { tags: [{ name: 'llama3.2:3b', digest: 'aaaa1111', size: 2_000_000_000 }], loaded: [] };
  const withoutSnapshot = createOllamaModelRemoveProvider({ fetchImpl: stateBackedFetch(state) });
  const facts = await withoutSnapshot.detect();
  assert.equal(withoutSnapshot.actionFor(modelFinding('llama3.2:3b'), facts), null);

  const withPartialSnapshot = createOllamaModelRemoveProvider({
    fetchImpl: stateBackedFetch(state), modelSnapshot: { blobSharing: {} },
  });
  assert.equal(withPartialSnapshot.actionFor(modelFinding('llama3.2:3b'), await withPartialSnapshot.detect()), null);
});

test('MNT-MDL-004: a shared blob reports zero physically reclaimable bytes without double counting', async () => {
  const state = { tags: [{ name: 'llama3.2:3b', digest: 'cccc3333', size: 2_000_000_000 }], loaded: [] };
  const provider = createOllamaModelRemoveProvider({
    fetchImpl: stateBackedFetch(state), modelSnapshot: { blobSharing: { 'cccc3333': 3 } },
  });
  const facts = await provider.detect();
  const action = provider.actionFor(modelFinding('llama3.2:3b'), facts);
  assert.ok(action);
  assert.equal(action.impact.bytes, 0, 'a shared blob reclaims nothing physically for this one model');
  assert.match(action.impact.summary, /shared with 2 other model/i);
});

test('a digest mismatch refuses removal (exact revision identity required)', async () => {
  const state = { tags: [{ name: 'llama3.2:3b', digest: 'aaaa1111', size: 2_000_000_000 }], loaded: [] };
  const provider = createOllamaModelRemoveProvider({
    fetchImpl: stateBackedFetch(state), modelSnapshot: { blobSharing: { 'aaaa1111': 1 } },
  });
  const facts = await provider.detect();
  const action = provider.actionFor(modelFinding('llama3.2:3b', { expectedDigest: 'dddd4444' }), facts);
  assert.equal(action, null);
});

test('a namespaced model name that cannot be represented in a bounded resource identity is excluded, and marks detection incomplete', async () => {
  const state = {
    tags: [
      { name: 'org/model:latest', digest: 'eeee5555', size: 1_000_000 },
      { name: 'llama3.2:3b', digest: 'aaaa1111', size: 2_000_000_000 },
    ],
    loaded: [],
  };
  const provider = createOllamaModelRemoveProvider({
    fetchImpl: stateBackedFetch(state), modelSnapshot: { blobSharing: { 'aaaa1111': 1 } },
  });
  const facts = await provider.detect();
  assert.equal(facts.tags.some((row) => row.name.includes('/')), false);
  assert.equal(facts.complete, false, 'an unrepresentable row marks the whole detection incomplete (fail-closed)');
  assert.equal(provider.actionFor(modelFinding('llama3.2:3b'), facts), null);
});

test('a non-loopback endpoint is refused outright', async () => {
  const provider = createOllamaModelRemoveProvider({
    baseUrl: 'http://example.com:11434',
    fetchImpl: async () => { throw new Error('must never be called for a non-loopback endpoint'); },
  });
  const facts = await provider.detect();
  assert.equal(facts.status, 'unavailable');
  assert.equal(facts.complete, false);
});

test('an oversized response is refused rather than parsed', async () => {
  const oversized = 'x'.repeat(300 * 1024);
  const provider = createOllamaModelRemoveProvider({
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => Buffer.from(`{"models":[],"pad":"${oversized}"}`) }),
  });
  const facts = await provider.detect();
  assert.equal(facts.status, 'unavailable');
});

test('one model per action: actionFor never derives a batched removal for multiple resources', async () => {
  const state = {
    tags: [
      { name: 'llama3.2:3b', digest: 'aaaa1111', size: 2_000_000_000 },
      { name: 'phi3:mini', digest: 'ffff6666', size: 1_500_000_000 },
    ],
    loaded: [],
  };
  const provider = createOllamaModelRemoveProvider({
    fetchImpl: stateBackedFetch(state),
    modelSnapshot: { blobSharing: { 'aaaa1111': 1, 'ffff6666': 1 } },
  });
  const facts = await provider.detect();
  const actionA = provider.actionFor(modelFinding('llama3.2:3b'), facts);
  const actionB = provider.actionFor(modelFinding('phi3:mini'), facts);
  assert.notEqual(actionA.resourceIdentity.name, actionB.resourceIdentity.name);
  assert.equal(actionA.resourceIdentity.name, 'llama3.2:3b');
});

test('inspectCurrent proves presence and absence for interruption-audit reuse, and never elevates', async () => {
  const state = { tags: [{ name: 'llama3.2:3b', digest: 'aaaa1111', size: 2_000_000_000 }], loaded: [] };
  const calls = [];
  const provider = createOllamaModelRemoveProvider({
    fetchImpl: stateBackedFetch(state), run: stateBackedRun(state, calls),
    modelSnapshot: { blobSharing: { 'aaaa1111': 1 } },
  });
  const facts = await provider.detect();
  const action = provider.actionFor(modelFinding('llama3.2:3b'), facts);
  const before = await provider.inspectCurrent(action);
  assert.equal(before.complete, true);
  await provider.apply(action);
  const after = await provider.inspectCurrent(action);
  assert.equal(after.complete, true);
  assert.notEqual(before.postFingerprint, after.postFingerprint);
  assert.equal(calls.every((call) => !call.args.includes('sudo')), true);
});

test('the provider declares its network and privilege posture', () => {
  const provider = createOllamaModelRemoveProvider({});
  assert.equal(provider.id, 'ollama-model');
  assert.equal(provider.network, 'loopback-only');
  assert.equal(provider.privilege, 'none');
  assert.deepEqual(provider.resourceKinds, ['model']);
  assert.deepEqual(provider.operations, ['remove']);
  assert.deepEqual(provider.rollback, ['irreversible']);
});

test('detect() bounds an absent/unresponsive daemon to one short deadline by fetching /api/tags and /api/ps concurrently', async () => {
  const requested = [];
  const neverResolves = (url, options) => {
    requested.push(new URL(url).pathname);
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    });
  };
  const provider = createOllamaModelRemoveProvider({ fetchImpl: neverResolves });
  const startedAt = Date.now();
  const facts = await provider.detect();
  const elapsedMs = Date.now() - startedAt;
  assert.equal(facts.status, 'unavailable');
  assert.equal(facts.complete, false);
  assert.ok(elapsedMs < 1500, `detect() took ${elapsedMs}ms; a default-registered, always-on provider must never add more than one short deadline to a scan`);
  assert.deepEqual([...requested].sort(), ['/api/ps', '/api/tags'], 'both endpoints are requested concurrently, not one after the other');
});

test('createDefaultMaintenanceProviderRegistry registers ollama-model by default and its detect() never throws when Ollama is absent', async () => {
  const { createDefaultMaintenanceProviderRegistry } = await import('../../src/lib/maintenance/provider-registry.mjs');
  const registry = createDefaultMaintenanceProviderRegistry({
    ollamaModel: { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } },
  });
  const provider = registry.get('ollama-model');
  assert.ok(provider);
  const facts = await provider.detect();
  assert.equal(facts.status, 'unavailable');
  assert.equal(facts.complete, false);
});
