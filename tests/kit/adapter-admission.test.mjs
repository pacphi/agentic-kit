// Adapter Contract Dossier — admission gate + overlay + derived lifecycle.
// admitAdapters must fail closed (never prompt, never construction-throw for
// a bad entry), isolate one bad entry from every other, and refuse a
// built-in-shadowing id. bootstrapHostAdapters must be a true no-op with the
// experimental flag unset. buildAdmittedLifecycleAdapter must route declared
// verbs through an injected hook runner and never fabricate a result for an
// undeclared one.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  admitAdapters, bootstrapHostAdapters, hashManifest, canonicalizeManifest, SUPPORTED_CONTRACT,
} from '../../src/lib/adapters/admission.mjs';
import {
  applyAdmitted, resetAdmitted, admittedHostIds, effectiveHostRegistry,
} from '../../src/lib/adapters/admitted.mjs';
import { validateAdapterManifest } from '../../src/lib/adapters/manifest.mjs';
import { validateLifecycleAdapter } from '../../src/lib/adapters/lifecycle.mjs';
import {
  buildAdmittedLifecycleAdapter, registerAdmittedLifecycle, lifecycleAdapterFor,
} from '../../src/lib/adapters/lifecycle-registry.mjs';
import { HOST_REGISTRY } from '../../src/lib/adapters/registries.mjs';

beforeEach(() => resetAdmitted());

function validHost(overrides = {}) {
  return {
    id: 'hermes',
    label: 'Hermes',
    install: { bin: 'hermes', externalInstallPolicy: 'detect-never-overwrite' },
    capabilities: {
      canDriveSession: true, canBePrimary: false, canRouteActivities: true,
      commandStatusline: false, transcripts: true, usage: false,
      nativeMcpConfig: false, nativeGuidance: false,
    },
    trust: { approvalPolicy: 'unchanged', changes: [] },
    enabledByDefault: false,
    configProjection: 'ruflo',
    observability: [],
    ...overrides,
  };
}

function validManifest(overrides = {}) {
  return {
    name: 'hermes',
    version: '1.0.0',
    contract: 1,
    host: validHost(),
    detection: { bin: 'hermes' },
    driving: { surfaces: ['acp'] },
    trust: {
      changes: [{
        id: 'hermes-subprocess-hooks', kind: 'third-party-adapter', scope: 'project',
        owner: 'hermes', value: 'subprocess hooks', effect: 'run consented lifecycle hooks for hermes',
      }],
    },
    ...overrides,
  };
}

/** Consent store that trusts exactly the {name: hash} pairs given. */
function trustingConsent(trusted = {}) {
  return {
    recordedHashFor: (name) => trusted[name] ?? null,
    isTrusted: (name, hash) => trusted[name] === hash,
  };
}

const neverCalled = (label) => () => { throw new Error(`${label} must not be called`); };

test('SUPPORTED_CONTRACT is 1', () => {
  assert.equal(SUPPORTED_CONTRACT, 1);
});

test('hashManifest is deterministic and key-order independent', () => {
  const a = hashManifest({ a: 1, b: { c: 2, d: 3 } });
  const b = hashManifest({ b: { d: 3, c: 2 }, a: 1 });
  assert.equal(a, b);
  assert.notEqual(a, hashManifest({ a: 1, b: { c: 2, d: 4 } }));
});

// ── P0-B: locale-independent hash ───────────────────────────────────────────
// canonicalizeManifest used to sort keys with String#localeCompare, whose
// result depends on the current ICU collation (locale). A key set containing
// a locale-sensitive character (e.g. 'ä') can sort differently under
// different locales, so the SAME manifest could canonicalize — and hash —
// differently on a CI runner or container whose locale differs from where
// consent was originally recorded, producing a bogus consent-stale refusal
// for a manifest that never actually changed.
test('canonicalizeManifest sorts keys by code unit, not locale collation', () => {
  // Sanity check pinning the very drift this fix closes: under this
  // process's ICU/locale, localeCompare puts 'ä' BEFORE 'z' — the opposite
  // of code-unit order (ä is U+00E4 = 228, z is U+007A = 122).
  assert.ok('ä'.localeCompare('z') < 0, 'sanity: this run\'s locale sorts ä before z under localeCompare');
  const canon = canonicalizeManifest({ z: 1, ä: 2, a: 3 });
  assert.ok(
    canon.indexOf('"z"') < canon.indexOf('"ä"'),
    `expected code-unit order (z before ä — NOT locale-collated), got: ${canon}`,
  );
});

test('hashManifest is stable across key permutations even with locale-sensitive characters', () => {
  const a = hashManifest({ z: 1, ä: 2, a: 3 });
  const b = hashManifest({ a: 3, z: 1, ä: 2 });
  const c = hashManifest({ ä: 2, a: 3, z: 1 });
  assert.equal(a, b);
  assert.equal(b, c);
});

test('a trusted, well-formed entry is admitted', async () => {
  const manifest = validateAdapterManifest(validManifest());
  const hash = hashManifest(manifest);
  const results = await admitAdapters({
    cfg: { hostAdapters: [{ name: 'hermes', source: 'mem://hermes' }] },
    readManifest: async () => validManifest(),
    consent: trustingConsent({ hermes: hash }),
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].admitted, true);
  assert.equal(results[0].entry.id, 'hermes');
});

test('missing consent is refused with reason consent-required', async () => {
  const results = await admitAdapters({
    cfg: { hostAdapters: [{ name: 'hermes', source: 'mem://hermes' }] },
    readManifest: async () => validManifest(),
    consent: trustingConsent({}),
  });
  assert.equal(results[0].admitted, false);
  assert.equal(results[0].reason, 'consent-required');
});

test('a stale (mismatched) consent hash is refused with reason consent-stale', async () => {
  const results = await admitAdapters({
    cfg: { hostAdapters: [{ name: 'hermes', source: 'mem://hermes' }] },
    readManifest: async () => validManifest(),
    consent: trustingConsent({ hermes: 'not-the-real-hash' }),
  });
  assert.equal(results[0].admitted, false);
  assert.equal(results[0].reason, 'consent-stale');
});

test('an unsupported contract version is refused before consent is even consulted', async () => {
  const results = await admitAdapters({
    cfg: { hostAdapters: [{ name: 'hermes', source: 'mem://hermes' }] },
    readManifest: async () => validManifest({ contract: 2 }),
    consent: { recordedHashFor: neverCalled('consent.recordedHashFor'), isTrusted: neverCalled('consent.isTrusted') },
  });
  assert.equal(results[0].admitted, false);
  assert.equal(results[0].reason, 'contract-version');
});

test('an entry claiming a built-in host id is refused, shadowing a built-in', async () => {
  const builtinId = HOST_REGISTRY[0].id;
  const results = await admitAdapters({
    cfg: { hostAdapters: [{ name: builtinId, source: 'mem://shadow' }] },
    readManifest: async () => validManifest({ name: builtinId, host: validHost({ id: builtinId }) }),
    consent: { recordedHashFor: neverCalled('consent.recordedHashFor'), isTrusted: neverCalled('consent.isTrusted') },
  });
  assert.equal(results[0].admitted, false);
  assert.equal(results[0].reason, 'builtin-shadow');
});

test('a manifest cap violation (e.g. canBePrimary) is refused with the schema-layer reason', async () => {
  const results = await admitAdapters({
    cfg: { hostAdapters: [{ name: 'hermes', source: 'mem://hermes' }] },
    readManifest: async () => validManifest({
      host: validHost({ capabilities: { ...validHost().capabilities, canBePrimary: true } }),
    }),
    consent: trustingConsent({}),
  });
  assert.equal(results[0].admitted, false);
  assert.equal(results[0].reason, 'cap-can-be-primary');
});

test('an unreadable manifest source is refused, isolated from a good sibling entry', async () => {
  const goodManifest = validateAdapterManifest(validManifest());
  const goodHash = hashManifest(goodManifest);
  const results = await admitAdapters({
    cfg: {
      hostAdapters: [
        { name: 'broken', source: 'mem://broken' },
        { name: 'hermes', source: 'mem://hermes' },
      ],
    },
    readManifest: async (source) => {
      if (source === 'mem://broken') throw new Error('ENOENT: no such file');
      return validManifest();
    },
    consent: trustingConsent({ hermes: goodHash }),
  });
  assert.equal(results.length, 2);
  const broken = results.find((r) => r.name === 'broken');
  const good = results.find((r) => r.name === 'hermes');
  assert.equal(broken.admitted, false);
  assert.equal(broken.reason, 'manifest-unreadable');
  assert.equal(good.admitted, true);
});

test('flag-off bootstrapHostAdapters is a true no-op: no readManifest/consent call, no output, no overlay change', async () => {
  const before = effectiveHostRegistry();
  const result = await bootstrapHostAdapters({
    cfg: { hostAdapters: [{ name: 'hermes', source: 'mem://hermes' }] },
    env: {}, // AK_EXPERIMENTAL_HOST_ADAPTERS unset
    readManifest: neverCalled('readManifest'),
    consent: { recordedHashFor: neverCalled('consent.recordedHashFor'), isTrusted: neverCalled('consent.isTrusted') },
  });
  assert.deepEqual(result, { active: false, admitted: [], warnings: [] });
  assert.equal(effectiveHostRegistry(), before, 'overlay must be untouched');
  assert.equal(effectiveHostRegistry(), HOST_REGISTRY);
});

test('flag-on but no configured adapters is also a no-op', async () => {
  const result = await bootstrapHostAdapters({
    cfg: { hostAdapters: [] },
    env: { AK_EXPERIMENTAL_HOST_ADAPTERS: '1' },
    readManifest: neverCalled('readManifest'),
    consent: { recordedHashFor: neverCalled('consent.recordedHashFor'), isTrusted: neverCalled('consent.isTrusted') },
  });
  assert.deepEqual(result, { active: false, admitted: [], warnings: [] });
});

test('flag-on with a trusted entry admits it and applies the overlay', async () => {
  const manifest = validateAdapterManifest(validManifest());
  const hash = hashManifest(manifest);
  const result = await bootstrapHostAdapters({
    cfg: { hostAdapters: [{ name: 'hermes', source: 'mem://hermes' }] },
    env: { AK_EXPERIMENTAL_HOST_ADAPTERS: '1' },
    readManifest: async () => validManifest(),
    consent: trustingConsent({ hermes: hash }),
  });
  assert.equal(result.active, true);
  assert.equal(result.admitted.length, 1);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(admittedHostIds(), ['hermes']);
  assert.equal(effectiveHostRegistry().length, HOST_REGISTRY.length + 1);
});

// ── overlay ──────────────────────────────────────────────────────────────

test('effectiveHostRegistry returns the built-in registry (same reference) when nothing is admitted', () => {
  assert.equal(effectiveHostRegistry(), HOST_REGISTRY);
});

test('effectiveHostRegistry returns builtins + external once applyAdmitted runs', () => {
  applyAdmitted([{ entry: validHost({ id: 'hermes' }) }]);
  const combined = effectiveHostRegistry();
  assert.equal(combined.length, HOST_REGISTRY.length + 1);
  assert.deepEqual(admittedHostIds(), ['hermes']);
  assert.ok(HOST_REGISTRY.every((host) => combined.includes(host)));
});

// ── P2 finding 4: applyAdmitted rejects non-conforming entries + deep-freezes ─
// applyAdmitted must only ever accept genuine admission output — a raw,
// hand-built object bypassing validateHostAdapter entirely (e.g. one that
// claims canBePrimary:true) must be rejected, not silently join
// effectiveHostRegistry(); and every entry it does accept must be deeply
// frozen so a caller holding a reference can't mutate a "trusted" host's
// capabilities after the fact.

test('applyAdmitted rejects a raw entry that bypasses validateHostAdapter (incomplete shape)', () => {
  assert.throws(
    () => applyAdmitted([{ id: 'raw-evil', capabilities: { canBePrimary: true } }]),
    /label/,
  );
  assert.deepEqual(admittedHostIds(), [], 'the overlay must not have been mutated by a rejected call');
});

test('applyAdmitted deep-freezes every stored entry (and its nested capabilities/install/trust)', () => {
  applyAdmitted([{ entry: validHost({ id: 'hermes' }) }]);
  const entry = effectiveHostRegistry().find((host) => host.id === 'hermes');
  assert.ok(Object.isFrozen(entry), 'the entry itself must be frozen');
  assert.ok(Object.isFrozen(entry.capabilities), 'nested capabilities must be frozen too');
  assert.ok(Object.isFrozen(entry.install), 'nested install must be frozen too');
  assert.throws(() => { 'use strict'; entry.capabilities.canBePrimary = true; }, TypeError);
  assert.equal(entry.capabilities.canBePrimary, false, 'the mutation attempt must not have taken effect');
});

// ── derived lifecycle ────────────────────────────────────────────────────

test('buildAdmittedLifecycleAdapter satisfies validateLifecycleAdapter and routes a declared verb through the injected hook', async () => {
  const manifest = validateAdapterManifest(validManifest({
    lifecycle: { detect: { hook: { command: ['hermes', 'detect'], timeoutMs: 5000 } } },
  }));
  const calls = [];
  const runHook = async (args) => {
    calls.push(args);
    // F4: parseHookPayload reads stdoutText (the UNMERGED stdout hook-runner
    // reports), not stdout (stdout+stderr merged) — a real runAdapterHook
    // call always populates both; this mock does too, to match that contract.
    const stdout = JSON.stringify({ observed: { version: '1.0.0' } });
    return { ok: true, stdout, stdoutText: stdout, exitCode: 0 };
  };
  const adapter = buildAdmittedLifecycleAdapter(manifest, { runHook });
  assert.doesNotThrow(() => validateLifecycleAdapter(adapter));

  const detected = await adapter.detect({ env: { X: '1' } });
  assert.deepEqual(detected, { observed: { version: '1.0.0' } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].hostId, 'hermes');
  assert.equal(calls[0].verb, 'detect');
  assert.equal(calls[0].timeoutMs, 5000);
  assert.deepEqual(calls[0].hook.command, ['hermes', 'detect']);
});

test('buildAdmittedLifecycleAdapter gives an honest no-op for an undeclared verb (never calls the hook)', async () => {
  const manifest = validateAdapterManifest(validManifest({
    lifecycle: { detect: { hook: { command: ['hermes', 'detect'] } } },
  }));
  const adapter = buildAdmittedLifecycleAdapter(manifest, { runHook: neverCalled('runHook') });
  const result = await adapter.apply({});
  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
});

test('buildAdmittedLifecycleAdapter reports a hook failure honestly instead of fabricating success', async () => {
  const manifest = validateAdapterManifest(validManifest({
    lifecycle: { verify: { hook: { command: ['hermes', 'verify'] } } },
  }));
  // No `.detail` (a real failed runAdapterHook call always sets one — see
  // hook-runner.mjs — so this specifically exercises hookFailureResult's
  // OWN fallback: F4's fix reads stdoutText for that fallback, not stdout).
  const runHook = async () => ({ ok: false, stdout: 'boom', stdoutText: 'boom', exitCode: 1 });
  const adapter = buildAdmittedLifecycleAdapter(manifest, { runHook });
  const result = await adapter.verify({});
  assert.equal(result.observed, null);
  assert.equal(result.error, 'boom');
});

test('F4: hookFailureResult\'s detail fallback reads stdoutText (unmerged), never the merged stdout+stderr blob', async () => {
  const manifest = validateAdapterManifest(validManifest({
    lifecycle: { verify: { hook: { command: ['hermes', 'verify'] } } },
  }));
  // stdout is the MERGED blob (what a real hook-runner would produce when
  // stderr chatter follows); stdoutText is the real, unmerged signal.
  const runHook = async () => ({
    ok: false, stdout: 'clean-stdout\n--- stderr ---\nnoisy stderr chatter', stdoutText: 'clean-stdout', exitCode: 1,
  });
  const adapter = buildAdmittedLifecycleAdapter(manifest, { runHook });
  const result = await adapter.verify({});
  assert.equal(result.error, 'clean-stdout', 'the fallback must read stdoutText, not the merged stdout blob');
});

test('F4: a successful hook exit with valid JSON on stdout and unrelated stderr chatter still reports ok:true (Wave B R-1 twin)', async () => {
  const manifest = validateAdapterManifest(validManifest({
    lifecycle: { apply: { hook: { command: ['hermes', 'apply'] } } },
  }));
  const payload = JSON.stringify({ ok: true, changed: true, actions: ['wired'], ownership: [], warnings: [], errors: [] });
  // A stray stderr warning would break JSON.parse(stdout) (the merged blob)
  // pre-fix — the hook still exited 0 with a fully valid JSON payload on its
  // OWN stdout, so this must report success.
  const runHook = async () => ({
    ok: true, stdout: `${payload}\n--- stderr ---\nsome deprecation warning`, stdoutText: payload, exitCode: 0,
  });
  const adapter = buildAdmittedLifecycleAdapter(manifest, { runHook });
  const result = await adapter.apply({});
  assert.equal(result.ok, true, 'stderr chatter alongside valid stdout JSON must not fail the apply');
  assert.equal(result.changed, true);
});

test('registerAdmittedLifecycle checks effectiveHostRegistry, not HOST_REGISTRY, and is retrievable via lifecycleAdapterFor', () => {
  applyAdmitted([{ entry: validHost({ id: 'hermes' }) }]);
  const manifest = validateAdapterManifest(validManifest());
  const runHook = async () => ({ ok: true, stdout: '{}', exitCode: 0 });
  const registered = registerAdmittedLifecycle(manifest, { runHook });
  assert.equal(lifecycleAdapterFor('hermes'), registered);
});

test('registerAdmittedLifecycle throws for a host id absent from effectiveHostRegistry', () => {
  const manifest = validateAdapterManifest(validManifest({ name: 'ghost', host: validHost({ id: 'ghost' }) }));
  assert.throws(() => registerAdmittedLifecycle(manifest), /ghost/);
});

// ── P3 (ADR-0031): bootstrapHostAdapters registers an admitted lifecycle ────
// The sibling block to execution registration (§222-261 above): an admitted
// manifest declaring a lifecycle block gets its derived adapter registered
// during bootstrap, guarded and non-fatal, the same posture as execution.
// Every test here uses its own host id — LIFECYCLE_ADAPTERS is a
// process-shared Map with no unregister, so reusing 'hermes' would collide
// with the registerAdmittedLifecycle tests above.

test('bootstrapHostAdapters registers the lifecycle adapter for an admitted manifest that declares one', async () => {
  const name = 'hermes-boot-lifecycle';
  const manifest = validateAdapterManifest(validManifest({
    name, host: validHost({ id: name }),
    lifecycle: { apply: { hook: { command: [name, 'apply'] } } },
  }));
  const hash = hashManifest(manifest);
  const result = await bootstrapHostAdapters({
    cfg: { hostAdapters: [{ name, source: 'mem://hermes-boot-lifecycle' }] },
    env: { AK_EXPERIMENTAL_HOST_ADAPTERS: '1' },
    readManifest: async () => manifest,
    consent: trustingConsent({ [name]: hash }),
  });
  assert.equal(result.admitted.length, 1);
  assert.deepEqual(result.warnings, [], `expected no warnings; got ${JSON.stringify(result.warnings)}`);
  assert.notEqual(lifecycleAdapterFor(name), null, 'the lifecycle adapter must be registered by bootstrap');
});

test('bootstrapHostAdapters never registers a lifecycle adapter for an admitted manifest with no lifecycle block', async () => {
  const name = 'hermes-boot-no-lifecycle';
  const manifest = validateAdapterManifest(validManifest({ name, host: validHost({ id: name }) }));
  const hash = hashManifest(manifest);
  const result = await bootstrapHostAdapters({
    cfg: { hostAdapters: [{ name, source: 'mem://hermes-boot-no-lifecycle' }] },
    env: { AK_EXPERIMENTAL_HOST_ADAPTERS: '1' },
    readManifest: async () => manifest,
    consent: trustingConsent({ [name]: hash }),
  });
  assert.equal(result.admitted.length, 1);
  assert.equal(lifecycleAdapterFor(name), null, 'no lifecycle block declared — nothing to register');
});

// ── F-1 (ADR-0031 P3, critical fix): bootstrap-level baseDir derivation ────
// Mirrors adapter-execution.test.mjs's own F-1 (bootstrap) tests exactly:
// a file-sourced manifest's relative lifecycle hook resolves against the
// manifest's own directory (never the operator's cwd — this is a REAL
// subprocess spawn, not an injected runHook); a remote (npm/https) source
// has no persistent local bundle to anchor to, so its relative hook is
// refused with a surfaced 'lifecycle-unanchored' warning instead.

test('F-1 (bootstrap): a file-sourced manifest derives baseDir from realpath(dirname(source)) and a real relative lifecycle hook runs anchored to it', async () => {
  const name = 'hermes-f1-file';
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-lifecycle-f1-basedir-'));
  try {
    // A REAL script, on disk, referenced by a RELATIVE path — proves the
    // hook actually resolves against the manifest's own directory rather
    // than wherever this test process happens to be running from.
    fs.writeFileSync(path.join(tmpDir, 'apply-hook.mjs'),
      "process.stdout.write(JSON.stringify({ok:true,changed:true,actions:['wired'],ownership:[],warnings:[],errors:[]}));\n");
    // process.execPath (absolute), not the bare token 'node' — runAdapterHook
    // spawns with shell:false, and a bare 'node' does not resolve on Windows
    // (no PATHEXT/shell resolution there), so the subprocess would never
    // start. process.execPath is the running node's own absolute path,
    // always spawnable on every OS; the RELATIVE 'apply-hook.mjs' argument
    // is what this test is actually anchoring, unaffected by the change.
    const manifest = validateAdapterManifest(validManifest({
      name, host: validHost({ id: name }),
      lifecycle: { apply: { hook: { command: [process.execPath, 'apply-hook.mjs'] } } },
    }));
    const manifestPath = path.join(tmpDir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const hash = hashManifest(manifest);
    const result = await bootstrapHostAdapters({
      cfg: { hostAdapters: [{ name, source: manifestPath }] },
      env: { AK_EXPERIMENTAL_HOST_ADAPTERS: '1' },
      readManifest: async () => manifest,
      consent: trustingConsent({ [name]: hash }),
    });
    assert.equal(result.admitted.length, 1);
    assert.deepEqual(result.warnings, [], `expected no warnings; got ${JSON.stringify(result.warnings)}`);
    const adapter = lifecycleAdapterFor(name);
    assert.notEqual(adapter, null);
    assert.deepEqual(adapter.unanchoredVerbs, []);
    const applied = await adapter.apply({});
    assert.equal(applied.ok, true, 'the real relative script must have actually run, anchored to the manifest\'s own directory');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('F-1 (bootstrap): an npm-sourced admitted manifest with a relative lifecycle hook surfaces a lifecycle-unanchored warning, and the verb is refused (never spawned)', async () => {
  const name = 'hermes-f1-npm';
  // process.execPath, not the bare token 'node' — this verb is refused
  // before ever spawning either way (npm source -> null baseDir -> unanchored),
  // but kept consistent with the file-sourced test above rather than leaving
  // a bare token that would misbehave the moment this test's shape changes.
  const manifest = validateAdapterManifest(validManifest({
    name, host: validHost({ id: name }),
    lifecycle: { apply: { hook: { command: [process.execPath, 'apply-hook.mjs'] } } },
  }));
  const hash = hashManifest(manifest);
  const result = await bootstrapHostAdapters({
    cfg: { hostAdapters: [{ name, source: 'npm:hermes-f1-npm-adapter@1.0.0' }] },
    env: { AK_EXPERIMENTAL_HOST_ADAPTERS: '1' },
    readManifest: async () => manifest,
    consent: trustingConsent({ [name]: hash }),
  });
  assert.equal(result.admitted.length, 1, 'the host itself still admits — only the unanchored verb is refused');
  const warning = result.warnings.find((w) => w.reason === 'lifecycle-unanchored');
  assert.ok(warning, `expected a 'lifecycle-unanchored' warning; got ${JSON.stringify(result.warnings)}`);
  const adapter = lifecycleAdapterFor(name);
  assert.notEqual(adapter, null, 'the adapter still registers — an unanchorable verb refuses itself, not the whole adapter');
  assert.deepEqual(adapter.unanchoredVerbs, ['apply']);
  const applied = await adapter.apply({});
  assert.equal(applied.ok, false, 'the hook must NEVER have been spawned for an unanchored verb');
  assert.match(applied.errors[0], /no anchored adapter base directory/);
});
