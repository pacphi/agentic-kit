import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { sandboxHome, rmrf } from './helpers/home-sandbox.mjs';

const home = sandboxHome('ak-setup-host-rerecord');
after(() => rmrf(home));
const setup = await import('../../src/commands/setup.mjs');
const cfg = { integrations: { hosts: { claude: false, codex: true, opencode: false } } };

for (const [name, initial, ok, expected] of [
  ['successful install', 'absent', true, 2],
  ['failed install', 'absent', false, 1],
  ['present host', 'npm', true, 1],
]) {
  test(`${name} records fresh host facts only when installation succeeds`, async () => {
    const stateCalls = [];
    const facts = [];
    const installs = [];
    await setup.installEnabledAbsentHosts(cfg, { yes: true }, {
      installState: async (_host, opts) => { stateCalls.push(opts); return { method: stateCalls.length === 1 ? initial : 'npm', version: '1.0.0' }; },
      install: async id => { installs.push(id); return { ok, detail: ok ? 'installed' : 'failed' }; },
      collectFacts: async opts => { facts.push(opts); },
    });
    assert.equal(stateCalls.length, expected);
    assert.deepEqual(installs, initial === 'absent' ? ['codex'] : []);
    if (expected === 2) {
      assert.deepEqual(stateCalls[1], { refresh: true, record: true, source: 'setup' });
      assert.deepEqual(facts, [{ cfg, refresh: true, record: true, source: 'setup' }]);
    } else assert.deepEqual(facts, []);
  });
}

test('disabled hosts do not probe, install, or record evidence', async () => {
  await setup.installEnabledAbsentHosts({ integrations: { hosts: {} } }, { yes: true }, {
    installState: async () => { throw new Error('disabled host probed'); },
    install: async () => { throw new Error('disabled host installed'); },
    collectFacts: async () => { throw new Error('disabled host recorded'); },
  });
});

test('setup run passes its host lifecycle through the machine setup boundary', async () => {
  const lifecycle = { installState: async () => { throw new Error('sentinel'); } };
  let received;
  await setup.run({
    flags: { 'dry-run': true, minimal: true, 'no-aqe': true, 'no-ruvnet-brain': true, 'no-agent-browser': true, yes: true },
    pkgRoot: process.cwd(),
    deps: { hostLifecycle: lifecycle },
    machineSetup: async args => { received = args.deps?.hostLifecycle; return false; },
  });
  assert.equal(received, lifecycle);
});
