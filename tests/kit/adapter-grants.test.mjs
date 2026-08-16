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
  recordTierResult, recordTierGate, recordTierFailure, grantCapability, revokeGrants, revokeCapability,
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

// ── F-1 (security review): grantedCapabilitiesFor re-derives the grant
// invariant at READ time, not just at write time. adapter-grants.json is a
// flat JSON file an operator (or a bad merge) can hand-edit directly —
// grantCapability's write-time gate does not protect against that. A
// capability must only ever be returned when it is a real TIER_GRANTS value
// AND its gating tier is recorded 'passed' at the exact same hash. ─────────

test('F-1: grantedCapabilitiesFor rejects a forged capability that has no matching passed tier, even at the correct hash', () => {
  const file = tempFile();
  // Simulate a hand-edited/forged/merged store: 'canBePrimary' sits in
  // capabilities with NO 'primary-eligible' tier ever recorded passed.
  recordTierResult('acme', 'admission', { hash: HASH_A }, { file });
  const store = JSON.parse(fs.readFileSync(file, 'utf8'));
  store.acme.capabilities = { canBePrimary: true };
  fs.writeFileSync(file, JSON.stringify(store, null, 2), 'utf8');

  assert.deepEqual(
    grantedCapabilitiesFor('acme', HASH_A, { file }),
    {},
    'a forged capability with no backing passed tier must never be returned',
  );
});

test("F-1: grantedCapabilitiesFor rejects a forged 'aqeProvider' key even though it is present in the raw store", () => {
  const file = tempFile();
  recordTierResult('acme', 'primary-eligible', { hash: HASH_A, evidence: 'led a run' }, { file });
  grantCapability('acme', 'canBePrimary', { hash: HASH_A }, { file });
  const store = JSON.parse(fs.readFileSync(file, 'utf8'));
  store.acme.capabilities.aqeProvider = true; // forged — never written by grantCapability
  fs.writeFileSync(file, JSON.stringify(store, null, 2), 'utf8');

  const granted = grantedCapabilitiesFor('acme', HASH_A, { file });
  assert.deepEqual(granted, { canBePrimary: true }, 'the real grant still returns; the forged aqeProvider key must not');
  assert.ok(!Object.hasOwn(granted, 'aqeProvider'));
});

test('F-1: grantedCapabilitiesFor rejects a capability whose gating tier was recorded but is not status "passed"', () => {
  const file = tempFile();
  recordTierGate('acme', 'primary-eligible', { hash: HASH_A, gatedBy: 'agentic-qe#563' }, { file });
  const store = JSON.parse(fs.readFileSync(file, 'utf8'));
  store.acme.capabilities = { canBePrimary: true }; // forged alongside a merely-gated tier
  fs.writeFileSync(file, JSON.stringify(store, null, 2), 'utf8');

  assert.deepEqual(grantedCapabilitiesFor('acme', HASH_A, { file }), {});
});

// ── F-2 (security review): running `gate` AFTER a grant must downgrade the
// live capability along with the tier — evidence and grant must never
// disagree, or a status display would show a self-contradiction (a 'gated'
// tier backing a still-live capability) and the audit trail would be lost.

test('F-2: recordTierGate on a grant-bearing tier that currently backs a live capability drops that capability', () => {
  const file = tempFile();
  recordTierResult('acme', 'primary-eligible', { hash: HASH_A, evidence: 'led a run' }, { file });
  grantCapability('acme', 'canBePrimary', { hash: HASH_A }, { file });
  assert.deepEqual(grantedCapabilitiesFor('acme', HASH_A, { file }), { canBePrimary: true });

  recordTierGate('acme', 'primary-eligible', { hash: HASH_A, gatedBy: 'ruvnet/ruflo#2962' }, { file });

  const record = grantsFor('acme', { file });
  assert.equal(record.tiers['primary-eligible'].status, 'gated');
  assert.ok(!Object.hasOwn(record.capabilities ?? {}, 'canBePrimary'), 'the stored record must drop the capability, not just the read side');
  assert.deepEqual(grantedCapabilitiesFor('acme', HASH_A, { file }), {});
});

test('F-2: recordTierGate on a grant-bearing tier leaves an UNRELATED live capability untouched', () => {
  const file = tempFile();
  recordTierResult('acme', 'primary-eligible', { hash: HASH_A, evidence: 'led a run' }, { file });
  grantCapability('acme', 'canBePrimary', { hash: HASH_A }, { file });
  recordTierResult('acme', 'statusline', { hash: HASH_A, evidence: 'footer renders' }, { file });
  grantCapability('acme', 'commandStatusline', { hash: HASH_A }, { file });

  recordTierGate('acme', 'primary-eligible', { hash: HASH_A, gatedBy: 'ruvnet/ruflo#2962' }, { file });

  assert.deepEqual(grantedCapabilitiesFor('acme', HASH_A, { file }), { commandStatusline: true });
});

test('F-2: recordTierGate on a tier with no live capability (never granted) is a no-op on capabilities', () => {
  const file = tempFile();
  recordTierResult('acme', 'primary-eligible', { hash: HASH_A, evidence: 'led a run' }, { file });
  // No grantCapability call — the tier passed but was never granted.
  recordTierGate('acme', 'primary-eligible', { hash: HASH_A, gatedBy: 'ruvnet/ruflo#2962' }, { file });
  const record = grantsFor('acme', { file });
  assert.equal(record.tiers['primary-eligible'].status, 'gated');
  assert.equal(record.capabilities, undefined);
});

// ── N-1 (security-review follow-up): recordTierFailure — the un-earn path
// mirroring recordTierGate's downgrade, but for a genuine RE-FAIL at the
// same hash a capability was earned at. ────────────────────────────────────

test('N-1: recordTierFailure on a grant-bearing tier that currently backs a live capability drops that capability', () => {
  const file = tempFile();
  recordTierResult('acme', 'primary-eligible', { hash: HASH_A, evidence: 'led a run' }, { file });
  grantCapability('acme', 'canBePrimary', { hash: HASH_A }, { file });
  assert.deepEqual(grantedCapabilitiesFor('acme', HASH_A, { file }), { canBePrimary: true });

  recordTierFailure('acme', 'primary-eligible', { hash: HASH_A }, { file });

  const record = grantsFor('acme', { file });
  assert.equal(record.tiers['primary-eligible'].status, 'failed');
  assert.ok(!Object.hasOwn(record.capabilities ?? {}, 'canBePrimary'), 'the stored record must drop the capability, not just the read side');
  assert.deepEqual(grantedCapabilitiesFor('acme', HASH_A, { file }), {});
});

test('N-1: recordTierFailure on a grant-bearing tier leaves an UNRELATED live capability untouched', () => {
  const file = tempFile();
  recordTierResult('acme', 'primary-eligible', { hash: HASH_A, evidence: 'led a run' }, { file });
  grantCapability('acme', 'canBePrimary', { hash: HASH_A }, { file });
  recordTierResult('acme', 'statusline', { hash: HASH_A, evidence: 'footer renders' }, { file });
  grantCapability('acme', 'commandStatusline', { hash: HASH_A }, { file });

  recordTierFailure('acme', 'primary-eligible', { hash: HASH_A }, { file });

  assert.deepEqual(grantedCapabilitiesFor('acme', HASH_A, { file }), { commandStatusline: true });
});

test('N-1: recordTierFailure on a tier with no live capability (never granted) is a no-op on capabilities', () => {
  const file = tempFile();
  recordTierResult('acme', 'primary-eligible', { hash: HASH_A, evidence: 'led a run' }, { file });
  recordTierFailure('acme', 'primary-eligible', { hash: HASH_A }, { file });
  const record = grantsFor('acme', { file });
  assert.equal(record.tiers['primary-eligible'].status, 'failed');
  assert.equal(record.capabilities, undefined);
});

test('N-1: recordTierFailure at a DIFFERENT hash still wipes prior tiers/capabilities via the existing freshRecordAt path', () => {
  const file = tempFile();
  recordTierResult('acme', 'primary-eligible', { hash: HASH_A, evidence: 'led a run' }, { file });
  grantCapability('acme', 'canBePrimary', { hash: HASH_A }, { file });

  recordTierFailure('acme', 'primary-eligible', { hash: HASH_B }, { file });

  const record = grantsFor('acme', { file });
  assert.equal(record.hash, HASH_B);
  assert.deepEqual(Object.keys(record.tiers), ['primary-eligible']);
  assert.equal(record.tiers['primary-eligible'].status, 'failed');
  assert.equal(record.capabilities, undefined);
  // The old hash's grant is gone too — a hash change voids everything.
  assert.deepEqual(grantedCapabilitiesFor('acme', HASH_A, { file }), {});
});

test('recordTierFailure throws TypeError on invalid name/tier/hash', () => {
  const file = tempFile();
  assert.throws(() => recordTierFailure('', 'primary-eligible', { hash: HASH_A }, { file }), TypeError);
  assert.throws(() => recordTierFailure('acme', 'not-a-tier', { hash: HASH_A }, { file }), TypeError);
  assert.throws(() => recordTierFailure('acme', 'primary-eligible', { hash: '' }, { file }), TypeError);
});

// ── F-9 (deferred nit, now taken): revokeCapability — per-capability revoke,
// narrower than revokeGrants' whole-record wipe. ───────────────────────────

test('revokeCapability removes only the named capability, leaving other tiers/capabilities intact', () => {
  const file = tempFile();
  recordTierResult('acme', 'primary-eligible', { hash: HASH_A, evidence: 'led a run' }, { file });
  grantCapability('acme', 'canBePrimary', { hash: HASH_A }, { file });
  recordTierResult('acme', 'statusline', { hash: HASH_A, evidence: 'footer renders' }, { file });
  grantCapability('acme', 'commandStatusline', { hash: HASH_A }, { file });

  assert.equal(revokeCapability('acme', 'canBePrimary', { file }), true);

  const record = grantsFor('acme', { file });
  assert.ok(!Object.hasOwn(record.capabilities, 'canBePrimary'));
  assert.equal(record.capabilities.commandStatusline, true);
  // Tiers are untouched — still 'passed', not reverted.
  assert.equal(record.tiers['primary-eligible'].status, 'passed');
  assert.equal(record.tiers.statusline.status, 'passed');
  assert.deepEqual(grantedCapabilitiesFor('acme', HASH_A, { file }), { commandStatusline: true });
});

test('revokeCapability returns false when the capability was never granted, or the adapter has no record', () => {
  const file = tempFile();
  assert.equal(revokeCapability('acme', 'canBePrimary', { file }), false);
  recordTierResult('acme', 'primary-eligible', { hash: HASH_A, evidence: 'led a run' }, { file });
  // Tier passed but never granted -> capability never existed to revoke.
  assert.equal(revokeCapability('acme', 'canBePrimary', { file }), false);
});

test('revokeCapability rejects a non-grantable capability, including a forged aqeProvider key', () => {
  const file = tempFile();
  recordTierResult('acme', 'primary-eligible', { hash: HASH_A, evidence: 'led a run' }, { file });
  grantCapability('acme', 'canBePrimary', { hash: HASH_A }, { file });
  assert.throws(() => revokeCapability('acme', 'aqeProvider', { file }), TypeError);
  assert.throws(() => revokeCapability('acme', 'transcripts', { file }), TypeError);
  // Nothing was touched by the rejected attempts.
  assert.deepEqual(grantedCapabilitiesFor('acme', HASH_A, { file }), { canBePrimary: true });
});

test('revokeCapability on prototype-chain names returns false, never a prototype-chain hit', () => {
  const file = tempFile();
  for (const protoName of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
    assert.equal(revokeCapability(protoName, 'canBePrimary', { file }), false);
  }
});
