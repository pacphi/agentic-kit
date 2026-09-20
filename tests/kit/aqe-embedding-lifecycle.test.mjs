import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareAqeEmbedding } from '../../src/lib/aqe-embedding-lifecycle.mjs';

const local = { aqe: true, aqeEmbedding: { mode: 'endpoint', endpoint: 'http://127.0.0.1:11434', provisioning: 'ollama' } };
const pass = async () => ({ status: 'passed', dimension: 384, fingerprint: '0123456789abcdef' });

test('local setup downloads missing model, creates AQE alias, then proves embeddings', async () => {
  const calls = [];
  const r = await prepareAqeEmbedding(local, { probe: pass, request: async (route, body) => {
    calls.push([route, body]);
    if (route === '/api/tags') return { models: [] };
    return {};
  } });
  assert.equal(r.ok, true);
  assert.deepEqual(calls.map(c => c[0]), ['/api/tags', '/api/pull', '/api/tags', '/api/copy']);
  assert.equal(calls[1][1].model, 'all-minilm:22m');
  assert.equal(calls[3][1].destination, 'Xenova/all-MiniLM-L6-v2');
});

test('an alias created during the download is preserved', async () => {
  let downloaded = false;
  const calls = [];
  await prepareAqeEmbedding(local, { probe: pass, request: async route => {
    calls.push(route);
    if (route === '/api/pull') { downloaded = true; return {}; }
    return { models: downloaded ? [{ name: 'Xenova/all-MiniLM-L6-v2:latest' }] : [] };
  } });
  assert.equal(calls.includes('/api/copy'), false);
});

test('repeated setup preserves an existing alias and performs no model writes', async () => {
  const calls = [];
  const r = await prepareAqeEmbedding(local, { probe: pass, request: async route => {
    calls.push(route); return { models: [{ name: 'Xenova/all-MiniLM-L6-v2:latest' }] };
  } });
  assert.equal(r.ok, true);
  assert.deepEqual(calls, ['/api/tags']);
});

test('missing service gives actionable incomplete setup instead of hash fallback', async () => {
  let probed = false;
  const r = await prepareAqeEmbedding(local, { probe: async () => { probed = true; }, request: async () => { throw Error('secret raw error'); } });
  assert.equal(r.ok, false);
  assert.match(r.detail, /Ollama/);
  assert.equal(r.detail.includes('secret'), false);
  assert.equal(probed, false);
});

test('external backends are never provisioned and failed semantic checks remain failed', async () => {
  const cfg = { aqeEmbedding: { mode: 'endpoint', endpoint: 'https://example.com' } };
  const r = await prepareAqeEmbedding(cfg, { request: async () => { throw Error('must not run'); },
    probe: async () => ({ status: 'failed', reason: 'model-unavailable' }) });
  assert.equal(r.ok, false);
  assert.match(r.detail, /model-unavailable/);
});

test('unmanaged and disabled AQE do not download, probe or enroll', async () => {
  for (const cfg of [{}, { ...local, aqe: false }]) {
    const r = await prepareAqeEmbedding(cfg, { request: async () => assert.fail(), probe: async () => assert.fail() });
    assert.equal(r.status, 'skipped');
  }
});

test('read-only mode never downloads missing models', async () => {
  const calls = [];
  const r = await prepareAqeEmbedding(local, { provision: false, request: async route => { calls.push(route); }, probe: pass });
  assert.equal(r.ok, true);
  assert.deepEqual(calls, []);
});
test('read-only verification can inspect an explicit ambient endpoint without enrolling it', async () => {
  const cfg = {};
  const r = await prepareAqeEmbedding(cfg, { provision: false,
    env: { AQE_EMBEDDER_ENDPOINT: 'http://localhost:11434' }, probe: pass,
    request: async () => assert.fail() });
  assert.equal(r.status, 'ok');
  assert.deepEqual(cfg, {});
});
