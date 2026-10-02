// intel-history.mjs — readers for the neural pattern store, the graph
// snapshot history, the neural global stats counters, and the machine-health
// ring, plus the append-with-dedup writer for that ring. Fixtures are written
// under an isolated mkdtempSync() dir shaped like a real project's
// .claude-flow/ tree; no real project files are ever touched.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cacheDir } from '../../src/lib/paths.mjs';
import {
  healthRingPath,
  readNeuralPatternStoreHistory,
  readGraphHistory,
  readGlobalStats,
  readHealthRing,
  appendHealthSnapshot,
  readIntelHistory,
  readMachineWideIntel,
} from '../../src/lib/dashboard/intel-history.mjs';
import { redirectToolState } from './helpers/home-sandbox.mjs';
import { tempDir } from './helpers/temp-dir.mjs';

// The health ring is cached under the kit's cache folder, so every test here points that folder (and the
// temp folder the projects live in) at a throwaway one instead of the machine's real ~/.cache.
const toolState = redirectToolState('ak-intel-history');
after(() => toolState.restore());

const tmp = () => tempDir('ak-intel-history');
const row = (n, extra = {}) => ({ ts: n, patternsLearned: n, trajectoriesRecorded: 0, signalsProcessed: 0, ...extra });

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
// Older versions kept the ring inside the project, at .claude-flow/health-history.json. It is still read
// (so existing history keeps showing) and never written.

test('readHealthRing accepts a bare array in the project\'s older ring', () => {
  const cwd = tmp();
  const samples = [{ ts: 1, ok: true }, { ts: 2, ok: false }];
  writeFixture(cwd, '.claude-flow/health-history.json', samples);
  assert.deepEqual(readHealthRing(cwd), samples);
});

test('readHealthRing accepts an object with a samples array in the project\'s older ring', () => {
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

test('appendHealthSnapshot caches the ring under the kit cache and writes nothing into the project', () => {
  const cwd = tmp();
  const file = healthRingPath(cwd);
  assert.ok(file.startsWith(path.join(cacheDir(), 'intel-history') + path.sep), file);
  assert.match(path.basename(file), /^[0-9a-f]{16}\.json$/);
  assert.equal(fs.existsSync(file), false);
  const sample = { ts: 100, patternsLearned: 5, trajectoriesRecorded: 2, signalsProcessed: 1 };
  appendHealthSnapshot(cwd, sample);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { project: cwd, samples: [sample] });
  assert.deepEqual(readHealthRing(cwd), [sample]);
  assert.deepEqual(fs.readdirSync(cwd), [], 'the project has no .claude-flow/ or any other new entry');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), [path.basename(file)], 'no backup or temp file is left beside the ring');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'the ring is private');
});

test('an older project ring is read, seeds the cache on the first append, and is never touched', () => {
  const cwd = tmp();
  const old = [row(1), row(2)];
  const oldFile = writeFixture(cwd, '.claude-flow/health-history.json', { samples: old });
  const bytes = fs.readFileSync(oldFile);
  const { mtimeMs } = fs.statSync(oldFile);

  assert.deepEqual(readHealthRing(cwd), old);
  assert.equal(fs.existsSync(healthRingPath(cwd)), false, 'reading writes nothing');
  appendHealthSnapshot(cwd, row(99, { patternsLearned: 2 }));
  assert.equal(fs.existsSync(healthRingPath(cwd)), false, 'a sample identical to the last older one is a no-op');

  appendHealthSnapshot(cwd, row(3));
  assert.deepEqual(readHealthRing(cwd), [...old, row(3)]);
  assert.deepEqual(JSON.parse(fs.readFileSync(healthRingPath(cwd), 'utf8')), { project: cwd, samples: [...old, row(3)] });
  assert.deepEqual(fs.readFileSync(oldFile), bytes, 'the older ring keeps its bytes');
  assert.equal(fs.statSync(oldFile).mtimeMs, mtimeMs, 'and its modification time');
  assert.deepEqual(fs.readdirSync(path.join(cwd, '.claude-flow')), ['health-history.json']);

  fs.writeFileSync(oldFile, JSON.stringify([row(500)]));
  assert.deepEqual(readHealthRing(cwd), [...old, row(3)], 'once the cache has a ring, the older file no longer matters');
});

test('a cached ring written for another project is ignored and replaced', () => {
  const cwd = tmp();
  const file = healthRingPath(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ project: path.join(cwd, 'elsewhere'), samples: [row(1), row(2)] }));
  assert.equal(readHealthRing(cwd), null);
  appendHealthSnapshot(cwd, row(3));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { project: cwd, samples: [row(3)] });
});

test('a cache file that is not a { project, samples } object is ignored', () => {
  for (const content of ['not json', '[{"ts":1}]', '{"samples":[{"ts":1}]}', '{"project":"x","samples":5}', 'null']) {
    const cwd = tmp();
    const file = healthRingPath(cwd);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    assert.equal(readHealthRing(cwd), null, content);
    appendHealthSnapshot(cwd, row(1));
    assert.deepEqual(readHealthRing(cwd), [row(1)], content);
  }
});

test('same-named folders in different places keep separate rings', () => {
  const a = path.join(tmp(), 'app');
  const b = path.join(tmp(), 'app');
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  assert.notEqual(healthRingPath(a), healthRingPath(b));
  appendHealthSnapshot(a, row(1));
  appendHealthSnapshot(b, row(2));
  assert.deepEqual(readHealthRing(a), [row(1)]);
  assert.deepEqual(readHealthRing(b), [row(2)]);
});

test('a symlink to a project shares that project\'s ring', { skip: process.platform === 'win32' }, () => {
  const cwd = tmp();
  const link = path.join(tmp(), 'link');
  fs.symlinkSync(cwd, link, 'dir');
  assert.equal(healthRingPath(link), healthRingPath(cwd));
  appendHealthSnapshot(link, row(1));
  assert.deepEqual(readHealthRing(cwd), [row(1)]);
});

test('appendHealthSnapshot throws when the cache cannot be written, and still writes nothing into the project', (t) => {
  const cwd = tmp();
  const blocker = path.join(tmp(), 'not-a-folder');
  fs.writeFileSync(blocker, '');
  const keys = ['XDG_CACHE_HOME', 'LOCALAPPDATA'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(() => { for (const key of keys) process.env[key] = previous[key]; });
  for (const key of keys) process.env[key] = path.join(blocker, 'cache'); // a folder cannot be made below a file
  assert.throws(() => appendHealthSnapshot(cwd, row(1)));
  assert.deepEqual(fs.readdirSync(cwd), []);
  assert.equal(readHealthRing(cwd), null);
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

// ── readMachineWideIntel ─────────────────────────────────────────────────

test('readMachineWideIntel aggregates totals and perProject rows across multiple fixture projects', () => {
  const cwdAlpha = tmp();
  writeFixture(cwdAlpha, '.claude-flow/neural/patterns.json', [
    { id: 'a1', type: 'action', createdAt: 1 },
    { id: 'a2', type: 'action', createdAt: 2 },
  ]);
  writeFixture(cwdAlpha, '.claude-flow/neural/stats.json', {
    patternsLearned: 10, trajectoriesRecorded: 4, signalsProcessed: 0, lastAdaptation: 1000,
  });
  writeFixture(cwdAlpha, '.claude-flow/data/intelligence-snapshot.json', [
    { timestamp: 1, nodes: 3, edges: 2, pageRankSum: 0.1 },
    { timestamp: 2, nodes: 5, edges: 8, pageRankSum: 0.2 },
  ]);

  const cwdBeta = tmp();
  writeFixture(cwdBeta, '.claude-flow/neural/patterns.json', [
    { id: 'b1', type: 'result', createdAt: 1 },
    { id: 'b2', type: 'result', createdAt: 2 },
    { id: 'b3', type: 'result', createdAt: 3 },
  ]);
  writeFixture(cwdBeta, '.claude-flow/neural/stats.json', {
    patternsLearned: 20, trajectoriesRecorded: 6, signalsProcessed: 0, lastAdaptation: 2000,
  });

  const result = readMachineWideIntel([
    { path: cwdAlpha, label: 'Alpha', learningScope: 'repository' },
    { path: cwdBeta, label: 'Beta', learningScope: 'repository' },
  ]);

  assert.deepEqual(result.totals, {
    patternsLearnedLifetime: 30,
    patternStoreEntries: 5,
    trajectoriesRecorded: 10,
    projectCount: 2,
    mostActiveProject: 'Beta',
  });
  assert.deepEqual(result.perProject, [
    {
      path: cwdAlpha, label: 'Alpha', key: null, learningScope: 'repository', patternsLearned: 10, patternStoreCount: 2,
      trajectoriesRecorded: 4, graphLatest: { nodes: 5, edges: 8 }, lastAdaptation: 1000,
      learningState: [], hosts: [], sessionOrigins: [], sessionSurfaces: null,
    },
    {
      path: cwdBeta, label: 'Beta', key: null, learningScope: 'repository', patternsLearned: 20, patternStoreCount: 3,
      trajectoriesRecorded: 6, graphLatest: null, lastAdaptation: 2000,
      learningState: [], hosts: [], sessionOrigins: [], sessionSurfaces: null,
    },
  ]);
});

test('readMachineWideIntel keeps patternsLearnedLifetime and patternStoreEntries as visibly different sums', () => {
  const cwdAlpha = tmp();
  writeFixture(cwdAlpha, '.claude-flow/neural/patterns.json', [
    { id: 'a1', type: 'action', createdAt: 1 },
    { id: 'a2', type: 'action', createdAt: 2 },
  ]);
  writeFixture(cwdAlpha, '.claude-flow/neural/stats.json', { patternsLearned: 500 });

  const cwdBeta = tmp();
  writeFixture(cwdBeta, '.claude-flow/neural/patterns.json', [
    { id: 'b1', type: 'result', createdAt: 1 },
  ]);
  writeFixture(cwdBeta, '.claude-flow/neural/stats.json', { patternsLearned: 300 });

  const { totals } = readMachineWideIntel([
    { path: cwdAlpha, label: 'Alpha' },
    { path: cwdBeta, label: 'Beta' },
  ]);

  assert.equal(totals.patternsLearnedLifetime, 800); // lifetime counters: 500 + 300
  assert.equal(totals.patternStoreEntries, 3); // entries on disk right now: 2 + 1
  assert.notEqual(totals.patternsLearnedLifetime, totals.patternStoreEntries);
});

test('readMachineWideIntel degrades a project with missing/malformed data to nulls/zeros without aborting the whole call', () => {
  const cwdGood = tmp();
  writeFixture(cwdGood, '.claude-flow/neural/patterns.json', [
    { id: 'g1', type: 'action', createdAt: 1 },
    { id: 'g2', type: 'action', createdAt: 2 },
  ]);
  writeFixture(cwdGood, '.claude-flow/neural/stats.json', {
    patternsLearned: 10, trajectoriesRecorded: 4, signalsProcessed: 0, lastAdaptation: 999,
  });

  const cwdEmpty = tmp(); // no .claude-flow tree at all

  const cwdMalformed = tmp();
  writeFixture(cwdMalformed, '.claude-flow/neural/patterns.json', '{not valid json');
  writeFixture(cwdMalformed, '.claude-flow/neural/stats.json', '{ broken');

  const result = readMachineWideIntel([
    { path: cwdGood, label: 'Good', learningScope: 'repository' },
    { path: cwdEmpty, label: 'Empty' },
    { path: cwdMalformed, label: 'Malformed' },
  ]);

  assert.deepEqual(result.totals, {
    patternsLearnedLifetime: 10,
    patternStoreEntries: 2,
    trajectoriesRecorded: 4,
    projectCount: 3,
    mostActiveProject: 'Good',
  });
  assert.deepEqual(result.perProject[1], {
    path: cwdEmpty, label: 'Empty', key: null, learningScope: 'unknown', patternsLearned: null, patternStoreCount: 0,
    trajectoriesRecorded: null, graphLatest: null, lastAdaptation: null, learningState: [],
    hosts: [], sessionOrigins: [], sessionSurfaces: null,
  });
  assert.deepEqual(result.perProject[2], {
    path: cwdMalformed, label: 'Malformed', key: null, learningScope: 'unknown', patternsLearned: null, patternStoreCount: 0,
    trajectoriesRecorded: null, graphLatest: null, lastAdaptation: null, learningState: [],
    hosts: [], sessionOrigins: [], sessionSurfaces: null,
  });
});

test('readMachineWideIntel picks mostActiveProject by the highest lastAdaptation, and null when none have adaptation data', () => {
  const cwdOld = tmp();
  writeFixture(cwdOld, '.claude-flow/neural/stats.json', { patternsLearned: 1, lastAdaptation: 500 });
  const cwdNewer = tmp();
  writeFixture(cwdNewer, '.claude-flow/neural/stats.json', { patternsLearned: 1, lastAdaptation: 1500 });
  const cwdNewest = tmp();
  writeFixture(cwdNewest, '.claude-flow/neural/stats.json', { patternsLearned: 1, lastAdaptation: 999999 });

  const withAdaptation = readMachineWideIntel([
    { path: cwdOld, label: 'Old', learningScope: 'repository' },
    { path: cwdNewest, label: 'Newest', learningScope: 'repository' },
    { path: cwdNewer, label: 'Newer', learningScope: 'repository' },
  ]);
  assert.equal(withAdaptation.totals.mostActiveProject, 'Newest');

  const cwdNoStats = tmp(); // no stats.json → globalStats null
  const cwdZeroAdaptation = tmp();
  writeFixture(cwdZeroAdaptation, '.claude-flow/neural/stats.json', { patternsLearned: 1 }); // lastAdaptation defaults to 0

  const withoutAdaptation = readMachineWideIntel([
    { path: cwdNoStats, label: 'NoStats' },
    { path: cwdZeroAdaptation, label: 'ZeroAdaptation' },
  ]);
  assert.equal(withoutAdaptation.totals.mostActiveProject, null);
});

test('readMachineWideIntel selects the most active Git repository, never a desktop or directory workspace', () => {
  const root = tmp();
  const repository = path.join(root, 'repository');
  const desktopWorkspace = path.join(root, 'g-p-opaque');
  writeFixture(repository, '.claude-flow/neural/stats.json', { patternsLearned: 1, lastAdaptation: 100 });
  writeFixture(desktopWorkspace, '.claude-flow/neural/stats.json', { patternsLearned: 999, lastAdaptation: 999 });

  const result = readMachineWideIntel([
    { path: repository, label: 'Repository', learningScope: 'repository' },
    { path: desktopWorkspace, label: 'g-p-opaque', learningScope: 'unknown' },
  ]);

  assert.equal(result.totals.mostActiveProject, 'Repository');
  assert.equal(result.totals.projectCount, 2, 'non-repository learning remains in the inventory');
});

test('readMachineWideIntel returns zeroed totals and an empty perProject for an empty projects array', () => {
  assert.deepEqual(readMachineWideIntel([]), {
    totals: {
      patternsLearnedLifetime: 0,
      patternStoreEntries: 0,
      trajectoriesRecorded: 0,
      projectCount: 0,
      mostActiveProject: null,
    },
    perProject: [],
  });
});

test('a census row\'s learningState rides through onto its perProject row', () => {
  // Why it must: a project with .agentic-qe but no ruflo stats reports 0
  // patterns, and without this field that row is indistinguishable from one
  // whose read failed. The rollup does not probe the filesystem itself — the
  // census already did, so the value is carried, never recomputed.
  const cwd = tmp();
  writeFixture(cwd, '.claude-flow/neural/stats.json', { patternsLearned: 3 });
  const result = readMachineWideIntel([
    { path: cwd, label: 'Carried', learningState: ['.agentic-qe', '.swarm'] },
  ]);
  assert.deepEqual(result.perProject[0].learningState, ['.agentic-qe', '.swarm']);
});

test('a project row with no learningState degrades to [] rather than undefined', () => {
  const cwd = tmp();
  writeFixture(cwd, '.claude-flow/neural/stats.json', { patternsLearned: 1 });
  for (const row of [{ path: cwd, label: 'X' }, { path: cwd, label: 'X', learningState: 'nope' }]) {
    assert.deepEqual(readMachineWideIntel([row]).perProject[0].learningState, []);
  }
});

test('readMachineWideIntel passes through declared session presentation evidence', () => {
  const evidence = { hosts: ['codex'], sessionOrigins: [{ origin: 'unknown', sessions: 2 }],
    sessionSurfaces: [{ host: 'codex', surface: 'codex-cli', sessions: 2 }] };
  const [row] = readMachineWideIntel([{ path: tmp(), label: 'CLI project', ...evidence }]).perProject;
  assert.deepEqual({ hosts: row.hosts, sessionOrigins: row.sessionOrigins, sessionSurfaces: row.sessionSurfaces }, evidence);
});
