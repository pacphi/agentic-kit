import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/agentic-kit.mjs');

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-usage-cli-'));
  const cfg = path.join(home, '.config');
  const bin = path.join(home, 'bin');
  const sentinel = path.join(home, 'npm-was-called');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\nprintf called > "${sentinel}"\nexit 99\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'npm.cmd'), `@echo called>"${sentinel}"\r\nexit /b 99\r\n`);
  return { home, cfg, bin, sentinel };
}

function ak(args, sb, extra = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NO_COLOR: '1',
      HOME: sb.home,
      USERPROFILE: sb.home,
      XDG_CONFIG_HOME: sb.cfg,
      APPDATA: sb.cfg,
      PATH: `${sb.bin}${path.delimiter}${process.env.PATH ?? ''}`,
      OPENROUTER_MANAGEMENT_KEY: '',
      ...extra,
    },
  });
}

test('ak usage status is an offline cache read with no generic npm drift probe', () => {
  const sb = sandbox();
  const result = ak(['usage', 'status'], sb);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no local activity cache/i);
  assert.equal(fs.existsSync(sb.sentinel), false, 'offline status must never execute npm');
  fs.rmSync(sb.home, { recursive: true, force: true });
});

test('ak usage refresh openrouter requires the dedicated management key', () => {
  const sb = sandbox();
  const result = ak(['usage', 'refresh', 'openrouter'], sb, {
    OPENROUTER_API_KEY: 'inference-only-key',
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /OPENROUTER_MANAGEMENT_KEY is required/);
  assert.equal(result.stdout.includes('inference-only-key'), false);
  assert.equal(fs.existsSync(sb.sentinel), false, 'failure must not fall through to npm drift');
  fs.rmSync(sb.home, { recursive: true, force: true });
});

test('ak usage refresh openrouter --dry-run performs no network or writes', () => {
  const sb = sandbox();
  const result = ak(['usage', 'refresh', 'openrouter', '--dry-run', '--json'], sb, {
    OPENROUTER_MANAGEMENT_KEY: 'must-not-be-used',
  });
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.deepEqual(
    {
      dryRun: value.dryRun,
      action: value.action,
      provider: value.provider,
      network: value.network,
      writes: value.writes,
    },
    {
      dryRun: true,
      action: 'refresh',
      provider: 'openrouter',
      network: false,
      writes: false,
    },
  );
  assert.equal(fs.existsSync(path.join(sb.cfg, 'agentic-kit', 'openrouter-activity.json')), false);
  assert.equal(fs.existsSync(sb.sentinel), false);
  fs.rmSync(sb.home, { recursive: true, force: true });
});

test('ak usage rejects unsupported providers and actions', () => {
  const sb = sandbox();
  const result = ak(['usage', 'refresh', 'unknown'], sb);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /usage: ak usage status/);
  fs.rmSync(sb.home, { recursive: true, force: true });
});
