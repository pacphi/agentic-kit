// ak dual — CLI spawn tests for the dual-run wrapper (dry-run only; no live swarm).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedDualRouting, policyToDualRunConfig } from '../../src/lib/routing.mjs';
import { writeConfigModule } from '../../src/commands/dual.mjs';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/agentic-kit.mjs');

function sandbox({ dualRouting }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-dual-home-'));
  const cfgDir = path.join(home, '.config', 'agentic-kit');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'kit.json'),
    JSON.stringify({ providers: { hosts: { claude: true, codex: true }, dualRouting } }));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-dual-proj-'));
  fs.mkdirSync(path.join(project, '.git'));
  return { home, project };
}

function ak(args, { cwd, home }) {
  const cfgDir = path.join(home, '.config');
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    cwd,
    // POSIX + Windows env isolation (see provider-cli.test.mjs lesson).
    env: { ...process.env, NO_COLOR: '1', HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: cfgDir, APPDATA: cfgDir },
  });
}
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });

test('ak dual run --dry-run materializes the feature pipeline from the policy', () => {
  const { home, project } = sandbox({ dualRouting: seedDualRouting() });
  const r = ak(['dual', 'run', 'feature', 'add auth', '--dry-run'], { cwd: project, home });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /dual run: feature/);
  assert.match(r.stdout, /"platform": "claude"/);
  assert.match(r.stdout, /"platform": "codex"/);
  assert.match(r.stdout, /add auth/);
  rm(home); rm(project);
});

test('ak dual run fails clearly when no routing policy is configured', () => {
  const { home, project } = sandbox({ dualRouting: {} });
  const r = ak(['dual', 'run', 'feature', 'x'], { cwd: project, home });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /no per-activity routing configured/);
  rm(home); rm(project);
});

test('ak dual run rejects an unknown template', () => {
  const { home, project } = sandbox({ dualRouting: seedDualRouting() });
  const r = ak(['dual', 'run', 'nope', 'x', '--dry-run'], { cwd: project, home });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /unknown template/);
  rm(home); rm(project);
});

test('materialized --config is an importable module exporting workers (adapter contract)', async () => {
  // The adapter loads --config via `await import()` and reads `.workers`, so a
  // plain .json path fails. Guard that we emit an import-loadable module.
  const config = policyToDualRunConfig(seedDualRouting(), { template: 'feature', task: 'x' });
  const url = writeConfigModule(config, 'x');
  assert.match(url, /^file:\/\/.*\.mjs$/);
  const mod = await import(url);
  assert.ok(Array.isArray(mod.workers), 'workers export is an array');
  assert.equal(mod.workers.length, config.workers.length);
  assert.ok(mod.workers.every((w) => w.platform === 'claude' || w.platform === 'codex'));
});

test('ak dual templates lists the pipelines', () => {
  const { home, project } = sandbox({ dualRouting: {} });
  const r = ak(['dual', 'templates'], { cwd: project, home });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /feature/);
  assert.match(r.stdout, /security/);
  rm(home); rm(project);
});
