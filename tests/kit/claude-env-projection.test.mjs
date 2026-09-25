import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reconcileClaudeComponentEnv, reconcileMemoryPin } from '../../src/lib/claude-env-projection.mjs';
import { renderPolicy } from '../../src/lib/ruflo-components/policy.mjs';

const cfg = (over = {}) => ({ rufloComponents: { typesafePicker: true, minilmPicker: true,
  mcpGovernance: { maxCallsPerMinute: 120 }, learningProfile: 'balanced', turnCredit: true,
  memoryFix2887: true, funnel: false, ...over } });
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-claude-rc-home-'));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ak-claude-rc-proj-')));
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(root, '.git'));
  return { root, userSettingsFile: path.join(home, 'settings.json') };
}
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('machine keys go to user settings; enforcement only to the project with a valid policy', (t) => {
  const { root, userSettingsFile } = fixture(t);
  fs.mkdirSync(path.join(root, '.harness'));
  fs.writeFileSync(path.join(root, '.harness', 'mcp-policy.json'), renderPolicy({ maxCallsPerMinute: 120 }));
  const result = reconcileClaudeComponentEnv(cfg(), { projectRoot: root, rufloVersion: '3.44.0', userSettingsFile });
  assert.equal(result.ok, true);
  assert.deepEqual(read(userSettingsFile).env, { CLAUDE_FLOW_ROUTER_TYPESAFE: '1', CLAUDE_FLOW_ROUTER_EMBEDDER: 'minilm', RUFLO_INTELLIGENCE_MODE: 'balanced' });
  assert.deepEqual(read(path.join(root, '.claude', 'settings.local.json')).env, { RUFLO_MCP_ENFORCE_POLICY: '1' });
});

test('project without a policy file never receives enforcement', (t) => {
  const { root, userSettingsFile } = fixture(t);
  reconcileClaudeComponentEnv(cfg(), { projectRoot: root, rufloVersion: '3.44.0', userSettingsFile });
  assert.equal(fs.existsSync(path.join(root, '.claude', 'settings.local.json')), false);
  assert.equal('RUFLO_MCP_ENFORCE_POLICY' in read(userSettingsFile).env, false);
});

test('deleting the policy file later removes enforcement on the next reconcile', (t) => {
  const { root, userSettingsFile } = fixture(t);
  const policy = path.join(root, '.harness', 'mcp-policy.json');
  fs.mkdirSync(path.dirname(policy)); fs.writeFileSync(policy, renderPolicy({ maxCallsPerMinute: 120 }));
  reconcileClaudeComponentEnv(cfg(), { projectRoot: root, rufloVersion: '3.44.0', userSettingsFile });
  fs.rmSync(policy);
  reconcileClaudeComponentEnv(cfg(), { projectRoot: root, rufloVersion: '3.44.0', userSettingsFile });
  const local = path.join(root, '.claude', 'settings.local.json');
  assert.equal('RUFLO_MCP_ENFORCE_POLICY' in (read(local).env ?? {}), false);
});

test('a settings.local.json that pre-exists as {} survives an add-then-retract cycle', (t) => {
  const { root, userSettingsFile } = fixture(t);
  const local = path.join(root, '.claude', 'settings.local.json');
  fs.mkdirSync(path.dirname(local), { recursive: true });
  fs.writeFileSync(local, '{}');
  const policy = path.join(root, '.harness', 'mcp-policy.json');
  fs.mkdirSync(path.dirname(policy)); fs.writeFileSync(policy, renderPolicy({ maxCallsPerMinute: 120 }));
  reconcileClaudeComponentEnv(cfg(), { projectRoot: root, rufloVersion: '3.44.0', userSettingsFile });
  assert.equal(read(local).env.RUFLO_MCP_ENFORCE_POLICY, '1');
  fs.rmSync(policy);
  reconcileClaudeComponentEnv(cfg(), { projectRoot: root, rufloVersion: '3.44.0', userSettingsFile });
  assert.equal(fs.existsSync(local), true);
  assert.equal('RUFLO_MCP_ENFORCE_POLICY' in (read(local).env ?? {}), false);
});

test('a user-set learning profile is preserved and reported', (t) => {
  const { root, userSettingsFile } = fixture(t);
  fs.writeFileSync(userSettingsFile, JSON.stringify({ env: { RUFLO_INTELLIGENCE_MODE: 'research' } }));
  const result = reconcileClaudeComponentEnv(cfg(), { projectRoot: root, rufloVersion: '3.44.0', userSettingsFile });
  // A preserved per-key conflict is reported, not a failure; the other keys still land.
  assert.equal(result.ok, true);
  const user = result.findings[0];
  assert.equal(user.keys.RUFLO_INTELLIGENCE_MODE, 'foreign');
  assert.match(user.conflicts[0].reason, /RUFLO_INTELLIGENCE_MODE/);
  assert.equal(read(userSettingsFile).env.RUFLO_INTELLIGENCE_MODE, 'research');
});

test('legacy unreceipted memory pin equal to the computed value is adopted and later removed', (t) => {
  const { root } = fixture(t);
  const local = path.join(root, '.claude', 'settings.local.json');
  const pin = path.join(root, '.swarm', 'memory.db');
  fs.mkdirSync(path.dirname(local), { recursive: true });
  fs.writeFileSync(local, JSON.stringify({ env: { CLAUDE_FLOW_DB_PATH: pin, KEEP: 'x' } }));
  assert.equal(reconcileMemoryPin(root, { enabled: true }).status, 'adopted');
  assert.equal(reconcileMemoryPin(root, { enabled: false }).changed, true);
  assert.deepEqual(read(local).env, { KEEP: 'x' });
});

test('a foreign memory pin is never adopted', (t) => {
  const { root } = fixture(t);
  const local = path.join(root, '.claude', 'settings.local.json');
  fs.mkdirSync(path.dirname(local), { recursive: true });
  fs.writeFileSync(local, JSON.stringify({ env: { CLAUDE_FLOW_DB_PATH: '/elsewhere/memory.db' } }));
  const result = reconcileMemoryPin(root, { enabled: true });
  assert.equal(result.ok, false);
  assert.equal(read(local).env.CLAUDE_FLOW_DB_PATH, '/elsewhere/memory.db');
});
