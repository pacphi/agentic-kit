import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { createMaintenanceProviderRegistry } from '../../src/lib/maintenance/provider-registry.mjs';
import { createClaudePluginProvider } from '../../src/lib/maintenance/providers/claude-plugin.mjs';
import { createCodexPluginProvider } from '../../src/lib/maintenance/providers/codex-plugin.mjs';
import { createCodexMcpProvider } from '../../src/lib/maintenance/providers/codex-mcp.mjs';
import { createMaintenanceService } from '../../src/lib/maintenance/service.mjs';
import { createOwnedNpxCacheProvider } from '../../src/lib/maintenance/providers/owned-storage.mjs';
import { createRufloMcpOrphanProvider } from '../../src/lib/maintenance/providers/ruflo-mcp-orphan.mjs';
import { sha256 } from '../../src/lib/maintenance/providers/shared.mjs';
import {
  createMaintenanceTransaction, writeMaintenanceReceipt,
} from '../../src/lib/maintenance/transaction-store.mjs';

const NOW = Date.parse('2026-09-03T20:00:00.000Z');
const okJson = (value) => ({ ok: true, exitCode: 0, timedOut: false, stdout: JSON.stringify(value), stderr: '' });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-maint-native-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function footprint(items = [], reclaimables = []) {
  return {
    generatedAt: new Date(NOW).toISOString(),
    snapshot: { present: true, asOf: NOW - 1000, stale: false, ageMs: 1000 },
    catalog: {
      asOf: NOW - 1000, complete: true, degraded: [], truncated: [], partial: [],
      sourceStamps: [{ id: 'catalog', value: 'native-source-a' }], items,
    },
    storage: { asOf: NOW - 1000, reclaimables },
  };
}

function serviceFor(t, provider, input = footprint()) {
  return createMaintenanceService({
    collector: { async read() { return input; }, async refreshDeep() { return { ok: true }; } },
    providers: new Map([[provider.id, provider]]),
    now: () => NOW,
    controlRoot: fixture(t),
  });
}

test('Claude joins exact host-native installed and available rows without lexical version inference', async (t) => {
  const calls = [];
  const inventory = {
    installed: [{ pluginId: 'demo@market', version: '9.0.0', scope: 'user', enabled: true }],
    available: [{ pluginId: 'demo@market', version: '1.0.0' }],
  };
  const provider = createClaudePluginProvider({ run: async (binary, args) => {
    calls.push({ binary, args });
    return okJson(inventory);
  } });
  const catalog = [{
    canonicalId: 'plugin:demo@market', kind: 'plugin', name: 'demo@market', pluginRef: 'demo@market',
    components: ['skill:a', 'command:b', 'agent:c'], presence: [],
  }];
  const service = serviceFor(t, provider, footprint(catalog));
  const model = await service.scan();
  const finding = model.findings.find((row) => row.resource.providerRef === 'demo@market');
  assert.equal(finding.state, 'update-available');
  assert.equal(finding.safetyClass, 'approval-required');
  assert.equal(finding.versions.installed, '9.0.0');
  assert.equal(finding.versions.recommended, '1.0.0');
  assert.equal(finding.ownership.authority, 'native-inventory');
  assert.equal(finding.impact.dependencies, 3);
  assert.equal(finding.nextAction.operation, 'update');
  assert.equal(finding.nextAction.executable, true);
  assert.deepEqual(calls[0], { binary: 'claude', args: ['plugin', 'list', '--available', '--json'] });

  const plan = await service.plan({ findingIds: [finding.id], executable: true });
  assert.equal(plan.actions[0].recommendedVersion, '1.0.0');
  assert.equal(plan.actions[0].providerId, 'claude-plugin');
  assert.doesNotMatch(JSON.stringify(model), /latest|command|argv|\/private/i);
});

test('ambiguous native candidates remain visible but cannot produce a Claude action', async (t) => {
  const inventory = {
    installed: [{ id: 'demo@market', version: '1.0.0', scope: 'user', enabled: true }],
    available: [
      { id: 'demo@market', version: '1.1.0' },
      { pluginId: 'demo@market', version: '1.2.0' },
    ],
  };
  const provider = createClaudePluginProvider({ run: async () => okJson(inventory) });
  const service = serviceFor(t, provider);
  const model = await service.scan();
  const finding = model.findings.find((row) => row.resource.providerRef === 'demo@market');
  assert.equal(finding.state, 'ambiguous');
  assert.equal(finding.safetyClass, 'never-automatic');
  await assert.rejects(() => service.plan({ findingIds: [finding.id], executable: true }), /not executable/i);
});

test('Codex reports an exact available candidate as upstream-required and never infers removal', async (t) => {
  const calls = [];
  const inventory = {
    installed: [{ pluginId: 'demo@market', version: '1.0.0', installed: true, enabled: true }],
    available: [{ pluginId: 'demo@market', version: '1.1.0' }],
  };
  const provider = createCodexPluginProvider({ run: async (binary, args) => {
    calls.push({ binary, args }); return okJson(inventory);
  } });
  const model = await serviceFor(t, provider).scan();
  const finding = model.findings.find((row) => row.resource.providerRef === 'demo@market');
  assert.equal(finding.state, 'update-available');
  assert.equal(finding.safetyClass, 'upstream-required');
  assert.equal(finding.nextAction.operation, 'review');
  assert.equal(finding.nextAction.executable, false);
  assert.equal(model.findings.some((row) => row.nextAction.operation === 'remove'), false);
  assert.deepEqual(calls[0], { binary: 'codex', args: ['plugin', 'list', '--available', '--json'] });
});

test('MCP registration alone creates no removal finding', async (t) => {
  const provider = createCodexMcpProvider({ run: async () => okJson([{
    name: 'registered-mcp', enabled: true, transport: { type: 'stdio' }, auth_status: 'authenticated',
  }]) });
  const model = await serviceFor(t, provider).scan();
  assert.equal(model.findings.some((row) => row.resource.kind === 'mcpServer'), false);
});

test('Claude uninstall is exact and fixed but only derives from an explicit lifecycle removal', async (t) => {
  const calls = [];
  const installed = {
    installed: [{ pluginId: 'demo@market', version: '1.0.0', scope: 'project', enabled: false }],
    available: [],
  };
  const absent = { installed: [], available: [] };
  const responses = [okJson(installed), okJson(installed), { ok: true, exitCode: 0, stdout: '', stderr: '' }, okJson(absent)];
  const provider = createClaudePluginProvider({ run: async (binary, args) => {
    calls.push({ binary, args }); return responses.shift();
  } });
  const explicit = [{
    canonicalId: 'plugin:demo@market', kind: 'plugin', name: 'demo@market', components: [],
    lifecycle: { state: 'stale-configuration', operation: 'remove' },
    presence: [{ host: 'claude', scope: 'plugin', plugin: { scope: 'project' },
      provider: { ref: 'demo@market', version: '1.0.0', evidence: { status: 'native' } } }],
  }];
  const service = serviceFor(t, provider, footprint(explicit));
  const model = await service.scan();
  const finding = model.findings.find((row) => row.nextAction.operation === 'remove');
  assert.equal(finding.nextAction.executable, true);
  const plan = await service.plan({ findingIds: [finding.id], executable: true });
  const outcome = await provider.apply(plan.actions[0]);
  assert.equal((await provider.verify(plan.actions[0], outcome)).ok, true);
  assert.deepEqual(calls[2].args, [
    'plugin', 'uninstall', '--scope', 'project', '--keep-data', '--yes', 'demo@market',
  ]);
  assert.equal(provider.limitations.some((row) => row.operation === 'prune' && row.status === 'unsupported'), true);

  const inventoryOnly = serviceFor(t, createClaudePluginProvider({ run: async () => okJson(installed) }));
  assert.equal((await inventoryOnly.scan()).findings.some((row) => row.nextAction.operation === 'remove'), false);
});

test('provider failures collapse into one report-only finding', async (t) => {
  const provider = (id) => ({
    id, version: '1', resourceKinds: ['plugin'], operations: ['review'], rollback: ['irreversible'],
    async detect() { throw new Error(`private failure from ${id}`); },
    actionFor() {}, preflight() {}, apply() {}, verify() {},
  });
  const providers = createMaintenanceProviderRegistry([provider('failed-one'), provider('failed-two')]);
  const service = createMaintenanceService({
    collector: { async read() { return footprint(); } }, providers, now: () => NOW, controlRoot: fixture(t),
  });
  const model = await service.scan();
  const unavailable = model.findings.filter((row) => row.classification === 'provider-evidence-unavailable');
  assert.equal(unavailable.length, 1);
  assert.equal(unavailable[0].safetyClass, 'never-automatic');
  assert.equal(unavailable[0].nextAction.executable, false);
  assert.doesNotMatch(JSON.stringify(unavailable), /private failure/i);
});

test('default wiring promotes only an exact currently stale npx candidate', async (t) => {
  const root = fixture(t);
  const cacheRoot = path.join(root, '_npx');
  const target = path.join(cacheRoot, 'abc');
  fs.mkdirSync(path.join(target, 'node_modules', 'ruflo'), { recursive: true });
  fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ dependencies: { ruflo: '*' } }));
  fs.writeFileSync(path.join(target, 'node_modules', 'ruflo', 'package.json'), JSON.stringify({ version: '1.0.0' }));
  const candidate = {
    id: 'stale-npx-env:abc', kind: 'stale-npx-env', label: 'npx abc', path: target,
    safety: 'regenerable', advisory: true,
    bytes: { status: 'measured', value: 20, partial: false, asOf: NOW - 1000 },
    files: { status: 'measured', value: 2, partial: false, asOf: NOW - 1000 },
  };
  const unavailable = { run: async () => ({ ok: false, exitCode: 1, stdout: '', stderr: '' }) };
  const service = createMaintenanceService({
    collector: { async read() { return footprint([], [candidate]); } }, now: () => NOW,
    controlRoot: path.join(root, 'control'),
    providerOptions: {
      claudePlugin: unavailable, codexPlugin: unavailable, codexMcp: unavailable,
      npxCache: { root: cacheRoot, baseline: () => '2.0.0' },
      rufloMcpOrphan: { uid: null, list: async () => [] },
    },
  });
  const model = await service.scan();
  const finding = model.findings.find((row) => row.resource.id === candidate.id);
  assert.equal(finding.ownership.authority, 'agentic-kit-procedure');
  assert.equal(finding.nextAction.executable, true);
  assert.equal((await service.plan({ findingIds: [finding.id], executable: true })).actions[0].providerId,
    'agentic-kit-npx-cache');

  fs.writeFileSync(path.join(target, 'node_modules', 'ruflo', 'package.json'), JSON.stringify({ version: '2.0.0' }));
  const idle = await service.scan();
  const preserved = idle.findings.find((row) => row.resource.id === candidate.id);
  assert.equal(preserved.ownership.authority, 'system-advisory');
  assert.equal(preserved.nextAction.executable, false);
});

test('complete live Ruflo orphan identity creates an approval-required terminate finding', async (t) => {
  const provider = createRufloMcpOrphanProvider({
    uid: 501,
    list: async () => [{ uid: 501, pid: 4321, ppid: 1, command: 'ruflo mcp start' }],
    classify: (rows) => rows,
  });
  const model = await serviceFor(t, provider).scan();
  const finding = model.findings.find((row) => row.resource.id === 'ruflo-mcp-orphan:4321');
  assert.equal(finding.safetyClass, 'approval-required');
  assert.equal(finding.nextAction.operation, 'terminate');
  assert.equal(finding.nextAction.executable, true);
  assert.doesNotMatch(JSON.stringify(finding), /ruflo mcp start|\bage(?:Ms|d)?\b/i);
});

test('service advertises control capability while read models remain independently read-only', async (t) => {
  const service = createMaintenanceService({
    collector: { async read() { return footprint(); } }, providers: new Map(),
    now: () => NOW, controlRoot: fixture(t),
  });
  const model = await service.scan();
  assert.equal(model.mode, 'control-plane');
  assert.deepEqual(model.capabilities, { plan: true, apply: true, undo: true });
});

test('scan reloads bounded sanitized receipt history and exposes corrupt recovery state without creating roots', async (t) => {
  const controlRoot = fixture(t);
  const transactionsRoot = path.join(controlRoot, 'transactions');
  const transaction = createMaintenanceTransaction(transactionsRoot, {
    now: () => new Date(NOW), nonce: () => 'history',
  });
  writeMaintenanceReceipt(transaction.file, {
    schemaVersion: 'maintenance-receipt/v1', id: transaction.id,
    createdAt: new Date(NOW - 1000).toISOString(), updatedAt: new Date(NOW).toISOString(),
    status: 'committed', planId: 'maintenance-plan-history', planDigest: 'digest',
    sourceFingerprint: 'source', authorization: { mechanism: 'exact-plan-selection', actionIds: ['a'] },
    actions: [{
      actionId: 'a', providerId: 'history-provider', providerVersion: '1', operation: 'archive',
      resourceIdentity: { id: 'skill:demo', kind: 'skill', name: 'demo' },
      classification: 'approval-required', rollback: 'reversible', restart: 'required',
      sourceFingerprint: 'before', state: 'verified',
      outcome: { status: 'applied', postFingerprint: 'after', summary: 'contains private details' },
      verification: { verified: true, postFingerprint: 'after' },
    }], verification: { nativeStateVerified: true, affectedCatalogRefreshed: true },
  });
  const corruptId = 'mnt-20260903T200000000Z-corrupt';
  fs.mkdirSync(path.join(transactionsRoot, corruptId));
  fs.writeFileSync(path.join(transactionsRoot, corruptId, 'receipt.json'), '{not json');
  const provider = {
    id: 'history-provider', version: '1', resourceKinds: ['skill'], operations: ['archive'],
    rollback: ['reversible'], async detect() { return { status: 'available', complete: true, authority: 'native-inventory' }; },
    actionFor() {}, async preflight() {}, async apply() {}, async verify() {},
    async inspectCurrent() { return { postFingerprint: 'after' }; }, async undo() {}, async verifyUndo() {},
  };
  const service = createMaintenanceService({
    collector: { async read() { return footprint(); } }, providers: new Map([[provider.id, provider]]),
    now: () => NOW, controlRoot,
  });
  const model = await service.scan();
  assert.equal(model.receipts.length, 2);
  assert.equal(model.summary.recentChanges, 2);
  assert.equal(model.receipts.find((row) => row.id === transaction.id).undoEligible, true);
  assert.equal(model.receipts.find((row) => row.id === corruptId).recoveryRequired, true);
  assert.doesNotMatch(JSON.stringify(model.receipts), /receiptFile|private details|transactionsRoot|error/i);
  fs.chmodSync(transactionsRoot, 0o755);
  const unsafe = await service.scan();
  assert.equal(unsafe.receipts[0].recoveryRequired, true);
  assert.equal(fs.statSync(transactionsRoot).mode & 0o077, 0o055, 'read-only history must not chmod existing state');

  const absentRoot = path.join(fixture(t), 'absent-control');
  const empty = createMaintenanceService({
    collector: { async read() { return footprint(); } }, providers: new Map(), controlRoot: absentRoot,
  });
  await empty.scan();
  assert.equal(fs.existsSync(absentRoot), false);
});

test('rollback-capable registries require guarded current inspection and verified undo', () => {
  const base = {
    id: 'rollback-provider', version: '1', resourceKinds: ['skill'], operations: ['archive'],
    detect() {}, actionFor() {}, preflight() {}, apply() {}, verify() {}, undo() {}, verifyUndo() {},
  };
  assert.throws(() => createMaintenanceProviderRegistry([{ ...base, rollback: ['reversible'] }]), /inspectCurrent/i);
  assert.throws(() => createMaintenanceProviderRegistry([{ ...base, rollback: ['compensating'] }]), /inspectCurrent/i);
  assert.doesNotThrow(() => createMaintenanceProviderRegistry([{
    ...base, rollback: ['compensating'], inspectCurrent() {},
  }]));
});

test('owner-sensitive providers fail closed when the current user identity is unavailable', async (t) => {
  const root = fixture(t);
  const cacheRoot = path.join(root, '_npx');
  const target = path.join(cacheRoot, 'abc');
  fs.mkdirSync(path.join(target, 'node_modules', 'ruflo'), { recursive: true });
  fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ dependencies: { ruflo: '*' } }));
  fs.writeFileSync(path.join(target, 'node_modules', 'ruflo', 'package.json'), JSON.stringify({ version: '1.0.0' }));
  const provider = createOwnedNpxCacheProvider({
    candidates: [{ id: 'stale-npx-env:abc', kind: 'stale-npx-env', path: target,
      safety: 'regenerable', advisory: true,
      bytes: { status: 'measured', value: 1, partial: false },
      files: { status: 'measured', value: 1, partial: false } }],
    root: cacheRoot, baseline: () => '2.0.0', currentUid: null,
  });
  assert.equal((await provider.detect()).candidates[0].status, 'unsupported');
});

test('explicit complete-tree ownership wiring archives and exposes guarded undo after reload', async (t) => {
  const root = fixture(t);
  const allowedRoot = path.join(root, 'skills');
  const target = path.join(allowedRoot, 'demo');
  const skillFile = path.join(target, 'SKILL.md');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(skillFile, '# demo\n');
  const stat = fs.lstatSync(skillFile);
  const entries = [{ path: 'SKILL.md', kind: 'file', mode: stat.mode & 0o777,
    size: stat.size, digest: createHash('sha256').update(fs.readFileSync(skillFile)).digest('hex') }];
  const receipt = {
    schemaVersion: 'agentic-kit.skill-tree-ownership/v1', id: 'skill-receipt-demo',
    owner: 'agentic-kit', resourceId: 'skill:project:demo', scope: 'project',
    sourceKind: 'projected', desired: false, root: target, allowedRoot,
    manifest: { complete: true, entries, digest: sha256(entries) },
  };
  const unavailable = { run: async () => ({ ok: false, exitCode: 1, stdout: '', stderr: '' }) };
  const collector = {
    async read() { return footprint(); },
    async refreshDeep() { return { ok: true }; },
  };
  const service = createMaintenanceService({
    collector, now: () => NOW, controlRoot: path.join(root, 'control'),
    providerOptions: {
      claudePlugin: unavailable, codexPlugin: unavailable, codexMcp: unavailable,
      rufloMcpOrphan: { uid: null, list: async () => [] },
      ownedSkill: { receipts: [receipt], allowedRoots: [allowedRoot], archiveRoot: path.join(root, 'archive') },
    },
  });
  const model = await service.scan();
  const finding = model.findings.find((row) => row.resource.id === receipt.resourceId);
  assert.equal(finding.nextAction.executable, true);
  const plan = await service.plan({ findingIds: [finding.id], executable: true });
  const applied = await service.apply({
    plan, actionIds: [plan.actions[0].id], expectedPlanDigest: plan.planDigest, confirmed: true,
  });
  assert.equal(applied.status, 'committed');
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(await service.prepareUndo({ receiptId: applied.receiptId }), {
    receiptId: applied.receiptId, undoable: true, actionCount: 1,
    summary: '1 maintenance action(s) can be safely undone.',
  });
  const reloaded = await service.scan();
  assert.equal(reloaded.receipts.find((row) => row.id === applied.receiptId).undoEligible, true);
});
