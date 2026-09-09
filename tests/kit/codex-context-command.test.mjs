import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandboxHome, captureLog, snapshot, assertUnchanged } from './helpers/home-sandbox.mjs';

const root = sandboxHome('ak-context-command');
process.env.CODEX_HOME = path.join(root, '.codex');
const { loadKitConfig, saveKitConfig } = await import('../../src/lib/config.mjs');
const command = await import('../../src/commands/x/codex-context.mjs');
const section = (await import('../../src/commands/status/sections/codex-context.mjs')).default;
const { SYNC_STEPS } = await import('../../src/commands/sync.mjs');
const { UNINSTALL_STEPS } = await import('../../src/commands/uninstall.mjs');
const contextOptions = { runner: async () => ({ code: 0, stdout: 'codex-cli 0.153.4' }) };
const run = (positionals, flags = {}) => command.run({ positionals, flags, contextOptions });
function seed() {
  fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
  fs.writeFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), 'model = "gpt-6-astra"\n');
  fs.writeFileSync(path.join(process.env.CODEX_HOME, 'models_cache.json'), JSON.stringify({
    client_version: '0.153.4', fetched_at: new Date().toISOString(), models: [{
      slug: 'gpt-6-astra', context_window: 272000, max_context_window: 872000, effective_context_window_percent: 95,
    }],
  }));
  const cfg = loadKitConfig(); cfg.codexContext = null; cfg.integrations.hosts.codex = true; saveKitConfig(cfg);
}

test('command dry-run preserves both native config and persisted ownership', async () => {
  seed(); const before = snapshot(root);
  const output = await captureLog(() => run(['max'], { 'dry-run': true, json: true }));
  assert.equal(JSON.parse(output.out).requestedWindow, 872000);
  assertUnchanged(before, root, 'dry-run writes nothing');
});

test('max survives reload, status creates an actionable sync repair, and off restores original', async () => {
  seed(); await captureLog(() => run(['max']));
  const cfg = loadKitConfig();
  assert.equal(cfg.codexContext.lastProjection, 872000);
  const current = await section.collect({ cfg });
  assert.equal(current[0].level, 'ok');
  assert.equal(current[0].contextReport.hosts.find(h => h.host === 'codex').runtimeVerified, false);
  fs.writeFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), 'model = "gpt-6-astra"\n');
  const drift = await section.collect({ cfg });
  assert.ok(drift[0].fix);
  const step = SYNC_STEPS.find(s => s.id === 'codex-context');
  assert.equal(step.when(new Set(['codex-context']), {}, cfg), true);
  assert.equal(step.when(new Set(['codex-context']), {}, { ...cfg, integrations: { hosts: { codex: false } } }), false);
  await captureLog(() => run(['max']));
  await captureLog(() => run(['off']));
  assert.equal(loadKitConfig().codexContext, null);
  assert.equal(fs.readFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), 'utf8'), 'model = "gpt-6-astra"\n');
});

test('uninstall context step is dry-run safe and retains ownership when native restoration fails', async () => {
  seed(); await captureLog(() => run(['max']));
  const cfg = loadKitConfig();
  const step = UNINSTALL_STEPS.find(s => s.id === 'codex-context');
  const before = snapshot(root);
  await captureLog(() => step.run({ cfg, dry: true }));
  assertUnchanged(before, root, 'dry-run writes nothing');
  fs.writeFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), 'model_context_window = -1\n');
  const ctx = { cfg, dry: false, state: { ownershipTeardownOk: true } };
  await captureLog(() => step.run(ctx));
  assert.equal(ctx.state.ownershipTeardownOk, false);
  assert.ok(loadKitConfig().codexContext);
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
