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
const status = await import('../../src/commands/status.mjs');
const { loadKitConfig } = await import('../../src/lib/config.mjs');
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

function dejaSyncConfig() {
  return offlineKitConfig({
    security: false,
    agentdb: false,
    mcp: { register: false, excludeFamilies: [] },
    integrations: {
      version: 3,
      hosts: { claude: false, codex: false, opencode: false },
      bindings: [],
      tools: {
        dejaVu: { enabled: true, mode: 'mcp', hosts: ['claude'], indexOnSetup: true },
      },
      ownership: {
        dejaVu: {
          install: {
            owner: 'agentic-kit', method: 'npm', package: '@vshulcz/deja-vu',
            written: { version: '0.19.0' },
          },
        },
      },
    },
    routing: { version: 1, primaryHost: 'claude', routes: {} },
    providers: {},
  });
}

function fakeDejaLifecycle({ target = false, index = 'stale', outdated = true, partial = false } = {}) {
  const state = { target, index, outdated };
  const calls = { detect: 0, plan: [], apply: 0, operations: [] };
  const adapter = {
    id: 'deja-vu',
    async detect({ cfg }) {
      calls.detect++;
      const receipt = cfg.integrations?.ownership?.dejaVu?.targets?.claude;
      return {
        desired: { enabled: true, mode: 'mcp', hosts: ['claude'], indexOnSetup: true },
        install: {
          binaryPresent: true, npmPresent: true, version: '0.19.0', supported: true,
          ownership: 'agentic-kit', receiptState: 'current',
        },
        doctor: { state: 'ok', reason: null, schemaVersion: 2 },
        index: { state: state.index, staleStores: state.index === 'stale' ? 1 : 0 },
        targets: {
          claude: {
            selected: true, hostPresent: true, desiredTarget: 'claude-code',
            direct: { mcp: state.target, auto: false }, plugin: { present: false, auto: false },
            receiptState: receipt ? 'current' : 'missing',
            ownership: receipt ? 'agentic-kit' : 'none',
            satisfied: state.target, conflict: null,
          },
          codex: { selected: false },
          opencode: { selected: false },
        },
      };
    },
    async plan({ options = {} }) {
      const allowUpgrade = options.allowUpgrade !== false;
      calls.plan.push(allowUpgrade);
      const operations = [];
      if (state.outdated && allowUpgrade) operations.push({ id: 'package-upgrade', kind: 'package-upgrade' });
      if (!state.target) operations.push({ id: 'target-install-claude', kind: 'target-install', host: 'claude' });
      if (state.index !== 'ok') operations.push({ id: 'index', kind: 'index' });
      return { changed: operations.length > 0, operations, warnings: [] };
    },
    async apply({ cfg, plan }) {
      calls.apply++;
      calls.operations.push(...plan.operations.map(({ kind }) => kind));
      if (plan.operations.some(({ kind }) => kind === 'package-upgrade')) state.outdated = false;
      if (plan.operations.some(({ kind }) => kind === 'target-install')) {
        state.target = true;
        cfg.integrations.ownership.dejaVu.targets = {
          claude: { owner: 'agentic-kit', mode: 'mcp', target: 'claude-code' },
        };
      }
      if (plan.operations.some(({ kind }) => kind === 'index')) state.index = 'ok';
      return {
        ok: !partial,
        changed: plan.operations.length > 0,
        configChanged: plan.operations.some(({ kind }) => kind === 'target-install'),
        actions: plan.operations.map(({ id }) => ({ id, status: 'ok', changed: true })),
        warnings: [],
        errors: partial ? ['target-install-failed'] : [],
      };
    },
    async verify() { return { ok: true, changed: false, errors: [] }; },
    async undo() { return { ok: true, changed: false, errors: [] }; },
  };
  return { state, calls, adapter };
}

async function collectOnlyDejaVu({ dejaVuAdapter, dejaVuPlanOptions }) {
  return status.collectDejaVuRows({
    cfg: loadKitConfig(), adapter: dejaVuAdapter, planOptions: dejaVuPlanOptions,
  });
}

async function isolatedDejaSync(adapter, flags = FLAGS()) {
  const cwd = process.cwd();
  process.chdir(PROJECT);
  try {
    return await captureLog(() => sync.run({
      flags, pkgRoot: PKG_ROOT, dejaVuAdapter: adapter, collectFn: collectOnlyDejaVu,
    }));
  } finally { process.chdir(cwd); }
}

test('deja-vu --no-upgrade suppresses only package upgrade and still converges target plus index', async () => {
  seedHome(dejaSyncConfig(), { ruflo: '9.9.9', 'agentic-qe': '9.9.9' });
  const fixture = fakeDejaLifecycle();
  const first = await isolatedDejaSync(fixture.adapter, FLAGS({ 'no-upgrade': true }));
  assert.equal(first.result, 0, first.out);
  assert.equal(fixture.calls.apply, 1);
  assert.deepEqual(fixture.calls.operations, ['target-install', 'index']);
  assert.ok(fixture.calls.plan.every((allowUpgrade) => allowUpgrade === false));
  assert.doesNotMatch(first.out, /warmup|deja update|--all|--auto/);
  assert.ok(loadKitConfig().integrations.ownership.dejaVu.targets.claude,
    'sync persisted the adapter-mutated ownership receipt');

  const second = await isolatedDejaSync(fixture.adapter, FLAGS({ 'no-upgrade': true }));
  assert.equal(second.result, 0, second.out);
  assert.match(second.out, /nothing to do/);
  assert.equal(fixture.calls.apply, 1, 'a converged second sync never calls apply');
});

test('deja-vu sync persists configChanged even when lifecycle apply is partial and fails', async () => {
  seedHome(dejaSyncConfig(), { ruflo: '9.9.9', 'agentic-qe': '9.9.9' });
  const fixture = fakeDejaLifecycle({ index: 'ok', outdated: false, partial: true });
  const result = await isolatedDejaSync(fixture.adapter);
  assert.equal(result.result, 1, result.out);
  assert.ok(loadKitConfig().integrations.ownership.dejaVu.targets.claude,
    'partial verified ownership proof must survive for retry/teardown');
  assert.match(result.out, /deja-vu.*apply failed|still failing: \[deja-vu\]/);
});

test('deja-vu sync never applies an already-healthy external package and wiring', async () => {
  const cfg = dejaSyncConfig();
  delete cfg.integrations.ownership;
  seedHome(cfg, { ruflo: '9.9.9', 'agentic-qe': '9.9.9' });
  let applies = 0;
  const adapter = {
    id: 'deja-vu',
    async detect() {
      return {
        desired: { enabled: true, mode: 'mcp', hosts: ['claude'], indexOnSetup: true },
        install: {
          binaryPresent: true, npmPresent: true, version: '0.19.0', supported: true,
          ownership: 'external', receiptState: 'missing',
        },
        doctor: { state: 'ok', reason: null, schemaVersion: 2 },
        index: { state: 'ok', staleStores: 0 },
        targets: {
          claude: {
            selected: true, hostPresent: true, desiredTarget: 'claude-code',
            direct: { mcp: true, auto: false }, plugin: { present: false, auto: false },
            receiptState: 'missing', ownership: 'external', satisfied: true, conflict: null,
          },
          codex: { selected: false }, opencode: { selected: false },
        },
      };
    },
    async plan() { return { changed: false, operations: [], warnings: [] }; },
    async apply() { applies++; throw new Error('external state must not be applied'); },
    async verify() { return { ok: true, changed: false, errors: [] }; },
    async undo() { return { ok: true, changed: false, errors: [] }; },
  };
  const result = await isolatedDejaSync(adapter);
  assert.equal(result.result, 0, result.out);
  assert.match(result.out, /nothing to do/);
  assert.equal(applies, 0);
  assert.equal(loadKitConfig().integrations.ownership?.dejaVu, undefined);
});

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

test('an AQE router apply failure survives collection and prevents a false converged verdict', async () => {
  seedHome(offlineKitConfig({
    security: false, agentdb: false, mcp: { register: false, excludeFamilies: [] },
    integrations: {
      version: 2, hosts: { claude: true, codex: false, opencode: false },
      bindings: [], ownership: {},
    },
    routing: { version: 1, primaryHost: 'claude', routes: {} },
    providers: {
      aqeProvider: null,
      aqeFallback: [{ provider: 'missing-external', models: ['default'], source: 'user' }],
      models: [], maxBudgetUsd: null,
    },
  }), { ruflo: '9.9.9', 'agentic-qe': '9.9.9' });
  const collectProviders = async () => [{
    subsystem: 'providers', level: 'warn', message: 'router needs repair',
    fix: 'sync re-applies provider env + aqe router',
  }];
  const prior = process.cwd();
  process.chdir(PROJECT);
  let result;
  try {
    result = await captureLog(() => sync.run({
      flags: FLAGS({ 'no-upgrade': true }), pkgRoot: PKG_ROOT, collectFn: collectProviders,
    }));
  } finally { process.chdir(prior); }
  assert.equal(result.result, 1, result.out);
  assert.match(result.out, /aqe router:.*no valid providers in fallback chain/);
  assert.match(result.out, /still failing: \[providers\] AQE router apply failed/);
  assert.doesNotMatch(result.out, /converged — no failing subsystems/);
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
  assert.ok(fs.existsSync(path.join(ocHome(), 'plugins', 'ruflo-gateway.js')), 'lazy gateway deployed by sync');
  assert.ok(fs.existsSync(path.join(ocHome(), 'agents', 'ak-specialist.md')),
    'specialist dispatcher deployed by sync');
  assert.equal(fs.existsSync(path.join(ocHome(), 'agents', 'coder.md')), false,
    'sync retires the eager agent projection after the dispatcher is current');
  // ordering: opencode steps ran before the convergence proof
  const stepIdx = out.search(/opencode (plugin|gateway|agent projection):/);
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
  assert.ok(!/opencode (plugin|gateway|agent projection|skill):/.test(out),
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
