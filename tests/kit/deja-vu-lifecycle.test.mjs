import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  companionLifecycleFor,
  companionsWithLifecycle,
} from '../../src/lib/adapters/companion-lifecycle-registry.mjs';
import { createDejaVuLifecycleAdapter } from '../../src/lib/adapters/deja-vu.mjs';
import { runLifecycle } from '../../src/lib/adapters/lifecycle.mjs';

const baseDoctor = () => ({
  schema_version: 2,
  stores: [],
  index: { state: 'missing', stale_stores: 0 },
  mcp: [],
  sqlite3: { state: 'ok' },
  version: { state: 'offline', current: '0.19.0' },
  policy: {
    state: 'default', indexed_sessions: 0,
    activations: { search: { withheld: 0 }, mcp: { withheld: 0 }, auto: { withheld: 0 } },
  },
  sync: { state: 'ok', peers: [] },
});

const config = (mode = 'mcp') => ({
  integrations: {
    tools: { dejaVu: { enabled: true, mode, hosts: ['claude'], indexOnSetup: true } },
  },
});

function fakeEnvironment({ binary = false, npmVersion = null, doctor = baseDoctor() } = {}) {
  const state = {
    binary, npmVersion, doctor: structuredClone(doctor),
    targets: {
      claude: { direct: { mcp: false, auto: false }, projection: { mcp: null, auto: null }, plugin: { present: false, auto: false } },
      codex: { direct: { mcp: false, auto: false }, projection: { mcp: null, auto: null }, plugin: { present: false, auto: false } },
      opencode: { direct: { mcp: false, auto: false }, projection: { mcp: null, auto: null }, plugin: { present: false, auto: false } },
    },
  };
  const calls = [];
  const runner = async (command, args) => {
    calls.push([command, ...args]);
    if (command === 'npm' && args[0] === 'install') {
      state.binary = true;
      state.npmVersion = args.find((arg) => arg.startsWith('@vshulcz/deja-vu@')).split('@').at(-1);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (command === 'npm' && args[0] === 'uninstall') {
      state.binary = false;
      state.npmVersion = null;
      return { code: 0, stdout: '', stderr: '' };
    }
    if (command === 'deja' && args[0] === 'doctor') {
      return { code: 0, stdout: JSON.stringify(state.doctor), stderr: '' };
    }
    if (command === 'deja' && args[0] === 'install') {
      const target = args[1];
      const host = target.startsWith('claude') ? 'claude'
        : target.startsWith('codex') ? 'codex' : 'opencode';
      state.targets[host].direct.mcp = true;
      state.targets[host].direct.auto = target.endsWith('-auto');
      state.targets[host].projection.mcp = 'a'.repeat(64);
      state.targets[host].projection.auto = target.endsWith('-auto') ? 'b'.repeat(64) : null;
      return { code: 0, stdout: 'SENTINEL private path', stderr: '' };
    }
    if (command === 'deja' && args[0] === 'uninstall') {
      const target = args[1];
      const host = target.startsWith('claude') ? 'claude'
        : target.startsWith('codex') ? 'codex' : 'opencode';
      state.targets[host].direct.mcp = false;
      state.targets[host].direct.auto = false;
      state.targets[host].projection.mcp = null;
      state.targets[host].projection.auto = null;
      return { code: 0, stdout: '', stderr: 'SENTINEL private path' };
    }
    if (command === 'deja' && args[0] === 'index') {
      state.doctor.index.state = 'ok';
      return { code: 0, stdout: 'SENTINEL transcript', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };
  const adapter = createDejaVuLifecycleAdapter({
    runner,
    haveFn: async (bin) => bin === 'deja' ? state.binary : bin === 'claude',
    packageVersionFn: async () => state.npmVersion,
    latestVersionFn: async () => '0.19.0',
    targetObserver: async () => structuredClone(state.targets),
    clock: () => '2026-08-26T00:00:00.000Z',
  });
  return { state, calls, adapter };
}

test('disabled unowned intent performs no binary, package, host, doctor, or observer probes', async () => {
  const calls = [];
  const adapter = createDejaVuLifecycleAdapter({
    runner: async () => { calls.push('runner'); throw new Error('must not run'); },
    haveFn: async () => { calls.push('have'); throw new Error('must not run'); },
    packageVersionFn: async () => { calls.push('package'); throw new Error('must not run'); },
    latestVersionFn: async () => { calls.push('version'); throw new Error('must not run'); },
    targetObserver: async () => { calls.push('observer'); throw new Error('must not run'); },
  });
  const cfg = config();
  cfg.integrations.tools.dejaVu.enabled = false;
  const facts = await adapter.detect({ cfg });
  const plan = await adapter.plan({ cfg, facts });
  assert.deepEqual(calls, []);
  assert.equal(facts.doctor.reason, 'integration-disabled');
  assert.deepEqual(plan.operations, []);
});

test('deja-vu lifecycle is registered only as a managed companion', () => {
  assert.deepEqual(companionsWithLifecycle(), ['deja-vu']);
  assert.equal(companionLifecycleFor('deja-vu')?.id, 'deja-vu');
  assert.equal(companionLifecycleFor('unknown'), null);
});

test('detect and plan are sanitized, read-only, deterministic, and explicit', async () => {
  const env = fakeEnvironment();
  const cfg = config();
  const before = structuredClone(cfg);
  const facts = await env.adapter.detect({ cfg });
  const first = await env.adapter.plan({ cfg, facts });
  const second = await env.adapter.plan({ cfg, facts });
  assert.deepEqual(second, first);
  assert.deepEqual(cfg, before);
  assert.deepEqual(first.operations.map(({ command, args }) => [command, ...args]), [
    ['npm', 'install', '-g', '@vshulcz/deja-vu@0.19.0', '--no-audit', '--no-fund'],
    ['deja', 'install', 'claude-code', '--no-guidance', '--no-index'],
    ['deja', 'index'],
  ]);
  assert.doesNotMatch(JSON.stringify({ facts, first }), /SENTINEL|warmup|deja update|--all/);
  assert.equal(env.calls.filter((call) => call[1] !== 'doctor').length, 0);
});

test('apply verifies each stage, records receipts, indexes once, and is idempotent', async () => {
  const env = fakeEnvironment();
  const cfg = config();
  const first = await runLifecycle({ adapter: env.adapter, action: 'apply', cfg });
  assert.equal(first.ok, true);
  assert.equal(first.configChanged, true);
  assert.equal(cfg.integrations.ownership.dejaVu.install.written.version, '0.19.0');
  assert.equal(cfg.integrations.ownership.dejaVu.targets.claude.mode, 'mcp');
  assert.equal(env.calls.filter((call) => call[0] === 'deja' && call[1] === 'index').length, 1);
  assert.doesNotMatch(JSON.stringify(first), /SENTINEL/);

  const mutationCount = env.calls.filter((call) => ['install', 'uninstall', 'index'].includes(call[1])).length;
  const second = await runLifecycle({ adapter: env.adapter, action: 'apply', cfg });
  assert.equal(second.ok, true);
  assert.equal(second.changed, false);
  assert.equal(second.configChanged, false);
  assert.equal(env.calls.filter((call) => ['install', 'uninstall', 'index'].includes(call[1])).length,
    mutationCount);
});

test('supported external install and exact external wiring are preserved without adoption', async () => {
  const env = fakeEnvironment({ binary: true, npmVersion: '0.19.0' });
  env.state.doctor.index.state = 'ok';
  env.state.targets.claude.direct.mcp = true;
  const cfg = config();
  const result = await runLifecycle({ adapter: env.adapter, action: 'apply', cfg });
  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.equal(cfg.integrations.ownership, undefined);
  assert.equal(env.calls.some((call) => call[0] === 'npm'), false);
});

test('structural verify reuses the lifecycle observation and runs doctor once', async () => {
  const env = fakeEnvironment({ binary: true, npmVersion: '0.19.0' });
  env.state.doctor.index.state = 'ok';
  env.state.targets.claude.direct.mcp = true;
  const result = await runLifecycle({ adapter: env.adapter, action: 'verify', cfg: config() });
  assert.equal(result.ok, true);
  assert.equal(env.calls.filter((call) => call[0] === 'deja' && call[1] === 'doctor').length, 1);
});

test('exit-zero doctor degradation fails verification and uses a dashboard-safe deadline', async () => {
  const unhealthy = baseDoctor();
  unhealthy.index.state = 'ok';
  unhealthy.stores = [{
    name: 'claude', state: 'denied', files: 1, indexed_sessions: 0,
  }];
  unhealthy.sqlite3.state = 'missing';
  const calls = [];
  const adapter = createDejaVuLifecycleAdapter({
    runner: async (command, args, options) => {
      calls.push([command, ...args, options.timeout]);
      return { code: 0, stdout: JSON.stringify(unhealthy), stderr: '' };
    },
    haveFn: async (bin) => bin === 'deja' || bin === 'claude',
    packageVersionFn: async () => '0.19.0',
    targetObserver: async () => ({
      claude: {
        direct: { mcp: true, auto: false },
        projection: { mcp: 'a'.repeat(64), auto: null },
        plugin: { present: false, auto: false },
      },
      codex: { direct: { mcp: false, auto: false }, plugin: { present: false, auto: false } },
      opencode: { direct: { mcp: false, auto: false }, plugin: { present: false, auto: false } },
    }),
  });
  const result = await runLifecycle({ adapter, action: 'verify', cfg: config() });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('deja-doctor-components-degraded'));
  assert.equal(result.facts.doctor.health.state, 'degraded');
  assert.equal(result.facts.doctor.health.storeIssues, 1);
  assert.deepEqual(calls, [['deja', 'doctor', '--json', '--offline', 10_000]]);
});

test('unknown doctor schema fails closed before any mutation', async () => {
  const bad = baseDoctor();
  bad.schema_version = 999;
  const env = fakeEnvironment({ binary: true, npmVersion: '0.19.0', doctor: bad });
  const result = await runLifecycle({ adapter: env.adapter, action: 'apply', cfg: config() });
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /schema-unsupported/);
  assert.equal(env.calls.some((call) => ['install', 'uninstall', 'index'].includes(call[1])), false);
});

test('auto to mcp transition removes, redetects, installs, and replaces the receipt', async () => {
  const env = fakeEnvironment();
  const cfg = config('auto');
  assert.equal((await runLifecycle({ adapter: env.adapter, action: 'apply', cfg })).ok, true);
  cfg.integrations.tools.dejaVu.mode = 'mcp';
  const start = env.calls.length;
  const result = await runLifecycle({ adapter: env.adapter, action: 'apply', cfg });
  assert.equal(result.ok, true);
  assert.equal(cfg.integrations.ownership.dejaVu.targets.claude.mode, 'mcp');
  const mutations = env.calls.slice(start).filter((call) => ['install', 'uninstall'].includes(call[1]));
  assert.deepEqual(mutations, [
    ['deja', 'uninstall', 'claude-auto', '--no-guidance', '--no-index'],
    ['deja', 'install', 'claude-code', '--no-guidance', '--no-index'],
  ]);
});

test('receipt drift refuses collateral uninstall and preserves ownership', async () => {
  const env = fakeEnvironment();
  const cfg = config();
  assert.equal((await runLifecycle({ adapter: env.adapter, action: 'apply', cfg })).ok, true);
  env.state.targets.claude.direct.auto = true;
  cfg.integrations.tools.dejaVu.enabled = false;
  const start = env.calls.length;
  const result = await runLifecycle({ adapter: env.adapter, action: 'apply', cfg });
  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.ok(cfg.integrations.ownership.dejaVu.targets.claude);
  assert.equal(env.calls.slice(start).some((call) => call[1] === 'uninstall'), false);
  assert.ok(result.warnings.includes('claude-ownership-drift-preserved'));
});

test('same-presence value drift refuses collateral uninstall', async () => {
  const env = fakeEnvironment();
  const cfg = config();
  assert.equal((await runLifecycle({ adapter: env.adapter, action: 'apply', cfg })).ok, true);
  env.state.targets.claude.projection.mcp = 'c'.repeat(64);
  cfg.integrations.tools.dejaVu.enabled = false;
  const start = env.calls.length;
  const result = await runLifecycle({ adapter: env.adapter, action: 'undo', cfg });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('claude-collateral-uninstall-refused'));
  assert.equal(env.calls.slice(start).some((call) => call[1] === 'uninstall'), false);
});

test('malformed target receipt cannot authorize uninstall even when the wiring signature matches', async () => {
  const env = fakeEnvironment();
  const cfg = config();
  assert.equal((await runLifecycle({ adapter: env.adapter, action: 'apply', cfg })).ok, true);
  cfg.integrations.ownership.dejaVu.targets.claude.target = 'codex';
  const start = env.calls.length;
  const result = await runLifecycle({ adapter: env.adapter, action: 'undo', cfg });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('claude-collateral-uninstall-refused'));
  assert.equal(env.calls.slice(start).some((call) => call[1] === 'uninstall'), false);
});

test('external plugin changes do not drift a direct-wiring receipt', async () => {
  const env = fakeEnvironment();
  const cfg = config();
  assert.equal((await runLifecycle({ adapter: env.adapter, action: 'apply', cfg })).ok, true);
  env.state.targets.claude.plugin = { present: true, auto: true };
  cfg.integrations.tools.dejaVu.enabled = false;
  const result = await runLifecycle({ adapter: env.adapter, action: 'apply', cfg });
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(cfg.integrations.ownership.dejaVu.targets, undefined);
  assert.ok(env.calls.some((call) => call[1] === 'uninstall'));
});

test('allowUpgrade false suppresses package upgrade but still heals target and index drift', async () => {
  const doctor = baseDoctor();
  doctor.version.current = '0.18.0';
  const env = fakeEnvironment({ binary: true, npmVersion: '0.18.0', doctor });
  const cfg = config();
  cfg.integrations.ownership = { dejaVu: {
    install: {
      owner: 'agentic-kit', method: 'npm', package: '@vshulcz/deja-vu',
      written: { version: '0.18.0' },
    },
    targets: {},
  } };
  const result = await runLifecycle({
    adapter: env.adapter, action: 'apply', cfg, options: { allowUpgrade: false },
  });
  assert.equal(result.ok, true);
  assert.ok(result.warnings.includes('deja-package-upgrade-suppressed'));
  assert.equal(env.calls.some((call) => call[0] === 'npm'), false);
  assert.ok(env.calls.some((call) => call[0] === 'deja' && call[1] === 'install'));
  assert.ok(env.calls.some((call) => call[0] === 'deja' && call[1] === 'index'));
});

test('owned npm companion upgrades to a strictly validated registry version', async () => {
  const env = fakeEnvironment({ binary: true, npmVersion: '0.19.0' });
  env.state.doctor.index.state = 'ok';
  env.state.targets.claude.direct.mcp = true;
  const cfg = config();
  cfg.integrations.ownership = { dejaVu: {
    install: {
      owner: 'agentic-kit', method: 'npm', package: '@vshulcz/deja-vu',
      written: { version: '0.19.0' },
    },
    targets: {},
  } };
  // Rebuild the fixture adapter with only the registry seam changed.
  const upgraded = createDejaVuLifecycleAdapter({
    runner: async (command, args) => {
      env.calls.push([command, ...args]);
      if (command === 'npm') {
        env.state.npmVersion = '0.20.0';
        return { code: 0, stdout: '', stderr: '' };
      }
      if (command === 'deja' && args[0] === 'doctor') {
        env.state.doctor.version.current = env.state.npmVersion;
        return { code: 0, stdout: JSON.stringify(env.state.doctor), stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
    haveFn: async (bin) => bin === 'deja' || bin === 'claude',
    packageVersionFn: async () => env.state.npmVersion,
    latestVersionFn: async () => '0.20.0',
    targetObserver: async () => structuredClone(env.state.targets),
  });
  const result = await runLifecycle({ adapter: upgraded, action: 'apply', cfg });
  assert.equal(result.ok, true);
  assert.ok(env.calls.some((call) => call.join(' ') ===
    'npm install -g @vshulcz/deja-vu@0.20.0 --no-audit --no-fund'));
  assert.equal(cfg.integrations.ownership.dejaVu.install.written.version, '0.20.0');
});

test('unavailable or unsafe latest metadata never enters a package command', async () => {
  for (const latest of [null, '0.18.9', '0.20.0 --unsafe']) {
    const env = fakeEnvironment({ binary: true, npmVersion: '0.19.0' });
    env.state.doctor.index.state = 'ok';
    env.state.targets.claude.direct.mcp = true;
    const cfg = config();
    cfg.integrations.ownership = { dejaVu: {
      install: {
        owner: 'agentic-kit', method: 'npm', package: '@vshulcz/deja-vu',
        written: { version: '0.19.0' },
      }, targets: {},
    } };
    const adapter = createDejaVuLifecycleAdapter({
      runner: async (command, args) => {
        env.calls.push([command, ...args]);
        if (command === 'deja' && args[0] === 'doctor') {
          return { code: 0, stdout: JSON.stringify(env.state.doctor), stderr: '' };
        }
        return { code: 1, stdout: '', stderr: '' };
      },
      haveFn: async (bin) => bin === 'deja' || bin === 'claude',
      packageVersionFn: async () => env.state.npmVersion,
      latestVersionFn: async () => latest,
      targetObserver: async () => structuredClone(env.state.targets),
    });
    const facts = await adapter.detect({ cfg });
    const plan = await adapter.plan({ cfg, facts });
    assert.equal(plan.operations.some(({ command }) => command === 'npm'), false);
    assert.ok(plan.warnings.includes('deja-package-latest-unavailable'));
    assert.doesNotMatch(JSON.stringify(plan), /--unsafe/);
  }
});

test('undo removes verified target before exact owned npm package and never touches index', async () => {
  const env = fakeEnvironment();
  const cfg = config();
  assert.equal((await runLifecycle({ adapter: env.adapter, action: 'apply', cfg })).ok, true);
  const start = env.calls.length;
  const result = await runLifecycle({
    adapter: env.adapter, action: 'undo', cfg, options: { removePackage: true },
  });
  assert.equal(result.ok, true);
  assert.equal(result.configChanged, true);
  assert.equal(cfg.integrations.ownership, undefined);
  const mutations = env.calls.slice(start).filter((call) => ['uninstall', 'index'].includes(call[1]));
  assert.deepEqual(mutations, [
    ['deja', 'uninstall', 'claude-code', '--no-guidance', '--no-index'],
    ['npm', 'uninstall', '-g', '@vshulcz/deja-vu', '--no-audit', '--no-fund'],
  ]);
});
