import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { sandboxHome, rmrf } from './helpers/home-sandbox.mjs';
import { isolateProject, REPO_ROOT } from './helpers/project-isolation.mjs';

const home = sandboxHome('ak-setup-host-rerecord');
after(() => rmrf(home));
isolateProject('ak-setup-host-rerecord');
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
    pkgRoot: REPO_ROOT,
    deps: { hostLifecycle: lifecycle },
    machineSetup: async args => { received = args.deps?.hostLifecycle; return false; },
  });
  assert.equal(received, lifecycle);
});

test('real run_machine passes injected lifecycle to the host installation loop', async () => {
  const stubs = new Map([
    ['../lib/versions.mjs', "export const installedVersion = () => '3.48.0'; export const cmpVersions = () => 0;"],
    ['../lib/heal.mjs', "export const healNatives = async () => ({ ok: true, detail: 'stub' }); export const healAidefence = async () => ({ ok: true, detail: 'stub' });"],
    ['../lib/exec.mjs', "export const have = async () => false; export const run = async () => { throw Error('real command reached'); };"],
    ['../lib/providers.mjs', `
      export const HOSTS = [{ id: 'codex', pkg: '@openai/codex' }];
      export const hostInstallState = async () => { throw Error('default host probe reached'); };
      export const installHost = async () => { throw Error('default installer reached'); };
      export const collectIntegrationFacts = async () => { throw Error('default facts collector reached'); };
      export const migrateRetiredRoutesInConfig = () => {};
      export const printActivityRoutingTable = () => {};
      export const convergeProviderStack = () => {};
      export const applySetupHostFlags = () => {};
      export const guidanceContext = () => {};
      export const reportRetiredRouteChanges = () => {};
    `],
    ['../lib/adapters/lifecycle-registry.mjs', `
      export const hostsWithLifecycle = () => [];
      export const lifecycleAdapterFor = () => { throw Error('host lifecycle reached'); };
      export const lifecycleExecutionEnabled = () => false;
      export const detectionBinFor = () => { throw Error('host lifecycle reached'); };
    `],
    ['../lib/ruflo-components/apply.mjs', "export const reconcileRufloComponents = async () => { throw Error('components reached'); };"],
    ['./status/sections/ruflo-components.mjs', "export const componentResultReport = () => [];"],
  ]);
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL?.includes('/src/commands/setup.mjs?b2-machine') && stubs.has(specifier)) {
        return { url: `data:text/javascript,${encodeURIComponent(stubs.get(specifier))}`, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
  const isolatedSetup = await import('../../src/commands/setup.mjs?b2-machine');
  const sentinel = new Error('injected host lifecycle reached');
  const machineCfg = {
    agentBrowser: false, aqe: false, ruvnetBrain: false, security: false,
    integrations: { hosts: { codex: true } },
  };
  let calls = 0;
  await assert.rejects(isolatedSetup.run_machine({
    flags: { yes: true }, cfg: machineCfg, pkgRoot: home,
    deps: { hostLifecycle: {
      installState: async () => { calls++; throw sentinel; },
      install: async () => { throw Error('injected installer reached'); },
      collectFacts: async () => { throw Error('injected facts reached'); },
    } },
  }), error => error === sentinel);
  assert.equal(calls, 1);
});
