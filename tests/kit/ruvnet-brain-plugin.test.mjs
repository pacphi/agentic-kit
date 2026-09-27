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

// Decision 4 of the 2026-09-26 audit: the 4.3.28 warning was permanent and said
// neither what changed nor what the user could do. It stays a warning with no
// sync action (no 4.3.28 contract), but names the added hook, and its options are
// a manual fix (P5, Branch 0 real-machine pass): tagged manual on Overview and
// About, and counted by the bare `ak` hint.
test('an unreviewed Brain hook delta names the hook and gives the user options as a manual fix, never a sync action', (t) => {
  const f = fixture(t);
  f.registry([{ ...f.record, version: '4.3.28' }]);
  f.write(path.join(f.payload, '.claude-plugin/plugin.json'), { name: 'ruvnet-brain', version: '4.3.28' });
  const shim = (action, timeout, tail = ' || true') => ({ type: 'command',
    command: `node "\${CLAUDE_PLUGIN_ROOT}/scripts/hook-shim.mjs" ${action}${tail}`, timeout });
  f.write(path.join(f.payload, 'hooks/hooks.json'), { hooks: {
    SessionStart: [{ matcher: 'startup|resume|clear|compact|fork', hooks: [shim('session-start', 5)] }],
    UserPromptSubmit: [{ matcher: '*', hooks: [shim('unprompted-speech UserPromptSubmit', 3, ''),
      shim('ground-ruvnet', 10), shim('capacity-aware-parallel-work', 2), shim('grounding-turn-mark', 5)] }],
    PreToolUse: [{ matcher: '^(Write|Edit|MultiEdit|NotebookEdit|apply_patch)$', hooks: [shim('decision-gate write', 5, '')] }],
    PostToolUse: [{ matcher: '^(?:.*__)?search_ruvnet$', hooks: [shim('grounding-stamp', 5)] }],
    Stop: [{ matcher: '*', hooks: [shim('continuation-gate', 10), shim('session-snapshot Stop', 10),
      shim('grounding-turn-gate', 10)] }],
    PreCompact: [{ matcher: '*', hooks: [shim('session-snapshot PreCompact', 10)] }],
    SessionEnd: [{ matcher: '*', hooks: [shim('session-snapshot SessionEnd', 10)] }],
  } });
  const [row] = brainPluginRows(f.inspect());
  assert.equal(row.level, 'warn');
  assert.equal(row.repair, 'manual', 'ak sync cannot review a hook, so it must never plan this row');
  assert.match(row.message, /adds UserPromptSubmit capacity-aware-parallel-work/);
  assert.match(row.message, /until an ak release reviews the change/);
  assert.match(row.fix, /claude plugin disable ruvnet-brain@ruvnet-brain/);
  assert.match(row.fix, /"ruvnetBrain": false/);
  assert.doesNotMatch(row.message, /claude plugin disable/, 'the options live in the fix, not twice');
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
