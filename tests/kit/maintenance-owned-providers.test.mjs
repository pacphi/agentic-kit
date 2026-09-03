import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sha256 } from '../../src/lib/maintenance/providers/shared.mjs';
import {
  createMaintenanceProviderRegistry,
} from '../../src/lib/maintenance/provider-registry.mjs';
import {
  createOwnedSkillProvider,
} from '../../src/lib/maintenance/providers/owned-skill.mjs';
import {
  createOwnedNpxCacheProvider,
} from '../../src/lib/maintenance/providers/owned-storage.mjs';
import {
  createRufloMcpOrphanProvider,
} from '../../src/lib/maintenance/providers/ruflo-mcp-orphan.mjs';

const fileHash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-maint-owned-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function entriesFor(root) {
  const entries = [];
  function visit(dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const file = path.join(dir, entry.name);
      const stat = fs.lstatSync(file);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        entries.push({ path: relative, kind: 'directory', mode: stat.mode & 0o777 });
        visit(file, relative);
      } else {
        entries.push({
          path: relative,
          kind: entry.isFile() && !entry.isSymbolicLink() ? 'file' : 'unsupported',
          mode: stat.mode & 0o777,
          size: stat.size,
          digest: entry.isFile() && !entry.isSymbolicLink() ? fileHash(file) : null,
        });
      }
    }
  }
  visit(root);
  return entries;
}

function skillReceipt(target, allowedRoot, overrides = {}) {
  const entries = entriesFor(target);
  return {
    schemaVersion: 'agentic-kit.skill-tree-ownership/v1',
    id: `skill-receipt-${path.basename(target)}`,
    owner: 'agentic-kit',
    resourceId: `skill:project:${path.basename(target)}`,
    scope: 'project',
    sourceKind: 'projected',
    desired: false,
    root: target,
    allowedRoot,
    manifest: { complete: true, entries, digest: sha256(entries) },
    ...overrides,
  };
}

function skillFinding(receipt, operation = 'archive') {
  return {
    state: 'stale-configuration',
    classification: 'receipt-owned-unchanged',
    safetyClass: 'safe-automatic',
    resource: {
      id: receipt.resourceId, kind: 'skill', name: path.basename(receipt.root),
      host: 'agentic-kit', scope: receipt.scope,
    },
    ownership: { authority: 'agentic-kit-receipt', managed: true },
    nextAction: { operation },
  };
}

function makeSkill(root, name = 'demo') {
  const allowedRoot = path.join(root, 'project', '.agents', 'skills');
  const target = path.join(allowedRoot, name);
  fs.mkdirSync(path.join(target, 'references'), { recursive: true });
  fs.writeFileSync(path.join(target, 'SKILL.md'), `# ${name}\n`);
  fs.writeFileSync(path.join(target, 'references', 'notes.md'), 'owned notes\n');
  return { allowedRoot, target };
}

test('exact recursive skill receipt archives, verifies, and restores without exposing paths', async (t) => {
  const root = fixture(t);
  const { allowedRoot, target } = makeSkill(root);
  const archiveRoot = path.join(root, 'maintenance-archive');
  const receipt = skillReceipt(target, allowedRoot);
  const provider = createOwnedSkillProvider({ receipts: [receipt], allowedRoots: [allowedRoot], archiveRoot });

  const facts = await provider.detect();
  const fact = facts.skills.find((row) => row.resourceId === receipt.resourceId);
  assert.ok(fact, JSON.stringify(facts));
  assert.equal(fact.status, 'owned-current');
  assert.equal(fact.executable, true);
  const action = provider.actionFor(skillFinding(receipt), facts);
  assert.equal(action.rollback, 'reversible');
  assert.equal(JSON.stringify(action).includes(root), false);
  assert.equal((await provider.preflight(action)).ok, true);
  assert.deepEqual(await provider.inspectCurrent(action), {
    complete: true, postFingerprint: action.sourceFingerprint,
  });

  const outcome = await provider.apply(action);
  assert.equal(outcome.status, 'applied');
  assert.equal(fs.existsSync(target), false);
  assert.equal((await provider.verify(action, outcome)).ok, true);

  const entry = {
    actionId: action.id,
    operation: action.operation,
    resourceIdentity: action.resourceIdentity,
    sourceFingerprint: action.sourceFingerprint,
    outcome,
  };
  assert.deepEqual(await provider.inspectPostimage(entry), {
    complete: true, postFingerprint: outcome.postFingerprint,
  });
  assert.equal((await provider.undo(entry)).status, 'restored');
  assert.equal((await provider.verifyUndo(entry)).ok, true);
  assert.equal(fs.readFileSync(path.join(target, 'references', 'notes.md'), 'utf8'), 'owned notes\n');
});

test('skill provider preserves legacy, partial, modified, duplicate, and unreceipted resources', async (t) => {
  const root = fixture(t);
  const { allowedRoot, target } = makeSkill(root);
  const exact = skillReceipt(target, allowedRoot);
  const legacy = { path: path.join(target, 'SKILL.md'), digest: fileHash(path.join(target, 'SKILL.md')), desired: false };
  const partial = skillReceipt(target, allowedRoot, {
    id: 'skill-receipt-partial', resourceId: 'skill:project:partial',
    manifest: { complete: false, entries: [], digest: sha256([]) },
  });
  const duplicate = { ...exact, id: 'skill-receipt-duplicate' };
  const provider = createOwnedSkillProvider({
    receipts: [legacy, partial, exact, duplicate], allowedRoots: [allowedRoot],
    archiveRoot: path.join(root, 'archive'),
  });
  const facts = await provider.detect();
  assert.ok(facts.skills.find((row) => row.resourceId === partial.resourceId), JSON.stringify(facts));
  assert.equal(facts.receiptLimitations.some((row) => row.reason === 'complete-tree-manifest-required'), true);
  const legacyFinding = provider.findings(facts)
    .find((row) => row.classification === 'legacy-skill-receipt-report-only');
  assert.equal(legacyFinding.nextAction.executable, false);
  assert.equal(legacyFinding.safetyClass, 'never-automatic');
  assert.equal(facts.skills.find((row) => row.resourceId === partial.resourceId).executable, false);
  assert.equal(facts.skills.find((row) => row.resourceId === exact.resourceId).reason, 'ambiguous-ownership-receipts');
  assert.equal(provider.actionFor(skillFinding(exact), facts), null);

  const modifiedRoot = makeSkill(root, 'modified');
  const modified = skillReceipt(modifiedRoot.target, modifiedRoot.allowedRoot);
  fs.writeFileSync(path.join(modifiedRoot.target, 'SKILL.md'), '# user edit\n');
  const modifiedProvider = createOwnedSkillProvider({
    receipts: [modified], allowedRoots: [modifiedRoot.allowedRoot], archiveRoot: path.join(root, 'archive-2'),
  });
  const modifiedFacts = await modifiedProvider.detect();
  assert.equal(modifiedFacts.skills[0].status, 'modified-or-shape-drift');
  assert.equal(modifiedProvider.actionFor(skillFinding(modified), modifiedFacts), null);
  assert.equal(modifiedProvider.actionFor(skillFinding({ ...modified, resourceId: 'skill:project:missing' }), modifiedFacts), null);

  const unreadableRoot = makeSkill(root, 'unreadable');
  const unreadable = skillReceipt(unreadableRoot.target, unreadableRoot.allowedRoot);
  const fsImpl = {
    ...fs,
    readdirSync(targetPath, options) {
      if (path.resolve(targetPath) === unreadable.root) {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      }
      return fs.readdirSync(targetPath, options);
    },
  };
  const unreadableProvider = createOwnedSkillProvider({
    receipts: [unreadable], allowedRoots: [unreadable.allowedRoot],
    archiveRoot: path.join(root, 'archive-3'), fsImpl,
  });
  const unreadableFacts = await unreadableProvider.detect();
  assert.equal(unreadableFacts.skills[0].reason, 'unreadable-tree');
  assert.equal(unreadableProvider.actionFor(skillFinding(unreadable), unreadableFacts), null);
});

test('skill ownership fails closed when filesystem owner identity is unavailable', async (t) => {
  const root = fixture(t);
  const { allowedRoot, target } = makeSkill(root);
  const receipt = skillReceipt(target, allowedRoot);
  const fsImpl = {
    ...fs,
    lstatSync(file) {
      const stat = fs.lstatSync(file);
      return new Proxy(stat, {
        get(value, key) {
          if (key === 'uid') return undefined;
          const property = Reflect.get(value, key);
          return typeof property === 'function' ? property.bind(value) : property;
        },
      });
    },
  };
  const provider = createOwnedSkillProvider({
    receipts: [receipt], allowedRoots: [allowedRoot], archiveRoot: path.join(root, 'archive'), fsImpl,
  });
  const facts = await provider.detect();
  assert.equal(facts.skills[0].executable, false);
  assert.equal(facts.skills[0].status, 'modified-or-shape-drift');
  assert.equal(provider.actionFor(skillFinding(receipt), facts), null);
});

test('skill provider rejects traversal, symlink targets, plugin-cache roots, and incomplete shape', async (t) => {
  const root = fixture(t);
  const { allowedRoot, target } = makeSkill(root);
  const outsideRoot = path.join(root, 'outside-root');
  const outsideTarget = path.join(outsideRoot, 'outside');
  fs.mkdirSync(outsideTarget, { recursive: true });
  fs.writeFileSync(path.join(outsideTarget, 'SKILL.md'), '# outside\n');
  const pluginRoot = path.join(root, 'plugin-cache');
  const pluginTarget = path.join(pluginRoot, 'demo');
  fs.mkdirSync(pluginTarget, { recursive: true });
  fs.writeFileSync(path.join(pluginTarget, 'SKILL.md'), '# plugin\n');
  const symlink = path.join(allowedRoot, 'linked');
  fs.symlinkSync(target, symlink);

  const traversal = skillReceipt(outsideTarget, allowedRoot, {
    id: 'skill-receipt-traversal', resourceId: 'skill:project:traversal',
  });
  const linked = skillReceipt(target, allowedRoot, {
    id: 'skill-receipt-linked', resourceId: 'skill:project:linked', root: symlink,
  });
  const plugin = skillReceipt(pluginTarget, pluginRoot, {
    id: 'skill-receipt-plugin', resourceId: 'skill:plugin:demo', scope: 'user', sourceKind: 'standalone',
  });
  const omitted = skillReceipt(target, allowedRoot, {
    id: 'skill-receipt-omitted', resourceId: 'skill:project:omitted',
  });
  omitted.manifest.entries = omitted.manifest.entries.filter((entry) => !entry.path.endsWith('notes.md'));
  omitted.manifest.digest = sha256(omitted.manifest.entries);

  const provider = createOwnedSkillProvider({
    receipts: [traversal, linked, plugin, omitted],
    allowedRoots: [allowedRoot, pluginRoot], pluginCacheRoots: [pluginRoot],
    archiveRoot: path.join(root, 'archive'),
  });
  const facts = await provider.detect();
  assert.deepEqual(facts.skills.map((row) => row.executable), [false, false, false, false]);
  assert.equal(facts.skills.some((row) => row.reason === 'target-outside-exact-allowed-root'), true);
  assert.equal(facts.skills.some((row) => row.reason === 'target-is-symlink'), true);
  assert.equal(facts.skills.some((row) => row.reason === 'plugin-cache-target-forbidden'), true);
  assert.equal(facts.skills.some((row) => row.reason === 'manifest-shape-drift'), true);
  assert.throws(() => createOwnedSkillProvider({
    allowedRoots: [allowedRoot], archiveRoot: allowedRoot,
  }), /bounded roots/);
  assert.throws(() => createOwnedSkillProvider({
    allowedRoots: [], archiveRoot: path.parse(root).root,
  }), /bounded roots/);
});

test('skill prune is exact and idempotent while archive undo refuses postimage drift', async (t) => {
  const root = fixture(t);
  const pruned = makeSkill(root, 'pruned');
  const pruneReceipt = skillReceipt(pruned.target, pruned.allowedRoot);
  const pruneProvider = createOwnedSkillProvider({
    receipts: [pruneReceipt], allowedRoots: [pruned.allowedRoot], archiveRoot: path.join(root, 'prune-archive'),
  });
  const pruneFacts = await pruneProvider.detect();
  const pruneAction = pruneProvider.actionFor(skillFinding(pruneReceipt, 'prune'), pruneFacts);
  assert.equal(pruneAction.rollback, 'irreversible');
  const prunedOutcome = await pruneProvider.apply(pruneAction);
  assert.equal(prunedOutcome.status, 'applied');
  assert.equal((await pruneProvider.verify(pruneAction, prunedOutcome)).ok, true);
  assert.equal((await pruneProvider.apply(pruneAction)).status, 'unchanged');

  const archived = makeSkill(root, 'archived');
  const archiveReceipt = skillReceipt(archived.target, archived.allowedRoot);
  const archiveRoot = path.join(root, 'archive');
  const archiveProvider = createOwnedSkillProvider({
    receipts: [archiveReceipt], allowedRoots: [archived.allowedRoot], archiveRoot,
  });
  const archiveAction = archiveProvider.actionFor(skillFinding(archiveReceipt), await archiveProvider.detect());
  const archiveOutcome = await archiveProvider.apply(archiveAction);
  const archivedTarget = path.join(archiveRoot, fs.readdirSync(archiveRoot)[0]);
  fs.writeFileSync(path.join(archivedTarget, 'SKILL.md'), '# later edit\n');
  const entry = {
    actionId: archiveAction.id, operation: 'archive', resourceIdentity: archiveAction.resourceIdentity,
    sourceFingerprint: archiveAction.sourceFingerprint, outcome: archiveOutcome,
  };
  assert.equal((await archiveProvider.undo(entry)).status, 'refused');
  assert.equal(fs.existsSync(archived.target), false);
});

function cacheCandidate(root, id = 'abc') {
  const target = path.join(root, id);
  return {
    id: `stale-npx-env:${id}`, kind: 'stale-npx-env', path: target,
    safety: 'regenerable', advisory: true,
    bytes: { status: 'measured', value: 10, partial: false },
    files: { status: 'measured', value: 2, partial: false },
  };
}

function cacheFinding(candidate) {
  return {
    state: 'orphaned-cache', classification: 'reproducible-storage-candidate',
    safetyClass: 'safe-automatic',
    resource: { id: candidate.id, kind: candidate.kind, host: 'agentic-kit', scope: 'machine' },
    ownership: { authority: 'agentic-kit-procedure', managed: true },
    nextAction: { operation: 'clean' },
  };
}

function makeNpxEnv(root, id = 'abc', version = '1.0.0') {
  const target = path.join(root, id);
  fs.mkdirSync(path.join(target, 'node_modules', 'ruflo'), { recursive: true });
  fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ dependencies: { ruflo: '*' } }));
  fs.writeFileSync(path.join(target, 'node_modules', 'ruflo', 'package.json'), JSON.stringify({ version }));
  return target;
}

test('owned npx provider cleans only an exact freshly stale collector candidate', async (t) => {
  const root = fixture(t);
  const cacheRoot = path.join(root, '_npx');
  makeNpxEnv(cacheRoot);
  const candidate = cacheCandidate(cacheRoot);
  const provider = createOwnedNpxCacheProvider({
    candidates: [candidate], root: cacheRoot, baseline: () => '2.0.0',
  });
  const facts = await provider.detect();
  assert.equal(facts.candidates[0].status, 'owned-procedure-current');
  const action = provider.actionFor(cacheFinding(candidate), facts);
  assert.equal(action.rollback, 'irreversible');
  assert.equal(JSON.stringify(action).includes(root), false);
  assert.equal((await provider.preflight(action)).ok, true);
  assert.deepEqual(await provider.inspectCurrent(action), {
    complete: true, postFingerprint: action.sourceFingerprint,
  });
  const outcome = await provider.apply(action);
  assert.equal(outcome.status, 'applied');
  assert.equal((await provider.verify(action, outcome)).ok, true);
  assert.deepEqual(await provider.inspectCurrent(action), {
    complete: true, postFingerprint: outcome.postFingerprint,
  });
  assert.equal((await provider.apply(action)).status, 'unchanged');
});

test('owned storage provider refuses history, partial evidence, traversal, symlinks, and drift', async (t) => {
  const root = fixture(t);
  const cacheRoot = path.join(root, '_npx');
  makeNpxEnv(cacheRoot);
  const exact = cacheCandidate(cacheRoot);
  const partial = { ...cacheCandidate(cacheRoot, 'partial'), bytes: { status: 'measured', value: 1, partial: true } };
  makeNpxEnv(cacheRoot, 'partial');
  const traversal = { ...cacheCandidate(cacheRoot, 'escape'), path: path.join(root, 'outside') };
  makeNpxEnv(root, 'outside');
  const real = makeNpxEnv(cacheRoot, 'real');
  const linkedPath = path.join(cacheRoot, 'linked');
  fs.symlinkSync(real, linkedPath);
  const linked = { ...cacheCandidate(cacheRoot, 'linked'), path: linkedPath };
  const provider = createOwnedNpxCacheProvider({
    candidates: [exact, partial, traversal, linked], root: cacheRoot, baseline: () => '2.0.0',
  });
  const facts = await provider.detect();
  assert.equal(facts.candidates.find((row) => row.resourceId === partial.id).executable, false);
  assert.equal(facts.candidates.find((row) => row.resourceId === traversal.id).executable, false);
  assert.equal(facts.candidates.find((row) => row.resourceId === linked.id).executable, false);
  assert.equal(provider.actionFor({ ...cacheFinding(exact), resource: {
    id: 'aged-transcripts:claude', kind: 'aged-transcripts', host: 'agentic-kit', scope: 'machine',
  } }, facts), null);

  const action = provider.actionFor(cacheFinding(exact), facts);
  fs.writeFileSync(path.join(cacheRoot, 'abc', 'node_modules', 'ruflo', 'package.json'), JSON.stringify({ version: '2.0.0' }));
  assert.equal((await provider.preflight(action)).ok, false);
  assert.equal(fs.existsSync(path.join(cacheRoot, 'abc')), true);
  assert.throws(() => createOwnedNpxCacheProvider({
    root: path.parse(root).root, baseline: () => '2.0.0',
  }), /absolute root/);
});

function orphanFinding(pid) {
  return {
    state: 'orphaned-cache', classification: 'identity-proven-ruflo-mcp-orphan',
    safetyClass: 'approval-required',
    resource: { id: `ruflo-mcp-orphan:${pid}`, kind: 'daemon', host: 'ruflo', scope: 'machine' },
    ownership: { authority: 'live-process-identity', managed: true },
    nextAction: { operation: 'terminate' },
  };
}

test('Ruflo MCP orphan provider rechecks live owner and identity before termination', async () => {
  const uid = 501;
  let current = { uid, pid: 4321, ppid: 1, command: 'ruflo mcp start' };
  let killed = 0;
  const provider = createRufloMcpOrphanProvider({
    uid,
    list: async () => current ? [current] : [],
    reap(rows) {
      assert.equal(rows[0], current);
      killed += 1;
      current = null;
      return [{ ...rows[0], killed: true }];
    },
  });
  const facts = await provider.detect();
  assert.equal(facts.capability.status, 'available');
  const action = provider.actionFor(orphanFinding(4321), facts);
  assert.equal((await provider.preflight(action)).ok, true);
  assert.deepEqual(await provider.inspectCurrent(action), {
    complete: true, postFingerprint: action.sourceFingerprint,
  });
  const outcome = await provider.apply(action);
  assert.equal(outcome.status, 'applied');
  assert.equal(killed, 1);
  assert.equal((await provider.verify(action, outcome)).ok, true);
  assert.deepEqual(await provider.inspectCurrent(action), {
    complete: true, postFingerprint: outcome.postFingerprint,
  });
  assert.equal((await provider.apply(action)).status, 'unchanged');
});

test('daemon provider exposes unsupported identity and refuses live drift without a fake action', async () => {
  const unknownOwner = createRufloMcpOrphanProvider({
    uid: null, list: async () => [{ uid: null, pid: 10, ppid: 1, command: 'ruflo mcp start' }],
  });
  const unsupported = await unknownOwner.detect();
  assert.equal(unsupported.capability.status, 'unsupported');
  assert.equal(unsupported.capability.reason, 'current-user-identity-unavailable');
  assert.equal(unknownOwner.actionFor(orphanFinding(10), unsupported), null);

  let current = { uid: 501, pid: 12, ppid: 1, command: 'ruflo mcp start' };
  let killed = false;
  const provider = createRufloMcpOrphanProvider({
    uid: 501, list: async () => [current],
    reap() { killed = true; return []; },
  });
  const facts = await provider.detect();
  const action = provider.actionFor(orphanFinding(12), facts);
  current = { ...current, command: 'node unrelated.js' };
  const outcome = await provider.apply(action);
  assert.equal(outcome.status, 'refused');
  assert.equal(killed, false);
});

test('exact-owner providers satisfy the shared provider registry without generic capabilities', (t) => {
  const root = fixture(t);
  const providers = [
    createOwnedSkillProvider({ allowedRoots: [], archiveRoot: path.join(root, 'archive') }),
    createOwnedNpxCacheProvider({ candidates: [], root: path.join(root, '_npx'), baseline: () => null }),
    createRufloMcpOrphanProvider({ uid: null, list: async () => [] }),
  ];
  const registry = createMaintenanceProviderRegistry(providers);
  assert.deepEqual([...registry.keys()], [
    'agentic-kit-owned-skill', 'agentic-kit-npx-cache', 'ruflo-mcp-orphan',
  ]);
  assert.equal(providers.some((provider) => provider.operations.includes('shell')), false);
  assert.equal(providers.some((provider) => provider.operations.includes('delete-path')), false);
});
