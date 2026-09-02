import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  buildHookHealingPlan, hookHealingPlanDigest, publicHookHealingPlan,
} from '../../src/lib/hook-remediation/planner.mjs';
import {
  applyHookHealingPlan, undoHookHealing,
} from '../../src/lib/hook-remediation/engine.mjs';
import { inspectHookTarget } from '../../src/lib/hook-remediation/fs-port.mjs';
import { replaceJsonNumbers } from '../../src/lib/hook-remediation/json-scalar-edit.mjs';
import { hookRemediationFixture as fixture } from './hook-remediation-fixture.mjs';

test('dry-run plan is deterministic, content-bound, redacted, and leaves no transaction state', () => {
  const fx = fixture();
  try {
    const before = fs.statSync(fx.target);
    const first = fx.plan();
    const second = fx.plan();
    assert.deepEqual(publicHookHealingPlan(second), publicHookHealingPlan(first));
    assert.match(first.planDigest, /^[a-f0-9]{64}$/);
    assert.equal(first.actions.length, 1);
    assert.equal(first.actions[0].classification, 'approval-required');
    assert.equal(first.actions[0].executable, true);
    assert.match(first.actions[0].observedProjection.occurrenceIds[0], /^[a-f0-9]{64}$/);
    assert.match(first.actions[0].diff, /^--- /m);
    assert.doesNotMatch(JSON.stringify(publicHookHealingPlan(first)), /candidateBytes|node end\.cjs/);
    assert.equal(fs.existsSync(fx.transactionsRoot), false);
    const after = fs.statSync(fx.target);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(after.size, before.size);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test('candidate bytes change only approved timeout tokens and preserve all unrelated bytes', () => {
  const fx = fixture();
  try {
    const custom = Buffer.from('{\n  "keep" : { "user":true },\n  "hooks": {"SessionEnd":[{"hooks":[{"type":"command","command":"node end.cjs","timeout" : 5,"label":"é\\u0061"}]}]}\n}\n');
    fs.writeFileSync(fx.target, custom, { mode: 0o640 });
    const plan = fx.plan();
    assert.equal(plan.actions.length, 1);
    assert.deepEqual(plan.actions[0].candidateBytes, Buffer.from(custom.toString('utf8').replace('"timeout" : 5', '"timeout" : 3')));
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test('byte-preserving scalar edits cover JSON nesting, pointer escaping, and fail-closed errors', () => {
  const source = Buffer.from('{"empty":{},"items":[],"a/b":{"~key":[true,false,null,"x\\"y",-2.5e+2]}}');
  assert.deepEqual(
    replaceJsonNumbers(source, [{ pointer: '/a~1b/~0key/4', before: -250, after: 3 }]),
    Buffer.from('{"empty":{},"items":[],"a/b":{"~key":[true,false,null,"x\\"y",3]}}'),
  );
  assert.throws(() => replaceJsonNumbers(Buffer.from('{"a":1}'), [
    { pointer: '/a', before: 1, after: 2 },
    { pointer: '/a', before: 1, after: 3 },
  ]), /overlapping/);
  assert.throws(() => replaceJsonNumbers(Buffer.from('{"a":1}'), [
    { pointer: '/missing', before: 1, after: 2 },
  ]), /preimage changed/);
  assert.throws(() => replaceJsonNumbers(Buffer.from('{"a":1}'), [
    { pointer: '/a', before: 1, after: Number.POSITIVE_INFINITY },
  ]), /must be finite/);

  for (const malformed of [
    '{', '[', '"unterminated', '{"a" 1}', '{"a":1 "b":2}', '[1 2]', '?', '1 x',
    '"raw\u0001control"',
  ]) {
    assert.throws(() => replaceJsonNumbers(Buffer.from(malformed), []), SyntaxError);
  }
});

test('authorized heal changes only the selected target and commits one verified receipt', () => {
  const fx = fixture();
  try {
    const plan = fx.plan();
    const action = plan.actions[0];
    const result = applyHookHealingPlan({
      plan, actionIds: [action.id], expectedPlanDigest: plan.planDigest,
      transactionsRoot: fx.transactionsRoot, auditFn: fx.audit,
      replanFn: (report) => buildHookHealingPlan({ report }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'committed');
    assert.equal(JSON.parse(fs.readFileSync(fx.target, 'utf8')).hooks.SessionEnd[0].hooks[0].timeout, 3);
    assert.equal(fs.statSync(fx.target).mode & 0o777, 0o640);
    const receipt = JSON.parse(fs.readFileSync(result.receiptFile, 'utf8'));
    assert.equal(receipt.status, 'committed');
    assert.equal(receipt.actions.length, 1);
    assert.equal(receipt.actions[0].preimage.sha256, action.expectedPreimage.sha256);
    assert.equal(receipt.actions[0].postimage.sha256, action.desiredPostimage.sha256);
    assert.equal(receipt.verification.targetedFindingsCleared, true);
    assert.equal(receipt.verification.idempotentNoop, true);
    assert.match(receipt.receiptDigest, /^[a-f0-9]{64}$/);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test('receipt undo restores exact bytes and mode while refusing later user drift', () => {
  const fx = fixture();
  try {
    const original = fs.readFileSync(fx.target);
    const plan = fx.plan();
    const applied = applyHookHealingPlan({
      plan, actionIds: [plan.actions[0].id], expectedPlanDigest: plan.planDigest,
      transactionsRoot: fx.transactionsRoot, auditFn: fx.audit,
      replanFn: (report) => buildHookHealingPlan({ report }),
    });
    fs.appendFileSync(fx.target, '\n');
    const drifted = fs.readFileSync(fx.target);
    const refused = undoHookHealing({ transactionsRoot: fx.transactionsRoot, receiptId: applied.receiptId });
    assert.equal(refused.ok, false);
    assert.equal(refused.status, 'drift-refused');
    assert.deepEqual(fs.readFileSync(fx.target), drifted);

    fs.writeFileSync(fx.target, plan.actions[0].candidateBytes, { mode: 0o640 });
    const undone = undoHookHealing({ transactionsRoot: fx.transactionsRoot, receiptId: applied.receiptId });
    assert.equal(undone.ok, true);
    assert.equal(undone.status, 'rolled-back');
    assert.deepEqual(fs.readFileSync(fx.target), original);
    assert.equal(fs.statSync(fx.target).mode & 0o777, 0o640);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test('stale plan preimage is refused before the transaction directory or any target write', () => {
  const fx = fixture();
  try {
    const plan = fx.plan();
    fs.appendFileSync(fx.target, ' ');
    const drifted = fs.readFileSync(fx.target);
    const result = applyHookHealingPlan({
      plan, actionIds: [plan.actions[0].id], expectedPlanDigest: plan.planDigest,
      transactionsRoot: fx.transactionsRoot, auditFn: fx.audit,
      replanFn: (report) => buildHookHealingPlan({ report }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'preflight-refused');
    assert.deepEqual(fs.readFileSync(fx.target), drifted);
    assert.equal(fs.existsSync(fx.transactionsRoot), false);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test('tampered plan identity is refused before transaction state exists', () => {
  const fx = fixture();
  try {
    const plan = fx.plan();
    plan.actions[0].classification = 'automatic-eligible';
    const result = applyHookHealingPlan({
      plan, actionIds: [plan.actions[0].id], expectedPlanDigest: plan.planDigest,
      transactionsRoot: fx.transactionsRoot, auditFn: fx.audit,
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'preflight-refused');
    assert.match(result.error, /integrity/);
    assert.equal(fs.existsSync(fx.transactionsRoot), false);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test('tampered candidate bytes are refused before transaction state exists', () => {
  const fx = fixture();
  try {
    const plan = fx.plan();
    plan.actions[0].candidateBytes = Buffer.from('{}\n');
    const result = applyHookHealingPlan({
      plan, actionIds: [plan.actions[0].id], expectedPlanDigest: plan.planDigest,
      transactionsRoot: fx.transactionsRoot, auditFn: fx.audit,
    });
    assert.equal(result.status, 'preflight-refused');
    assert.match(result.error, /postimage integrity/);
    assert.equal(fs.existsSync(fx.transactionsRoot), false);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test('non-executable actions and changed modes fail before transaction creation', () => {
  const fx = fixture();
  try {
    let plan = fx.plan();
    plan.actions[0].executable = false;
    plan.planDigest = hookHealingPlanDigest(plan);
    let result = applyHookHealingPlan({
      plan, actionIds: [plan.actions[0].id], expectedPlanDigest: plan.planDigest,
      transactionsRoot: fx.transactionsRoot, auditFn: fx.audit,
    });
    assert.equal(result.status, 'preflight-refused');
    assert.match(result.error, /not executable/);

    plan = fx.plan();
    fs.chmodSync(fx.target, 0o600);
    result = applyHookHealingPlan({
      plan, actionIds: [plan.actions[0].id], expectedPlanDigest: plan.planDigest,
      transactionsRoot: fx.transactionsRoot, auditFn: fx.audit,
    });
    assert.equal(result.status, 'preflight-refused');
    assert.match(result.error, /mode changed/);
    assert.equal(fs.existsSync(fx.transactionsRoot), false);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test('backup failure leaves the target byte-identical and records no successful mutation', () => {
  const fx = fixture();
  try {
    const before = fs.readFileSync(fx.target);
    const plan = fx.plan();
    const result = applyHookHealingPlan({
      plan, actionIds: [plan.actions[0].id], expectedPlanDigest: plan.planDigest,
      transactionsRoot: fx.transactionsRoot, auditFn: fx.audit,
      faults: { beforeBackup() { throw new Error('injected backup failure'); } },
    });
    assert.equal(result.ok, false);
    assert.deepEqual(fs.readFileSync(fx.target), before);
    assert.match(result.error, /backup failure/);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test('receipt persistence failure before the first write leaves the target unchanged', () => {
  const fx = fixture();
  try {
    const before = fs.readFileSync(fx.target);
    const plan = fx.plan();
    const result = applyHookHealingPlan({
      plan, actionIds: [plan.actions[0].id], expectedPlanDigest: plan.planDigest,
      transactionsRoot: fx.transactionsRoot, auditFn: fx.audit,
      faults: { beforeReceipt(stage) { if (stage === 'prepared') throw new Error('injected receipt failure'); } },
    });
    assert.equal(result.ok, false);
    assert.deepEqual(fs.readFileSync(fx.target), before);
    assert.match(result.error, /receipt failure/);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test('failure before transaction allocation is reported without filesystem state', () => {
  const fx = fixture();
  try {
    const plan = fx.plan();
    const result = applyHookHealingPlan({
      plan, actionIds: [plan.actions[0].id], expectedPlanDigest: plan.planDigest,
      transactionsRoot: fx.transactionsRoot, auditFn: fx.audit,
      faults: { beforeTransaction() { throw new Error('injected allocation failure'); } },
    });
    assert.equal(result.status, 'backup-refused');
    assert.match(result.error, /allocation failure/);
    assert.equal(fs.existsSync(fx.transactionsRoot), false);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test('a later target failure rolls back every earlier selected target exactly', () => {
  const fx = fixture();
  try {
    const secondTarget = path.join(fx.codexHome, 'second-hooks.json');
    fs.copyFileSync(fx.target, secondTarget);
    fs.chmodSync(secondTarget, 0o640);
    const firstBytes = fs.readFileSync(fx.target);
    const secondBytes = fs.readFileSync(secondTarget);
    const plan = fx.plan();
    const first = plan.actions[0];
    const second = {
      ...first,
      id: `${first.id}-second`,
      observedProjection: { ...first.observedProjection, file: secondTarget },
      canonicalTarget: { file: secondTarget, containmentRoot: fx.codexHome },
      verification: { ...first.verification, sourceFile: secondTarget },
    };
    plan.actions = [first, second];
    plan.summary = { ...plan.summary, total: 2, executable: 2, approvalRequired: 2 };
    plan.planDigest = hookHealingPlanDigest(plan);
    const result = applyHookHealingPlan({
      plan, actionIds: plan.actions.map((action) => action.id),
      expectedPlanDigest: plan.planDigest, transactionsRoot: fx.transactionsRoot,
      auditFn: fx.audit,
      faults: { beforeReplace(_action, index) { if (index === 1) throw new Error('injected second-target failure'); } },
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'rolled-back');
    assert.deepEqual(fs.readFileSync(fx.target), firstBytes);
    assert.deepEqual(fs.readFileSync(secondTarget), secondBytes);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test('concurrent drift after backup is preserved and never overwritten', () => {
  const fx = fixture();
  try {
    const before = fs.readFileSync(fx.target);
    const plan = fx.plan();
    const drift = Buffer.concat([before, Buffer.from(' ')]);
    const result = applyHookHealingPlan({
      plan, actionIds: [plan.actions[0].id], expectedPlanDigest: plan.planDigest,
      transactionsRoot: fx.transactionsRoot, auditFn: fx.audit,
      faults: { beforeReplace() { fs.writeFileSync(fx.target, drift, { mode: 0o640 }); } },
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'rolled-back');
    assert.match(result.error, /changed after preflight/);
    assert.deepEqual(fs.readFileSync(fx.target), drift);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test('verification failure automatically restores exact preimage bytes and mode', () => {
  const fx = fixture();
  try {
    const before = fs.readFileSync(fx.target);
    const plan = fx.plan();
    const result = applyHookHealingPlan({
      plan, actionIds: [plan.actions[0].id], expectedPlanDigest: plan.planDigest,
      transactionsRoot: fx.transactionsRoot,
      auditFn: () => ({ reports: { codex: { records: [{
        source: { file: fx.target }, diagnostics: [{ code: 'session-end-timeout-clamped' }],
      }] } } }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'rolled-back');
    assert.deepEqual(fs.readFileSync(fx.target), before);
    assert.equal(fs.statSync(fx.target).mode & 0o777, 0o640);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test('rollback preserves drift created after replacement and reports a partial transaction', () => {
  const fx = fixture();
  try {
    const plan = fx.plan();
    const result = applyHookHealingPlan({
      plan, actionIds: [plan.actions[0].id], expectedPlanDigest: plan.planDigest,
      transactionsRoot: fx.transactionsRoot, auditFn: fx.audit,
      faults: { afterReplace() { fs.appendFileSync(fx.target, 'later drift'); throw new Error('interrupt'); } },
    });
    assert.equal(result.status, 'partial');
    assert.match(fs.readFileSync(fx.target, 'utf8'), /later drift/);
    assert.equal(JSON.parse(fs.readFileSync(result.receiptFile, 'utf8')).actions[0].state, 'rollback-drift-refused');
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test('rollback refuses a corrupted backup and records the exact failure', () => {
  const fx = fixture();
  try {
    const plan = fx.plan();
    const result = applyHookHealingPlan({
      plan, actionIds: [plan.actions[0].id], expectedPlanDigest: plan.planDigest,
      transactionsRoot: fx.transactionsRoot, auditFn: fx.audit,
      faults: {
        afterReplace() {
          const [transaction] = fs.readdirSync(fx.transactionsRoot);
          fs.appendFileSync(path.join(fx.transactionsRoot, transaction, 'backups', '0000.bin'), 'corrupt');
          throw new Error('interrupt after corrupt backup');
        },
      },
    });
    assert.equal(result.status, 'partial');
    const receipt = JSON.parse(fs.readFileSync(result.receiptFile, 'utf8'));
    assert.equal(receipt.actions[0].state, 'rollback-failed');
    assert.match(receipt.actions[0].error, /backup digest mismatch/);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test('verification refuses a second plan that still targets the written file', () => {
  const fx = fixture();
  try {
    const before = fs.readFileSync(fx.target);
    const plan = fx.plan();
    const result = applyHookHealingPlan({
      plan, actionIds: [plan.actions[0].id], expectedPlanDigest: plan.planDigest,
      transactionsRoot: fx.transactionsRoot,
      auditFn: () => ({ reports: { codex: { records: [] } } }),
      replanFn: () => plan,
    });
    assert.equal(result.status, 'rolled-back');
    assert.match(result.error, /second plan still contains/);
    assert.deepEqual(fs.readFileSync(fx.target), before);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test('planner refuses a symlinked hook target instead of compiling an executable action', (t) => {
  const fx = fixture();
  try {
    const actual = path.join(fx.root, 'actual.json');
    fs.renameSync(fx.target, actual);
    try { fs.symlinkSync(actual, fx.target); } catch (error) {
      if (error.code === 'EPERM') { t.skip('file symlinks unavailable'); return; }
      throw error;
    }
    assert.equal(fx.plan().actions.filter((action) => action.executable).length, 0);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test('planner drops an action when its audited source disappears before planning', () => {
  const fx = fixture();
  try {
    const report = fx.audit();
    fs.renameSync(fx.target, `${fx.target}.moved`);
    assert.equal(buildHookHealingPlan({ report }).summary.executable, 0);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test('target inspection detects inode replacement and post-open path changes', () => {
  const fx = fixture();
  try {
    const inodeFs = Object.create(fs);
    inodeFs.fstatSync = (descriptor) => {
      const stat = fs.fstatSync(descriptor);
      return new Proxy(stat, { get(target, key) { return key === 'ino' ? Number(target.ino) + 1 : target[key]; } });
    };
    assert.throws(() => inspectHookTarget(fx.target, fx.codexHome, { fsImpl: inodeFs }), /identity changed/);

    const pathFs = Object.create(fs);
    let realpaths = 0;
    pathFs.realpathSync = (value) => {
      realpaths += 1;
      const actual = fs.realpathSync(value);
      return realpaths === 3 ? `${actual}.changed` : actual;
    };
    assert.throws(() => inspectHookTarget(fx.target, fx.codexHome, { fsImpl: pathFs }), /path changed/);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});
