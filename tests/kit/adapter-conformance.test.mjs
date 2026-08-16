// Adapter Contract Dossier — BLACK-BOX conformance harness. Every other
// adapter-*.test.mjs file exercises admission/manifest/hook-runner as UNIT
// tests with in-memory manifests and injected readManifest/runHook stubs.
// This file is the graduation artifact ADR-0029 names: a REAL fixture
// adapter (tests/fixtures/adapters/acme/) admitted through the REAL
// admitAdapters, with a REAL on-disk consent record, whose declared
// lifecycle hook is a REAL subprocess actually spawned through the REAL
// hook-runner — proving the contract end-to-end, not just at the unit
// boundary (ruflo ADR-102: black-box subprocess tests against an installed
// layout catch what unit tests miss).
//
// A future external adapter (Hermes, first) is expected to pass this same
// shape of test against ITS OWN manifest — runConformanceReport() is
// exported so a future `ak adapters conformance` command or CI step can
// reuse this exact sequence instead of re-implementing it.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAdapterManifest } from '../../src/lib/adapters/manifest.mjs';
import { admitAdapters, hashManifest } from '../../src/lib/adapters/admission.mjs';
import {
  applyAdmitted, resetAdmitted, effectiveHostRegistry, admittedHostIds,
} from '../../src/lib/adapters/admitted.mjs';
import {
  recordConsent, recordedHashFor, isTrusted, revokeConsent,
} from '../../src/lib/adapters/consent.mjs';
import { registerAdmittedLifecycle } from '../../src/lib/adapters/lifecycle-registry.mjs';
import { registerAdmittedExecution, resetAdmittedExecution } from '../../src/lib/execution/admitted.mjs';
import { executeRunPlan } from '../../src/lib/execution/runner.mjs';

// Resolved relative to THIS file via fileURLToPath, never a hardcoded
// repo-absolute or monorepo-sibling path (ruflo #2912 counter-example) — so
// the harness works whether it runs from a checkout or an installed layout.
const FIXTURE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/adapters/acme');

const NEGATIVE_CORPUS = [
  ['a manifest claiming host.capabilities.canBePrimary', 'can-be-primary.json', 'acme-primary', 'cap-can-be-primary'],
  ['a manifest with a path-traversal guidanceFile', 'guidance-traversal.json', 'acme-legacy', 'invalid-guidance-file'],
  ['a manifest declaring an unsupported contract version', 'contract-two.json', 'acme-v2', 'contract-version'],
  ["a manifest shadowing the built-in 'claude' host id", 'shadow-claude.json', 'claude', 'builtin-shadow'],
];

/**
 * The manifest contract has no path-resolution policy of its own for
 * LIFECYCLE hooks (hook.command is just "a non-empty array of non-empty
 * strings" — manifest.mjs never inspects the values, and lifecycle-registry.mjs
 * spawns with no `cwd` anchoring). A real installed adapter would need SOME
 * resolution step to turn a portable manifest's declared lifecycle command
 * into a locally-runnable one; that step doesn't exist in src/ today, so
 * this remains a minimal, test-owned stand-in for lifecycle hooks ONLY: the
 * literal token 'node' becomes process.execPath, and a relative *.mjs
 * argument is resolved against the fixture's own directory.
 *
 * The EXECUTION hook (`execution.run.hook`) needs no such rewriting — Wave B
 * security review (F-1) gave admission.mjs a real baseDir-derivation +
 * cwd-anchoring path (registerAdmittedExecution -> buildAdmittedExecutionAdapter
 * -> runAdapterHook's `cwd` option), so the fixture's literal, UNREWRITTEN
 * `["node", "run-hook.mjs"]` resolves correctly through the real resolver:
 * 'node' via PATH, 'run-hook.mjs' relative to the fixture's own directory
 * (this manifest's `source` is a file path, so baseDir = FIXTURE_ROOT). A
 * test-side rewrite here would prove a safer-than-production path, not the
 * real one — see the negative-corpus/unanchored tests in adapter-execution.test.mjs
 * for what happens when there is no baseDir to anchor to.
 */
function resolveHookCommand(command, hookDir) {
  return command.map((part) => {
    if (part === 'node') return process.execPath;
    if (part.endsWith('.mjs') && !path.isAbsolute(part)) return path.join(hookDir, part);
    return part;
  });
}

function resolveManifestCommands(raw, hookDir) {
  if (!raw || typeof raw !== 'object' || !raw.lifecycle || typeof raw.lifecycle !== 'object') return raw;
  const lifecycle = {};
  for (const [verb, entry] of Object.entries(raw.lifecycle)) {
    lifecycle[verb] = entry?.hook?.command
      ? { ...entry, hook: { ...entry.hook, command: resolveHookCommand(entry.hook.command, hookDir) } }
      : entry;
  }
  return { ...raw, lifecycle };
}

/** admitAdapters' readManifest contract: `(source) => Promise<any>`. A REAL
 *  fs read of a REAL file — nothing about this fixture's admission path is
 *  in-memory. */
async function readManifestFromFile(source) {
  const text = fs.readFileSync(source, 'utf8');
  return resolveManifestCommands(JSON.parse(text), FIXTURE_ROOT);
}

function consentStoreFor(file) {
  return {
    recordedHashFor: (name) => recordedHashFor(name, { file }),
    isTrusted: (name, hash) => isTrusted(name, hash, { file }),
  };
}

const neverCalled = (label) => () => { throw new Error(`${label} must not be called`); };

/**
 * Run the full black-box conformance sequence against a fixture bundle and
 * return a numeric pass/fail summary — the evidence shape a graduation gate
 * (a future `ak` command or CI check) can consume directly. Self-contained:
 * builds its own temp consent store, runs every check independently (one
 * check's failure doesn't abort the rest — a downstream check that depends
 * on an earlier one just fails honestly with its own detail), and cleans up
 * after itself. Safe to call more than once in the same process.
 * @param {{ fixtureRoot?: string }} [options]
 * @returns {Promise<{ total: number, passed: number, failed: number,
 *   checks: Array<{ name: string, ok: boolean, detail?: string }> }>}
 */
export async function runConformanceReport({ fixtureRoot = FIXTURE_ROOT } = {}) {
  const checks = [];
  const run = async (name, fn) => {
    try {
      await fn();
      checks.push({ name, ok: true });
    } catch (error) {
      checks.push({ name, ok: false, detail: error?.message ?? String(error) });
    }
  };

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-adapter-conformance-'));
  const consentFile = path.join(tempDir, 'adapter-consent.json');
  const consent = consentStoreFor(consentFile);
  const validManifestPath = path.join(fixtureRoot, 'manifest.json');

  let validated = null;
  let admittedResult = null;

  await run('valid manifest parses, validates, and is admitted through a real on-disk consent record', async () => {
    const raw = await readManifestFromFile(validManifestPath);
    validated = validateAdapterManifest(raw);
    const validHash = hashManifest(validated);
    recordConsent('acme', validHash, { file: consentFile });
    const results = await admitAdapters({
      cfg: { hostAdapters: [{ name: 'acme', source: validManifestPath }] },
      readManifest: readManifestFromFile,
      consent,
    });
    admittedResult = results[0];
    assert.equal(admittedResult?.admitted, true, admittedResult?.detail ?? 'expected admission');
    assert.equal(admittedResult.entry.id, 'acme');
  });

  await run("admitted 'acme' host joins effectiveHostRegistry()", async () => {
    if (!admittedResult?.admitted) throw new Error('prerequisite: valid manifest was not admitted');
    applyAdmitted([admittedResult]);
    assert.ok(effectiveHostRegistry().some((host) => host.id === 'acme'));
    assert.ok(admittedHostIds().includes('acme'));
  });

  await run("the fixture's declared detect hook runs as a real subprocess and its JSON payload flows back", async () => {
    if (!validated) throw new Error('prerequisite: manifest was not validated');
    // No runHook injection: this exercises buildAdmittedLifecycleAdapter's
    // real default, a dynamic import of the real hook-runner.mjs — proof
    // the whole chain (derived adapter -> hook runner -> spawned Node
    // process -> stdout JSON) actually runs, not just that it's wired.
    const adapter = registerAdmittedLifecycle(validated);
    const detected = await adapter.detect({});
    assert.equal(detected?.observed?.host, 'acme');
    assert.equal(detected?.observed?.bin, 'acme');
    assert.equal(typeof detected?.observed?.pid, 'number');
  });

  await run("the fixture's declared execution.run hook drives a real one-worker plan end-to-end (P2, ADR-0031)", async () => {
    if (!validated) throw new Error('prerequisite: manifest was not validated');
    // No runHook injection here either: registerAdmittedExecution's default
    // dynamically imports the real hook-runner.mjs, and executeRunPlan's
    // default adapter lookup (executionAdapterFor) falls through to the
    // admitted overlay — proof the whole `ak run` path (materialized plan ->
    // execution seam -> derived adapter -> hook runner -> spawned Node
    // process -> stdout JSON -> WorkerResult) actually runs end-to-end.
    // baseDir mirrors exactly what bootstrapHostAdapters derives in
    // production (F-1) — this call bypasses that bootstrap wiring (it calls
    // registerAdmittedExecution directly), so it must reproduce the same
    // derivation rather than a test-only shortcut.
    resetAdmittedExecution();
    try {
      // haveFn only: the fixture's detection.bin ('acme') is a fictitious
      // binary that will never actually be on a test machine's PATH — that's
      // orthogonal to what this check proves (the execution.run hook itself
      // running end-to-end), so readiness is stubbed the same way a real
      // installed adapter's `acme` binary would report present. runHook
      // stays the real default: a genuine spawned subprocess.
      registerAdmittedExecution(validated, {
        haveFn: async () => true,
        baseDir: path.dirname(fs.realpathSync(validManifestPath)),
      });
      const plan = { workers: [{ id: 'w1', activity: 'implementation', role: 'coder', host: 'acme', prompt: 'do the thing' }] };
      const [result] = await executeRunPlan(plan, { clock: () => new Date().toISOString() });
      assert.equal(result.status, 'succeeded', result.failure?.reason ?? 'expected a succeeded WorkerResult');
      assert.equal(result.host, 'acme');
      assert.equal(result.exitCategory, 'success');
      assert.equal(result.provider, 'acme');
      // F-7: a payload-declared provider is 'inferred', never 'observed' —
      // ak did not verify the hook's claim against anything.
      assert.equal(result.providerProvenance, 'inferred');
    } finally {
      resetAdmittedExecution();
    }
  });

  for (const [description, file, cfgName, reason] of NEGATIVE_CORPUS) {
    await run(`negative corpus: ${description} is refused with reason '${reason}'`, async () => {
      const results = await admitAdapters({
        cfg: { hostAdapters: [{ name: cfgName, source: path.join(fixtureRoot, 'invalid', file) }] },
        readManifest: readManifestFromFile,
        // Every reason in the negative corpus fires before consent is even
        // consulted (structural cap, contract-version, or builtin-shadow all
        // return earlier in admitOne) — proven, not assumed, by making a
        // consent lookup here a hard failure.
        consent: { recordedHashFor: neverCalled('recordedHashFor'), isTrusted: neverCalled('isTrusted') },
      });
      assert.equal(results[0].admitted, false);
      assert.equal(results[0].reason, reason, results[0].detail);
    });
  }

  await run('edit-invalidation: mutating one byte of the manifest invalidates the prior consent (consent-stale)', async () => {
    const rawText = fs.readFileSync(validManifestPath, 'utf8');
    if (!rawText.includes('"1.0.0"')) throw new Error("fixture no longer declares version '1.0.0' — update this byte-mutation");
    const mutatedText = rawText.replace('"1.0.0"', '"1.0.1"');
    assert.notEqual(mutatedText, rawText);
    const mutatedRaw = resolveManifestCommands(JSON.parse(mutatedText), fixtureRoot);
    const results = await admitAdapters({
      cfg: { hostAdapters: [{ name: 'acme', source: 'mem://acme-mutated-by-conformance-report' }] },
      readManifest: async () => mutatedRaw,
      consent, // same store — still holds the ORIGINAL (pre-mutation) hash
    });
    assert.equal(results[0].admitted, false);
    assert.equal(results[0].reason, 'consent-stale');
  });

  resetAdmitted();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }

  const passed = checks.filter((c) => c.ok).length;
  return { total: checks.length, passed, failed: checks.length - passed, checks };
}

// ── node:test wiring: run the report once, assert each check individually ──
// so `node --test` reports itemized pass/fail, while runConformanceReport
// itself stays a plain, framework-independent async function.

let report;
before(async () => {
  report = await runConformanceReport();
});

function assertCheck(name) {
  const found = report.checks.find((c) => c.name === name);
  assert.ok(found, `no such check recorded: ${name}`);
  assert.equal(found.ok, true, found.detail);
}

test('valid manifest parses, validates, and is admitted through a real on-disk consent record', () => {
  assertCheck('valid manifest parses, validates, and is admitted through a real on-disk consent record');
});

test("admitted 'acme' host joins effectiveHostRegistry()", () => {
  assertCheck("admitted 'acme' host joins effectiveHostRegistry()");
});

test("the fixture's declared detect hook runs as a real subprocess and its JSON payload flows back", () => {
  assertCheck("the fixture's declared detect hook runs as a real subprocess and its JSON payload flows back");
});

test("the fixture's declared execution.run hook drives a real one-worker plan end-to-end (P2, ADR-0031)", () => {
  assertCheck("the fixture's declared execution.run hook drives a real one-worker plan end-to-end (P2, ADR-0031)");
});

for (const [description, , , reason] of NEGATIVE_CORPUS) {
  const name = `negative corpus: ${description} is refused with reason '${reason}'`;
  test(name, () => assertCheck(name));
}

test('edit-invalidation: mutating one byte of the manifest invalidates the prior consent (consent-stale)', () => {
  assertCheck('edit-invalidation: mutating one byte of the manifest invalidates the prior consent (consent-stale)');
});

test('runConformanceReport reports a clean pass with no failures', () => {
  assert.equal(report.failed, 0, JSON.stringify(report.checks.filter((c) => !c.ok), null, 2));
  assert.equal(report.total, 9);
  assert.equal(report.passed, 9);
});

// ── GAP CLOSED (Wave 4 security remediation, P0-A): consent hashing used to
// be scoped to the validated schema, not the manifest's full content ───────
//
// ADR-0029 §6 states the design intent plainly: "computes a content hash
// over the manifest... attached to a specific byte sequence, never to an
// identity that content can silently drift underneath." validateAdapterManifest
// used to reconstruct a literal object from exactly seven known keys (name,
// version, contract, host, detection, driving, lifecycle?, trust) and
// hashManifest hashed THAT — so any top-level key outside that set,
// including one that reads as an executable-looking hook declaration like
// "postInstall", was silently DROPPED before hashing rather than rejected.
// A recorded consent could therefore cover content the operator never
// reviewed.
//
// manifest.mjs now allowlists every top-level (and host/host.install/
// host.legacy) key: an unrecognized field is refused outright — 'unknown-
// field' — before validation even reaches the host/detection/driving
// sub-validators, so it can never reach hashManifest at all.
//
// tests/fixtures/adapters/acme/manifest-with-extraneous-field.json is
// manifest.json plus one added top-level "postInstall" key — kept as the
// fixture proving this exact class of attack is now closed, not merely
// documented.
test('GAP CLOSED: an added top-level field outside the schema is refused, not silently dropped before hashing', async () => {
  const validRaw = await readManifestFromFile(path.join(FIXTURE_ROOT, 'manifest.json'));
  const extraRaw = await readManifestFromFile(path.join(FIXTURE_ROOT, 'manifest-with-extraneous-field.json'));
  assert.ok('postInstall' in extraRaw, 'fixture sanity: the extra field must actually be present in the raw JSON');

  const validated = validateAdapterManifest(validRaw);
  assert.throws(() => validateAdapterManifest(extraRaw), (error) => {
    assert.equal(error.reason, 'unknown-field');
    assert.match(error.message, /postInstall/);
    return true;
  });

  const hash = hashManifest(validated);

  // Consequence, proven end-to-end: a manifest carrying the extraneous field
  // is refused by the real admission gate itself — reason 'unknown-field',
  // BEFORE consent is even consulted — never silently admitted under a
  // consent recorded for the original (extra-field-free) manifest.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-adapter-conformance-gap-'));
  const consentFile = path.join(tempDir, 'adapter-consent.json');
  try {
    recordConsent('acme', hash, { file: consentFile });
    const results = await admitAdapters({
      cfg: { hostAdapters: [{ name: 'acme', source: path.join(FIXTURE_ROOT, 'manifest-with-extraneous-field.json') }] },
      readManifest: readManifestFromFile,
      consent: { recordedHashFor: neverCalled('recordedHashFor'), isTrusted: neverCalled('isTrusted') },
    });
    assert.equal(results[0].admitted, false, 'the manifest with the added field must never be admitted');
    assert.equal(results[0].reason, 'unknown-field');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ── P2 finding 8: revokeConsent must not walk the prototype chain ──────────
// `name in store` (the `in` operator) checks the prototype chain, not just
// own properties. revokeConsent('constructor') — or 'toString',
// 'hasOwnProperty', ... — used to read true off Object.prototype and report
// having revoked consent for an adapter that was never actually consented
// to, which is a lie a caller (a future `ak host adapters` CLI) could act on.
test("revokeConsent('constructor') on a store that never consented to it returns false, not a prototype-chain lie", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-adapter-conformance-consent-'));
  const consentFile = path.join(tempDir, 'adapter-consent.json');
  try {
    for (const protoName of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      assert.equal(revokeConsent(protoName, { file: consentFile }), false,
        `revokeConsent('${protoName}') on a never-consented store must be false, not a prototype-chain hit`);
    }
    // A REAL consented adapter must still revoke correctly (own-property path
    // still works; this isn't just "everything returns false now").
    recordConsent('acme', 'deadbeef', { file: consentFile });
    assert.equal(revokeConsent('acme', { file: consentFile }), true);
    assert.equal(recordedHashFor('acme', { file: consentFile }), null);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
