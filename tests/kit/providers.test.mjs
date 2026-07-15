import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJson } from '../../src/lib/settings.mjs';
import { loadKitConfig } from '../../src/lib/config.mjs';
import {
  isDefault, managedEnv, applyHosts, undoProviders, MANAGED_ENV_KEYS,
  HOSTS, installHost, updateHost, applyAqeRouter, undoAqeRouter, aqeRouterFile,
  CODEX_ADAPTER_PKG, codexAdapterAction, ensureCodexAdapter, AQE_PROVIDER_TYPES,
} from '../../src/lib/providers.mjs';

// A tmp dir with a .git marker → settingsTarget() writes the ISOLATED
// project settings.local.json instead of the real ~/.claude/settings.json.
function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-prov-'));
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  return dir;
}
const localFile = (dir) => path.join(dir, '.claude', 'settings.local.json');
const rm = (dir) => fs.rmSync(dir, { recursive: true, force: true });

function defaultCfg() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-cfg-'));
  const cfg = loadKitConfig(path.join(dir, 'kit.json'));
  rm(dir);
  return cfg;
}

test('isDefault is true for the claude-only default config', () => {
  assert.equal(isDefault(defaultCfg()), true);
});

test('isDefault is false once codex is enabled', () => {
  const cfg = defaultCfg();
  cfg.providers.hosts.codex = true;
  assert.equal(isDefault(cfg), false);
});

test('managedEnv leaves AQE_LLM_PROVIDER unset when no aqe provider is pinned', () => {
  const cfg = defaultCfg();
  cfg.providers.hosts.codex = true; // host axis is independent of the aqe provider
  const env = managedEnv(cfg);
  assert.equal(env.ENABLE_CLAUDE_CODE, 'true');
  assert.equal(env.ENABLE_CODEX, 'true');
  assert.equal('AQE_LLM_PROVIDER' in env, false, 'unset aqeProvider → aqe keeps its own default');
});

test('managedEnv writes AQE_LLM_PROVIDER for any supported provider (not just claude-code)', () => {
  for (const provider of ['claude-code', 'openai', 'gemini', 'ollama']) {
    const cfg = defaultCfg();
    cfg.providers.aqeProvider = provider;
    assert.equal(managedEnv(cfg).AQE_LLM_PROVIDER, provider, `${provider} wired`);
  }
});

test('managedEnv ignores an unknown aqe provider value', () => {
  const cfg = defaultCfg();
  cfg.providers.aqeProvider = 'bogus-model';
  assert.equal('AQE_LLM_PROVIDER' in managedEnv(cfg), false);
});

test('managedEnv adds AQE_MAX_BUDGET_USD only when a budget is set', () => {
  const cfg = defaultCfg();
  cfg.providers.hosts.codex = true;
  cfg.providers.maxBudgetUsd = 5;
  assert.equal(managedEnv(cfg).AQE_MAX_BUDGET_USD, '5');
});

test('applyHosts is a no-op at the claude-only default (writes nothing)', () => {
  const dir = tmpProject();
  const res = applyHosts(defaultCfg(), dir);
  assert.equal(res.changed, false);
  assert.equal(fs.existsSync(localFile(dir)), false, 'no settings file created at default');
  rm(dir);
});

test('applyHosts writes managed env into project settings.local.json when codex is enabled', () => {
  // Arrange: an unrelated pre-existing env key must survive (merge-not-clobber)
  const dir = tmpProject();
  fs.mkdirSync(path.dirname(localFile(dir)), { recursive: true });
  fs.writeFileSync(localFile(dir), JSON.stringify({ env: { FOO: 'bar' } }));
  const cfg = defaultCfg();
  cfg.providers.hosts.codex = true;
  // Act
  const res = applyHosts(cfg, dir);
  // Assert
  assert.equal(res.changed, true);
  const env = readJson(localFile(dir)).env;
  assert.equal(env.ENABLE_CODEX, 'true');
  assert.equal(env.ENABLE_CLAUDE_CODE, 'true');
  assert.equal(env.FOO, 'bar', 'unrelated env key preserved');
  rm(dir);
});

test('applyHosts is idempotent — second run reports no change', () => {
  const dir = tmpProject();
  const cfg = defaultCfg();
  cfg.providers.hosts.codex = true;
  applyHosts(cfg, dir);
  const second = applyHosts(cfg, dir);
  assert.equal(second.changed, false);
  rm(dir);
});

test('undoProviders strips every managed key and leaves others intact', () => {
  const dir = tmpProject();
  const cfg = defaultCfg();
  cfg.providers.hosts.codex = true;
  applyHosts(cfg, dir);
  // seed an unrelated key alongside the managed ones
  const seeded = readJson(localFile(dir));
  seeded.env.CLAUDE_FLOW_DB_PATH = '/x/memory.db';
  fs.writeFileSync(localFile(dir), JSON.stringify(seeded));
  // Act
  const res = undoProviders(dir);
  // Assert
  assert.equal(res.changed, true);
  const env = readJson(localFile(dir)).env;
  for (const k of MANAGED_ENV_KEYS) assert.equal(k in env, false, `${k} removed`);
  assert.equal(env.CLAUDE_FLOW_DB_PATH, '/x/memory.db', 'unrelated key survives undo');
  rm(dir);
});

test('applyAqeRouter writes a complete ak-managed fallback chain to llm-config.json', () => {
  const dir = tmpProject();
  const cfg = defaultCfg();
  cfg.providers.aqeProvider = 'claude-code';
  cfg.providers.aqeFallback = [
    { provider: 'claude-code', models: ['claude-opus-4-8'] },
    { provider: 'openai', models: ['gpt-5.6', 'gpt-5.6-terra'] },
  ];
  const res = applyAqeRouter(cfg, dir);
  assert.equal(res.changed, true);
  const disk = JSON.parse(fs.readFileSync(aqeRouterFile(dir), 'utf8'));
  assert.equal(disk._managedBy, 'agentic-kit');
  assert.equal(disk.defaultProvider, 'claude-code');
  assert.deepEqual(disk.fallbackChain.entries.map((e) => e.provider), ['claude-code', 'openai']);
  assert.equal(disk.fallbackChain.entries[0].priority > disk.fallbackChain.entries[1].priority, true, 'priority descends by order');
  assert.equal(disk.fallbackChain.maxRetries, 3, 'complete chain carries scalar defaults');
  assert.equal(disk.providers.openai.enabled, true);
  assert.equal('apiKey' in (disk.providers.openai), false, 'never persists apiKey');
  rm(dir);
});

test('applyAqeRouter is a no-op with no fallback chain configured', () => {
  const dir = tmpProject();
  const res = applyAqeRouter(defaultCfg(), dir);
  assert.equal(res.changed, false);
  assert.equal(fs.existsSync(aqeRouterFile(dir)), false);
  rm(dir);
});

test('undoAqeRouter removes an ak-created llm-config.json (no prior file)', () => {
  const dir = tmpProject();
  const cfg = defaultCfg();
  cfg.providers.aqeFallback = [{ provider: 'openai', models: ['gpt-5.6'] }];
  applyAqeRouter(cfg, dir);
  assert.equal(fs.existsSync(aqeRouterFile(dir)), true);
  const res = undoAqeRouter(dir);
  assert.equal(res.changed, true);
  assert.equal(fs.existsSync(aqeRouterFile(dir)), false, 'ak-created file removed');
  rm(dir);
});

test('undoAqeRouter restores a pre-existing user llm-config.json from backup', () => {
  const dir = tmpProject();
  const file = aqeRouterFile(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ defaultProvider: 'gemini', userKey: 'keep-me' }));
  const cfg = defaultCfg();
  cfg.providers.aqeFallback = [{ provider: 'openai', models: ['gpt-5.6'] }];
  applyAqeRouter(cfg, dir); // overwrites, backs up first
  const restored = undoAqeRouter(dir);
  assert.equal(restored.changed, true);
  const back = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(back.userKey, 'keep-me', 'user config restored from .bak');
  assert.equal('_managedBy' in back, false);
  rm(dir);
});

test('undoAqeRouter leaves a foreign (non-ak) llm-config.json untouched', () => {
  const dir = tmpProject();
  const file = aqeRouterFile(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ defaultProvider: 'gemini' }));
  const res = undoAqeRouter(dir);
  assert.equal(res.changed, false);
  assert.equal(fs.existsSync(file), true, 'foreign file left as-is');
  rm(dir);
});

test('every host descriptor carries an npm package name for install/update', () => {
  for (const h of HOSTS) assert.equal(typeof h.pkg, 'string', `${h.id} has pkg`);
});

test('installHost rejects an unknown host id without shelling out', async () => {
  const r = await installHost('bogus');
  assert.equal(r.ok, false);
  assert.match(r.detail, /unknown host/);
});

test('updateHost rejects an unknown host id without shelling out', async () => {
  const r = await updateHost('bogus');
  assert.equal(r.ok, false);
  assert.match(r.detail, /unknown host/);
});

test('config merge: providers partial merges over defaults (hosts deep-merged)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-merge-'));
  const f = path.join(dir, 'kit.json');
  fs.writeFileSync(f, JSON.stringify({ providers: { hosts: { codex: true } } }));
  const cfg = loadKitConfig(f);
  assert.equal(cfg.providers.hosts.codex, true, 'user value applied');
  assert.equal(cfg.providers.hosts.claude, true, 'unspecified host keeps default');
  assert.equal(cfg.providers.aqeProvider, null, 'unspecified field keeps default');
  rm(dir);
});

test('isDefault is false once an aqe provider is pinned (independent of hosts)', () => {
  const cfg = defaultCfg();
  cfg.providers.aqeProvider = 'openai';
  assert.equal(isDefault(cfg), false);
});

test('AQE_PROVIDER_TYPES mirrors aqe ALL_PROVIDER_TYPES (incl. local onnx)', () => {
  // Guards against drift from aqe's dist/shared/llm/router/types.js. Order-
  // independent set comparison; the point is coverage, not sequence.
  const expected = [
    'claude', 'claude-code', 'openai', 'ollama', 'openrouter',
    'gemini', 'azure-openai', 'bedrock', 'cognitum', 'onnx',
  ];
  assert.deepEqual([...AQE_PROVIDER_TYPES].sort(), [...expected].sort());
  assert.equal(AQE_PROVIDER_TYPES.includes('onnx'), true, 'onnx (local) is a valid aqe provider');
});

test('the codex host descriptor carries the dual-mode adapter package name', () => {
  const codex = HOSTS.find((h) => h.id === 'codex');
  assert.equal(codex.adapterPkg, CODEX_ADAPTER_PKG);
  assert.equal(CODEX_ADAPTER_PKG, '@claude-flow/codex');
});

test('codexAdapterAction skips when codex host is not opted in', () => {
  const action = codexAdapterAction({ opted: false, cliPresent: true, adapterInstalled: false });
  assert.equal(action, 'skip-not-opted');
});

test('codexAdapterAction skips when opted in but the codex CLI is not detected', () => {
  const action = codexAdapterAction({ opted: true, cliPresent: false, adapterInstalled: false });
  assert.equal(action, 'skip-no-cli');
});

test('codexAdapterAction is a no-op when the adapter is already installed', () => {
  const action = codexAdapterAction({ opted: true, cliPresent: true, adapterInstalled: true });
  assert.equal(action, 'already-installed');
});

test('codexAdapterAction installs only when opted in, CLI present, adapter absent', () => {
  const action = codexAdapterAction({ opted: true, cliPresent: true, adapterInstalled: false });
  assert.equal(action, 'install');
});

test('ensureCodexAdapter is a no-op without shelling out when codex is disabled', async () => {
  const cfg = defaultCfg(); // claude-only default → hosts.codex false
  const res = await ensureCodexAdapter(cfg);
  assert.equal(res.ok, true);
  assert.equal(res.changed, false);
  assert.match(res.detail, /codex disabled/);
});
