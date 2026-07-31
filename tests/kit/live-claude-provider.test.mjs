// claude-provider.mjs — who serves a Claude Code session. Selection mirrors the
// documented env surface (CLAUDE_CODE_USE_BEDROCK/_VERTEX/_FOUNDRY,
// ANTHROPIC_BASE_URL) across settings layers; provenance is configured/inferred.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveClaudeProvider } from '../../src/lib/live/claude-provider.mjs';

const HOME = '/home/dev';
const CWD = '/repo/app';
const base = { cwd: CWD, env: {}, home: HOME, platform: 'linux', read: () => null };
const files = (map) => (file) => map[file] ?? null;
const userSettings = path.join(HOME, '.claude', 'settings.json');
const projectShared = path.join(CWD, '.claude', 'settings.json');
const projectLocal = path.join(CWD, '.claude', 'settings.local.json');
const managed = '/etc/claude-code/managed-settings.json';

test('defaults to anthropic with inferred provenance when nothing selects a provider', () => {
  assert.deepEqual(resolveClaudeProvider(base),
    { provider: 'anthropic', provenance: 'inferred' });
});

test('shell CLAUDE_CODE_USE_BEDROCK selects bedrock as configured', () => {
  assert.deepEqual(resolveClaudeProvider({ ...base, env: { CLAUDE_CODE_USE_BEDROCK: '1' } }),
    { provider: 'bedrock', provenance: 'configured' });
});

test('an explicit "0"/"false" flag is not a selection', () => {
  assert.equal(resolveClaudeProvider({
    ...base, env: { CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: 'false' },
  }).provider, 'anthropic');
});

test('user settings env selects vertex without any shell variable', () => {
  const read = files({ [userSettings]: { env: { CLAUDE_CODE_USE_VERTEX: '1' } } });
  assert.deepEqual(resolveClaudeProvider({ ...base, read }),
    { provider: 'vertex', provenance: 'configured' });
});

test('project settings outrank user settings; local outranks shared', () => {
  const read = files({
    [userSettings]: { env: { CLAUDE_CODE_USE_VERTEX: '1' } },
    [projectShared]: { env: { CLAUDE_CODE_USE_VERTEX: '', CLAUDE_CODE_USE_BEDROCK: '1' } },
    [projectLocal]: { env: { CLAUDE_CODE_USE_BEDROCK: '', CLAUDE_CODE_USE_FOUNDRY: '1' } },
  });
  assert.deepEqual(resolveClaudeProvider({ ...base, read }),
    { provider: 'foundry', provenance: 'configured' });
});

test('managed settings outrank everything', () => {
  const read = files({
    [managed]: { env: { CLAUDE_CODE_USE_BEDROCK: '' } },
    [projectLocal]: { env: { CLAUDE_CODE_USE_BEDROCK: '1' } },
  });
  assert.equal(resolveClaudeProvider({ ...base, read }).provider, 'anthropic');
});

test('an empty settings value masks a shell variable (documented unset idiom)', () => {
  const read = files({ [userSettings]: { env: { ANTHROPIC_BASE_URL: '' } } });
  assert.deepEqual(resolveClaudeProvider({
    ...base, read, env: { ANTHROPIC_BASE_URL: 'https://proxy.corp.example' },
  }), { provider: 'anthropic', provenance: 'inferred' });
});

test('ANTHROPIC_BASE_URL classifies openrouter, anthropic, and unknown gateways', () => {
  const at = (url) => resolveClaudeProvider({ ...base, env: { ANTHROPIC_BASE_URL: url } });
  assert.deepEqual(at('https://openrouter.ai/api'),
    { provider: 'openrouter', provenance: 'configured' });
  assert.deepEqual(at('https://api.anthropic.com'),
    { provider: 'anthropic', provenance: 'configured' });
  assert.deepEqual(at('https://litellm.corp.example/v1'),
    { provider: 'gateway', provenance: 'configured' });
  assert.deepEqual(at('not a url'),
    { provider: 'gateway', provenance: 'configured' });
});

test('without a cwd only user/managed layers are consulted', () => {
  const read = files({ [projectLocal]: { env: { CLAUDE_CODE_USE_BEDROCK: '1' } } });
  assert.equal(resolveClaudeProvider({ ...base, cwd: undefined, read }).provider, 'anthropic');
});

test('a malformed settings env block never breaks resolution', () => {
  assert.equal(resolveClaudeProvider({
    ...base, read: () => ({ env: ['not', 'a', 'plain', 'object'] }),
  }).provider, 'anthropic');
});
