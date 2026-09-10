import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandboxHome, sandboxProject } from './helpers/home-sandbox.mjs';
const sandbox = sandboxHome('ak-maintenance-alignment');
const project = sandboxProject('ak-maintenance-alignment');
const { buildManagementInventory } = await import('../../src/lib/maintenance/management/projection.mjs');
const { runInventoryQuery } = await import('../../src/lib/maintenance/management/query.mjs');
const KEY = 'host-alignment-ui-test-key';

const entry = (id, scope, projectPath = null) => ({ id, host: 'claude', scope, project: projectPath,
  file: projectPath ? path.join(projectPath, '.mcp.json') : path.join(sandbox, '.claude.json'),
  name: 'Host alignment: codex', message: 'Retired Codex transport', repairable: true,
  code: 'retired-codex-mcp', sourceFingerprint: 'a'.repeat(64) });

test('host-alignment findings appear in distinct User and Project filtered views without leaking paths', () => {
  const { inventory } = buildManagementInventory({ installationKey: KEY, environment: { platform: process.platform },
    discovery: { hostAlignment: { entries: [entry('align-user', 'user'), entry('align-project', 'project', project)] } },
  });
  const user = runInventoryQuery(inventory, { scope: 'user', view: 'host-alignment' });
  const projects = runInventoryQuery(inventory, { scope: 'project', view: 'host-alignment' });
  assert.equal(user.total, 1);
  assert.equal(projects.total, 1);
  assert.ok(inventory.placements.find(p => p.administrativeScope === 'project').projectId);
  assert.equal(JSON.stringify(inventory).includes(sandbox), false);
  assert.equal(JSON.stringify(inventory).includes(project), false);
});

test('Maintenance preview/apply corrects only the selected registration, even when two share a config', async () => {
  const file = path.join(sandbox, '.claude.json');
  const legacy = { command: 'codex', args: ['mcp-server'] };
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { first: legacy, second: legacy } }));
  const { createHostAlignmentProvider } = await import('../../src/lib/maintenance/providers/host-alignment.mjs');
  const provider = createHostAlignmentProvider({ home: sandbox, projectRoots: [project] });
  const facts = await provider.detect();
  const finding = provider.findings(facts).find(f => f.resource.name.includes('first'));
  const action = provider.actionFor(finding, facts);
  assert.ok(action);
  assert.equal((await provider.preflight(action)).ok, true);
  const outcome = await provider.apply(action);
  assert.equal(outcome.status, 'applied');
  assert.equal((await provider.verify(action, outcome)).ok, true);
  const after = JSON.parse(fs.readFileSync(file));
  assert.deepEqual(after.mcpServers, { second: legacy });
  assert.equal((await provider.detect()).entries.length, 1);
});

test('a stale Maintenance action cannot remove a changed registration', async () => {
  const file = path.join(sandbox, '.claude.json');
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { old: { command: 'codex', args: ['mcp-server'] } } }));
  const { createHostAlignmentProvider } = await import('../../src/lib/maintenance/providers/host-alignment.mjs');
  const provider = createHostAlignmentProvider({ home: sandbox, projectRoots: [] });
  const facts = await provider.detect();
  const action = provider.actionFor(provider.findings(facts)[0], facts);
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { old: { type: 'http', url: 'https://example.com/mcp' } } }));
  const source = fs.readFileSync(file, 'utf8');
  assert.equal((await provider.preflight(action)).ok, false);
  assert.equal((await provider.apply(action)).status, 'unknown');
  assert.equal(fs.readFileSync(file, 'utf8'), source);
});

test('an unassessed project configuration remains visible and cannot receive an apply action', async () => {
  fs.writeFileSync(path.join(project, '.mcp.json'), '{ broken');
  const { createHostAlignmentProvider } = await import('../../src/lib/maintenance/providers/host-alignment.mjs');
  const provider = createHostAlignmentProvider({ home: sandbox, projectRoots: [project] });
  const facts = await provider.detect();
  const { inventory } = buildManagementInventory({ installationKey: KEY, environment: { platform: process.platform },
    discovery: { hostAlignment: facts } });
  const row = inventory.placements.find(p => p.administrativeScope === 'project');
  assert.ok(row.projectId);
  assert.ok(row.conditions.includes('source-scan-incomplete'));
  assert.equal(provider.actionFor(provider.findings(facts)[0], facts), null);
  fs.writeFileSync(path.join(project, '.mcp.json'), '{}');
});

test('Maintenance transaction requires confirmation and records a verified one-registration correction', {
  skip: process.platform === 'win32' ? 'existing Maintenance durable mutation backend is POSIX-only' : false,
}, async () => {
  const file = path.join(sandbox, '.claude.json');
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { old: { command: 'codex', args: ['mcp-server'] } } }));
  const { createHostAlignmentProvider } = await import('../../src/lib/maintenance/providers/host-alignment.mjs');
  const { createMaintenanceService } = await import('../../src/lib/maintenance/service.mjs');
  const provider = createHostAlignmentProvider({ home: sandbox, projectRoots: [project] });
  const now = Date.now();
  const footprint = { generatedAt: new Date(now).toISOString(), snapshot: { present: true, asOf: now, stale: false, ageMs: 0 },
    catalog: { asOf: now, complete: true, degraded: [], truncated: [], partial: [], sourceStamps: [], items: [] },
    storage: { asOf: now, reclaimables: [] } };
  const service = createMaintenanceService({ providers: new Map([[provider.id, provider]]),
    collector: { read: async () => footprint, isScanning: () => false, refreshDeep: async () => ({ ok: true, persisted: { ok: true } }) },
    controlRoot: path.join(sandbox, 'control'), now: () => now });
  const report = await service.scan();
  const finding = report.findings.find(f => f.nextAction.providerId === 'host-alignment');
  const plan = await service.plan({ findingIds: [finding.id], executable: true });
  await assert.rejects(() => service.apply({ plan, actionIds: [plan.actions[0].id], expectedPlanDigest: plan.planDigest }), /confirmation/i);
  const result = await service.apply({ plan, actionIds: [plan.actions[0].id], expectedPlanDigest: plan.planDigest, confirmed: true });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.receipt.actions[0].verification.verified, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).mcpServers, {});
});
