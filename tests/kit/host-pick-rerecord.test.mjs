import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { sandboxHome, rmrf, writeKitConfig, offlineKitConfig } from './helpers/home-sandbox.mjs';

const home = sandboxHome('ak-host-pick-rerecord');
after(() => rmrf(home));
const host = await import('../../src/commands/x/host.mjs');
const cfg = { integrations: { hosts: { claude: false, codex: true, opencode: false } } };
const cwd = '/disposable-project';

for (const [name, initial, ok, expected] of [
  ['successful install', 'absent', true, 2],
  ['failed install', 'absent', false, 1],
  ['present host', 'external', true, 1],
]) {
  test(`host pick ${name} re-records only after success`, async () => {
    const states = [];
    const facts = [];
    const installs = [];
    await host.installPickAbsentHosts(cfg, cwd, {
      installState: async (_host, opts) => { states.push(opts); return { method: states.length === 1 ? initial : 'npm', version: '1.0.0' }; },
      install: async id => { installs.push(id); return { ok, detail: ok ? 'installed' : 'failed' }; },
      collectFacts: async opts => { facts.push(opts); },
    });
    assert.equal(states.length, expected);
    assert.deepEqual(installs, initial === 'absent' ? ['codex'] : []);
    if (expected === 2) {
      assert.deepEqual(states[1], { refresh: true, record: true, source: 'host-pick' });
      assert.deepEqual(facts, [{ cwd, cfg, refresh: true, record: true, source: 'host-pick' }]);
    } else assert.deepEqual(facts, []);
  });
}

test('disabled hosts do not probe, install, or record evidence', async () => {
  await host.installPickAbsentHosts({ integrations: { hosts: {} } }, cwd, {
    installState: async () => { throw new Error('disabled host probed'); },
    install: async () => { throw new Error('disabled host installed'); },
    collectFacts: async () => { throw new Error('disabled host recorded'); },
  });
});

test('host command dispatch passes the lifecycle to pick before installation', async () => {
  writeKitConfig(home, offlineKitConfig());
  const sentinel = new Error('injected host lifecycle reached');
  let calls = 0;
  await assert.rejects(host.run({
    flags: { host: 'codex', yes: true, 'aqe-provider': 'none' },
    positionals: ['pick'],
    pkgRoot: process.cwd(),
    deps: { hostLifecycle: {
      installState: async () => { calls++; throw sentinel; },
      install: async () => { throw new Error('installer reached'); },
      collectFacts: async () => { throw new Error('collector reached'); },
    } },
  }), error => error === sentinel);
  assert.equal(calls, 1);
});
