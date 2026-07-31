// `ak sync` — converge-to-good. It is the command that actually mutates the
// machine (npm upgrades, native rebuilds, MCP registration, CLAUDE.md
// rewrites), so the tested surface here is deliberately the decision layer:
// which rows become plan items, how --no-upgrade narrows them, and the
// promise that --dry-run stops before the first write. A non-dry-run sync is
// NOT exercised — it would install packages onto the machine running the
// suite; the individual heals it delegates to have their own unit tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sandboxHome, assertSandboxed, snapshot, assertUnchanged, captureLog, rmrf,
  sandboxProject, writeKitConfig, offlineKitConfig, fakeGlobalRoot,
} from './helpers/home-sandbox.mjs';

const HOME = sandboxHome('ak-sync');
const paths = await import('../../src/lib/paths.mjs');
const sync = await import('../../src/commands/sync.mjs');
assertSandboxed(paths, HOME);

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROJECT = sandboxProject('ak-sync');
const FLAGS = (over = {}) => ({ 'dry-run': false, 'no-upgrade': false, json: false, ...over });

function seedHome(cfg = offlineKitConfig(), pkgs = {}) {
  rmrf(paths.claudeDir(), paths.configDir(), path.join(HOME, '.config', 'opencode'));
  fs.mkdirSync(paths.claudeDir(), { recursive: true });
  fs.writeFileSync(paths.claudeMdPath(), '# machine notes\n');
  writeKitConfig(HOME, cfg);
  paths._setGlobalRootForTest(fakeGlobalRoot(HOME, pkgs));
}

/** Run `ak sync --dry-run …` from the sandbox project and return its output. */
async function dryRun(over = {}) {
  const cwd = process.cwd();
  process.chdir(PROJECT);
  try {
    return await captureLog(() => sync.run({ flags: FLAGS({ 'dry-run': true, ...over }), pkgRoot: PKG_ROOT }));
  } finally { process.chdir(cwd); }
}

test('--dry-run prints a plan and then changes nothing at all', async () => {
  seedHome();
  const beforeHome = snapshot(HOME);
  const beforeProject = snapshot(PROJECT);
  const { result, out } = await dryRun();
  assert.equal(result, 0, '`--dry-run` always exits 0 — it only reports');
  assert.match(out, /sync plan \(\d+ action\(s\)\):/);
  assertUnchanged(beforeHome, HOME, '`ak sync --dry-run` must not touch HOME');
  assertUnchanged(beforeProject, PROJECT, '`ak sync --dry-run` must not touch the project');
});

test('the plan is exactly the rows status marked with a fix', async () => {
  seedHome();
  const status = await import('../../src/commands/status.mjs');
  const expected = (await status.collect({ pkgRoot: PKG_ROOT, cwd: PROJECT })).filter((r) => r.fix);
  const { out } = await dryRun();
  const planned = out.split('\n').filter((l) => l.trim().startsWith('•'));
  assert.equal(planned.length, expected.length,
    'sync must plan every actionable row and nothing else');
  for (const r of expected) {
    assert.ok(planned.some((l) => l.includes(`[${r.subsystem}]`) && l.includes(r.fix)),
      `plan is missing [${r.subsystem}] ${r.fix}`);
  }
});

test('--no-upgrade drops version/self/brain upgrades but keeps the heals', async () => {
  // No ruflo in the global root → a `versions` row with a fix, which is the
  // upgrade class --no-upgrade is supposed to withhold.
  seedHome(offlineKitConfig(), {});
  const full = (await dryRun()).out;
  assert.match(full, /\[versions\]/, 'a missing ruflo is normally planned as an upgrade');

  const narrowed = (await dryRun({ 'no-upgrade': true })).out;
  for (const withheld of ['[versions]', '[self]', '[ruvnet-brain]']) {
    assert.ok(!narrowed.includes(withheld), `--no-upgrade must withhold ${withheld}`);
  }
  assert.match(narrowed, /sync plan|nothing to do/, 'the remaining heals are still planned');
});

test('--no-upgrade still plans non-version heals (e.g. MCP registration)', async () => {
  seedHome();
  const { out } = await dryRun({ 'no-upgrade': true });
  assert.match(out, /\[mcp\] setup\/sync registers claude-flow at user scope/);
});

test('kit.json opt-outs keep their subsystems out of the plan entirely', async () => {
  seedHome(offlineKitConfig({ security: false, agentdb: false, mcp: { register: false, excludeFamilies: [] } }));
  const { out } = await dryRun();
  for (const off of ['[security]', '[agentdb]', '[mcp]']) {
    assert.ok(!out.includes(off), `a disabled subsystem must never appear in the plan: ${off}`);
  }
});

test('--dry-run stops before the apply phase (no heal results, no convergence re-check)', async () => {
  seedHome();
  const { out } = await dryRun();
  // The apply phase reports each heal as "<name>: <detail>" and closes with a
  // convergence verdict. Neither may appear when the run stopped at the plan.
  assert.ok(!/converged — no failing subsystems/.test(out), 'no convergence proof on a dry run');
  assert.ok(!/still failing:/.test(out), 'no post-heal verdict on a dry run');
  assert.ok(!/^\s*✓ (natives|aidefence|npx|blocks|statusline):/m.test(out), 'no heal ran');
});

test('an oversized RVF store is planned as a quarantine', async () => {
  seedHome();
  const aqeDir = paths.projectAqeDir(PROJECT);
  fs.mkdirSync(aqeDir, { recursive: true });
  fs.writeFileSync(path.join(aqeDir, 'brain.rvf'), 'x'.repeat(4096));
  const prev = process.env.RUFLO_AQE_RVF_MAX_BYTES;
  process.env.RUFLO_AQE_RVF_MAX_BYTES = '16';
  try {
    const { out } = await dryRun();
    assert.match(out, /\[aqe\] sync quarantines them/);
    assert.ok(fs.existsSync(path.join(aqeDir, 'brain.rvf')),
      'a previewed quarantine must not delete the store');
  } finally {
    if (prev === undefined) delete process.env.RUFLO_AQE_RVF_MAX_BYTES;
    else process.env.RUFLO_AQE_RVF_MAX_BYTES = prev;
    rmrf(aqeDir);
  }
});

test('every documented flag is declared in the parser options', () => {
  for (const flag of ['dry-run', 'no-upgrade', 'json']) {
    assert.ok(flag in sync.options, `--${flag} is documented in help but not parseable`);
    assert.match(sync.help, new RegExp(`--${flag}\\b`), `--${flag} is parseable but undocumented`);
  }
});

// ── opencode convergence through a REAL sync ─────────────────────────────────
// The maintainer's command-level scenarios: enabled+drifted converges after the
// hosts step and before the final verification; enabled+absent never fabricates
// the config home; disabled makes no opencode writes; --dry-run mutates no
// opencode surface; a second sync is a no-op. A real sync.run is exercised here
// (the suite otherwise stays at the plan layer) — hermetic because the global
// root is faked (no upgrades planned), MCP/agentdb are opted out, and PATH has
// no npm.

const ocHome = () => path.join(HOME, '.config', 'opencode');

/** Fake `opencode` + `claude` CLIs on PATH for the duration of `fn` (claude is
 *  the primary host — its absence is a fail-level row that would mask the
 *  opencode assertions). /usr/bin:/bin ride along for the `which` probe. */
async function withOpencodeCli(fn) {
  const bin = path.join(HOME, 'fake-bin-sync');
  fs.mkdirSync(bin, { recursive: true });
  for (const name of ['opencode', 'claude']) {
    fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, `${name}.cmd`), '@echo off\r\nexit /b 0\r\n');
    fs.writeFileSync(path.join(bin, `${name}.ps1`), 'exit 0\r\n');
  }
  const prev = process.env.PATH;
  process.env.PATH = [bin, '/usr/bin', '/bin'].join(path.delimiter);
  try { return await fn(); } finally { process.env.PATH = prev; rmrf(bin); }
}

function seedCatalog() {
  const root = path.join(HOME, 'catalog');
  rmrf(root);
  fs.mkdirSync(path.join(root, '.claude', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude', 'skills', 'a-skill'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '9.9.9' }));
  fs.writeFileSync(path.join(root, '.claude', 'agents', 'coder.md'),
    '---\nname: coder\ndescription: Implementation specialist\n---\n\nBody.\n');
  fs.writeFileSync(path.join(root, 'SKILL.md'), '---\nname: ruflo\ndescription: platform\n---\n\n# Ruflo\n');
  return root;
}

/** A fake global root where nothing is upgrade-planned and the aqe native
 *  binding is fabricated (bsq3Root needs the package's package.json; the probe
 *  itself is an existsSync on the built .node file). */
function fakeSyncRoot() {
  const root = path.join(HOME, `fake-sync-root-${Math.random().toString(36).slice(2, 8)}`, 'node_modules');
  fs.mkdirSync(path.join(root, 'ruflo'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ruflo', 'package.json'), JSON.stringify({ name: 'ruflo', version: '9.9.9' }));
  const bsq3RootDir = path.join(root, 'agentic-qe', 'node_modules', 'better-sqlite3');
  fs.mkdirSync(path.join(bsq3RootDir, 'build', 'Release'), { recursive: true });
  fs.writeFileSync(path.join(root, 'agentic-qe', 'package.json'), JSON.stringify({ name: 'agentic-qe', version: '9.9.9' }));
  fs.writeFileSync(path.join(bsq3RootDir, 'package.json'), JSON.stringify({ name: 'better-sqlite3', version: '12.0.0' }));
  fs.writeFileSync(path.join(bsq3RootDir, 'build', 'Release', 'better_sqlite3.node'), 'fake native binding\n');
  return root;
}

/** kit.json with opencode enabled, noisy subsystems opted out, fresh version cache. */
function syncCfg(catalog) {
  return offlineKitConfig({
    agentdb: false,
    mcp: { register: false, excludeFamilies: [] },
    integrations: {
      version: 2,
      hosts: { claude: true, codex: false, opencode: true },
      bindings: [],
      ownership: { opencode: { catalogDir: catalog } },
    },
    routing: { version: 1, primaryHost: 'claude', routes: {} },
    providers: {},
  });
}

async function realSync() {
  const cwd = process.cwd();
  process.chdir(PROJECT);
  try {
    return await captureLog(() => sync.run({ flags: FLAGS(), pkgRoot: PKG_ROOT }));
  } finally { process.chdir(cwd); }
}

test('enabled + drifted: a real sync converges opencode after hosts, before final verification', async () => {
  const catalog = seedCatalog();
  seedHome(syncCfg(catalog), { ruflo: '9.9.9' });
  paths._setGlobalRootForTest(fakeSyncRoot());
  const { result, out } = await withOpencodeCli(() => realSync());
  assert.equal(result, 0, out);
  // wiring landed on disk
  const doc = JSON.parse(fs.readFileSync(path.join(ocHome(), 'opencode.json'), 'utf8'));
  assert.ok(doc.mcp['claude-flow'], 'claude-flow MCP converged by sync');
  assert.ok(fs.existsSync(path.join(ocHome(), 'plugins', 'ruflo-hooks.js')), 'plugin deployed by sync');
  assert.ok(fs.existsSync(path.join(ocHome(), 'agents', 'coder.md')), 'agents converted by sync');
  // ordering: opencode steps ran before the convergence proof
  const stepIdx = out.search(/opencode (plugin|agents):/);
  const verdictIdx = out.search(/converged — no failing subsystems/);
  assert.ok(stepIdx > -1 && verdictIdx > -1 && stepIdx < verdictIdx,
    `opencode convergence must land before the final verification:\n${out}`);
});

test('a second sync is a no-op for every opencode surface', async () => {
  const catalog = seedCatalog();
  seedHome(syncCfg(catalog), { ruflo: '9.9.9' });
  paths._setGlobalRootForTest(fakeSyncRoot());
  await withOpencodeCli(() => realSync());
  const convergedHome = snapshot(ocHome());
  const { result, out } = await withOpencodeCli(() => realSync());
  assert.equal(result, 0, out);
  assertUnchanged(convergedHome, ocHome(), 'a converged sync must not rewrite any opencode file');
  assert.ok(!/opencode (plugin|agents|skill):/.test(out),
    'the opencode branch is not even entered once every row reports converged');
});

// codex-review r3: the blocks branch must run when the opencode branch ran,
// because a fresh enable creates the config home that activates the
// agents-opencode guidance target. The pre-fix scenario: claude guidance
// ALREADY converged (no blocks drift in the plan) — guidance must still land
// on the SAME sync that creates the config home.
test('converged claude guidance + fresh opencode enable: opencode guidance lands on the SAME sync', async () => {
  const catalog = seedCatalog();
  // Step 1: converge everything except opencode (opencode disabled here).
  seedHome(syncCfg(catalog), { ruflo: '9.9.9' });
  const disabledCfg = syncCfg(catalog);
  disabledCfg.integrations.hosts = { claude: true, codex: false, opencode: false };
  writeKitConfig(HOME, disabledCfg);
  paths._setGlobalRootForTest(fakeSyncRoot());
  await withOpencodeCli(() => realSync()); // CLAUDE.md blocks now converged
  assert.ok(!fs.existsSync(ocHome()), 'opencode disabled: no config home yet');

  // Step 2: enable opencode in kit.json (as `pick` would persist it), sync again.
  const enabledCfg = syncCfg(catalog);
  writeKitConfig(HOME, enabledCfg);
  const { result, out } = await withOpencodeCli(() => realSync());
  assert.equal(result, 0, out);
  const agentsMd = path.join(ocHome(), 'AGENTS.md');
  assert.ok(fs.existsSync(agentsMd),
    'guidance must land on the SAME sync that creates the config home, not one sync late');
  assert.match(fs.readFileSync(agentsMd, 'utf8'), /BEGIN ruflo-preamble/);

  // Step 3: the follow-up sync is then a TRUE no-op on the whole opencode home.
  const converged = snapshot(ocHome());
  const third = await withOpencodeCli(() => realSync());
  assert.equal(third.result, 0, third.out);
  assertUnchanged(converged, ocHome(), 'once converged, sync rewrites nothing');
});

test('enabled + absent CLI: the install is attempted by hosts, the wiring is skipped, no config home appears', async () => {
  const catalog = seedCatalog();
  seedHome(syncCfg(catalog), { ruflo: '9.9.9' });
  paths._setGlobalRootForTest(fakeSyncRoot());
  // No fake bin — opencode is not on PATH, and npm is unresolvable (install fails honestly).
  const { out } = await realSync();
  assert.match(out, /opencode: enabled but CLI not installed — wiring skipped/);
  assert.ok(!fs.existsSync(ocHome()), 'the config home is never fabricated for an absent host');
});

test('disabled + installed: no wiring writes, and enablement-gated guidance is stripped — user config untouched', async () => {
  seedHome(offlineKitConfig({
    agentdb: false,
    mcp: { register: false, excludeFamilies: [] },
    providers: { hosts: { claude: true, codex: false, opencode: false } },
  }), { ruflo: '9.9.9' });
  paths._setGlobalRootForTest(fakeSyncRoot());
  // A pre-existing, user-owned opencode home that still carries an
  // enablement-gated block from a previous enablement.
  fs.mkdirSync(ocHome(), { recursive: true });
  const userConfig = JSON.stringify({ model: 'opencode/kimi-k3' }, null, 2) + '\n';
  fs.writeFileSync(path.join(ocHome(), 'opencode.json'), userConfig);
  fs.writeFileSync(path.join(ocHome(), 'AGENTS.md'),
    '# my notes\n\n<!-- BEGIN ruflo-opencode-reference -->\nstale gated guidance\n<!-- END ruflo-opencode-reference -->\n');
  const { out } = await withOpencodeCli(() => realSync());
  assert.ok(!/\[opencode\]/.test(out.split('sync plan')[1] ?? ''), 'no opencode work is planned when disabled');
  assert.equal(fs.readFileSync(path.join(ocHome(), 'opencode.json'), 'utf8'), userConfig,
    'user opencode.json is byte-identical — no wiring writes when disabled');
  assert.ok(!fs.existsSync(path.join(ocHome(), 'plugins')), 'no plugin deployed when disabled');
  assert.ok(!fs.existsSync(path.join(ocHome(), 'agents')), 'no agents deployed when disabled');
  const md = fs.readFileSync(path.join(ocHome(), 'AGENTS.md'), 'utf8');
  assert.ok(!md.includes('ruflo-opencode-reference'), 'enablement-gated guidance stripped');
  assert.ok(md.includes('# my notes'), 'user guidance content preserved');
});

test('--dry-run reports the opencode repair without mutating any opencode surface', async () => {
  const catalog = seedCatalog();
  seedHome(syncCfg(catalog), { ruflo: '9.9.9' });
  paths._setGlobalRootForTest(fakeSyncRoot());
  const before = snapshot(HOME);
  const { result, out } = await withOpencodeCli(() => dryRun());
  assert.equal(result, 0);
  assert.ok(/\[opencode\]/.test(out), 'opencode repair appears in the plan');
  assert.ok(!fs.existsSync(ocHome()), 'no config written on a dry run');
  assertUnchanged(before, HOME, 'sync --dry-run mutates nothing, opencode included');
});

test.after(() => rmrf(HOME, PROJECT));
