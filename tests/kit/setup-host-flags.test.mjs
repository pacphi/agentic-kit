import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySetupHostFlags } from '../../src/lib/providers.mjs';

const freshCfg = () => ({ providers: { hosts: { claude: true, codex: false } } });

test('no flags → claude-only default is left untouched', () => {
  const cfg = freshCfg();
  const r = applySetupHostFlags(cfg, {});
  assert.equal(cfg.providers.hosts.codex, false);
  assert.equal(r.changed, false);
});

test('--codex enables both hosts and reports changed', () => {
  const cfg = freshCfg();
  const r = applySetupHostFlags(cfg, { codex: true });
  assert.equal(cfg.providers.hosts.claude, true);
  assert.equal(cfg.providers.hosts.codex, true);
  assert.equal(r.changed, true);
});

test('--primary-host codex implies enabling codex', () => {
  const cfg = freshCfg();
  applySetupHostFlags(cfg, { 'primary-host': 'codex' });
  assert.equal(cfg.providers.hosts.codex, true);
  assert.equal(cfg.providers.primaryHost, 'codex');
});

test('--primary-host claude does not enable codex', () => {
  const cfg = freshCfg();
  applySetupHostFlags(cfg, { 'primary-host': 'claude' });
  assert.equal(cfg.providers.hosts.codex, false);
  assert.equal(cfg.providers.primaryHost, 'claude');
});

test('an unknown --primary-host is ignored with a warning, codex untouched', () => {
  const cfg = freshCfg();
  const r = applySetupHostFlags(cfg, { 'primary-host': 'gemini' });
  assert.equal(cfg.providers.primaryHost, undefined);
  assert.equal(cfg.providers.hosts.codex, false);
  assert.equal(r.warnings.length, 1);
});

test('--codex is idempotent — a second application reports no change', () => {
  const cfg = { providers: { hosts: { claude: true, codex: true } } };
  const r = applySetupHostFlags(cfg, { codex: true });
  assert.equal(r.changed, false);
});
