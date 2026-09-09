import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createMaintenanceProviderRegistry, publicMaintenanceProviders,
} from '../../src/lib/maintenance/provider-registry.mjs';
import { createClaudePluginProvider } from '../../src/lib/maintenance/providers/claude-plugin.mjs';
import { createCodexPluginProvider } from '../../src/lib/maintenance/providers/codex-plugin.mjs';
import { createCodexMcpProvider } from '../../src/lib/maintenance/providers/codex-mcp.mjs';
import { runNativeCommand } from '../../src/lib/maintenance/native-command.mjs';

function scriptedRun(steps, calls) {
  return async (binary, args) => {
    calls.push({ binary, args });
    const next = steps.shift();
    if (!next) throw new Error('unexpected native command');
    return typeof next === 'function' ? next(binary, args) : next;
  };
}

const okJson = (value) => ({ ok: true, exitCode: 0, timedOut: false, stdout: JSON.stringify(value), stderr: '' });
const pluginFinding = (host, operation, overrides = {}) => ({
  state: operation === 'update' ? 'update-available' : 'stale-configuration',
  safetyClass: 'approval-required',
  resource: {
    id: `plugin:${host}:demo@market`, kind: 'plugin', name: 'demo', host, scope: 'user',
    providerRef: 'demo@market', path: '/browser/must/not/control',
  },
  versions: { installed: '1.0.0', recommended: operation === 'update' ? '1.1.0' : null },
  ownership: { authority: 'native-inventory', managed: true },
  nextAction: { operation },
  ...overrides,
});

test('registry admits explicit providers, publishes capability facts, and rejects malformed or duplicate entries', () => {
  const provider = {
    id: 'test', version: '1', resourceKinds: ['plugin'], operations: ['disable'],
    detect() {}, actionFor() {}, preflight() {}, apply() {}, verify() {},
  };
  const registry = createMaintenanceProviderRegistry([provider]);
  assert.equal(registry.get('test'), provider);
  assert.deepEqual(publicMaintenanceProviders(registry), [{
    id: 'test', version: '1', resourceKinds: ['plugin'], operations: ['disable'],
    rollback: [], status: 'available',
  }]);
  assert.throws(() => createMaintenanceProviderRegistry([provider, provider]), /duplicate/);
  assert.throws(() => createMaintenanceProviderRegistry([{ id: '../bad', version: '1' }]), /invalid/);
  assert.throws(() => createMaintenanceProviderRegistry([{ ...provider, operations: ['shell anything'] }]), /operation/);
  assert.throws(() => createMaintenanceProviderRegistry([{
    ...provider, rollback: ['reversible'],
  }]), /undo verification/);
});

test('Claude plugin provider plans only exact native update/disable operations and never exposes argv or paths', async () => {
  const calls = [];
  const installed = { installed: [{ pluginId: 'demo@market', version: '1.0.0', scope: 'user', enabled: true,
    installPath: '/secret/cache', mcpServers: { demo: { headers: { Authorization: 'secret' } } } }],
  available: [{ pluginId: 'demo@market', version: '1.1.0' }] };
  const updated = { installed: [{ pluginId: 'demo@market', version: '1.1.0', scope: 'user', enabled: true }],
    available: [] };
  const run = scriptedRun([
    okJson(installed), okJson(installed), { ok: true, exitCode: 0, stdout: '', stderr: '' }, okJson(updated),
  ], calls);
  const provider = createClaudePluginProvider({ run });
  const facts = await provider.detect();
  assert.deepEqual(facts.plugins, [{
    ref: 'demo@market', version: '1.0.0', candidateStatus: 'exact',
    availableVersion: '1.1.0', scope: 'user', enabled: true,
  }]);
  assert.equal(JSON.stringify(facts).includes('secret'), false);
  assert.equal(JSON.stringify(facts).includes('installPath'), false);
  const item = provider.actionFor(pluginFinding('claude', 'update'), facts);
  assert.equal(item.operation, 'update');
  assert.equal(item.rollback, 'irreversible');
  assert.equal(item.executable, true);
  assert.equal('command' in item, false);
  assert.equal('argv' in item, false);
  assert.equal('path' in item.resourceIdentity, false);
  assert.equal((await provider.preflight(item)).ok, true);
  const outcome = await provider.apply(item);
  assert.equal(outcome.status, 'applied');
  assert.equal((await provider.verify(item, outcome)).ok, true);
  assert.deepEqual(calls[2], {
    binary: 'claude', args: ['plugin', 'update', '--scope', 'user', '--yes', 'demo@market'],
  });

  assert.equal(provider.actionFor(pluginFinding('claude', 'update', {
    resource: { ...pluginFinding('claude', 'update').resource, providerRef: 'demo;rm@market' },
  }), facts), null);
  assert.equal(provider.actionFor(pluginFinding('codex', 'update'), facts), null);
  assert.equal(provider.actionFor(pluginFinding('claude', 'update', {
    versions: { installed: '1.0.0', recommended: '1.2.0' },
  }), facts), null, 'a recommendation not reported by the native host is never executable');
});

test('Claude disable is reversible through fixed enable argv and verifies both sides', async () => {
  const calls = [];
  const enabled = [{ id: 'demo@market', version: '1.0.0', scope: 'user', enabled: true }];
  const disabled = [{ id: 'demo@market', version: '1.0.0', scope: 'user', enabled: false }];
  const run = scriptedRun([
    okJson(enabled), okJson(enabled), { ok: true, exitCode: 0, stdout: '', stderr: '' }, okJson(disabled),
    { ok: true, exitCode: 0, stdout: '', stderr: '' }, okJson(enabled),
  ], calls);
  const provider = createClaudePluginProvider({ run });
  const facts = await provider.detect();
  const item = provider.actionFor(pluginFinding('claude', 'disable'), facts);
  assert.equal(item.rollback, 'reversible');
  assert.equal((await provider.preflight(item)).ok, true);
  const outcome = await provider.apply(item);
  assert.equal((await provider.verify(item, outcome)).ok, true);
  const entry = {
    actionId: item.id, operation: item.operation, resourceIdentity: item.resourceIdentity,
    sourceFingerprint: item.sourceFingerprint, outcome,
  };
  assert.equal((await provider.undo(entry)).status, 'restored');
  assert.equal((await provider.verifyUndo(entry)).ok, true);
  assert.deepEqual(calls[2].args, ['plugin', 'disable', '--scope', 'user', 'demo@market']);
  assert.deepEqual(calls[4].args, ['plugin', 'enable', '--scope', 'user', 'demo@market']);
});

test('Codex plugin removal is exact, native, irreversible, and verified by fresh inventory', async () => {
  const calls = [];
  const installed = { installed: [{ pluginId: 'demo@market', version: '1.0.0', installed: true, enabled: true,
    source: { path: '/private/cache' } }], available: [] };
  const absent = { installed: [], available: [] };
  const run = scriptedRun([
    okJson(installed), okJson(installed), { ok: true, exitCode: 0, stdout: '{}', stderr: '' }, okJson(absent),
  ], calls);
  const provider = createCodexPluginProvider({ run });
  const facts = await provider.detect();
  assert.equal(JSON.stringify(facts).includes('/private/cache'), false);
  const item = provider.actionFor(pluginFinding('codex', 'remove'), facts);
  assert.equal(item.rollback, 'irreversible');
  assert.equal((await provider.preflight(item)).ok, true);
  const outcome = await provider.apply(item);
  assert.equal((await provider.verify(item, outcome)).ok, true);
  assert.deepEqual(calls[2], { binary: 'codex', args: ['plugin', 'remove', 'demo@market', '--json'] });
});

test('Codex MCP provider keeps registration/configuration/health/auth facts distinct and removes by exact name only', async () => {
  const calls = [];
  const configured = [{ name: 'demo-mcp', enabled: true, auth_status: 'authenticated',
    transport: { type: 'stdio', command: 'secret-command', env: { TOKEN: 'secret' } } }];
  const run = scriptedRun([
    okJson(configured), okJson(configured), { ok: true, exitCode: 0, stdout: '', stderr: '' }, okJson([]),
  ], calls);
  const provider = createCodexMcpProvider({ run });
  const facts = await provider.detect();
  assert.deepEqual({ ...facts.servers[0], configurationFingerprint: undefined }, {
    name: 'demo-mcp', registered: true, configured: true, enabled: true,
    reachable: 'unknown', healthy: 'unknown', authenticated: true, authorized: 'unknown',
    configurationFingerprint: undefined,
  });
  assert.match(facts.servers[0].configurationFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(facts).includes('secret'), false);
  const finding = {
    state: 'stale-configuration', safetyClass: 'approval-required',
    resource: { id: 'mcp:codex:demo-mcp', kind: 'mcpServer', name: 'demo-mcp', host: 'codex', scope: 'user' },
    ownership: { authority: 'native-inventory', managed: true }, nextAction: { operation: 'remove' },
  };
  const item = provider.actionFor(finding, facts);
  assert.equal((await provider.preflight(item)).ok, true);
  const outcome = await provider.apply(item);
  assert.equal((await provider.verify(item, outcome)).ok, true);
  assert.deepEqual(calls[2], { binary: 'codex', args: ['mcp', 'remove', 'demo-mcp'] });
  assert.equal(provider.actionFor({ ...finding, resource: { ...finding.resource, name: '../escape' } }, facts), null);
});

test('native failures and malformed inventory fail closed without fabricating state', async () => {
  const timeout = { ok: false, exitCode: null, timedOut: true, stdout: '', stderr: 'secret detail' };
  const provider = createClaudePluginProvider({ run: scriptedRun([timeout], []) });
  const facts = await provider.detect();
  assert.equal(facts.status, 'unavailable');
  assert.equal(facts.complete, false);
  assert.equal(JSON.stringify(facts).includes('secret'), false);

  const malformed = createCodexPluginProvider({ run: scriptedRun([okJson({ wrong: true })], []) });
  assert.equal((await malformed.detect()).complete, false);
});

test('native runner uses asynchronous fixed argv with shell disabled and bounded capture', async () => {
  let invocation;
  const result = await runNativeCommand('claude', ['plugin', 'list', '--json'], {
    timeoutMs: 1234,
    execFileImpl(binary, args, options, callback) {
      invocation = { binary, args, options };
      setImmediate(() => callback(null, '[]', ''));
    },
  });
  assert.equal(result.ok, true);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.timeout, 1234);
  assert.equal(invocation.options.maxBuffer, 256 * 1024);
  assert.deepEqual(invocation.args, ['plugin', 'list', '--json']);
  await assert.rejects(() => runNativeCommand('../shell', []), /binary/);
  await assert.rejects(() => runNativeCommand('claude', ['bad\0arg']), /arguments/);
});

test('native runner does not monopolize the event loop while a host command is pending', async () => {
  let release;
  const pending = runNativeCommand('codex', ['plugin', 'list', '--json'], {
    execFileImpl(_binary, _args, _options, callback) {
      release = () => callback(null, '{"plugins":[]}', '');
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof release, 'function', 'the asynchronous child command was started');
  release();
  assert.equal((await pending).ok, true);
});

test('native runner reports timeout, abort, and non-zero exit without leaking unbounded output', async () => {
  const timeout = await runNativeCommand('claude', ['plugin', 'list'], {
    timeoutMs: 5,
    execFileImpl(_binary, _args, _options, callback) {
      setTimeout(() => callback(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT', signal: 'SIGTERM' }), 'x', 'y'), 10);
    },
  });
  assert.equal(timeout.ok, false);
  assert.equal(timeout.timedOut, true);
  assert.equal(timeout.signal, 'SIGTERM');

  const controller = new AbortController();
  controller.abort();
  const aborted = await runNativeCommand('codex', ['mcp', 'list'], {
    signal: controller.signal,
    execFileImpl(_binary, _args, options, callback) {
      assert.equal(options.signal, controller.signal);
      callback(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }), '', '');
    },
  });
  assert.equal(aborted.aborted, true);

  const large = 'x'.repeat(300 * 1024);
  const failed = await runNativeCommand('codex', ['plugin', 'list'], {
    execFileImpl(_binary, _args, _options, callback) {
      callback(Object.assign(new Error('failed'), { code: 2 }), large, large);
    },
  });
  assert.equal(failed.exitCode, 2);
  assert.equal(failed.stdout.length, 256 * 1024);
  assert.equal(failed.stderr.length, 256 * 1024);
});
