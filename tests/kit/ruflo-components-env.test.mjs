import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { componentEnv, machineComponentEnv, supports } from '../../src/lib/ruflo-components/env.mjs';
import {
  readPolicy, renderPolicy, reconcilePolicy, POLICY_RELATIVE, AK_POLICY_MARKER,
} from '../../src/lib/ruflo-components/policy.mjs';

const cfg = (over = {}) => ({ rufloComponents: { typesafePicker: true, minilmPicker: true,
  mcpGovernance: { maxCallsPerMinute: 120 }, learningProfile: 'balanced', turnCredit: true,
  memoryFix2887: true, funnel: false, ...over } });
const project = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-rc-env-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('machine env on 3.44.0 carries pickers and profile, never enforcement', () => {
  assert.deepEqual(machineComponentEnv(cfg(), '3.44.0'), {
    CLAUDE_FLOW_ROUTER_TYPESAFE: '1', CLAUDE_FLOW_ROUTER_EMBEDDER: 'minilm', RUFLO_INTELLIGENCE_MODE: 'balanced',
  });
});

test('too-old ruflo drops only the components it cannot run', () => {
  assert.deepEqual(machineComponentEnv(cfg(), '3.43.0'), {
    CLAUDE_FLOW_ROUTER_TYPESAFE: '1', RUFLO_INTELLIGENCE_MODE: 'balanced' });
  assert.deepEqual(machineComponentEnv(cfg(), '3.42.0'), {});
  assert.deepEqual(machineComponentEnv(cfg(), null), {});
});

test('opted-out components produce no variables', () => {
  assert.deepEqual(machineComponentEnv(cfg({ typesafePicker: false, learningProfile: false }), '3.44.0'),
    { CLAUDE_FLOW_ROUTER_EMBEDDER: 'minilm' });
});

test('no policy file means no enforcement variable', (t) => {
  const dir = project(t);
  assert.equal('RUFLO_MCP_ENFORCE_POLICY' in componentEnv(dir, cfg(), '3.44.0'), false);
});

test('invalid policy file means no enforcement variable', (t) => {
  const dir = project(t);
  fs.mkdirSync(path.join(dir, '.harness'));
  fs.writeFileSync(path.join(dir, POLICY_RELATIVE), '{ not json');
  assert.equal(readPolicy(dir).state, 'invalid');
  assert.equal('RUFLO_MCP_ENFORCE_POLICY' in componentEnv(dir, cfg(), '3.44.0'), false);
});

test('valid policy file plus managed governance adds enforcement', (t) => {
  const dir = project(t);
  fs.mkdirSync(path.join(dir, '.harness'));
  fs.writeFileSync(path.join(dir, POLICY_RELATIVE), renderPolicy({ maxCallsPerMinute: 120 }));
  assert.equal(componentEnv(dir, cfg(), '3.44.0').RUFLO_MCP_ENFORCE_POLICY, '1');
  assert.equal('RUFLO_MCP_ENFORCE_POLICY' in componentEnv(dir, cfg({ mcpGovernance: false }), '3.44.0'), false);
});

test('rendered policy is exactly what ruflo enforces', () => {
  const policy = JSON.parse(renderPolicy({ maxCallsPerMinute: 120 }));
  assert.deepEqual({ auditLog: policy.auditLog, maxToolCallsPerTurn: policy.maxToolCallsPerTurn, turnWindowMs: policy.turnWindowMs },
    { auditLog: true, maxToolCallsPerTurn: 120, turnWindowMs: 60000 });
});

test('policy reconcile writes, converges, preserves user edits, and removes only its own file', (t) => {
  const dir = project(t);
  const receipts = {};
  const first = reconcilePolicy(dir, { maxCallsPerMinute: 120 }, receipts);
  assert.equal(first.status, 'written');
  assert.equal(reconcilePolicy(dir, { maxCallsPerMinute: 120 }, receipts).changed, false);
  fs.writeFileSync(path.join(dir, POLICY_RELATIVE), JSON.stringify({ auditLog: true, maxToolCallsPerTurn: 5 }));
  const edited = reconcilePolicy(dir, { maxCallsPerMinute: 120 }, receipts);
  assert.equal(edited.status, 'user-managed');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, POLICY_RELATIVE))).maxToolCallsPerTurn, 5);
  assert.equal(reconcilePolicy(dir, false, receipts).status, 'user-managed');
  assert.ok(fs.existsSync(path.join(dir, POLICY_RELATIVE)));
});

test('policy removal deletes an unchanged ak-written file', (t) => {
  const dir = project(t);
  const receipts = {};
  reconcilePolicy(dir, { maxCallsPerMinute: 120 }, receipts);
  assert.equal(reconcilePolicy(dir, false, receipts).status, 'removed');
  assert.equal(fs.existsSync(path.join(dir, POLICY_RELATIVE)), false);
});

test('a pre-existing foreign policy file is never overwritten', (t) => {
  const dir = project(t);
  fs.mkdirSync(path.join(dir, '.harness'));
  fs.writeFileSync(path.join(dir, POLICY_RELATIVE), JSON.stringify({ auditLog: true, maxToolCallsPerTurn: 50, defaultDeny: true }));
  const result = reconcilePolicy(dir, { maxCallsPerMinute: 120 }, {});
  assert.equal(result.status, 'user-managed');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, POLICY_RELATIVE))).defaultDeny, true);
});

test('AK_POLICY_MARKER matches the _about prefix renderPolicy writes', () => {
  assert.equal(AK_POLICY_MARKER, 'Managed by agentic-kit');
  const policy = JSON.parse(renderPolicy({ maxCallsPerMinute: 120 }));
  assert.ok(policy._about.startsWith(AK_POLICY_MARKER));
});

test('readPolicy: a valid-JSON policy file without the ak marker is "foreign", not "valid"', (t) => {
  const dir = project(t);
  fs.mkdirSync(path.join(dir, '.harness'));
  fs.writeFileSync(path.join(dir, POLICY_RELATIVE), JSON.stringify({ auditLog: true, maxToolCallsPerTurn: 8 }));
  assert.equal(readPolicy(dir).state, 'foreign');
});

test('readPolicy: an ak-written policy file is "valid"', (t) => {
  const dir = project(t);
  fs.mkdirSync(path.join(dir, '.harness'));
  fs.writeFileSync(path.join(dir, POLICY_RELATIVE), renderPolicy({ maxCallsPerMinute: 120 }));
  assert.equal(readPolicy(dir).state, 'valid');
});

test('a foreign policy file (e.g. from MetaHarness or Agentic-QE) is left untouched and never enforced', (t) => {
  const dir = project(t);
  fs.mkdirSync(path.join(dir, '.harness'));
  const foreign = JSON.stringify({ auditLog: true, maxToolCallsPerTurn: 8 });
  fs.writeFileSync(path.join(dir, POLICY_RELATIVE), foreign);
  const receipts = {};
  const result = reconcilePolicy(dir, { maxCallsPerMinute: 120 }, receipts);
  assert.equal(result.status, 'user-managed');
  assert.equal(result.changed, false);
  assert.equal(fs.readFileSync(path.join(dir, POLICY_RELATIVE), 'utf8'), foreign);
  assert.equal('RUFLO_MCP_ENFORCE_POLICY' in componentEnv(dir, cfg(), '3.44.0'), false);
});

test('supports compares prerelease-aware versions', () => {
  assert.equal(supports('3.44.0', '3.44.0'), true);
  assert.equal(supports('3.43.9', '3.44.0'), false);
  assert.equal(supports(null, '3.36.0'), false);
  assert.equal(supports('3.1.0', null), true);
});
