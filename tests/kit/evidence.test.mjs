import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  sandboxHome, assertSandboxed, snapshot, assertUnchanged, rmrf,
} from './helpers/home-sandbox.mjs';

const HOME = sandboxHome('ak-evidence');
const paths = await import('../../src/lib/paths.mjs');
const evidence = await import('../../src/lib/evidence.mjs');
assertSandboxed(paths, HOME);

const NOW = Date.parse('2026-09-26T12:00:00Z');
const MINUTE = 60_000;
const reset = () => rmrf(evidence.evidenceDir());

test('evidence files are stored under the kit state directory', () => {
  assert.ok(evidence.evidenceDir().startsWith(HOME), 'evidence must never escape the state base');
  assert.equal(path.basename(evidence.evidenceDir()), 'evidence');
});

test('evidenceFile returns kind/id.json path in evidence dir', () => {
  const file = evidence.evidenceFile('aqe', 'v1.2.3');
  assert.ok(file.startsWith(evidence.evidenceDir()), 'must be under evidence dir');
  assert.ok(file.endsWith('.json'), 'must be json');
  assert.ok(file.includes(path.join('aqe', 'v1.2.3.json')), 'must include kind/id.json structure');
});

test('evidenceFile sanitizes id by replacing path separators and unsafe chars', () => {
  const file = evidence.evidenceFile('test-kind', '@claude-flow/memory');
  assert.ok(file.endsWith(path.join('test-kind', '@claude-flow_memory.json')), 'must replace / with _');

  const fileTraversal = evidence.evidenceFile('kind', 'a/b\\c:d');
  assert.ok(fileTraversal.endsWith(path.join('kind', 'a_b_c_d.json')), 'must replace /, \\, : with _');
  assert.ok(!fileTraversal.includes('a/b'), 'must not preserve path separators in id');
});

test('stableInputsKey produces a stable, short hash for objects and arrays', () => {
  const key1 = evidence.stableInputsKey({ b: 2, a: 1 });
  const key2 = evidence.stableInputsKey({ a: 1, b: 2 });
  assert.equal(key1, key2, 'key must be stable regardless of object key order');
  assert.match(key1, /^[a-f0-9]{16}$/, 'key must be a 16-char hex string');

  const key3 = evidence.stableInputsKey([1, 2, 3]);
  assert.match(key3, /^[a-f0-9]{16}$/, 'arrays must also produce a 16-char hex');
  assert.notEqual(key1, key3, 'different inputs must produce different keys');
});

test('stableInputsKey handles null, primitive values, and nested structures', () => {
  const nullKey = evidence.stableInputsKey(null);
  const undefinedKey = evidence.stableInputsKey(undefined);
  assert.equal(nullKey, undefinedKey, 'null and undefined must be treated the same');

  const nested = { outer: { inner: { value: 42 } } };
  assert.match(evidence.stableInputsKey(nested), /^[a-f0-9]{16}$/);
});

test('describeAge formats milliseconds as human-readable strings', () => {
  assert.equal(evidence.describeAge(0), 'just now');
  assert.equal(evidence.describeAge(30_000), 'just now');
  assert.equal(evidence.describeAge(60_000), '1m ago');
  assert.equal(evidence.describeAge(5 * 60_000), '5m ago');
  assert.equal(evidence.describeAge(90 * 60_000), '1h ago');
  assert.equal(evidence.describeAge(3 * 60 * 60_000), '3h ago');
  assert.equal(evidence.describeAge(48 * 60 * 60_000), '2d ago');
});

test('describeAge handles negative ages (clock skew) as zero', () => {
  assert.equal(evidence.describeAge(-1000), 'just now');
});

test('round-trip: writeEvidence then readEvidence returns the same data', () => {
  reset();
  const input = {
    source: 'my-checker',
    inputsKey: 'abc123',
    inputs: { config: 'value', nested: { key: 123 } },
    result: { status: 'passed', detail: 'OK' },
  };
  const written = evidence.writeEvidence('test-kind', 'test-id', input, { now: NOW });
  assert.equal(written, true, 'write should succeed');

  const read = evidence.readEvidence('test-kind', 'test-id', { inputsKey: 'abc123', now: NOW });
  assert.ok(read, 'read should return a record');
  assert.equal(read.source, input.source);
  assert.deepEqual(read.inputs, input.inputs);
  assert.deepEqual(read.result, input.result);
  assert.equal(read.inputsKey, 'abc123');
  assert.equal(read.version, 1);
  assert.equal(read.kind, 'test-kind');
  assert.equal(read.id, 'test-id');
  assert.equal(read.checkedAt, new Date(NOW).toISOString());
});

test('readEvidence computes ageMs based on checkedAt', () => {
  reset();
  evidence.writeEvidence('test', 'id1', {
    source: 'test',
    inputsKey: 'k1',
    inputs: {},
    result: {},
  }, { now: NOW });

  const read5min = evidence.readEvidence('test', 'id1', { now: NOW + 5 * MINUTE });
  assert.equal(read5min.ageMs, 5 * MINUTE);

  const readSameTime = evidence.readEvidence('test', 'id1', { now: NOW });
  assert.equal(readSameTime.ageMs, 0);
});

test('readEvidence marks record as stale when older than maxAgeMs', () => {
  reset();
  evidence.writeEvidence('test', 'id1', {
    source: 'test',
    inputsKey: 'k1',
    inputs: {},
    result: {},
  }, { now: NOW });

  const stale = evidence.readEvidence('test', 'id1', {
    maxAgeMs: 1 * MINUTE,
    now: NOW + 5 * MINUTE,
  });
  assert.equal(stale.stale, true);

  const fresh = evidence.readEvidence('test', 'id1', {
    maxAgeMs: 10 * MINUTE,
    now: NOW + 5 * MINUTE,
  });
  assert.equal(fresh.stale, false);

  const noMaxAge = evidence.readEvidence('test', 'id1', {
    now: NOW + 5 * MINUTE,
  });
  assert.equal(noMaxAge.stale, false, 'stale is false when maxAgeMs is not passed');
});

test('readEvidence marks record as invalidated when inputsKey differs', () => {
  reset();
  evidence.writeEvidence('test', 'id1', {
    source: 'test',
    inputsKey: 'key-a',
    inputs: {},
    result: {},
  }, { now: NOW });

  const invalidated = evidence.readEvidence('test', 'id1', {
    inputsKey: 'key-b',
  });
  assert.equal(invalidated.invalidated, true);
  assert.equal(invalidated.stale, false, 'stale is false when maxAgeMs not passed');

  const valid = evidence.readEvidence('test', 'id1', {
    inputsKey: 'key-a',
  });
  assert.equal(valid.invalidated, false);

  const noKey = evidence.readEvidence('test', 'id1');
  assert.equal(noKey.invalidated, false, 'invalidated is false when inputsKey not passed');
});

test('writeEvidence returns false when directory is unwritable', () => {
  reset();
  fs.mkdirSync(path.dirname(evidence.evidenceDir()), { recursive: true });
  fs.writeFileSync(evidence.evidenceDir(), 'a file where the directory should be');
  try {
    const result = evidence.writeEvidence('test', 'id1', {
      source: 'test',
      inputsKey: 'k',
      inputs: {},
      result: {},
    });
    assert.equal(result, false, 'should return false, not throw');
  } finally {
    rmrf(evidence.evidenceDir());
  }
});

test('per-id isolation: different ids produce separate files', () => {
  reset();
  evidence.writeEvidence('kind1', 'id-a', {
    source: 'test',
    inputsKey: 'k1',
    inputs: { data: 'a' },
    result: { outcome: 'a' },
  });
  evidence.writeEvidence('kind1', 'id-b', {
    source: 'test',
    inputsKey: 'k1',
    inputs: { data: 'b' },
    result: { outcome: 'b' },
  });

  const readA = evidence.readEvidence('kind1', 'id-a');
  const readB = evidence.readEvidence('kind1', 'id-b');
  assert.equal(readA.result.outcome, 'a');
  assert.equal(readB.result.outcome, 'b');
});

test('readEvidence returns null for missing record', () => {
  reset();
  const result = evidence.readEvidence('nonexistent-kind', 'nonexistent-id');
  assert.equal(result, null);
});

test('readEvidence returns null for corrupt/invalid JSON', () => {
  reset();
  fs.mkdirSync(path.dirname(evidence.evidenceDir()), { recursive: true });
  fs.mkdirSync(evidence.evidenceDir(), { recursive: true });
  fs.mkdirSync(path.join(evidence.evidenceDir(), 'kind1'), { recursive: true });
  fs.writeFileSync(path.join(evidence.evidenceDir(), 'kind1', 'id1.json'), '{not valid json');
  const result = evidence.readEvidence('kind1', 'id1');
  assert.equal(result, null);
});

test('readEvidence is read-only and never writes', () => {
  reset();
  evidence.writeEvidence('test', 'id1', {
    source: 'test',
    inputsKey: 'key-a',
    inputs: {},
    result: {},
  }, { now: NOW });

  const before = snapshot(HOME);
  evidence.readEvidence('test', 'id1', { inputsKey: 'key-b', now: NOW + 10 * MINUTE });
  assertUnchanged(before, HOME, 'reading evidence must never write, even when invalidated');
});

test.after(() => rmrf(HOME));
