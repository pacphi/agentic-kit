// `ak system` — the machine footprint in the terminal (ADR-0025). Reading is
// always safe and spawn-free: the live census, the individually-known files,
// and whatever the last machine measurement persisted. The expensive walk
// (and the shared Maintenance/inventory refresh) only runs behind an explicit
// --refresh[=live|machine] (ADR-0063), through the same shared stage table
// `ak status` and `ak maintain` use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { captureLog, spawnEnv } from './helpers/home-sandbox.mjs';
import { tempDir } from './helpers/temp-dir.mjs';

import * as system from '../../src/commands/system.mjs';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = path.join(PKG_ROOT, 'bin', 'agentic-kit.mjs');
// A throwaway home/cwd: `system.mjs` is exercised entirely through injected
// fakes below, so these only back the spawned-CLI and spawned-child tests.
const HOME = tempDir('ak-system-cli-home');
const PROJECT = tempDir('ak-system-cli-project');

/** A collector double: only `.read()` and `.refreshDeep()`. Everything else a
 *  real refresh needs (Maintenance, the inventory, live checks, status's own
 *  re-check) is `deps.refreshStages`, injected separately so this file never
 *  builds a real Maintenance service or touches real state. */
function fakeCollector(overrides = {}) {
  const calls = [];
  return {
    calls,
    async read() { calls.push(['read']); return overrides.snapshot ?? { platform: 'test', marker: 'plain' }; },
    async refreshDeep(options) {
      calls.push(['refreshDeep', options]);
      return overrides.refreshDeep ?? { ok: true, persisted: { ok: true } };
    },
  };
}

// ── plain reads are spawn-free and never touch refreshDeep ─────────────────

test('a plain run never calls refreshDeep and reads the collector exactly once', async () => {
  const collector = fakeCollector();
  const r = await captureLog(() => system.run({ flags: {}, deps: { collector } }));
  assert.equal(r.result, 0);
  assert.deepEqual(collector.calls, [['read']]);
});

test('--json with no --refresh prints the snapshot verbatim, with no "refresh" key', async () => {
  const collector = fakeCollector({ snapshot: { platform: 'test', marker: 'plain' } });
  const r = await captureLog(() => system.run({ flags: { json: true }, deps: { collector } }));
  assert.equal(r.result, 0);
  const parsed = JSON.parse(r.out);
  assert.deepEqual(parsed, { platform: 'test', marker: 'plain' });
  assert.ok(!('refresh' in parsed), 'JSON carries "refresh" only when a refresh actually ran');
});

test('a plain run ignores a stray positional, as ak status does', async () => {
  const collector = fakeCollector();
  const r = await captureLog(() => system.run({ flags: {}, positionals: ['extra'], deps: { collector } }));
  assert.notEqual(r.result, 2);
  assert.deepEqual(collector.calls, [['read']]);
});

// ── request validation, before any stage runs ───────────────────────────────

test('a bad refresh strength is a usage error; nothing runs', async () => {
  const collector = fakeCollector();
  const r = await captureLog(() => system.run({ flags: { refresh: 'bogus' }, deps: { collector } }));
  assert.equal(r.result, 2);
  assert.match(r.out, /✗ ak system: --refresh=bogus is not a refresh strength/);
  assert.deepEqual(collector.calls, []);
});

test('--project-trees without --refresh=machine is a usage error', async () => {
  const collector = fakeCollector();
  const r = await captureLog(() => system.run({ flags: { 'project-trees': true }, deps: { collector } }));
  assert.equal(r.result, 2);
  assert.match(r.out, /--project-trees needs --refresh=machine/);
  assert.deepEqual(collector.calls, []);
});

test('a refresh takes no positional; a strength name gets the one-token spelling hint', async () => {
  const collector = fakeCollector();
  const stray = await captureLog(() => system.run({
    flags: { refresh: '' }, positionals: ['extra'], deps: { collector },
  }));
  assert.equal(stray.result, 2);
  assert.match(stray.out, /^✗ ak system: unexpected argument 'extra'$/m);

  const strength = await captureLog(() => system.run({
    flags: { refresh: '' }, positionals: ['machine'], deps: { collector },
  }));
  assert.equal(strength.result, 2);
  assert.match(strength.out, /^✗ ak system: unexpected argument 'machine' — write --refresh=machine$/m);
  assert.deepEqual(collector.calls, [], 'no stage and no read runs when the request is refused');
});

// ── --refresh runs the shared stages, then reads the (same) collector ──────

test('--refresh runs the shared stages, then reads the collector; one human line per stage', async () => {
  const calls = [];
  const refreshStages = {
    maintenance: async (ctx) => { calls.push(['maintenance', ctx.strength]); return { ok: true, detail: 'checked 1 of 1 providers' }; },
    inventory: async () => { calls.push(['inventory']); return { ok: true }; },
    local: async () => { calls.push(['local']); return { ok: true }; },
  };
  const collector = fakeCollector({ snapshot: { platform: 'test', marker: 'refreshed' } });
  const r = await captureLog(() => system.run({ flags: { refresh: '' }, deps: { collector, refreshStages } }));
  assert.equal(r.result, 0);
  assert.deepEqual(calls, [['maintenance', 'local'], ['inventory'], ['local']]);
  assert.deepEqual(collector.calls, [['read']], 'the machine stage never runs at the local strength');
  assert.match(r.out, /^✓ Refreshing Maintenance evidence \(\d+ ms\): checked 1 of 1 providers$/m);
  assert.match(r.out, /^✓ Rebuilding the inventory/m);
  assert.match(r.out, /^✓ Re-checking local evidence and versions/m);
  assert.match(r.out, /ak system — machine footprint/);
});

test('a machine refresh runs machine, maintenance, inventory, local in order; the machine stage sees --project-trees', async () => {
  const calls = [];
  const refreshStages = {
    machine: async (ctx) => { calls.push(['machine', ctx.projectTrees]); return { ok: true }; },
    maintenance: async () => { calls.push(['maintenance']); return { ok: true }; },
    inventory: async () => { calls.push(['inventory']); return { ok: true }; },
    local: async () => { calls.push(['local']); return { ok: true }; },
  };
  const collector = fakeCollector();
  const r = await captureLog(() => system.run({
    flags: { refresh: 'machine', 'project-trees': true }, deps: { collector, refreshStages },
  }));
  assert.equal(r.result, 0);
  assert.deepEqual(calls, [['machine', true], ['maintenance'], ['inventory'], ['local']]);
  assert.deepEqual(collector.calls, [['read']], 'system.mjs itself never calls refreshDeep — the machine stage does');
});

test('a failed refresh stage exits 1 (not 2); the collector is still read afterward', async () => {
  const refreshStages = {
    machine: async () => ({ ok: false, detail: 'walk failed' }),
    maintenance: async () => ({ ok: true }),
    inventory: async () => ({ ok: true }),
    local: async () => ({ ok: true }),
  };
  const collector = fakeCollector();
  const r = await captureLog(() => system.run({ flags: { refresh: 'machine' }, deps: { collector, refreshStages } }));
  assert.equal(r.result, 1);
  assert.deepEqual(collector.calls, [['read']]);
});

// ── --json + --refresh: stdout carries exactly one JSON object ─────────────
// Spawned: system.mjs swaps process.stdout.write for the duration of the
// refresh under --json, which must not happen inside this test file's own
// process.

const moduleUrl = (rel) => pathToFileURL(path.join(PKG_ROOT, rel)).href;

/** The maintenance stage prints through the shared helpers, as a real stage
 *  can — under --json that output must land on stderr, never stdout. */
const FAKE_STAGES = `{
  machine: async () => ({ ok: FAIL_MACHINE ? false : true, detail: FAIL_MACHINE ? 'walk failed' : null }),
  maintenance: async () => { output.ok('maintenance evidence (fake)'); return { ok: true, detail: 'checked 1 of 1 providers' }; },
  inventory: async () => ({ ok: true }),
  local: async () => ({ ok: true }),
}`;

function systemChild(flags, { failMachine = false } = {}) {
  const script = `
    const system = await import(${JSON.stringify(moduleUrl('src/commands/system.mjs'))});
    const output = await import(${JSON.stringify(moduleUrl('src/lib/output.mjs'))});
    const { exitWhenFlushed } = output;
    const FAIL_MACHINE = ${failMachine};
    const collector = {
      read: async () => ({ platform: 'test', marker: 'child' }),
      refreshDeep: async () => ({ ok: true, persisted: { ok: true } }),
    };
    const refreshStages = ${FAKE_STAGES};
    exitWhenFlushed(await system.run({ flags: ${JSON.stringify(flags)}, positionals: [],
      deps: { collector, refreshStages } }));
  `;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: PROJECT, env: spawnEnv(HOME, { NO_COLOR: '1' }), encoding: 'utf8', timeout: 120_000,
  });
}

/** stdout must hold exactly one JSON value; JSON.parse rejects anything else. */
function oneJson(child) {
  assert.ok(child.stdout.trim().startsWith('{'), `stdout is not a JSON object:\n${child.stdout}\n--- stderr:\n${child.stderr}`);
  return JSON.parse(child.stdout);
}

test('--refresh --json prints one JSON object; stage lines go to stderr, none on stdout', () => {
  const child = systemChild({ refresh: '', json: true });
  const parsed = oneJson(child);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(parsed.platform, 'test');
  assert.equal(parsed.refresh.strength, 'local');
  assert.equal(parsed.refresh.ok, true);
  assert.deepEqual(parsed.refresh.stages.map(({ id, state }) => [id, state]),
    [['maintenance', 'done'], ['inventory', 'done'], ['local', 'done']]);
  assert.match(child.stderr, /^✓ maintenance evidence \(fake\)$/m, 'what a stage itself prints goes to stderr');
  // The JSON payload legitimately carries the stage LABEL text ("Refreshing
  // Maintenance evidence") as data; what must never reach stdout is the
  // stage's own self-print or a printed (✓-prefixed) per-stage line.
  assert.doesNotMatch(child.stdout, /maintenance evidence \(fake\)|^✓ Refreshing Maintenance evidence/m,
    'no stage output and no per-stage line print under --json');
});

test('a failed machine stage under --json exits 1; the JSON still carries the snapshot', () => {
  const child = systemChild({ refresh: 'machine', json: true }, { failMachine: true });
  const parsed = oneJson(child);
  assert.equal(child.status, 1, child.stderr);
  assert.equal(parsed.refresh.ok, false);
  assert.deepEqual(parsed.refresh.stages.map(({ id, state }) => [id, state]),
    [['machine', 'failed'], ['maintenance', 'skipped'], ['inventory', 'skipped'], ['local', 'done']]);
  assert.equal(parsed.platform, 'test');
});

// ── the real CLI: the retired --deep flag and the help surface ─────────────

test('the retired --deep flag gets the parser\'s generic unknown-option error', () => {
  const r = spawnSync(process.execPath, [BIN, 'system', '--deep'], { encoding: 'utf8', env: spawnEnv(HOME) });
  assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
  const error = r.stdout.split('\n').find((l) => l.includes('Unknown option')) ?? '';
  assert.match(error, /^✗ ak system: Unknown option '--deep'\. To specify a positional argument/);
  assert.doesNotMatch(error, /did you mean|is now|renamed|retired|no longer/i, 'no alias and no hint');
});

test('ak system --help documents only the current spellings', () => {
  const r = spawnSync(process.execPath, [BIN, 'system', '--help'], { encoding: 'utf8', env: spawnEnv(HOME) });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\[--refresh\[=live\|machine\]\] \[--project-trees\] \[--json\]/);
  assert.doesNotMatch(r.stdout, /--deep\b/, 'only the current spellings');
});
