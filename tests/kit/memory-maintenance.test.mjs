// Ruflo's memory backup and distillation evidence, read from what Ruflo itself
// writes: the daemon's .claude-flow/metrics/{backup,consolidation}.json and the
// memory-<ISO>.db snapshots in .swarm/backups (worker-daemon.js 1523-1640,
// memory-backup.js 36-41, 3.45.0). Read-only; nothing here starts a daemon.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BACKUP_STALE_MS, memoryMaintenanceStatus } from '../../src/lib/memory-maintenance.mjs';
import { projectDaemonAlive, rufloAutostartOff } from '../../src/lib/daemons.mjs';

const NOW = Date.parse('2026-09-26T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-memory-maint-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function metric(root, name, value) {
  const dir = path.join(root, '.claude-flow', 'metrics');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));
}

function snapshot(root, relativeDir, atMs) {
  const dir = path.join(root, ...relativeDir.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `memory-${new Date(atMs).toISOString().replace(/[:.]/g, '-')}.db`);
  fs.writeFileSync(file, 'snapshot');
  fs.utimesSync(file, new Date(atMs), new Date(atMs));
  return file;
}

test('no metrics and no snapshots: nothing recorded, and that counts as stale', (t) => {
  const status = memoryMaintenanceStatus(project(t), { now: NOW });
  assert.deepEqual(status.backup, { lastAt: null, ageMs: null, stale: true, failed: null });
  assert.equal(status.distillation, null);
  assert.equal(status.mcpStoreBackup, null);
});

test("the daemon's backup record gives the last backup age, fresh within 48 hours", (t) => {
  const root = project(t);
  metric(root, 'backup.json', { timestamp: new Date(NOW - 5 * HOUR).toISOString(), backedUp: true, path: 'x', sizeBytes: 1 });
  const { backup } = memoryMaintenanceStatus(root, { now: NOW });
  assert.equal(backup.ageMs, 5 * HOUR);
  assert.equal(backup.stale, false);
  assert.equal(backup.failed, null);
  assert.equal(BACKUP_STALE_MS, 48 * HOUR, 'twice the 24 h worker interval');
});

test('a manual `ruflo memory backup` snapshot counts too, whichever is newer wins', (t) => {
  const root = project(t);
  metric(root, 'backup.json', { timestamp: new Date(NOW - 16 * 24 * HOUR).toISOString(), backedUp: true });
  snapshot(root, '.swarm/backups', NOW - 2 * HOUR);
  const { backup } = memoryMaintenanceStatus(root, { now: NOW });
  assert.equal(backup.ageMs, 2 * HOUR);
  assert.equal(backup.stale, false);
});

test('snapshots in a subfolder of .swarm/backups are not memory.db backups', (t) => {
  const root = project(t);
  snapshot(root, '.swarm/backups/pre-test-row-cleanup-2026-09-26', NOW - HOUR);
  fs.writeFileSync(path.join(root, '.swarm', 'backups', 'notes.txt'), 'x');
  assert.equal(memoryMaintenanceStatus(root, { now: NOW }).backup.lastAt, null);
});

test('a stale backup is flagged after 48 hours', (t) => {
  const root = project(t);
  metric(root, 'backup.json', { timestamp: new Date(NOW - 16 * 24 * HOUR).toISOString(), backedUp: true });
  const { backup } = memoryMaintenanceStatus(root, { now: NOW });
  assert.equal(backup.stale, true);
  assert.equal(backup.ageMs, 16 * 24 * HOUR);
});

test('a failed latest attempt is reported with its reason; a no-db skip is not a failure', (t) => {
  const root = project(t);
  snapshot(root, '.swarm/backups', NOW - 30 * HOUR);
  metric(root, 'backup.json', { timestamp: new Date(NOW - HOUR).toISOString(), backedUp: false, error: 'EACCES: permission denied\n  at open' });
  const failed = memoryMaintenanceStatus(root, { now: NOW }).backup;
  assert.equal(failed.failed.at, NOW - HOUR);
  assert.equal(failed.failed.reason, 'EACCES: permission denied at open', 'whitespace collapsed to one line');
  assert.equal(failed.ageMs, 30 * HOUR, 'the last good backup is still reported');

  metric(root, 'backup.json', { timestamp: new Date(NOW - HOUR).toISOString(), backedUp: false, skipped: 'no-db' });
  assert.equal(memoryMaintenanceStatus(root, { now: NOW }).backup.failed, null);

  metric(root, 'backup.json', { timestamp: new Date(NOW - 40 * HOUR).toISOString(), backedUp: false, skipped: 'backup failed: busy' });
  assert.equal(memoryMaintenanceStatus(root, { now: NOW }).backup.failed, null, 'a failure older than the last good backup is history');
});

test('distillation age, disabled distillation and a failed or corrupt run are told apart', (t) => {
  const root = project(t);
  metric(root, 'consolidation.json', { timestamp: new Date(NOW - 15 * 24 * HOUR).toISOString(), distillationEnabled: true, corrupt: false });
  assert.deepEqual(memoryMaintenanceStatus(root, { now: NOW }).distillation,
    { ageMs: 15 * 24 * HOUR, enabled: true, failed: null });
  metric(root, 'consolidation.json', { timestamp: new Date(NOW - HOUR).toISOString(), distillationEnabled: false, note: 'off' });
  assert.equal(memoryMaintenanceStatus(root, { now: NOW }).distillation.enabled, false);
  metric(root, 'consolidation.json', { timestamp: new Date(NOW - HOUR).toISOString(), distillationEnabled: true, error: 'boom' });
  assert.equal(memoryMaintenanceStatus(root, { now: NOW }).distillation.failed, 'boom');
  metric(root, 'consolidation.json', { timestamp: new Date(NOW - HOUR).toISOString(), distillationEnabled: true, corrupt: true, skipped: 'malformed' });
  assert.match(memoryMaintenanceStatus(root, { now: NOW }).distillation.failed, /corrupt/);
});

test('malformed, oversized or timestamp-less metrics are treated as absent, never thrown', (t) => {
  const root = project(t);
  metric(root, 'backup.json', '{not json');
  metric(root, 'consolidation.json', { distillationEnabled: true });
  const status = memoryMaintenanceStatus(root, { now: NOW });
  assert.equal(status.backup.lastAt, null);
  assert.equal(status.distillation, null);
  metric(root, 'backup.json', `{"timestamp":"${new Date(NOW).toISOString()}","backedUp":true,"pad":"${'x'.repeat(1_100_000)}"}`);
  assert.equal(memoryMaintenanceStatus(root, { now: NOW }).backup.lastAt, null);
});

test('a manual MCP-store backup in .swarm/backups/agentdb is reported separately', (t) => {
  const root = project(t);
  snapshot(root, '.swarm/backups/agentdb', NOW - 3 * HOUR);
  const status = memoryMaintenanceStatus(root, { now: NOW });
  assert.deepEqual(status.mcpStoreBackup, { ageMs: 3 * HOUR });
  assert.equal(status.backup.lastAt, null, 'it is not a memory.db backup');
});

test("projectDaemonAlive reads Ruflo's pidfile and checks the process", (t) => {
  const root = project(t);
  assert.equal(projectDaemonAlive(root), false);
  fs.mkdirSync(path.join(root, '.claude-flow'));
  fs.writeFileSync(path.join(root, '.claude-flow', 'daemon.pid'), String(process.pid));
  assert.equal(projectDaemonAlive(root), true);
  fs.writeFileSync(path.join(root, '.claude-flow', 'daemon.pid'), '0');
  assert.equal(projectDaemonAlive(root), false, 'pid 0 would signal the process group');
  fs.writeFileSync(path.join(root, '.claude-flow', 'daemon.pid'), 'garbage');
  assert.equal(projectDaemonAlive(root), false);
});

test("rufloAutostartOff names the setting that stops Ruflo starting the daemon on use", (t) => {
  const root = project(t);
  assert.equal(rufloAutostartOff(root, {}), null);
  assert.match(rufloAutostartOff(root, { RUFLO_DAEMON_AUTOSTART: 'off' }), /RUFLO_DAEMON_AUTOSTART/);
  assert.equal(rufloAutostartOff(root, { RUFLO_DAEMON_AUTOSTART: '1' }), null);
  fs.mkdirSync(path.join(root, '.claude'));
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify({ claudeFlow: { daemon: { autoStart: false } } }));
  assert.equal(rufloAutostartOff(root, {}), '.claude/settings.json claudeFlow.daemon.autoStart: false');
  fs.writeFileSync(path.join(root, 'claude-flow.config.json'), JSON.stringify({ daemon: { autostart: false } }));
  assert.equal(rufloAutostartOff(root, {}), 'claude-flow.config.json daemon.autostart: false');
  fs.writeFileSync(path.join(root, 'claude-flow.config.json'), '{broken');
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify({ claudeFlow: { daemon: { autoStart: true } } }));
  assert.equal(rufloAutostartOff(root, {}), null, 'true or unreadable config says nothing');
});
