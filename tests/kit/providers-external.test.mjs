import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateAdapterManifest } from '../../src/lib/adapters/manifest.mjs';
import { hashAdapterContent } from '../../src/lib/adapters/integrity.mjs';
import { registerAdmittedAqeProvider, resetAdmittedAqeProviders } from '../../src/lib/adapters/aqe-provider.mjs';
import { _setGlobalRootForTest } from '../../src/lib/paths.mjs';
import {
  applyAqeRouter, aqeExternalProviderState, aqeRouterFile, aqeSelectableProviderTypes, managedEnv,
} from '../../src/lib/providers.mjs';
import { configuredPolicyToAgentOverrides } from '../../src/lib/routing.mjs';

const dirs = [];
afterEach(() => {
  resetAdmittedAqeProviders();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function fakeAqe(version) {
  const root = tmp('ak-aqe-version-');
  const pkg = path.join(root, 'agentic-qe');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'agentic-qe', version }));
  _setGlobalRootForTest(root);
}

function registerHermes() {
  const baseDir = tmp('ak-aqe-hermes-');
  fs.writeFileSync(path.join(baseDir, 'provider.mjs'), 'process.stdin.pipe(process.stdout);\n');
  fs.writeFileSync(path.join(baseDir, 'execution.mjs'), 'process.stdin.pipe(process.stdout);\n');
  const manifest = validateAdapterManifest({
    name: 'hermes', version: '1.0.0', contract: 1,
    host: {
      id: 'hermes', label: 'Hermes',
      install: { bin: 'hermes', externalInstallPolicy: 'detect-never-overwrite' },
      capabilities: {
        canDriveSession: false, canBePrimary: false, canRouteActivities: true,
        commandStatusline: false, transcripts: false, usage: false,
        nativeMcpConfig: false, nativeGuidance: false,
      },
      trust: { approvalPolicy: 'unchanged', changes: [] },
      enabledByDefault: false, configProjection: 'ruflo', observability: [],
    },
    detection: { bin: 'hermes' }, driving: { surfaces: ['cli-subprocess'] },
    execution: { run: { hook: {
      command: [process.execPath, 'execution.mjs'], files: ['execution.mjs'],
    } } },
    aqe: { provider: {
      hook: { command: [process.execPath, 'provider.mjs'], files: ['provider.mjs'] },
      billingMode: 'subscription', models: ['default'], defaultModel: 'default',
    } },
    trust: { changes: [] },
  });
  const integrity = hashAdapterContent(manifest, { baseDir });
  registerAdmittedAqeProvider(manifest, { baseDir, integrity, contentHash: integrity.hash });
  return { baseDir, manifest, integrity };
}

function project() {
  const dir = tmp('ak-aqe-project-');
  fs.mkdirSync(path.join(dir, '.git'));
  return dir;
}

const cfg = ({
  provider = 'hermes',
  chain = [{ provider: 'hermes', models: ['default'] }],
  routes = { testing: { host: 'hermes', model: 'default', provenance: 'user' } },
} = {}) => ({
  aqe: true,
  integrations: { hosts: { claude: true, codex: false } },
  routing: { routes },
  providers: { aqeProvider: provider, aqeFallback: chain },
});

test('admitted providers become lazily selectable and project host routes', () => {
  assert.equal(aqeSelectableProviderTypes().includes('hermes'), false);
  registerHermes();
  assert.equal(aqeSelectableProviderTypes().includes('hermes'), true);
  assert.deepEqual(configuredPolicyToAgentOverrides(cfg().routing.routes)['qe-test-architect'], {
    provider: 'hermes', model: 'default',
  });
});

test('AQE 3.13.12 projection writes a project-only default and ownership receipt', () => {
  fakeAqe('3.13.12'); registerHermes();
  const dir = project();
  const result = applyAqeRouter(cfg(), dir);
  const disk = JSON.parse(fs.readFileSync(aqeRouterFile(dir), 'utf8'));
  assert.equal(result.ok, true);
  assert.equal(disk.defaultProvider, 'hermes');
  assert.equal(disk.externalProviders.hermes.kind, 'cli');
  assert.deepEqual(disk.providers.hermes, { enabled: true });
  assert.match(disk._agenticKit.externalProviders.hermes.writtenHash, /^[a-f0-9]{64}$/);
  assert.match(disk._agenticKit.externalProviders.hermes.providerWrittenHash, /^[a-f0-9]{64}$/);
  assert.equal(disk._agenticKit.externalDefaultProvider.provider, 'hermes');
  assert.match(disk._agenticKit.externalDefaultProvider.writtenHash, /^[a-f0-9]{64}$/);
  assert.equal(managedEnv(cfg()).AQE_LLM_PROVIDER, undefined, 'external default never leaks into settings env');
});

test('a converged external projection is byte- and mtime-idempotent', () => {
  fakeAqe('3.13.12'); registerHermes();
  for (const desired of [
    cfg({ chain: [], routes: {} }),
    cfg(),
  ]) {
    const dir = project();
    const first = applyAqeRouter(desired, dir);
    const file = aqeRouterFile(dir);
    const bytes = fs.readFileSync(file, 'utf8');
    const old = new Date('2001-01-01T00:00:00.000Z');
    fs.utimesSync(file, old, old);
    const beforeMtime = fs.statSync(file).mtimeMs;

    const second = applyAqeRouter(desired, dir);

    assert.equal(first.changed, true);
    assert.equal(second.ok, true, second.detail);
    assert.equal(second.changed, false, second.detail);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    assert.equal(fs.statSync(file).mtimeMs, beforeMtime, 'converged projection must not rewrite the file');
  }
});

test('an owned declaration refreshes atomically when admitted provider content changes', () => {
  fakeAqe('3.13.12');
  const admitted = registerHermes();
  const dir = project();
  assert.equal(applyAqeRouter(cfg(), dir).ok, true);
  const before = JSON.parse(fs.readFileSync(aqeRouterFile(dir), 'utf8'));
  const beforeCommand = before.externalProviders.hermes.command;
  const beforeReceipt = before._agenticKit.externalProviders.hermes;

  fs.appendFileSync(path.join(admitted.baseDir, 'provider.mjs'), '\n// admitted provider update\n');
  const nextIntegrity = hashAdapterContent(admitted.manifest, { baseDir: admitted.baseDir });
  registerAdmittedAqeProvider(admitted.manifest, {
    baseDir: admitted.baseDir,
    integrity: nextIntegrity,
    contentHash: nextIntegrity.hash,
  });
  const result = applyAqeRouter(cfg(), dir);
  const after = JSON.parse(fs.readFileSync(aqeRouterFile(dir), 'utf8'));
  const afterCommand = after.externalProviders.hermes.command;
  const afterReceipt = after._agenticKit.externalProviders.hermes;

  assert.equal(result.ok, true, result.detail);
  assert.notDeepEqual(afterCommand, beforeCommand);
  assert.equal(afterCommand[afterCommand.indexOf('--expect-hash') + 1], nextIntegrity.hash);
  assert.equal(afterReceipt.contentHash, nextIntegrity.hash);
  assert.notEqual(afterReceipt.writtenHash, beforeReceipt.writtenHash);
});

test('foreign same-id declarations are preserved and refused', () => {
  fakeAqe('3.13.12'); registerHermes();
  const dir = project();
  fs.mkdirSync(path.dirname(aqeRouterFile(dir)), { recursive: true });
  const foreign = { kind: 'cli', command: ['foreign-provider'] };
  const userChain = { id: 'user-chain', entries: [{ provider: 'hermes', enabled: true }] };
  fs.writeFileSync(aqeRouterFile(dir), JSON.stringify({
    externalProviders: { hermes: foreign },
    providers: { hermes: { enabled: true, source: 'user' } },
    defaultProvider: 'hermes',
    fallbackChain: userChain,
  }));
  const result = applyAqeRouter(cfg(), dir);
  const disk = JSON.parse(fs.readFileSync(aqeRouterFile(dir), 'utf8'));
  assert.equal(result.ok, false);
  assert.deepEqual(disk.externalProviders.hermes, foreign);
  assert.equal(disk.defaultProvider, 'hermes');
  assert.deepEqual(disk.fallbackChain, userChain);
  assert.deepEqual(disk.providers.hermes, { enabled: true, source: 'user' });
  assert.match(result.detail, /conflicts preserved/);
});

test('an external-default receipt cannot reacquire ownership after user drift', () => {
  fakeAqe('3.13.12'); registerHermes();
  const dir = project();
  assert.equal(applyAqeRouter(cfg({ chain: [] }), dir).ok, true);
  const file = aqeRouterFile(dir);
  let disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(disk._agenticKit.externalDefaultProvider.provider, 'hermes');

  disk.defaultProvider = 'openai';
  fs.writeFileSync(file, JSON.stringify(disk));
  assert.equal(applyAqeRouter(cfg({ provider: null, chain: [] }), dir).ok, true);
  disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(disk.defaultProvider, 'openai');
  assert.equal(disk._agenticKit?.externalDefaultProvider, undefined,
    'user drift relinquishes external-default ownership immediately');

  disk.defaultProvider = 'hermes';
  disk.externalProviders.hermes.command = ['/tmp/user-edited-provider'];
  fs.writeFileSync(file, JSON.stringify(disk));
  const conflict = applyAqeRouter(cfg({ provider: null, chain: [] }), dir);
  disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(conflict.ok, false);
  assert.equal(disk.defaultProvider, 'hermes', 'returning to the old value is still user-owned');
  assert.deepEqual(disk.externalProviders.hermes.command, ['/tmp/user-edited-provider']);
});

test('explicit deselection retires only the exactly owned external default', () => {
  fakeAqe('3.13.12'); registerHermes();
  const dir = project();
  assert.equal(applyAqeRouter(cfg({ chain: [], routes: {} }), dir).ok, true);

  const deselected = applyAqeRouter(cfg({ provider: null, chain: [], routes: {} }), dir);
  const disk = JSON.parse(fs.readFileSync(aqeRouterFile(dir), 'utf8'));
  assert.equal(deselected.ok, true, deselected.detail);
  assert.equal(deselected.changed, true);
  assert.equal(disk.defaultProvider, undefined, 'the previously selected external default is retired');
  assert.equal(disk._agenticKit.externalDefaultProvider, undefined, 'its exact ownership receipt is retired');
  assert.ok(disk.externalProviders.hermes, 'the admitted declaration remains available');
  assert.deepEqual(disk.providers.hermes, { enabled: true }, 'the MCP activation remains available');

  const converged = applyAqeRouter(cfg({ provider: null, chain: [], routes: {} }), dir);
  assert.equal(converged.changed, false, converged.detail);
});

test('malformed ownership receipts are relinquished without deleting user values or throwing', () => {
  fakeAqe('3.13.12');
  const dir = project();
  fs.mkdirSync(path.dirname(aqeRouterFile(dir)), { recursive: true });
  const userDeclaration = { kind: 'cli', command: ['user-provider'] };
  fs.writeFileSync(aqeRouterFile(dir), JSON.stringify({
    _managedBy: 'agentic-kit',
    _agenticKit: { externalProviders: { dead: null } },
    externalProviders: { dead: userDeclaration },
    providers: { dead: { enabled: true, source: 'user' } },
  }));

  const result = applyAqeRouter({ providers: {}, routing: { routes: {} } }, dir);
  const disk = JSON.parse(fs.readFileSync(aqeRouterFile(dir), 'utf8'));
  assert.equal(result.ok, true, result.detail);
  assert.deepEqual(disk.externalProviders.dead, userDeclaration);
  assert.deepEqual(disk.providers.dead, { enabled: true, source: 'user' });
  assert.equal(disk._agenticKit, undefined, 'a malformed receipt proves no ownership and is dropped');
});

test('stale owned declarations are pruned but edited declarations become user-owned', () => {
  fakeAqe('3.13.12'); registerHermes();
  const dir = project();
  applyAqeRouter(cfg(), dir);
  resetAdmittedAqeProviders();
  let result = applyAqeRouter({ ...cfg(), routing: { routes: {} }, providers: { aqeProvider: null, aqeFallback: [] } }, dir);
  let disk = JSON.parse(fs.readFileSync(aqeRouterFile(dir), 'utf8'));
  assert.match(result.detail, /stale owned pruned/);
  assert.equal(disk.externalProviders, undefined);
  assert.equal(disk.providers, undefined, 'unchanged ak-owned MCP activation is pruned');
  assert.equal(disk.defaultProvider, undefined, 'stale ak-owned default is not left dangling');

  registerHermes();
  applyAqeRouter(cfg(), dir);
  disk = JSON.parse(fs.readFileSync(aqeRouterFile(dir), 'utf8'));
  disk.externalProviders.hermes.displayName = 'User override';
  fs.writeFileSync(aqeRouterFile(dir), JSON.stringify(disk));

  result = applyAqeRouter(cfg(), dir);
  disk = JSON.parse(fs.readFileSync(aqeRouterFile(dir), 'utf8'));
  assert.equal(result.ok, false);
  assert.equal(disk.externalProviders.hermes.displayName, 'User override');
  assert.equal(disk.defaultProvider, undefined,
    'the ak-managed default cannot keep selecting a refused edited declaration');
  assert.equal(disk.fallbackChain, undefined,
    'the ak-managed fallback cannot keep selecting a refused edited declaration');
  assert.deepEqual(disk.providers.hermes, { enabled: true },
    'the exact activation receipt remains until revoke while routing references are withdrawn');
  assert.deepEqual(Object.keys(disk._agenticKit.externalProviders.hermes), ['providerWrittenHash'],
    'declaration ownership is relinquished while exact activation ownership remains');

  resetAdmittedAqeProviders();
  result = applyAqeRouter({ ...cfg(), routing: { routes: {} }, providers: { aqeProvider: null, aqeFallback: [] } }, dir);
  disk = JSON.parse(fs.readFileSync(aqeRouterFile(dir), 'utf8'));
  assert.equal(result.ok, true);
  assert.equal(disk.externalProviders.hermes.displayName, 'User override');
  assert.equal(disk.providers?.hermes, undefined,
    'the unchanged ak-created activation is pruned independently of the edited declaration');
  assert.equal(disk._agenticKit, undefined, 'receipt relinquished after user edit');
});

test('user-owned provider activation is preserved and explicit disablement is refused', () => {
  fakeAqe('3.13.12'); registerHermes();
  const dir = project();
  fs.mkdirSync(path.dirname(aqeRouterFile(dir)), { recursive: true });
  fs.writeFileSync(aqeRouterFile(dir), JSON.stringify({ providers: {
    hermes: { enabled: true, defaultModel: 'user-model' },
  } }));
  let result = applyAqeRouter(cfg(), dir);
  let disk = JSON.parse(fs.readFileSync(aqeRouterFile(dir), 'utf8'));
  assert.equal(result.ok, true, result.detail);
  assert.deepEqual(disk.providers.hermes, { enabled: true, defaultModel: 'user-model' });
  assert.equal(disk._agenticKit.externalProviders.hermes.providerWrittenHash, undefined,
    'ak does not claim a user-owned activation record');

  disk.providers.hermes.enabled = false;
  fs.writeFileSync(aqeRouterFile(dir), JSON.stringify(disk));
  result = applyAqeRouter(cfg(), dir);
  disk = JSON.parse(fs.readFileSync(aqeRouterFile(dir), 'utf8'));
  assert.equal(result.ok, false);
  assert.equal(disk.providers.hermes.enabled, false);
  assert.equal(disk.agentOverrides?.['qe-test-architect'], undefined,
    'an inactive external provider is pruned from ak-managed agent overrides');
  assert.match(result.detail, /enabled is not true/);
});

test('projection state detects declaration drift and a missing ownership receipt', () => {
  fakeAqe('3.13.12'); registerHermes();
  const state = aqeExternalProviderState({
    externalProviders: { hermes: { kind: 'cli', command: ['foreign-provider'] } },
  });
  assert.equal(state.ok, false);
  assert.deepEqual(state.drifted, ['hermes']);
});

test('external projection refuses AQE versions before 3.13.12', () => {
  fakeAqe('3.13.11'); registerHermes();
  const dir = project();
  const result = applyAqeRouter(cfg(), dir);
  assert.equal(result.ok, false);
  assert.match(result.detail, />=3\.13\.12/);
  assert.equal(fs.existsSync(aqeRouterFile(dir)), false);
});

test('AQE downgrade prunes only unchanged owned declarations and dangling references', () => {
  fakeAqe('3.13.12'); registerHermes();
  const dir = project();
  assert.equal(applyAqeRouter(cfg(), dir).ok, true);
  fakeAqe('3.13.0');
  const result = applyAqeRouter(cfg(), dir);
  const disk = JSON.parse(fs.readFileSync(aqeRouterFile(dir), 'utf8'));
  assert.equal(result.ok, false);
  assert.match(result.detail, /stale owned pruned/);
  assert.equal(disk.externalProviders, undefined);
  assert.equal(disk.providers, undefined);
  assert.equal(disk.defaultProvider, undefined);
  assert.equal(disk.fallbackChain, undefined);
  assert.equal(disk.agentOverrides?.['qe-test-architect'], undefined,
    'downgrade below agentOverrides support still prunes ak-managed external references');
  assert.equal(disk._agenticKit, undefined);
});
