// The lifecycle registry — host lifecycle adapters (detect/plan/apply/verify/
// undo) reached by id lookup, never by a named import of a concrete host
// module. Only opencode has a lifecycle adapter today; this file pins that
// the registry wires it correctly at import time AND that the five call
// sites that used to `import { OPENCODE_LIFECYCLE_ADAPTER } from
// '../lib/opencode.mjs'` no longer do — the whole point of F-02 is that a
// second lifecycle host never needs a new named import anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  registerBuiltinLifecycle, registerAdmittedLifecycle, lifecycleAdapterFor,
  hostsWithLifecycle, builtinHostsWithLifecycle, isBuiltinHost,
  lifecycleExecutionEnabled, detectionBinFor, buildAdmittedLifecycleAdapter,
  resetAdmittedLifecycle,
} from '../../src/lib/adapters/lifecycle-registry.mjs';
import { OPENCODE_LIFECYCLE_ADAPTER } from '../../src/lib/opencode.mjs';
import { validateLifecycleAdapter } from '../../src/lib/adapters/lifecycle.mjs';
import { HOST_REGISTRY } from '../../src/lib/adapters/index.mjs';
import { validateAdapterManifest } from '../../src/lib/adapters/manifest.mjs';
import { applyAdmitted, resetAdmitted } from '../../src/lib/adapters/admitted.mjs';
import { fakeLifecycleAdapter, fakeSurface } from './helpers/lifecycle-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const src = (rel) => fs.readFileSync(path.join(ROOT, 'src', rel), 'utf8');

test('lifecycleAdapterFor(\'opencode\') returns the real, validated adapter', () => {
  const adapter = lifecycleAdapterFor('opencode');
  assert.equal(adapter, OPENCODE_LIFECYCLE_ADAPTER, 'registry must hand back the SAME adapter instance opencode.mjs exports');
  assert.doesNotThrow(() => validateLifecycleAdapter(adapter));
});

test('lifecycleAdapterFor of an unknown/unregistered host id returns null', () => {
  assert.equal(lifecycleAdapterFor('codex'), null, 'codex has no lifecycle adapter yet');
  assert.equal(lifecycleAdapterFor('not-a-real-host'), null);
});

test('hostsWithLifecycle() returns only registered ids, in HOST_REGISTRY order', () => {
  const ids = hostsWithLifecycle();
  assert.deepEqual(ids, ['opencode'], 'only opencode is registered in this wave');
  // order sanity: whatever is registered must appear in the same relative
  // order it holds in HOST_REGISTRY, not Map-insertion order.
  const registryOrder = HOST_REGISTRY.map((h) => h.id);
  let cursor = -1;
  for (const id of ids) {
    const idx = registryOrder.indexOf(id);
    assert.ok(idx > cursor, `${id} out of HOST_REGISTRY order`);
    cursor = idx;
  }
});

test('hostsWithLifecycle() equals builtinHostsWithLifecycle() when nothing is admitted (ADR-0031 P3 freeze criterion 4)', () => {
  assert.deepEqual(hostsWithLifecycle(), builtinHostsWithLifecycle(),
    'flag-off / nothing-admitted must be byte-identical to the pre-P3 built-ins-only behavior');
});

test('registering an unknown host id throws at registration (construction-time invariant)', () => {
  const surface = fakeSurface({ enabled: false });
  const adapter = fakeLifecycleAdapter(surface);
  assert.throws(
    () => registerBuiltinLifecycle('not-in-the-registry', adapter, { hostRegistry: [{ id: 'claude' }, { id: 'opencode' }] }),
    /not-in-the-registry/,
  );
});

test('registering an adapter that fails the lifecycle contract throws (construction-time invariant)', () => {
  assert.throws(
    () => registerBuiltinLifecycle('claude', { id: 'claude', detect() {} }, { hostRegistry: [{ id: 'claude' }] }),
    /must be a function/,
  );
});

test('registering a known host id with a valid adapter succeeds and is retrievable', () => {
  const surface = fakeSurface({ enabled: false });
  const adapter = fakeLifecycleAdapter(surface);
  const registered = registerBuiltinLifecycle('claude', adapter, { hostRegistry: [{ id: 'claude' }] });
  assert.equal(registered, adapter);
});

// ── architecture guard: dispatch by registry, never by name ────────────────
// Real import errors (a wiring bug in a built-in) are supposed to throw at
// module load — proven above via the hostRegistry-override seam rather than a
// fresh-module import, since the real HOST_REGISTRY/opencode wiring is
// correct and importing it a second time would just re-hit Node's ESM module
// cache (no fresh throw to observe).
for (const rel of [
  'commands/sync.mjs', 'commands/setup.mjs', 'commands/x/host.mjs', 'commands/uninstall.mjs',
]) {
  test(`${rel} no longer names OPENCODE_LIFECYCLE_ADAPTER — it goes through the registry`, () => {
    const text = src(rel);
    assert.ok(!text.includes('OPENCODE_LIFECYCLE_ADAPTER'),
      `${rel} must reach opencode's lifecycle adapter via lifecycleAdapterFor(...), not a named import`);
  });
}

// ── P3: the loop bodies are now shape-agnostic (ADR-0031 P3) ───────────────
// setup.mjs/sync.mjs/uninstall.mjs's lifecycle loops used to destructure an
// opencode-shaped result (stack.oc / ret.undo / ret.artifacts) directly,
// which is why they stuck to builtinHostsWithLifecycle() (built-ins only).
// This wave routes every loop through lifecycle-render.mjs's shape-dispatching
// renderer instead, so they now iterate hostsWithLifecycle() (built-ins +
// admitted) safely, gated per-host by lifecycleExecutionEnabled — an admitted
// host is never exercised without BOTH cfg enablement and the experimental
// flag, so this never auto-enables anything.
for (const rel of ['commands/sync.mjs', 'commands/setup.mjs', 'commands/uninstall.mjs']) {
  test(`${rel} loops hostsWithLifecycle() gated by lifecycleExecutionEnabled (ADR-0031 P3)`, () => {
    const text = src(rel);
    assert.ok(text.includes('hostsWithLifecycle()'),
      `${rel}'s lifecycle loop must iterate hostsWithLifecycle() now that the loop body is shape-agnostic`);
    assert.ok(text.includes('lifecycleExecutionEnabled'),
      `${rel} must gate lifecycle execution through lifecycleExecutionEnabled (flag + explicit enablement for an admitted host)`);
  });
}

// ── builtinHostsWithLifecycle() stays a pure, built-ins-only registry query ─
// No longer the setup/sync/uninstall-facing function (P3 above), but its own
// invariant is unaffected: it must never include an admitted external, even
// once that host's lifecycle adapter is registered — e.g. an install-hint
// lookup that only makes sense against HOSTS' own built-in package metadata
// must never be handed an admitted host id.
test('builtinHostsWithLifecycle() excludes an admitted external host even after its lifecycle is registered', () => {
  const hostId = 'hermes-lifecycle-probe';
  const host = {
    id: hostId,
    label: 'Hermes',
    install: { bin: hostId, externalInstallPolicy: 'detect-never-overwrite' },
    capabilities: {
      canDriveSession: true, canBePrimary: false, canRouteActivities: true,
      commandStatusline: false, transcripts: true, usage: false,
      nativeMcpConfig: false, nativeGuidance: false,
    },
    trust: { approvalPolicy: 'unchanged', changes: [] },
    enabledByDefault: false,
    configProjection: 'ruflo',
    observability: [],
  };
  const manifest = validateAdapterManifest({
    name: hostId,
    version: '1.0.0',
    contract: 1,
    host,
    detection: { bin: hostId },
    driving: { surfaces: ['acp'] },
    lifecycle: { detect: { hook: { command: [hostId, 'detect'] } } },
    trust: {
      changes: [{
        id: 'hermes-subprocess-hooks', kind: 'third-party-adapter', scope: 'project',
        owner: 'hermes', value: 'subprocess hooks', effect: 'run consented lifecycle hooks for hermes',
      }],
    },
  });

  // Baseline BEFORE admitting anything — not a literal ['opencode'], because
  // an earlier test in this same file (registerBuiltinLifecycle('claude', ...))
  // mutates the real, process-shared LIFECYCLE_ADAPTERS map too. The
  // invariant under test is "unaffected by registering an external", so
  // compare against a live before/after snapshot instead of a hardcoded list.
  const before = builtinHostsWithLifecycle();

  applyAdmitted([{ entry: host }]);
  try {
    registerAdmittedLifecycle(manifest, { runHook: async () => ({ ok: true, stdout: '{}', exitCode: 0 }) });

    assert.ok(hostsWithLifecycle().includes(hostId),
      'sanity: the pure registry query DOES see the admitted, lifecycle-registered host');
    assert.ok(
      !builtinHostsWithLifecycle().includes(hostId),
      'the setup/sync/uninstall-facing function must never include an admitted external, even once its lifecycle is registered',
    );
    assert.deepEqual(builtinHostsWithLifecycle(), before,
      'builtinHostsWithLifecycle() must be unaffected by registering an external lifecycle adapter');
  } finally {
    resetAdmitted();
  }
});

// ── ADR-0031 P3: execution-eligibility helpers ──────────────────────────────
// isBuiltinHost / lifecycleExecutionEnabled / detectionBinFor are what let
// setup.mjs/sync.mjs/uninstall.mjs iterate hostsWithLifecycle() safely: the
// gate that keeps an admitted host opt-in (cfg enablement AND the
// experimental flag), and the CLI-presence probe name for each shape.

function hermesHost(overrides = {}) {
  return {
    id: 'hermes-gate-probe',
    label: 'Hermes',
    install: { bin: 'hermes-gate-probe', externalInstallPolicy: 'detect-never-overwrite' },
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

function hermesManifest(overrides = {}) {
  return validateAdapterManifest({
    name: 'hermes-gate-probe',
    version: '1.0.0',
    contract: 1,
    host: hermesHost(),
    detection: { bin: 'hermes-bin' },
    driving: { surfaces: ['acp'] },
    lifecycle: { apply: { hook: { command: ['hermes-gate-probe', 'apply'] } } },
    trust: {
      changes: [{
        id: 'hermes-subprocess-hooks', kind: 'third-party-adapter', scope: 'project',
        owner: 'hermes', value: 'subprocess hooks', effect: 'run consented lifecycle hooks for hermes',
      }],
    },
    ...overrides,
  });
}

test('isBuiltinHost distinguishes HOST_REGISTRY ids from an admitted external', () => {
  assert.equal(isBuiltinHost('opencode'), true);
  assert.equal(isBuiltinHost('hermes-gate-probe'), false);
});

test('lifecycleExecutionEnabled: a built-in only needs cfg enablement (no flag required)', () => {
  assert.equal(lifecycleExecutionEnabled('opencode', { integrations: { hosts: { opencode: true } } }, {}), true);
  assert.equal(lifecycleExecutionEnabled('opencode', { integrations: { hosts: { opencode: false } } }, {}), false);
  assert.equal(lifecycleExecutionEnabled('opencode', {}, {}), false, 'no cfg enablement at all');
});

test('lifecycleExecutionEnabled: an admitted host needs BOTH cfg enablement AND the experimental flag', () => {
  const cfgEnabled = { integrations: { hosts: { 'hermes-gate-probe': true } } };
  assert.equal(lifecycleExecutionEnabled('hermes-gate-probe', cfgEnabled, {}), false, 'flag unset');
  assert.equal(
    lifecycleExecutionEnabled('hermes-gate-probe', cfgEnabled, { AK_EXPERIMENTAL_HOST_ADAPTERS: '1' }),
    true,
    'flag set AND cfg enabled',
  );
  assert.equal(
    lifecycleExecutionEnabled('hermes-gate-probe', {}, { AK_EXPERIMENTAL_HOST_ADAPTERS: '1' }),
    false,
    'flag alone never auto-enables — cfg enablement is still required',
  );
});

test('detectionBinFor: a built-in uses its own host id; an admitted host uses manifest.detection.bin', () => {
  applyAdmitted([{ entry: hermesHost() }]);
  try {
    const manifest = hermesManifest();
    registerAdmittedLifecycle(manifest, { runHook: async () => ({ ok: true, stdout: '{}', exitCode: 0 }) });
    assert.equal(detectionBinFor('opencode'), 'opencode');
    assert.equal(detectionBinFor('hermes-gate-probe'), 'hermes-bin',
      'must read the manifest\'s own detection.bin, not the host id');
  } finally {
    resetAdmitted();
  }
});

test('buildAdmittedLifecycleAdapter stashes detectionBin from manifest.detection.bin', () => {
  const adapter = buildAdmittedLifecycleAdapter(hermesManifest());
  assert.equal(adapter.detectionBin, 'hermes-bin');
});

// ── F-1 (ADR-0031 P3, critical fix): lifecycle hooks must anchor exactly
// like execution hooks (execution/admitted.mjs's F-1 is canonical). A
// relative lifecycle.<verb>.hook.command resolving against the OPERATOR's
// cwd (rather than the adapter's own directory) is arbitrary-code-execution
// by planting a same-named file, with the consent hash unchanged. Unlike
// execution (one hook, all-or-nothing refusal), lifecycle has five
// independently-optional verbs — an unanchorable one is refused PER-VERB
// (never wired to spawn), not a whole-adapter throw.

test('F-1: a relative lifecycle hook command with no baseDir is NEVER spawned — refused with reason lifecycle-unanchored', async () => {
  const manifest = hermesManifest({
    lifecycle: { apply: { hook: { command: ['hermes-gate-probe', 'apply-hook.mjs'] } } },
  });
  const adapter = buildAdmittedLifecycleAdapter(manifest, { runHook: async () => { throw new Error('runHook must never be called for an unanchored verb'); } });
  assert.deepEqual(adapter.unanchoredVerbs, ['apply'], 'the refused verb must be named for the bootstrap warning');
  const result = await adapter.apply({});
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /lifecycle\.apply\.hook\.command/);
  assert.match(result.errors[0], /no anchored adapter base directory/);
});

test('F-1: a relative lifecycle hook command IS legal once a baseDir anchors it, and the hook receives cwd=baseDir', async () => {
  const manifest = hermesManifest({
    lifecycle: { apply: { hook: { command: ['hermes-gate-probe', 'apply-hook.mjs'] } } },
  });
  const calls = [];
  // F4: a real runAdapterHook call always populates stdoutText (the UNMERGED
  // stdout) alongside stdout — parseHookPayload reads stdoutText.
  const payload = '{"ok":true,"changed":true,"actions":[],"ownership":[],"warnings":[],"errors":[]}';
  const runHook = async (options) => { calls.push(options); return { ok: true, stdout: payload, stdoutText: payload, exitCode: 0 }; };
  const adapter = buildAdmittedLifecycleAdapter(manifest, { runHook, baseDir: '/adapters/hermes' });
  assert.deepEqual(adapter.unanchoredVerbs, [], 'anchored — nothing refused');
  const result = await adapter.apply({});
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, '/adapters/hermes');
});

test('F-1: a bare PATH-resolved interpreter/binary lifecycle hook command stays legal with no baseDir (and runs with no cwd override)', async () => {
  const manifest = hermesManifest({
    lifecycle: { detect: { hook: { command: ['hermes-gate-probe', 'detect'] } } },
  });
  const calls = [];
  const runHook = async (options) => { calls.push(options); return { ok: true, stdout: '{"observed":{}}', stdoutText: '{"observed":{}}', exitCode: 0 }; };
  const adapter = buildAdmittedLifecycleAdapter(manifest, { runHook }); // baseDir defaults to null
  assert.deepEqual(adapter.unanchoredVerbs, [], 'a bare token (no "/", no script suffix) is not relative — nothing refused');
  await adapter.detect({});
  assert.equal(calls.length, 1);
  assert.equal('cwd' in calls[0], false, 'no cwd override is passed — Node\'s own default is safe for a bare PATH binary');
});

test('F-1: an absolute lifecycle hook command is always legal, baseDir or not', async () => {
  const manifest = hermesManifest({
    lifecycle: { detect: { hook: { command: ['/usr/bin/hermes-gate-probe', '/abs/detect-hook.mjs'] } } },
  });
  const adapter = buildAdmittedLifecycleAdapter(manifest, { runHook: async () => ({ ok: true, stdout: '{"observed":{}}', stdoutText: '{"observed":{}}', exitCode: 0 }) });
  assert.deepEqual(adapter.unanchoredVerbs, []);
});

test('registerAdmittedLifecycle threads baseDir through to buildAdmittedLifecycleAdapter', async () => {
  applyAdmitted([{ entry: hermesHost() }]);
  try {
    const manifest = hermesManifest({
      lifecycle: { apply: { hook: { command: ['hermes-gate-probe', 'apply-hook.mjs'] } } },
    });
    const calls = [];
    const payload = '{"ok":true,"changed":false,"actions":[],"ownership":[],"warnings":[],"errors":[]}';
    const runHook = async (options) => { calls.push(options); return { ok: true, stdout: payload, stdoutText: payload, exitCode: 0 }; };
    const registered = registerAdmittedLifecycle(manifest, { runHook, baseDir: '/adapters/hermes-gate-probe' });
    await registered.apply({});
    assert.equal(calls[0].cwd, '/adapters/hermes-gate-probe');
  } finally {
    resetAdmitted();
  }
});

// ── F7 (Wave C security review — prioritized for P4's paired-overlay reset):
// resetAdmittedLifecycle() must clear every ADMITTED registration while
// leaving 'opencode' (and any other built-in) untouched, mirroring
// execution/admitted.mjs's resetAllAdmitted() pairing pattern.

test('F7: resetAdmittedLifecycle() clears an admitted registration but leaves the built-in opencode adapter untouched', () => {
  applyAdmitted([{ entry: hermesHost() }]);
  try {
    registerAdmittedLifecycle(hermesManifest(), { runHook: async () => ({ ok: true, stdout: '{}', stdoutText: '{}', exitCode: 0 }) });
    assert.notEqual(lifecycleAdapterFor('hermes-gate-probe'), null, 'sanity: the admitted host is registered');
    assert.equal(lifecycleAdapterFor('opencode'), OPENCODE_LIFECYCLE_ADAPTER, 'sanity: opencode is registered');

    resetAdmittedLifecycle();

    assert.equal(lifecycleAdapterFor('hermes-gate-probe'), null, 'the admitted registration must be cleared');
    assert.equal(lifecycleAdapterFor('opencode'), OPENCODE_LIFECYCLE_ADAPTER, 'the built-in registration must survive untouched');
  } finally {
    resetAdmitted();
  }
});

test('F7: resetAdmittedLifecycle() clears MULTIPLE admitted registrations, not just the most recent one', () => {
  const hostA = { ...hermesHost(), id: 'hermes-f7-a' };
  const hostB = { ...hermesHost(), id: 'hermes-f7-b' };
  applyAdmitted([{ entry: hostA }, { entry: hostB }]);
  try {
    const runHook = async () => ({ ok: true, stdout: '{}', stdoutText: '{}', exitCode: 0 });
    registerAdmittedLifecycle(hermesManifest({ name: 'hermes-f7-a', host: hostA }), { runHook });
    registerAdmittedLifecycle(hermesManifest({ name: 'hermes-f7-b', host: hostB }), { runHook });
    assert.notEqual(lifecycleAdapterFor('hermes-f7-a'), null);
    assert.notEqual(lifecycleAdapterFor('hermes-f7-b'), null);

    resetAdmittedLifecycle();

    assert.equal(lifecycleAdapterFor('hermes-f7-a'), null);
    assert.equal(lifecycleAdapterFor('hermes-f7-b'), null);
  } finally {
    resetAdmitted();
  }
});

test('F7: resetAdmittedLifecycle() is idempotent — a second call with nothing registered is a harmless no-op', () => {
  assert.doesNotThrow(() => resetAdmittedLifecycle());
  assert.doesNotThrow(() => resetAdmittedLifecycle());
  assert.equal(lifecycleAdapterFor('opencode'), OPENCODE_LIFECYCLE_ADAPTER);
});

// ── F9 (Wave C security review — Windows parity): SCRIPT_LIKE_RE must catch
// Windows executable extensions too, since CreateProcess searches the
// current directory before PATH for a bare relative name.

test('F9: a relative .bat lifecycle hook command with no baseDir is refused (Windows CreateProcess searches cwd)', async () => {
  const manifest = hermesManifest({
    lifecycle: { apply: { hook: { command: ['hermes-gate-probe', 'hook.bat'] } } },
  });
  const adapter = buildAdmittedLifecycleAdapter(manifest, { runHook: async () => { throw new Error('runHook must never be called for an unanchored verb'); } });
  assert.deepEqual(adapter.unanchoredVerbs, ['apply']);
});

test('F9: .exe/.cmd/.com/.ps1 are all treated as script-like (relative + no baseDir refused)', async () => {
  for (const ext of ['exe', 'cmd', 'com', 'ps1']) {
    const manifest = hermesManifest({
      lifecycle: { apply: { hook: { command: ['hermes-gate-probe', `hook.${ext}`] } } },
    });
    const adapter = buildAdmittedLifecycleAdapter(manifest, { runHook: async () => { throw new Error('must never spawn'); } });
    assert.deepEqual(adapter.unanchoredVerbs, ['apply'], `.${ext} must be treated as script-like`);
  }
});

test('F9: a relative .bat command IS legal once a baseDir anchors it', async () => {
  const manifest = hermesManifest({
    lifecycle: { apply: { hook: { command: ['hermes-gate-probe', 'hook.bat'] } } },
  });
  const calls = [];
  const payload = '{"ok":true,"changed":false,"actions":[],"ownership":[],"warnings":[],"errors":[]}';
  const runHook = async (options) => { calls.push(options); return { ok: true, stdout: payload, stdoutText: payload, exitCode: 0 }; };
  const adapter = buildAdmittedLifecycleAdapter(manifest, { runHook, baseDir: 'C:\\adapters\\hermes' });
  assert.deepEqual(adapter.unanchoredVerbs, []);
  await adapter.apply({});
  assert.equal(calls[0].cwd, 'C:\\adapters\\hermes');
});
