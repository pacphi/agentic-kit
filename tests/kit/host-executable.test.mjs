import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { hostExecutable } from '../../src/lib/providers.mjs';
import hostsSection from '../../src/commands/status/sections/hosts.mjs';
import { evidenceDir, writeEvidence, stableInputsKey } from '../../src/lib/evidence.mjs';
import { tempDir } from './helpers/temp-dir.mjs';

process.env.XDG_STATE_HOME = tempDir('ak-host-executable-state');
process.env.LOCALAPPDATA = process.env.XDG_STATE_HOME;
const resetEvidence = () => fs.rmSync(evidenceDir(), { recursive: true, force: true });

const codex = { id: 'codex', bin: 'codex', pkg: '@openai/codex' };
const brokenStderr = 'file:///x/codex.js:107\n  throw new Error(\n\nError: Missing optional dependency @openai/codex-darwin-arm64. Reinstall Codex: npm install -g @openai/codex@latest\n    at findCodexExecutable';
const hostLaunchKey = (host) => stableInputsKey({ id: host.id, bin: host.bin, pkg: host.pkg, PATH: process.env.PATH ?? '' });

test('hostExecutable reports a launcher that cannot start and surfaces the Error line', async () => {
  const r = await hostExecutable(codex, { runner: async () => ({ code: 1, stdout: '', stderr: brokenStderr }) });
  assert.equal(r.ok, false);
  assert.match(r.detail, /^Error: Missing optional dependency @openai\/codex-darwin-arm64/);
});

test('hostExecutable accepts a launcher that answers --version', async () => {
  const calls = [];
  const r = await hostExecutable(codex, { runner: async (bin, args) => { calls.push([bin, ...args]); return { code: 0, stdout: 'codex-cli 0.156.1\n', stderr: '' }; } });
  assert.deepEqual(r, { ok: true, detail: null });
  assert.deepEqual(calls, [['codex', '--version']]);
});

// ── hostExecutable refresh caching (Branch 6a Task 5) ───────────────────────
// `runner` is injectable, so these prove zero-spawn directly instead of
// needing the broken-PATH trick tests/kit/host-setup-evidence.test.mjs uses
// for the non-injectable have()/hostVersion() probes.

test('hostExecutable({ refresh: false }) reuses fresh cached evidence and never calls the runner', async () => {
  resetEvidence();
  writeEvidence('host-launch', codex.id, {
    source: 'test', inputsKey: hostLaunchKey(codex),
    inputs: { PATH: process.env.PATH ?? '', bin: codex.bin },
    result: { ok: true, detail: null },
  });
  let called = false;
  const r = await hostExecutable(codex, { refresh: false, runner: async () => { called = true; return { code: 1, stdout: '', stderr: '' }; } });
  assert.equal(called, false, 'fresh, matching cached evidence: runner must never be called');
  assert.deepEqual(r, { ok: true, detail: null });
  resetEvidence();
});

test('hostExecutable({ refresh: true }) always calls the runner, ignoring fresh cached evidence', async () => {
  resetEvidence();
  writeEvidence('host-launch', codex.id, {
    source: 'test', inputsKey: hostLaunchKey(codex),
    inputs: { PATH: process.env.PATH ?? '', bin: codex.bin },
    result: { ok: true, detail: null },
  });
  let called = false;
  const r = await hostExecutable(codex, { refresh: true, runner: async () => { called = true; return { code: 0, stdout: 'codex-cli 0.156.1\n', stderr: '' }; } });
  assert.equal(called, true, 'refresh:true must always probe');
  assert.deepEqual(r, { ok: true, detail: null });
  resetEvidence();
});

test('hostExecutable({ refresh: false }) calls the runner when there is no cached evidence yet (first run)', async () => {
  resetEvidence();
  let called = false;
  await hostExecutable(codex, { refresh: false, runner: async () => { called = true; return { code: 0, stdout: 'codex-cli 0.156.1\n', stderr: '' }; } });
  assert.equal(called, true, 'no cached evidence at all: must probe');
  resetEvidence();
});

test('hostExecutable({ refresh: false }) re-probes when cached evidence is older than 6h', async () => {
  resetEvidence();
  writeEvidence('host-launch', codex.id, {
    source: 'test', inputsKey: hostLaunchKey(codex),
    inputs: { PATH: process.env.PATH ?? '', bin: codex.bin },
    result: { ok: true, detail: null },
  }, { now: Date.now() - 7 * 3600_000 });
  let called = false;
  await hostExecutable(codex, { refresh: false, runner: async () => { called = true; return { code: 0, stdout: '', stderr: '' }; } });
  assert.equal(called, true, 'evidence older than the 6h window must not suppress the probe');
  resetEvidence();
});

test('hostExecutable({ refresh: false }) re-probes when PATH changed (invalidated inputsKey)', async () => {
  resetEvidence();
  writeEvidence('host-launch', codex.id, {
    source: 'test',
    inputsKey: stableInputsKey({ id: codex.id, bin: codex.bin, pkg: codex.pkg, PATH: 'a-completely-different-path-string' }),
    inputs: { PATH: 'a-completely-different-path-string', bin: codex.bin },
    result: { ok: true, detail: null },
  });
  let called = false;
  await hostExecutable(codex, { refresh: false, runner: async () => { called = true; return { code: 0, stdout: '', stderr: '' }; } });
  assert.equal(called, true, 'a changed PATH invalidates the cached inputsKey');
  resetEvidence();
});

const cfg = { routing: { primaryHost: 'claude' }, integrations: { hosts: { claude: false, codex: true, opencode: false } } };
const facts = { hosts: { codex: { present: true } } };

test('hosts status section threads refresh into both installState and executable deps', async () => {
  const calls = [];
  await hostsSection.collect({
    cfg, integrationFacts: facts, refresh: true, hostDeps: {
      installState: async (h, opts) => { calls.push(['installState', h.id, opts]); return { method: 'npm', version: '0.156.1' }; },
      executable: async (h, opts) => { calls.push(['executable', h.id, opts]); return { ok: true, detail: null }; },
      authState: () => ({ mode: 'oauth', billing: 'subscription', source: null, note: null }),
    },
  });
  assert.deepEqual(calls, [
    ['installState', 'codex', { refresh: true, record: true }],
    ['executable', 'codex', { refresh: true, record: true }],
  ]);
});

test('hosts status section defaults refresh to false when the caller omits it', async () => {
  const calls = [];
  await hostsSection.collect({
    cfg, integrationFacts: facts, hostDeps: {
      installState: async (h, opts) => { calls.push(opts); return { method: 'npm', version: '0.156.1' }; },
      executable: async (h, opts) => { calls.push(opts); return { ok: true, detail: null }; },
      authState: () => ({ mode: 'oauth', billing: 'subscription', source: null, note: null }),
    },
  });
  assert.deepEqual(calls, [{ refresh: false, record: true }, { refresh: false, record: true }]);
});

test('hosts status fails a recorded npm install whose binary cannot start', async () => {
  const rows = await hostsSection.collect({ cfg, integrationFacts: facts, hostDeps: {
    installState: async () => ({ method: 'npm', version: '0.156.1' }),
    executable: async () => ({ ok: false, detail: 'Error: Missing optional dependency @openai/codex-darwin-arm64.' }),
    authState: () => ({ mode: 'oauth', billing: 'subscription', source: '~/.codex/auth.json', note: null }),
  } });
  const install = rows.find((r) => r.message.startsWith('codex 0.156.1'));
  assert.equal(install.level, 'warn');
  assert.match(install.message, /not executable.*Missing optional dependency/);
  assert.equal(install.fix, 'sync reinstalls @openai/codex');
});

test('hosts status stays ok when the npm install starts', async () => {
  const rows = await hostsSection.collect({ cfg, integrationFacts: facts, hostDeps: {
    installState: async () => ({ method: 'npm', version: '0.156.1' }),
    executable: async () => ({ ok: true, detail: null }),
    authState: () => ({ mode: 'oauth', billing: 'subscription', source: null, note: null }),
  } });
  assert.equal(rows.find((r) => r.message.startsWith('codex 0.156.1')).level, 'ok');
});
