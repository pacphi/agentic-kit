import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateExecutionAdapter, validateWorkerResult } from '../../src/lib/execution/schema.mjs';

const adapter = () => ({
  id: 'test-host',
  readiness() {}, prepare() {}, launch() {}, observe() {}, interpret() {}, summarize() {}, cancel() {}, cleanup() {},
});

const result = () => ({
  workerId: 'worker-1', activity: 'implementation', role: 'coder', host: 'opencode',
  status: 'blocked', exitCategory: 'permission_required',
  startedAt: '2026-07-29T00:00:00.000Z', endedAt: '2026-07-29T00:00:01.000Z', durationMs: 1000,
  provider: null, providerProvenance: 'unknown', configuredModel: 'openrouter/example', observedModel: null,
  sessionId: null, transcriptRefs: [], failure: null, usage: null,
});

test('execution adapters must implement the complete host-neutral lifecycle', () => {
  assert.equal(validateExecutionAdapter(adapter()).id, 'test-host');
  const incomplete = adapter();
  delete incomplete.summarize;
  assert.throws(() => validateExecutionAdapter(incomplete), /executionAdapter.summarize/);
});

test('worker results preserve unknown provider facts instead of inferring from the host', () => {
  const out = validateWorkerResult(result());
  assert.equal(out.provider, null);
  assert.equal(out.providerProvenance, 'unknown');
  assert.throws(() => validateWorkerResult({ ...result(), providerProvenance: 'inferred' }), /must be unknown/);
});

test('worker results require a bounded terminal category and timing evidence', () => {
  assert.throws(() => validateWorkerResult({ ...result(), exitCategory: 'made-up' }), /exitCategory/);
  assert.throws(() => validateWorkerResult({ ...result(), durationMs: -1 }), /non-negative/);
});
