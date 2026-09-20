import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAqeEmbeddingIntent, selectAqeEmbeddingIntent, resolveAqeEmbedding } from '../../src/lib/aqe-embedding-config.mjs';

test('legacy configuration stays unmanaged until setup selects a backend', () => {
  assert.equal(resolveAqeEmbedding({}, {}).mode, 'unmanaged');
  assert.deepEqual(selectAqeEmbeddingIntent({}, {}), {
    mode: 'endpoint', endpoint: 'http://127.0.0.1:11434', provisioning: 'ollama',
  });
});

test('setup preserves explicit endpoint and local backend choices', () => {
  const intent = { mode: 'in-process' };
  assert.deepEqual(selectAqeEmbeddingIntent({ aqeEmbedding: intent }, {}), intent);
  assert.deepEqual(selectAqeEmbeddingIntent({ aqeEmbedding: { mode: 'unmanaged' } }, {}), { mode: 'unmanaged' });
  assert.deepEqual(selectAqeEmbeddingIntent({}, { AQE_EMBEDDER_ENDPOINT: 'https://embeddings.example' }), {
    mode: 'endpoint', endpoint: 'https://embeddings.example', provisioning: 'external',
  });
});

test('malformed or secret-bearing intent never enters persisted configuration', () => {
  for (const endpoint of [null, 42, 'https://example.com/\n', 'https://example.com/' + 'a'.repeat(2050)]) {
    assert.throws(() => validateAqeEmbeddingIntent({ mode: 'endpoint', endpoint }));
  }
  for (const endpoint of ['http://remote.example', 'http://user:password@localhost', 'http://localhost/v1',
    'https://example.com?token=x', 'unix:relative', 'unix:/tmp/../secret', 'https://example.com#x']) {
    assert.throws(() => validateAqeEmbeddingIntent({ mode: 'endpoint', endpoint }));
  }
  assert.throws(() => validateAqeEmbeddingIntent({ mode: 'endpoint', endpoint: 'http://localhost', token: 'secret' }));
  assert.throws(() => validateAqeEmbeddingIntent({ mode: 'endpoint', endpoint: 'https://example.com', provisioning: 'ollama' }));
  assert.throws(() => validateAqeEmbeddingIntent({ mode: 'endpoint', endpoint: 'https://example.com', provisioning: 'auto' }));
  assert.throws(() => validateAqeEmbeddingIntent({ mode: 'in-process', endpoint: 'http://localhost' }));
  assert.throws(() => validateAqeEmbeddingIntent(null));
  assert.throws(() => validateAqeEmbeddingIntent([]));
  assert.throws(() => validateAqeEmbeddingIntent({ mode: 'hash' }));
});

test('explicit in-process clears endpoint while unmanaged preserves caller environment', () => {
  const env = { AQE_EMBEDDER_ENDPOINT: 'http://localhost:11434', OTHER: 'preserved' };
  assert.equal(resolveAqeEmbedding({ aqeEmbedding: { mode: 'in-process' } }, env).env.AQE_EMBEDDER_ENDPOINT, '');
  assert.deepEqual(resolveAqeEmbedding({}, env).env, env);
  assert.equal(env.AQE_EMBEDDER_ENDPOINT, 'http://localhost:11434');
});

test('configured endpoint governs kit children and exposes ambient conflict without secrets', () => {
  const r = resolveAqeEmbedding({ aqeEmbedding: { mode: 'endpoint', endpoint: 'unix:/tmp/aqe.sock' } },
    { AQE_EMBEDDER_ENDPOINT: 'http://localhost:11434', AQE_EMBEDDER_TOKEN: 'private' });
  assert.equal(r.env.AQE_EMBEDDER_ENDPOINT, 'unix:/tmp/aqe.sock');
  assert.equal(r.ambientConflict, true);
  assert.equal(r.env.AQE_EMBEDDER_TOKEN, 'private');
});
