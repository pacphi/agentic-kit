// `ak sync --skip versions` (and `--skip self`, `--skip ruvnet-brain`) leaves
// that part's online version lookup out of the run as well (ADR-0063): the
// forced pre-plan lookup is not made, and the plan read and the converge proof
// use what ak recorded instead of fetching on an expired TTL. A sync that skips
// nothing still makes every forced lookup first.
//
// Every lookup path is observed: the forced lookups through the injected
// fetchLatest/releaseDatesRunner/brainDrift; the sections' own reads through a
// fake `npm` on PATH that logs its arguments and exits 1 (POSIX only), and a
// global `fetch` stub for the Brain's GitHub release lookup. A failing fake
// lookup saves nothing, so kit.json's versionCheck can be compared byte for
// byte.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  sandboxHome, assertSandboxed, captureLog, rmrf, sandboxProject, writeKitConfig, offlineKitConfig, fakeGlobalRoot,
} from './helpers/home-sandbox.mjs';
import { isolateProject } from './helpers/project-isolation.mjs';

const HOME = sandboxHome('ak-sync-skip-versions');
const paths = await import('../../src/lib/paths.mjs');
const sync = await import('../../src/commands/sync.mjs');
const { loadKitConfig } = await import('../../src/lib/config.mjs');
const { KIT_PKG } = await import('../../src/lib/versions.mjs');
const versionsSection = (await import('../../src/commands/status/sections/versions.mjs')).default;
const selfSection = (await import('../../src/commands/status/sections/self.mjs')).default;
const brainSection = (await import('../../src/commands/status/sections/ruvnet-brain.mjs')).default;
assertSandboxed(paths, HOME);
isolateProject('ak-sync-skip-versions');

const PROJECT = sandboxProject('ak-sync-skip-versions');
const PKG_ROOT = path.join(HOME, 'installed-kit');
const KB = path.join(HOME, 'brain-kb');
const POSIX = process.platform !== 'win32';
const TWO_DAYS_AGO = Date.now() - 48 * 3600_000;
const savedKb = process.env.RUVNET_BRAIN_KB;
process.env.RUVNET_BRAIN_KB = KB;
after(() => {
  if (savedKb === undefined) delete process.env.RUVNET_BRAIN_KB; else process.env.RUVNET_BRAIN_KB = savedKb;
  rmrf(HOME, PROJECT);
});

/** kit.json whose version caches all expired two days ago, so a plain read would fetch. */
function seed({ ruvnetBrain = false } = {}) {
  fs.mkdirSync(PKG_ROOT, { recursive: true });
  fs.writeFileSync(path.join(PKG_ROOT, 'package.json'), JSON.stringify({ name: KIT_PKG, version: '4.0.0' }));
  const cfg = offlineKitConfig({ ruvnetBrain });
  cfg.versionCheck = {
    ttlHours: 24,
    last: TWO_DAYS_AGO,
    seen: { ruflo: '9.9.9', 'agentic-qe': '9.9.9' },
    self: { last: TWO_DAYS_AGO, best: { version: '4.0.0', tag: 'latest' } },
    ruvnetBrain: { last: TWO_DAYS_AGO, latest: '4.3.28', releaseAssetAvailable: true },
  };
  writeKitConfig(HOME, cfg);
  paths._setGlobalRootForTest(fakeGlobalRoot(HOME, { ruflo: '9.9.9', 'agentic-qe': '9.9.9' }));
}

const versionCheckText = () => JSON.stringify(loadKitConfig().versionCheck);
const kitJsonText = () => fs.readFileSync(paths.kitConfigPath(), 'utf8');

const MARKER = {
  subsystem: 'sync-test-only-marker', level: 'warn', message: 'marker row', fix: 'no sync step performs this',
};

/** A collectFn that runs the three real version sections with the arguments
 *  sync passes, then plans one marker row that no step performs (so the apply
 *  phase does no work and the converge proof still runs). */
function versionSectionsCollect(calls) {
  return async (args) => {
    calls.push(args);
    const ctx = { ...args, cfg: loadKitConfig(), refresh: false };
    for (const section of [versionsSection, selfSection, brainSection]) await section.collect(ctx);
    return args.record ? [] : [MARKER];
  };
}

/** Run `fn` with a fake failing `npm` on PATH and a recording `fetch` stub. */
async function observingLookups(fn) {
  const bin = fs.mkdtempSync(path.join(HOME, 'fakebin-npm-'));
  const log = path.join(bin, 'npm.log');
  if (POSIX) fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\necho "$*" >> "${log}"\nexit 1\n`, { mode: 0o755 });
  const fetched = [];
  const saved = { path: process.env.PATH, fetch: globalThis.fetch, cwd: process.cwd() };
  process.env.PATH = bin;
  globalThis.fetch = async (url) => { fetched.push(String(url)); return { ok: false, json: async () => ({}) }; };
  process.chdir(PROJECT);
  try {
    const result = await fn();
    const npm = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
    return { ...result, npm, fetched };
  } finally {
    process.chdir(saved.cwd);
    process.env.PATH = saved.path;
    globalThis.fetch = saved.fetch;
  }
}

/** A real (or dry) sync with every lookup observed. */
function observedSync(flags) {
  const calls = { fetchLatest: [], releaseDates: 0, brainDrift: [], collect: [] };
  return observingLookups(async () => {
    const { result, out } = await captureLog(() => sync.run({
      flags: { 'dry-run': false, 'no-upgrade': false, yes: true, json: false, ...flags },
      pkgRoot: PKG_ROOT,
      fetchLatest: async (pkg) => { calls.fetchLatest.push(pkg); return null; },
      releaseDatesRunner: async () => { calls.releaseDates += 1; return { code: 1, stdout: '', stderr: '' }; },
      brainDrift: async (opts) => { calls.brainDrift.push(opts); return {}; },
      refreshHosts: async () => {},
      collectFn: versionSectionsCollect(calls.collect),
    }));
    return { result, out, calls };
  });
}

const npmViews = (npm, pkg) => npm.filter((line) => line.startsWith(`view ${pkg}@`));

test('--skip versions makes no forced or plan-time lookup for ruflo/agentic-qe and records nothing', async () => {
  seed();
  const before = versionCheckText();
  const { calls, npm, out } = await observedSync({ skip: ['versions'] });
  assert.equal(calls.collect.length, 2, `the plan read and the converge proof both ran\n${out}`);
  assert.deepEqual(calls.fetchLatest.filter((pkg) => pkg === 'ruflo' || pkg === 'agentic-qe'), []);
  assert.equal(calls.releaseDates, 0, "Ruflo's release dates are part of the versions lookup");
  if (POSIX) {
    assert.deepEqual([...npmViews(npm, 'ruflo'), ...npmViews(npm, 'agentic-qe')], [],
      'neither the plan read nor the converge proof may fetch on the expired cache');
  }
  assert.equal(versionCheckText(), before, "kit.json's versionCheck is byte-identical");
});

test('--skip self makes no lookup for the kit itself', async () => {
  seed();
  const { calls, npm, out } = await observedSync({ skip: ['self'] });
  assert.equal(calls.collect.length, 2, out);
  assert.deepEqual(calls.fetchLatest.filter((pkg) => pkg === KIT_PKG), []);
  if (POSIX) assert.deepEqual(npmViews(npm, KIT_PKG), []);
  assert.ok(calls.fetchLatest.includes('ruflo'), 'the versions lookup still runs: only self was skipped');
});

test('--skip ruvnet-brain makes no Brain release lookup', async () => {
  seed({ ruvnetBrain: true });
  const { calls, fetched, out } = await observedSync({ skip: ['ruvnet-brain'] });
  assert.equal(calls.collect.length, 2, out);
  assert.deepEqual(calls.brainDrift.filter((opts) => opts?.force === true), []);
  assert.deepEqual(fetched, [], 'the plan read and the proof read the recorded Brain release');
});

test('a sync that skips nothing makes every forced lookup before it plans', async () => {
  seed({ ruvnetBrain: true });
  const { calls, out } = await observedSync({});
  assert.equal(calls.collect.length, 2, out);
  for (const pkg of ['ruflo', 'agentic-qe', KIT_PKG]) assert.ok(calls.fetchLatest.includes(pkg), `looked up ${pkg}`);
  assert.equal(calls.releaseDates, 1);
  assert.deepEqual(calls.brainDrift, [{ force: true }]);
});

test('a dry run with --skip versions reads the recorded versions and writes nothing', async () => {
  seed();
  const before = kitJsonText();
  const { result, calls, npm, out } = await observedSync({ 'dry-run': true, skip: ['versions'] });
  assert.equal(result, 0, out);
  assert.equal(calls.collect.length, 1, 'a dry run stops after the plan');
  assert.deepEqual(calls.fetchLatest, [], 'a dry run makes no forced lookup');
  if (POSIX) assert.deepEqual([...npmViews(npm, 'ruflo'), ...npmViews(npm, 'agentic-qe')], []);
  assert.equal(kitJsonText(), before);
});

// ── the sections take the evidence sync hands them ──────────────────────────

test('the versions section uses the drift rows it is given and never calls drift()', async () => {
  let called = 0;
  const rows = await versionsSection.collect({
    versionEvidence: { drift: [{ pkg: 'agentic-qe', installed: '1.0.0', latest: '1.1.0', outdated: true, latestSource: 'cache' }] },
    drift: async () => { called += 1; return []; },
  });
  assert.equal(called, 0);
  assert.match(rows[0].message, /agentic-qe 1\.0\.0 installed, 1\.1\.0 available/);
});

test("the support-window row reads the evidence's kit.json copy when one is given", async () => {
  let loads = 0;
  const cfg = { versionCheck: { rufloMinors: { observedAt: Date.now(), firstPublished: { '3.46': new Date().toISOString() } } } };
  const rows = await versionsSection.collect({
    versionEvidence: { drift: [{ pkg: 'ruflo', installed: '3.46.0', latest: '3.46.0', outdated: false, latestSource: 'cache' }], cfg },
    loadConfig: () => { loads += 1; return {}; },
  });
  assert.equal(loads, 0);
  assert.ok(rows.some((r) => /inside the support window/.test(r.message)), JSON.stringify(rows));
});

test('the self section uses the self drift it is given', async () => {
  seed();
  const { rows, npm } = await observingLookups(async () => ({
    rows: await selfSection.collect({
      pkgRoot: PKG_ROOT,
      versionEvidence: { self: { pkg: KIT_PKG, installed: '4.0.0', latest: '4.1.0', tag: 'latest', outdated: true } },
    }),
  }));
  assert.match(rows[0].message, /kit 4\.0\.0 installed, 4\.1\.0 available/);
  if (POSIX) assert.deepEqual(npm, []);
});

test('the ruvnet-brain section uses the Brain drift it is given', async () => {
  seed({ ruvnetBrain: true });
  const brain = {
    present: true, outdated: false, unversioned: false, installedRelease: '4.3.28', latest: '4.3.28',
    releaseAssetAvailable: true, latestSource: 'cache', latestObservedAt: TWO_DAYS_AGO, heldRefresh: null,
  };
  const { rows, fetched } = await observingLookups(async () => ({
    rows: await brainSection.collect({ cfg: { ruvnetBrain: true }, versionEvidence: { brain } }),
  }));
  assert.deepEqual(fetched, []);
  assert.match(rows[0].message, /ruvnet-brain release v4\.3\.28/);
});

// ── the cache-only evidence ──────────────────────────────────────────────────

test('skipped parts get cache-only evidence: no network, no write', async () => {
  const { skippedVersionEvidence } = await import('../../src/commands/sync/plan-versions.mjs');
  seed({ ruvnetBrain: true });
  const before = kitJsonText();
  const { evidence, npm, fetched } = await observingLookups(async () => ({
    evidence: await skippedVersionEvidence({ skip: new Set(['versions', 'self', 'ruvnet-brain']), pkgRoot: PKG_ROOT }),
  }));
  assert.deepEqual(evidence.drift.map((r) => [r.pkg, r.latest, r.latestSource]),
    [['ruflo', '9.9.9', 'cache-fallback'], ['agentic-qe', '9.9.9', 'cache-fallback']]);
  assert.equal(evidence.self.latest, '4.0.0');
  assert.equal(evidence.brain.latest, '4.3.28');
  assert.equal(evidence.brain.latestSource, 'cache-fallback');
  if (POSIX) assert.deepEqual(npm, []);
  assert.deepEqual(fetched, []);
  assert.equal(kitJsonText(), before);
});

test('no skipped part means no evidence, and the Brain is read only when ak manages it', async () => {
  const { skippedVersionEvidence } = await import('../../src/commands/sync/plan-versions.mjs');
  seed();
  assert.deepEqual(await skippedVersionEvidence({ skip: new Set(), pkgRoot: PKG_ROOT }), {});
  assert.deepEqual(await skippedVersionEvidence({ skip: new Set(['ruvnet-brain']), pkgRoot: PKG_ROOT }), {});
});
