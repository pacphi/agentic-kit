// intel-history.mjs — readers for the neural pattern store, the graph
// snapshot history, the neural global stats counters, and the machine-health
// ring, plus the append-with-dedup writer for that ring. Fixtures are written
// under an isolated mkdtempSync() dir shaped like a real project's
// .claude-flow/ tree; no real project files are ever touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readNeuralPatternStoreHistory,
  readGraphHistory,
  readGlobalStats,
  readHealthRing,
  appendHealthSnapshot,
  readIntelHistory,
} from '../../src/lib/dashboard/intel-history.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ak-intel-history-'));

/** Write `content` (object → JSON.stringify'd, string → written verbatim so
 *  malformed-JSON fixtures are easy to express) at cwd-relative `relPath`,
 *  creating parent dirs as needed. */
function writeFixture(cwd, relPath, content) {
  const file = path.join(cwd, relPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

// ── readNeuralPatternStoreHistory ───────────────────────────────────────────

test('readNeuralPatternStoreHistory reads the top-level array shape and maps createdAt/type', () => {
  const cwd = tmp();
  writeFixture(cwd, '.claude-flow/neural/patterns.json', [
    { id: 'a', type: 'action', createdAt: 1780024063013, embedding: [1, 2], content: 'x' },
    { id: 'b', type: 'result', createdAt: 1783106501523, embedding: [3, 4], content: 'y' },
  ]);
  const rows = readNeuralPatternStoreHistory(cwd);
  assert.deepEqual(rows, [
    { createdAt: new Date(1780024063013).toISOString(), type: 'action' },
    { createdAt: new Date(1783106501523).toISOString(), type: 'result' },
  ]);
});

test('readNeuralPatternStoreHistory defaults a missing type to null and drops entries with no resolvable createdAt', () => {
  const cwd = tmp();
  writeFixture(cwd, '.claude-flow/neural/patterns.json', [
    { id: 'no-type', createdAt: 1780024063013 },
    { id: 'no-timestamp', type: 'action' },
    { id: 'bad-timestamp', type: 'action', createdAt: 'not-a-date' },
  ]);
  const rows = readNeuralPatternStoreHistory(cwd);
  assert.deepEqual(rows, [
    { createdAt: new Date(1780024063013).toISOString(), type: null },
  ]);
});

test('readNeuralPatternStoreHistory returns [] for a missing file', () => {
  const cwd = tmp();
  assert.deepEqual(readNeuralPatternStoreHistory(cwd), []);
});

test('readNeuralPatternStoreHistory returns [] for malformed JSON text', () => {
  const cwd = tmp();
  writeFixture(cwd, '.claude-flow/neural/patterns.json', '{not valid json');
  assert.deepEqual(readNeuralPatternStoreHistory(cwd), []);
});

test('readNeuralPatternStoreHistory returns [] when the file is an object, not a top-level array', () => {
  const cwd = tmp();
  writeFixture(cwd, '.claude-flow/neural/patterns.json', { patterns: [{ id: 'a', type: 'action', createdAt: 1 }] });
  assert.deepEqual(readNeuralPatternStoreHistory(cwd), []);
});

// ── readGraphHistory ─────────────────────────────────────────────────────

test('readGraphHistory projects each sample down to the four scalar fields', () => {
  const cwd = tmp();
  writeFixture(cwd, '.claude-flow/data/intelligence-snapshot.json', [
    { timestamp: 1785257673755, nodes: 55, edges: 128, pageRankSum: 1, confidences: [0.5], topPatterns: [{ id: 'x' }] },
  ]);
  const rows = readGraphHistory(cwd);
  assert.deepEqual(rows, [
    { timestamp: 1785257673755, nodes: 55, edges: 128, pageRankSum: 1 },
  ]);
});

test('readGraphHistory returns null for a missing file', () => {
  const cwd = tmp();
  assert.equal(readGraphHistory(cwd), null);
});

test('readGraphHistory returns null when the file is not a JSON array', () => {
  const cwd = tmp();
  writeFixture(cwd, '.claude-flow/data/intelligence-snapshot.json', { not: 'an array' });
  assert.equal(readGraphHistory(cwd), null);
});

test('readGraphHistory returns null for malformed JSON text', () => {
  const cwd = tmp();
  writeFixture(cwd, '.claude-flow/data/intelligence-snapshot.json', 'not json at all');
  assert.equal(readGraphHistory(cwd), null);
});

// ── readGlobalStats ──────────────────────────────────────────────────────

test('readGlobalStats reads .claude-flow/neural/stats.json with the same ?? 0 defaulting status.mjs uses', () => {
  const cwd = tmp();
  writeFixture(cwd, '.claude-flow/neural/stats.json', {
    trajectoriesRecorded: 1400,
    patternsLearned: 1337,
    signalsProcessed: 1266,
    lastAdaptation: 1785915702033,
  });
  assert.deepEqual(readGlobalStats(cwd), {
    patternsLearned: 1337,
    trajectoriesRecorded: 1400,
    signalsProcessed: 1266,
    lastAdaptation: 1785915702033,
  });
});

test('readGlobalStats defaults missing numeric fields to 0', () => {
  const cwd = tmp();
  writeFixture(cwd, '.claude-flow/neural/stats.json', { patternsLearned: 5 });
  assert.deepEqual(readGlobalStats(cwd), {
    patternsLearned: 5,
    trajectoriesRecorded: 0,
    signalsProcessed: 0,
    lastAdaptation: 0,
  });
});

test('readGlobalStats returns null for a missing file', () => {
  const cwd = tmp();
  assert.equal(readGlobalStats(cwd), null);
});

test('readGlobalStats returns null for malformed JSON text', () => {
  const cwd = tmp();
  writeFixture(cwd, '.claude-flow/neural/stats.json', '{ broken');
  assert.equal(readGlobalStats(cwd), null);
});

// ── readHealthRing ───────────────────────────────────────────────────────

test('readHealthRing accepts a bare array', () => {
  const cwd = tmp();
  const samples = [{ ts: 1, ok: true }, { ts: 2, ok: false }];
  writeFixture(cwd, '.claude-flow/health-history.json', samples);
  assert.deepEqual(readHealthRing(cwd), samples);
});

test('readHealthRing accepts an object with a samples array', () => {
  const cwd = tmp();
  const samples = [{ ts: 1, ok: true }];
  writeFixture(cwd, '.claude-flow/health-history.json', { samples });
  assert.deepEqual(readHealthRing(cwd), samples);
});

test('readHealthRing returns null for a missing file', () => {
  const cwd = tmp();
  assert.equal(readHealthRing(cwd), null);
});

test('readHealthRing returns null for an empty array', () => {
  const cwd = tmp();
  writeFixture(cwd, '.claude-flow/health-history.json', []);
  assert.equal(readHealthRing(cwd), null);
});

test('readHealthRing returns null for malformed JSON text', () => {
  const cwd = tmp();
  writeFixture(cwd, '.claude-flow/health-history.json', 'not json');
  assert.equal(readHealthRing(cwd), null);
});

// ── appendHealthSnapshot ─────────────────────────────────────────────────

test('appendHealthSnapshot creates the file fresh, seeded with just this snapshot', () => {
  const cwd = tmp();
  const file = path.join(cwd, '.claude-flow', 'health-history.json');
  assert.equal(fs.existsSync(file), false);
  appendHealthSnapshot(cwd, { ts: 100, patternsLearned: 5, trajectoriesRecorded: 2, signalsProcessed: 1 });
  assert.equal(fs.existsSync(file), true);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(onDisk, {
    samples: [{ ts: 100, patternsLearned: 5, trajectoriesRecorded: 2, signalsProcessed: 1 }],
  });
  assert.deepEqual(readHealthRing(cwd), [{ ts: 100, patternsLearned: 5, trajectoriesRecorded: 2, signalsProcessed: 1 }]);
});

test('appendHealthSnapshot dedups: an identical snapshot (aside from ts) appended twice leaves the ring length unchanged', () => {
  const cwd = tmp();
  appendHealthSnapshot(cwd, { ts: 1, patternsLearned: 5, trajectoriesRecorded: 2, signalsProcessed: 1 });
  appendHealthSnapshot(cwd, { ts: 2, patternsLearned: 5, trajectoriesRecorded: 2, signalsProcessed: 1 });
  const ring = readHealthRing(cwd);
  assert.equal(ring.length, 1);
  assert.equal(ring[0].ts, 1); // second call was a no-op; the original row stands
});

test('appendHealthSnapshot appends a new row when a field actually changed', () => {
  const cwd = tmp();
  appendHealthSnapshot(cwd, { ts: 1, patternsLearned: 5, trajectoriesRecorded: 2, signalsProcessed: 1 });
  appendHealthSnapshot(cwd, { ts: 2, patternsLearned: 6, trajectoriesRecorded: 2, signalsProcessed: 1 });
  const ring = readHealthRing(cwd);
  assert.equal(ring.length, 2);
  assert.equal(ring[1].patternsLearned, 6);
});

test('appendHealthSnapshot caps the ring at 500 entries, dropping the oldest first', () => {
  const cwd = tmp();
  for (let i = 0; i <= 500; i++) {
    appendHealthSnapshot(cwd, { ts: i, patternsLearned: i, trajectoriesRecorded: 0, signalsProcessed: 0 });
  }
  const ring = readHealthRing(cwd);
  assert.equal(ring.length, 500);
  assert.equal(ring[0].patternsLearned, 1); // entry 0 was evicted
  assert.equal(ring[ring.length - 1].patternsLearned, 500);
});

// ── readIntelHistory (combinator) ────────────────────────────────────────

test('readIntelHistory combines all four readers', () => {
  const cwd = tmp();
  writeFixture(cwd, '.claude-flow/neural/patterns.json', [{ id: 'a', type: 'action', createdAt: 1780024063013 }]);
  writeFixture(cwd, '.claude-flow/data/intelligence-snapshot.json', [{ timestamp: 1, nodes: 2, edges: 3, pageRankSum: 1 }]);
  writeFixture(cwd, '.claude-flow/neural/stats.json', { patternsLearned: 9 });
  writeFixture(cwd, '.claude-flow/health-history.json', [{ ts: 1 }]);

  assert.deepEqual(readIntelHistory(cwd), {
    patternStore: readNeuralPatternStoreHistory(cwd),
    graph: readGraphHistory(cwd),
    healthRing: readHealthRing(cwd),
    globalStats: readGlobalStats(cwd),
  });
});

test('readIntelHistory tolerates every source being absent', () => {
  const cwd = tmp();
  assert.deepEqual(readIntelHistory(cwd), {
    patternStore: [],
    graph: null,
    healthRing: null,
    globalStats: null,
  });
});
