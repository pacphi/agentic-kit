import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODES, normalizeMode } from '../../src/lib/usage-modes.mjs';

test('MODES is the closed four-value taxonomy', () => {
  assert.deepEqual(MODES, ['guarded', 'auto-edit', 'plan', 'unrestricted']);
});

test('claude permissionMode maps per table', () => {
  assert.equal(normalizeMode({ host: 'claude', permissionMode: 'default' }).mode, 'guarded');
  assert.equal(normalizeMode({ host: 'claude', permissionMode: 'acceptEdits' }).mode, 'auto-edit');
  assert.equal(normalizeMode({ host: 'claude', permissionMode: 'auto' }).mode, 'auto-edit');
  assert.equal(normalizeMode({ host: 'claude', permissionMode: 'plan' }).mode, 'plan');
  assert.equal(normalizeMode({ host: 'claude', permissionMode: 'bypassPermissions' }).mode, 'unrestricted');
});

test('codex approval x sandbox maps per table, read-only sandbox wins as plan', () => {
  assert.equal(normalizeMode({ host: 'codex', approvalPolicy: 'never', sandboxPolicy: 'danger-full-access' }).mode, 'unrestricted');
  assert.equal(normalizeMode({ host: 'codex', approvalPolicy: 'never', sandboxPolicy: 'workspace-write' }).mode, 'auto-edit');
  assert.equal(normalizeMode({ host: 'codex', approvalPolicy: 'on-request', sandboxPolicy: 'workspace-write' }).mode, 'guarded');
  assert.equal(normalizeMode({ host: 'codex', approvalPolicy: 'never', sandboxPolicy: 'read-only' }).mode, 'plan');
});

test('opencode mode maps build/plan', () => {
  assert.equal(normalizeMode({ host: 'opencode', opencodeMode: 'build' }).mode, 'auto-edit');
  assert.equal(normalizeMode({ host: 'opencode', opencodeMode: 'plan' }).mode, 'plan');
});

test('absent or unrecognized evidence is null, raw preserved, never guessed', () => {
  assert.equal(normalizeMode({ host: 'claude' }).mode, null);
  const odd = normalizeMode({ host: 'claude', permissionMode: 'superSafe9000' });
  assert.equal(odd.mode, null);
  assert.equal(odd.raw, 'superSafe9000');
});
