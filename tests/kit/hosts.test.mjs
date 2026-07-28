import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOST_IDS, adapterFor, statuslineSupported, drivingHost } from '../../src/lib/hosts.mjs';
import { hostAuthState } from '../../src/lib/providers.mjs';

// ── HOST_ADAPTERS descriptors ────────────────────────────────────────────────
test('HOST_ADAPTERS defines the three hosts', () => {
  assert.deepEqual(HOST_IDS, ['claude', 'codex', 'opencode']);
});

test('claude adapter targets CLAUDE.md/json and supports a statusline', () => {
  const a = adapterFor('claude');
  assert.equal(a.guidanceFile, 'claude');
  assert.equal(a.configFormat, 'json');
  assert.equal(a.statuslineSupported, true);
  assert.equal(a.aqeProvider, 'claude-code');
});

test('codex adapter targets AGENTS.md/toml and has NO command-backed statusline', () => {
  const a = adapterFor('codex');
  assert.equal(a.guidanceFile, 'agents');
  assert.equal(a.configFormat, 'toml');
  assert.equal(a.statuslineSupported, false);
  assert.deepEqual(a.statusline, { mode: 'builtin', scope: 'user', customCommand: false, multiline: false });
  assert.equal(a.aqeProvider, 'codex');
});

test('opencode adapter targets its own AGENTS.md/json, no statusline, no aqe provider, no session env markers', () => {
  const a = adapterFor('opencode');
  assert.equal(a.guidanceFile, 'agents-opencode');
  assert.equal(a.configFormat, 'json');
  assert.equal(a.statuslineSupported, false);
  assert.equal(a.aqeProvider, null);
  assert.deepEqual(a.envMarkers, []);
});

test('adapterFor returns null for an unknown host', () => {
  assert.equal(adapterFor('gemini'), null);
});

test('statuslineSupported is true for claude and false for codex', () => {
  assert.equal(statuslineSupported('claude'), true);
  assert.equal(statuslineSupported('codex'), false);
});

// ── drivingHost detection (env-only, deterministic) ──────────────────────────
test('drivingHost honors an explicit AK_DRIVING_HOST override', () => {
  assert.equal(drivingHost({ AK_DRIVING_HOST: 'codex', CLAUDECODE: '1' }), 'codex');
});

test('drivingHost ignores an invalid override and falls through', () => {
  assert.equal(drivingHost({ AK_DRIVING_HOST: 'bogus', CLAUDECODE: '1' }), 'claude');
});

test('drivingHost detects claude from CLAUDECODE marker', () => {
  assert.equal(drivingHost({ CLAUDECODE: '1' }), 'claude');
});

test('drivingHost detects codex from a CODEX_* marker', () => {
  assert.equal(drivingHost({ CODEX_SANDBOX: 'workspace-write' }), 'codex');
});

test('drivingHost falls back to the configured primary host', () => {
  assert.equal(drivingHost({}, { providers: { primaryHost: 'codex' } }), 'codex');
});

test('drivingHost defaults to claude with no signal', () => {
  assert.equal(drivingHost({}), 'claude');
});

// ── hostAuthState (billing axis) ─────────────────────────────────────────────
test('hostAuthState reports api-key/metered when the key env is set (codex)', () => {
  const a = hostAuthState('codex', { env: { OPENAI_API_KEY: 'sk-x' }, present: true });
  assert.equal(a.mode, 'api-key');
  assert.equal(a.billing, 'metered');
  assert.equal(a.source, 'OPENAI_API_KEY');
});

test('hostAuthState reports api-key/metered when the key env is set (claude)', () => {
  const a = hostAuthState('claude', { env: { ANTHROPIC_API_KEY: 'sk-x' }, present: true });
  assert.equal(a.mode, 'api-key');
  assert.equal(a.billing, 'metered');
});

test('hostAuthState infers oauth/subscription for a present claude with no key', () => {
  const a = hostAuthState('claude', { env: {}, present: true });
  assert.equal(a.mode, 'oauth');
  assert.equal(a.billing, 'subscription');
});

test('hostAuthState reports none for an absent claude with no key', () => {
  // home must point at an EMPTY dir: on a real machine with file-based claude
  // credentials (~/.claude/.credentials.json present, e.g. Linux installs), the
  // login-file probe legitimately wins and this test flaked 'oauth'.
  const a = hostAuthState('claude', { env: {}, present: false, home: fs.mkdtempSync(path.join(os.tmpdir(), 'ak-nohome-')) });
  assert.equal(a.mode, 'none');
});

test('hostAuthState returns unknown for an unrecognized host', () => {
  const a = hostAuthState('gemini', { env: {}, present: true });
  assert.equal(a.mode, 'unknown');
});
