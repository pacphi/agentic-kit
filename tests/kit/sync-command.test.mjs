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
  rmrf(paths.claudeDir(), paths.configDir());
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

test.after(() => rmrf(HOME, PROJECT));
