// Decision A (docs/audits/2026-09-26-issues-237-238-239-verification-and-decisions.md,
// addendum): ak facilitates and monitors what Ruflo does; it does not run a
// parallel copy. The standalone global `agentdb` ak used to install for
// `ak x harvest` was a worse duplicate of the copy Ruflo bundles, its install was
// on by default while its only consumer was off by default (#237 §3: an EEXIST
// on every sync), and `agentdb skill consolidate` consolidated an empty store.
//
// What must hold after the retirement:
//   · no setup/sync/status path installs, repins or monitors the standalone CLI;
//   · a legacy `agentdb` key in kit.json is tolerated silently (preserved, ignored);
//   · harvest runs only Ruflo's own verbs, from the project memory root, with the
//     project memory pin — and distillation is an explicit opt-in;
//   · `ak x verify harvest` never seeds an AgentDB store and keeps every memory
//     path inside its temporary directory;
//   · About reports the agentdb copy Ruflo bundles, never the standalone global.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sandboxHome, assertSandboxed, captureLog, rmrf, sandboxProject, writeKitConfig,
  offlineKitConfig, fakeGlobalRoot,
} from './helpers/home-sandbox.mjs';

const HOME = sandboxHome('ak-agentdb-retired');
const paths = await import('../../src/lib/paths.mjs');
const status = await import('../../src/commands/status.mjs');
const heal = await import('../../src/lib/heal.mjs');
const { SYNC_STEPS } = await import('../../src/commands/sync.mjs');
const { loadKitConfig, saveKitConfig } = await import('../../src/lib/config.mjs');
const harvest = await import('../../src/lib/harvest.mjs');
const verify = await import('../../src/commands/x/verify.mjs');
const about = await import('../../src/commands/about.mjs');
const { foldKnownVersions } = await import('../../src/lib/dashboard-server.mjs');
assertSandboxed(paths, HOME);

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROJECT = sandboxProject('ak-agentdb-retired');

/** A global root where the standalone agentdb (alpha.17) and Ruflo's bundled
 *  copy (alpha.20) disagree — the exact shape H-agentdb-lifecycle observed. */
function globalRootWithBothCopies() {
  const root = fakeGlobalRoot(HOME, { ruflo: '9.9.9', agentdb: '3.0.0-alpha.17' });
  const bundled = path.join(root, 'ruflo', 'node_modules', 'agentdb');
  fs.mkdirSync(bundled, { recursive: true });
  fs.writeFileSync(path.join(bundled, 'package.json'),
    JSON.stringify({ name: 'agentdb', version: '3.0.0-alpha.20' }));
  return root;
}
paths._setGlobalRootForTest(globalRootWithBothCopies());

function seedHome(cfg = offlineKitConfig()) {
  rmrf(paths.claudeDir(), paths.codexDir(), paths.configDir());
  fs.mkdirSync(paths.claudeDir(), { recursive: true });
  fs.writeFileSync(paths.claudeMdPath(), '# machine notes\n');
  writeKitConfig(HOME, cfg);
}

test('status emits no agentdb row, whatever a legacy kit.json says', async () => {
  for (const legacy of [{}, { agentdb: true }, { agentdb: false }]) {
    seedHome(offlineKitConfig(legacy));
    const rows = await status.collect({ pkgRoot: PKG_ROOT, cwd: PROJECT });
    assert.deepEqual(rows.filter((r) => r.subsystem === 'agentdb'), [],
      `no agentdb row for kit.json ${JSON.stringify(legacy)}`);
  }
});

test('no heal or sync step installs, repins or plans the standalone agentdb CLI', () => {
  assert.equal('healAgentdb' in heal, false, 'the standalone install heal is retired');
  assert.deepEqual(SYNC_STEPS.filter((s) => s.id === 'agentdb'), []);
  const setupSource = fs.readFileSync(path.join(PKG_ROOT, 'src', 'commands', 'setup.mjs'), 'utf8');
  assert.doesNotMatch(setupSource, /healAgentdb|lib\/agentdb\.mjs/,
    'setup no longer installs the standalone agentdb CLI');
});

test('a legacy agentdb key is tolerated silently and preserved on save', async () => {
  // The unknown-key warning fires once per distinct key set per process, so a
  // genuinely unknown companion key both proves the warning ran here and gives
  // this load a key set no earlier test could have consumed.
  seedHome(offlineKitConfig({ agentdb: false, zzRetirementProbe: 1 }));
  const { out } = await captureLog(async () => {
    const cfg = loadKitConfig();
    assert.equal(cfg.agentdb, false, 'the user value round-trips untouched');
    saveKitConfig(cfg);
  });
  assert.match(out, /not recognized by this ak version: zzRetirementProbe/);
  assert.doesNotMatch(out, /agentdb/, 'a retired key is not an unknown key');
  const saved = JSON.parse(fs.readFileSync(paths.kitConfigPath(), 'utf8'));
  assert.equal(saved.agentdb, false, 'ak never deletes a user setting it retired');

  seedHome({});
  assert.equal('agentdb' in loadKitConfig(), false, 'fresh configs carry no agentdb default');
});

test('the harvest plan runs only Ruflo verbs; distillation is an explicit opt-in', () => {
  const plain = harvest.planHarvest({ cwd: PROJECT });
  assert.deepEqual(plain.map((s) => s.cmd), ['ruflo']);
  assert.deepEqual(plain[0].args.slice(0, 2), ['hooks', 'post-task']);

  const distilled = harvest.planHarvest({ cwd: PROJECT, distill: true });
  assert.deepEqual(distilled.map((s) => s.name), ['record-outcome', 'distill-memory']);
  assert.deepEqual(distilled[1].args,
    ['memory', 'distill', 'run', '--db', paths.projectMemoryDb(PROJECT)],
    'distillation targets the project store deliberately, not whatever cwd implies');
  for (const step of distilled) {
    assert.notEqual(step.cmd, 'agentdb');
    // Verbs only: the --db path legitimately contains `.swarm`.
    const verbs = step.args.filter((arg) => !path.isAbsolute(arg)).join(' ');
    assert.doesNotMatch(verbs, /consolidate|daemon|swarm/);
  }
});

test('harvest runs from the project memory root with the project memory pin', async () => {
  const sub = path.join(PROJECT, 'packages', 'deep');
  fs.mkdirSync(sub, { recursive: true });
  const calls = [];
  const runner = async (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { code: 0, stdout: '', stderr: '' }; };
  const res = await harvest.runHarvest({ runner, cwd: sub, distill: true, env: { EXTRA: '1' } });
  assert.equal(res.ok, true);
  assert.deepEqual(calls.map((c) => c.cmd), ['ruflo', 'ruflo']);
  for (const { opts } of calls) {
    assert.equal(opts.cwd, PROJECT, 'a subdirectory run must not create stores in that subdirectory');
    assert.equal(opts.env.CLAUDE_FLOW_DB_PATH, paths.projectMemoryDb(PROJECT));
    assert.equal(opts.env.EXTRA, '1', 'caller env is merged, not dropped');
  }
  assert.equal('agentdb' in res, false, 'the result no longer reports a standalone CLI');

  calls.length = 0;
  const dry = await harvest.runHarvest({ runner, cwd: sub, dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(calls.length, 0, 'a dry run spawns nothing');
});

test('verify harvest isolates every memory path in its temp dir and never seeds agentdb', async () => {
  seedHome();
  const calls = [];
  const runner = async (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { code: 0, stdout: '', stderr: '' }; };
  const { result } = await captureLog(() => verify.verifyHarvest({ runner, haveCmd: async () => true }));
  assert.equal(result, true);
  assert.ok(calls.length >= 3, 'init, record-outcome and distill all ran');
  assert.equal(calls.some((c) => c.cmd === 'agentdb'), false, 'no standalone agentdb seeding');
  const tmp = calls[0].opts.cwd;
  assert.match(path.basename(tmp), /^agentic-kit-harvest-/);
  const inside = (p) => typeof p === 'string' && (p === tmp || p.startsWith(`${tmp}${path.sep}`));
  for (const { cmd, args, opts } of calls) {
    const label = `${cmd} ${args.join(' ')}`;
    assert.equal(opts.cwd, tmp, `${label}: runs in the temp dir`);
    for (const key of ['CLAUDE_FLOW_DB_PATH', 'CLAUDE_FLOW_MEMORY_PATH', 'AGENTDB_PATH']) {
      assert.ok(inside(opts.env?.[key]), `${label}: ${key} stays inside the temp dir (got ${opts.env?.[key]})`);
    }
  }
  assert.deepEqual(calls[0].args, ['memory', 'init']);
  assert.ok(calls.some((c) => c.args.slice(0, 3).join(' ') === 'memory distill run'));
  assert.equal(fs.existsSync(tmp), false, 'the temp dir is removed afterwards');

  const absent = await captureLog(() => verify.verifyHarvest({ runner, haveCmd: async () => false }));
  assert.equal(absent.result, false, 'no ruflo means no proof, never a silent pass');
  assert.match(absent.out, /ruflo CLI not installed/);
});

test('About reports the agentdb copy Ruflo bundles, not a standalone global', async () => {
  seedHome();
  const { out } = await captureLog(() => about.run({
    flags: { json: true }, positionals: ['agentdb'], pkgRoot: PKG_ROOT,
  }));
  const entry = JSON.parse(out).entries.find((e) => e.id === 'agentdb');
  assert.equal(entry.state.state, 'installed');
  assert.equal(entry.state.version, '3.0.0-alpha.20', 'the bundled copy, not the alpha.17 global');
  assert.doesNotMatch(entry.paragraph, /cannot drift|pins its version/);

  const drift = await foldKnownVersions([], {
    hostFacts: {}, installedVersionFn: (pkg) => (pkg === 'agentdb' ? '3.0.0-alpha.17' : null),
  });
  assert.equal(drift.find((d) => d.pkg === 'agentdb')?.installed, '3.0.0-alpha.20',
    'the dashboard chip reads the Ruflo-bundled version');
});
