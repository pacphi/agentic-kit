import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applySetupHostFlags } from '../../src/lib/providers.mjs';
import { loadKitConfig, saveKitConfig } from '../../src/lib/config.mjs';
import { defaultHostMap } from '../../src/lib/adapters/index.mjs';

const freshCfg = () => ({
  integrations: {
    version: 2,
    hosts: { claude: true, codex: false, opencode: false },
    bindings: [],
  },
  routing: { version: 1, primaryHost: 'claude', routes: {} },
  providers: {},
});

test('no flags → claude-only default is left untouched', () => {
  const cfg = freshCfg();
  const r = applySetupHostFlags(cfg, {});
  assert.equal(cfg.integrations.hosts.codex, false);
  assert.equal(r.changed, false);
});

test('--codex enables both hosts and reports changed', () => {
  const cfg = freshCfg();
  const r = applySetupHostFlags(cfg, { codex: true });
  assert.equal(cfg.integrations.hosts.claude, true);
  assert.equal(cfg.integrations.hosts.codex, true);
  assert.equal(r.changed, true);
});

test('--primary-host codex implies enabling codex', () => {
  const cfg = freshCfg();
  applySetupHostFlags(cfg, { 'primary-host': 'codex' });
  assert.equal(cfg.integrations.hosts.codex, true);
  assert.equal(cfg.routing.primaryHost, 'codex');
});

test('--primary-host claude does not enable codex', () => {
  const cfg = freshCfg();
  applySetupHostFlags(cfg, { 'primary-host': 'claude' });
  assert.equal(cfg.integrations.hosts.codex, false);
  assert.equal(cfg.routing.primaryHost, 'claude');
});

test('an unknown --primary-host is ignored with a warning, codex untouched', () => {
  const cfg = freshCfg();
  const r = applySetupHostFlags(cfg, { 'primary-host': 'zz-not-a-registered-host' });
  assert.equal(cfg.routing.primaryHost, 'claude');
  assert.equal(cfg.integrations.hosts.codex, false);
  assert.equal(r.warnings.length, 1);
});

test('--codex is idempotent — a second application reports no change', () => {
  const cfg = freshCfg();
  cfg.integrations.hosts.codex = true;
  const r = applySetupHostFlags(cfg, { codex: true });
  assert.equal(r.changed, false);
});

test('--opencode opts the opencode host in without touching claude/codex or primary', () => {
  const cfg = freshCfg();
  const r = applySetupHostFlags(cfg, { opencode: true });
  assert.equal(cfg.integrations.hosts.opencode, true);
  assert.equal(cfg.integrations.hosts.claude, true, 'claude is not replaced');
  assert.equal(cfg.integrations.hosts.codex, false, 'codex is not pulled in');
  assert.equal(cfg.routing.primaryHost, 'claude', 'an integration host does not alter primary');
  assert.equal(r.changed, true);
});

test('--opencode is idempotent — a second application reports no change', () => {
  const cfg = freshCfg();
  cfg.integrations.hosts.opencode = true;
  const r = applySetupHostFlags(cfg, { opencode: true });
  assert.equal(r.changed, false);
});

test('--primary-host opencode is ignored with a warning (integration hosts never lead)', () => {
  const cfg = freshCfg();
  const r = applySetupHostFlags(cfg, { opencode: true, 'primary-host': 'opencode' });
  assert.equal(cfg.integrations.hosts.opencode, true, 'the enablement itself still lands');
  assert.notEqual(cfg.routing.primaryHost, 'opencode');
  assert.equal(r.warnings.length, 1);
});

test('an empty config gets complete canonical envelopes and survives persistence', () => {
  const cfg = {};
  applySetupHostFlags(cfg, { codex: true });
  assert.deepEqual(cfg.routing, {
    version: 1,
    primaryHost: 'claude',
    routes: {},
  });
  assert.equal(cfg.integrations.version, 2);
  assert.deepEqual(cfg.integrations.hosts, { ...defaultHostMap(), codex: true });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-setup-empty-'));
  const file = path.join(dir, 'kit.json');
  saveKitConfig(cfg, file);
  assert.equal(loadKitConfig(file).routing.primaryHost, 'claude');
  fs.rmSync(dir, { recursive: true, force: true });
});
