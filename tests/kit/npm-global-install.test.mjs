import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  REVIEWED_GLOBAL_INSTALL_SCRIPTS, globalInstallArgs, installGlobalCli,
} from '../../src/lib/npm-global-install.mjs';
import { installHost } from '../../src/lib/providers.mjs';
import { selfUpdate, upgradePackage } from '../../src/lib/heal.mjs';

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
  const result = await installHost('claude', { sleep: async () => {},
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

// npm exits 0 after silently dropping a failed optional dependency — how codex
// lost @openai/codex-darwin-arm64 when a sync upgrade landed minutes after
// OpenAI's staggered per-platform publish. One revalidating retry repairs it.
const missingPlatform = { code: 1, stdout: '', stderr: 'Error: Missing optional dependency @openai/codex-darwin-arm64. Reinstall Codex' };
const noSleep = async () => {};

test('a CLI left non-executable is reinstalled once with --prefer-online', async () => {
  const calls = [];
  let versionChecks = 0;
  const result = await installGlobalCli('@openai/codex@latest', 'codex', { sleep: noSleep,
    runner: async (bin, args) => {
      calls.push([bin, ...args]);
      if (bin === 'npm') return { code: 0, stdout: '', stderr: '' };
      return ++versionChecks === 1 ? missingPlatform : { code: 0, stdout: 'codex-cli 0.156.1\n', stderr: '' };
    } });
  assert.equal(result.ok, true);
  assert.equal(result.retried, true);
  assert.deepEqual(calls.map((c) => c[0]), ['npm', 'codex', 'npm', 'codex']);
  assert.deepEqual(calls[2].slice(1), globalInstallArgs('@openai/codex@latest', { preferOnline: true }));
  assert.ok(calls[2].includes('--prefer-online'));
});

test('a CLI that still cannot start after the retry is a failure with the real error line', async () => {
  const result = await installGlobalCli('@openai/codex@latest', 'codex', { sleep: noSleep,
    runner: async (bin) => (bin === 'npm' ? { code: 0, stdout: '', stderr: '' } : missingPlatform) });
  assert.equal(result.ok, false);
  assert.equal(result.changed, true);
  assert.match(result.detail, /codex --version failed.*Missing optional dependency @openai\/codex-darwin-arm64/);
});

test('an executable CLI is verified once, without a retry', async () => {
  const calls = [];
  const result = await installGlobalCli('@openai/codex@latest', 'codex', { sleep: noSleep,
    runner: async (bin, args) => { calls.push([bin, ...args]); return { code: 0, stdout: '0.156.1', stderr: '' }; } });
  assert.equal(result.ok, true);
  assert.equal(result.retried, false);
  assert.equal(calls.length, 2);
});

test('upgradePackage verifies a host CLI instead of trusting npm exit 0', async () => {
  const result = await upgradePackage('@openai/codex', { bin: 'codex', sleep: noSleep,
    runner: async (bin) => (bin === 'npm' ? { code: 0, stdout: '', stderr: '' } : missingPlatform) });
  assert.equal(result.ok, false);
  assert.match(result.detail, /Missing optional dependency/);
});
