// Regression (audit #1 — provider-convergence pipeline pasted 3x): the
// applyHosts → seedActivityRoutesIfMultiHost → applyAqeRouter → retireCodexMcp
// → ensureRufloMcpInCodex → applyProviders pipeline is duplicated across
// host.mjs (`ak host pick`), sync.mjs (`ak sync`), and setup.mjs
// (`ak setup --project`). Only sync called migrateRetiredRoutesInConfig, so
// `ak host pick` and `ak setup` persisted a route naming a withdrawn model
// that only the next `ak sync` repaired.
//
// routing.mjs's RETIRED_MODELS table is intentionally empty (no first-party
// withdrawal notice is currently cited), so a real retirement cannot be
// observed end-to-end today. `pick()`/`run_project()` accept an injectable
// `migrateRoutes` (defaulting to the real migrateRetiredRoutesInConfig)
// purely as a test seam — production callers never pass it — so this suite
// can prove the wiring and the save-on-change policy without depending on a
// live entry in that table.
//
// In-process against the sandboxed HOME (see helpers/home-sandbox.mjs) —
// `pick()` must NEVER touch the real HOME (the historic #137 trap: a spawned
// pick() with an undefined cwd wrote into the real repository).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  sandboxHome, assertSandboxed, sandboxProject, rmrf, captureLog,
} from './helpers/home-sandbox.mjs';

const HOME = sandboxHome('ak-routing-retirement');
const paths = await import('../../src/lib/paths.mjs');
const host = await import('../../src/commands/x/host.mjs');
const setup = await import('../../src/commands/setup.mjs');
const { loadKitConfig } = await import('../../src/lib/config.mjs');
assertSandboxed(paths, HOME);

/** Executable no-op shims — present on PATH so `have()`/`hostInstallState`
 *  see an externally-installed CLI (never an 'absent' host, so pick/setup
 *  never attempt a real `npm install`) without needing a working binary. */
function fakeBinDir(names) {
  const bin = path.join(HOME, `fake-bin-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(bin, { recursive: true });
  for (const name of names) {
    fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, `${name}.cmd`), '@echo off\r\nexit /b 0\r\n');
    fs.writeFileSync(path.join(bin, `${name}.ps1`), 'exit 0\r\n');
  }
  return bin;
}

async function withFakePath(names, fn) {
  const bin = fakeBinDir(names);
  const prev = process.env.PATH;
  process.env.PATH = [bin, '/usr/bin', '/bin'].join(path.delimiter);
  try {
    return await fn();
  } finally {
    process.env.PATH = prev;
    rmrf(bin);
  }
}

/** A fake `migrateRetiredRoutesInConfig` shaped exactly like the real one:
 *  rewrites a seeded route naming `from` to `to`, records the call, and
 *  returns the same {changed, changes} contract. Lets the test simulate the
 *  exact scenario RETIRED_MODELS is currently empty for. */
function fakeMigrateThatRetires(activity, from, to) {
  const calls = [];
  const migrate = (cfg) => {
    calls.push(structuredClone(cfg.routing.routes));
    const entry = cfg.routing.routes[activity];
    if (!entry || entry.model !== from || entry.provenance !== 'seeded') {
      return { changed: false, changes: [] };
    }
    entry.model = to;
    return {
      changed: true,
      changes: [{
        activity, field: 'model', from, to, retiresOn: '2099-01-01', provenance: 'seeded', rewritten: true,
      }],
    };
  };
  return { migrate, calls };
}

function baseCfg(routes) {
  return {
    integrations: {
      version: 2, hosts: { claude: true, codex: false, opencode: false }, bindings: [],
    },
    routing: { version: 1, primaryHost: 'claude', routes },
    providers: {
      aqeProvider: null, aqeFallback: [], models: [], maxBudgetUsd: null,
    },
    versionCheck: { last: Date.now(), seen: {}, self: { last: Date.now(), best: null } },
  };
}

function seedKitConfig(cfg) {
  const dir = path.join(HOME, '.config', 'agentic-kit');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'kit.json'), `${JSON.stringify(cfg, null, 2)}\n`);
}

test('ak host pick heals a retired seeded route instead of leaving it for the next sync', async () => {
  const project = sandboxProject('ak-pick-retirement');
  seedKitConfig(baseCfg({ testing: { host: 'claude', model: 'retired-model-x', provenance: 'seeded' } }));
  const { migrate, calls } = fakeMigrateThatRetires('testing', 'retired-model-x', 'replacement-model');

  const { result, out } = await withFakePath(['claude'], () => captureLog(() => host.pick({
    flags: { host: 'claude', yes: true }, cwd: project, pkgRoot: null, migrateRoutes: migrate,
  })));

  assert.equal(calls.length, 1, `pick() must run the shared retirement-migration step\n${out}`);
  assert.match(out, /routing: testing model: retired-model-x → replacement-model \(retires 2099-01-01\)/);
  const saved = loadKitConfig();
  assert.equal(saved.routing.routes.testing.model, 'replacement-model',
    'pick() must persist the migrated route, not leave the retired model for `ak sync` to repair');
  assert.equal(result, 0, out);
  rmrf(project);
});

test('ak host pick reports (but never rewrites) a user pin on a retired model', async () => {
  const project = sandboxProject('ak-pick-retirement-user-pin');
  seedKitConfig(baseCfg({ testing: { host: 'claude', model: 'retired-model-x', provenance: 'user' } }));
  const calls = [];
  const migrate = (cfg) => {
    calls.push(1);
    const entry = cfg.routing.routes.testing;
    if (entry?.model !== 'retired-model-x') return { changed: false, changes: [] };
    return {
      changed: false,
      changes: [{
        activity: 'testing', field: 'model', from: 'retired-model-x', to: 'replacement-model',
        retiresOn: '2099-01-01', provenance: 'user', rewritten: false,
      }],
    };
  };

  const { out } = await withFakePath(['claude'], () => captureLog(() => host.pick({
    flags: { host: 'claude', yes: true }, cwd: project, pkgRoot: null, migrateRoutes: migrate,
  })));

  assert.equal(calls.length, 1);
  assert.match(out, /routing: testing model pins retired-model-x \(retires 2099-01-01\) — user pin kept; ak runs replacement-model/);
  const saved = loadKitConfig();
  assert.equal(saved.routing.routes.testing.model, 'retired-model-x',
    'a user pin must never be rewritten on disk, only reported');
  rmrf(project);
});

/** Exit-0 shims for `ruflo`/`claude`, the only two binaries run_project()'s
 *  non-dry-run path spawns before reaching the 9.5 provider-wiring block. */
async function withProjectCli(fn) {
  const bin = path.join(HOME, `fake-proj-bin-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(bin, { recursive: true });
  for (const name of ['ruflo', 'claude']) {
    fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  const prev = process.env.PATH;
  process.env.PATH = [bin, '/usr/bin', '/bin'].join(path.delimiter);
  try {
    return await fn();
  } finally {
    process.env.PATH = prev;
    rmrf(bin);
  }
}

test('ak setup --project heals a retired seeded route instead of leaving it for the next sync', async () => {
  const project = sandboxProject('ak-setup-retirement');
  const cwd = process.cwd();
  process.chdir(project);
  const { migrate, calls } = fakeMigrateThatRetires('testing', 'retired-model-x', 'replacement-model');
  const cfg = baseCfg({ testing: { host: 'claude', model: 'retired-model-x', provenance: 'seeded' } });
  let out;
  try {
    ({ out } = await withProjectCli(() => captureLog(() => setup.run_project({
      flags: {}, cfg, trustDisclosed: true, migrateRoutes: migrate,
    }))));
  } finally {
    process.chdir(cwd);
  }
  assert.equal(calls.length, 1, `run_project() must run the shared retirement-migration step\n${out}`);
  assert.match(out, /routing: testing model: retired-model-x → replacement-model \(retires 2099-01-01\)/);
  assert.equal(cfg.routing.routes.testing.model, 'replacement-model');
  const saved = loadKitConfig();
  assert.equal(saved.routing.routes.testing.model, 'replacement-model',
    'run_project() must persist the migrated route, not leave the retired model for `ak sync` to repair');
  rmrf(project);
});
