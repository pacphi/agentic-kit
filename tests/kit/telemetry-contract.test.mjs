import { test } from 'node:test';
import assert from 'node:assert/strict';

const projectionPath = '../../src/lib/telemetry/projection.mjs';
const contractPath = '../../src/lib/telemetry/contract.mjs';
import { fixture, source, now } from './helpers/telemetry.mjs';

test('should_exposeSnapshotProjection_when_telemetryIsImplemented', async () => {
  const module = await import(projectionPath).catch(() => null);
  assert.equal(typeof module?.createSnapshot, 'function');
});
test('should_excludePrivateSourceFields_when_exporting', async () => {
  const snapshot = await fixture();
  assert.doesNotMatch(JSON.stringify(snapshot), /SECRET|native-private|abababab|title|project/);
});
test('should_validateOwnExport_when_projectingKnownEvidence', async () => {
  const { validateSnapshot } = await import(contractPath);
  assert.equal(validateSnapshot(await fixture()).kind, 'agentic-kit.telemetry.snapshot');
});
test('should_preserveUnknownTokens_when_noUsageEvidenceExists', async () => {
  const snapshot = await fixture({ sessions: [source({ costEvidence: { observedUsd: 0, estimatedUsd: 0, observedMessages: 0, estimatedMessages: 0, unpricedMessages: 0 } })] });
  assert.equal(snapshot.usage.sessions[0].input, null);
});
test('should_preserveMeasuredZero_when_usageWasReported', async () => {
  const snapshot = await fixture({ sessions: [source({ input: 0 })] });
  assert.equal(snapshot.usage.sessions[0].input, 0);
});
test('should_distinguishHostIdentities_when_nativeIdsMatch', async () => {
  const snapshot = await fixture({ sessions: [source(), source({ host: 'claude' })] });
  assert.equal(new Set(snapshot.usage.sessions.map(x => x.sessionId)).size, 2);
});
test('should_rejectUnsupportedVersion_when_validating', async () => {
  const { validateSnapshot } = await import(contractPath);
  assert.throws(() => validateSnapshot({ schemaVersion: 2 }), /schema|contract/i);
});
test('should_rejectUnknownFields_when_validating', async () => {
  const { validateSnapshot } = await import(contractPath);
  const snapshot = await fixture();
  assert.throws(() => validateSnapshot({ ...snapshot, secret: 'do not echo' }), /contract/i);
});
test('should_rejectTampering_when_digestNoLongerMatches', async () => {
  const { validateSnapshot } = await import(contractPath);
  const snapshot = await fixture(); snapshot.usage.sessions[0].input++;
  assert.throws(() => validateSnapshot(snapshot), /digest/i);
});
test('should_omitArbitraryReceiptFields_when_projecting', async () => {
  const snapshot = await fixture({ receipts: [{ id: 'private-receipt', status: 'committed', updatedAt: now, command: 'SECRET', actions: [{ token: 'SECRET' }] }] });
  assert.doesNotMatch(JSON.stringify(snapshot), /private-receipt|SECRET|command/);
});
test('should_preserveMissingInventory_when_noRetainedScanExists', async () => {
  assert.equal((await fixture()).inventory.resources, null);
});
test('should_publishCanonicalTimestampPattern_when_exposingSchema', async () => {
  const { SNAPSHOT_SCHEMA } = await import('../../src/lib/telemetry/schema.mjs');
  assert.equal(typeof SNAPSHOT_SCHEMA.properties.generatedAt.pattern, 'string');
  assert.equal(new RegExp(SNAPSHOT_SCHEMA.properties.generatedAt.pattern).test('2026-09-20T12:00:00Z'), false);
});
test('should_rejectMalformedAdmission_when_knownFieldsAreHostile', async () => {
  const { validateSnapshot, snapshotDigest } = await import(contractPath);
  const mutations = [
    s => { s.usage.sessions[0].input = -1; },
    s => { s.usage.sessions[0].responses = 1.5; },
    s => { s.usage.sessions[0].input = Infinity; },
    s => { s.usage.sessions[0].latencyBuckets = [0]; },
    s => { s.usage.sessions[0].latencyBuckets[0] = -1; },
    s => { s.usage.sessions[0].host = 'SECRET'; },
    s => { s.usage.sessions.push(s.usage.sessions[0]); },
    s => { s.usage.state = 'unavailable'; },
    s => { s.inventory.resources = 0; },
    s => { s.inventory.state = 'available'; },
    s => { s.generatedAt = '2026-02-30T12:00:00.000Z'; },
    s => { delete s.selection; },
    s => { s.selection.days = 366; },
    s => { s.usage.sourceHealth.codex = 'SECRET'; },
    s => { s.usage.sessions[0].input = 'SECRET'; },
    s => { s.usage.sessions[0].secret = 'SECRET'; },
  ];
  for (const mutate of mutations) {
    const snapshot = await fixture(); mutate(snapshot); snapshot.snapshotId = snapshotDigest(snapshot);
    assert.throws(() => validateSnapshot(snapshot), /contract/i);
  }
});
test('should_normalizeUnknownReceiptState_when_sourceUsesFutureStatus', async () => {
  const snapshot = await fixture({ receipts: [{ id: 'receipt', status: 'SECRET', updatedAt: 'bad' }] });
  assert.equal(snapshot.maintenance.receipts[0].status, 'unknown');
  assert.equal(snapshot.maintenance.receipts[0].updatedAt, null);
});
test('should_preserveInventoryCapture_when_retainedSnapshotIsAvailable', async () => {
  const snapshot = await fixture({ inventory: { capturedAt: now, resources: [{ secret: 'SECRET' }], placements: [{}, {}] } });
  assert.deepEqual(snapshot.inventory, { state: 'available', capturedAt: now, resources: 1, placements: 2 });
});
test('should_rejectInvalidNativeIdentity_when_projectingSources', async () => {
  await assert.rejects(fixture({ sessions: [source({ host: 'SECRET' })] }), /identity/);
  await assert.rejects(fixture({ sessions: [source({ id: '' })] }), /identity/);
  await assert.rejects(fixture({ receipts: [{ id: '', status: 'committed' }] }), /identity/);
});
