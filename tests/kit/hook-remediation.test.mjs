import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { auditHooks } from '../../src/lib/hook-audit/orchestrator.mjs';
import {
  buildHookHealingPlan, publicHookHealingPlan,
} from '../../src/lib/hook-remediation/planner.mjs';
import {
  applyHookHealingPlan, previewHookHealingRecovery, previewHookHealingUndo,
  recoverHookHealing, undoHookHealing,
} from '../../src/lib/hook-remediation/engine.mjs';
import {
  createHookTransactionDir, unfinishedHookReceipts, writeHookReceipt,
} from '../../src/lib/hook-remediation/store.mjs';

function writeJson(file, value, mode = 0o640) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode });
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-hook-heal-'));
  const codexHome = path.join(root, 'codex');
  const transactionsRoot = path.join(root, 'transactions');
  const target = path.join(codexHome, 'hooks.json');
  writeJson(target, {
    keep: { user: true },
    hooks: {
      SessionEnd: [{ hooks: [{ type: 'command', command: 'node end.cjs', timeout: 5 }] }],
    },
  });
  const audit = () => auditHooks({
    hosts: ['codex'],
    versions: { codex: '0.151.0' },
    projectRoots: [],
    codex: { codexHome, pluginCacheDir: path.join(codexHome, 'plugins', 'cache') },
    upstream: { file: path.join(root, 'missing-constraints.json') },
  });
  const plan = () => buildHookHealingPlan({ report: audit() });
  return { root, codexHome, transactionsRoot, target, audit, plan };
}

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
    assert.match(first.actions[0].diff, /^--- /m);
    assert.doesNotMatch(JSON.stringify(publicHookHealingPlan(first)), /candidateBytes|node end\.cjs/);
    assert.equal(fs.existsSync(fx.transactionsRoot), false);
    const after = fs.statSync(fx.target);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(after.size, before.size);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('authorized heal changes only the selected target and commits one verified receipt', () => {
  const fx = fixture();
  try {
    const plan = fx.plan();
    const action = plan.actions[0];
    const result = applyHookHealingPlan({
      plan,
      actionIds: [action.id],
      expectedPlanDigest: plan.planDigest,
      transactionsRoot: fx.transactionsRoot,
      auditFn: fx.audit,
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
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('receipt undo restores exact bytes and mode while refusing later user drift', () => {
  const fx = fixture();
  try {
    const original = fs.readFileSync(fx.target);
    const plan = fx.plan();
    const applied = applyHookHealingPlan({
      plan,
      actionIds: [plan.actions[0].id],
      expectedPlanDigest: plan.planDigest,
      transactionsRoot: fx.transactionsRoot,
      auditFn: fx.audit,
      replanFn: (report) => buildHookHealingPlan({ report }),
    });
    fs.appendFileSync(fx.target, '\n');
    const drifted = fs.readFileSync(fx.target);
    const refused = undoHookHealing({
      transactionsRoot: fx.transactionsRoot,
      receiptId: applied.receiptId,
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.status, 'drift-refused');
    assert.deepEqual(fs.readFileSync(fx.target), drifted);

    fs.writeFileSync(fx.target, plan.actions[0].candidateBytes, { mode: 0o640 });
    const undone = undoHookHealing({
      transactionsRoot: fx.transactionsRoot,
      receiptId: applied.receiptId,
    });
    assert.equal(undone.ok, true);
    assert.equal(undone.status, 'rolled-back');
    assert.deepEqual(fs.readFileSync(fx.target), original);
    assert.equal(fs.statSync(fx.target).mode & 0o777, 0o640);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('stale plan preimage is refused before the transaction directory or any target write', () => {
  const fx = fixture();
  try {
    const plan = fx.plan();
    fs.appendFileSync(fx.target, ' ');
    const drifted = fs.readFileSync(fx.target);
    const result = applyHookHealingPlan({
      plan,
      actionIds: [plan.actions[0].id],
      expectedPlanDigest: plan.planDigest,
      transactionsRoot: fx.transactionsRoot,
      auditFn: fx.audit,
      replanFn: (report) => buildHookHealingPlan({ report }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'preflight-refused');
    assert.deepEqual(fs.readFileSync(fx.target), drifted);
    assert.equal(fs.existsSync(fx.transactionsRoot), false);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('plan and private candidate tampering are refused before transaction state', () => {
  const fx = fixture();
  try {
    const plan = fx.plan();
    plan.actions[0].trustImpact = 'mutated after preview';
    let result = applyHookHealingPlan({
      plan, actionIds: [plan.actions[0].id], expectedPlanDigest: plan.planDigest,
      transactionsRoot: fx.transactionsRoot, auditFn: fx.audit,
    });
    assert.equal(result.status, 'preflight-refused');
    assert.equal(fs.existsSync(fx.transactionsRoot), false);

    const fresh = fx.plan();
    fresh.actions[0].candidateBytes[0] ^= 1;
    result = applyHookHealingPlan({
      plan: fresh, actionIds: [fresh.actions[0].id], expectedPlanDigest: fresh.planDigest,
      transactionsRoot: fx.transactionsRoot, auditFn: fx.audit,
    });
    assert.equal(result.status, 'preflight-refused');
    assert.equal(fs.existsSync(fx.transactionsRoot), false);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('duplicate, unknown, and non-executable action selections fail closed', () => {
  const fx = fixture();
  try {
    const plan = fx.plan();
    for (const actionIds of [[plan.actions[0].id, plan.actions[0].id], ['missing-action']]) {
      const result = applyHookHealingPlan({
        plan, actionIds, expectedPlanDigest: plan.planDigest,
        transactionsRoot: fx.transactionsRoot, auditFn: fx.audit,
      });
      assert.equal(result.status, 'preflight-refused');
      assert.equal(fs.existsSync(fx.transactionsRoot), false);
    }
    const report = auditHooks({
      hosts: ['codex'], versions: { codex: 'future' }, projectRoots: [],
      codex: { codexHome: fx.codexHome, pluginCacheDir: path.join(fx.codexHome, 'plugins', 'cache') },
      upstream: { file: path.join(fx.root, 'missing.json') },
    });
    const closed = buildHookHealingPlan({ report });
    assert.equal(closed.summary.executable, 0);
    assert.ok(closed.actions.every((action) => !action.executable));
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('noncanonical JSON is observed but not rewritten behind a scalar-only diff', () => {
  const fx = fixture();
  try {
    fs.writeFileSync(fx.target, '{"hooks":{"SessionEnd":[{"hooks":[{"type":"command","command":"node end.cjs","timeout":5}]}]},"keep":true}\n');
    const plan = fx.plan();
    assert.equal(plan.summary.executable, 0);
    assert.ok(plan.actions.some((action) => action.classification === 'approval-required' && !action.executable));
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('exact Claude settings repair stays distinct from plugin upstream work', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-hook-claude-heal-'));
  try {
    const claudeRoot = path.join(root, 'claude');
    const plugin = path.join(root, 'plugin');
    writeJson(path.join(claudeRoot, 'settings.json'), {
      hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'node user.cjs', timeout: 120 }] }] },
    });
    writeJson(path.join(claudeRoot, 'plugins', 'installed_plugins.json'), {
      plugins: { 'fixture@test': [{ installPath: plugin, version: '1.0.0' }] },
    });
    writeJson(path.join(plugin, 'hooks', 'hooks.json'), {
      hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'node plugin.cjs', timeout: 10 }] }] },
    });
    const report = auditHooks({
      hosts: ['claude'], versions: { claude: '2.1.258' }, projectRoots: [],
      claude: { claudeRoot, managedSettingsFile: null },
      upstream: { file: path.join(root, 'missing.json') },
    });
    const plan = buildHookHealingPlan({ report });
    assert.equal(plan.actions.filter((action) => action.executable).length, 1);
    assert.equal(plan.actions.filter((action) => action.classification === 'upstream-required').length, 1);
    assert.equal(plan.actions.filter((action) => action.providerActionId
      && action.target === path.join(claudeRoot, 'settings.json')).length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('host profile drift between preview and apply refuses before backups', () => {
  const fx = fixture();
  try {
    const plan = fx.plan();
    const driftAudit = () => auditHooks({
      hosts: ['codex'], versions: { codex: '0.152.0' }, projectRoots: [],
      codex: { codexHome: fx.codexHome, pluginCacheDir: path.join(fx.codexHome, 'plugins', 'cache') },
      upstream: { file: path.join(fx.root, 'missing.json') },
    });
    const result = applyHookHealingPlan({
      plan, actionIds: [plan.actions[0].id], expectedPlanDigest: plan.planDigest,
      transactionsRoot: fx.transactionsRoot, auditFn: driftAudit,
    });
    assert.equal(result.status, 'preflight-refused');
    assert.equal(fs.existsSync(fx.transactionsRoot), false);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('second-target failure conditionally restores the first target', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-hook-multi-heal-'));
  try {
    const codexHome = path.join(root, 'codex');
    const claudeRoot = path.join(root, 'claude');
    const codexTarget = path.join(codexHome, 'hooks.json');
    const claudeTarget = path.join(claudeRoot, 'settings.json');
    writeJson(codexTarget, { hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'node c.cjs', timeout: 5 }] }] } });
    writeJson(claudeTarget, { hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'node d.cjs', timeout: 120 }] }] } });
    const audit = () => auditHooks({
      hosts: ['codex', 'claude'], versions: { codex: '0.151.0', claude: '2.1.258' }, projectRoots: [],
      codex: { codexHome, pluginCacheDir: path.join(codexHome, 'plugins', 'cache') },
      claude: { claudeRoot, managedSettingsFile: null }, upstream: { file: path.join(root, 'missing.json') },
    });
    const plan = buildHookHealingPlan({ report: audit() });
    const originals = [fs.readFileSync(codexTarget), fs.readFileSync(claudeTarget)];
    const result = applyHookHealingPlan({
      plan, actionIds: plan.actions.filter((action) => action.executable).map((action) => action.id),
      expectedPlanDigest: plan.planDigest, transactionsRoot: path.join(root, 'transactions'), auditFn: audit,
      faults: { beforeReplace: (_action, index) => { if (index === 1) throw new Error('injected second write failure'); } },
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'rolled-back');
    assert.deepEqual(fs.readFileSync(codexTarget), originals[0]);
    assert.deepEqual(fs.readFileSync(claudeTarget), originals[1]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('receipt tampering is detected before rollback touches the target', () => {
  const fx = fixture();
  try {
    const plan = fx.plan();
    const applied = applyHookHealingPlan({
      plan, actionIds: [plan.actions[0].id], expectedPlanDigest: plan.planDigest,
      transactionsRoot: fx.transactionsRoot, auditFn: fx.audit,
    });
    const changed = fs.readFileSync(fx.target);
    const receipt = JSON.parse(fs.readFileSync(applied.receiptFile, 'utf8'));
    receipt.actions[0].target = path.join(fx.root, 'other.json');
    fs.writeFileSync(applied.receiptFile, `${JSON.stringify(receipt)}\n`);
    const result = undoHookHealing({ transactionsRoot: fx.transactionsRoot, receiptId: applied.receiptId });
    assert.equal(result.status, 'receipt-refused');
    assert.deepEqual(fs.readFileSync(fx.target), changed);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('caller-supplied transaction roots are never silently re-permissioned', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-hook-root-'));
  try {
    fs.chmodSync(root, 0o755);
    assert.throws(() => createHookTransactionDir(root), /must already be private/);
    assert.equal(fs.statSync(root).mode & 0o777, 0o755);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('missing or corrupt transaction journals block new apply as recovery-required', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-hook-root-'));
  try {
    const id = 'tx-2026-09-02T00-00-00.000Z-0123456789abcdef';
    const dir = path.join(root, id);
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'receipt.json'), '{broken', { mode: 0o600 });
    const unfinished = unfinishedHookReceipts(root);
    assert.equal(unfinished.length, 1);
    assert.equal(unfinished[0].id, id);
    assert.equal(unfinished[0].status, 'unknown-recovery-required');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('undo preview verifies backup bytes before reporting ready', () => {
  const fx = fixture();
  try {
    const plan = fx.plan();
    const applied = applyHookHealingPlan({
      plan, actionIds: [plan.actions[0].id], expectedPlanDigest: plan.planDigest,
      transactionsRoot: fx.transactionsRoot, auditFn: fx.audit,
      replanFn: (report) => buildHookHealingPlan({ report }),
    });
    const receipt = JSON.parse(fs.readFileSync(applied.receiptFile, 'utf8'));
    fs.rmSync(path.join(path.dirname(applied.receiptFile), receipt.actions[0].backup.relative));
    const preview = previewHookHealingUndo({ transactionsRoot: fx.transactionsRoot, receiptId: applied.receiptId });
    assert.equal(preview.ok, false);
    assert.equal(preview.status, 'drift-refused');
    assert.match(preview.error, /ENOENT|could not|no such file/i);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('unfinished applied receipts require explicit previewed recovery and restore exact bytes', () => {
  const fx = fixture();
  try {
    const original = fs.readFileSync(fx.target);
    const plan = fx.plan();
    const applied = applyHookHealingPlan({
      plan, actionIds: [plan.actions[0].id], expectedPlanDigest: plan.planDigest,
      transactionsRoot: fx.transactionsRoot, auditFn: fx.audit,
      replanFn: (report) => buildHookHealingPlan({ report }),
    });
    const receipt = JSON.parse(fs.readFileSync(applied.receiptFile, 'utf8'));
    receipt.status = 'applying';
    receipt.actions[0].state = 'applied';
    writeHookReceipt(applied.receiptFile, receipt);
    const preview = previewHookHealingRecovery({ transactionsRoot: fx.transactionsRoot, receiptId: applied.receiptId });
    assert.equal(preview.ok, true);
    assert.equal(preview.actions[0].status, 'ready');
    assert.equal(preview.actions[0].backupVerified, true);
    const recovered = recoverHookHealing({ transactionsRoot: fx.transactionsRoot, receiptId: applied.receiptId });
    assert.equal(recovered.ok, true);
    assert.equal(recovered.status, 'rolled-back');
    assert.deepEqual(fs.readFileSync(fx.target), original);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('Windows plans expose findings but compile no executable replacement action', () => {
  const fx = fixture();
  try {
    const report = fx.audit();
    const plan = buildHookHealingPlan({ report, platform: 'win32' });
    assert.equal(plan.summary.executable, 0);
    assert.ok(plan.actions.every((action) => action.executable === false));
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});
