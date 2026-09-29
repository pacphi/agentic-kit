// claudeLauncherUnavailable() (src/lib/mcp.mjs) stops
// spawning `which ak` (and, when ak is present, `ak x ruflo-mcp --help`) on
// every plain `ak status` call where sync's register() would run — it reuses
// fresh evidence instead (kind 'ak-launcher', id 'machine', 6h TTL,
// invalidated by a PATH change). `refresh` defaults to true (Ruling B: every
// non-status caller keeps its unconditional probe); status/sections/mcp.mjs's
// own collect() explicitly threads refresh:false from ctx.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { claudeLauncherUnavailable } from '../../src/lib/mcp.mjs';
import {
  evidenceDir, evidenceFile, readEvidence, writeEvidence, stableInputsKey,
} from '../../src/lib/evidence.mjs';
import { tempDir } from './helpers/temp-dir.mjs';

process.env.XDG_STATE_HOME = tempDir('ak-launcher-evidence-state');
process.env.LOCALAPPDATA = process.env.XDG_STATE_HOME;

const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
const resetEvidence = () => rm(evidenceDir());
const inputsKey = (pathValue = process.env.PATH ?? '') => stableInputsKey({ PATH: pathValue });

const neverProbe = async () => { throw new Error('must not probe: cached evidence should have been used'); };

test('claudeLauncherUnavailable({ refresh: false }) reuses fresh, matching evidence and never probes', async () => {
  resetEvidence();
  writeEvidence('ak-launcher', 'machine', {
    source: 'test', inputsKey: inputsKey(), inputs: { PATH: process.env.PATH ?? '' }, result: { reason: 'ak-launcher-outdated' },
  });
  const reason = await claudeLauncherUnavailable({ refresh: false, haveFn: neverProbe, probe: neverProbe });
  assert.equal(reason, 'ak-launcher-outdated');
  resetEvidence();
});

test('claudeLauncherUnavailable({ refresh: true }) always probes and writes evidence a later refresh:false read can reuse', async () => {
  resetEvidence();
  const reason = await claudeLauncherUnavailable({ refresh: true, haveFn: async () => false });
  assert.equal(reason, 'ak-not-on-path');
  const record = readEvidence('ak-launcher', 'machine', { inputsKey: inputsKey() });
  assert.ok(record, 'evidence was written after the probe');
  assert.equal(record.result.reason, 'ak-not-on-path');
  const cached = await claudeLauncherUnavailable({ refresh: false, haveFn: neverProbe, probe: neverProbe });
  assert.equal(cached, 'ak-not-on-path', 'refresh:false reused the evidence refresh:true just wrote');
  resetEvidence();
});

test('claudeLauncherUnavailable({ refresh: false }) re-probes when cached evidence is older than 6h', async () => {
  resetEvidence();
  writeEvidence('ak-launcher', 'machine', {
    source: 'test', inputsKey: inputsKey(), inputs: { PATH: process.env.PATH ?? '' }, result: { reason: 'ak-not-on-path' },
  }, { now: Date.now() - 7 * 3600_000 });
  let called = false;
  const reason = await claudeLauncherUnavailable({
    refresh: false, haveFn: async () => { called = true; return true; }, probe: async () => ({ code: 0, stdout: '--host' }),
  });
  assert.equal(called, true, 'evidence older than the 6h window must not suppress the probe');
  assert.equal(reason, null);
  resetEvidence();
});

test('claudeLauncherUnavailable({ refresh: false }) re-probes when PATH changed since evidence was written (invalidated inputsKey)', async () => {
  resetEvidence();
  writeEvidence('ak-launcher', 'machine', {
    source: 'test', inputsKey: inputsKey('/some/other/path'), inputs: { PATH: '/some/other/path' }, result: { reason: 'ak-not-on-path' },
  });
  let called = false;
  const reason = await claudeLauncherUnavailable({ refresh: false, haveFn: async () => { called = true; return false; } });
  assert.equal(called, true, 'a PATH change must invalidate the cached inputsKey');
  assert.equal(reason, 'ak-not-on-path');
  resetEvidence();
});

test('claudeLauncherUnavailable({ refresh: false }) probes when there is no cached evidence yet (first run)', async () => {
  resetEvidence();
  const reason = await claudeLauncherUnavailable({ refresh: false, haveFn: async () => false });
  assert.equal(reason, 'ak-not-on-path');
  assert.ok(fs.existsSync(evidenceFile('ak-launcher', 'machine')), 'the probe is recorded for next time');
  resetEvidence();
});

test('claudeLauncherUnavailable({ record: false }) still probes but writes no evidence', async () => {
  resetEvidence();
  const reason = await claudeLauncherUnavailable({ refresh: true, record: false, haveFn: async () => false });
  assert.equal(reason, 'ak-not-on-path');
  assert.equal(fs.existsSync(evidenceFile('ak-launcher', 'machine')), false, 'record:false must not write evidence');
  resetEvidence();
});
