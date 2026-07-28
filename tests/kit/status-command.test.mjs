// `ak status` — the read-only collector that every other command's plan is
// built from. Two things must hold: it never writes (it is the one command
// users run to look before they leap), and each row's `fix` field is present
// exactly when `ak sync` should act — a stray `fix` on a row the user
// deliberately disabled makes sync heal something they turned off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sandboxHome, assertSandboxed, snapshot, assertUnchanged, captureLog, rmrf,
  sandboxProject, writeKitConfig, offlineKitConfig, fakeGlobalRoot,
} from './helpers/home-sandbox.mjs';

const HOME = sandboxHome('ak-status');
const paths = await import('../../src/lib/paths.mjs');
const status = await import('../../src/commands/status.mjs');
assertSandboxed(paths, HOME);

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROJECT = sandboxProject('ak-status');

// Pin the npm global root at a fixture tree so version/native probes are
// hermetic (the real one would make these tests depend on what this machine
// happens to have installed globally).
paths._setGlobalRootForTest(fakeGlobalRoot(HOME, { ruflo: '9.9.9', 'agentic-qe': '9.9.9' }));

function seedHome(cfg = offlineKitConfig()) {
  rmrf(paths.claudeDir(), paths.configDir());
  fs.mkdirSync(paths.claudeDir(), { recursive: true });
  fs.writeFileSync(paths.claudeMdPath(), '# machine notes\n');
  writeKitConfig(HOME, cfg);
}

const collect = () => status.collect({ pkgRoot: PKG_ROOT, cwd: PROJECT });
const rowsFor = (rows, subsystem) => rows.filter((r) => r.subsystem === subsystem);
const one = (rows, subsystem) => {
  const hit = rowsFor(rows, subsystem);
  assert.ok(hit.length >= 1, `expected at least one '${subsystem}' row, got ${rows.map((r) => r.subsystem)}`);
  return hit[0];
};

test('collect() writes nothing to HOME or the project', async () => {
  seedHome();
  const beforeHome = snapshot(HOME);
  const beforeProject = snapshot(PROJECT);
  await collect();
  assertUnchanged(beforeHome, HOME, '`ak status` must be strictly read-only (HOME)');
  assertUnchanged(beforeProject, PROJECT, '`ak status` must be strictly read-only (project)');
});

test('every row carries the documented shape', async () => {
  seedHome();
  const rows = await collect();
  assert.ok(rows.length > 0, 'status always reports something');
  for (const r of rows) {
    assert.equal(typeof r.subsystem, 'string');
    assert.ok(['ok', 'warn', 'fail', 'info'].includes(r.level), `bad level: ${r.level}`);
    assert.equal(typeof r.message, 'string');
    assert.ok(r.fix === null || typeof r.fix === 'string');
    assert.ok(r.level !== 'ok' || r.fix === null, `an 'ok' row must never plan a fix: ${r.message}`);
    assert.ok(r.level !== 'info' || r.fix === null, `an 'info' row must never plan a fix: ${r.message}`);
  }
});

test('a missing global ruflo is a FAIL with a fix; a present one is ok', async () => {
  seedHome();
  const withRuflo = await collect();
  assert.equal(rowsFor(withRuflo, 'versions').find((r) => r.message.startsWith('ruflo')).level, 'ok');

  paths._setGlobalRootForTest(fakeGlobalRoot(HOME, {}));
  const without = await collect();
  const ruflo = rowsFor(without, 'versions').find((r) => r.message.includes('ruflo'));
  assert.equal(ruflo.level, 'fail', 'ruflo is the load-bearing dependency — its absence fails the check');
  assert.ok(ruflo.fix, 'a failing row must tell sync what to do');
  paths._setGlobalRootForTest(fakeGlobalRoot(HOME, { ruflo: '9.9.9', 'agentic-qe': '9.9.9' }));
});

test('a missing agentic-qe is only a WARN (it is optional)', async () => {
  seedHome();
  paths._setGlobalRootForTest(fakeGlobalRoot(HOME, { ruflo: '9.9.9' }));
  const rows = await collect();
  const aqe = rowsFor(rows, 'versions').find((r) => r.message.includes('agentic-qe'));
  assert.equal(aqe.level, 'warn');
  paths._setGlobalRootForTest(fakeGlobalRoot(HOME, { ruflo: '9.9.9', 'agentic-qe': '9.9.9' }));
});

// kit.json's opt-outs were once write-only: documented, persisted, read by
// nothing. Each must produce an INFO row with NO fix, so sync never re-heals
// a surface the user deliberately switched off.
for (const [key, value, subsystem, needle] of [
  ['security', false, 'security', /disabled/i],
  ['agentdb', false, 'agentdb', /disabled/i],
]) {
  test(`kit.json ${key}:${value} yields an info row that sync will never act on`, async () => {
    seedHome(offlineKitConfig({ [key]: value }));
    const row = one(await collect(), subsystem);
    assert.equal(row.level, 'info');
    assert.match(row.message, needle);
    assert.equal(row.fix, null, `a disabled subsystem must not be planned by sync`);
  });
}

test('mcp.register:false yields an info row; the default yields an actionable warn', async () => {
  seedHome(offlineKitConfig({ mcp: { register: false, excludeFamilies: [] } }));
  const off = one(await collect(), 'mcp');
  assert.equal(off.level, 'info');
  assert.equal(off.fix, null);

  seedHome();
  const on = one(await collect(), 'mcp');
  assert.equal(on.level, 'warn', 'unregistered MCP with registration enabled is drift');
  assert.ok(on.fix);
});

test('a legacy ruflo-keyed MCP registration is reported as migratable drift', async () => {
  seedHome();
  fs.writeFileSync(paths.claudeUserMcpPath(),
    JSON.stringify({ mcpServers: { ruflo: { command: 'ruflo' } } }));
  const rows = rowsFor(await collect(), 'mcp');
  const legacy = rows.find((r) => r.message.includes('legacy'));
  assert.ok(legacy, 'a legacy registration must surface');
  assert.match(legacy.fix, /migrates it to claude-flow/);
  fs.rmSync(paths.claudeUserMcpPath(), { force: true });
});

test('a registered claude-flow MCP reports ok with the deny-rule count', async () => {
  seedHome();
  fs.writeFileSync(paths.claudeUserMcpPath(),
    JSON.stringify({ mcpServers: { 'claude-flow': { command: 'ruflo' } } }));
  fs.writeFileSync(paths.claudeSettingsPath(), JSON.stringify({
    permissions: { deny: ['mcp__claude-flow__wasm_agent_create', 'Read(./.env)'] },
  }));
  const row = one(await collect(), 'mcp');
  assert.equal(row.level, 'ok');
  assert.match(row.message, /1 tool\(s\) denied/);
  fs.rmSync(paths.claudeUserMcpPath(), { force: true });
});

test('project-scope rows degrade to info in a project that was never set up', async () => {
  seedHome();
  const rows = await collect();
  assert.equal(one(rows, 'learning').level, 'info');
  assert.equal(one(rows, 'aqe').level, 'info');
  assert.equal(one(rows, 'statusline').level, 'info');
});

test('an initialized project reports its learned-pattern count', async () => {
  seedHome();
  const neural = path.join(paths.projectClaudeFlowDir(PROJECT), 'neural');
  fs.mkdirSync(neural, { recursive: true });
  fs.writeFileSync(path.join(neural, 'stats.json'),
    JSON.stringify({ patternsLearned: 7, trajectoriesRecorded: 3 }));
  const row = one(await collect(), 'learning');
  assert.equal(row.level, 'ok');
  assert.match(row.message, /7 patterns learned, 3 trajectories/);
  rmrf(paths.projectClaudeFlowDir(PROJECT));
});

test('run() --json emits a parseable report and exits 0 unless something failed', async () => {
  seedHome();
  const cwd = process.cwd();
  process.chdir(PROJECT);
  let parsed; let code;
  try {
    const r = await captureLog(() => status.run({ flags: { json: true }, pkgRoot: PKG_ROOT }));
    code = r.result;
    parsed = JSON.parse(r.out);
  } finally { process.chdir(cwd); }
  assert.ok(Array.isArray(parsed.rows) && parsed.rows.length > 0);
  assert.ok(['ok', 'warn', 'fail'].includes(parsed.overall));
  assert.equal(code, parsed.overall === 'fail' ? 1 : 0, 'exit code tracks the worst level');
});

test('run() --hint prints exactly one suggested next action', async () => {
  seedHome();
  const cwd = process.cwd();
  process.chdir(PROJECT);
  try {
    const { out } = await captureLog(() => status.run({ flags: { hint: true }, pkgRoot: PKG_ROOT }));
    const hints = out.split('\n').filter((l) => /need attention — run|all healthy — nothing to do/.test(l));
    assert.equal(hints.length, 1, `expected one hint line, got: ${hints}`);
  } finally { process.chdir(cwd); }
});

test('run() without --hint suggests nothing (bare rows only)', async () => {
  seedHome();
  const cwd = process.cwd();
  process.chdir(PROJECT);
  try {
    const { out } = await captureLog(() => status.run({ flags: {}, pkgRoot: PKG_ROOT }));
    assert.ok(!/need attention — run/.test(out));
    assert.match(out, /ak status/);
  } finally { process.chdir(cwd); }
});

test('a corrupt kit.json degrades to defaults instead of throwing', async () => {
  seedHome();
  fs.writeFileSync(paths.kitConfigPath(), '{ this is not json');
  const rows = await collect();
  assert.ok(rows.length > 0, 'status still reports on an unreadable config');
});

test.after(() => rmrf(HOME, PROJECT));
