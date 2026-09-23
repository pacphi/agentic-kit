import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostExecutable } from '../../src/lib/providers.mjs';
import hostsSection from '../../src/commands/status/sections/hosts.mjs';

const codex = { id: 'codex', bin: 'codex', pkg: '@openai/codex' };
const brokenStderr = 'file:///x/codex.js:107\n  throw new Error(\n\nError: Missing optional dependency @openai/codex-darwin-arm64. Reinstall Codex: npm install -g @openai/codex@latest\n    at findCodexExecutable';

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

const cfg = { routing: { primaryHost: 'claude' }, integrations: { hosts: { claude: false, codex: true, opencode: false } } };
const facts = { hosts: { codex: { present: true } } };

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
