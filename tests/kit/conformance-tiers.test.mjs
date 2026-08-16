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
import {
  grantsFor, grantCapability, grantedCapabilitiesFor, recordTierResult,
} from '../../src/lib/adapters/grants.mjs';
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

// ── statusline: honest gated, ungranted (untouched this wave) ──────────────

test('statusline tier is gated (never passed) against acme with no grant recorded', async () => {
  const grantsFile = tempGrantsFile();
  const report = await runTieredConformance({
    manifestSource: VALID_MANIFEST_PATH,
    readManifest: readManifestFromFile,
    tiers: ['statusline'],
    grantsFile,
  });
  const [tier] = report.tiers;
  assert.equal(tier.status, 'gated', JSON.stringify(tier.checks));
  assert.notEqual(tier.status, 'passed');
  assert.match(tier.detail, /ak-local/);
  assert.equal(grantsFor('acme', { file: grantsFile }), null);
});

// ── primary-eligible: honest activity-routing dependency ───────────────────

test('primary-eligible tier is skipped when activity-routing did not pass this run', async () => {
  const grantsFile = tempGrantsFile();
  // No haveFn override: acme's detection.bin will never be on a test
  // machine's real PATH, so activity-routing genuinely fails this run —
  // primary-eligible must short-circuit on that.
  const report = await runTieredConformance({
    manifestSource: VALID_MANIFEST_PATH,
    readManifest: readManifestFromFile,
    tiers: ['primary-eligible'],
    grantsFile,
  });
  const [tier] = report.tiers;
  assert.equal(tier.status, 'skipped', JSON.stringify(tier.checks));
  assert.notEqual(tier.status, 'passed');
  assert.match(tier.checks[0].detail, /activity-routing did not pass/);
  assert.equal(grantsFor('acme', { file: grantsFile }), null);
});

test('primary-eligible tier is skipped on a missing activity-routing prerequisite even when a real grant was earned earlier through the sanctioned flow', async () => {
  const grantsFile = tempGrantsFile();
  // Earn the grant honestly first, via the real sanctioned sequence (ADR-0031
  // §2): a run with activity-routing genuinely passing records a real
  // 'passed' primary-eligible tier, which grantCapability (grants.mjs)
  // requires before it will confer canBePrimary — never hand-seeded.
  const earned = await runTieredConformance({
    manifestSource: VALID_MANIFEST_PATH,
    readManifest: readManifestFromFile,
    tiers: ['primary-eligible'],
    grantsFile,
    haveFn: async () => true,
  });
  assert.equal(earned.tiers[0].status, 'passed', JSON.stringify(earned.tiers[0].checks));
  grantCapability('acme', 'canBePrimary', { hash: earned.hash }, { file: grantsFile });

  // Re-run WITHOUT the haveFn override — activity-routing genuinely fails
  // this run, so primary-eligible must short-circuit regardless of the (now
  // real, honestly earned) grant already sitting in the store.
  const report = await runTieredConformance({
    manifestSource: VALID_MANIFEST_PATH,
    readManifest: readManifestFromFile,
    tiers: ['primary-eligible'],
    grantsFile,
  });
  const [tier] = report.tiers;
  assert.equal(tier.status, 'skipped', JSON.stringify(tier.checks));
  assert.match(tier.checks[0].detail, /activity-routing did not pass/);
});

// ── primary-eligible: the real exercise, evidence-first (F-1 fix) ──────────
// F-1 (security review, HIGH, fixed): the exercise runs UNCONDITIONALLY —
// never gated on a pre-existing canBePrimary grant. Gating it on the grant
// it exists to justify was a deadlock: grantCapability (grants.mjs) refuses
// unless a 'passed' primary-eligible tier is ALREADY recorded at this hash,
// so the only way it could ever pass before this fix was hand-seeding a fake
// tier result first — defeating the whole earned-evidence point of
// ADR-0031 §2 ("passing a tier records evidence; the maintainer's grant
// turns evidence into capability" — evidence comes FIRST). These tests prove
// the corrected, sanctioned sequence with NO hand-seeding anywhere.

test('primary-eligible tier GENUINELY PASSES via the real exercise with NO pre-existing grant — evidence records first, per ADR-0031 §2', async () => {
  const grantsFile = tempGrantsFile();
  assert.equal(grantsFor('acme', { file: grantsFile }), null, 'sanity: nothing recorded before this run');

  const report = await runTieredConformance({
    manifestSource: VALID_MANIFEST_PATH,
    readManifest: readManifestFromFile,
    tiers: ['primary-eligible'],
    grantsFile,
    haveFn: async () => true,
  });
  const [tier] = report.tiers;
  assert.equal(tier.status, 'passed', JSON.stringify(tier.checks, null, 2));
  // Real evidence, not a fabricated string — worded to what was actually
  // demonstrated (a direct run plus a genuine ADR-0019 escalation onto the
  // same host: ladder + execution-contract plumbing), not an overclaim about
  // agentic task quality (F-7).
  assert.match(tier.evidence, /'acme' completed a direct \(non-escalated\) run/);
  assert.match(tier.evidence, /genuine ADR-0019 escalation onto itself/);
  assert.match(tier.evidence, /2 attempts:/);
  assert.match(tier.evidence, /=failed -> acme=succeeded/);

  const record = grantsFor('acme', { file: grantsFile });
  assert.equal(record.tiers['primary-eligible'].status, 'passed');
  assert.match(record.tiers['primary-eligible'].evidence, /genuine ADR-0019 escalation/);
});

test('the sanctioned §2 sequence end to end: a freshly-passed tier with NO prior grant lets grantCapability confer a LIVE canBePrimary', async () => {
  const grantsFile = tempGrantsFile();
  assert.equal(grantsFor('acme', { file: grantsFile }), null, 'sanity: nothing recorded before this run');

  // Step 1: the real exercise earns the evidence (no grant exists yet).
  const report = await runTieredConformance({
    manifestSource: VALID_MANIFEST_PATH,
    readManifest: readManifestFromFile,
    tiers: ['primary-eligible'],
    grantsFile,
    haveFn: async () => true,
  });
  assert.equal(report.tiers[0].status, 'passed', JSON.stringify(report.tiers[0].checks));
  assert.equal(
    grantedCapabilitiesFor('acme', report.hash, { file: grantsFile }).canBePrimary,
    undefined,
    'passing the tier alone must never itself grant the capability',
  );

  // Step 2: the maintainer's explicit act (ADR-0031 §1) — only possible now
  // because the tier is genuinely 'passed' at this hash, not because
  // anything above hand-seeded it.
  grantCapability('acme', 'canBePrimary', { hash: report.hash }, { file: grantsFile });
  assert.equal(grantedCapabilitiesFor('acme', report.hash, { file: grantsFile }).canBePrimary, true);
});

test('primary-eligible tier: a caller-supplied legacy exercisePrimaryEligible option has no effect — there is no injection seam, only the real exercise ever runs', async () => {
  const grantsFile = tempGrantsFile();
  const report = await runTieredConformance({
    manifestSource: VALID_MANIFEST_PATH,
    readManifest: readManifestFromFile,
    tiers: ['primary-eligible'],
    grantsFile,
    haveFn: async () => true,
    // Not a real option on runTieredConformance anymore (silently ignored) —
    // proves a caller cannot launder a fabricated pass through what used to
    // be the injection point.
    exercisePrimaryEligible: async () => ({ ok: true, detail: 'FAKE-LAUNDERED-PASS' }),
  });
  const [tier] = report.tiers;
  assert.equal(tier.status, 'passed');
  assert.notEqual(tier.evidence, 'FAKE-LAUNDERED-PASS');
  assert.match(tier.evidence, /genuine ADR-0019 escalation onto itself/);
  const record = grantsFor('acme', { file: grantsFile });
  assert.notEqual(record.tiers['primary-eligible'].evidence, 'FAKE-LAUNDERED-PASS');
});

// ── N-1 (security-review follow-up): the persist loop's un-earn path ───────
// recordTierGate already voids a live capability when a grant-bearing tier
// is downgraded to 'gated' at the same hash (F-2 above). These tests prove
// the mirrored path for a genuine RE-FAIL: a grant-bearing tier that runs
// 'failed' at the SAME (unchanged) hash a capability was earned at must void
// both the stored tier and the capability — never leave a live capability
// standing on evidence just shown non-reproducible.

/** A custom execution.run.hook (inline `node -e`, no fixture file edits) that
 * succeeds for activity-routing's own worker (id 'conformance-w1' — never
 * matches the 'primary-eligible' prefix check) but genuinely fails for
 * primary-eligible's two workers (ids 'primary-eligible-direct'/
 * '-escalation'), gated behind an on-disk flag file the test flips between
 * runs. This lets the SAME manifest content (same hash) genuinely PASS
 * primary-eligible on one run and genuinely FAIL it on the next, while
 * activity-routing — primary-eligible's own real prerequisite — keeps
 * genuinely passing both times. No '/' or '\' anywhere in the inline script
 * text: commandIsUnanchorable (execution/admitted.mjs) inspects every arg,
 * and a slash would make this otherwise-absolute-argv0 command read as
 * needing baseDir anchoring, which this mem:// source has none of. */
function flakyPrimaryEligibleManifest(flagPath) {
  const NODE = process.execPath;
  const script = 'const fs=require("fs");let i="";process.stdin.on("data",c=>{i+=c});'
    + 'process.stdin.on("end",()=>{const id=process.env.AK_WORKER_ID||"";const flag=process.argv[1];'
    + 'if(id.indexOf("primary-eligible")===0&&fs.existsSync(flag)){process.stderr.write("deliberate re-run failure");process.exit(3);return}'
    + 'process.stdout.write(JSON.stringify({summary:"ok "+id,observedModel:null,provider:"acme-flaky"}))});';
  const raw = rawAcmeManifest();
  // No baseDir exists for this mem:// source, so the fixture's own relative
  // lifecycle.detect.hook.command would be refused as unanchorable (F1) —
  // orthogonal to what this test isolates, so drop it, same pattern the
  // other mem:// tests in this file already use.
  delete raw.lifecycle;
  raw.execution = { run: { hook: { command: [NODE, '-e', script, flagPath] } } };
  return raw;
}

test('N-1: a grant-bearing tier that RE-FAILS at the SAME hash voids the stored tier and the live capability, leaving an unrelated grant untouched', async () => {
  const grantsFile = tempGrantsFile();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-conformance-tiers-refail-'));
  const flagPath = path.join(dir, 'fail-after-here');
  const manifestSource = 'mem://acme-flaky-primary-eligible';
  const readManifest = async () => flakyPrimaryEligibleManifest(flagPath);

  // Step 1: earn primary-eligible honestly (no flag file yet -> the flaky
  // hook succeeds for every worker id), grant canBePrimary, and separately
  // force-record + grant an UNRELATED statusline capability at the same hash
  // — the control this test proves survives untouched.
  const earned = await runTieredConformance({
    manifestSource, readManifest, tiers: ['primary-eligible'], grantsFile, haveFn: async () => true,
  });
  assert.equal(earned.tiers[0].status, 'passed', JSON.stringify(earned.tiers[0].checks, null, 2));
  grantCapability('acme', 'canBePrimary', { hash: earned.hash }, { file: grantsFile });
  recordTierResult('acme', 'statusline', { hash: earned.hash, evidence: 'footer renders' }, { file: grantsFile });
  grantCapability('acme', 'commandStatusline', { hash: earned.hash }, { file: grantsFile });
  assert.deepEqual(
    grantedCapabilitiesFor('acme', earned.hash, { file: grantsFile }),
    { canBePrimary: true, commandStatusline: true },
  );

  // Step 2: flip the flag -> the SAME manifest content (same hash, same
  // command) now genuinely fails the primary-eligible exercise, while
  // activity-routing (worker id 'conformance-w1') still genuinely passes.
  fs.writeFileSync(flagPath, '');
  const refailed = await runTieredConformance({
    manifestSource, readManifest, tiers: ['primary-eligible'], grantsFile, haveFn: async () => true,
  });
  assert.equal(refailed.hash, earned.hash, 'sanity: same manifest content, same hash');
  const [tier] = refailed.tiers;
  assert.equal(tier.status, 'failed', JSON.stringify(tier.checks, null, 2));

  const record = grantsFor('acme', { file: grantsFile });
  assert.equal(record.tiers['primary-eligible'].status, 'failed');
  assert.ok(!Object.hasOwn(record.capabilities ?? {}, 'canBePrimary'), 'canBePrimary must be voided, not left standing on disproven evidence');
  assert.deepEqual(
    grantedCapabilitiesFor('acme', earned.hash, { file: grantsFile }),
    { commandStatusline: true },
    'an unrelated live grant earned at the same hash must survive a primary-eligible re-fail',
  );
});

test('N-1: a SKIPPED primary-eligible result (its own prerequisite did not run/pass this run) does NOT void an already-earned capability', async () => {
  const grantsFile = tempGrantsFile();
  // Earn the grant honestly first, same sanctioned flow the F-1 tests above use.
  const earned = await runTieredConformance({
    manifestSource: VALID_MANIFEST_PATH, readManifest: readManifestFromFile, tiers: ['primary-eligible'], grantsFile,
    haveFn: async () => true,
  });
  assert.equal(earned.tiers[0].status, 'passed', JSON.stringify(earned.tiers[0].checks));
  grantCapability('acme', 'canBePrimary', { hash: earned.hash }, { file: grantsFile });
  assert.deepEqual(grantedCapabilitiesFor('acme', earned.hash, { file: grantsFile }), { canBePrimary: true });

  // Re-run WITHOUT the haveFn override -> activity-routing genuinely fails
  // this run (acme's detection.bin is never really on a test machine's
  // PATH), so primary-eligible short-circuits to 'skipped' — its own
  // prerequisite was never evaluated this run, which is ambiguous, not a
  // disproof of anything already earned.
  const report = await runTieredConformance({
    manifestSource: VALID_MANIFEST_PATH, readManifest: readManifestFromFile, tiers: ['primary-eligible'], grantsFile,
  });
  assert.equal(report.tiers[0].status, 'skipped', JSON.stringify(report.tiers[0].checks));

  assert.deepEqual(
    grantedCapabilitiesFor('acme', earned.hash, { file: grantsFile }),
    { canBePrimary: true },
    'a skipped (never-evaluated) tier must never void an already-earned capability',
  );
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

test('running all five tiers together against acme yields three genuinely-passed tiers (admission, activity-routing, primary-eligible) plus an honestly gated statusline, with nothing faked', async () => {
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
  // primary-eligible now genuinely passes in the same run (F-1 fix): its
  // real exercise is unconditional, not gated on a pre-existing grant — no
  // grant was seeded anywhere in this test.
  assert.equal(byTier['primary-eligible'], 'passed');
  assert.equal(byTier.statusline, 'gated');

  const record = grantsFor('acme', { file: grantsFile });
  assert.equal(record.tiers.admission.status, 'passed');
  assert.equal(record.tiers['activity-routing'].status, 'passed');
  assert.equal(record.tiers['primary-eligible'].status, 'passed');
  assert.ok(record.tiers['primary-eligible'].evidence.length > 0);
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
