import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scanMaintenanceFindings } from '../../src/lib/maintenance/scanner.mjs';
import {
  assertMaintenancePlanIntegrity,
  buildMaintenancePlan,
} from '../../src/lib/maintenance/planner.mjs';

const NOW = Date.parse('2026-09-03T12:00:00.000Z');

function footprint() {
  return {
    generatedAt: new Date(NOW).toISOString(),
    snapshot: { present: true, asOf: NOW - 60_000, stale: false, ageMs: 60_000 },
    catalog: {
      asOf: NOW - 60_000,
      complete: true,
      sourceStamps: [{ id: 'codex-native', value: 'inventory-a' }],
      items: [{
        canonicalId: 'plugin:codex:demo@market',
        kind: 'plugin',
        name: 'demo@market',
        presence: [{
          host: 'codex', scope: 'plugin', path: '/private/plugin-cache/demo',
          provider: {
            ref: 'demo@market', version: '1.2.3', cacheGeneration: 'generation-a',
            evidence: { status: 'native', token: 'do-not-project' },
          },
          digest: { status: 'measured', value: 'sha256-demo', partial: false, asOf: NOW - 60_000 },
        }],
      }],
    },
    storage: {
      asOf: NOW - 60_000,
      reclaimables: [{
        id: 'cache:demo', kind: 'regenerable-cache', label: 'Demo download cache',
        path: '/private/cache/demo', samplePaths: ['/private/cache/demo/a'],
        bytes: { status: 'measured', value: 4096, partial: false, asOf: NOW - 60_000 },
        files: { status: 'measured', value: 3, partial: false, asOf: NOW - 60_000 },
        safety: 'regenerable', advisory: true,
        rationale: 'Owner can reproduce these downloaded artifacts.',
        cleanupHint: 'rm -rf /private/cache/demo',
      }],
    },
  };
}

test('scanner projects evidence-backed findings without content, credentials, paths, or commands', () => {
  const result = scanMaintenanceFindings({ footprint: footprint(), now: () => NOW });
  const cache = result.findings.find((finding) => finding.resource.id === 'cache:demo');

  assert.equal(cache.state, 'orphaned-cache');
  assert.equal(cache.bucket, 'safeCleanup');
  assert.equal(cache.safetyClass, 'safe-automatic');
  assert.equal(cache.evidence.completeness, 'complete');
  assert.equal(cache.nextAction.operation, 'clean');
  assert.equal(cache.nextAction.executable, false);

  const wire = JSON.stringify(result);
  assert.doesNotMatch(wire, /\/private\//);
  assert.doesNotMatch(wire, /rm -rf/);
  assert.doesNotMatch(wire, /do-not-project/);
  assert.doesNotMatch(wire, /cleanupHint|samplePaths|token/);
});

test('carried-forward measurements retain their original freshness instead of becoming unreadable', () => {
  const input = footprint();
  input.storage.reclaimables[0].bytes.status = 'carried-forward';
  input.storage.reclaimables[0].files.status = 'carried-forward';

  const { findings } = scanMaintenanceFindings({ footprint: input, now: () => NOW });
  const cache = findings.find((finding) => finding.resource.id === 'cache:demo');
  assert.equal(cache.evidence.completeness, 'complete');
  assert.equal(cache.bucket, 'safeCleanup');
});

test('age and absence of observed usage remain review evidence, never action authority', () => {
  const input = footprint();
  input.storage.reclaimables = [{
    id: 'history:old', kind: 'aged-transcripts', label: 'Old transcripts',
    path: '/private/history',
    bytes: { status: 'measured', value: 99, partial: false, asOf: NOW },
    files: { status: 'measured', value: 2, partial: false, asOf: NOW },
    safety: 'review', advisory: true,
    rationale: 'No activity was observed for 90 days.', cleanupHint: null,
  }];

  const { findings } = scanMaintenanceFindings({ footprint: input, now: () => NOW });
  const history = findings.find((finding) => finding.resource.id === 'history:old');
  assert.equal(history.bucket, 'needsReview');
  assert.equal(history.safetyClass, 'approval-required');
  assert.equal(history.observedUsage.status, 'not-proof-of-disuse');
  assert.equal(history.nextAction.executable, false);
  assert.doesNotMatch(history.nextAction.label, /delete|remove/i);
});

test('explicit lifecycle evidence keeps version axes separate and never promotes latest to recommended', () => {
  const input = footprint();
  input.catalog.items[0].lifecycle = {
    state: 'update-available', latestVersion: '9.9.9', sourceRevision: 'market-42',
  };

  const { findings } = scanMaintenanceFindings({ footprint: input, now: () => NOW });
  const plugin = findings.find((finding) => finding.resource.id === 'plugin:codex:demo@market');
  assert.equal(plugin.bucket, 'updatesReady');
  assert.equal(plugin.versions.installed, '1.2.3');
  assert.equal(plugin.versions.producer, '1.2.3');
  assert.equal(plugin.versions.recommended, null, 'latest is not automatically recommended');
  assert.equal(plugin.versions.sourceRevision, 'market-42');
  assert.equal(plugin.ownership.owner, 'demo@market');
  assert.equal(plugin.nextAction.executable, false);
});

test('partial or unreadable evidence cannot produce a safe cleanup classification', () => {
  const input = footprint();
  input.storage.reclaimables[0].bytes.partial = true;
  input.catalog.complete = false;
  input.catalog.degraded = ['codex-plugins'];

  const { findings } = scanMaintenanceFindings({ footprint: input, now: () => NOW });
  const cache = findings.find((finding) => finding.resource.id === 'cache:demo');
  assert.equal(cache.state, 'unreadable-partial');
  assert.equal(cache.bucket, 'needsReview');
  assert.equal(cache.safetyClass, 'never-automatic');
  assert.equal(cache.evidence.completeness, 'partial');
});

test('one incomplete source becomes one evidence finding instead of per-resource sprawl', () => {
  const input = footprint();
  input.storage.reclaimables = [];
  input.catalog.complete = false;
  input.catalog.degraded = ['codex-plugins'];
  input.catalog.items = Array.from({ length: 40 }, (_, index) => ({
    canonicalId: `skill:${index}`, kind: 'skill', name: `skill-${index}`,
    digestCoverage: { measured: 0, unknown: 1, unique: 0, partial: true },
    presence: [{ host: 'codex', scope: 'user' }],
  }));

  const { findings } = scanMaintenanceFindings({ footprint: input, now: () => NOW });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].classification, 'system-evidence-incomplete');
});

test('cross-project revision diversity is context, not hundreds of maintenance actions', () => {
  const input = footprint();
  input.storage.reclaimables = [];
  input.catalog.items = Array.from({ length: 40 }, (_, index) => ({
    canonicalId: `skill:${index}`, kind: 'skill', name: `skill-${index}`,
    variantCount: 2, sourceScopes: ['project'],
    presence: [
      { host: 'codex', scope: 'project', project: `/projects/a-${index}` },
      { host: 'codex', scope: 'project', project: `/projects/b-${index}` },
    ],
  }));

  const { findings } = scanMaintenanceFindings({ footprint: input, now: () => NOW });
  assert.deepEqual(findings, []);
});

test('project and shared resources become one relationship finding per human decision', () => {
  const input = footprint();
  input.storage.reclaimables = [];
  const digest = (value) => ({ status: 'measured', value, partial: false, asOf: NOW });
  const observed = (value) => ({ digest: digest(value), definition: digest(value) });
  input.catalog.items = [{
    canonicalId: 'skill:shared', kind: 'skill', name: 'shared', capabilityName: 'shared',
    presence: [
      { host: 'codex', scope: 'user', sourceFile: '/private/user/shared/SKILL.md',
        ...observed('same'), definition: { ...digest('same'), status: 'carried-forward' } },
      { host: 'codex', scope: 'project', project: '/private/project-a', sourceFile: '/private/project-a/.agents/skills/shared/SKILL.md',
        ...observed('same'), tracking: { repository: true, tracked: false, workingTree: 'clean' } },
    ],
  }, {
    canonicalId: 'skill:project-mode', kind: 'skill', name: 'project-mode', capabilityName: 'project-mode',
    presence: [
      { host: 'claude', scope: 'user', sourceFile: '/private/user/project-mode/SKILL.md', ...observed('user') },
      { host: 'claude', scope: 'project', project: '/private/project-b', sourceFile: '/private/project-b/.claude/skills/project-mode/SKILL.md',
        ...observed('project'), tracking: { repository: true, tracked: false, workingTree: 'clean' } },
    ],
  }, {
    canonicalId: 'agent:reviewer', kind: 'agent', name: 'reviewer', capabilityName: 'reviewer',
    presence: [
      { host: 'claude', scope: 'plugin', sourceFile: '/private/plugin/agents/reviewer.md',
        provider: { ref: 'review-tools@market' }, ...observed('agent-same') },
      { host: 'claude', scope: 'project', project: '/private/project-c', sourceFile: '/private/project-c/.claude/agents/reviewer.md',
        ...observed('agent-same'), tracking: { repository: true, tracked: true, workingTree: 'clean' } },
    ],
  }, {
    canonicalId: 'mcpServer:claude-flow', kind: 'mcpServer', name: 'claude-flow', capabilityName: 'claude-flow',
    presence: [{ host: 'claude', scope: 'user', sourceFile: '/private/user/.claude.json', ...observed('ruflo-transport') }],
  }, {
    canonicalId: 'mcpServer:ruflo', kind: 'mcpServer', name: 'ruflo', capabilityName: 'ruflo',
    presence: [{ host: 'claude', scope: 'project', project: '/private/project-d', sourceFile: '/private/project-d/.mcp.json',
      ...observed('ruflo-transport'), tracking: { repository: true, tracked: false, workingTree: 'clean' } }],
  }];

  const { findings } = scanMaintenanceFindings({ footprint: input, now: () => NOW });
  const relationships = findings.filter((finding) => finding.relationship);
  assert.deepEqual(relationships.map((finding) => finding.classification).sort(), [
    'legacy-equivalent-transport',
    'redundant-project-override',
    'same-name-different-definition',
    'tracked-source-copy',
  ]);
  assert.equal(relationships.every((finding) => finding.nextAction.executable === false), true);
  assert.equal(relationships.every((finding) => finding.bucket === 'needsReview'), true);
  assert.equal(relationships.every((finding) => finding.relationship.memberCount === 2), true);
  assert.equal(relationships.every((finding) => finding.nextAction.recommendation
    && finding.nextAction.steps.length >= 2 && finding.nextAction.blockedReason), true,
  'each report-only finding still gives the user a concrete procedure');
  assert.equal(relationships.every((finding) => finding.impact.summary
    && finding.impact.summary !== finding.nextAction.recommendation), true,
  'expected effect is distinct from the recommendation');
  assert.equal(findings.filter((finding) => finding.resource.name === 'project-mode').length, 1,
    'the grouped relationship replaces generic per-item ambiguity');
  assert.doesNotMatch(JSON.stringify(relationships), /\/private\//);
});

test('stale evidence is visible and cannot produce a safe cleanup classification', () => {
  const input = footprint();
  input.snapshot.stale = true;
  input.snapshot.ageMs = 8 * 86_400_000;

  const { findings } = scanMaintenanceFindings({ footprint: input, now: () => NOW });
  const cache = findings.find((finding) => finding.resource.id === 'cache:demo');
  assert.equal(cache.evidence.freshness, 'stale');
  assert.equal(cache.bucket, 'needsReview');
  assert.equal(cache.safetyClass, 'never-automatic');
});

test('maintenance plans are deeply immutable, five-minute, and source-bound', () => {
  const scan = scanMaintenanceFindings({ footprint: footprint(), now: () => NOW });
  const finding = scan.findings.find((row) => row.resource.id === 'cache:demo');
  const plan = buildMaintenancePlan({
    findings: [finding], sourceFingerprint: scan.sourceFingerprint, now: () => NOW,
  });

  assert.equal(plan.schemaVersion, 1);
  assert.equal(plan.mode, 'read-only');
  assert.deepEqual(plan.capabilities, { plan: true, apply: false, undo: false });
  assert.equal(plan.expiresAt, new Date(NOW + 300_000).toISOString());
  assert.equal(plan.safetyClass, 'safe-automatic');
  assert.equal(plan.actions[0].resourceIdentity.id, 'cache:demo');
  assert.equal(plan.actions[0].classification, 'safe-automatic');
  assert.equal(plan.actions[0].findingClassification, 'reproducible-storage-candidate');
  assert.equal(plan.actions[0].executable, false);
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.actions), true);
  assert.equal(Object.isFrozen(plan.actions[0]), true);
  assert.doesNotThrow(() => assertMaintenancePlanIntegrity(plan, {
    sourceFingerprint: scan.sourceFingerprint, now: () => NOW + 299_999,
  }));
  assert.throws(() => assertMaintenancePlanIntegrity(plan, {
    sourceFingerprint: 'different-source', now: () => NOW,
  }), /source fingerprint/i);
  assert.throws(() => assertMaintenancePlanIntegrity(plan, {
    sourceFingerprint: scan.sourceFingerprint, now: () => NOW + 300_001,
  }), /expired/i);
  const tampered = structuredClone(plan);
  tampered.actions[0].operation = 'remove';
  assert.throws(() => assertMaintenancePlanIntegrity(tampered, {
    sourceFingerprint: scan.sourceFingerprint, now: () => NOW,
  }), /digest/i);
  const mixedClass = structuredClone(plan);
  mixedClass.actions[0].classification = 'approval-required';
  assert.throws(() => assertMaintenancePlanIntegrity(mixedClass, {
    sourceFingerprint: scan.sourceFingerprint, now: () => NOW,
  }), /safety class/i);
});

test('planner is deterministic and rejects mixed safety classes', () => {
  const scan = scanMaintenanceFindings({ footprint: footprint(), now: () => NOW });
  const safe = scan.findings.find((row) => row.resource.id === 'cache:demo');
  const review = {
    ...safe,
    id: 'maintenance-finding-review',
    safetyClass: 'approval-required',
    resource: { ...safe.resource, id: 'history:one' },
  };
  const input = { findings: [safe], sourceFingerprint: scan.sourceFingerprint, now: () => NOW };
  const first = buildMaintenancePlan(input);
  const second = buildMaintenancePlan(input);
  assert.equal(first.planId, second.planId);
  assert.equal(first.planDigest, second.planDigest);
  assert.throws(() => buildMaintenancePlan({
    findings: [safe, review], sourceFingerprint: scan.sourceFingerprint, now: () => NOW,
  }), /one safety class/i);
});
