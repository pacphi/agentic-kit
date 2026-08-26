// Slice 1 — the agentOverrides projection: applyAqeRouter materializes the
// routes policy into .agentic-qe/llm-config.json, version-gated on aqe ≥ 3.13.1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyAqeRouter, aqeRouterFile, undoAqeRouter, retireCodexMcp, ensureRufloMcpInCodex, undoCodexMcp, undoRufloMcpInCodex } from '../../src/lib/providers.mjs';
import { seedActivityRoutes } from '../../src/lib/routing.mjs';
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

const cfgWith = ({ routes = {}, ...providers } = {}) => ({
  routing: { version: 1, primaryHost: 'claude', routes },
  providers: { aqeProvider: null, aqeFallback: [], ...providers },
});
const readDisk = (dir) => JSON.parse(fs.readFileSync(aqeRouterFile(dir), 'utf8'));

test('writes agentOverrides from a seeded policy when aqe ≥ 3.13.1', () => {
  const groot = fakeAqe('3.13.1');
  const dir = tmpProject();
  const res = applyAqeRouter(cfgWith({ routes: seedActivityRoutes() }), dir);

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
  const res = applyAqeRouter(cfgWith({ routes: seedActivityRoutes() }), dir);

  assert.match(res.detail, /skipped/);
  assert.equal(res.changed, false, 'nothing written when only a gated-out policy exists');
  assert.equal(fs.existsSync(aqeRouterFile(dir)), false, 'no bare file created');
  rm(dir); rm(groot);
});

test('a policy-only project (no fallback chain) still materializes the file', () => {
  const groot = fakeAqe('3.13.1');
  const dir = tmpProject();
  const res = applyAqeRouter(cfgWith({ routes: seedActivityRoutes() }), dir);

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
    routes: seedActivityRoutes(),
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

// #108 phase 3: aqe reaches a provider only through defaultProvider, the
// fallbackChain, or its FALLBACK_PRIORITY list — which contains neither codex
// nor claude-code. A codex CHAIN RUNG is therefore the sanctioned way to make
// the subscription Codex CLI provider live, and ak's chain gate must admit it.
test('a codex chain rung is admitted, enabled, and keeps its order (chain gate)', () => {
  const groot = fakeAqe('3.13.1');
  const dir = tmpProject();
  const res = applyAqeRouter(cfgWith({
    aqeProvider: 'claude-code',
    aqeFallback: [
      { provider: 'claude-code', models: ['claude-opus-5'] },
      { provider: 'codex', models: ['gpt-5.6-terra'] },
      { provider: 'openrouter', models: ['z-ai/glm-5.2'] },
    ],
    routes: seedActivityRoutes(),
  }), dir);

  const disk = readDisk(dir);
  assert.match(res.detail, /chain: claude-code → codex → openrouter/);
  assert.equal(disk.fallbackChain.entries[1].provider, 'codex');
  assert.deepEqual(disk.fallbackChain.entries[1].models, ['gpt-5.6-terra']);
  assert.equal(disk.providers.codex.enabled, true, 'chain rung enables the provider');
  rm(dir); rm(groot);
});

// #108 phase 3: an override naming a provider aqe must construct is inert
// until that provider is enabled in this same file — subscription host-CLI
// providers (codex, claude-code) have no env key to auto-enable them.
test('the overrides projection enables exactly the providers it references', () => {
  const groot = fakeAqe('3.13.1');
  const dir = tmpProject();
  fs.mkdirSync(path.dirname(aqeRouterFile(dir)), { recursive: true });
  fs.writeFileSync(aqeRouterFile(dir), JSON.stringify({
    _managedBy: 'agentic-kit',
    providers: { openrouter: { enabled: true, custom: 'kept' }, codex: { note: 'foreign config survives' } },
  }));
  const res = applyAqeRouter(cfgWith({ routes: seedActivityRoutes() }), dir);

  const disk = readDisk(dir);
  assert.match(res.detail, /providers enabled: .*codex/);
  assert.equal(disk.providers.codex.enabled, true, 'codex override provider enabled');
  assert.equal(disk.providers.codex.note, 'foreign config survives', 'merge, not clobber');
  assert.equal(disk.providers['claude-code'].enabled, true, 'claude-code override provider enabled');
  assert.deepEqual(disk.providers.openrouter, { enabled: true, custom: 'kept' }, 'unreferenced provider untouched');
  assert.equal(JSON.stringify(disk).includes('apiKey'), false);
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
  applyAqeRouter(cfgWith({ routes: seedActivityRoutes() }), dir);

  const disk = readDisk(dir);
  assert.deepEqual(disk.agentOverrides['qe-custom-agent'], { provider: 'ollama' }, 'foreign entry preserved');
  assert.ok(disk.agentOverrides['qe-security-scanner'], 'ak curated entry still written');
  rm(dir); rm(groot);
});

test('stale curated overrides are pruned while configured and foreign entries survive', () => {
  const groot = fakeAqe('3.13.1');
  const dir = tmpProject();
  fs.mkdirSync(path.dirname(aqeRouterFile(dir)), { recursive: true });
  fs.writeFileSync(aqeRouterFile(dir), JSON.stringify({
    _managedBy: 'agentic-kit',
    agentOverrides: {
      'qe-security-scanner': { provider: 'codex', model: 'gpt-5.4' },
      'qe-code-reviewer': { provider: 'claude-code', model: 'claude-sonnet-5' },
      'qe-custom-agent': { provider: 'ollama' },
    },
  }));
  const res = applyAqeRouter(cfgWith({ routes: {
    review: { host: 'claude', model: 'claude-sonnet-5', provenance: 'user' },
  } }), dir);
  const disk = readDisk(dir);
  assert.match(res.detail, /stale ak entries pruned/);
  assert.equal(disk.agentOverrides['qe-security-scanner'], undefined);
  assert.deepEqual(disk.agentOverrides['qe-code-reviewer'], { provider: 'claude-code', model: 'claude-sonnet-5' });
  assert.deepEqual(disk.agentOverrides['qe-custom-agent'], { provider: 'ollama' });
  rm(dir); rm(groot);
});

test('an invalid fallback chain does not block the agentOverrides projection (M3)', () => {
  const groot = fakeAqe('3.13.1');
  const dir = tmpProject();
  const res = applyAqeRouter(cfgWith({ aqeFallback: [{ provider: 'not-a-provider', models: [] }], routes: seedActivityRoutes() }), dir);

  assert.equal(res.changed, true, 'still wrote agentOverrides');
  assert.equal(res.ok, false, 'but surfaces the chain error');
  const disk = readDisk(dir);
  assert.ok(disk.agentOverrides['qe-security-scanner'], 'agentOverrides written despite the bad chain');
  assert.equal(disk.fallbackChain, undefined, 'no chain written');
  rm(dir); rm(groot);
});

test('codex MCP teardown is a no-op unless ak owns it (H2)', async () => {
  const off = await undoCodexMcp(process.cwd(), { managed: false });
  assert.equal(off.changed, false);
  assert.match(off.detail, /left as-is/);
});

test('legacy codex MCP retirement removes and confirms only ak-owned state', async () => {
  const calls = [];
  const cfg = { integrations: { ownership: { codex: { mcp: 'ak', reverseMcp: 'ak' } } } };
  const observations = [
    { registered: true, owned: true },
    { registered: false, owned: true },
  ];
  const result = await retireCodexMcp(cfg, '/work/project', {
    runner: async (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return { code: 0, stdout: '', stderr: '' };
    },
    inspect: () => observations.shift(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.deepEqual(calls, [
    { cmd: 'claude', args: ['mcp', 'remove', 'codex', '-s', 'project'], opts: { cwd: '/work/project' } },
  ]);
  assert.equal(cfg.integrations.ownership.codex.mcp, null);
  assert.equal(cfg.integrations.ownership.codex.reverseMcp, 'ak', 'independent Ruflo receipt survives');
});

test('legacy codex MCP retirement preserves an unowned registration and gives a manual remedy', async () => {
  const cfg = { integrations: { ownership: { codex: { mcp: null } } } };
  let called = false;
  const result = await retireCodexMcp(cfg, '/work/project', {
    runner: async () => { called = true; return { code: 0, stdout: '', stderr: '' }; },
    inspect: () => ({ registered: true, owned: false }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.changed, false);
  assert.equal(called, false);
  assert.match(result.detail, /user-owned/);
  assert.match(result.detail, /claude mcp remove codex -s project/);
});

test('legacy codex MCP retirement keeps its ownership receipt when removal cannot be confirmed', async () => {
  const cfg = { integrations: { ownership: { codex: { mcp: 'ak' } } } };
  const result = await retireCodexMcp(cfg, '/work/project', {
    runner: async () => ({ code: 0, stdout: '', stderr: '' }),
    inspect: () => ({ registered: true, owned: true }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.changed, false);
  assert.equal(cfg.integrations.ownership.codex.mcp, 'ak');
  assert.match(result.detail, /could not be confirmed/);
});

test('owned integration teardown sends the precise safe argv on every platform', async () => {
  const calls = [];
  const runner = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { code: 0, stdout: '', stderr: '' };
  };
  const cwd = '/work/project';

  const codex = await undoCodexMcp(cwd, { managed: true, runner });
  const ruflo = await undoRufloMcpInCodex(cwd, { managed: true, runner, haveFn: async () => true });

  assert.equal(codex.changed, true);
  assert.equal(ruflo.changed, true);
  assert.deepEqual(calls, [
    { cmd: 'claude', args: ['mcp', 'remove', 'codex', '-s', 'project'], opts: { cwd } },
    { cmd: 'codex', args: ['mcp', 'remove', 'ruflo'], opts: { cwd } },
  ]);
});

test('failed owned MCP teardown is explicit so callers retain ownership receipts', async () => {
  const runner = async () => ({ code: 7, stdout: '', stderr: 'permission denied' });
  const codex = await undoCodexMcp('/work/project', { managed: true, runner });
  const ruflo = await undoRufloMcpInCodex('/work/project', {
    managed: true, runner, haveFn: async () => true,
  });
  assert.equal(codex.ok, false);
  assert.equal(codex.changed, false);
  assert.match(codex.detail, /permission denied/);
  assert.equal(ruflo.ok, false);
  assert.equal(ruflo.changed, false);
  assert.match(ruflo.detail, /permission denied/);
});

test('Codex Ruflo integration uses the workspace-aware memory launcher and migrates only ak-owned state', async () => {
  const calls = [];
  const runner = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { code: 0, stdout: '', stderr: '' };
  };
  const cfg = {
    integrations: {
      hosts: { codex: true },
      ownership: { codex: { reverseMcp: 'ak' } },
    },
  };
  const result = await ensureRufloMcpInCodex(cfg, '/work/project', {
    runner,
    haveFn: async () => true,
    inspect: () => ({ registered: true, owned: true, command: 'ruflo', args: ['mcp', 'start'] }),
  });
  assert.equal(result.changed, true);
  assert.deepEqual(calls, [
    { cmd: 'codex', args: ['mcp', 'remove', 'ruflo'], opts: { cwd: '/work/project' } },
    { cmd: 'codex', args: ['mcp', 'add', 'ruflo', '--', 'ak', 'x', 'ruflo-mcp'], opts: { cwd: '/work/project' } },
  ]);

  calls.length = 0;
  const preserved = await ensureRufloMcpInCodex(cfg, '/work/project', {
    runner,
    haveFn: async () => true,
    inspect: () => ({ registered: true, owned: false, command: 'custom', args: [] }),
  });
  assert.equal(preserved.changed, false);
  assert.match(preserved.detail, /user-owned; left unchanged/);
  assert.deepEqual(calls, []);
});

test('undoAqeRouter removes the ak-created file (agentOverrides included)', () => {
  const groot = fakeAqe('3.13.1');
  const dir = tmpProject();
  applyAqeRouter(cfgWith({ routes: seedActivityRoutes() }), dir);
  assert.equal(fs.existsSync(aqeRouterFile(dir)), true);

  const undo = undoAqeRouter(dir);
  assert.equal(undo.changed, true);
  assert.equal(fs.existsSync(aqeRouterFile(dir)), false);
  rm(dir); rm(groot);
});
