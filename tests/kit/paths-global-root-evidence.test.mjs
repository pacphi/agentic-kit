// Branch 6a Task 7: globalRoot() (src/lib/paths.mjs) stops spawning
// `npm root -g` on every plain `ak status` call — it reuses fresh evidence
// instead (kind 'npm-global-root', id 'machine', 24h TTL). Unlike every other
// evidence-gated check in this branch, BOTH `refresh` and `record` DEFAULT TO
// FALSE here: see paths.mjs's own comment on globalRoot() for why (it had no
// gating concept before, every real call site is bare `globalRoot()`, and it
// is reached from far more contexts than status.mjs's own collect() tree —
// status.mjs itself is the one caller that opts into `record: true`, by
// warming the in-process memo once at the top of collect()).
//
// paths.mjs cannot import evidence.mjs's readEvidence/writeEvidence (a
// circular import back through evidence.mjs's own `evidenceDir = paths.
// evidenceDir` — see the comment above globalRootEvidenceFile()), so it
// writes a hand-rolled envelope. These tests read/write that envelope
// through evidence.mjs's OWN readEvidence/writeEvidence to prove the two are
// byte-compatible, not just paths.mjs talking to itself.
//
// globalRoot() has no injectable runner (it calls execFileSync directly), so
// — mirroring tests/kit/host-setup-evidence.test.mjs's Task 5 precedent —
// these tests break PATH so a real `npm root -g` ENOENTs deterministically,
// then seed cached evidence with a marker path no real probe/fallback could
// ever produce. Getting the marker back proves the cache was used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  globalRoot, globalRootInputsKey, _setGlobalRootForTest,
} from '../../src/lib/paths.mjs';
import {
  evidenceDir, evidenceFile, readEvidence, writeEvidence,
} from '../../src/lib/evidence.mjs';
import { tempDir } from './helpers/temp-dir.mjs';

process.env.XDG_STATE_HOME = tempDir('ak-global-root-evidence-state');
process.env.LOCALAPPDATA = process.env.XDG_STATE_HOME;

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
const resetEvidence = () => rm(evidenceDir());

/** Real `npm root -g` ENOENTs deterministically inside `fn`: PATH points
 *  nowhere. The in-process memo is reset before and after so each case
 *  exercises the evidence layer, not a leftover memo from a prior test. */
function withBrokenPath(fn) {
  const prevPath = process.env.PATH;
  process.env.PATH = path.join(os.tmpdir(), 'ak-global-root-no-such-bin');
  _setGlobalRootForTest(null);
  try {
    return fn();
  } finally {
    process.env.PATH = prevPath;
    _setGlobalRootForTest(null);
  }
}

test('globalRoot({ refresh: false }) reuses fresh, matching evidence and never re-resolves', () => {
  resetEvidence();
  withBrokenPath(() => {
    const inputsKey = globalRootInputsKey();
    const marker = '/marker/no-real-probe-or-fallback-could-produce-this';
    writeEvidence('npm-global-root', 'machine', {
      source: 'test', inputsKey, inputs: { execPath: process.execPath }, result: { path: marker },
    });
    const root = globalRoot({ refresh: false });
    assert.equal(root, marker, 'the cached marker came back, not a freshly resolved path');
  });
  resetEvidence();
});

test('globalRoot({ refresh: true, record: true }) always re-resolves and writes evidence a later refresh:false read can reuse', () => {
  resetEvidence();
  withBrokenPath(() => {
    const before = globalRoot({ refresh: true, record: true });
    assert.ok(before, 'resolveGlobalRoot() fallback still returns a path with npm unreachable');
    const record = readEvidence('npm-global-root', 'machine', { inputsKey: globalRootInputsKey() });
    assert.ok(record, 'evidence was written after the resolve');
    assert.equal(record.result.path, before);
    _setGlobalRootForTest(null); // drop the in-process memo; force the NEXT call through evidence
    const after = globalRoot({ refresh: false });
    assert.equal(after, before, 'refresh:false reused the evidence refresh:true just wrote');
  });
  resetEvidence();
});

test('globalRoot({ refresh: false }) re-resolves when cached evidence is older than 24h', () => {
  resetEvidence();
  withBrokenPath(() => {
    const inputsKey = globalRootInputsKey();
    const marker = '/marker/stale-should-never-come-back';
    writeEvidence('npm-global-root', 'machine', {
      source: 'test', inputsKey, inputs: { execPath: process.execPath }, result: { path: marker },
    }, { now: Date.now() - 25 * 3600_000 });
    const root = globalRoot({ refresh: false });
    assert.notEqual(root, marker, 'evidence older than the 24h window must not be trusted');
  });
  resetEvidence();
});

test('globalRoot({ refresh: false }) re-resolves when PATH changed since evidence was written (invalidated inputsKey)', () => {
  resetEvidence();
  withBrokenPath(() => {
    const marker = '/marker/invalidated-should-never-come-back';
    writeEvidence('npm-global-root', 'machine', {
      // A key computed under a DIFFERENT PATH than the one now in effect.
      source: 'test', inputsKey: globalRootInputsKey({ PATH: '/some/other/path' }),
      inputs: { execPath: process.execPath }, result: { path: marker },
    });
    const root = globalRoot({ refresh: false });
    assert.notEqual(root, marker, 'a PATH change must invalidate the cached inputsKey');
  });
  resetEvidence();
});

test('globalRoot({ refresh: false, record: true }) re-resolves and records when there is no cached evidence yet (first run)', () => {
  resetEvidence();
  withBrokenPath(() => {
    const root = globalRoot({ refresh: false, record: true });
    assert.ok(root, 'resolveGlobalRoot() fallback still answers with no cache at all');
    assert.ok(fs.existsSync(evidenceFile('npm-global-root', 'machine')), 'the resolve is recorded for next time');
  });
  resetEvidence();
});

test('a bare globalRoot() call resolves but writes no evidence (record defaults to false)', () => {
  resetEvidence();
  withBrokenPath(() => {
    const root = globalRoot();
    assert.ok(root, 'the resolve itself must still run and return a real result');
    assert.equal(fs.existsSync(evidenceFile('npm-global-root', 'machine')), false,
      'record defaults to false: only status.mjs\'s own warming call opts in');
  });
  resetEvidence();
});

// Regression guard for the design in status.mjs's collect(): persistence for
// this evidence kind is entirely collect()'s responsibility (it is the one
// caller that warms globalRoot()'s memo with a real refresh/record), NOT an
// incidental property of "nothing else happens to call globalRoot() first".
// If a future change adds a bare globalRoot() call anywhere ahead of
// collect()'s own warming line in the same process, this proves the design
// still holds: a bare call never persists, whether it runs before collect()
// (cold memo, no evidence yet), right after it (memo-hit), or later still
// with a cold memo but warm evidence (cache-hit) — only collect()'s explicit
// `record: true` call, once, ever writes anything. `withBrokenPath` is not
// reused here because its `finally` would run before an async body settles.
test("collect() alone persists npm-global-root evidence; a bare globalRoot() call never does, before or after it", async () => {
  resetEvidence();
  const prevPath = process.env.PATH;
  const prevConfigHome = process.env.XDG_CONFIG_HOME;
  const prevAppData = process.env.APPDATA;
  process.env.PATH = path.join(os.tmpdir(), 'ak-global-root-collect-no-such-bin');
  process.env.XDG_CONFIG_HOME = tempDir('ak-global-root-collect-config');
  process.env.APPDATA = process.env.XDG_CONFIG_HOME;
  _setGlobalRootForTest(null);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-global-root-collect-cwd-'));
  try {
    // Simulates a hypothetical future call path reaching globalRoot() BEFORE
    // status.mjs's collect() ever runs.
    globalRoot();
    assert.equal(fs.existsSync(evidenceFile('npm-global-root', 'machine')), false,
      'a bare globalRoot() call never persists, even as the very first call in the process');
    _setGlobalRootForTest(null);

    const { collect } = await import('../../src/commands/status.mjs');
    await collect({
      pkgRoot: PKG_ROOT, cwd, refresh: false, record: true,
    });
    const inputsKey = globalRootInputsKey();
    const record1 = readEvidence('npm-global-root', 'machine', { inputsKey });
    assert.ok(record1, "collect()'s own warming call is what persists the evidence");
    const checkedAt1 = record1.checkedAt;

    // Memo now warm (set by collect()'s warming call): a bare call hits the
    // memo and does not write again.
    globalRoot();
    assert.equal(readEvidence('npm-global-root', 'machine', { inputsKey }).checkedAt, checkedAt1,
      'a bare globalRoot() call after collect() does not persist again (memo-hit)');

    // Memo dropped again but evidence still warm: a bare call reuses the
    // cache (refresh:false default) but STILL never writes — the cache-hit
    // return happens before the `if (record)` line is ever reached, same as
    // the memo-hit path above.
    _setGlobalRootForTest(null);
    globalRoot();
    assert.equal(readEvidence('npm-global-root', 'machine', { inputsKey }).checkedAt, checkedAt1,
      'a bare globalRoot() call never persists, memo warm or cold — only collect() opts in');
  } finally {
    process.env.PATH = prevPath;
    if (prevConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevConfigHome;
    if (prevAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = prevAppData;
    _setGlobalRootForTest(null);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
  resetEvidence();
});
