// Branch 6a Task 5, Part 1: detectHosts()/hostInstallState() stop spawning
// `which`/`<bin> --version` on every plain `ak status` call — they reuse
// fresh evidence instead, gated by `refresh` (Ruling A: 6h max age; Ruling B:
// every new `refresh` param defaults to true, so every caller other than
// status's plain-status path keeps probing unconditionally, unchanged).
//
// Neither `have()` nor `hostVersion()` (providers.mjs) nor `installedVersion()`
// (versions.mjs, via globalRoot()) is injectable, so — mirroring
// tests/kit/natives-runtime.test.mjs's Task 4 precedent — these tests break
// PATH and redirect the npm global root to an empty fixture dir so a REAL
// probe deterministically returns "absent", then seed cached evidence with a
// value ("...-cache-marker") a real probe could never produce. Getting the
// marker back proves the cache was used, not a real probe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  detectHosts, hostInstallState, collectIntegrationFacts, HOSTS,
} from '../../src/lib/providers.mjs';
import {
  evidenceDir, evidenceFile, writeEvidence, stableInputsKey,
} from '../../src/lib/evidence.mjs';
import { _setGlobalRootForTest } from '../../src/lib/paths.mjs';
import { tempDir } from './helpers/temp-dir.mjs';

process.env.XDG_STATE_HOME = tempDir('ak-host-setup-evidence-state');
process.env.LOCALAPPDATA = process.env.XDG_STATE_HOME;

const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
const resetEvidence = () => rm(evidenceDir());

const hostSetupKey = (host, pathValue) => stableInputsKey({
  id: host.id, bin: host.bin, pkg: host.pkg, PATH: pathValue ?? '',
});

/** Real `have()`/`hostVersion()`/`installedVersion()` probes all fail
 *  deterministically inside `fn`: PATH points nowhere (so `which` ENOENTs)
 *  and the npm global root is an empty fixture dir (so no host package is
 *  ever "found" there). */
async function withDeterministicAbsence(fn) {
  const prevPath = process.env.PATH;
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-host-setup-empty-root-'));
  process.env.PATH = path.join(os.tmpdir(), 'ak-host-setup-no-such-bin');
  _setGlobalRootForTest(emptyRoot);
  try {
    return await fn();
  } finally {
    process.env.PATH = prevPath;
    _setGlobalRootForTest(null);
    fs.rmSync(emptyRoot, { recursive: true, force: true });
  }
}

function seedHostSetup(host, pathValue, result, opts = {}) {
  writeEvidence('host-setup', host.id, {
    source: 'test',
    inputsKey: hostSetupKey(host, pathValue),
    inputs: { PATH: pathValue ?? '', bin: host.bin },
    result,
  }, opts);
}

function seedHostInstallMethod(host, pathValue, result, opts = {}) {
  writeEvidence('host-install-method', host.id, {
    source: 'test',
    inputsKey: hostSetupKey(host, pathValue),
    inputs: { PATH: pathValue ?? '', bin: host.bin },
    result,
  }, opts);
}

// ── detectHosts ──────────────────────────────────────────────────────────

test('detectHosts({ refresh: false }) reuses fresh cached evidence and never probes', async () => {
  resetEvidence();
  await withDeterministicAbsence(async () => {
    for (const h of HOSTS) {
      seedHostSetup(h, process.env.PATH, { present: true, version: '99.99.99-cache-marker' });
    }
    const out = await detectHosts(process.cwd(), { refresh: false });
    for (const h of HOSTS) {
      assert.equal(out[h.id].present, true, `${h.id}: served from cache, not a real (deterministically-absent) probe`);
      assert.equal(out[h.id].version, '99.99.99-cache-marker');
    }
  });
  resetEvidence();
});

test('detectHosts({ refresh: true }) always probes, ignoring fresh cached evidence', async () => {
  resetEvidence();
  await withDeterministicAbsence(async () => {
    for (const h of HOSTS) {
      seedHostSetup(h, process.env.PATH, { present: true, version: '99.99.99-cache-marker' });
    }
    const out = await detectHosts(process.cwd(), { refresh: true });
    for (const h of HOSTS) {
      assert.equal(out[h.id].present, false, `${h.id}: refresh:true must ignore the cache and probe for real`);
    }
  });
  resetEvidence();
});

test('detectHosts({ refresh: false }) probes when there is no cached evidence yet (first run)', async () => {
  resetEvidence();
  await withDeterministicAbsence(async () => {
    const out = await detectHosts(process.cwd(), { refresh: false });
    for (const h of HOSTS) assert.equal(out[h.id].present, false);
  });
  resetEvidence();
});

test('detectHosts({ refresh: false }) re-probes when cached evidence is older than 6h', async () => {
  resetEvidence();
  await withDeterministicAbsence(async () => {
    for (const h of HOSTS) {
      seedHostSetup(h, process.env.PATH, { present: true, version: '99.99.99-cache-marker' }, {
        now: Date.now() - 7 * 3600_000,
      });
    }
    const out = await detectHosts(process.cwd(), { refresh: false });
    for (const h of HOSTS) {
      assert.equal(out[h.id].present, false, `${h.id}: evidence older than the 6h window must not suppress the probe`);
    }
  });
  resetEvidence();
});

test('detectHosts({ refresh: false }) re-probes when PATH changed (invalidated inputsKey)', async () => {
  resetEvidence();
  await withDeterministicAbsence(async () => {
    for (const h of HOSTS) {
      // Evidence recorded under a different PATH string than the one active now.
      seedHostSetup(h, 'a-completely-different-path-string', { present: true, version: '99.99.99-cache-marker' });
    }
    const out = await detectHosts(process.cwd(), { refresh: false });
    for (const h of HOSTS) {
      assert.equal(out[h.id].present, false, `${h.id}: a changed PATH invalidates the cached inputsKey`);
    }
  });
  resetEvidence();
});

// ── hostInstallState ─────────────────────────────────────────────────────

const claude = HOSTS.find((h) => h.id === 'claude');

test('hostInstallState({ refresh: false }) reuses fresh cached evidence and never probes', async () => {
  resetEvidence();
  await withDeterministicAbsence(async () => {
    seedHostInstallMethod(claude, process.env.PATH, { method: 'external', version: '9.9.9-cache-marker' });
    const st = await hostInstallState(claude, { refresh: false });
    assert.deepEqual(st, { method: 'external', version: '9.9.9-cache-marker' });
  });
  resetEvidence();
});

test('hostInstallState({ refresh: true }) always probes, ignoring fresh cached evidence', async () => {
  resetEvidence();
  await withDeterministicAbsence(async () => {
    seedHostInstallMethod(claude, process.env.PATH, { method: 'external', version: '9.9.9-cache-marker' });
    const st = await hostInstallState(claude, { refresh: true });
    assert.deepEqual(st, { method: 'absent', version: null });
  });
  resetEvidence();
});

test('hostInstallState({ refresh: false }) probes when there is no cached evidence yet (first run)', async () => {
  resetEvidence();
  await withDeterministicAbsence(async () => {
    const st = await hostInstallState(claude, { refresh: false });
    assert.deepEqual(st, { method: 'absent', version: null });
  });
  resetEvidence();
});

test('hostInstallState({ refresh: false }) re-probes when cached evidence is older than 6h', async () => {
  resetEvidence();
  await withDeterministicAbsence(async () => {
    seedHostInstallMethod(claude, process.env.PATH, { method: 'external', version: '9.9.9-cache-marker' }, {
      now: Date.now() - 7 * 3600_000,
    });
    const st = await hostInstallState(claude, { refresh: false });
    assert.deepEqual(st, { method: 'absent', version: null });
  });
  resetEvidence();
});

test('hostInstallState({ refresh: false }) re-probes when PATH changed (invalidated inputsKey)', async () => {
  resetEvidence();
  await withDeterministicAbsence(async () => {
    seedHostInstallMethod(claude, 'a-completely-different-path-string', { method: 'external', version: '9.9.9-cache-marker' });
    const st = await hostInstallState(claude, { refresh: false });
    assert.deepEqual(st, { method: 'absent', version: null });
  });
  resetEvidence();
});

// ── collectIntegrationFacts threading ────────────────────────────────────

test('collectIntegrationFacts({ refresh: false }) threads refresh into detectHosts (reuses cache)', async () => {
  resetEvidence();
  await withDeterministicAbsence(async () => {
    for (const h of HOSTS) {
      seedHostSetup(h, process.env.PATH, { present: true, version: '99.99.99-cache-marker' });
    }
    const facts = await collectIntegrationFacts({ cwd: process.cwd(), cfg: null, refresh: false });
    for (const h of HOSTS) {
      assert.equal(facts.hosts[h.id].version, '99.99.99-cache-marker', `${h.id}: collectIntegrationFacts did not thread refresh:false through`);
    }
  });
  resetEvidence();
});

test('collectIntegrationFacts({ refresh: true }) (its default) threads through and always probes', async () => {
  resetEvidence();
  await withDeterministicAbsence(async () => {
    for (const h of HOSTS) {
      seedHostSetup(h, process.env.PATH, { present: true, version: '99.99.99-cache-marker' });
    }
    const facts = await collectIntegrationFacts({ cwd: process.cwd(), cfg: null });
    for (const h of HOSTS) {
      assert.equal(facts.hosts[h.id].present, false, `${h.id}: default refresh:true must ignore the cache`);
    }
  });
  resetEvidence();
});

// ── Task 4/5 joint fix: `record` suppresses persistence, never the probe ────
// (`sync.mjs`'s plan-computation reads pass `record: false` so a cold-cache
// probe never writes evidence as a side effect of merely building the plan.)

test('detectHosts({ refresh: true, record: false }) still probes and returns live results, but writes no evidence', async () => {
  resetEvidence();
  await withDeterministicAbsence(async () => {
    const out = await detectHosts(process.cwd(), { refresh: true, record: false });
    for (const h of HOSTS) {
      assert.equal(out[h.id].present, false, `${h.id}: the probe itself must still run and return a real result`);
      assert.equal(fs.existsSync(evidenceFile('host-setup', h.id)), false, `${h.id}: record:false must not write evidence`);
    }
  });
  resetEvidence();
});

test('detectHosts({ refresh: true, record: true }) (the default) still writes evidence as before', async () => {
  resetEvidence();
  await withDeterministicAbsence(async () => {
    const out = await detectHosts(process.cwd(), { refresh: true });
    for (const h of HOSTS) {
      assert.equal(out[h.id].present, false);
      assert.equal(fs.existsSync(evidenceFile('host-setup', h.id)), true, `${h.id}: record defaults to true and writes evidence`);
    }
  });
  resetEvidence();
});

test('hostInstallState({ refresh: true, record: false }) still probes and returns live results, but writes no evidence', async () => {
  resetEvidence();
  await withDeterministicAbsence(async () => {
    const st = await hostInstallState(claude, { refresh: true, record: false });
    assert.deepEqual(st, { method: 'absent', version: null }, 'the probe itself must still run and return a real result');
    assert.equal(fs.existsSync(evidenceFile('host-install-method', claude.id)), false, 'record:false must not write evidence');
  });
  resetEvidence();
});

test('collectIntegrationFacts({ record: false }) threads record:false through to detectHosts (no evidence written)', async () => {
  resetEvidence();
  await withDeterministicAbsence(async () => {
    const facts = await collectIntegrationFacts({ cwd: process.cwd(), cfg: null, record: false });
    for (const h of HOSTS) {
      assert.equal(facts.hosts[h.id].present, false, `${h.id}: the probe itself must still run`);
      assert.equal(fs.existsSync(evidenceFile('host-setup', h.id)), false, `${h.id}: record:false must thread through`);
    }
  });
  resetEvidence();
});
