import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandboxHome } from './helpers/home-sandbox.mjs';

sandboxHome('ak-sync-host-repair');
const sync = await import('../../src/commands/sync.mjs');

const hostsStep = sync.SYNC_STEPS.find((s) => s.id === 'hosts');
const cfg = { integrations: { hosts: { claude: false, codex: true, opencode: false } } };

async function runHosts(lifecycle) {
  const steps = [];
  const installs = [];
  await hostsStep.run({ cfg, hostLifecycle: {
    ...lifecycle,
    install: async (id) => { installs.push(id); return { ok: true, detail: 'installed' }; },
  }, step: async (label, fn) => { steps.push(label); return fn(); } });
  return { steps, installs };
}

test('sync reinstalls an npm-owned host whose CLI cannot start', async () => {
  const r = await runHosts({
    installState: async () => ({ method: 'npm', version: '0.156.1' }),
    executable: async () => ({ ok: false, detail: 'Error: Missing optional dependency @openai/codex-darwin-arm64.' }),
  });
  assert.deepEqual(r.steps, ['repair codex']);
  assert.deepEqual(r.installs, ['codex']);
});

test('sync leaves an executable npm host and any external host alone', async () => {
  for (const method of ['npm', 'external']) {
    const r = await runHosts({
      installState: async () => ({ method, version: '0.156.1' }),
      executable: async () => { if (method === 'external') throw new Error('external hosts are not probed'); return { ok: true }; },
    });
    assert.deepEqual(r.installs, [], method);
  }
});

test('sync still installs an absent enabled host', async () => {
  const r = await runHosts({
    installState: async () => ({ method: 'absent', version: null }),
    executable: async () => { throw new Error('absent hosts are not probed'); },
  });
  assert.deepEqual(r.steps, ['install codex']);
});

test('the hosts step runs before Codex MCP repair and the provider stack that use the CLI', () => {
  const order = sync.SYNC_STEPS.map((s) => s.id);
  assert.ok(order.indexOf('hosts') < order.indexOf('codex-mcp-repair'));
  assert.ok(order.indexOf('hosts') < order.indexOf('providers'));
});

test('the versions step verifies host CLIs it upgrades', () => {
  assert.equal(sync.hostUpgradeOptions('@openai/codex').bin, 'codex');
  assert.deepEqual(sync.hostUpgradeOptions('ruflo'), {});
});
