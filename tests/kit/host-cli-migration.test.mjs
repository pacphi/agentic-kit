import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/agentic-kit.mjs');

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-host-cli-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-host-project-'));
  fs.mkdirSync(path.join(project, '.git'));
  const config = path.join(home, '.config');
  return {
    home,
    project,
    env: {
      ...process.env,
      NO_COLOR: '1',
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: config,
      APPDATA: config,
      PATH: path.join(home, 'no-such-bin'),
    },
  };
}

function ak(sb, ...args) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: sb.project,
    env: sb.env,
    encoding: 'utf8',
  });
}

const output = (result) => `${result.stdout}\n${result.stderr}`;

test('top-level ak host is the canonical management command', () => {
  const sb = sandbox();
  const result = ak(sb, 'host', '--help');
  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /^ak host — /);
  assert.match(result.stdout, /status\s+\(default\)/);
  assert.match(result.stdout, /pick\s+/);
  assert.match(result.stdout, /refresh\s+/);
  assert.match(result.stdout, /off\s+/);
  assert.doesNotMatch(output(result), /deprecated/i);
});

test('ak host status dispatches the existing read-only status semantics', () => {
  const sb = sandbox();
  const result = ak(sb, 'host', 'status', '--json');
  assert.equal(result.status, 0, output(result));
  const payload = JSON.parse(result.stdout);
  assert.equal(typeof payload.hosts, 'object');
  assert.equal(typeof payload.providers, 'object',
    'host management retains the existing host/provider fact payload during migration');
});

test('ak host preserves pick option parsing without performing an interactive run', () => {
  const sb = sandbox();
  const result = ak(sb, 'host', 'pick', '--help');
  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /--host claude,codex/);
  assert.match(result.stdout, /--primary-host claude\|codex/);
  assert.match(result.stdout, /--aqe-provider/);
  assert.match(result.stdout, /--provider <csv>/);
});

test('legacy top-level ak provider remains a functional deprecation shim', () => {
  const sb = sandbox();
  const result = ak(sb, 'provider', '--help');
  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /status\s+\(default\)/);
  assert.match(output(result), /ak provider is deprecated/i);
  assert.match(output(result), /use `?ak host`?/i);
  assert.match(output(result), /removed before (?:the )?stable release/i);
});

test('legacy provider shim delegates status and warns exactly once', () => {
  const sb = sandbox();
  const result = ak(sb, 'provider', 'status', '--json');
  assert.equal(result.status, 0, output(result));
  assert.doesNotThrow(() => JSON.parse(result.stdout));
  const warnings = output(result).match(/ak provider is deprecated/gi) ?? [];
  assert.equal(warnings.length, 1);
});

test('plumbing host and provider aliases remain available during migration', () => {
  const sb = sandbox();
  for (const name of ['host', 'provider']) {
    const result = ak(sb, 'x', name, '--help');
    assert.equal(result.status, 0, `${name}\n${output(result)}`);
    assert.match(result.stdout, /status\s+\(default\)/);
  }
});

test('top-level help advertises host canonically and labels provider deprecated', () => {
  const sb = sandbox();
  const result = ak(sb, '--help');
  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /^\s+ak host\s+/m);
  assert.match(result.stdout, /^\s+ak provider\s+.*deprecated/im);
  assert.ok(result.stdout.indexOf('ak host') < result.stdout.indexOf('ak provider'),
    'canonical host command should be listed before its legacy shim');
});

test('plumbing index advertises x host canonically and marks x provider deprecated', () => {
  const sb = sandbox();
  const result = ak(sb, '--help', '--all');
  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /^\s+ak x host\s+/m);
  assert.match(result.stdout, /^\s+ak x provider\s+.*deprecated/im);
});
