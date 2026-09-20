import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, source, identity, now } from './helpers/telemetry.mjs';
const modulePath = '../../src/lib/telemetry/aggregate.mjs';
const secondIdentity = { ...identity, installationId: '22222222-2222-4222-8222-222222222222' };
async function fold(snapshots, options = {}) {
  const { aggregateSnapshots } = await import(modulePath);
  return aggregateSnapshots(snapshots, { asOf: now, ...options });
}
test('should_exposeReducer_when_telemetryIsImplemented', async () => {
  const module = await import(modulePath).catch(() => null);
  assert.equal(typeof module?.aggregateSnapshots, 'function');
});
test('should_beIdempotent_when_replayingAnExport', async () => {
  const a = await fixture();
  assert.deepEqual(await fold([a, a]), await fold([a]));
});
test('should_replaceWholeSnapshot_when_newerExportOmitsOldSessions', async () => {
  const old = await fixture({ generatedAt: '2026-09-19T12:00:00.000Z' });
  const recent = await fixture({ sessions: [] });
  assert.equal((await fold([old, recent])).usage.sessionObservations, 0);
});
test('should_beOrderIndependent_when_installationsAndRevisionsAreReordered', async () => {
  const a = await fixture(); const b = await fixture({ identity: secondIdentity });
  assert.deepEqual(await fold([a, b]), await fold([b, a]));
});
test('should_rejectConflictingTies_when_timestampMatchesButContentDiffers', async () => {
  await assert.rejects(fold([await fixture(), await fixture({ sessions: [source({ input: 20 })] })]), /conflict/i);
});
test('should_rejectMixedLookbacks_when_selectionCannotBeCompared', async () => {
  await assert.rejects(fold([await fixture(), await fixture({ days: 7, identity: secondIdentity })]), /selection/i);
});
test('should_computeWeightedCacheShare_when_installationsDiffer', async () => {
  const result = await fold([await fixture(), await fixture({ identity: secondIdentity, sessions: [source({ input: 20, cacheRead: 0 })] })]);
  assert.equal(result.usage.cacheReadShare, 0.4);
});
test('should_mergeBuckets_when_latencyEvidenceIsPresent', async () => {
  const result = await fold([await fixture(), await fixture({ identity: secondIdentity })]);
  assert.deepEqual(result.usage.latency.bucketCounts, [2, 2, 0, 2, 0, 0]);
});
test('should_reportMissingContributions_when_onlySomeSessionsHaveUsage', async () => {
  const result = await fold([await fixture({ sessions: [source(), source({ id: 'other', costEvidence: null })] })]);
  assert.deepEqual(result.usage.metrics.input, { value: 100, measured: 1, missing: 1 });
});
test('should_keepAllMissingNull_when_usageCollectionFailed', async () => {
  const result = await fold([await fixture({ usage: null })]);
  assert.equal(result.usage.metrics.input.value, null);
});
test('should_reportStaleness_when_collectionIsOld', async () => {
  const result = await fold([await fixture({ generatedAt: '2026-09-18T12:00:00.000Z' })]);
  assert.equal(result.installations[0].stale, true);
});
test('should_rejectFutureRecords_when_asOfPrecedesExport', async () => {
  await assert.rejects(fold([await fixture()], { asOf: '2026-09-19T12:00:00.000Z' }), /future/i);
});
test('should_notMutateInputs_when_aggregating', async () => {
  const a = await fixture(); const before = structuredClone(a); await fold([a]);
  assert.deepEqual(a, before);
});
test('should_preserveLargeIntegers_when_summingCounters', async () => {
  const result = await fold([await fixture({ sessions: [source({ prompts: 1689509126518595 })] })]);
  assert.equal(result.usage.metrics.prompts.value, 1689509126518595);
});
test('should_rejectNumericOverflow_when_combiningInstallations', async () => {
  const sessions = [source({ prompts: Number.MAX_SAFE_INTEGER })];
  await assert.rejects(fold([await fixture({ sessions }), await fixture({ sessions, identity: secondIdentity })]), /numeric bounds/);
});
test('should_rejectInvalidReducerOptions_when_boundsAreViolated', async () => {
  const snapshot = await fixture();
  for (const options of [{ asOf: 'bad' }, { staleAfterSeconds: 0 }, { staleAfterSeconds: 31_536_001 }]) {
    await assert.rejects(fold([snapshot], options), /Invalid/);
  }
  await assert.rejects(fold([]), /requires/);
  await assert.rejects(fold(Array(257).fill(snapshot)), /requires/);
});
