import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync, sign as signEd25519 } from 'node:crypto';

import {
  codexAutoMemoryHookSignature, hasAmbiguousCodexAutoMemoryHook,
  retireCodexAutoMemoryHooks,
} from '../../src/lib/hook-audit/codex-auto-memory.mjs';
import { auditHooks } from '../../src/lib/hook-audit/orchestrator.mjs';
import { applyHookHealingPlan, undoHookHealing } from '../../src/lib/hook-remediation/engine.mjs';
import { buildHookHealingPlan } from '../../src/lib/hook-remediation/planner.mjs';

const PREFIX = 'sh -c \'D="${CLAUDE_PROJECT_DIR:-.}"; [ -f "$D/.claude/helpers/auto-memory-hook.mjs" ] || D="${HOME}"; exec node "$D/.claude/helpers/auto-memory-hook.mjs"';

function autoMemory(action, timeout) {
  return { type: 'command', command: `${PREFIX} ${action}'`, timeout };
}

function document() {
  return {
    keep: { owner: 'project' },
    hooks: {
      SessionStart: [{ hooks: [
        { type: 'command', command: 'node project-session-start.cjs', timeout: 7 },
        autoMemory('import', 8000),
      ] }],
      Stop: [{ hooks: [autoMemory('sync', 10000)] }],
      PostToolUse: [{ matcher: 'Write', hooks: [
        { type: 'command', command: 'node project-post.cjs', timeout: 5 },
      ] }],
    },
  };
}

test('recognizes only the exact paired Codex AutoMemory projection', () => {
  assert.equal(
    codexAutoMemoryHookSignature('SessionStart', undefined, autoMemory('import', 8000))?.action,
    'import',
  );
  assert.equal(
    codexAutoMemoryHookSignature('Stop', undefined, autoMemory('sync', 10000))?.action,
    'sync',
  );
  assert.equal(codexAutoMemoryHookSignature('SessionStart', '', autoMemory('import', 8000)), null);
  assert.equal(codexAutoMemoryHookSignature('SessionStart', undefined, autoMemory('import', 8)), null);
  assert.equal(codexAutoMemoryHookSignature('Stop', undefined, {
    ...autoMemory('sync', 10000), continueOnError: true,
  }), null);
});

test('retires only exact AutoMemory hooks and preserves unrelated bytes semantically', () => {
  const input = document();
  const result = retireCodexAutoMemoryHooks(input);
  assert.deepEqual(input, document());
  assert.deepEqual(result.removed.map(({ event, action }) => ({ event, action })), [
    { event: 'SessionStart', action: 'import' },
    { event: 'Stop', action: 'sync' },
  ]);
  assert.deepEqual(result.document, {
    keep: { owner: 'project' },
    hooks: {
      SessionStart: [{ hooks: [
        { type: 'command', command: 'node project-session-start.cjs', timeout: 7 },
      ] }],
      PostToolUse: [{ matcher: 'Write', hooks: [
        { type: 'command', command: 'node project-post.cjs', timeout: 5 },
      ] }],
    },
  });
});

test('flags any near-match as ambiguous so a planner cannot partially rewrite it', () => {
  const input = document();
  input.hooks.Stop[0].hooks[0].timeout = 9999;
  assert.equal(hasAmbiguousCodexAutoMemoryHook(input), true);
  const retired = retireCodexAutoMemoryHooks(input);
  assert.equal(retired.removed.length, 1);
  assert.match(retired.document.hooks.Stop[0].hooks[0].command, /auto-memory-hook/);
});

function writeJson(file, value, mode = 0o640) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode });
}

function signedHelper(root) {
  const helper = `
const log = (msg) => console.log('[AutoMemory] ' + msg);
class JsonFileBackend {
  async query(opts) {
    let results = [];
    if (opts?.namespace) results = results.filter(e => e.namespace === opts.namespace);
    if (opts?.type) results = results.filter(e => e.type === opts.type);
    return results;
  }
}
async function doSync() { log('Syncing insights to auto memory files...'); }
const command = process.argv[2] || 'status';
switch (command) { case 'sync': await doSync(); break; }
process.exit(0);
`;
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const manifest = {
    version: '3.38.21',
    files: { 'auto-memory-hook.mjs': createHash('sha256').update(helper).digest('hex') },
  };
  const bytes = Buffer.from(JSON.stringify({ version: manifest.version, files: manifest.files }));
  const helperFile = path.join(root, '.claude', 'helpers', 'auto-memory-hook.mjs');
  fs.mkdirSync(path.dirname(helperFile), { recursive: true });
  fs.writeFileSync(helperFile, helper);
  writeJson(path.join(root, '.claude', 'helpers', 'helpers.manifest.json'), {
    manifest,
    signature: signEd25519(null, bytes, privateKey).toString('base64'),
    algorithm: 'ed25519',
  });
  return publicKey.export({ type: 'spki', format: 'pem' });
}

function integrationFixture({ nearMatch = false, omitStop = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-hook-auto-memory-'));
  const project = path.join(root, 'project');
  const codexHome = path.join(root, 'codex');
  const target = path.join(project, '.codex', 'hooks.json');
  const input = document();
  if (nearMatch) input.hooks.Stop[0].hooks[0].timeout = 9999;
  if (omitStop) delete input.hooks.Stop;
  writeJson(target, input);
  const publicKey = signedHelper(project);
  const transactionsRoot = path.join(root, 'transactions');
  const audit = () => auditHooks({
    hosts: ['codex'], versions: { codex: '0.153.2' }, projectRoots: [project],
    codex: {
      codexHome, pluginCacheDir: path.join(codexHome, 'plugins', 'cache'),
      rufloHelpersPublicKey: publicKey,
    },
    upstream: { file: path.join(root, 'missing-constraints.json') },
  });
  return { root, project, target, transactionsRoot, audit };
}

const POSIX_MUTATION_ONLY = process.platform === 'win32'
  ? { skip: 'executable hook healing is intentionally unavailable on Windows' }
  : {};

test('transactionally quarantines the exact pair and undo restores the preimage', POSIX_MUTATION_ONLY, () => {
  const fx = integrationFixture();
  try {
    const original = fs.readFileSync(fx.target);
    const plan = buildHookHealingPlan({ report: fx.audit() });
    const action = plan.actions.find(
      (candidate) => candidate.recipeId === 'codex/project-json/ruflo-auto-memory-quarantine/v1',
    );
    assert.equal(action.classification, 'approval-required');
    assert.equal(action.executable, true);
    assert.match(action.behaviorImpact, /native \.swarm\/agentdb-memory\.db remain unchanged/);

    const applied = applyHookHealingPlan({
      plan, actionIds: [action.id], expectedPlanDigest: plan.planDigest,
      transactionsRoot: fx.transactionsRoot, auditFn: fx.audit,
    });
    assert.equal(applied.status, 'committed');
    const changed = fs.readFileSync(fx.target, 'utf8');
    assert.doesNotMatch(changed, /auto-memory-hook/);
    assert.match(changed, /project-session-start/);
    const secondPlan = buildHookHealingPlan({ report: fx.audit() });
    assert.equal(secondPlan.actions.some((candidate) => candidate.executable), false);

    const undone = undoHookHealing({
      transactionsRoot: fx.transactionsRoot, receiptId: applied.receiptId,
    });
    assert.equal(undone.status, 'rolled-back');
    assert.deepEqual(fs.readFileSync(fx.target), original);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

for (const [label, options] of [
  ['a near-match', { nearMatch: true }],
  ['an incomplete pair', { omitStop: true }],
]) {
  test(`refuses executable quarantine for ${label}`, () => {
    const fx = integrationFixture(options);
    try {
      const plan = buildHookHealingPlan({ report: fx.audit() });
      assert.equal(plan.actions.some(
        (candidate) => candidate.recipeId === 'codex/project-json/ruflo-auto-memory-quarantine/v1',
      ), false);
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });
}
