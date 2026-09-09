import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectClaudeBrainPlugin } from '../../src/lib/ruvnet-brain-plugin.mjs';
import { brainPluginRows } from '../../src/commands/status/sections/ruvnet-brain.mjs';

function fixture(t) {
  const claudeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-brain-plugin-'));
  t.after(() => fs.rmSync(claudeRoot, { recursive: true, force: true }));
  const payload = path.join(claudeRoot, 'plugins/cache/ruvnet-brain/ruvnet-brain/4.3.14');
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
  const record = { scope: 'user', version: '4.3.14', installPath: payload };
  const registry = (records) => write(path.join(claudeRoot, 'plugins/installed_plugins.json'),
    { plugins: { 'ruvnet-brain@ruvnet-brain': records } });
  registry([record]);
  write(path.join(claudeRoot, 'settings.json'), { enabledPlugins: { 'ruvnet-brain@ruvnet-brain': true } });
  write(path.join(payload, '.claude-plugin/plugin.json'), { name: 'ruvnet-brain', version: '4.3.14' });
  write(path.join(payload, 'commands/rvbc.md'), 'console');
  write(path.join(payload, 'hooks/hooks.json'), { hooks: {} });
  return { claudeRoot, payload, record, registry, write, inspect: () => inspectClaudeBrainPlugin({ claudeRoot }) };
}

test('Brain should observe the selected payload without asserting runtime health or prescribing sync', (t) => {
  const f = fixture(t);
  f.write(path.join(f.claudeRoot, 'plugins/marketplaces/ruvnet-brain/plugin/.claude-plugin/plugin.json'),
    { name: 'ruvnet-brain', version: '99.0.0' });
  const r = f.inspect();
  assert.equal(r.payloadVersion, '4.3.14');
  assert.deepEqual(r.issues, []);
  assert.equal(r.runtimeVerified, false);
  assert.equal(brainPluginRows(r)[0].fix, null);
});

test('Brain continuity requires the selected shim without claiming runtime execution', (t) => {
  const f = fixture(t);
  f.registry([{ ...f.record, version: '4.3.17' }]);
  f.write(path.join(f.payload, '.claude-plugin/plugin.json'), { name: 'ruvnet-brain', version: '4.3.17' });
  const entry = (matcher, action, timeout) => [{ matcher, hooks: [{ type: 'command',
    command: `node "\${CLAUDE_PLUGIN_ROOT}/scripts/hook-shim.mjs" ${action} || true`, timeout }] }];
  f.write(path.join(f.payload, 'hooks/hooks.json'), { hooks: {
    SessionStart: entry('startup|resume|clear|compact|fork', 'session-start', 5),
    Stop: entry('*', 'continuation-gate', 10),
  } });
  assert.equal(f.inspect().issues.length, 1, 'missing shim cannot pass');
  const shim = path.join(f.payload, 'scripts/hook-shim.mjs');
  f.write(shim, 'not executed');
  assert.deepEqual(f.inspect().issues, []);
  assert.equal(f.inspect().runtimeVerified, false);
  assert.equal(f.inspect().hookContract, '4.3.17-continuity');
  if (process.platform !== 'win32') {
    fs.unlinkSync(shim);
    fs.symlinkSync(path.join(f.payload, 'commands/rvbc.md'), shim);
    assert.equal(f.inspect().issues.length, 1, 'symlinked shim cannot pass');
  }
});

test('Brain should qualify the 4.3.18 continuity contract', (t) => {
  const f = fixture(t);
  f.registry([{ ...f.record, version: '4.3.18' }]);
  f.write(path.join(f.payload, '.claude-plugin/plugin.json'), { name: 'ruvnet-brain', version: '4.3.18' });
  const entry = (matcher, action, timeout) => [{ matcher, hooks: [{ type: 'command',
    command: `node "\${CLAUDE_PLUGIN_ROOT}/scripts/hook-shim.mjs" ${action} || true`, timeout }] }];
  f.write(path.join(f.payload, 'hooks/hooks.json'), { hooks: {
    SessionStart: entry('startup|resume|clear|compact|fork', 'session-start', 5),
    Stop: entry('*', 'continuation-gate', 10),
  } });
  f.write(path.join(f.payload, 'scripts/hook-shim.mjs'), 'not executed');

  const result = f.inspect();
  assert.deepEqual(result.issues, []);
  assert.equal(result.hookContract, '4.3.17-continuity');
});

test('Brain should qualify a future release with the exact continuity contract', (t) => {
  const f = fixture(t);
  f.registry([{ ...f.record, version: '4.3.19' }]);
  f.write(path.join(f.payload, '.claude-plugin/plugin.json'), { name: 'ruvnet-brain', version: '4.3.19' });
  const entry = (matcher, action, timeout) => [{ matcher, hooks: [{ type: 'command',
    command: `node "\${CLAUDE_PLUGIN_ROOT}/scripts/hook-shim.mjs" ${action} || true`, timeout }] }];
  f.write(path.join(f.payload, 'hooks/hooks.json'), { hooks: {
    SessionStart: entry('startup|resume|clear|compact|fork', 'session-start', 5),
    Stop: entry('*', 'continuation-gate', 10),
  } });
  f.write(path.join(f.payload, 'scripts/hook-shim.mjs'), 'not executed');

  assert.deepEqual(f.inspect().issues, []);
});

test('Brain should disclose both missing commands and retired hooks in a disabled old payload', (t) => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.payload, 'commands/rvbc.md'));
  f.write(path.join(f.payload, 'hooks/hooks.json'), { hooks: { SessionStart: [], UserPromptSubmit: [], PreToolUse: [] } });
  f.write(path.join(f.claudeRoot, 'settings.json'), { enabledPlugins: { 'ruvnet-brain@ruvnet-brain': false } });
  const r = f.inspect();
  assert.equal(r.enabled, false);
  assert.equal(r.issues.length, 2);
  assert.deepEqual(r.hookEvents, ['SessionStart', 'UserPromptSubmit', 'PreToolUse']);
  assert.match(brainPluginRows(r)[0].message, /disabled.*runtime unverified/);
});

test('Brain should reject ambiguous registrations and paths outside the managed cache', (t) => {
  const f = fixture(t);
  f.registry([f.record, f.record]);
  assert.equal(f.inspect().registration, 'invalid');
  for (const installPath of ['relative', f.claudeRoot]) {
    f.registry([{ ...f.record, installPath }]);
    assert.equal(f.inspect().registration, 'invalid');
  }
});

test('Brain should not claim retirement for an uninspected explicit hook declaration', (t) => {
  const f = fixture(t);
  for (const hooks of ['./other-hooks.json', { hooks: { SessionStart: [] } }]) {
    f.write(path.join(f.payload, '.claude-plugin/plugin.json'), { name: 'ruvnet-brain', version: '4.3.14', hooks });
    assert.match(f.inspect().issues.join(' '), /outside the verified retirement contract/);
  }
});

test('Brain should keep absent, malformed and unverified hook state distinct', (t) => {
  const f = fixture(t);
  f.registry([]);
  assert.equal(f.inspect().registration, 'invalid');
  f.registry([f.record]);
  f.write(path.join(f.payload, 'hooks/hooks.json'), { hooks: null });
  assert.match(f.inspect().issues.join(' '), /retirement is unverified/);
  f.write(path.join(f.claudeRoot, 'plugins/installed_plugins.json'), { plugins: {} });
  assert.equal(f.inspect().registration, 'absent');
  f.write(path.join(f.claudeRoot, 'plugins/installed_plugins.json'), {});
  assert.equal(f.inspect().registration, 'invalid');
});

test('Brain should honor CLAUDE_CONFIG_DIR without writing to its selected payload', (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(path.join(f.payload, 'hooks/hooks.json'));
  const prior = process.env.CLAUDE_CONFIG_DIR;
  try {
    process.env.CLAUDE_CONFIG_DIR = f.claudeRoot;
    assert.deepEqual(inspectClaudeBrainPlugin(), f.inspect());
    assert.deepEqual(fs.readFileSync(path.join(f.payload, 'hooks/hooks.json')), before);
  } finally {
    if (prior === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prior;
  }
});

test('Brain should refuse symlinked payload evidence', { skip: process.platform === 'win32' ? 'symlink privilege unavailable' : false }, (t) => {
  const f = fixture(t);
  const file = path.join(f.payload, 'hooks/hooks.json');
  const elsewhere = path.join(f.claudeRoot, 'external-hooks.json');
  f.write(elsewhere, { hooks: {} }); fs.unlinkSync(file); fs.symlinkSync(elsewhere, file);
  assert.match(f.inspect().issues.join(' '), /retirement is unverified/);
});
