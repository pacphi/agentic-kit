import { test } from 'node:test';
import assert from 'node:assert/strict';
import { embeddingIntentFromFlags, embeddingSetupDisclosure } from '../../src/lib/aqe-embedding-setup.mjs';
import { setupTrustManifest } from '../../src/lib/trust-manifest.mjs';

test('fresh install offers local MiniLM and discloses download and prerequisite', () => {
  const intent = embeddingIntentFromFlags({}, {}, {});
  assert.equal(intent.provisioning, 'ollama');
  assert.match(embeddingSetupDisclosure(intent), /45 MB/);
  assert.match(embeddingSetupDisclosure(intent), /already be installed/);
  assert.ok(setupTrustManifest({ aqe: true, aqeEmbedding: intent }).some(group => group.companionId === 'aqe-embedding'));
});

test('explicit alternatives do not silently return to the local default', () => {
  for (const mode of ['in-process', 'unmanaged']) {
    assert.equal(embeddingIntentFromFlags({}, { 'aqe-embedding-mode': mode }, {}).mode, mode);
  }
  assert.equal(embeddingIntentFromFlags({}, { 'aqe-embedding-endpoint': 'https://embed.example' }, {}).provisioning, 'external');
});

test('conflicting backend flags fail before any installation', () => {
  assert.throws(() => embeddingIntentFromFlags({}, { 'aqe-embedding-mode': 'hash' }, {}));
  assert.throws(() => embeddingIntentFromFlags({}, { 'aqe-embedding-mode': 'in-process', 'aqe-embedding-endpoint': 'http://localhost' }, {}));
  assert.throws(() => embeddingIntentFromFlags({}, { 'aqe-embedding-mode': 'endpoint' }, {}));
});
