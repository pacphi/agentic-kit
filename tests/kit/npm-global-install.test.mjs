import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  REVIEWED_GLOBAL_INSTALL_SCRIPTS, globalInstallArgs,
} from '../../src/lib/npm-global-install.mjs';
import { installHost } from '../../src/lib/providers.mjs';
import { selfUpdate } from '../../src/lib/heal.mjs';

test('reviewed global lifecycle policy includes Claude Code postinstall', () => {
  assert.ok(REVIEWED_GLOBAL_INSTALL_SCRIPTS.includes('@anthropic-ai/claude-code'));
  assert.ok(REVIEWED_GLOBAL_INSTALL_SCRIPTS.includes('opencode-ai'));
  assert.deepEqual(globalInstallArgs('@anthropic-ai/claude-code@latest'), [
    'install', '-g',
    `--allow-scripts=${REVIEWED_GLOBAL_INSTALL_SCRIPTS.join(',')}`,
    '@anthropic-ai/claude-code@latest',
  ]);
});

test('initial host install uses the same reviewed lifecycle policy and verifies the CLI', async () => {
  const calls = [];
  const result = await installHost('claude', {
    runner: async (bin, args, options) => {
      calls.push({ bin, args, options });
      return args[0] === 'install'
        ? { code: 0, stdout: '', stderr: '' }
        : { code: 0, stdout: '2.1.258\n', stderr: '' };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].bin, 'npm');
  assert.deepEqual(calls[0].args, globalInstallArgs('@anthropic-ai/claude-code@latest'));
  assert.deepEqual(calls[1].args, ['--version']);
});

test('npm success is not reported as a usable host when the installed CLI cannot start', async () => {
  const result = await installHost('claude', {
    runner: async (_bin, args) => args[0] === 'install'
      ? { code: 0, stdout: '', stderr: '' }
      : { code: 1, stdout: '', stderr: 'postinstall did not materialize the executable' },
  });

  assert.equal(result.ok, false);
  assert.equal(result.changed, true);
  assert.match(result.detail, /installed package but claude --version failed/i);
});

test('the kit self-update uses the same reviewed lifecycle policy', async () => {
  const calls = [];
  const result = await selfUpdate('4.2.0', {
    runner: async (bin, args, options) => {
      calls.push({ bin, args, options });
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0].args, globalInstallArgs('@pacphi/agentic-kit@4.2.0'));
});
