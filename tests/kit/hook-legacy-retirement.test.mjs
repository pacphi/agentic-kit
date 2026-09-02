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
  applyHookHealingPlan, undoHookHealing,
} from '../../src/lib/hook-remediation/engine.mjs';
import {
  legacyRufloProjectHookSignature, retireLegacyRufloProjectHooks,
} from '../../src/lib/hook-audit/codex-legacy.mjs';

const POSIX_MUTATION_ONLY = process.platform === 'win32'
  ? { skip: 'executable hook healing is intentionally unavailable on Windows' }
  : {};

const LEGACY_PREFIX = 'sh -c \'D="${CLAUDE_PROJECT_DIR:-.}"; [ -f "$D/.claude/helpers/hook-handler.cjs" ] || D="${HOME}"; exec node "$D/.claude/helpers/hook-handler.cjs"';
const AUTO_MEMORY_PREFIX = 'sh -c \'D="${CLAUDE_PROJECT_DIR:-.}"; [ -f "$D/.claude/helpers/auto-memory-hook.mjs" ] || D="${HOME}"; exec node "$D/.claude/helpers/auto-memory-hook.mjs"';

function hook(command, timeout) {
  return {
    type: 'command', command,
    ...(timeout === undefined ? {} : { timeout }),
  };
}

function legacy(command, timeout) {
  return hook(`${LEGACY_PREFIX} ${command}'`, timeout);
}

function autoMemory(command, timeout) {
  return hook(`${AUTO_MEMORY_PREFIX} ${command}'`, timeout);
}

function writeJson(file, value, mode = 0o640) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode });
}

function installRufloPlugin(codexHome) {
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(
    path.join(codexHome, 'config.toml'),
    '[plugins."ruflo-core@ruflo"]\nenabled = true\n',
  );
  const root = path.join(codexHome, 'plugins', 'cache', 'ruflo', 'ruflo-core', '0.2.6');
  writeJson(path.join(root, '.codex-plugin', 'plugin.json'), {
    name: 'ruflo-core', version: '0.2.6', hooks: './hooks/hooks.json',
  });
  writeJson(path.join(root, 'hooks', 'hooks.json'), {
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [hook('node plugin-pre.cjs')] }],
      PostToolUse: [{ matcher: 'Bash', hooks: [hook('node plugin-post.cjs')] }],
    },
  });
  return root;
}

function legacyDocument(label = 'one') {
  return {
    keep: { label },
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [
        legacy('pre-bash', 5000),
        hook('node project-owned-guard.cjs', 7),
      ] }],
      PostToolUse: [{ matcher: 'Bash', hooks: [legacy('post-bash', 5000)] }],
      SessionStart: [{ hooks: [
        legacy('session-restore', 15000),
        autoMemory('import', 8),
      ] }],
      SessionEnd: [{ hooks: [legacy('session-end', 10000)] }],
      Stop: [{ hooks: [autoMemory('sync', 10)] }],
    },
  };
}

function fixture(projectCount = 1, { withPlugin = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-hook-legacy-'));
  const codexHome = path.join(root, 'codex');
  const projects = Array.from({ length: projectCount }, (_, index) => path.join(root, `project-${index}`));
  const targets = projects.map((project, index) => {
    const target = path.join(project, '.codex', 'hooks.json');
    writeJson(target, legacyDocument(String(index)));
    return target;
  });
  const pluginRoot = withPlugin ? installRufloPlugin(codexHome) : null;
  const transactionsRoot = path.join(root, 'transactions');
  const audit = () => auditHooks({
    hosts: ['codex'],
    versions: { codex: '0.152.1' },
    projectRoots: projects,
    codex: { codexHome, pluginCacheDir: path.join(codexHome, 'plugins', 'cache') },
    upstream: { file: path.join(root, 'missing-constraints.json') },
  });
  return { root, codexHome, projects, targets, pluginRoot, transactionsRoot, audit };
}

test('Codex 0.152.1 is exact-profile verified while the next version stays syntax-only', () => {
  const fx = fixture();
  try {
    const current = fx.audit().reports.codex;
    assert.equal(current.hostSchema.confidence, 'verified');
    assert.equal(current.records.find((record) => record.event === 'SessionEnd').timeout.maximum, 3);
    const interruptFile = fx.targets[0];
    const interruptDocument = legacyDocument('interrupt');
    interruptDocument.hooks.Interrupt = [{ hooks: [hook('node interrupt.cjs', 5)] }];
    writeJson(interruptFile, interruptDocument);
    const interrupt = fx.audit().reports.codex.records.find((record) => record.event === 'Interrupt');
    assert.equal(interrupt.timeout.maximum, 3);
    assert.ok(interrupt.diagnostics.some((diagnostic) => diagnostic.code === 'interrupt-timeout-clamped'));
    for (const version of ['0.152.0', '0.152.2']) {
      const unverified = auditHooks({
        hosts: ['codex'], versions: { codex: version }, projectRoots: fx.projects,
        codex: { codexHome: fx.codexHome, pluginCacheDir: path.join(fx.codexHome, 'plugins', 'cache') },
        upstream: { file: path.join(fx.root, 'missing-constraints.json') },
      }).reports.codex;
      assert.equal(unverified.hostSchema.confidence, 'syntax-only');
    }
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('legacy Ruflo project hooks compile to one approval-required retirement that preserves unrelated hooks', POSIX_MUTATION_ONLY, () => {
  const fx = fixture();
  try {
    const report = fx.audit();
    const plan = buildHookHealingPlan({ report });
    const executable = plan.actions.filter((action) => action.executable);
    assert.equal(executable.length, 1);
    const action = executable[0];
    assert.equal(action.classification, 'approval-required');
    assert.equal(action.recipeId, 'codex/project-json/legacy-ruflo-claude-projection-retirement/v1');
    assert.equal(action.canonicalTarget.file, fx.targets[0]);
    assert.equal(action.replacementEvidence.pluginRef, 'ruflo-core@ruflo');
    assert.deepEqual(action.replacementEvidence.pluginVersions, ['0.2.6']);
    assert.deepEqual(action.replacementEvidence.coveredEvents, ['PostToolUse', 'PreToolUse']);
    assert.match(action.behaviorImpact, /preserv/i);
    assert.match(action.trustImpact, /shifted handler indexes/i);
    assert.doesNotMatch(JSON.stringify(publicHookHealingPlan(plan)), /hook-handler\.cjs/);

    const candidate = JSON.parse(action.candidateBytes.toString('utf8'));
    assert.deepEqual(candidate.keep, { label: '0' });
    assert.equal(candidate.hooks.PreToolUse[0].hooks.length, 1);
    assert.equal(candidate.hooks.PreToolUse[0].hooks[0].command, 'node project-owned-guard.cjs');
    assert.equal(candidate.hooks.PostToolUse, undefined);
    assert.equal(candidate.hooks.SessionStart[0].hooks.length, 1);
    assert.match(candidate.hooks.SessionStart[0].hooks[0].command, /auto-memory-hook\.mjs/);
    assert.equal(candidate.hooks.SessionEnd, undefined);
    assert.match(candidate.hooks.Stop[0].hooks[0].command, /auto-memory-hook\.mjs/);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('exact detector refuses near-matches and distinguishes an absent matcher', () => {
  const recognized = legacy('session-restore', 15000);
  assert.ok(legacyRufloProjectHookSignature('SessionStart', undefined, recognized));
  assert.equal(legacyRufloProjectHookSignature('SessionStart', '', recognized), null);
  assert.equal(legacyRufloProjectHookSignature('SessionStart', undefined, {
    ...recognized, statusMessage: 'extra',
  }), null);
  assert.equal(legacyRufloProjectHookSignature('SessionStart', undefined, {
    ...recognized, command: `${LEGACY_PREFIX} unknown-action'`,
  }), null);
});

test('retirement preserves metadata on an emptied group', () => {
  const input = {
    hooks: {
      SessionEnd: [{ owner: 'project', hooks: [legacy('session-end', 10000)] }],
    },
  };
  const retired = retireLegacyRufloProjectHooks(input);
  assert.equal(retired.removed.length, 1);
  assert.deepEqual(retired.document.hooks.SessionEnd, [{ owner: 'project', hooks: [] }]);
});

test('an ambiguous helper occurrence blocks the entire file retirement', POSIX_MUTATION_ONLY, () => {
  const fx = fixture();
  try {
    const document = legacyDocument('ambiguous');
    document.hooks.PreToolUse[0].hooks.push({
      ...legacy('pre-bash', 5000), statusMessage: 'near match',
    });
    writeJson(fx.targets[0], document);
    const plan = buildHookHealingPlan({ report: fx.audit() });
    assert.equal(plan.summary.executable, 0);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('a noncanonical project file is never executable', POSIX_MUTATION_ONLY, () => {
  const fx = fixture();
  try {
    fs.writeFileSync(fx.targets[0], JSON.stringify(legacyDocument('compact')));
    const plan = buildHookHealingPlan({ report: fx.audit() });
    assert.equal(plan.summary.executable, 0);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('retirement requires a selected Ruflo replacement plugin', () => {
  const fx = fixture(1, { withPlugin: false });
  try {
    const plan = buildHookHealingPlan({ report: fx.audit() });
    assert.equal(plan.summary.executable, 0);
    assert.ok(plan.actions.some((action) => (
      action.classification === 'approval-required'
      && action.executable === false
      && /replacement plugin/i.test(action.reason)
    )));
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('multi-project retirement commits one receipt and undo restores every exact preimage', POSIX_MUTATION_ONLY, () => {
  const fx = fixture(2);
  try {
    const originals = fx.targets.map((target) => fs.readFileSync(target));
    const plan = buildHookHealingPlan({ report: fx.audit() });
    const actionIds = plan.actions.filter((action) => action.executable).map((action) => action.id);
    assert.equal(actionIds.length, 2);
    const applied = applyHookHealingPlan({
      plan, actionIds, expectedPlanDigest: plan.planDigest,
      transactionsRoot: fx.transactionsRoot, auditFn: fx.audit,
    });
    assert.equal(applied.ok, true);
    assert.equal(applied.status, 'committed');
    assert.equal(applied.receipt.actions.length, 2);
    for (const target of fx.targets) {
      assert.doesNotMatch(fs.readFileSync(target, 'utf8'), /hook-handler\.cjs/);
      assert.match(fs.readFileSync(target, 'utf8'), /auto-memory-hook\.mjs/);
    }

    const undone = undoHookHealing({
      transactionsRoot: fx.transactionsRoot, receiptId: applied.receiptId,
    });
    assert.equal(undone.ok, true);
    fx.targets.forEach((target, index) => assert.deepEqual(fs.readFileSync(target), originals[index]));
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});
