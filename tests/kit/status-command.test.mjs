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
const { loadKitConfig } = await import('../../src/lib/config.mjs');
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

test('owned Codex statusline reports independently without enabling Codex MCP routing', async () => {
  const preset = [
    'model-with-reasoning', 'project-name', 'git-branch', 'run-state',
    'context-remaining', 'five-hour-limit', 'weekly-limit', 'task-progress',
  ];
  seedHome(offlineKitConfig({
    providers: { hosts: { claude: true, codex: false } },
    statusline: {
      codex: {
        preset: 'native',
        lastProjection: { status_line_use_colors: true, status_line: preset },
      },
    },
  }));
  fs.mkdirSync(paths.codexDir(), { recursive: true });
  fs.writeFileSync(paths.codexConfigPath(),
    `[tui]\nstatus_line_use_colors = true\nstatus_line = ${JSON.stringify(preset)}\n`);
  const rows = await collect();
  assert.equal(one(rows, 'codex-statusline').level, 'ok');
  assert.equal(rowsFor(rows, 'codex-mcp').length, 0,
    'statusline ownership must not imply Codex is enabled as a routed host');
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

// Regression: dbPathPinStatus() was called with settingsLocalFile/projectRoot
// built from process.cwd() instead of the `cwd` param collect() received.
// Harmless when ak status runs from a project's own root (the two coincide),
// but collect({ cwd }) is called with a NON-cwd path elsewhere (the dashboard
// does exactly this) — the memory-pin row then described process.cwd()'s
// pin, not the target project's. This test's own PROJECT sandbox is a
// different directory from process.cwd() (the real repo checkout running
// this suite), so it fails under the old code even without a dashboard.
test('the memory-pin row reads the TARGET project (cwd param), not process.cwd()', async () => {
  seedHome();
  const pinned = path.join(PROJECT, 'nonexistent-dir', 'memory.db');
  fs.mkdirSync(path.join(PROJECT, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT, '.claude', 'settings.local.json'),
    JSON.stringify({ env: { CLAUDE_FLOW_DB_PATH: pinned } }));
  const row = one(await collect(), 'memory-pin');
  assert.equal(row.level, 'warn');
  assert.ok(row.message.includes(pinned),
    `memory-pin row must describe PROJECT's own pin (${pinned}), got: ${row.message}`);
  rmrf(path.join(PROJECT, '.claude', 'settings.local.json'));
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

// ── opencode subsystem rows ──────────────────────────────────────────────────
// The third host's status surface: one row family covering config wiring, the
// lifecycle plugin, converted agents, and the platform skill — OK when
// converged, honest non-OK detail + a specific fix otherwise, silence when
// disabled. Strictly read-only throughout (proven by the suite-wide snapshot
// test above, which these scenarios also honor).

const ocHome = () => path.join(HOME, '.config', 'opencode');
const ocJsonPath = () => path.join(ocHome(), 'opencode.json');

/** Fake `opencode` CLI on PATH for the duration of `fn` (+ /usr/bin for the
 *  `which` probe itself; npm stays unresolvable so probes remain offline). */
async function withOpencodeCli(fn) {
  const bin = path.join(HOME, 'fake-bin-oc');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'opencode'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'opencode.cmd'), '@echo off\r\nexit /b 0\r\n');
  const prev = process.env.PATH;
  process.env.PATH = [bin, '/usr/bin', '/bin'].join(path.delimiter);
  try { return await fn(); } finally { process.env.PATH = prev; rmrf(bin); }
}

/** Seed an enabled, CONVERGED opencode state by running the real stack. */
async function seedConvergedOpencode() {
  const catalog = path.join(HOME, 'catalog');
  rmrf(catalog);
  fs.mkdirSync(path.join(catalog, '.claude', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(catalog, '.claude', 'skills', 'a-skill'), { recursive: true });
  fs.writeFileSync(path.join(catalog, 'package.json'), JSON.stringify({ name: 'fixture', version: '9.9.9' }));
  fs.writeFileSync(path.join(catalog, '.claude', 'agents', 'coder.md'),
    '---\nname: coder\ndescription: Implementation specialist\n---\n\nBody.\n');
  fs.writeFileSync(path.join(catalog, 'SKILL.md'), '---\nname: ruflo\ndescription: platform\n---\n\n# Ruflo\n');
  const { opencodeStack } = await import('../../src/lib/opencode.mjs');
  const cfg = loadKitConfig();
  cfg.providers = {
    ...(cfg.providers ?? {}),
    hosts: { claude: true, codex: false, opencode: true },
    opencodeCatalogDir: catalog,
  };
  await withOpencodeCli(() => opencodeStack(cfg, { pkgRoot: PKG_ROOT }));
  writeKitConfig(HOME, cfg); // persist the ownership markers the stack recorded
  return cfg;
}

test('enabled + converged: every opencode row is ok with no fix planned', async () => {
  seedHome();
  await seedConvergedOpencode();
  const rows = await withOpencodeCli(() => collect());
  const oc = rowsFor(rows, 'opencode');
  assert.ok(oc.length >= 2, `expected opencode rows, got: ${rows.map((r) => r.subsystem)}`);
  for (const r of oc) {
    assert.equal(r.level, 'ok', `converged row must be ok: ${r.message}`);
    assert.equal(r.fix, null, `converged row must never plan a fix: ${r.message}`);
  }
  assert.ok(oc.some((r) => /converged/.test(r.message)), 'the wiring row reports convergence');
});

test('enabled + drifted: a warn row names the sync fix', async () => {
  seedHome();
  await seedConvergedOpencode();
  const doc = JSON.parse(fs.readFileSync(ocJsonPath(), 'utf8'));
  delete doc.permission['claude-flow_*']; // user/edit drift
  fs.writeFileSync(ocJsonPath(), JSON.stringify(doc, null, 2));
  const rows = await withOpencodeCli(() => collect());
  const oc = rowsFor(rows, 'opencode');
  const drifted = oc.find((r) => r.level === 'warn');
  assert.ok(drifted, `a drift row must surface: ${oc.map((r) => r.message)}`);
  assert.match(drifted.fix, /sync re-applies the opencode wiring/);
});

test('enabled + JSONC config: refused honestly with a manual-merge fix, never a clobber', async () => {
  seedHome();
  await seedConvergedOpencode();
  fs.writeFileSync(ocJsonPath(), '{\n  // legal JSONC comment\n  "mcp": {}\n}\n');
  const rows = await withOpencodeCli(() => collect());
  const oc = rowsFor(rows, 'opencode').find((r) => r.level === 'warn');
  assert.ok(oc, 'a JSONC-refused row must surface');
  assert.match(oc.message, /not plain JSON/);
  assert.match(oc.fix, /merge the ak wiring manually/);
  // …and status left the file alone (read-only even here).
  assert.match(fs.readFileSync(ocJsonPath(), 'utf8'), /legal JSONC comment/);
});

test('a user-owned plugin occupying the slot is an info row, not a nag to overwrite', async () => {
  seedHome();
  await seedConvergedOpencode();
  fs.writeFileSync(path.join(ocHome(), 'plugins', 'ruflo-hooks.js'), '// my own plugin — no ak marker\n');
  const rows = await withOpencodeCli(() => collect());
  const oc = rowsFor(rows, 'opencode').find((r) => /user-owned ruflo-hooks\.js/.test(r.message));
  assert.ok(oc, `foreign-plugin row missing: ${rowsFor(rows, 'opencode').map((r) => r.message)}`);
  assert.equal(oc.level, 'info');
  assert.equal(oc.fix, null, 'ak must not plan to overwrite a user-owned file');
});

test('enabled + CLI absent: the hosts story, and no config-home probing beyond it', async () => {
  seedHome();
  await seedConvergedOpencode();
  // No fake bin here — the sandbox PATH has no opencode.
  const rows = await collect();
  const oc = rowsFor(rows, 'opencode').find((r) => r.level === 'warn');
  assert.ok(oc, 'enabled-but-absent must surface');
  assert.match(oc.message, /enabled but opencode CLI not installed/);
  assert.match(oc.fix, /sync installs opencode-ai/);
});

test('disabled + installed: complete opencode-row silence + the pick hint on providers', async () => {
  seedHome();
  const rows = await withOpencodeCli(() => collect());
  assert.equal(rowsFor(rows, 'opencode').length, 0,
    'a disabled host claims no active wiring — no opencode rows at all');
  const hint = rowsFor(rows, 'providers').find((r) => /opencode CLI installed but not enabled/.test(r.message));
  assert.ok(hint, 'the providers row carries the adoption hint');
  assert.match(hint.message, /ak host pick --host claude,opencode/);
  assert.equal(hint.fix, null, 'advisory only — sync never opts a host in');
});

test('--json carries the opencode rows with the same shape the dashboard consumes', async () => {
  seedHome();
  await seedConvergedOpencode();
  const cwd = process.cwd();
  process.chdir(PROJECT);
  try {
    const r = await withOpencodeCli(() => captureLog(() => status.run({ flags: { json: true }, pkgRoot: PKG_ROOT })));
    const parsed = JSON.parse(r.out);
    const oc = (parsed.rows ?? []).filter((x) => x.subsystem === 'opencode');
    assert.ok(oc.length >= 1, 'opencode rows present in --json');
    for (const x of oc) {
      assert.equal(typeof x.level, 'string');
      assert.equal(typeof x.message, 'string');
      assert.ok(x.fix === null || typeof x.fix === 'string');
    }
  } finally { process.chdir(cwd); }
});

test.after(() => rmrf(HOME, PROJECT));
