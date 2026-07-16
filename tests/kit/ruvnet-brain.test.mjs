import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  kbDir, present, installedVersion, classifyDrift,
  INSTALL_SPEC, INSTALL_ARGS, REPO,
} from '../../src/lib/ruvnet-brain.mjs';
import { BUILTIN_BLOCKS, detect } from '../../src/lib/blocks.mjs';
import { loadKitConfig, saveKitConfig } from '../../src/lib/config.mjs';

const withEnv = (key, value, fn) => {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
};

test('kbDir honors $RUVNET_BRAIN_KB, else defaults under ~/.cache', () => {
  withEnv('RUVNET_BRAIN_KB', '/custom/kb', () => {
    assert.equal(kbDir(), '/custom/kb');
  });
  withEnv('RUVNET_BRAIN_KB', undefined, () => {
    assert.ok(kbDir().endsWith(path.join('.cache', 'ruvnet-brain', 'kb')));
  });
});

test('install spec/args stay pinned to the GitHub installer with --no-stack --no-enhance', () => {
  // Regression lock: ak owns ruflo/RuVector + the CLAUDE.md block, so these two
  // flags MUST persist or the installer double-manages them.
  assert.equal(REPO, 'stuinfla/ruvnet-brain');
  assert.equal(INSTALL_SPEC, 'github:stuinfla/ruvnet-brain');
  assert.ok(INSTALL_ARGS.includes('--no-stack'));
  assert.ok(INSTALL_ARGS.includes('--no-enhance'));
  assert.ok(INSTALL_ARGS.includes('--yes'));
});

test('present() is true when the KB entrypoint exists (forge-mcp-all.mjs)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-kb-'));
  fs.writeFileSync(path.join(tmp, 'forge-mcp-all.mjs'), '// stub');
  withEnv('RUVNET_BRAIN_KB', tmp, () => {
    assert.equal(present(), true);
  });
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('installedVersion() returns null or a version string (never throws)', () => {
  const v = installedVersion();
  assert.ok(v === null || typeof v === 'string');
});

test('classifyDrift compares in the RELEASE-TAG namespace and converges', () => {
  // absent → never outdated
  assert.deepEqual(
    classifyDrift({ present: false, installedRelease: null, latest: '3.0.1' }),
    { present: false, outdated: false, unversioned: false, installedRelease: null, latest: '3.0.1' });

  // present + ak-stamped older release + newer latest → outdated
  const older = classifyDrift({ present: true, installedRelease: '3.0.0', latest: '3.0.1' });
  assert.equal(older.outdated, true);
  assert.equal(older.unversioned, false);

  // present + stamp == latest → converged (this is what a refresh achieves; the
  // OLD bug compared plugin semver 0.5.0-dev vs 3.0.1 and could never reach this)
  assert.equal(classifyDrift({ present: true, installedRelease: '3.0.1', latest: '3.0.1' }).outdated, false);

  // present but ak never stamped a release (manual/pre-existing) + latest known →
  // surfaced as outdated ONCE so `ak sync` pulls it onto the managed track
  const unstamped = classifyDrift({ present: true, installedRelease: null, latest: '3.0.1' });
  assert.equal(unstamped.outdated, true);
  assert.equal(unstamped.unversioned, true);

  // latest unknown (offline / rate-limited) → never falsely outdated
  assert.equal(classifyDrift({ present: true, installedRelease: null, latest: null }).outdated, false);
  assert.equal(classifyDrift({ present: true, installedRelease: '3.0.0', latest: null }).outdated, false);
});

test('BUILTIN_BLOCKS carries the ruvnet-brain-reference row gated on the KB dir', async () => {
  const row = BUILTIN_BLOCKS.find((b) => b.slug === 'ruvnet-brain-reference');
  assert.ok(row, 'row must be registered');
  assert.equal(row.template, 'ruvnet-brain-reference.md');
  assert.equal(row.detector.type, 'dir');
  assert.equal(row.detector.target, '~/.cache/ruvnet-brain/kb');
  // dir detector: true when the target exists, false when absent
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-det-'));
  assert.equal(await detect({ type: 'dir', target: tmp }), true);
  assert.equal(await detect({ type: 'dir', target: path.join(tmp, 'nope') }), false);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('the ruvnet-brain-reference template ships and is self-sentineled', () => {
  const tpl = path.join(process.cwd(), 'claude', 'ruvnet-brain-reference.md');
  assert.ok(fs.existsSync(tpl), 'template must exist under claude/');
  const body = fs.readFileSync(tpl, 'utf8');
  assert.ok(body.includes('<!-- BEGIN ruvnet-brain-reference -->'));
  assert.ok(body.includes('<!-- END ruvnet-brain-reference -->'));
});

test('kit config: ruvnetBrain defaults true and round-trips a false override', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-cfg-'));
  const f = path.join(tmp, 'kit.json');
  assert.equal(loadKitConfig(f).ruvnetBrain, true, 'default is on');
  const cfg = loadKitConfig(f);
  cfg.ruvnetBrain = false;
  saveKitConfig(cfg, f);
  assert.equal(loadKitConfig(f).ruvnetBrain, false, 'override persists');
  fs.rmSync(tmp, { recursive: true, force: true });
});
