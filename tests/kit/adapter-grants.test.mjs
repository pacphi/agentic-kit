// Unit tests for the hash-pinned capability-grant store (ADR-0031 §1, §2,
// §4). Mirrors adapter-conformance.test.mjs's consent-store test patterns:
// temp files, prototype-chain safety, corrupt/missing-file tolerance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONFORMANCE_TIERS, TIER_GRANTS,
  recordTierResult, recordTierGate, grantCapability, revokeGrants,
  grantsFor, grantedCapabilitiesFor, gatedTiersFor,
} from '../../src/lib/adapters/grants.mjs';

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-adapter-grants-'));
  return path.join(dir, 'adapter-grants.json');
}

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

test('exports the five conformance tiers in graduation order', () => {
  assert.deepEqual(CONFORMANCE_TIERS, [
    'admission', 'session-driving', 'activity-routing', 'primary-eligible', 'statusline',
  ]);
});

test('TIER_GRANTS only maps primary-eligible and statusline; aqeProvider never appears', () => {
  assert.deepEqual(TIER_GRANTS, { 'primary-eligible': 'canBePrimary', statusline: 'commandStatusline' });
  assert.ok(!Object.values(TIER_GRANTS).includes('aqeProvider'));
});

test('record -> grant happy path: passed tier at the same hash grants the capability', () => {
  const file = tempFile();
  recordTierResult('acme', 'primary-eligible', { hash: HASH_A, evidence: 'led a run, escalated to' }, { file });
  grantCapability('acme', 'canBePrimary', { hash: HASH_A }, { file });

  const record = grantsFor('acme', { file });
  assert.equal(record.hash, HASH_A);
  assert.equal(record.tiers['primary-eligible'].status, 'passed');
  assert.equal(record.tiers['primary-eligible'].evidence, 'led a run, escalated to');
  assert.equal(record.capabilities.canBePrimary, true);
  assert.ok(typeof record.grantedAt === 'string' && Number.isFinite(Date.parse(record.grantedAt)));

  assert.deepEqual(grantedCapabilitiesFor('acme', HASH_A, { file }), { canBePrimary: true });
});

test('grantCapability refused: no tier recorded at all', () => {
  const file = tempFile();
  assert.throws(() => grantCapability('acme', 'canBePrimary', { hash: HASH_A }, { file }), (error) => {
    assert.match(error.message, /primary-eligible/);
    return true;
  });
});

test('grantCapability refused: tier passed but at a DIFFERENT hash', () => {
  const file = tempFile();
  recordTierResult('acme', 'primary-eligible', { hash: HASH_A, evidence: 'led a run' }, { file });
  assert.throws(() => grantCapability('acme', 'canBePrimary', { hash: HASH_B }, { file }), (error) => {
    assert.match(error.message, /primary-eligible/);
    assert.match(error.message, new RegExp(HASH_B));
    return true;
  });
  // and the never-recorded hash grants nothing either
  assert.deepEqual(grantedCapabilitiesFor('acme', HASH_A, { file }), {});
});

test('grantCapability refused: aqeProvider is never a grantable capability', () => {
  const file = tempFile();
  recordTierResult('acme', 'primary-eligible', { hash: HASH_A, evidence: 'led a run' }, { file });
  assert.throws(() => grantCapability('acme', 'aqeProvider', { hash: HASH_A }, { file }), TypeError);
});

test('grantedCapabilitiesFor returns {} on hash mismatch', () => {
  const file = tempFile();
  recordTierResult('acme', 'statusline', { hash: HASH_A, evidence: 'footer renders' }, { file });
  grantCapability('acme', 'commandStatusline', { hash: HASH_A }, { file });
  assert.deepEqual(grantedCapabilitiesFor('acme', HASH_A, { file }), { commandStatusline: true });
  assert.deepEqual(grantedCapabilitiesFor('acme', HASH_B, { file }), {});
});

test('grantedCapabilitiesFor returns {} after a re-record at a new hash (edit-invalidation)', () => {
  const file = tempFile();
  recordTierResult('acme', 'statusline', { hash: HASH_A, evidence: 'footer renders' }, { file });
  grantCapability('acme', 'commandStatusline', { hash: HASH_A }, { file });
  assert.deepEqual(grantedCapabilitiesFor('acme', HASH_A, { file }), { commandStatusline: true });

  // Manifest changed -> re-record at a new hash.
  recordTierResult('acme', 'statusline', { hash: HASH_B, evidence: 'new footer render' }, { file });
  assert.deepEqual(grantedCapabilitiesFor('acme', HASH_A, { file }), {});
  assert.deepEqual(grantedCapabilitiesFor('acme', HASH_B, { file }), {});
});

test('re-record at a new hash wipes prior tiers and capabilities entirely', () => {
  const file = tempFile();
  recordTierResult('acme', 'primary-eligible', { hash: HASH_A, evidence: 'led a run' }, { file });
  grantCapability('acme', 'canBePrimary', { hash: HASH_A }, { file });
  recordTierResult('acme', 'session-driving', { hash: HASH_A }, { file });

  let record = grantsFor('acme', { file });
  assert.ok(record.tiers['primary-eligible']);
  assert.ok(record.tiers['session-driving']);
  assert.equal(record.capabilities.canBePrimary, true);

  recordTierResult('acme', 'admission', { hash: HASH_B }, { file });
  record = grantsFor('acme', { file });
  assert.equal(record.hash, HASH_B);
  assert.deepEqual(Object.keys(record.tiers), ['admission']);
  assert.equal(record.capabilities, undefined);
  assert.equal(record.grantedAt, undefined);
});

test('recordTierGate validates the gatedBy ref format', () => {
  const file = tempFile();
  recordTierGate('acme', 'primary-eligible', { hash: HASH_A, gatedBy: 'agentic-qe#563' }, { file });
  recordTierGate('acme', 'statusline', { hash: HASH_A, gatedBy: 'ruvnet/ruflo#2962' }, { file });
  const record = grantsFor('acme', { file });
  assert.equal(record.tiers['primary-eligible'].status, 'gated');
  assert.equal(record.tiers['primary-eligible'].gatedBy, 'agentic-qe#563');
  assert.equal(record.tiers.statusline.gatedBy, 'ruvnet/ruflo#2962');

  for (const bad of ['agentic-qe#0', 'no-hash', 'a#b', 'agentic-qe#', '#123', 'agentic-qe#01']) {
    assert.throws(
      () => recordTierGate('acme', 'primary-eligible', { hash: HASH_A, gatedBy: bad }, { file }),
      TypeError,
      `expected recordTierGate to reject gatedBy: ${bad}`,
    );
  }
});

test('gatedTiersFor lists gated entries and [] when none/missing', () => {
  const file = tempFile();
  assert.deepEqual(gatedTiersFor('acme', { file }), []);
  recordTierGate('acme', 'primary-eligible', { hash: HASH_A, gatedBy: 'agentic-qe#563' }, { file });
  recordTierResult('acme', 'admission', { hash: HASH_A }, { file });
  const gated = gatedTiersFor('acme', { file });
  assert.equal(gated.length, 1);
  assert.equal(gated[0].tier, 'primary-eligible');
  assert.equal(gated[0].gatedBy, 'agentic-qe#563');
});

test('revokeGrants: true when a record existed, false otherwise', () => {
  const file = tempFile();
  assert.equal(revokeGrants('acme', { file }), false);
  recordTierResult('acme', 'admission', { hash: HASH_A }, { file });
  assert.equal(revokeGrants('acme', { file }), true);
  assert.equal(grantsFor('acme', { file }), null);
  assert.equal(revokeGrants('acme', { file }), false);
});

test("revokeGrants on prototype-chain names ('constructor', '__proto__', 'toString') returns false on an empty store", () => {
  const file = tempFile();
  for (const protoName of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
    assert.equal(revokeGrants(protoName, { file }), false,
      `revokeGrants('${protoName}') on a never-recorded store must be false, not a prototype-chain hit`);
  }
  // A real recorded adapter must still revoke correctly.
  recordTierResult('acme', 'admission', { hash: HASH_A }, { file });
  assert.equal(revokeGrants('acme', { file }), true);
});

test('corrupt or missing file tolerance: grantsFor null, grantedCapabilitiesFor {}, gatedTiersFor []', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-adapter-grants-corrupt-'));
  const missing = path.join(dir, 'does-not-exist.json');
  assert.equal(grantsFor('acme', { file: missing }), null);
  assert.deepEqual(grantedCapabilitiesFor('acme', HASH_A, { file: missing }), {});
  assert.deepEqual(gatedTiersFor('acme', { file: missing }), []);

  const corrupt = path.join(dir, 'adapter-grants.json');
  fs.writeFileSync(corrupt, '{ not valid json', 'utf8');
  assert.equal(grantsFor('acme', { file: corrupt }), null);
  assert.deepEqual(grantedCapabilitiesFor('acme', HASH_A, { file: corrupt }), {});
  assert.deepEqual(gatedTiersFor('acme', { file: corrupt }), []);
});

test('recordTierResult / recordTierGate throw TypeError on invalid name/tier/hash', () => {
  const file = tempFile();
  assert.throws(() => recordTierResult('', 'admission', { hash: HASH_A }, { file }), TypeError);
  assert.throws(() => recordTierResult('acme', 'not-a-tier', { hash: HASH_A }, { file }), TypeError);
  assert.throws(() => recordTierResult('acme', 'admission', { hash: '' }, { file }), TypeError);
  assert.throws(() => recordTierGate('acme', 'not-a-tier', { hash: HASH_A, gatedBy: 'x#1' }, { file }), TypeError);
  assert.throws(() => recordTierGate('acme', 'admission', { hash: '', gatedBy: 'x#1' }, { file }), TypeError);
});

test('evidence is bounded to 2048 characters', () => {
  const file = tempFile();
  const huge = 'x'.repeat(3000);
  recordTierResult('acme', 'admission', { hash: HASH_A, evidence: huge }, { file });
  const record = grantsFor('acme', { file });
  assert.equal(record.tiers.admission.evidence.length, 2048);
});

// ── Finding 10: grantsFor/gatedTiersFor are reporting surfaces, not the
// capability reader — currentHash lets them ANNOTATE/void staleness for a
// status display without hiding it. grantedCapabilitiesFor stays the only
// hash-blind-proof reader. ───────────────────────────────────────────────

test('grantsFor: no currentHash -> no stale field at all (raw reporting)', () => {
  const file = tempFile();
  recordTierResult('acme', 'admission', { hash: HASH_A }, { file });
  const record = grantsFor('acme', { file });
  assert.equal(Object.hasOwn(record, 'stale'), false);
});

test('grantsFor: currentHash supplied -> stale:false on match, stale:true on mismatch, record still returned either way', () => {
  const file = tempFile();
  recordTierResult('acme', 'admission', { hash: HASH_A, evidence: 'e' }, { file });

  const fresh = grantsFor('acme', { file, currentHash: HASH_A });
  assert.equal(fresh.stale, false);
  assert.equal(fresh.hash, HASH_A);
  assert.ok(fresh.tiers.admission, 'stale annotation must not hide the underlying evidence');

  const stale = grantsFor('acme', { file, currentHash: HASH_B });
  assert.equal(stale.stale, true);
  assert.equal(stale.hash, HASH_A);
  assert.ok(stale.tiers.admission, 'a stale record must still be visible, just flagged, not hidden');
});

test('gatedTiersFor: currentHash omitted returns every gated tier regardless of hash', () => {
  const file = tempFile();
  recordTierGate('acme', 'primary-eligible', { hash: HASH_A, gatedBy: 'agentic-qe#563' }, { file });
  assert.equal(gatedTiersFor('acme', { file }).length, 1);
  assert.equal(gatedTiersFor('acme', { file, currentHash: HASH_A }).length, 1);
});

test('gatedTiersFor: currentHash mismatch voids gated-tier records, same as grants', () => {
  const file = tempFile();
  recordTierGate('acme', 'primary-eligible', { hash: HASH_A, gatedBy: 'agentic-qe#563' }, { file });
  assert.deepEqual(gatedTiersFor('acme', { file, currentHash: HASH_B }), []);
});

// ── Finding 11: a grant-bearing tier ('primary-eligible', 'statusline')
// must never be recorded 'passed' with empty evidence — a grant must always
// trace back to real conformance evidence (ADR-0031 §1). ──────────────────

test('recordTierResult on a grant-bearing tier requires non-empty evidence', () => {
  const file = tempFile();
  assert.throws(() => recordTierResult('acme', 'primary-eligible', { hash: HASH_A }, { file }), TypeError);
  assert.throws(() => recordTierResult('acme', 'primary-eligible', { hash: HASH_A, evidence: '' }, { file }), TypeError);
  assert.throws(() => recordTierResult('acme', 'primary-eligible', { hash: HASH_A, evidence: '   ' }, { file }), TypeError);
  assert.throws(() => recordTierResult('acme', 'statusline', { hash: HASH_A, evidence: '' }, { file }), TypeError);
  // nothing was recorded by any of the rejected attempts
  assert.equal(grantsFor('acme', { file }), null);
});

test('recordTierResult on an evidence-only tier (admission) still accepts empty/missing evidence', () => {
  const file = tempFile();
  recordTierResult('acme', 'admission', { hash: HASH_A }, { file });
  const record = grantsFor('acme', { file });
  assert.equal(record.tiers.admission.status, 'passed');
  assert.equal(record.tiers.admission.evidence, '');
});
