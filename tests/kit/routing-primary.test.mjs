import { test } from 'node:test';
import assert from 'node:assert/strict';
import { swapHostModel, swapRoute, seedDualRouting, DEFAULT_ROUTES, DEFAULT_PRIMARY_HOST, PRIMARY_HOSTS } from '../../src/lib/routing.mjs';

// ── swapHostModel ────────────────────────────────────────────────────────────
test('swapHostModel maps a claude model to the codex host', () => {
  const r = swapHostModel('claude', 'claude-opus-4-8');
  assert.equal(r.host, 'codex');
  assert.ok(typeof r.model === 'string' && r.model.length > 0);
});

test('swapHostModel maps a codex model to the claude host', () => {
  const r = swapHostModel('codex', 'gpt-5.4');
  assert.equal(r.host, 'claude');
  assert.ok(typeof r.model === 'string' && r.model.length > 0);
});

// ── swapRoute ────────────────────────────────────────────────────────────────
test('swapRoute inverts the host and mirrors the escalation ladder', () => {
  // implementation default: codex primary, escalates to claude
  const swapped = swapRoute(DEFAULT_ROUTES.implementation);
  assert.equal(swapped.host, 'claude');
  assert.equal(swapped.escalate[0].host, 'codex');
});

// ── seedDualRouting primary bias ─────────────────────────────────────────────
test('seedDualRouting default (claude primary) keeps rUv host assignments', () => {
  const policy = seedDualRouting({ hosts: ['claude', 'codex'] });
  assert.equal(policy.architecture.host, 'claude'); // reasoning stays on claude
  assert.equal(policy.implementation.host, 'codex'); // impl stays on codex
});

test('seedDualRouting with codex primary mirrors host assignments', () => {
  const policy = seedDualRouting({ hosts: ['claude', 'codex'], primary: 'codex' });
  assert.equal(policy.architecture.host, 'codex'); // codex now leads reasoning
  assert.equal(policy.implementation.host, 'claude'); // claude becomes the alternate
});

test('seedDualRouting stamps every seeded entry with source:seeded', () => {
  const policy = seedDualRouting({ hosts: ['claude', 'codex'], primary: 'codex' });
  assert.ok(Object.values(policy).every((r) => r.source === 'seeded'));
});

// ── constants ────────────────────────────────────────────────────────────────
test('DEFAULT_PRIMARY_HOST is claude and both hosts are valid primaries', () => {
  assert.equal(DEFAULT_PRIMARY_HOST, 'claude');
  assert.deepEqual([...PRIMARY_HOSTS].sort(), ['claude', 'codex']);
});
