import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { sandboxHome, rmrf } from './helpers/home-sandbox.mjs';

const SANDBOX_HOME = sandboxHome('ak-sync-host-repair');
after(() => rmrf(SANDBOX_HOME));
const sync = await import('../../src/commands/sync.mjs');

const hostsStep = sync.SYNC_STEPS.find((s) => s.id === 'hosts');
const cfg = { integrations: { hosts: { claude: false, codex: true, opencode: false } } };

async function runHosts(lifecycle, { collectHostFacts = async () => {} } = {}) {
  const steps = [];
  const installs = [];
  await hostsStep.run({
    cfg, collectHostFacts, hostLifecycle: {
      ...lifecycle,
      install: async (id) => { installs.push(id); return { ok: true, detail: 'installed' }; },
    }, step: async (label, fn) => { steps.push(label); return fn(); },
  });
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

// ── re-record evidence after a repair succeeds ───────────
// The Important finding: `installState()` at the top of the loop records the
// PRE-repair evidence; without a re-probe after `install()` succeeds, that
// stale row is the last thing written — a later `ak status`/this sync's own
// converge proof would see the host as still broken/absent. Mutation-tested:
// deleting the `installState`/`executable`/`collectHostFacts` re-probe block
// in src/commands/sync.mjs's 'hosts' step turns the first assertion below red
// (the second `installState` call, and the `collectHostFacts` call, never
// happen) while leaving every other test in this file green.

test('a successful repair re-probes and re-records host evidence with source "sync"', async () => {
  const installStateCalls = [];
  const executableCalls = [];
  let n = 0;
  const installState = async (h, opts) => {
    n += 1;
    installStateCalls.push(opts);
    // Stateful: absent before install(), npm after — mirrors a real repair.
    return n === 1 ? { method: 'absent', version: null } : { method: 'npm', version: '0.156.1' };
  };
  const executable = async (h, opts) => { executableCalls.push(opts); return { ok: true, detail: null }; };
  const collectHostFactsCalls = [];
  const r = await runHosts(
    { installState, executable },
    { collectHostFacts: async (opts) => collectHostFactsCalls.push(opts) },
  );
  assert.deepEqual(r.steps, ['install codex']);
  assert.equal(installStateCalls.length, 2, 'installState is called once to plan, once again to re-record after install');
  assert.deepEqual(installStateCalls[1], { refresh: true, record: true, source: 'sync' },
    'the re-probe forces a fresh read and persists it as this repair\'s own evidence');
  assert.equal(executableCalls.length, 1, 'the post-repair method is npm, so the launcher is re-probed too');
  assert.deepEqual(executableCalls[0], { refresh: true, record: true, source: 'sync' });
  assert.equal(collectHostFactsCalls.length, 1, 'host-setup facts are refreshed once after the loop, not per host');
  assert.deepEqual(collectHostFactsCalls[0], { cwd: undefined, cfg, refresh: true, record: true, source: 'sync' });
});

test('an install that stays npm-external after repair never re-probes the launcher', async () => {
  const executableCalls = [];
  let n = 0;
  const installState = async () => {
    n += 1;
    return n === 1 ? { method: 'npm', version: '0.1.0' } : { method: 'external', version: '0.2.0' };
  };
  const executable = async (h, opts) => { executableCalls.push(opts); return n === 1 ? { ok: false, detail: 'boom' } : { ok: true, detail: null }; };
  await runHosts({ installState, executable });
  // Only the PLAN-time executable probe (n===1, the one that decides a
  // repair is needed) — the post-repair re-probe is skipped because the
  // fresh method is no longer 'npm'.
  assert.equal(executableCalls.length, 1);
});

test('no repair, no re-record: an already-healthy host never calls collectHostFacts', async () => {
  const collectHostFactsCalls = [];
  await runHosts(
    {
      installState: async () => ({ method: 'npm', version: '0.156.1' }),
      executable: async () => ({ ok: true, detail: null }),
    },
    { collectHostFacts: async (opts) => collectHostFactsCalls.push(opts) },
  );
  assert.equal(collectHostFactsCalls.length, 0, 'nothing changed, so host-setup facts are not force-refreshed');
});
