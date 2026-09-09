import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContextReport } from '../../src/lib/context-report.mjs';

const now = Date.parse('2026-09-09T14:00:00Z');
const cfg = { integrations: { hosts: { claude: true, codex: true, opencode: true } } };
const status = { available: true, owned: false, configuredWindow: 872000,
  autoCompactTokenLimit: 150000, observedAt: new Date(now).toISOString(),
  cacheFetchedAt: '2026-09-08T14:00:00Z', models: [
    { model: 'large', nativeWindow: 272000, maximumWindow: 872000,
      requestedWindow: 872000, allocatedWindow: 872000, effectivePercent: 95, effectiveWindow: 828400 },
    { model: 'small', nativeWindow: 272000, maximumWindow: 272000,
      requestedWindow: 872000, allocatedWindow: 272000, effectivePercent: 95, effectiveWindow: 258400 },
  ] };

test('configured catalog values never become a verified active-session window', () => {
  const host = buildContextReport(cfg, status, { now }).hosts[1];
  assert.equal(host.effectiveWindow, null);
  assert.equal(host.modelCapacity, null);
  assert.equal(host.usage, null);
  assert.equal(host.runtimeVerified, false);
  assert.equal(host.models[1].effectiveWindow, 258400);
  assert.equal(host.configuredRequest, 872000);
});

test('unmanaged Codex retains catalog evidence with original freshness', () => {
  const host = buildContextReport(cfg, status, { now }).hosts[1];
  assert.equal(host.managed, false);
  assert.equal(host.models.length, 2);
  assert.equal(host.cacheFetchedAt, status.cacheFetchedAt);
  assert.equal(host.observedAt, status.observedAt);
});

test('compaction scalar is distinct from verified threshold and scope', () => {
  const host = buildContextReport(cfg, status, { now }).hosts[1];
  assert.deepEqual(host.compaction, { configuredThreshold: 150000, scope: 'unverified',
    runtimeThreshold: null, control: 'user-owned' });
});

test('other hosts preserve unknown values and distinguish unsupported inspection', () => {
  const hosts = buildContextReport(cfg, status, { now }).hosts.filter(h => h.host !== 'codex');
  assert.deepEqual(hosts.map(h => [h.host, h.state, h.usage, h.compaction.control]), [
    ['claude', 'not-inspected', null, 'not-inspected'],
    ['opencode', 'not-inspected', null, 'not-inspected'],
  ]);
});

test('unavailable evidence cannot leak cached values into the current report', () => {
  const host = buildContextReport(cfg, { ...status, available: false, reason: 'stale cache' }, { now }).hosts[1];
  assert.equal(host.configuredRequest, null);
  assert.deepEqual(host.models, []);
  assert.equal(host.state, 'unavailable');
  assert.ok(host.limitations.includes('stale cache'));
});

test('disabled hosts are omitted except retained Codex ownership', () => {
  assert.deepEqual(buildContextReport({}, null, { now }).hosts, []);
  const report = buildContextReport({ codexContext: {} }, status, { now });
  assert.equal(report.hosts.length, 1);
  assert.equal(report.hosts[0].enabled, false);
});

test('fallback section reports enabled non-Codex hosts without duplicate reports', async () => {
  const section = (await import('../../src/commands/status/sections/context.mjs')).default;
  assert.deepEqual(await section.collect({ cfg }), []);
  const rows = await section.collect({ cfg: { integrations: { hosts: { claude: true } } } });
  assert.equal(rows[0].contextReport.hosts[0].host, 'claude');
  assert.deepEqual(await section.collect({ cfg: {} }), []);
});
