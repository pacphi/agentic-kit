import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { run as runAuditCommand } from '../../src/commands/audit.mjs';
import { run as runHooksCommand } from '../../src/commands/hooks.mjs';
import {
  applyHookHealingPlan, previewHookHealingUndo, undoHookHealing,
} from '../../src/lib/hook-remediation/engine.mjs';
import {
  createHookTransactionDir, lastHookReceiptId, readHookReceipt, unfinishedHookReceipts,
  writeHookReceipt,
} from '../../src/lib/hook-remediation/store.mjs';
import { captureConsole, hookRemediationFixture as fixture } from './hook-remediation-fixture.mjs';

test('receipt integrity tampering is refused by undo', () => {
  const fx = fixture();
  try {
    const plan = fx.plan();
    const applied = applyHookHealingPlan({
      plan, actionIds: [plan.actions[0].id], expectedPlanDigest: plan.planDigest,
      transactionsRoot: fx.transactionsRoot, auditFn: fx.audit,
    });
    const receipt = JSON.parse(fs.readFileSync(applied.receiptFile, 'utf8'));
    receipt.status = 'prepared';
    fs.writeFileSync(applied.receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
    assert.throws(() => readHookReceipt(fx.transactionsRoot, applied.receiptId), /integrity/);
    const result = undoHookHealing({ transactionsRoot: fx.transactionsRoot, receiptId: applied.receiptId });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'receipt-refused');
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test('unfinished and last-receipt discovery ignores integrity-tampered receipts', () => {
  const fx = fixture();
  try {
    const plan = fx.plan();
    const applied = applyHookHealingPlan({
      plan, actionIds: [plan.actions[0].id], expectedPlanDigest: plan.planDigest,
      transactionsRoot: fx.transactionsRoot, auditFn: fx.audit,
    });
    assert.equal(lastHookReceiptId(fx.transactionsRoot), applied.receiptId);
    assert.deepEqual(unfinishedHookReceipts(fx.transactionsRoot), []);
    const receipt = JSON.parse(fs.readFileSync(applied.receiptFile, 'utf8'));
    receipt.status = 'applying';
    fs.writeFileSync(applied.receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
    assert.equal(lastHookReceiptId(fx.transactionsRoot), null);
    assert.deepEqual(unfinishedHookReceipts(fx.transactionsRoot), []);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test('undo previews distinguish ready, already-restored, drifted, and missing receipts', () => {
  const fx = fixture();
  try {
    assert.equal(previewHookHealingUndo({ transactionsRoot: fx.transactionsRoot, last: true }).status, 'not-found');
    const plan = fx.plan();
    const applied = applyHookHealingPlan({
      plan, actionIds: [plan.actions[0].id], expectedPlanDigest: plan.planDigest,
      transactionsRoot: fx.transactionsRoot, auditFn: fx.audit,
    });
    const ready = previewHookHealingUndo({ transactionsRoot: fx.transactionsRoot, receiptId: applied.receiptId });
    assert.equal(ready.actions[0].status, 'ready');
    fs.appendFileSync(fx.target, ' ');
    assert.equal(previewHookHealingUndo({
      transactionsRoot: fx.transactionsRoot, receiptId: applied.receiptId,
    }).status, 'drift-refused');
    fs.writeFileSync(fx.target, plan.actions[0].candidateBytes, { mode: 0o640 });
    assert.equal(undoHookHealing({
      transactionsRoot: fx.transactionsRoot, receiptId: applied.receiptId,
    }).status, 'rolled-back');
    const restored = previewHookHealingUndo({ transactionsRoot: fx.transactionsRoot, receiptId: applied.receiptId });
    assert.equal(restored.actions[0].status, 'already-restored');
    assert.equal(undoHookHealing({
      transactionsRoot: fx.transactionsRoot, receiptId: applied.receiptId,
    }).status, 'already-rolled-back');
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test('undo preview refuses a corrupted backup before confirmation', () => {
  const fx = fixture();
  try {
    const plan = fx.plan();
    const applied = applyHookHealingPlan({
      plan, actionIds: [plan.actions[0].id], expectedPlanDigest: plan.planDigest,
      transactionsRoot: fx.transactionsRoot, auditFn: fx.audit,
    });
    const receipt = JSON.parse(fs.readFileSync(applied.receiptFile, 'utf8'));
    fs.appendFileSync(path.join(path.dirname(applied.receiptFile), receipt.actions[0].backup.relative), 'corrupt');
    const preview = previewHookHealingUndo({
      transactionsRoot: fx.transactionsRoot, receiptId: applied.receiptId,
    });
    assert.equal(preview.ok, false);
    assert.match(preview.error, /backup integrity/);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test('undo reports partial when atomic restore cannot rename', () => {
  const fx = fixture();
  try {
    const plan = fx.plan();
    const applied = applyHookHealingPlan({
      plan, actionIds: [plan.actions[0].id], expectedPlanDigest: plan.planDigest,
      transactionsRoot: fx.transactionsRoot, auditFn: fx.audit,
    });
    const failingFs = Object.create(fs);
    failingFs.renameSync = () => { throw new Error('injected restore rename failure'); };
    const result = undoHookHealing({
      transactionsRoot: fx.transactionsRoot, receiptId: applied.receiptId, fsImpl: failingFs,
    });
    assert.equal(result.status, 'partial');
    assert.match(result.error, /restore rename failure/);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test('transaction store propagates non-missing directory errors and bounds id collisions', () => {
  const deniedFs = Object.create(fs);
  deniedFs.readdirSync = () => { const error = new Error('denied'); error.code = 'EACCES'; throw error; };
  assert.throws(() => lastHookReceiptId('/denied', { fsImpl: deniedFs }), /denied/);
  assert.throws(() => unfinishedHookReceipts('/denied', { fsImpl: deniedFs }), /denied/);

  const collisionFs = Object.create(fs);
  let mkdirCalls = 0;
  collisionFs.mkdirSync = () => {
    mkdirCalls += 1;
    if (mkdirCalls === 1) return undefined;
    const error = new Error('collision'); error.code = 'EEXIST'; throw error;
  };
  collisionFs.lstatSync = () => ({ isDirectory: () => true, isSymbolicLink: () => false });
  collisionFs.chmodSync = () => {};
  assert.throws(() => createHookTransactionDir('/collisions', { fsImpl: collisionFs }), /unique/);
});

test('transaction store refuses a symlinked root', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-hook-heal-store-'));
  try {
    const actual = path.join(root, 'actual');
    const linked = path.join(root, 'linked');
    fs.mkdirSync(actual);
    try { fs.symlinkSync(actual, linked, 'dir'); } catch (error) {
      if (error.code === 'EPERM') { t.skip('directory symlinks unavailable'); return; }
      throw error;
    }
    assert.throws(() => createHookTransactionDir(linked), /non-symlink directory/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('receipt durability does not require fsync on a read-only file descriptor', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-hook-heal-fsync-'));
  try {
    const transaction = createHookTransactionDir(path.join(root, 'transactions'));
    const windowsLikeFs = Object.create(fs);
    windowsLikeFs.openSync = (file, flags, ...args) => {
      if (file === transaction.receiptFile && flags === 'r') {
        const error = new Error('simulated Windows EPERM for read-only fsync');
        error.code = 'EPERM';
        throw error;
      }
      return fs.openSync(file, flags, ...args);
    };
    assert.doesNotThrow(() => writeHookReceipt(transaction.receiptFile, {
      schemaVersion: 'hook-heal-receipt/v1', id: transaction.id,
      createdAt: '2026-09-01T00:00:00.000Z', status: 'prepared', actions: [],
    }, { fsImpl: windowsLikeFs }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('hooks doctor JSON stays byte-compatible with audit hooks JSON', async () => {
  const flags = { json: true, host: ['codex'], project: [] };
  const dependencies = {
    detectVersionFn: () => 'unknown',
    loadConfigFn: () => { throw new Error('must not load unrelated config'); },
  };
  const audit = await captureConsole(() => runAuditCommand({ flags, positionals: ['hooks'], ...dependencies }));
  const doctor = await captureConsole(() => runHooksCommand({ flags, positionals: ['doctor'], ...dependencies }));
  assert.equal(doctor.status, audit.status);
  assert.equal(doctor.stdout, audit.stdout);
  assert.equal(doctor.stderr, audit.stderr);
});

test('hooks heal dry-run is write-free and non-interactive apply requires explicit approval', async () => {
  const fx = fixture();
  try {
    const before = fs.readFileSync(fx.target);
    const dryRun = await captureConsole(() => runHooksCommand({
      flags: { json: true, 'dry-run': true, host: ['codex'], project: [] },
      positionals: ['heal'], auditFn: fx.audit, transactionsRoot: fx.transactionsRoot,
    }));
    assert.equal(dryRun.status, 0);
    const publicPlan = JSON.parse(dryRun.stdout);
    assert.equal(publicPlan.summary.executable, 1);
    assert.equal(fs.existsSync(fx.transactionsRoot), false);
    assert.deepEqual(fs.readFileSync(fx.target), before);

    const refused = await captureConsole(() => runHooksCommand({
      flags: {
        json: true, action: [publicPlan.actions[0].id],
        'expect-plan': publicPlan.planDigest, host: ['codex'], project: [],
      },
      positionals: ['heal'], auditFn: fx.audit, transactionsRoot: fx.transactionsRoot,
    }));
    assert.equal(refused.status, 2);
    assert.match(JSON.parse(refused.stdout).error, /requires --yes|approval/);
    assert.equal(fs.existsSync(fx.transactionsRoot), false);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test('interactive approval binds the displayed plan before applying', async () => {
  const fx = fixture();
  try {
    const plan = fx.plan();
    let approvalMessage = '';
    const applied = await captureConsole(() => runHooksCommand({
      flags: {
        json: true, action: [plan.actions[0].id],
        'expect-plan': plan.planDigest, host: ['codex'], project: [],
      },
      positionals: ['heal'], auditFn: fx.audit, transactionsRoot: fx.transactionsRoot,
      approvalFn(message) { approvalMessage = message; return true; },
    }));
    assert.equal(applied.status, 0);
    assert.match(approvalMessage, new RegExp(plan.planDigest));
    assert.match(approvalMessage, new RegExp(plan.actions[0].id));
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test('hooks heal and --last undo require exact plan binding and preserve unrelated keys', async () => {
  const fx = fixture();
  try {
    const original = fs.readFileSync(fx.target);
    const plan = fx.plan();
    const applied = await captureConsole(() => runHooksCommand({
      flags: {
        json: true, yes: true, action: [plan.actions[0].id],
        'expect-plan': plan.planDigest, host: ['codex'], project: [],
      },
      positionals: ['heal'], auditFn: fx.audit, transactionsRoot: fx.transactionsRoot,
    }));
    assert.equal(applied.status, 0);
    assert.equal(JSON.parse(fs.readFileSync(fx.target, 'utf8')).keep.user, true);

    const preview = await captureConsole(() => runHooksCommand({
      flags: { json: true, last: true, 'dry-run': true },
      positionals: ['undo'], transactionsRoot: fx.transactionsRoot,
    }));
    assert.equal(preview.status, 0);
    assert.equal(JSON.parse(preview.stdout).actions[0].status, 'ready');

    const undone = await captureConsole(() => runHooksCommand({
      flags: { json: true, last: true, yes: true },
      positionals: ['undo'], transactionsRoot: fx.transactionsRoot,
    }));
    assert.equal(undone.status, 0);
    assert.deepEqual(fs.readFileSync(fx.target), original);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});
