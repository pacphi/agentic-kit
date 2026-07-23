// Slice 1 — the agentOverrides projection: applyAqeRouter materializes the
// dualRouting policy into .agentic-qe/llm-config.json, version-gated on aqe ≥ 3.13.1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyAqeRouter, aqeRouterFile, undoAqeRouter, ensureCodexMcp, undoCodexMcp } from '../../src/lib/providers.mjs';
import { seedDualRouting } from '../../src/lib/routing.mjs';
import { _setGlobalRootForTest } from '../../src/lib/paths.mjs';

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-route-'));
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  return dir;
}
const rm = (dir) => fs.rmSync(dir, { recursive: true, force: true });

/** Point installedVersion('agentic-qe') at a synthetic global root. */
function fakeAqe(version) {
  const groot = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-groot-'));
  if (version !== null) {
    const pkg = path.join(groot, 'agentic-qe');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'agentic-qe', version }));
  }
  _setGlobalRootForTest(groot);
  return groot;
}

const cfgWith = (extra) => ({ providers: { aqeProvider: null, aqeFallback: [], dualRouting: {}, ...extra } });
const readDisk = (dir) => JSON.parse(fs.readFileSync(aqeRouterFile(dir), 'utf8'));

test('writes agentOverrides from a seeded policy when aqe ≥ 3.13.1', () => {
  const groot = fakeAqe('3.13.1');
  const dir = tmpProject();
  const res = applyAqeRouter(cfgWith({ dualRouting: seedDualRouting() }), dir);

  assert.equal(res.changed, true);
  const disk = readDisk(dir);
  assert.equal(disk._managedBy, 'agentic-kit');
  assert.ok(disk.agentOverrides, 'agentOverrides present');
  // security agents route to codex, review agents to claude-code (grounded defaults)
  assert.equal(disk.agentOverrides['qe-security-scanner'].provider, 'codex');
  assert.equal(disk.agentOverrides['qe-code-reviewer'].provider, 'claude-code');
  assert.ok(disk.agentOverrides['qe-test-architect'].model, 'model populated');
  rm(dir); rm(groot);
});

test('skips agentOverrides on aqe < 3.13.1 and says so', () => {
  const groot = fakeAqe('3.13.0');
  const dir = tmpProject();
  const res = applyAqeRouter(cfgWith({ dualRouting: seedDualRouting() }), dir);

  assert.match(res.detail, /skipped/);
  assert.equal(res.changed, false, 'nothing written when only a gated-out policy exists');
  assert.equal(fs.existsSync(aqeRouterFile(dir)), false, 'no bare file created');
  rm(dir); rm(groot);
});

test('a policy-only project (no fallback chain) still materializes the file', () => {
  const groot = fakeAqe('3.13.1');
  const dir = tmpProject();
  const res = applyAqeRouter(cfgWith({ dualRouting: seedDualRouting() }), dir);

  assert.equal(res.changed, true);
  const disk = readDisk(dir);
  assert.equal(disk._managedBy, 'agentic-kit');
  assert.ok(disk.agentOverrides);
  assert.equal(disk.fallbackChain, undefined, 'no chain written when none configured');
  rm(dir); rm(groot);
});

test('chain and agentOverrides are written together and never persist apiKey', () => {
  const groot = fakeAqe('3.13.1');
  const dir = tmpProject();
  const cfg = cfgWith({
    aqeProvider: 'claude-code',
    aqeFallback: [{ provider: 'claude-code', models: ['claude-opus-4-8'] }],
    dualRouting: seedDualRouting(),
  });
  const res = applyAqeRouter(cfg, dir);

  const disk = readDisk(dir);
  assert.match(res.detail, /chain:/);
  assert.match(res.detail, /agentOverrides:/);
  assert.equal(disk.defaultProvider, 'claude-code');
  assert.ok(disk.fallbackChain && disk.agentOverrides);
  const leaked = JSON.stringify(disk).includes('apiKey');
  assert.equal(leaked, false, 'never writes apiKey');
  rm(dir); rm(groot);
});

test('agentOverrides MERGES — a foreign entry survives (H1: never clobbered)', () => {
  const groot = fakeAqe('3.13.1');
  const dir = tmpProject();
  fs.mkdirSync(path.dirname(aqeRouterFile(dir)), { recursive: true });
  fs.writeFileSync(aqeRouterFile(dir), JSON.stringify({
    _managedBy: 'agentic-kit',
    agentOverrides: { 'qe-custom-agent': { provider: 'ollama' } }, // outside ak's curated map
  }));
  applyAqeRouter(cfgWith({ dualRouting: seedDualRouting() }), dir);

  const disk = readDisk(dir);
  assert.deepEqual(disk.agentOverrides['qe-custom-agent'], { provider: 'ollama' }, 'foreign entry preserved');
  assert.ok(disk.agentOverrides['qe-security-scanner'], 'ak curated entry still written');
  rm(dir); rm(groot);
});

test('an invalid fallback chain does not block the agentOverrides projection (M3)', () => {
  const groot = fakeAqe('3.13.1');
  const dir = tmpProject();
  const res = applyAqeRouter(cfgWith({ aqeFallback: [{ provider: 'not-a-provider', models: [] }], dualRouting: seedDualRouting() }), dir);

  assert.equal(res.changed, true, 'still wrote agentOverrides');
  assert.equal(res.ok, false, 'but surfaces the chain error');
  const disk = readDisk(dir);
  assert.ok(disk.agentOverrides['qe-security-scanner'], 'agentOverrides written despite the bad chain');
  assert.equal(disk.fallbackChain, undefined, 'no chain written');
  rm(dir); rm(groot);
});

test('codex MCP teardown is a no-op unless ak owns it (H2), and never shells when codex is off', async () => {
  const off = await undoCodexMcp(process.cwd(), { managed: false });
  assert.equal(off.changed, false);
  assert.match(off.detail, /left as-is/);
  const ensure = await ensureCodexMcp({ providers: { hosts: { claude: true, codex: false } } });
  assert.equal(ensure.changed, false);
  assert.match(ensure.detail, /not enabled/);
});

test('undoAqeRouter removes the ak-created file (agentOverrides included)', () => {
  const groot = fakeAqe('3.13.1');
  const dir = tmpProject();
  applyAqeRouter(cfgWith({ dualRouting: seedDualRouting() }), dir);
  assert.equal(fs.existsSync(aqeRouterFile(dir)), true);

  const undo = undoAqeRouter(dir);
  assert.equal(undo.changed, true);
  assert.equal(fs.existsSync(aqeRouterFile(dir)), false);
  rm(dir); rm(groot);
});
