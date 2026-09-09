import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGuidanceInventory, recommendationEntries } from '../../src/lib/maintenance/management/guidance-purpose.mjs';
import { guidanceCoverage } from '../../src/lib/maintenance/management/guidance-coverage.mjs';
import { publicGuidance } from '../../src/lib/dashboard/maintenance-api.mjs';

const optional = { guidanceId: 'old-action', placementId: 'codex', lane: 'apply', providerCapabilityId: 'codex-mcp:v1:remove', verb: 'remove' };
function inventory() {
  return { placements: [
    { placementId: 'codex', consumerHosts: ['codex'], guidanceLane: 'apply' },
    { placementId: 'shared', consumerHosts: ['claude', 'opencode', 'opencode'], guidanceLane: 'steps' },
  ], guidanceEntries: [optional, { guidanceId: 'missing-command', placementId: 'shared', lane: 'steps' }] };
}
test('old snapshots retain exact optional action identities without recommendation badges', () => {
  const old = inventory();
  const current = normalizeGuidanceInventory(old);
  assert.equal(old.placements[0].guidanceLane, 'apply');
  assert.equal(current.placements[0].guidanceLane, null);
  assert.equal(current.guidanceEntries[0].guidanceId, 'old-action');
  assert.equal(current.guidanceEntries[0].purpose, 'optional-management');
  assert.deepEqual(recommendationEntries(current.guidanceEntries).map(e => e.guidanceId), ['missing-command']);
  assert.equal(normalizeGuidanceInventory(current), current);
});
test('an unknown provider is not silently classified as an optional action', () => {
  const entry = { lane: 'apply', placementId: 'other' };
  assert.deepEqual(recommendationEntries([entry]), [entry]);
});
test('a real recommendation on an optional-action placement retains its lane', () => {
  const old = inventory();
  old.guidanceEntries.push({ placementId: 'codex', lane: 'decision' });
  assert.equal(normalizeGuidanceInventory(old).placements[0].guidanceLane, 'decision');
});
test('coverage distinguishes measured hosts, shared recommendations, and limited adapters', () => {
  const providers = new Map([
    ['claude-plugin', { id: 'claude-plugin', host: 'claude', resourceKinds: ['plugin'] }],
    ['codex-mcp', { id: 'codex-mcp', host: 'codex', resourceKinds: ['mcp-registration'] }],
  ]);
  const coverage = guidanceCoverage(inventory(), providers, new Map([
    ['claude-plugin', { status: 'available', complete: true }],
    ['codex-mcp', { status: 'available', complete: false }],
  ]));
  const byHost = Object.fromEntries(coverage.map(row => [row.host, row]));
  assert.equal(byHost.claude.actionStatus, 'checked');
  assert.deepEqual(byHost.claude.actionKinds, ['plugin']);
  assert.equal(byHost.codex.actionStatus, 'incomplete');
  assert.equal(byHost.codex.recommendations, 0);
  assert.equal(byHost.codex.optionalActions, 1);
  assert.equal(byHost.opencode.actionStatus, 'unsupported');
  assert.equal(byHost.opencode.placements, 1);
  assert.equal(byHost.opencode.recommendations, 1);
  assert.deepEqual(publicGuidance({ coverage }).coverage, coverage);
});
test('legacy coverage with no adapter checks makes no availability claim', () => {
  assert.ok(guidanceCoverage(inventory()).every(row => row.actionStatus === 'not-checked'));
});
test('detected host adapters remain visible even without any consumer installations', () => {
  const evidence = { placements: [{ placementId: 'host', kind: 'host-adapter', hostNamespace: 'hermes', consumerHosts: [] }], guidanceEntries: [] };
  assert.equal(guidanceCoverage(evidence)[0].host, 'hermes');
  assert.equal(guidanceCoverage(evidence)[0].actionStatus, 'not-checked');
});
