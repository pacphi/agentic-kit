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
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  sandboxHome, assertSandboxed, snapshot, assertUnchanged, captureLog, rmrf,
  sandboxProject, writeKitConfig, offlineKitConfig, fakeGlobalRoot, spawnEnv,
} from './helpers/home-sandbox.mjs';
import { isolateProject } from './helpers/project-isolation.mjs';

const HOME = sandboxHome('ak-sync');
const paths = await import('../../src/lib/paths.mjs');
const sync = await import('../../src/commands/sync.mjs');
const status = await import('../../src/commands/status.mjs');
const { loadKitConfig } = await import('../../src/lib/config.mjs');
const { HOSTS, hostInstallState } = await import('../../src/lib/providers.mjs');
const { writeEvidence, stableInputsKey } = await import('../../src/lib/evidence.mjs');
assertSandboxed(paths, HOME);
isolateProject('ak-sync-command');

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROJECT = sandboxProject('ak-sync');
const FLAGS = (over = {}) => ({ 'dry-run': false, 'no-upgrade': false, yes: false, json: false, ...over });

function seedHome(cfg = offlineKitConfig(), pkgs = {}) {
  rmrf(paths.claudeDir(), paths.codexDir(), paths.configDir(), path.join(HOME, '.config', 'opencode'));
  fs.mkdirSync(paths.claudeDir(), { recursive: true });
  fs.writeFileSync(paths.claudeMdPath(), '# machine notes\n');
  writeKitConfig(HOME, cfg);
  paths._setGlobalRootForTest(fakeGlobalRoot(HOME, pkgs));
}

/** Run `ak sync --dry-run …` from the sandbox project and return its output.
 *  The dry run's version lookups answer nothing: some tests put /usr/bin on
 *  PATH, where a real npm would otherwise query the registry. */
async function dryRun(over = {}) {
  const cwd = process.cwd();
  process.chdir(PROJECT);
  try {
    return await captureLog(() => sync.run({
      flags: FLAGS({ 'dry-run': true, ...over }), pkgRoot: PKG_ROOT,
      fetchLatest: async () => null, releaseDatesRunner: async () => ({ code: 1, stdout: '', stderr: 'offline (test)' }),
    }));
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
  rmrf(paths.evidenceDir());
  const beforeHome = snapshot(HOME);
  const beforeProject = snapshot(PROJECT);
  const { result, out } = await dryRun();
  assert.equal(result, 0, '`--dry-run` always exits 0 — it only reports');
  assert.match(out, /sync plan \(\d+ action\(s\)\):/);
  // ADR-0063: sync's plan-computation read calls collect() with record:false,
  // so probing on a cache miss never persists evidence — the dry-run plan is
  // a read, not a write. `refreshPlanHosts()` (real host-evidence work sync
  // now does before the plan, to catch a not-yet-stale but wrong row) is
  // itself skipped under --dry-run for the same reason. The post-heal
  // convergence re-check does persist (record: true) but is never reached
  // here — --dry-run returns before any step, including that re-check, runs.
  assertUnchanged(beforeHome, HOME, '`ak sync --dry-run` must not touch HOME, including the evidence cache');
  assertUnchanged(beforeProject, PROJECT, '`ak sync --dry-run` must not touch the project');
});

/** A fake `ak` on PATH for `fn`: the mcp rows are sync repairs only when the
 *  PATH `ak` can run the launcher (register() refuses otherwise), and the
 *  sandbox PATH is empty. It answers the launcher check's `--help` with the
 *  `--host` option. /usr/bin:/bin ride along for the `which` probe. */
async function withAkOnPath(fn) {
  const bin = path.join(HOME, 'fake-bin-ak');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'ak'), '#!/bin/sh\necho "  --host <claude|codex>"\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'ak.cmd'), '@echo off\r\necho   --host ^<claude^|codex^>\r\nexit /b 0\r\n');
  fs.writeFileSync(path.join(bin, 'ak.ps1'), "Write-Output '  --host <claude|codex>'\r\nexit 0\r\n");
  const prev = process.env.PATH;
  process.env.PATH = [bin, '/usr/bin', '/bin'].join(path.delimiter);
  try { return await fn(); } finally { process.env.PATH = prev; rmrf(bin); }
}

test('the plan is exactly the rows status marked with a fix', () => withAkOnPath(async () => {
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
}));

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

test('--no-upgrade still plans non-version heals (e.g. MCP registration)', () => withAkOnPath(async () => {
  seedHome();
  const { out } = await dryRun({ 'no-upgrade': true });
  assert.match(out, /\[mcp\] setup\/sync registers claude-flow at user scope/);
}));

test('without ak on PATH the MCP registration is not planned: register() would refuse', async () => {
  seedHome();
  const { out } = await dryRun({ 'no-upgrade': true });
  assert.doesNotMatch(out, /\[mcp\] setup\/sync registers claude-flow/);
});

// Controller ruling: a ruflo-components row asking for a ruflo UPGRADE
// (needs-ruflo) gets the same --no-upgrade treatment as 'versions' — but
// other ruflo-components fixes (which don't need an upgrade) must stay
// planned. collectFn is fully injected here (dry-run stops before any
// SYNC_STEPS apply), so this never spawns a real reconcile.
test('--no-upgrade drops a needs-ruflo ruflo-components row but keeps other ruflo-components fixes', async () => {
  seedHome();
  const collectMixed = async () => [
    {
      subsystem: 'ruflo-components', level: 'warn', state: 'needs-ruflo',
      message: 'MiniLM agent picker — needs ruflo ≥ 3.44.0: The installed ruflo is too old for this component.',
      fix: 'sync applies MiniLM agent picker (Run ak sync to upgrade ruflo.)',
    },
    {
      subsystem: 'ruflo-components', level: 'warn', state: 'not-applied',
      message: 'Typesafe agent picker — not applied: ak has not applied the managed value yet.',
      fix: 'sync applies Typesafe agent picker (reconcile)',
    },
  ];
  const prior = process.cwd();
  process.chdir(PROJECT);
  try {
    const { out } = await captureLog(() => sync.run({
      flags: FLAGS({ 'dry-run': true, 'no-upgrade': true }), pkgRoot: PKG_ROOT, collectFn: collectMixed,
    }));
    assert.doesNotMatch(out, /MiniLM agent picker/, '--no-upgrade must withhold a needs-ruflo ruflo-components fix');
    assert.match(out, /Typesafe agent picker/, 'a non-upgrade ruflo-components fix must stay planned');
  } finally { process.chdir(prior); }
});

// Controller ruling: a blocked (level: 'fail') ruflo-components row must
// survive into the post-heal convergence check the same way any other
// subsystem's fail row does. The FIRST collectFn call seeds the plan with an
// unrelated, unmatched subsystem (so none of SYNC_STEPS' specific `when`
// gates fire — 'host-lifecycles' is the only unconditional step, and it
// no-ops with no lifecycle hosts enabled); the SECOND call (the post-heal
// "after" proof) reports the blocked ruflo-components row. This proves the
// convergence check without ever entering the real `reconcileRufloComponents`
// (which never appears in `subsystems` here) — hermetic by construction.
test('a blocked (fail-level) ruflo component prevents a false converged verdict', async () => {
  seedHome();
  let calls = 0;
  const collectFn = async () => {
    calls += 1;
    if (calls === 1) {
      return [{
        subsystem: 'sync-test-only-marker', level: 'warn', message: 'placeholder heal for this test',
        fix: 'sync does something harmless not tied to any real step',
      }];
    }
    return [{
      subsystem: 'ruflo-components', level: 'fail',
      message: 'MCP tool governance — blocked: Applying failed. Follow the reason shown, then run ak sync.',
      fix: null,
    }];
  };
  const prior = process.cwd();
  process.chdir(PROJECT);
  let result;
  try {
    result = await captureLog(() => sync.run({
      flags: FLAGS({ 'no-upgrade': true }), pkgRoot: PKG_ROOT, collectFn,
    }));
  } finally { process.chdir(prior); }
  assert.equal(result.result, 1, result.out);
  assert.match(result.out, /still failing: \[ruflo-components\]/);
  assert.doesNotMatch(result.out, /converged — no failing subsystems/);
});

// ADR-0058 C1: with nothing written to Claude settings yet (and no evidence cache), the
// real status section must still hand sync a ruflo-components fix, or an upgraded ak
// never applies the components from a non-project cwd.
test('an unconverged Claude projection puts ruflo-components in the sync plan', async () => {
  seedHome(offlineKitConfig({
    rufloComponents: { ...offlineKitConfig().rufloComponents, minilmPicker: true },
  }), { ruflo: '3.44.0' });
  const { out } = await dryRun();
  assert.match(out, /\[ruflo-components\] sync applies MiniLM agent picker/);
});

test('kit.json opt-outs keep their subsystems out of the plan entirely', async () => {
  seedHome(offlineKitConfig({ security: false, mcp: { register: false, excludeFamilies: [] } }));
  const { out } = await dryRun();
  for (const off of ['[security]', '[mcp]']) {
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
  for (const flag of ['dry-run', 'no-upgrade', 'yes', 'json', 'skip']) {
    assert.ok(flag in sync.options, `--${flag} is documented in help but not parseable`);
    assert.match(sync.help, new RegExp(`--${flag}\\b`), `--${flag} is parseable but undocumented`);
  }
});

test('a noninteractive Codex repair is disclosed but not applied without --yes', async () => {
  seedHome(offlineKitConfig({
    integrations: {
      version: 2, hosts: { claude: true, codex: true, opencode: false }, bindings: [], ownership: {},
    },
  }));
  fs.mkdirSync(paths.codexDir(), { recursive: true });
  fs.writeFileSync(paths.codexConfigPath(), [
    '[mcp_servers.codex]', 'command = "codex"', 'args = ["mcp-server"]',
  ].join('\n'));
  const before = snapshot(HOME);
  const prior = process.cwd();
  process.chdir(PROJECT);
  let result;
  try {
    result = await captureLog(() => sync.run({
      flags: FLAGS({ 'no-upgrade': true }), pkgRoot: PKG_ROOT,
      // refreshHosts is real host-evidence work sync now does before the plan
      // read even exists to matter here (collectFn below is fully synthetic);
      // no-op it so the sandbox stays byte-for-byte untouched, same as the
      // real collectFn is bypassed for this test.
      refreshHosts: async () => {},
      collectFn: async () => [{
        subsystem: 'codex-mcp', level: 'fail', message: 'recursive Codex registration',
        fix: 'remove the recursive Codex MCP registration',
      }],
    }));
  } finally { process.chdir(prior); }
  assert.equal(result.result, 1);
  assert.match(result.out, /Codex repairs need confirmation/);
  assertUnchanged(before, HOME, 'unapproved Codex repair must not mutate the sandbox');
});

test('the mcp step names a preserved custom legacy ruflo registration and its manual command', async () => {
  seedHome(offlineKitConfig({ mcp: { register: true, excludeFamilies: [] } }));
  const mcpStep = sync.SYNC_STEPS.find((s) => s.id === 'mcp');
  const results = [];
  const ctx = {
    cfg: loadKitConfig(),
    step: async (name, thunk) => { const r = await thunk(); results.push([name, r]); return r; },
    registerMcp: async () => ({
      ok: true, preserved: [{ name: 'ruflo', scope: 'user', command: '/opt/homebrew/bin/ruflo', args: ['mcp'] }],
    }),
  };
  const { out } = await captureLog(() => mcpStep.run(ctx));
  assert.equal(results[0][1].ok, true, 'claude-flow registration itself succeeded');
  assert.match(out, /custom 'ruflo' MCP registration preserved \(user scope\)/);
  assert.match(out, /claude mcp remove ruflo -s user/);
});

// ── promised repairs must converge (#237 §F) ─────────────────────────────────
// A planned sync fix whose row is still there after the apply phase was
// silently dropped from the verdict: sync printed "converged" and exited 0.
// These runs stay hermetic: the planned subsystem is `aqe`, whose step
// (healRvf) only scans the sandbox project's missing .agentic-qe directory.

/** A collectFn that returns `first` for the plan and `after` for the proof. */
function twoPhase(first, after) {
  let calls = 0;
  return async () => (calls++ === 0 ? first : after);
}

async function syncWith(collectFn, over = {}) {
  const prior = process.cwd();
  process.chdir(PROJECT);
  try {
    return await captureLog(() => sync.run({
      flags: FLAGS({ 'no-upgrade': true, ...over }), pkgRoot: PKG_ROOT, collectFn,
    }));
  } finally { process.chdir(prior); }
}

const RVF_FIX = 'sync quarantines them (aqe rebuilds the store)';

test('a planned sync repair still present after the apply phase is unresolved and fails sync', async () => {
  seedHome();
  const persisting = { subsystem: 'aqe', level: 'warn', message: 'store still oversized', fix: RVF_FIX, repair: 'sync' };
  const { result, out } = await syncWith(twoPhase([persisting], [persisting]));
  assert.equal(result, 1, out);
  assert.match(out, /unresolved: \[aqe\] sync quarantines them \(aqe rebuilds the store\) — store still oversized/);
  assert.doesNotMatch(out, /converged — no failing subsystems/);
});

test('a fixture row without a repair field is still held to its promise', async () => {
  seedHome();
  // The plan admits any fix that is not manual, so the proof must use the same test.
  const legacy = { subsystem: 'aqe', level: 'warn', message: 'store still oversized', fix: RVF_FIX };
  const { result, out } = await syncWith(twoPhase([legacy], [legacy]));
  assert.equal(result, 1, out);
  assert.match(out, /unresolved: \[aqe\]/);
});

test('a planned subsystem that no sync step performs is unresolved even when its row disappears', async () => {
  seedHome();
  const { result, out } = await syncWith(twoPhase([{
    subsystem: 'sync-test-only-marker', level: 'warn', message: 'nothing handles this', fix: 'sync pretends to fix it',
  }], []));
  assert.equal(result, 1, out);
  assert.match(out, /unresolved: \[sync-test-only-marker\] sync pretends to fix it — no sync step performs this repair/);
  assert.doesNotMatch(out, /converged — no failing subsystems/);
});

test('manual fixes and preserved advisories never enter the plan and never fail sync', async () => {
  seedHome();
  const manual = {
    subsystem: 'mcp', level: 'warn', message: "custom 'ruflo' MCP registration preserved (user scope)",
    fix: 'claude mcp remove ruflo -s user', repair: 'manual',
  };
  const advisory = { subsystem: 'project-memory', level: 'warn', message: 'two preserved memory files', fix: null, repair: null };
  const repaired = { subsystem: 'aqe', level: 'warn', message: 'store oversized', fix: RVF_FIX, repair: 'sync' };
  const { result, out } = await syncWith(twoPhase([repaired, manual, advisory], [manual, advisory]));
  assert.equal(result, 0, out);
  assert.doesNotMatch(out, /• \[mcp\]/, 'a manual fix is never a plan item');
  assert.doesNotMatch(out, /unresolved:/);
  assert.match(out, /converged — no failing subsystems/);
});

// ADR-0063: the plan read never records (record: false), the converge proof
// does (record: true), and neither forces a refresh. versionEvidence carries
// cache-only version results for the parts --skip names; a sync that skips
// none of them hands both reads an empty one.
const MARKER = { subsystem: 'sync-test-only-marker', level: 'warn', message: 'marker row', fix: 'no sync step performs this' };

test('the plan read and the converge proof get exactly these collect() arguments', async () => {
  seedHome();
  const calls = [];
  await syncWith(async (args) => { calls.push(args); return args.record ? [] : [MARKER]; });
  assert.equal(calls.length, 2);
  const expected = (record) => ({
    pkgRoot: PKG_ROOT, cwd: PROJECT, dejaVuAdapter: calls[0].dejaVuAdapter,
    dejaVuPlanOptions: { allowUpgrade: false }, record, versionEvidence: {},
  });
  assert.deepEqual(calls[0], expected(false));
  assert.deepEqual(calls[1], expected(true));
  assert.equal(calls[1].dejaVuAdapter, calls[0].dejaVuAdapter);
});

test('with --skip versions both reads get cache-only drift, re-read after the apply phase', async () => {
  seedHome(offlineKitConfig(), { ruflo: '9.9.8', 'agentic-qe': '9.9.9' });
  const calls = [];
  await syncWith(async (args) => {
    calls.push(args);
    // Stand-in for an apply phase that changed what is installed.
    if (!args.record) paths._setGlobalRootForTest(fakeGlobalRoot(HOME, { ruflo: '9.9.9', 'agentic-qe': '9.9.9' }));
    return args.record ? [] : [MARKER];
  }, { skip: ['versions'] });
  assert.equal(calls.length, 2);
  const ruflo = (call) => call.versionEvidence.drift.find((r) => r.pkg === 'ruflo');
  assert.deepEqual(Object.keys(calls[0].versionEvidence), ['drift']);
  assert.deepEqual(Object.keys(calls[1].versionEvidence), ['drift']);
  assert.equal(ruflo(calls[0]).installed, '9.9.8');
  assert.equal(ruflo(calls[1]).installed, '9.9.9', 'the proof re-reads installed versions after the apply phase');
});

test('which steps perform a subsystem: none for an unknown one, the tail for host alignment', () => {
  const cfg = loadKitConfig();
  const flags = FLAGS();
  assert.deepEqual(sync.performingSteps('sync-test-only-marker', flags, cfg), []);
  assert.deepEqual(sync.performingSteps('aqe', flags, cfg), ['aqe-rvf']);
  assert.ok(sync.performingSteps('versions', flags, cfg).includes('natives'), 'an upgrade re-heals natives');
  assert.ok(sync.performingSteps('host-alignment', flags, cfg).length > 0, 'alignHosts runs after every step');
  assert.ok(!sync.performingSteps('memory-pin', flags, cfg).includes('host-lifecycles'),
    'host-lifecycles runs every sync but only acts for a lifecycle host');
});

test('a real repair converges, and the next sync has nothing left to do', async () => {
  seedHome(offlineKitConfig({ aqe: false }));
  const aqeDir = paths.projectAqeDir(PROJECT);
  fs.mkdirSync(aqeDir, { recursive: true });
  fs.writeFileSync(path.join(aqeDir, 'brain.rvf'), 'x'.repeat(4096));
  const prev = process.env.RUFLO_AQE_RVF_MAX_BYTES;
  process.env.RUFLO_AQE_RVF_MAX_BYTES = '16';
  const aqeSection = (await import('../../src/commands/status/sections/aqe.mjs')).default;
  const collectAqe = async ({ cwd }) => aqeSection.collect({ cwd, cfg: loadKitConfig() });
  try {
    const first = await syncWith(collectAqe);
    assert.equal(first.result, 0, first.out);
    assert.match(first.out, /\[aqe\] sync quarantines them/);
    assert.match(first.out, /converged — no failing subsystems/);
    assert.ok(!fs.existsSync(path.join(aqeDir, 'brain.rvf')), 'the oversized store was quarantined');

    const second = await syncWith(collectAqe);
    assert.equal(second.result, 0, second.out);
    assert.doesNotMatch(second.out, /sync plan/, 'a converged machine plans nothing');
    // The only row left is the info-level "readiness unverified" reminder
    // (repair: manual). It is invisible to the needs-your-action list, so the
    // manual-step count that must agree with that list is zero (decision 10,
    // review-sync-exit.md minor 4): sync reports the machine healthy outright.
    assert.doesNotMatch(second.out, /item\(s\) need a manual step/);
    assert.match(second.out, /nothing to do — all subsystems healthy/);
  } finally {
    if (prev === undefined) delete process.env.RUFLO_AQE_RVF_MAX_BYTES;
    else process.env.RUFLO_AQE_RVF_MAX_BYTES = prev;
    rmrf(aqeDir);
  }
});

// ── --skip: one-run subsystem exclusions (decision D5) ───────────────────────

test('--skip is a repeatable string option the CLI parser accepts', async () => {
  const { parseArgs } = await import('node:util');
  const { values } = parseArgs({
    args: ['--skip', 'natives', '--skip', 'ruvnet-brain'], options: sync.options, strict: true,
  });
  assert.deepEqual(values.skip, ['natives', 'ruvnet-brain']);
});

test('--skip rejects an unknown subsystem, names the known ones, and runs nothing', async () => {
  seedHome();
  let collected = 0;
  const { result, out } = await syncWith(async () => { collected++; return []; }, { skip: ['natvies'] });
  assert.equal(result, 2, out);
  assert.match(out, /unknown --skip subsystem 'natvies'/);
  assert.match(out, /natives/, 'the error lists the names it accepts');
  assert.equal(collected, 0, 'a rejected flag never reaches the collector');
});

test('--skip removes the plan item, says so, and keeps the rest of the plan', async () => {
  seedHome();
  const rows = [
    { subsystem: 'aqe', level: 'fail', message: 'store oversized', fix: RVF_FIX, repair: 'sync' },
    { subsystem: 'daemons', level: 'warn', message: 'stale daemons', fix: 'sync reaps stale daemons', repair: 'sync' },
  ];
  const { result, out } = await syncWith(async () => rows, { 'dry-run': true, skip: ['aqe'] });
  assert.equal(result, 0, out);
  const planned = out.split('\n').filter((l) => l.trim().startsWith('•'));
  assert.equal(planned.length, 1, out);
  assert.match(planned[0], /\[daemons\]/);
  assert.match(out, /skipped by request: \[aqe\] sync quarantines them/);
});

test('--skip accepts a comma-separated list', async () => {
  seedHome();
  const rows = [
    { subsystem: 'aqe', level: 'fail', message: 'store oversized', fix: RVF_FIX, repair: 'sync' },
    { subsystem: 'daemons', level: 'warn', message: 'stale daemons', fix: 'sync reaps stale daemons', repair: 'sync' },
  ];
  const { result, out } = await syncWith(async () => rows, { 'dry-run': true, skip: ['aqe,daemons'] });
  assert.equal(result, 0, out);
  assert.doesNotMatch(out, /sync plan/);
  assert.match(out, /skipped by request: \[daemons\]/);
});

test('when every planned item is skipped, sync never claims the machine is healthy', async () => {
  seedHome();
  const rows = [{ subsystem: 'aqe', level: 'fail', message: 'store oversized', fix: RVF_FIX, repair: 'sync' }];
  const { result, out } = await syncWith(async () => rows, { skip: ['aqe'] });
  assert.equal(result, 0, out);
  assert.match(out, /nothing to do — 1 planned item\(s\) skipped by request/);
  assert.doesNotMatch(out, /all subsystems healthy/);
});

test('a skipped subsystem runs no step and is never counted as a failure', async () => {
  seedHome();
  const oversized = { subsystem: 'aqe', level: 'fail', message: 'store oversized', fix: RVF_FIX, repair: 'sync' };
  // npx's step only scans the sandbox npm cache; it keeps the apply phase
  // running. aqe still fails afterwards, but it was skipped by request.
  const npx = { subsystem: 'npx', level: 'warn', message: 'stale npx env', fix: 'sync prunes stale npx envs', repair: 'sync' };
  const { result, out } = await syncWith(twoPhase([oversized, npx], [oversized]), { skip: ['aqe'] });
  assert.equal(result, 0, out);
  assert.match(out, /npx: no stale envs/, 'the step that was not skipped ran');
  assert.doesNotMatch(out, /rvf:/, 'the aqe step never ran');
  assert.doesNotMatch(out, /unresolved:|still failing:/);
  assert.match(out, /skipped by request: \[aqe\]/);
});

// A skipped item is announced once, with the plan; the verdict does not repeat
// it. Without --no-upgrade, so the ruvnet-brain row reaches the plan at all.
const BRAIN_ROW = { subsystem: 'ruvnet-brain', level: 'warn', message: 'ruvnet-brain release v4.3.29 available', fix: 'sync refreshes the KB', repair: 'sync' };
const NPX_ROW = { subsystem: 'npx', level: 'warn', message: 'stale npx env', fix: 'sync prunes stale npx envs', repair: 'sync' };
const brainSkippedLines = (out) => out.match(/skipped by request: \[ruvnet-brain\]/g) ?? [];

test('--skip ruvnet-brain prints its skipped line once', async () => {
  seedHome();
  const prior = process.cwd();
  process.chdir(PROJECT);
  try {
    const { result, out } = await captureLog(() => sync.run({
      flags: FLAGS({ skip: ['ruvnet-brain'], yes: true }), pkgRoot: PKG_ROOT, collectFn: twoPhase([BRAIN_ROW, NPX_ROW], []),
      fetchLatest: async () => null, releaseDatesRunner: async () => ({ code: 1, stdout: '', stderr: 'offline (test)' }),
    }));
    assert.equal(result, 0, out);
    assert.match(out, /converged — no failing subsystems \(1 skipped by request\)/);
    assert.equal(brainSkippedLines(out).length, 1, out);
  } finally { process.chdir(prior); }
});

// A host probe that throws while sync refreshes host evidence before planning
// is reported, naming the host, and the sync goes on with the next host and
// with the plan (which then reads that host as ak last recorded it).
test('a host probe that fails before planning is reported by name and the sync continues', async () => {
  seedHome(offlineKitConfig({
    integrations: { version: 2, hosts: { claude: true, codex: true, opencode: false }, bindings: [] },
    routing: { version: 1, primaryHost: 'claude', routes: {} },
  }));
  const probed = [];
  const probes = {
    installState: async (h) => {
      probed.push(h.id);
      if (h.id === 'claude') throw new Error('claude probe exploded');
      return { method: 'external' };
    },
    executable: async () => ({ ok: true }),
    collectFacts: async () => { throw new Error('host setup probe exploded'); },
  };
  const prior = process.cwd();
  process.chdir(PROJECT);
  try {
    const { result, out } = await captureLog(() => sync.run({
      flags: FLAGS({ 'no-upgrade': true }), pkgRoot: PKG_ROOT, collectFn: async () => [],
      refreshHosts: (flags, cwd) => sync.refreshPlanHosts(flags, cwd, probes),
    }));
    assert.equal(result, 0, out);
    assert.deepEqual(probed, ['claude', 'codex'], 'the next host is still probed');
    assert.match(out, /⚠.*claude.*claude probe exploded/);
    assert.match(out, /⚠.*host setup.*host setup probe exploded/);
    assert.match(out, /nothing to do — all subsystems healthy/, 'the sync went on to plan');
  } finally { process.chdir(prior); }
});

test('--skip stops a step on its derived triggers too', () => {
  const cfg = { ...loadKitConfig(), security: true };
  const flags = FLAGS();
  const active = (subs, skip) => sync.activeSteps(new Set(subs), flags, cfg, new Set(skip));
  assert.ok(active(['versions'], []).includes('natives'), 'control: an upgrade re-heals natives');
  assert.ok(!active(['versions', 'security'], ['natives']).includes('natives'), 'natives stays off on versions/security');
  assert.ok(active(['versions', 'security'], ['natives']).includes('security'));
  assert.ok(!active(['routing', 'codex-mcp'], ['providers']).includes('providers'), 'providers stays off on routing/codex-mcp');
  assert.ok(!active(['versions'], ['statusline']).includes('statusline'));
});

test('a fix performed only by a skipped step is skipped with it, never unresolved', async () => {
  seedHome();
  const codex = { subsystem: 'codex-mcp', level: 'warn', message: 'no ruflo MCP in codex', fix: 'sync registers the ruflo MCP into codex', repair: 'sync' };
  const { out } = await syncWith(async () => [codex], { 'dry-run': true, skip: ['providers'] });
  assert.doesNotMatch(out, /sync plan/, out);
  assert.match(out, /skipped by request: \[codex-mcp\]/);
});

// correctness-skip-providers-false-unresolved: the codex-mcp subsystem has
// fixes of two kinds. Registering, migrating or retiring an MCP table is done
// only by the providers step; removing a recursive table is done by
// codex-mcp-repair. --skip providers must skip the first kind, not plan it.
test('--skip providers skips the codex-mcp fixes only the providers step performs', () => {
  const cfg = loadKitConfig();
  const flags = FLAGS();
  const codex = (fix, level = 'warn') => ({ subsystem: 'codex-mcp', level, message: 'm', fix, repair: 'sync' });
  const providerOnly = [
    codex('sync registers the ruflo MCP into codex'),
    codex('sync migrates it to workspace-pinned project memory'),
    codex('sync retires the legacy MCP entry'),
  ];
  const recursive = codex('sync removes the exact recursive [mcp_servers.codex] table after confirmation (backed up)', 'fail');
  const { plan, skipped } = sync.splitSkipped([...providerOnly, recursive], new Set(['providers']), flags, cfg);
  assert.deepEqual(skipped.map((p) => p.fix), providerOnly.map((p) => p.fix), 'nothing but the providers step performs these');
  assert.deepEqual(plan.map((p) => p.fix), [recursive.fix], 'codex-mcp-repair still removes a recursive table');

  const control = sync.splitSkipped(providerOnly, new Set(), flags, cfg);
  assert.equal(control.plan.length, 3, 'control: without --skip they are planned');
  const verdict = sync.convergenceVerdict({
    plan: [], after: providerOnly, state: { applyFailures: [] }, flags, cfg, skip: new Set(['providers']), skipped,
  });
  assert.deepEqual(verdict.unresolved, [], 'a skipped fix is never unresolved');
  assert.deepEqual(verdict.remaining, []);
});

// Follow-up (correctness-skip-providers-false-unresolved): a subsystem can now
// be partly skipped. The verdict must still hold its planned fixes to their
// promise; only the skipped (subsystem, fix) pairs are "skipped by request".
test('a partly skipped subsystem still proves the fixes that stayed planned', () => {
  const cfg = loadKitConfig();
  const flags = FLAGS();
  const recursive = { subsystem: 'codex-mcp', level: 'fail', message: 'recursive codex → codex mcp-server registration detected (user)',
    fix: 'sync removes the exact recursive [mcp_servers.codex] table after confirmation (backed up)', repair: 'sync' };
  const register = { subsystem: 'codex-mcp', level: 'warn', message: 'codex enabled but ruflo MCP not registered in codex',
    fix: 'sync registers the ruflo MCP into codex', repair: 'sync' };
  const skip = new Set(['providers']);
  const { plan, skipped } = sync.splitSkipped([recursive, register], skip, flags, cfg);
  assert.deepEqual(plan.map((p) => p.fix), [recursive.fix]);
  const verdict = sync.convergenceVerdict({ plan, after: [recursive, register], state: { applyFailures: [] }, flags, cfg, skip, skipped });
  assert.deepEqual(verdict.unresolved.map((u) => [u.fix, u.reason]), [[recursive.fix, 'not-converged']],
    'a planned repair that did not take is unresolved, not "skipped by request"');
  assert.deepEqual(verdict.remaining, []);
  assert.deepEqual(verdict.skipped.map((r) => r.fix), [register.fix]);
});

// correctness-skip-leaves-subsystem-touched: a skipped subsystem stays
// untouched even when a sibling step that serves it runs for another one.
test('--skip codex-mcp and --skip routing reach into the providers step', async () => {
  const step = sync.SYNC_STEPS.find((s) => s.id === 'providers');
  const runWith = async (skip) => {
    const seen = {};
    const convergeProviders = async (cfg, cwd, options) => {
      Object.assign(seen, options);
      // The pipeline's documented contract: a disabled step still reports, with null.
      for (const id of ['legacy-codex-mcp', 'ruflo-codex-mcp']) {
        if (options.codexMcp === false) await options.reporter(id, null);
      }
      seen.retired = options.migrateRoutes ? options.migrateRoutes(cfg) : 'default';
      return {};
    };
    await captureLog(() => step.run({
      cfg: loadKitConfig(), cwd: PROJECT, skip: new Set(skip), state: {}, report: () => {}, convergeProviders,
    }));
    return seen;
  };
  const control = await runWith([]);
  assert.equal(control.codexMcp, true, 'control: providers also converges the Codex MCP tables');
  assert.equal(control.seedRoutes, true);
  assert.equal(control.retired, 'default', 'control: retired routes are migrated');

  const noCodex = await runWith(['codex-mcp']);
  assert.equal(noCodex.codexMcp, false, '--skip codex-mcp must leave ~/.codex/config.toml alone');
  assert.equal(noCodex.seedRoutes, true);

  const noRouting = await runWith(['routing']);
  assert.equal(noRouting.seedRoutes, false, '--skip routing must not seed routes');
  assert.deepEqual(noRouting.retired, { changed: false, changes: [] }, '--skip routing must not rewrite retired routes');
  assert.equal(noRouting.codexMcp, true);
});

test('--skip statusline also skips the helper refresh that can replace the statusline', () => {
  const cfg = loadKitConfig();
  const active = (skip) => sync.activeSteps(new Set(['versions']), FLAGS(), cfg, new Set(skip));
  assert.ok(active([]).includes('ruflo-helpers'), 'control: an upgrade refreshes the generated helpers');
  assert.ok(!active(['statusline']).includes('ruflo-helpers'));
  assert.ok(active(['statusline']).includes('versions'), 'the upgrade itself still runs');
});

test('--skip opencode stops the lifecycle refresh an upgrade would trigger', async () => {
  const step = sync.SYNC_STEPS.find((s) => s.id === 'host-lifecycles');
  const cfg = { ...loadKitConfig(), integrations: { ...loadKitConfig().integrations, hosts: { claude: true, codex: false, opencode: true } } };
  const run = (skip) => captureLog(() => step.run({ cfg, subsystems: new Set(['versions']), skip: new Set(skip), pkgRoot: PKG_ROOT }));
  assert.match((await run([])).out, /opencode:/, 'control: an upgrade refreshes the opencode wiring');
  assert.doesNotMatch((await run(['opencode'])).out, /opencode:/);
});

test('every subsystem a sync step answers to is a name --skip accepts', () => {
  const known = new Set(sync.skippableSubsystems());
  for (const step of sync.SYNC_STEPS) {
    for (const [, name] of String(step.when).matchAll(/has\('([^']+)'\)/g)) {
      assert.ok(known.has(name), `step ${step.id} fires on '${name}', which --skip does not accept`);
    }
  }
  assert.ok(known.has('opencode'), 'lifecycle hosts are skippable');
  assert.ok(known.has('host-alignment'), 'the post-step host alignment is skippable');
  // Every opt-in managed, so each step's own enablement gate is open (ruvector
  // is managed only while registered as a Claude MCP server).
  seedHome();
  fs.writeFileSync(paths.claudeUserMcpPath(), JSON.stringify({ mcpServers: { ruvector: { command: 'ruvector' } } }));
  try {
    const cfg = {
      ...loadKitConfig(), agentBrowser: true, aqe: true, security: true, mcp: { register: true, excludeFamilies: [] },
      codexContext: { owned: true }, statusline: { codex: { preset: 'census' } },
      integrations: { ...loadKitConfig().integrations, hosts: { claude: true, codex: true, opencode: true } },
    };
    for (const name of known) {
      assert.ok(sync.performingSteps(name, FLAGS(), cfg).length > 0, `--skip ${name} names nothing sync does`);
    }
  } finally {
    rmrf(paths.claudeUserMcpPath());
  }
});

// ── --json: exactly one JSON result on stdout (decision D6) ──────────────────
// Each case runs sync in a child process so its real stdout and stderr can be
// read apart: stdout must parse as ONE JSON value, and the human lines must
// all be on stderr. The child inherits this file's sandboxed environment
// (HOME, XDG_*, npm cache, and a PATH with nothing on it).

const BIN = path.join(PKG_ROOT, 'bin', 'agentic-kit.mjs');
const moduleUrl = (rel) => pathToFileURL(path.join(PKG_ROOT, rel)).href;

/** Run sync.run({ flags }) in a child whose collector returns `first` for the
 *  plan and `after` for the proof (or throws). */
function syncChild({ first = [], after = [], flags = {}, throws = false }) {
  const root = fakeGlobalRoot(HOME, { ruflo: '9.9.9', 'agentic-qe': '9.9.9' });
  const script = `
    const paths = await import(${JSON.stringify(moduleUrl('src/lib/paths.mjs'))});
    paths._setGlobalRootForTest(${JSON.stringify(root)});
    const sync = await import(${JSON.stringify(moduleUrl('src/commands/sync.mjs'))});
    const { exitWhenFlushed } = await import(${JSON.stringify(moduleUrl('src/lib/output.mjs'))});
    const first = ${JSON.stringify(first)};
    const after = ${JSON.stringify(after)};
    let calls = 0;
    const collectFn = async () => {
      ${throws ? "throw new Error('collector exploded');" : ''}
      return calls++ === 0 ? first : after;
    };
    exitWhenFlushed(await sync.run({ flags: ${JSON.stringify(FLAGS({ 'no-upgrade': true, json: true, ...flags }))},
      pkgRoot: ${JSON.stringify(PKG_ROOT)}, collectFn,
      fetchLatest: async () => null, releaseDatesRunner: async () => ({ code: 1, stdout: '', stderr: 'offline (test)' }) }));
  `;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: PROJECT, env: spawnEnv(HOME), encoding: 'utf8', timeout: 120_000,
  });
}

/** Run the real CLI (`node bin/agentic-kit.mjs sync …`) against a fake npm prefix. */
function akSync(args) {
  const root = fakeGlobalRoot(HOME, { ruflo: '9.9.9', 'agentic-qe': '9.9.9' });
  return spawnSync(process.execPath, [BIN, 'sync', ...args], {
    cwd: PROJECT, encoding: 'utf8', timeout: 120_000,
    env: spawnEnv(HOME, { npm_config_prefix: path.dirname(root) }),
  });
}

/** stdout must hold exactly one JSON value; JSON.parse rejects anything else. */
function oneJson(child) {
  assert.ok(child.stdout.trim().startsWith('{'), `stdout is not a JSON object:\n${child.stdout}\n--- stderr:\n${child.stderr}`);
  return JSON.parse(child.stdout);
}

const SHAPE = ['plan', 'steps', 'unresolved', 'skipped', 'needsYourAction', 'converged', 'exitCode'];

test('--json: a run with an unresolved repair emits one JSON result and keeps human lines on stderr', () => {
  seedHome();
  const persisting = { subsystem: 'aqe', level: 'warn', message: 'store still oversized', fix: RVF_FIX, repair: 'sync' };
  const child = syncChild({ first: [persisting], after: [persisting] });
  const out = oneJson(child);
  assert.deepEqual(Object.keys(out), SHAPE);
  assert.equal(child.status, 1, child.stderr);
  assert.equal(out.exitCode, 1);
  assert.equal(out.converged, false);
  assert.deepEqual(out.plan, [{ subsystem: 'aqe', level: 'warn', message: 'store still oversized', fix: RVF_FIX, repair: 'sync' }]);
  const rvf = out.steps.find((s) => s.id === 'aqe-rvf');
  assert.ok(rvf, `the aqe step is listed: ${JSON.stringify(out.steps)}`);
  assert.equal(rvf.ok, true);
  assert.match(rvf.detail, /rvf: healthy/);
  assert.deepEqual(out.unresolved, [{ subsystem: 'aqe', fix: RVF_FIX, message: 'store still oversized', reason: 'not-converged' }]);
  assert.match(child.stderr, /sync plan \(1 action\(s\)\)/);
  assert.match(child.stderr, /unresolved: \[aqe\]/);
});

test('--json: a converged run with a skip reports the skipped item and exit 0', () => {
  seedHome();
  const oversized = { subsystem: 'aqe', level: 'fail', message: 'store oversized', fix: RVF_FIX, repair: 'sync' };
  const npx = { subsystem: 'npx', level: 'warn', message: 'stale npx env', fix: 'sync prunes stale npx envs', repair: 'sync' };
  const child = syncChild({ first: [oversized, npx], after: [], flags: { skip: ['aqe'] } });
  const out = oneJson(child);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(out.exitCode, 0);
  assert.equal(out.converged, true);
  assert.deepEqual(out.plan.map((p) => p.subsystem), ['npx']);
  assert.deepEqual(out.skipped.map((s) => s.subsystem), ['aqe']);
  assert.deepEqual(out.unresolved, []);
  assert.ok(out.steps.some((s) => s.id === 'npx' && s.ok), JSON.stringify(out.steps));
  assert.ok(!out.steps.some((s) => s.id === 'aqe-rvf'), 'a skipped step is not listed as run');
  assert.match(child.stderr, /converged — no failing subsystems/);
});

test('--json --skip ruvnet-brain keeps the skipped item in the JSON and prints its line once', () => {
  seedHome();
  const child = syncChild({ first: [BRAIN_ROW, NPX_ROW], after: [], flags: { 'no-upgrade': false, yes: true, skip: ['ruvnet-brain'] } });
  const out = oneJson(child);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(out.skipped, [BRAIN_ROW]);
  assert.deepEqual(out.plan.map((p) => p.subsystem), ['npx']);
  assert.equal(brainSkippedLines(child.stderr).length, 1, child.stderr);
});

test('--json: an error still yields exactly one JSON result, with the error and exit 1', () => {
  seedHome();
  const child = syncChild({ throws: true });
  const out = oneJson(child);
  assert.equal(child.status, 1, child.stderr);
  assert.equal(out.exitCode, 1);
  assert.equal(out.converged, null, 'no verdict was reached');
  assert.equal(out.error, 'collector exploded');
  assert.match(child.stderr, /collector exploded/);
});

test('--json --dry-run through the real CLI: plan on stdout as JSON, the listing on stderr', () => {
  seedHome();
  const before = snapshot(PROJECT);
  const child = akSync(['--json', '--dry-run']);
  const out = oneJson(child);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(Object.keys(out), SHAPE);
  assert.equal(out.exitCode, 0);
  assert.equal(out.converged, null, 'a dry run proves nothing');
  assert.deepEqual(out.steps, []);
  assert.ok(Array.isArray(out.plan) && out.plan.length > 0, 'the sandbox has something to plan');
  assert.ok(out.plan.every((p) => p.subsystem && p.fix && p.repair === 'sync'), JSON.stringify(out.plan));
  assert.match(child.stderr, /sync plan \(\d+ action\(s\)\)/);
  assertUnchanged(before, PROJECT, '`ak sync --json --dry-run` must not touch the project');
});

test('--json with a rejected --skip still answers in JSON on stdout', () => {
  seedHome();
  const child = akSync(['--json', '--skip', 'natvies']);
  const out = oneJson(child);
  assert.equal(child.status, 2, child.stderr);
  assert.equal(out.exitCode, 2);
  assert.equal(out.converged, null);
  assert.match(out.error, /unknown --skip subsystem 'natvies'/);
  assert.match(child.stderr, /unknown --skip subsystem/);
});

test('failed heal results are retained for the final convergence proof', () => {
  const state = { applyFailures: [] };
  sync.recordApplyFailure(state, 'ruvnet-brain', { ok: false, status: 'failed', detail: 'network unavailable' });
  sync.recordApplyFailure(state, 'natives', { ok: true, detail: 'healthy' });
  assert.deepEqual(state.applyFailures, [{ name: 'ruvnet-brain', detail: 'network unavailable' }]);
});

test('a package upgrade makes an enabled lifecycle host eligible for a same-run refresh', () => {
  assert.equal(sync.lifecycleRefreshRequired(new Set(['versions']), 'opencode'), true);
  assert.equal(sync.lifecycleRefreshRequired(new Set(['versions']), 'codex'), false);
  assert.equal(sync.lifecycleRefreshRequired(new Set(['opencode']), 'opencode'), true);
  assert.equal(sync.lifecycleRefreshRequired(new Set(), 'opencode'), false);
});

test('a Ruflo version upgrade explicitly refreshes generated helpers before the statusline heal', () => {
  const helpers = sync.SYNC_STEPS.findIndex((step) => step.id === 'ruflo-helpers');
  const statusline = sync.SYNC_STEPS.findIndex((step) => step.id === 'statusline');
  assert.ok(helpers > -1, 'sync needs a dedicated Ruflo generated-helper stage');
  assert.ok(helpers < statusline, 'Ruflo may replace statusline.cjs, so helpers refresh first');
  assert.equal(sync.SYNC_STEPS[helpers].when(new Set(['versions'])), true);
  assert.equal(sync.SYNC_STEPS[helpers].when(new Set()), false);
});

// #237 §4: sync forced the fresh-install path onto every existing Brain. The
// heal now chooses between the bundle's updater and an install from what is on
// disk, so the step must not override that choice.
test('the Brain sync step lets the heal choose update versus install', () => {
  const brain = sync.SYNC_STEPS.find((step) => step.id === 'ruvnet-brain');
  assert.ok(brain, 'sync keeps a Brain step');
  assert.doesNotMatch(String(brain.run), /force/, 'no forced fresh install from sync');
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

/** A real sync from the sandbox project. Its version lookups answer nothing:
 *  withOpencodeCli puts /usr/bin on PATH, where a real npm would otherwise
 *  query the registry. */
async function realSync() {
  const cwd = process.cwd();
  process.chdir(PROJECT);
  try {
    return await captureLog(() => sync.run({
      flags: FLAGS(), pkgRoot: PKG_ROOT,
      fetchLatest: async () => null, releaseDatesRunner: async () => ({ code: 1, stdout: '', stderr: 'offline (test)' }),
    }));
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

// a real (non-dry-run) sync forces host evidence fresh
// BEFORE the plan is read (refreshPlanHosts), so a cached row that has not
// yet gone stale (host-setup's 6h TTL) but is simply WRONG — here, claude
// went from "absent" to "on PATH" since it was last recorded — can never
// hide that from the plan, and the persisted evidence itself is corrected
// too (not just what happens to print).
test('sync (non-dry) force-refreshes host evidence too, so a fresh-but-wrong cache cannot hide a host that changed', async () => {
  const catalog = seedCatalog();
  seedHome(syncCfg(catalog), { ruflo: '9.9.9' });
  paths._setGlobalRootForTest(fakeSyncRoot());
  const claudeHost = HOSTS.find((h) => h.id === 'claude');
  const { out, after } = await withOpencodeCli(async () => {
    // Stale-but-fresh: a cache that has not yet hit its 6h TTL, claiming
    // claude is still absent — even though withOpencodeCli's fake `claude`
    // binary is on PATH right now (a real probe would see it as 'external').
    writeEvidence('host-install-method', claudeHost.id, {
      source: 'test',
      inputsKey: stableInputsKey({ id: claudeHost.id, bin: claudeHost.bin, pkg: claudeHost.pkg, PATH: process.env.PATH ?? '' }),
      inputs: { PATH: process.env.PATH ?? '', bin: claudeHost.bin },
      result: { method: 'absent', version: null },
    });
    const syncResult = await realSync();
    // Read the persisted evidence while the fake `claude` bin is still on
    // PATH — a read after PATH is restored would invalidate the inputsKey
    // and re-probe against a DIFFERENT PATH, proving nothing about this fix.
    return { ...syncResult, after: await hostInstallState(claudeHost, { refresh: false }) };
  });
  assert.doesNotMatch(out, /claude enabled but not installed/,
    'the plan must reflect the just-refreshed host state, not the stale-but-fresh cache');
  assert.equal(after.method, 'external', 'the persisted evidence itself must be corrected, not just what the plan happened to print');
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
