// The one refresh operation (ADR-0063): a bare `--refresh` and its `live` and
// `machine` strengths run one ordered stage table, and every command that
// takes the flag shares it. These tests hold the table, the parsing of the
// flag, the stage runner's order and failure rules, and the CLI stage set's
// wiring to the collector, Maintenance, the inventory, the live checks and
// status's own re-check. Every stage is injected: a real Maintenance service
// or management facade writes `<state>/agentic-kit/maintenance/`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sandboxHome, assertSandboxed, captureLog, rmrf, sandboxProject, writeKitConfig, offlineKitConfig,
} from './helpers/home-sandbox.mjs';

const HOME = sandboxHome('ak-refresh');
const PROJECT = sandboxProject('ak-refresh');
after(() => rmrf(HOME, PROJECT));
const paths = await import('../../src/lib/paths.mjs');
const {
  REFRESH_STRENGTHS, REFRESH_OPTIONS, REFRESH_STAGES, normalizeBareRefresh, refreshRequestFromFlags, stagesFor,
  runRefresh, cliRefreshStages, printRefreshStage,
} = await import('../../src/lib/refresh.mjs');
const { loadKitConfig } = await import('../../src/lib/config.mjs');
assertSandboxed(paths, HOME);
writeKitConfig(HOME, offlineKitConfig());

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REFRESH_SOURCE = path.join(PKG_ROOT, 'src', 'lib', 'refresh.mjs');

test('the strengths, options and stage table are the shared vocabulary', () => {
  assert.deepEqual(REFRESH_STRENGTHS, ['local', 'live', 'machine']);
  assert.deepEqual(REFRESH_OPTIONS, {
    refresh: { type: 'string' },
    'project-trees': { type: 'boolean', default: false },
  });
  assert.deepEqual(REFRESH_STAGES.map(({ id, label, runsAt }) => [id, label, runsAt]), [
    ['machine', 'Measuring the machine', ['machine']],
    ['maintenance', 'Refreshing Maintenance evidence', ['local', 'live', 'machine']],
    ['inventory', 'Rebuilding the inventory', ['local', 'live', 'machine']],
    ['live', 'Running live checks', ['live']],
    ['local', 'Re-checking local evidence and versions', ['local', 'live', 'machine']],
  ]);
  assert.ok(Object.isFrozen(REFRESH_STRENGTHS) && Object.isFrozen(REFRESH_OPTIONS) && Object.isFrozen(REFRESH_STAGES));
});

test('normalizeBareRefresh', () => {
  assert.deepEqual(normalizeBareRefresh(['--refresh']), ['--refresh=']);
  assert.deepEqual(normalizeBareRefresh(['--refresh', '--json']), ['--refresh=', '--json']);
  assert.deepEqual(normalizeBareRefresh(['--refresh', 'report']), ['--refresh=', 'report']); // never consumes a positional
  assert.deepEqual(normalizeBareRefresh(['--refresh=live']), ['--refresh=live']);
  assert.deepEqual(normalizeBareRefresh(['--', '--refresh']), ['--', '--refresh']);
  assert.deepEqual(normalizeBareRefresh(['--json', '--refresh', '--', '--refresh']), ['--json', '--refresh=', '--', '--refresh']);
  assert.deepEqual(normalizeBareRefresh(['--refreshx', '--refresh-inventory']), ['--refreshx', '--refresh-inventory'],
    'only the exact token is rewritten');
});

test('refreshRequestFromFlags', () => {
  const none = { strength: null, projectTrees: false, only: [] };
  assert.deepEqual(refreshRequestFromFlags({}), none);
  assert.deepEqual(refreshRequestFromFlags({ refresh: undefined }), none);
  assert.deepEqual(refreshRequestFromFlags({ refresh: false }), none);
  for (const bare of ['', true, 'local']) {
    assert.deepEqual(refreshRequestFromFlags({ refresh: bare }), { strength: 'local', projectTrees: false, only: [] },
      `${JSON.stringify(bare)} is the local strength`);
  }
  assert.deepEqual(refreshRequestFromFlags({ refresh: 'live' }), { strength: 'live', projectTrees: false, only: [] });
  assert.deepEqual(refreshRequestFromFlags({ refresh: 'machine' }), { strength: 'machine', projectTrees: false, only: [] });
  assert.deepEqual(refreshRequestFromFlags({ refresh: 'machine', 'project-trees': true }),
    { strength: 'machine', projectTrees: true, only: [] });

  const bogus = refreshRequestFromFlags({ refresh: 'bogus' });
  assert.equal(typeof bogus.error, 'string');
  assert.match(bogus.error, /bogus/);
  assert.match(bogus.error, /=live or =machine/);
  for (const flags of [{ 'project-trees': true }, { refresh: '', 'project-trees': true }, { refresh: 'live', 'project-trees': true }]) {
    assert.deepEqual(refreshRequestFromFlags(flags), { error: '--project-trees needs --refresh=machine' });
  }
});

test('stagesFor', () => {
  assert.deepEqual(stagesFor('local'), ['maintenance', 'inventory', 'local']);
  assert.deepEqual(stagesFor('live'), ['maintenance', 'inventory', 'live', 'local']);
  assert.deepEqual(stagesFor('machine'), ['machine', 'maintenance', 'inventory', 'local']);
});

/** A stage map whose every stage records its call and returns `<id>-result`;
 *  `overrides` replaces single stages. */
function spyStages(log, overrides = {}) {
  return Object.fromEntries(REFRESH_STAGES.map(({ id }) => [id, overrides[id] ?? (async (ctx) => {
    log.push({ id, ctx });
    return { ok: true, detail: null, result: `${id}-result` };
  })]));
}
const tick = () => { let t = 0; return () => (t += 5); };
const states = (outcome) => outcome.stages.map(({ id, state }) => `${id}:${state}`);

test('runRefresh runs stages in order and reports each', async () => {
  const log = [];
  const events = [];
  const outcome = await runRefresh({ strength: 'live', stages: spyStages(log), onStage: (e) => events.push(e), now: tick() });
  assert.deepEqual(log.map(({ id }) => id), ['maintenance', 'inventory', 'live', 'local']);
  assert.deepEqual(events.map(({ id, state }) => `${id}:${state}`), [
    'maintenance:running', 'maintenance:done', 'inventory:running', 'inventory:done',
    'live:running', 'live:done', 'local:running', 'local:done',
  ]);
  assert.deepEqual(events[0], { id: 'maintenance', label: 'Refreshing Maintenance evidence', state: 'running', detail: null, elapsedMs: 0 });
  assert.deepEqual(events[1], { id: 'maintenance', label: 'Refreshing Maintenance evidence', state: 'done', detail: null, elapsedMs: 5 });
  assert.equal(outcome.strength, 'live');
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.stages.map(({ id, label, state, detail, elapsedMs, result }) => ({ id, label, state, detail, elapsedMs, result })),
    ['maintenance', 'inventory', 'live', 'local'].map((id) => ({
      id, label: REFRESH_STAGES.find((s) => s.id === id).label, state: 'done', detail: null, elapsedMs: 5, result: `${id}-result`,
    })));
  const local = log.find(({ id }) => id === 'local').ctx;
  assert.equal(local.strength, 'live');
  assert.equal(local.projectTrees, false);
  assert.deepEqual(local.only, []);
  assert.deepEqual(local.results, { maintenance: 'maintenance-result', inventory: 'inventory-result', live: 'live-result' },
    'a stage sees the results of the stages before it');
  assert.deepEqual(log[0].ctx.results, {});
});

test('a failed machine stage skips maintenance and inventory; local still runs; ok false', async () => {
  const log = [];
  const outcome = await runRefresh({
    strength: 'machine', projectTrees: true, now: tick(),
    stages: spyStages(log, { machine: async (ctx) => { log.push({ id: 'machine', ctx }); return { ok: false, detail: 'walk failed' }; } }),
  });
  assert.deepEqual(log.map(({ id }) => id), ['machine', 'local']);
  assert.equal(log[0].ctx.projectTrees, true);
  assert.deepEqual(states(outcome), ['machine:failed', 'maintenance:skipped', 'inventory:skipped', 'local:done']);
  assert.equal(outcome.stages[0].detail, 'walk failed');
  for (const skipped of outcome.stages.slice(1, 3)) {
    assert.match(skipped.detail, /machine/);
    assert.equal(skipped.elapsedMs, 0);
  }
  assert.equal(outcome.ok, false);
});

test('a throwing stage is failed with its message; later independent stages still run', async () => {
  const log = [];
  const events = [];
  const outcome = await runRefresh({
    strength: 'local', now: tick(), onStage: (e) => events.push(`${e.id}:${e.state}`),
    stages: spyStages(log, { maintenance: async () => { throw new Error('provider scan exploded'); } }),
  });
  assert.deepEqual(states(outcome), ['maintenance:failed', 'inventory:done', 'local:done']);
  assert.equal(outcome.stages[0].detail, 'provider scan exploded');
  assert.equal(outcome.ok, false);
  assert.deepEqual(events, ['maintenance:running', 'maintenance:failed', 'inventory:running', 'inventory:done', 'local:running', 'local:done']);
  assert.ok(!('maintenance' in log.find(({ id }) => id === 'local').ctx.results), 'a failed stage has no result');
});

test('runRefresh refuses an unknown strength or a missing stage', async () => {
  await assert.rejects(runRefresh({ strength: 'bogus', stages: spyStages([]) }), TypeError);
  const { local: _local, ...partial } = spyStages([]);
  await assert.rejects(runRefresh({ strength: 'local', stages: partial }), /local/);
});

test('the refresh operation can never reach the paid connection check (R7)', () => {
  // 6c-1 adds src/lib/dashboard/refresh-api.mjs to this list.
  for (const file of [REFRESH_SOURCE]) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /checkConnection|host-health-connected/, file);
  }
});

test('refresh.mjs is cheap to import: its only static import is the output helpers', () => {
  const source = fs.readFileSync(REFRESH_SOURCE, 'utf8');
  const staticImports = [...source.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
  assert.deepEqual(staticImports, ['./output.mjs'],
    'status, live checks, footprint, maintenance and config load lazily inside cliRefreshStages');
});

// ── the CLI stage set ────────────────────────────────────────────────────────

function fakeDeps({ deep = { ok: true, persisted: { ok: true } } } = {}) {
  const calls = [];
  const rows = [{ subsystem: 'versions', level: 'ok', message: 'fake', fix: null, repair: null }];
  const live = [{ id: 'memory', status: 'passed', reason: null, elapsedMs: 3 }];
  const deps = {
    collector: { refreshDeep: async (...args) => { calls.push(['refreshDeep', ...args]); return deep; } },
    maintenance: { scan: async (options) => { calls.push(['scan', options]); return { scan: { providersChecked: 2, providersTotal: 3 } }; } },
    management: {
      refreshInventory: async (options) => { calls.push(['refreshInventory', options]); return { inventoryId: 'inv-1' }; },
      rebuildAfterMeasurement: async (...args) => { calls.push(['rebuildAfterMeasurement', ...args]); return { inventory: { inventoryId: 'inv-2' } }; },
    },
    runLive: async (options) => { calls.push(['runLive', options]); return live; },
    collect: async (options) => { calls.push(['collect', options]); return rows; },
  };
  return { calls, rows, live, deps };
}

test('cliRefreshStages: machine measures (project trees on request), rebuilds after the measurement, re-checks status', async () => {
  const { calls, rows, deps } = fakeDeps();
  const stages = cliRefreshStages({ cwd: PROJECT, pkgRoot: PKG_ROOT, deps });
  const outcome = await runRefresh({ strength: 'machine', projectTrees: true, stages });
  assert.deepEqual(states(outcome), ['machine:done', 'maintenance:done', 'inventory:done', 'local:done']);
  assert.deepEqual(calls, [
    ['refreshDeep', { includeProjectTrees: true }],
    ['scan', { deep: false }],
    ['rebuildAfterMeasurement'],
    ['collect', { pkgRoot: PKG_ROOT, cwd: PROJECT, refresh: true }],
  ]);
  assert.equal(outcome.stages.at(-1).result, rows, 'the local stage returns the status rows');
  assert.equal(outcome.ok, true);

  const plain = fakeDeps();
  await runRefresh({ strength: 'machine', stages: cliRefreshStages({ cwd: PROJECT, pkgRoot: PKG_ROOT, deps: plain.deps }) });
  assert.deepEqual(plain.calls[0], ['refreshDeep', undefined], 'without --project-trees the collector keeps its own default');
});

test('cliRefreshStages: a measurement that could not be saved fails the machine stage', async () => {
  const { calls, deps } = fakeDeps({ deep: { ok: true, persisted: { ok: false, error: 'EACCES' }, error: 'snapshot not persisted: EACCES' } });
  const outcome = await runRefresh({ strength: 'machine', stages: cliRefreshStages({ cwd: PROJECT, pkgRoot: PKG_ROOT, deps }) });
  assert.deepEqual(states(outcome), ['machine:failed', 'maintenance:skipped', 'inventory:skipped', 'local:done']);
  assert.equal(outcome.stages[0].detail, 'snapshot not persisted: EACCES');
  assert.deepEqual(calls.map(([name]) => name), ['refreshDeep', 'collect']);

  const failed = fakeDeps({ deep: { ok: false, persisted: null, error: 'ETIMEDOUT' } });
  const second = await runRefresh({ strength: 'machine', stages: cliRefreshStages({ cwd: PROJECT, pkgRoot: PKG_ROOT, deps: failed.deps }) });
  assert.equal(second.stages[0].state, 'failed');
  assert.equal(second.stages[0].detail, 'ETIMEDOUT');
});

test('cliRefreshStages: live runs the live checks with this config and cwd; local refreshes the inventory', async () => {
  const { calls, live, deps } = fakeDeps();
  const outcome = await runRefresh({ strength: 'live', stages: cliRefreshStages({ cwd: PROJECT, pkgRoot: PKG_ROOT, deps }) });
  assert.deepEqual(calls.map(([name]) => name), ['scan', 'refreshInventory', 'runLive', 'collect']);
  assert.deepEqual(calls[1], ['refreshInventory', { deep: false }]);
  const [, liveOptions] = calls[2];
  assert.equal(liveOptions.cwd, PROJECT);
  assert.deepEqual(liveOptions.cfg, loadKitConfig(), 'the live checks read the kit config, as `ak status` always passed it');
  assert.equal(outcome.stages.find((s) => s.id === 'live').result, live);
  assert.equal(outcome.ok, true, 'a failed live check is a finding, not a failed stage');
});

// ── the CLI renderer ─────────────────────────────────────────────────────────

test('printRefreshStage prints one line per finished stage', async () => {
  const label = 'Refreshing Maintenance evidence';
  const { out } = await captureLog(() => {
    printRefreshStage({ id: 'maintenance', label, state: 'running', detail: null, elapsedMs: 0 });
  });
  assert.equal(out, '', 'a running stage prints nothing');
  const line = async (event) => (await captureLog(() => printRefreshStage({ id: 'maintenance', label, ...event }))).out;
  assert.match(await line({ state: 'done', detail: null, elapsedMs: 3_200 }), /^✓ Refreshing Maintenance evidence \(3 s\)$/);
  assert.match(await line({ state: 'done', detail: 'checked 2 of 3 providers', elapsedMs: 40 }),
    /^✓ Refreshing Maintenance evidence \(40 ms\): checked 2 of 3 providers$/);
  assert.match(await line({ state: 'failed', detail: 'provider scan exploded', elapsedMs: 1_000 }),
    /^⚠ {2}Refreshing Maintenance evidence failed \(1 s\): provider scan exploded$/);
  assert.match(await line({ state: 'skipped', detail: 'the machine measurement failed', elapsedMs: 0 }),
    /^ℹ {2}Refreshing Maintenance evidence skipped: the machine measurement failed$/);
});
