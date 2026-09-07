// ADR-0048 source coverage — MNT-DSC-014/015/016, MNT-PERF-007, last-good
// preservation, and the truthful-progress narrative.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  claimsAllowed, coverageFor, createLastGoodSnapshotStore, progressNarrative,
} from '../../src/lib/maintenance/discovery/coverage.mjs';
import { INCOMPLETE_SOURCE_FORBIDDEN_CLAIMS } from '../../src/lib/maintenance/management/model.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-discovery-coverage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('coverageFor maps the fine scan state machine to the coarser public coverage state', () => {
  const record = {
    sourceId: 'src_a', environmentId: 'env_a', scanState: 'checkpointed', visited: 128, estimated: null,
    completedPartitions: 2, pendingPartitions: 3, limitingReason: 'work-slice', ceiling: null,
    lastCompletedAt: null, label: 'Projects',
  };
  const coverage = coverageFor(record);
  assert.equal(coverage.state, 'scanning');
  assert.equal(coverage.completedPartitions, 2);
  assert.equal(coverage.pendingPartitions, 3);
  assert.equal(coverage.lastCompletedAt, null);

  const published = coverageFor({ ...record, scanState: 'published', limitingReason: null, lastCompletedAt: '2026-09-05T12:00:00.000Z' });
  assert.equal(published.state, 'complete');
  assert.equal(published.lastCompletedAt, '2026-09-05T12:00:00.000Z');
});

test('QE D3: a never-run "configured" record maps to not-scanned, never scanning', () => {
  const neverRun = coverageFor({
    sourceId: 'src_a', environmentId: 'env_a', scanState: 'configured', visited: 0, estimated: null,
    completedPartitions: 0, pendingPartitions: 0, limitingReason: null, ceiling: null,
    lastCompletedAt: null, label: 'Runtimes',
  });
  assert.equal(neverRun.state, 'not-scanned');
  assert.equal(neverRun.visited, 0);
  assert.equal(neverRun.completedPartitions, 0);
  assert.equal(neverRun.limitingReason, null);
  assert.equal(neverRun.lastCompletedAt, null);
});

test('a "complete" coverage entry never carries a lastCompletedAt when its own state disagrees', () => {
  const stopped = coverageFor({
    sourceId: 'src_a', environmentId: 'env_a', scanState: 'stopped', visited: 10, estimated: null,
    completedPartitions: 1, pendingPartitions: 1, limitingReason: 'safety-ceiling', ceiling: 'entries',
    lastCompletedAt: '2020-01-01T00:00:00.000Z', label: 'Big monorepo',
  });
  assert.equal(stopped.lastCompletedAt, null);
  assert.equal(stopped.ceiling, 'entries');
});

test('MNT-DSC-014: claimsAllowed forbids absence/total/uniqueness claims unless every source is complete', () => {
  const allComplete = [{ state: 'complete' }, { state: 'complete' }];
  const onePartial = [{ state: 'complete' }, { state: 'scanning' }];
  assert.deepEqual(claimsAllowed(allComplete), []);
  assert.deepEqual(claimsAllowed(onePartial), [...INCOMPLETE_SOURCE_FORBIDDEN_CLAIMS]);
  assert.deepEqual(claimsAllowed([]), [...INCOMPLETE_SOURCE_FORBIDDEN_CLAIMS]);
});

test('MNT-DSC-016: the progress narrative states visited work and completion count truthfully', () => {
  const coverage = [
    { state: 'complete', visited: 84231, label: 'Projects' },
    { state: 'paused', visited: 12, label: 'Big monorepo', limitingReason: 'work-slice' },
  ];
  const narrative = progressNarrative(coverage, { totalSources: 10 });
  assert.match(narrative, /Scanned 84,243 entries\./);
  assert.match(narrative, /1 of 10 sources are complete\./);
  assert.match(narrative, /Big monorepo is paused and will resume; its inventory is not yet complete\./);
  assert.doesNotMatch(narrative, /unknown|unsupported|needs attention/i);
});

test('QE D3: the narrative reports never-run sources separately, not as scanning', () => {
  const narrative = progressNarrative([
    { state: 'complete', visited: 500, label: 'Projects' },
    { state: 'not-scanned', visited: 0, label: 'Runtimes' },
    { state: 'not-scanned', visited: 0, label: 'Ollama' },
  ], { totalSources: 3 });
  assert.match(narrative, /1 of 3 sources are complete\./);
  assert.match(narrative, /2 sources have not been scanned yet\./);
  assert.doesNotMatch(narrative, /scanning/i);
});

test('MNT-DSC-017: the narrative states a safety-ceiling stop factually, never as "unhealthy"', () => {
  const narrative = progressNarrative([
    { state: 'stopped', visited: 250000, label: 'Collection root', limitingReason: 'safety-ceiling', ceiling: 'entries' },
  ]);
  assert.match(narrative, /Collection root stopped at its entries limit after 250,000 entries\./);
});

test('MNT-PERF-007: a last-good snapshot store keeps a complete entry and rejects a partial overwrite', (t) => {
  const dir = path.join(fixture(t), 'management');
  const store = createLastGoodSnapshotStore(dir, { fsImpl: fs, now: () => Date.parse('2026-09-05T12:00:00.000Z') });
  const complete = { sourceId: 'src_a', environmentId: 'env_a', state: 'complete', visited: 500, label: 'Projects' };
  assert.equal(store.write(complete), true);
  assert.deepEqual(store.current().map((entry) => entry.sourceId), ['src_a']);

  const failedRun = { sourceId: 'src_a', environmentId: 'env_a', state: 'failed', visited: 12, label: 'Projects' };
  assert.equal(store.write(failedRun), false);
  const [kept] = store.current();
  assert.equal(kept.state, 'complete');
  assert.equal(kept.visited, 500);
});

test('the last-good snapshot store survives a corrupted file by returning an empty baseline', (t) => {
  const dir = path.join(fixture(t), 'management');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'discovery-latest.json'), '{not json');
  const store = createLastGoodSnapshotStore(dir, { fsImpl: fs, now: Date.now });
  assert.deepEqual(store.current(), []);
});
