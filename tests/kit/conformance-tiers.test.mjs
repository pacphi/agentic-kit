// Tiered conformance harness (ADR-0031 §2, §5) — src/lib/adapters/conformance.mjs.
// Reuses the acme fixture adapter-conformance.test.mjs established: real
// admission, real on-disk consent, a real spawned subprocess for both the
// lifecycle detect hook and the execution.run hook. This file proves the
// GENERALIZED tiered shape on top of that same fixture: which tiers
// genuinely pass, and which are honestly 'gated'/'skipped' rather than
// faked, per ADR-0031's "do not fake a pass" discipline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTieredConformance, CONFORMANCE_TIERS } from '../../src/lib/adapters/conformance.mjs';
import { grantsFor, recordTierResult, grantCapability } from '../../src/lib/adapters/grants.mjs';
import { lifecycleAdapterFor } from '../../src/lib/adapters/lifecycle-registry.mjs';

const FIXTURE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/adapters/acme');
const VALID_MANIFEST_PATH = path.join(FIXTURE_ROOT, 'manifest.json');

function tempGrantsFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-conformance-tiers-grants-'));
  return path.join(dir, 'adapter-grants.json');
}

/**
 * Reads the fixture manifest EXACTLY as authored — no command rewriting.
 * checkAdmission now threads a real baseDir into registerAdmittedLifecycle
 * (Wave C, F1), so the fixture's own literal, unrewritten
 * ["node","detect-hook.mjs"] resolves correctly through the real resolver:
 * 'node' via PATH (matches how the execution.run hook already worked
 * unrewritten — see the sibling comment this file used to carry), and the
 * relative 'detect-hook.mjs' anchored to the manifest's own directory via
 * the derived baseDir. If this rewrite were still needed, that would mean F1
 * regressed — this reader is deliberately a no-op beyond parsing, so the
 * admission tier proves the real, shipped resolution path.
 */
async function readManifestFromFile(source) {
  const text = fs.readFileSync(source, 'utf8');
  return JSON.parse(text);
}

function rawAcmeManifest(overrides = {}) {
  const text = fs.readFileSync(VALID_MANIFEST_PATH, 'utf8');
  const base = JSON.parse(text);
  return {
    ...base,
    ...overrides,
    host: { ...base.host, ...(overrides.host ?? {}), capabilities: { ...base.host.capabilities, ...(overrides.host?.capabilities ?? {}) } },
  };
}

// ── exports sanity ───────────────────────────────────────────────────────

test('re-exports the five ADR-0031 §2 conformance tiers in graduation order', () => {
  assert.deepEqual(CONFORMANCE_TIERS, [
    'admission', 'session-driving', 'activity-routing', 'primary-eligible', 'statusline',
  ]);
});

// ── admission tier: genuinely passes ────────────────────────────────────

test('admission tier passes against the acme fixture: real admission, real registry join, real detect-hook subprocess', async () => {
  const grantsFile = tempGrantsFile();
  const report = await runTieredConformance({
    manifestSource: VALID_MANIFEST_PATH,
    readManifest: readManifestFromFile,
    tiers: ['admission'],
    grantsFile,
  });

  assert.equal(report.name, 'acme');
  assert.ok(typeof report.hash === 'string' && report.hash.length > 0);
  assert.equal(report.tiers.length, 1);
  const [admissionTier] = report.tiers;
  assert.equal(admissionTier.tier, 'admission');
  assert.equal(admissionTier.status, 'passed', JSON.stringify(admissionTier.checks, null, 2));
  assert.ok(admissionTier.checks.length >= 3, 'expects manifest-validates, admits, registry-join, detect-hook checks');
  assert.ok(admissionTier.checks.every((c) => c.ok));

  const record = grantsFor('acme', { file: grantsFile });
  assert.equal(record.hash, report.hash);
  assert.equal(record.tiers.admission.status, 'passed');
});

test('admission tier fails honestly on an invalid manifest, with no grant-store write', async () => {
  const grantsFile = tempGrantsFile();
  const report = await runTieredConformance({
    manifestSource: 'mem://acme-primary-claim',
    readManifest: async () => rawAcmeManifest({ host: { capabilities: { canBePrimary: true } } }),
    tiers: ['admission'],
    grantsFile,
  });
  const [admissionTier] = report.tiers;
  assert.equal(admissionTier.status, 'failed');
  assert.ok(admissionTier.checks.some((c) => !c.ok));
  assert.equal(grantsFor('acme', { file: grantsFile }), null);
});

// ── F2 (Wave C security review, BLOCKER): a manifest that schema-VALIDATES
// but whose real admission (admitAdapters — consent/contract/name-mismatch)
// FAILS must not let any downstream tier still spawn a real hook or record
// 'passed'. Forcing a genuine admitOne 'name-mismatch' refusal (an explicit
// cfg `name` that disagrees with the manifest's own host.id) proves the
// distinction from the previous test: the manifest itself is schema-valid
// (check 1 in checkAdmission passes), only the SECOND check — the real
// admission gate — fails. Every downstream tier must see this exactly as if
// admission had never validated at all.

test('F2: a manifest that schema-validates but fails real admission (name-mismatch) short-circuits every downstream tier to skipped, with no hook spawned and nothing persisted', async () => {
  const grantsFile = tempGrantsFile();
  const report = await runTieredConformance({
    manifestSource: VALID_MANIFEST_PATH,
    readManifest: readManifestFromFile,
    name: 'not-acme', // disagrees with the fixture manifest's own host.id ('acme') -> admitOne refuses 'name-mismatch'
    tiers: ['admission', 'activity-routing', 'session-driving', 'primary-eligible', 'statusline'],
    grantsFile,
    haveFn: async () => true,
  });

  const admissionTier = report.tiers.find((t) => t.tier === 'admission');
  assert.equal(admissionTier.status, 'failed', JSON.stringify(admissionTier.checks, null, 2));
  assert.match(admissionTier.checks.find((c) => !c.ok)?.detail ?? '', /does not match manifest host id/);

  for (const tierName of ['activity-routing', 'session-driving', 'primary-eligible', 'statusline']) {
    const tier = report.tiers.find((t) => t.tier === tierName);
    assert.equal(tier.status, 'skipped', `${tierName}: ${JSON.stringify(tier.checks)}`);
    assert.match(tier.checks[0].detail, /admission tier did not pass/);
  }

  // Nothing at all persisted — not even the failed admission tier itself.
  assert.equal(grantsFor('not-acme', { file: grantsFile }), null);
  assert.equal(grantsFor('acme', { file: grantsFile }), null);
});

// ── activity-routing tier: genuinely passes (real subprocess worker) ───────

test('activity-routing tier genuinely passes against acme via a real subprocess worker (ADR-0018)', async () => {
  const grantsFile = tempGrantsFile();
  const report = await runTieredConformance({
    manifestSource: VALID_MANIFEST_PATH,
    readManifest: readManifestFromFile,
    tiers: ['activity-routing'],
    grantsFile,
    haveFn: async () => true, // acme's detection.bin will never be on a test machine's PATH
  });

  const [tier] = report.tiers;
  assert.equal(tier.tier, 'activity-routing');
  assert.equal(tier.status, 'passed', JSON.stringify(tier.checks, null, 2));
  assert.match(tier.evidence, /succeeded/);
  assert.match(tier.evidence, /acme/);

  const record = grantsFor('acme', { file: grantsFile });
  assert.equal(record.tiers['activity-routing'].status, 'passed');
  assert.ok(record.tiers['activity-routing'].evidence.length > 0);
});

test('activity-routing tier is honestly skipped when the manifest declares neither canRouteActivities nor an execution.run hook', async () => {
  const grantsFile = tempGrantsFile();
  const report = await runTieredConformance({
    manifestSource: 'mem://acme-no-execution',
    readManifest: async () => {
      const raw = rawAcmeManifest({ host: { capabilities: { canRouteActivities: false } } });
      delete raw.execution;
      // No baseDir exists for a mem:// source, so the fixture's own relative
      // lifecycle.detect.hook.command would be refused as unanchorable (F1)
      // and fail admission for a reason unrelated to what this test isolates
      // (canRouteActivities/execution.run absence) — drop lifecycle too, so
      // the skip below is provably the activity-routing check's own, not a
      // side effect of the admission prerequisite failing.
      delete raw.lifecycle;
      return raw;
    },
    tiers: ['admission', 'activity-routing'],
    grantsFile,
  });
  const admissionTier = report.tiers.find((t) => t.tier === 'admission');
  const tier = report.tiers.find((t) => t.tier === 'activity-routing');
  assert.equal(admissionTier.status, 'passed', JSON.stringify(admissionTier.checks, null, 2));
  assert.equal(tier.status, 'skipped');
  assert.match(tier.checks[0].detail, /not declared/);
  const record = grantsFor('acme', { file: grantsFile });
  assert.equal(record.tiers.admission.status, 'passed'); // admission legitimately recorded
  assert.equal(record.tiers['activity-routing'], undefined); // the skipped tier recorded nothing
});

// ── session-driving tier: honest skipped/gated, never faked ────────────────

test('session-driving tier is skipped when the manifest does not declare canDriveSession', async () => {
  const grantsFile = tempGrantsFile();
  const report = await runTieredConformance({
    manifestSource: VALID_MANIFEST_PATH,
    readManifest: readManifestFromFile,
    tiers: ['session-driving'],
    grantsFile,
  });
  const [tier] = report.tiers;
  assert.equal(tier.status, 'skipped');
  assert.notEqual(tier.status, 'passed');
  assert.equal(grantsFor('acme', { file: grantsFile }), null);
});

test('session-driving tier is honestly gated (never passed) when canDriveSession is declared but no external session-driving path exists', async () => {
  const grantsFile = tempGrantsFile();
  const report = await runTieredConformance({
    manifestSource: 'mem://acme-session-driving',
    readManifest: async () => {
      const raw = rawAcmeManifest({ host: { capabilities: { canDriveSession: true, canRouteActivities: false } } });
      delete raw.execution;
      // No baseDir exists for a mem:// source (nothing to fs.realpathSync),
      // so the fixture's own relative lifecycle.detect.hook.command would be
      // refused as unanchorable (F1) and fail admission — orthogonal to what
      // this test isolates (session-driving semantics), so drop lifecycle too.
      delete raw.lifecycle;
      return raw;
    },
    tiers: ['admission', 'session-driving'],
    grantsFile,
  });
  const admissionTier = report.tiers.find((t) => t.tier === 'admission');
  const tier = report.tiers.find((t) => t.tier === 'session-driving');
  assert.equal(admissionTier.status, 'passed', JSON.stringify(admissionTier.checks, null, 2));
  assert.equal(tier.status, 'gated');
  assert.notEqual(tier.status, 'passed');
  assert.match(tier.detail, /ruflo/i);
  // No upstream ref supplied -> nothing persisted for THIS tier (there is no
  // real tracking issue to pin a recordTierGate() call to yet) — admission
  // still legitimately recorded, since it genuinely passed.
  assert.equal(tier.gatedBy, undefined);
  const record = grantsFor('acme', { file: grantsFile });
  assert.equal(record.tiers.admission.status, 'passed');
  assert.equal(record.tiers['session-driving'], undefined);
});

test('session-driving tier persists via recordTierGate when a real upstream ref is supplied', async () => {
  const grantsFile = tempGrantsFile();
  const report = await runTieredConformance({
    manifestSource: 'mem://acme-session-driving-ref',
    readManifest: async () => {
      const raw = rawAcmeManifest({ host: { capabilities: { canDriveSession: true, canRouteActivities: false } } });
      delete raw.execution;
      // No baseDir exists for a mem:// source (nothing to fs.realpathSync),
      // so the fixture's own relative lifecycle.detect.hook.command would be
      // refused as unanchorable (F1) and fail admission — orthogonal to what
      // this test isolates (session-driving semantics), so drop lifecycle too.
      delete raw.lifecycle;
      return raw;
    },
    tiers: ['session-driving'],
    grantsFile,
    sessionDrivingUpstreamRef: 'ruvnet/ruflo#9001',
  });
  const [tier] = report.tiers;
  assert.equal(tier.status, 'gated');
  assert.equal(tier.gatedBy, 'ruvnet/ruflo#9001');
  const record = grantsFor('acme', { file: grantsFile });
  assert.equal(record.tiers['session-driving'].status, 'gated');
  assert.equal(record.tiers['session-driving'].gatedBy, 'ruvnet/ruflo#9001');
});

// ── primary-eligible / statusline: honest gated, ungranted or unbuilt ──────

test('primary-eligible and statusline tiers are gated (never passed) against acme with no grant recorded', async () => {
  const grantsFile = tempGrantsFile();
  const report = await runTieredConformance({
    manifestSource: VALID_MANIFEST_PATH,
    readManifest: readManifestFromFile,
    tiers: ['primary-eligible', 'statusline'],
    grantsFile,
  });
  for (const tier of report.tiers) {
    assert.equal(tier.status, 'gated', `${tier.tier}: ${JSON.stringify(tier.checks)}`);
    assert.notEqual(tier.status, 'passed');
    assert.match(tier.detail, /ak-local/);
  }
  assert.equal(grantsFor('acme', { file: grantsFile }), null);
});

// F-6 (security review): the property that actually holds the "no exercise
// confers a grant" invariant is checkGrantGatedTier evaluating `granted`
// BEFORE ever calling `exercise` (conformance.mjs) — a caller-supplied
// exercise result can never confer the FIRST grant, because exercise is
// simply never reached without one already recorded. Pin that ordering
// directly: inject a real exercisePrimaryEligible with NO existing grant.
test('primary-eligible tier stays gated (never passed) when an exercise callback is injected but no grant exists — granted is checked BEFORE exercise runs', async () => {
  const grantsFile = tempGrantsFile();
  const report = await runTieredConformance({
    manifestSource: VALID_MANIFEST_PATH,
    readManifest: readManifestFromFile,
    tiers: ['primary-eligible'],
    grantsFile,
    exercisePrimaryEligible: async () => ({ ok: true }),
  });
  const [tier] = report.tiers;
  assert.equal(tier.status, 'gated');
  assert.notEqual(tier.status, 'passed');
  assert.equal(grantsFor('acme', { file: grantsFile }), null, 'a caller-supplied exercise result must never confer the FIRST grant');
});

test('primary-eligible tier stays honestly gated even when GRANTED, because no lead/escalation runtime path is built yet', async () => {
  const grantsFile = tempGrantsFile();
  // Seed a real grant the way the (future) promotion command would.
  const hash = (await runTieredConformance({
    manifestSource: VALID_MANIFEST_PATH, readManifest: readManifestFromFile, tiers: ['admission'], grantsFile,
  })).hash;
  recordTierResult('acme', 'primary-eligible', { hash, evidence: 'seeded for test' }, { file: grantsFile });
  grantCapability('acme', 'canBePrimary', { hash }, { file: grantsFile });

  const report = await runTieredConformance({
    manifestSource: VALID_MANIFEST_PATH,
    readManifest: readManifestFromFile,
    tiers: ['primary-eligible'],
    grantsFile,
  });
  const [tier] = report.tiers;
  assert.equal(tier.status, 'gated');
  assert.notEqual(tier.status, 'passed');
  assert.match(tier.detail, /granted/);
  assert.match(tier.detail, /not built/);
});

test('primary-eligible tier PASSES when granted AND a real exercise path is injected (proves the injection seam, not a built-in fake)', async () => {
  const grantsFile = tempGrantsFile();
  const hash = (await runTieredConformance({
    manifestSource: VALID_MANIFEST_PATH, readManifest: readManifestFromFile, tiers: ['admission'], grantsFile,
  })).hash;
  recordTierResult('acme', 'primary-eligible', { hash, evidence: 'seeded for test' }, { file: grantsFile });
  grantCapability('acme', 'canBePrimary', { hash }, { file: grantsFile });

  const report = await runTieredConformance({
    manifestSource: VALID_MANIFEST_PATH,
    readManifest: readManifestFromFile,
    tiers: ['primary-eligible'],
    grantsFile,
    exercisePrimaryEligible: async () => ({ ok: true, detail: 'led a run and received a simulated escalation' }),
  });
  const [tier] = report.tiers;
  assert.equal(tier.status, 'passed');
  assert.equal(tier.evidence, 'led a run and received a simulated escalation');
  const record = grantsFor('acme', { file: grantsFile });
  assert.equal(record.tiers['primary-eligible'].status, 'passed');
  assert.equal(record.tiers['primary-eligible'].evidence, 'led a run and received a simulated escalation');
});

test('statusline tier is skipped/gated (never passed) when the admission prerequisite tier is not part of this run and the manifest never admitted', async () => {
  const grantsFile = tempGrantsFile();
  const report = await runTieredConformance({
    manifestSource: 'mem://does-not-admit',
    readManifest: async () => { throw new Error('unreadable on purpose'); },
    tiers: ['statusline'],
    grantsFile,
  });
  const [tier] = report.tiers;
  assert.equal(tier.status, 'skipped');
  assert.notEqual(tier.status, 'passed');
});

// ── full sequence + persistence summary ─────────────────────────────────

test('running all five tiers together against acme yields exactly one passed-non-admission tier (activity-routing) plus admission, with nothing faked', async () => {
  const grantsFile = tempGrantsFile();
  const report = await runTieredConformance({
    manifestSource: VALID_MANIFEST_PATH,
    readManifest: readManifestFromFile,
    grantsFile,
    haveFn: async () => true,
  });
  assert.equal(report.tiers.length, 5);
  const byTier = Object.fromEntries(report.tiers.map((t) => [t.tier, t.status]));
  assert.equal(byTier.admission, 'passed');
  assert.equal(byTier['session-driving'], 'skipped'); // acme declares canDriveSession:false
  assert.equal(byTier['activity-routing'], 'passed');
  assert.equal(byTier['primary-eligible'], 'gated');
  assert.equal(byTier.statusline, 'gated');

  const record = grantsFor('acme', { file: grantsFile });
  assert.equal(record.tiers.admission.status, 'passed');
  assert.equal(record.tiers['activity-routing'].status, 'passed');
  assert.equal(record.tiers['primary-eligible'], undefined, 'an ak-local gate with no upstream ref persists nothing');
  assert.equal(record.tiers.statusline, undefined);
});

// ── persist:false opt-out ───────────────────────────────────────────────

test('persist:false runs the full sequence without writing anything to the grant store', async () => {
  const grantsFile = tempGrantsFile();
  const report = await runTieredConformance({
    manifestSource: VALID_MANIFEST_PATH,
    readManifest: readManifestFromFile,
    tiers: ['admission'],
    grantsFile,
    persist: false,
  });
  assert.equal(report.tiers[0].status, 'passed');
  assert.equal(grantsFor('acme', { file: grantsFile }), null);
});

// ── self-contained + repeatable ─────────────────────────────────────────

// ── F7 (Wave C security review): the lifecycle overlay must not leak ───────
// checkAdmission's detect-hook check registers a real lifecycle adapter via
// registerAdmittedLifecycle. Before F7 the finally block only reset the host
// and execution overlays, leaving that registration live in
// LIFECYCLE_ADAPTERS after runTieredConformance returned — an
// already-bootstrapped-looking 'acme' lifecycle adapter surviving a
// conformance run that (in another test) may have refused it.

test('does not leak an admitted lifecycle registration after returning (F7)', async () => {
  const grantsFile = tempGrantsFile();
  assert.equal(lifecycleAdapterFor('acme'), null, 'sanity: nothing registered before this test runs');
  const report = await runTieredConformance({
    manifestSource: VALID_MANIFEST_PATH, readManifest: readManifestFromFile, tiers: ['admission'], grantsFile,
  });
  assert.equal(report.tiers[0].status, 'passed');
  assert.equal(lifecycleAdapterFor('acme'), null, 'the admitted lifecycle registration must not survive the run');
});

test('is safe to call repeatedly and cleans up its own temp consent store when none is supplied', async () => {
  for (let i = 0; i < 2; i += 1) {
    const grantsFile = tempGrantsFile();
    const report = await runTieredConformance({
      manifestSource: VALID_MANIFEST_PATH, readManifest: readManifestFromFile, tiers: ['admission'], grantsFile,
    });
    assert.equal(report.tiers[0].status, 'passed');
  }
});
