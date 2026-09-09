import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { probeAqeEmbeddings } from '../../src/lib/aqe-embedding-probe.mjs';

const env = { AQE_EMBEDDER_ENDPOINT: 'http://127.0.0.1:11434', AQE_EMBEDDER_TOKEN: 'private-token' };
function fixture(t, body) {
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-embedding-client-'));
  t.after(() => fs.rmSync(packageRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(packageRoot, 'dist/learning'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(packageRoot, 'dist/learning/embedder-endpoint-client.js'), body);
  return packageRoot;
}

test('an absent endpoint is unconfigured and never inferred from local services', async () => {
  assert.deepEqual(await probeAqeEmbeddings({ env: {} }), { status: 'not-configured', reason: 'embedding-endpoint-not-configured' });
});

test('rejects credentials, paths and non-HTTP endpoints without echoing their contents', async () => {
  for (const endpoint of ['http://user:private-token@localhost', 'http://localhost/v1', 'http://localhost/?token=private-token', 'file:///private-token']) {
    const result = await probeAqeEmbeddings({ env: { AQE_EMBEDDER_ENDPOINT: endpoint } });
    assert.equal(result.status, 'invalid-config');
    assert.equal(JSON.stringify(result).includes('private-token'), false);
  }
});

test('missing installed endpoint client and unbounded timeouts are explicit', async () => {
  assert.equal((await probeAqeEmbeddings({ env, packageRoot: '/missing-aqe-client' })).status, 'unavailable');
  assert.equal((await probeAqeEmbeddings({ env, timeoutMs: 30_001 })).status, 'invalid-config');
});

test('uses the installed client, closes it, and reports semantic evidence without raw vectors', async (t) => {
  const packageRoot = fixture(t, `import fs from 'node:fs';
    export class EmbedderEndpointClient {
      constructor(options) { if (options.model !== 'Xenova/all-MiniLM-L6-v2' || options.expectedDim !== 384 || options.token !== 'private-token') throw Error('bad options'); }
      async probe() { return { dim: 384, fingerprint: '0123456789abcdef', endpoint: 'private-token' }; }
      async embed(texts) { if (texts.length !== 3) throw Error('bad inputs');
        const a = Array(384).fill(0); a[0] = 1;
        const b = Array(384).fill(0); b[0] = 0.8; b[1] = 0.6;
        const c = Array(384).fill(0); c[2] = 1;
        return [a, b, c]; }
      close() { fs.writeFileSync(new URL('../../closed', import.meta.url), 'closed'); }
    }`);
  const result = await probeAqeEmbeddings({ env, packageRoot });
  assert.equal(result.status, 'passed');
  assert.equal(result.dimension, 384);
  assert.equal(result.relatedSimilarity, 0.8);
  assert.equal(result.unrelatedSimilarity, 0);
  assert.equal(result.fingerprint, '0123456789abcdef');
  assert.equal(fs.readFileSync(path.join(packageRoot, 'closed'), 'utf8'), 'closed');
  assert.equal(JSON.stringify(result).includes('private-token'), false);
});

test('dimension failures are reported without echoing endpoint errors or tokens', async (t) => {
  const packageRoot = fixture(t, `export class EmbedderEndpointClient {
    async probe() { throw Error('dim mismatch: private-token http://secret.invalid'); }
    close() {}
  }`);
  const result = await probeAqeEmbeddings({ env, packageRoot });
  assert.equal(result.reason, 'dimension-mismatch');
  assert.equal(JSON.stringify(result).includes('private-token'), false);
  assert.equal(JSON.stringify(result).includes('secret.invalid'), false);
});

test('constant fabricated vectors fail the semantic smoke check', async (t) => {
  const packageRoot = fixture(t, `export class EmbedderEndpointClient {
    async probe() { return { dim: 384, fingerprint: '0123456789abcdef' }; }
    async embed() { return Array.from({length: 3}, () => Array(384).fill(1)); }
    close() {}
  }`);
  assert.equal((await probeAqeEmbeddings({ env, packageRoot })).reason, 'semantic-smoke-failed');
});

test('a stalled client is terminated by the overall deadline', async (t) => {
  const packageRoot = fixture(t, `export class EmbedderEndpointClient {
    async probe() { await new Promise(resolve => setTimeout(resolve, 60000)); }
    close() {}
  }`);
  const result = await probeAqeEmbeddings({ env, packageRoot, timeoutMs: 200 });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'probe-process-failed-or-timed-out');
  assert.ok(result.elapsedMs < 3000);
});
