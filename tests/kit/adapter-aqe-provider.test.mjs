import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAdapterManifest } from '../../src/lib/adapters/manifest.mjs';
import { bootstrapHostAdapters } from '../../src/lib/adapters/admission.mjs';
import { resetAdmitted } from '../../src/lib/adapters/admitted.mjs';
import { grantCapability, recordTierResult } from '../../src/lib/adapters/grants.mjs';
import { hashAdapterContent } from '../../src/lib/adapters/integrity.mjs';
import {
  admittedAqeProviderFor,
  admittedAqeProviders,
  projectedAqeExternalProviders,
  registerAdmittedAqeProvider,
  resetAdmittedAqeProviders,
  runAdmittedAqeProvider,
  runAdmittedAqeProviderProbe,
} from '../../src/lib/adapters/aqe-provider.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

beforeEach(() => {
  resetAdmittedAqeProviders();
  resetAdmitted();
});

function validHost(id = 'hermes') {
  return {
    id,
    label: 'Hermes',
    install: { bin: 'hermes', externalInstallPolicy: 'detect-never-overwrite' },
    capabilities: {
      canDriveSession: false, canBePrimary: false, canRouteActivities: true,
      commandStatusline: false, transcripts: false, usage: false,
      nativeMcpConfig: false, nativeGuidance: false,
    },
    trust: { approvalPolicy: 'unchanged', changes: [] },
    enabledByDefault: false,
    configProjection: 'ruflo',
    observability: [],
  };
}

function rawManifest(id = 'hermes', aqe = {}) {
  return {
    name: id,
    version: '1.0.0',
    contract: 1,
    host: validHost(id),
    detection: { bin: 'hermes' },
    driving: { surfaces: ['cli-subprocess'] },
    execution: {
      run: {
        hook: {
          command: [process.execPath, 'execution-hook.mjs'],
          files: ['execution-hook.mjs'],
          timeoutMs: 5000,
        },
      },
    },
    aqe: {
      provider: {
        hook: {
          command: [process.execPath, 'aqe-hook.mjs'],
          files: ['aqe-hook.mjs'],
          timeoutMs: 5000,
          passEnv: ['BRIDGE_TOKEN'],
        },
        billingMode: 'subscription',
        models: ['default', 'fast'],
        defaultModel: 'default',
        maxConcurrency: 3,
        stripEnv: ['OPENAI_API_KEY'],
        displayName: 'Hermes subscription',
        ...aqe,
      },
    },
    trust: { changes: [] },
  };
}

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-aqe-provider-'));
  fs.writeFileSync(path.join(dir, 'execution-hook.mjs'), `
process.stdin.resume();
process.stdin.on('end', () => process.stdout.write('OK'));
`);
  fs.writeFileSync(path.join(dir, 'aqe-hook.mjs'), `
let prompt = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) prompt += chunk;
process.stdout.write(JSON.stringify({
  prompt,
  model: process.env.AK_AQE_MODEL,
  provider: process.env.AK_AQE_PROVIDER,
  project: process.env.AK_AQE_PROJECT_CWD,
  token: process.env.BRIDGE_TOKEN ?? null,
  leaked: process.env.UNLISTED_SECRET ?? null
}));
`);
  const manifest = validateAdapterManifest(rawManifest());
  const integrity = hashAdapterContent(manifest, { baseDir: dir });
  return { dir, manifest, integrity };
}

test('aqe.provider is strict, host-derived, normalized candidate data', () => {
  const manifest = validateAdapterManifest(rawManifest());
  assert.equal(Object.hasOwn(manifest.aqe.provider, 'type'), false);
  assert.deepEqual(manifest.aqe.provider.models, ['default', 'fast']);
  assert.equal(manifest.aqe.provider.defaultModel, 'default');
  assert.throws(
    () => validateAdapterManifest(rawManifest('openai')),
    (error) => error.reason === 'aqe-provider-collision',
  );
  assert.throws(
    () => validateAdapterManifest(rawManifest('hermes', { apiKey: 'secret' })),
    (error) => error.reason === 'unknown-field',
  );
  assert.throws(
    () => validateAdapterManifest(rawManifest('hermes', { stripEnv: ['BRIDGE_TOKEN'] })),
    (error) => error.reason === 'invalid-aqe-provider',
  );
  const injected = rawManifest();
  injected.aqe.provider.hook.passEnv = ['NODE_OPTIONS'];
  assert.throws(
    () => validateAdapterManifest(injected),
    (error) => error.reason === 'invalid-aqe-provider',
  );
  assert.throws(
    () => validateAdapterManifest(rawManifest('hermes', { stripEnv: ['PATH'] })),
    (error) => error.reason === 'invalid-aqe-provider',
  );
  assert.throws(
    () => validateAdapterManifest(rawManifest('hermes', { maxConcurrency: 65 })),
    (error) => error.reason === 'invalid-aqe-provider' && /<= 64/.test(error.message),
  );
  const tooSlow = rawManifest();
  tooSlow.aqe.provider.hook.timeoutMs = 86_400_001;
  assert.throws(
    () => validateAdapterManifest(tooSlow),
    (error) => error.reason === 'invalid-aqe-provider' && /<= 86400000/.test(error.message),
  );
  assert.throws(
    () => validateAdapterManifest(rawManifest('hermes', { models: Array.from({ length: 129 }, (_, i) => `model-${i}`) })),
    (error) => error.reason === 'invalid-aqe-provider' && /at most 128/.test(error.message),
  );
  assert.throws(
    () => validateAdapterManifest(rawManifest('hermes', { models: ['x'.repeat(257)] })),
    (error) => error.reason === 'invalid-aqe-provider' && /256 UTF-8 bytes/.test(error.message),
  );
  assert.throws(
    () => validateAdapterManifest(rawManifest('hermes', { displayName: 'unsafe\u001b[31mname' })),
    (error) => error.reason === 'invalid-aqe-provider' && /control-free/.test(error.message),
  );
  const noCli = rawManifest();
  noCli.driving.surfaces = ['mcp'];
  assert.throws(
    () => validateAdapterManifest(noCli),
    (error) => error.reason === 'aqe-provider-surface',
  );
  const noWorkerPath = rawManifest();
  delete noWorkerPath.execution;
  assert.throws(
    () => validateAdapterManifest(noWorkerPath),
    (error) => error.reason === 'aqe-provider-routing',
  );
});

test('AQE hook files participate in the admitted adapter content identity', () => {
  const { dir, manifest, integrity } = fixture();
  try {
    assert.deepEqual(integrity.hookFiles.map((file) => file.path), ['aqe-hook.mjs', 'execution-hook.mjs']);
    fs.appendFileSync(path.join(dir, 'aqe-hook.mjs'), '\n// changed\n');
    const changed = hashAdapterContent(manifest, { baseDir: dir });
    assert.notEqual(changed.hash, integrity.hash);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('live provider receipts are immutable and projection exposes no manifest internals', () => {
  const { dir, manifest, integrity } = fixture();
  try {
    registerAdmittedAqeProvider(manifest, { baseDir: dir, integrity, contentHash: integrity.hash });
    const receipt = admittedAqeProviderFor('hermes');
    assert.equal(receipt.id, 'hermes');
    assert.equal(receipt.hostId, 'hermes');
    assert.equal(receipt.contentHash, integrity.hash);
    assert.equal(Object.hasOwn(receipt, 'manifest'), false);
    assert.equal(Object.hasOwn(receipt, 'baseDir'), false);
    assert.ok(Object.isFrozen(receipt));
    assert.equal(admittedAqeProviders().length, 1);

    const projected = projectedAqeExternalProviders();
    assert.equal(projected.hermes.command[0], process.execPath);
    assert.match(projected.hermes.command[1], /bin[/\\]agentic-kit\.mjs$/);
    assert.deepEqual(projected.hermes.command.slice(2, 5), ['x', 'aqe-provider', 'hermes']);
    assert.deepEqual(projected.hermes.command.slice(5), [
      '--expect-hash', integrity.hash, '--project-root', process.cwd(),
    ]);
    assert.equal(projected.hermes.kind, 'cli');
    assert.equal(projected.hermes.modelFlag, '--model');
    assert.equal(projected.hermes.timeoutMs, 7500);
    assert.deepEqual(projected.hermes.stripEnv, ['OPENAI_API_KEY']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bootstrap activates only an admitted, enabled, hash-current aqeProvider grant', async (t) => {
  const priorXdg = process.env.XDG_CONFIG_HOME;
  const grantHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-aqe-provider-grant-'));
  process.env.XDG_CONFIG_HOME = grantHome;
  const { dir, manifest, integrity } = fixture();
  const manifestFile = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  t.after(() => {
    process.env.XDG_CONFIG_HOME = priorXdg;
    fs.rmSync(grantHome, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
    resetAdmittedAqeProviders();
    resetAdmitted();
  });

  recordTierResult('hermes', 'aqe-provider', {
    hash: integrity.hash, evidence: 'real AQE stdin/stdout provider probe returned OK',
  });
  grantCapability('hermes', 'aqeProvider', { hash: integrity.hash });
  const consent = {
    recordedHashFor: () => integrity.hash,
    isTrusted: (_name, hash) => hash === integrity.hash,
  };
  const cfg = {
    hostAdapters: [{ name: 'hermes', source: manifestFile }],
    integrations: { hosts: { hermes: true } },
  };
  const active = await bootstrapHostAdapters({
    cfg, env: { AK_EXPERIMENTAL_HOST_ADAPTERS: '1' },
    readManifest: async () => manifest, consent,
  });
  assert.equal(active.admitted.length, 1);
  assert.equal(active.warnings.length, 0);
  assert.equal(admittedAqeProviderFor('hermes')?.contentHash, integrity.hash);

  await bootstrapHostAdapters({
    cfg: { hostAdapters: [] },
    env: { AK_EXPERIMENTAL_HOST_ADAPTERS: '1' },
    readManifest: async () => manifest, consent,
  });
  assert.equal(admittedAqeProviderFor('hermes'), null,
    'removing the final configured adapter clears the prior in-process provider snapshot');

  await bootstrapHostAdapters({
    cfg,
    env: { AK_EXPERIMENTAL_HOST_ADAPTERS: '1' },
    readManifest: async () => manifest, consent,
  });
  assert.equal(admittedAqeProviderFor('hermes')?.contentHash, integrity.hash);

  await bootstrapHostAdapters({
    cfg: { ...cfg, integrations: { hosts: { hermes: false } } },
    env: { AK_EXPERIMENTAL_HOST_ADAPTERS: '1' },
    readManifest: async () => manifest, consent,
  });
  assert.equal(admittedAqeProviderFor('hermes'), null, 'a disabled host clears the live provider snapshot');
});

test('production bridge uses supervised stdin/model/env/cwd path and strips unrelated secrets', async () => {
  const { dir, manifest, integrity } = fixture();
  try {
    registerAdmittedAqeProvider(manifest, { baseDir: dir, integrity });
    const result = await runAdmittedAqeProvider('hermes', {
      stdin: 'hello from AQE',
      model: 'fast',
      projectRoot: dir,
      env: { BRIDGE_TOKEN: 'allowed', UNLISTED_SECRET: 'must-not-leak' },
    });
    assert.equal(result.ok, true, result.detail);
    const payload = JSON.parse(result.stdoutText);
    assert.deepEqual(payload, {
      prompt: 'hello from AQE', model: 'fast', provider: 'hermes', project: dir,
      token: 'allowed', leaked: null,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unsupported models and post-admission hook edits fail before execution with no stdout', async () => {
  const { dir, manifest, integrity } = fixture();
  try {
    registerAdmittedAqeProvider(manifest, { baseDir: dir, integrity });
    const badModel = await runAdmittedAqeProvider('hermes', {
      stdin: 'prompt', model: 'undeclared', projectRoot: dir,
    });
    assert.equal(badModel.ok, false);
    assert.equal(badModel.stdoutText, '');
    assert.match(badModel.detail, /does not declare model/);

    const staleProjection = await runAdmittedAqeProvider('hermes', {
      stdin: 'prompt', model: 'default', projectRoot: dir, expectedHash: 'f'.repeat(64),
    });
    assert.equal(staleProjection.ok, false);
    assert.equal(staleProjection.stdoutText, '');
    assert.match(staleProjection.detail, /does not match projected/);

    fs.appendFileSync(path.join(dir, 'aqe-hook.mjs'), '\nthrow new Error("must not run");\n');
    const stale = await runAdmittedAqeProvider('hermes', {
      stdin: 'prompt', model: 'default', projectRoot: dir,
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.stdoutText, '');
    assert.match(stale.detail, /hook-content-changed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('evidence-first probe uses the production runner with a fixed bounded prompt', async () => {
  const { dir, manifest, integrity } = fixture();
  try {
    const result = await runAdmittedAqeProviderProbe({
      manifest, baseDir: dir, integrity, projectRoot: dir, timeoutMs: 5000,
    });
    assert.equal(result.ok, true, result.detail);
    const payload = JSON.parse(result.stdoutText);
    assert.equal(payload.prompt, 'Reply with exactly: OK');
    assert.equal(payload.model, 'default');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hidden CLI transport never emits failure or drift diagnostics on stdout', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-aqe-provider-home-'));
  try {
    const result = spawnSync(process.execPath, [
      path.join(ROOT, 'bin', 'agentic-kit.mjs'), 'x', 'aqe-provider', 'missing-provider', '--model', 'default',
      '--expect-hash', 'a'.repeat(64), '--project-root', ROOT,
    ], {
      cwd: ROOT,
      env: { ...process.env, HOME: home, AK_EXPERIMENTAL_HOST_ADAPTERS: '1' },
      input: 'prompt',
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /not active/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
