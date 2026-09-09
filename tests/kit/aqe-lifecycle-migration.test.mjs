import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { auditHooks } from '../../src/lib/hook-audit/orchestrator.mjs';
import { buildHookHealingPlan } from '../../src/lib/hook-remediation/planner.mjs';
import { applyHookHealingPlan, undoHookHealing } from '../../src/lib/hook-remediation/engine.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-aqe-artifact-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [dir, name] of [['hooks', 'aqe-hook.cjs'], ['helpers', 'brain-checkpoint.cjs']]) {
    fs.mkdirSync(path.join(root, '.claude', dir), { recursive: true });
    fs.copyFileSync(new URL(`../fixtures/aqe-lifecycle/${name}`, import.meta.url), path.join(root, '.claude', dir, name));
  }
  const signature = JSON.parse(fs.readFileSync(new URL('../../src/templates/aqe-lifecycle/legacy-handlers.json', import.meta.url)))[0];
  const settings = { keep: true, hooks: { [signature.event]: [{ matcher: signature.matcher,
    hooks: [{ type: 'command', command: 'ruflo hooks pre-edit', timeout: 12 }, signature.hook] }] } };
  const settingsFile = path.join(root, '.claude', 'settings.json');
  fs.writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
  const audit = (version = '2.1.258') => auditHooks({ hosts: ['claude'], projectRoots: [root],
    versions: { claude: version }, claude: { claudeRoot: path.join(root, 'absent'), managedSettingsFile: null },
    upstream: { file: path.join(root, 'absent.json') } });
  return { root, audit, settings, settingsFile };
}

test('content-bound migration backs up helpers and preserves mixed hook groups, then undoes exactly', (t) => {
  const fx = fixture(t);
  const plan = buildHookHealingPlan({ report: fx.audit() });
  const actions = plan.actions.filter((item) => item.executable);
  assert.equal(actions.length, 3);
  const transactionsRoot = path.join(fx.root, 'transactions');
  const result = applyHookHealingPlan({ plan, actionIds: actions.map((item) => item.id),
    expectedPlanDigest: plan.planDigest, transactionsRoot, auditFn: fx.audit });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.receipt.verification.idempotentNoop, true);
  const settings = JSON.parse(fs.readFileSync(fx.settingsFile));
  const hooks = settings.hooks.PreToolUse[0].hooks;
  assert.deepEqual(hooks[0], fx.settings.hooks.PreToolUse[0].hooks[0]);
  assert.equal(hooks[1].timeout, 3);
  const helper = fs.readFileSync(path.join(fx.root, '.claude/helpers/brain-checkpoint.cjs'), 'utf8');
  assert.doesNotMatch(helper, /unlinkSync|'npx'/);
  const shim = fs.readFileSync(path.join(fx.root, '.claude/hooks/aqe-hook.cjs'), 'utf8');
  assert.doesNotMatch(shim, /cmd = .*npx|cmdArgs = \['-y'/);
  const undone = undoHookHealing({ transactionsRoot, receiptId: result.receipt.id });
  assert.equal(undone.ok, true, JSON.stringify(undone));
  assert.deepEqual(JSON.parse(fs.readFileSync(fx.settingsFile)), fx.settings);
});

test('unverified host profile and user-modified artifacts cannot acquire executable helper actions', (t) => {
  const fx = fixture(t);
  assert.equal(buildHookHealingPlan({ report: fx.audit('999.0.0') }).summary.executable, 0);
  for (const name of ['hooks/aqe-hook.cjs', 'helpers/brain-checkpoint.cjs']) {
    fs.appendFileSync(path.join(fx.root, '.claude', name), '\n// user modification\n');
  }
  const plan = buildHookHealingPlan({ report: fx.audit() });
  assert.equal(plan.actions.filter((item) => item.executable && item.canonicalTarget.file.endsWith('.cjs')).length, 0);
  assert.equal(plan.actions.filter((item) => item.classification === 'never-automatic').length, 2);
});

test('failed checkpoint export leaves the previous RVF and sidecar untouched without package resolution', () => {
  const source = fs.readFileSync(new URL('../../src/templates/aqe-lifecycle/brain-checkpoint.cjs', import.meta.url), 'utf8');
  const nativeRequire = createRequire(import.meta.url);
  const calls = [];
  const context = { __dirname: '/project/.claude/helpers', require(name) {
    if (name === 'fs') return { existsSync: (file) => !file.endsWith('DISABLE_BRAIN_CHECKPOINT'), unlinkSync: () => assert.fail('checkpoint deletion') };
    if (name === 'child_process') return { execFileSync(command, args) { calls.push({ command, args }); throw new Error('export failed'); } };
    return nativeRequire(name);
  }, process: { argv: ['node', 'helper', 'export'], env: {}, platform: 'linux', stderr: { write() {} } } };
  vm.runInNewContext(source, context);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'aqe');
  assert.equal(calls[0].args[0], 'brain');
});

test('lifecycle runner launches installed AQE directly when a project bundle is absent', () => {
  const source = fs.readFileSync(new URL('../../src/templates/aqe-lifecycle/aqe-hook.cjs', import.meta.url), 'utf8');
  const nativeRequire = createRequire(import.meta.url);
  const calls = [];
  vm.runInNewContext(source, { require(name) {
    if (name === 'node:fs') return { existsSync: () => false };
    if (name === 'node:child_process') return { spawnSync(command, args, options) {
      calls.push({ command, args: [...args], options }); return { stdout: '{}\n', status: 0 };
    } };
    return nativeRequire(name);
  }, process: { argv: ['node', 'shim', 'route', '--json'], env: {}, platform: 'linux',
    exit() {}, stdout: { write() {} } } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'aqe');
  assert.deepEqual(calls[0].args, ['hooks', 'route', '--json']);
  assert.equal(calls[0].options.timeout, 4500);
});


test('released 3.14.1 checkpoint is also recognized and malformed hooks remain read-only', (t) => {
  const fx = fixture(t);
  fs.copyFileSync(new URL('../fixtures/aqe-lifecycle/brain-checkpoint-3.14.1.cjs', import.meta.url),
    path.join(fx.root, '.claude/helpers/brain-checkpoint.cjs'));
  fs.writeFileSync(fx.settingsFile, JSON.stringify({ hooks: { Stop: [null] } }));
  const plan = buildHookHealingPlan({ report: fx.audit() });
  assert.equal(plan.actions.filter((item) => item.executable).length, 2);
  const checkpoint = plan.actions.find((item) => item.recipeId?.includes('brain-checkpoint.cjs'));
  assert.match(checkpoint.candidateBytes.toString(), /CHECKPOINT_DISABLED/);
  assert.doesNotMatch(checkpoint.candidateBytes.toString(), /unlinkSync/);
});


test('Claude 2.1.266 receives its own verified profile and receipt identity', (t) => {
  const fx = fixture(t);
  const audit = () => fx.audit('2.1.266');
  const report = audit();
  assert.equal(report.reports.claude.hostSchema.id, 'claude-hooks-2.1.266');
  const plan = buildHookHealingPlan({ report });
  const actions = plan.actions.filter((item) => item.executable);
  assert.equal(actions.length, 3);
  assert.ok(actions.every((item) => item.hostVersion === '2.1.266'));
  const result = applyHookHealingPlan({ plan, actionIds: actions.map((item) => item.id),
    expectedPlanDigest: plan.planDigest, transactionsRoot: path.join(fx.root, 'transactions'), auditFn: audit });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.receipt.actions.every((item) => item.hostVersion === '2.1.266'));
});
