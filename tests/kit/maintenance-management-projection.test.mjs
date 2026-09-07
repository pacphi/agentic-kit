// ADR-0048 management projection tests. Each test names the requirement id
// (MNT-…) it proves. Hermetic: no filesystem, process, or network access —
// every fact is constructed inline or injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertLabelAllowed, assertManagementInventory, isOpaqueId, isProhibitedLabel, opaqueId,
} from '../../src/lib/maintenance/management/model.mjs';
import {
  artifactIdentity, bindingIdentity, conflictIdentity, edgeIdentity, placementIdentity,
  projectIdentity, resourceIdentity,
} from '../../src/lib/maintenance/management/identity.mjs';
import {
  assertion, assertionsFor, inferredDetail, isVerified, scorecardFor, strongestAssertion,
} from '../../src/lib/maintenance/management/evidence.mjs';
import {
  currentEnvironmentId, detectEnvironments, environmentById,
} from '../../src/lib/maintenance/management/environments.mjs';
import { deriveDependencyEdges } from '../../src/lib/maintenance/management/dependencies.mjs';
import { classifyConflicts } from '../../src/lib/maintenance/management/conflicts.mjs';
import { buildManagementInventory } from '../../src/lib/maintenance/management/projection.mjs';

const KEY = 'test-installation-key-0123456789abcdef';
const NOW_ISO = '2026-09-05T12:00:00.000Z';
const NOW = () => Date.parse(NOW_ISO);

// ── identity.mjs ─────────────────────────────────────────────────────────

test('MNT-INV-002/identity: resourceIdentity is deterministic for equal material', () => {
  const a = resourceIdentity({ kind: 'skill', sourceSelector: 'clarity' }, KEY);
  const b = resourceIdentity({ kind: 'skill', sourceSelector: 'clarity' }, KEY);
  assert.equal(a, b);
  assert.ok(isOpaqueId(a, 'res'));
});

test('MNT-INV-002/identity: equal display names never establish equal resource identity', () => {
  // Two resources a person would both call "clarity" but with different
  // source selectors (a project-scoped install vs a user-scoped one) must
  // never collide.
  const user = resourceIdentity({ kind: 'skill', sourceSelector: 'clarity' }, KEY);
  const project = resourceIdentity({
    kind: 'skill', sourceSelector: 'clarity', projectId: projectIdentity({ lexicalRoot: '/a/b' }, KEY),
  }, KEY);
  assert.notEqual(user, project);
});

test('identity: resourceIdentity requires a kind', () => {
  assert.throws(() => resourceIdentity({ sourceSelector: 'x' }, KEY), TypeError);
});

test('identity: placementIdentity separates the same resource across environments', () => {
  const resource = resourceIdentity({ kind: 'executable', sourceSelector: 'node' }, KEY);
  const envA = resourceIdentity({ kind: 'macos', sourceSelector: 'a' }, KEY); // stand-in opaque env id
  const envB = resourceIdentity({ kind: 'linux', sourceSelector: 'b' }, KEY);
  const a = placementIdentity({ resourceId: resource, environmentId: envA, administrativeScope: 'machine' }, KEY);
  const b = placementIdentity({ resourceId: resource, environmentId: envB, administrativeScope: 'machine' }, KEY);
  assert.notEqual(a, b);
  assert.ok(isOpaqueId(a, 'plc'));
});

test('identity: placementIdentity requires resourceId, environmentId, and administrativeScope', () => {
  assert.throws(() => placementIdentity({ environmentId: 'env_x', administrativeScope: 'user' }, KEY), TypeError);
});

test('identity: conflictIdentity is order-independent over placementIds', () => {
  const a = conflictIdentity({ kind: 'duplicate-placement', placementIds: ['plc_a', 'plc_b'] }, KEY);
  const b = conflictIdentity({ kind: 'duplicate-placement', placementIds: ['plc_b', 'plc_a'] }, KEY);
  assert.equal(a, b);
});

test('identity: edgeIdentity and bindingIdentity and artifactIdentity are opaque and stable', () => {
  const artifact = artifactIdentity({ carrier: 'file', locator: 'x' }, KEY);
  const binding = bindingIdentity({ placementId: 'plc_x', consumerKind: 'host' }, KEY);
  const edge = edgeIdentity({ fromPlacementId: 'plc_x', toId: 'res_y', kind: 'requires-executable' }, KEY);
  assert.ok(isOpaqueId(artifact, 'art'));
  assert.ok(isOpaqueId(binding, 'bnd'));
  assert.ok(isOpaqueId(edge, 'edg'));
});

test('identity: projectIdentity distinguishes two worktrees sharing one remote', () => {
  const main = projectIdentity({ verifiedRemote: 'github.com/a/b', worktreeRoot: '/repo/main' }, KEY);
  const feature = projectIdentity({ verifiedRemote: 'github.com/a/b', worktreeRoot: '/repo/feature' }, KEY);
  assert.notEqual(main, feature);
  assert.ok(isOpaqueId(main, 'prj'));
});

// ── evidence.mjs ─────────────────────────────────────────────────────────

test('MNT-EVD-001: assertion() validates grade, field, and timestamp', () => {
  const base = {
    subjectId: 'plc_x', field: 'installedVersion', value: '1.0.0', grade: 'verified',
    authority: 'a', sourceRef: 'b', capturedAt: NOW_ISO,
  };
  assert.doesNotThrow(() => assertion(base));
  assert.throws(() => assertion({ ...base, field: 'not-a-field' }), TypeError);
  assert.throws(() => assertion({ ...base, grade: 'guessed' }), TypeError);
  assert.throws(() => assertion({ ...base, capturedAt: 'not-a-date' }), TypeError);
});

test('MNT-EVD-002/003: scorecardFor keeps the strongest grade per field, never averages', () => {
  const assertions = [
    assertion({
      subjectId: 'plc_x', field: 'candidateSource', value: 'a', grade: 'inferred',
      authority: 'guess', sourceRef: 'x', capturedAt: NOW_ISO,
    }),
    assertion({
      subjectId: 'plc_x', field: 'candidateSource', value: 'a', grade: 'verified',
      authority: 'registry', sourceRef: 'x', capturedAt: NOW_ISO,
    }),
  ];
  const scorecard = scorecardFor(assertions);
  assert.equal(scorecard.candidateSource, 'verified');
  assert.equal(isVerified(assertions, 'plc_x', 'candidateSource'), true);
  assert.equal(strongestAssertion(assertions, 'plc_x', 'candidateSource').authority, 'registry');
});

test('evidence: a field never asserted is omitted from the scorecard', () => {
  const scorecard = scorecardFor([]);
  assert.equal('remedy' in scorecard, false);
});

test('MNT-EVD-003: inferredDetail only fires for inferred-only evidence', () => {
  const inferredOnly = [assertion({
    subjectId: 'plc_x', field: 'remedy', value: 'maybe', grade: 'inferred',
    authority: 'heuristic', sourceRef: 'x', capturedAt: NOW_ISO,
  })];
  assert.equal(inferredDetail(inferredOnly, 'plc_x', 'remedy', () => 'guessed remedy'), 'guessed remedy');
  const verified = [assertion({
    subjectId: 'plc_x', field: 'remedy', value: 'sure', grade: 'verified',
    authority: 'provider', sourceRef: 'x', capturedAt: NOW_ISO,
  })];
  assert.equal(inferredDetail(verified, 'plc_x', 'remedy', () => 'should not show'), null);
});

test('evidence: assertionsFor filters by subject', () => {
  const all = [
    assertion({ subjectId: 'a', field: 'identity', value: 1, grade: 'verified', authority: 'x', sourceRef: 'y', capturedAt: NOW_ISO }),
    assertion({ subjectId: 'b', field: 'identity', value: 1, grade: 'verified', authority: 'x', sourceRef: 'y', capturedAt: NOW_ISO }),
  ];
  assert.equal(assertionsFor(all, 'a').length, 1);
});

// ── environments.mjs ─────────────────────────────────────────────────────

test('MNT-INV-012: WSL distributions are separate environments carrying an explicit parent edge', () => {
  const environments = detectEnvironments({
    platform: 'win32', release: '11', arch: 'x64', wslDistributions: ['Ubuntu', 'Debian'],
  }, KEY);
  assert.equal(environments.length, 3);
  const [windows, ubuntu, debian] = environments;
  assert.equal(windows.kind, 'windows');
  assert.equal(ubuntu.kind, 'wsl');
  assert.equal(debian.kind, 'wsl');
  assert.equal(ubuntu.parentEnvironmentId, windows.environmentId);
  assert.equal(debian.parentEnvironmentId, windows.environmentId);
  assert.notEqual(ubuntu.environmentId, debian.environmentId);
  assert.ok(environmentById(environments, windows.environmentId));
});

test('environments: darwin and linux each yield exactly one environment', () => {
  assert.equal(detectEnvironments({ platform: 'darwin' }, KEY).length, 1);
  assert.equal(detectEnvironments({ platform: 'linux' }, KEY).length, 1);
});

test('environments: an unsupported platform throws rather than guessing', () => {
  assert.throws(() => detectEnvironments({ platform: 'plan9' }, KEY), TypeError);
});

test('environments: currentEnvironmentId prefers the non-WSL environment by default', () => {
  const environments = detectEnvironments({ platform: 'win32', wslDistributions: ['Ubuntu'] }, KEY);
  assert.equal(currentEnvironmentId(environments), environments[0].environmentId);
  assert.equal(currentEnvironmentId(environments, { wslDistro: 'Ubuntu' }), environments[1].environmentId);
});

// ── projection.mjs: buildManagementInventory ────────────────────────────

function baseFootprint() {
  return {
    catalog: {
      sourceStamps: [{ id: 'claude-user', value: 'fp-1' }],
      items: [{
        canonicalId: 'skill::clarity', kind: 'skill', name: 'clarity', capabilityName: 'clarity',
        pluginRef: null,
        presence: [
          {
            host: 'claude', scope: 'user', project: null, itemPath: '/home/skills/clarity',
            artifactId: 'catalog-artifact-clarity', digest: { status: 'measured', value: 'sha256-clarity' },
            consumer: { mechanism: 'claude-user-skills', enabled: true, configScope: 'user' },
          },
          {
            host: 'codex', scope: 'user', project: null, itemPath: '/home/skills/clarity',
            artifactId: 'catalog-artifact-clarity', digest: { status: 'measured', value: 'sha256-clarity' },
            consumer: { mechanism: 'codex-agents-skills', enabled: true, configScope: 'user' },
          },
        ],
      }],
    },
  };
}

/** By default, every environment implied by `environment` is marked as a
 *  complete source so a test can assert one specific condition without the
 *  incidental (and separately tested) `source-scan-incomplete` condition
 *  riding along. A test that wants incompleteness passes its own
 *  `sourceCoverage`. */
function defaultSourceCoverage(environment) {
  const environments = detectEnvironments({
    platform: environment.platform, release: environment.release, arch: environment.arch,
    wslDistributions: environment.wsl ?? [],
  }, KEY);
  return environments.map((entry, index) => ({
    sourceId: opaqueId('src', { fixture: 'default', index }, KEY), environmentId: entry.environmentId,
    state: 'complete', visited: 1, completedPartitions: 1, pendingPartitions: 0,
  }));
}

function invoke(overrides = {}) {
  const environment = overrides.environment ?? { platform: 'darwin' };
  return buildManagementInventory({
    footprint: baseFootprint(), environment, installationKey: KEY, now: NOW,
    sourceCoverage: defaultSourceCoverage(environment),
    ...overrides,
  });
}

test('MNT-INV-004: one artifact consumed by two hosts is one placement with two bindings', () => {
  const { inventory } = invoke();
  assert.equal(inventory.placements.length, 1);
  const [placement] = inventory.placements;
  assert.equal(placement.consumerBindingIds.length, 2);
  assert.equal(inventory.consumerBindings.length, 2);
  assert.deepEqual([...placement.consumerHosts].sort(), ['claude', 'codex']);
});

test('MNT-INV-003/007: J1 Lightpanda — one exact placement plus a verified missing-executable edge', () => {
  const footprint = {
    catalog: {
      items: [{
        canonicalId: 'mcpServer::lightpanda', kind: 'mcpServer', name: 'lightpanda', capabilityName: 'lightpanda',
        pluginRef: null,
        presence: [{
          host: 'claude', scope: 'user', project: null, itemPath: null,
          artifactId: 'catalog-artifact-lightpanda', digest: null,
          consumer: { mechanism: 'claude-json-mcp', enabled: true, configScope: 'user' },
        }],
      }],
    },
  };
  const { inventory } = invoke({
    footprint,
    discovery: {
      dependencyProbes: [{
        subjectKind: 'mcp-registration', subjectSelector: 'lightpanda', host: 'claude',
        requirement: 'lightpanda', requirementKind: 'executable', satisfied: false,
        authority: 'claude configuration + PATH probe',
      }],
    },
  });
  assert.equal(inventory.placements.length, 1);
  const [placement] = inventory.placements;
  assert.deepEqual(placement.conditions, ['missing-verified-dependency']);
  assert.ok(placement.technicalDetails.some((line) => line.includes('lightpanda')));
  assert.equal(inventory.dependencyEdges.length, 1);
  const [edge] = inventory.dependencyEdges;
  assert.equal(edge.kind, 'requires-executable');
  assert.equal(edge.fromPlacementId, placement.placementId);
  assert.equal(edge.satisfied, false);
  // The dependency target is a resource with no placement of its own — a
  // verified absence, not an invented installation.
  const target = inventory.resources.find((r) => r.resourceId === edge.toId);
  assert.ok(target);
  assert.equal(target.placementIds.length, 0);
});

test('J9: two definitions competing for one (host, lifecyclePoint) slot is a real, field-based definitions-differ signal', () => {
  // The read model's own grouping keys are the evidence: two definitionGroups
  // that share a (host, lifecyclePoint) but carry different behaviorFingerprints
  // ('codex-session-start-A' vs '-B') prove the definitions genuinely differ —
  // this is never a title/prose heuristic.
  const hookReadModel = {
    definitionGroups: [
      {
        behaviorId: 'codex-session-start-A', host: 'codex', lifecyclePoint: 'SessionStart', handlerKind: 'command',
        placements: [{ occurrenceId: 'occ-1', source: { label: 'AutoMemory' }, selectionState: 'selected' }],
      },
      {
        behaviorId: 'codex-session-start-B', host: 'codex', lifecyclePoint: 'SessionStart', handlerKind: 'command',
        placements: [{ occurrenceId: 'occ-2', source: { label: 'AutoMemory (legacy)' }, selectionState: 'selected' }],
      },
    ],
    findings: [{
      findingId: 'legacy-ruflo-project-hook', code: 'legacy-ruflo-project-hook', title: 'Legacy helper is incompatible with this host',
      explanation: 'The audit recognized a legacy Ruflo Claude helper projection in Codex. Retirement requires exact source and replacement evidence.',
      affectedOccurrenceIds: ['occ-2'],
    }],
    observations: [],
  };
  const { inventory } = invoke({ footprint: {}, hookReadModel });
  assert.equal(inventory.placements.length, 2);
  for (const placement of inventory.placements) {
    assert.deepEqual(placement.conditions, ['definitions-differ']);
    assert.equal(placement.guidanceLane, null);
  }
  assert.equal(inventory.guidanceEntries.length, 0);
  const legacy = inventory.placements.find((p) => p.technicalDetails.some((line) => line.includes('legacy-ruflo-project-hook')));
  assert.ok(legacy, 'the finding-affected occurrence carries its diagnostic code');
  assert.ok(legacy.technicalDetails.some((line) => line.includes('Retirement requires exact source')));
});

test('one hook definition for a (host, lifecyclePoint) slot with no competing definition is healthy, not differs', () => {
  const hookReadModel = {
    definitionGroups: [{
      behaviorId: 'codex-session-start-A', host: 'codex', lifecyclePoint: 'SessionStart', handlerKind: 'command',
      placements: [{ occurrenceId: 'occ-1', source: { label: 'AutoMemory' }, selectionState: 'selected' }],
    }],
    findings: [], observations: [],
  };
  const { inventory } = invoke({ footprint: {}, hookReadModel });
  assert.deepEqual(inventory.placements[0].conditions, ['healthy']);
});

test('a diagnostic code without a definitions-differ signal still shows its allowlisted explanation and code', () => {
  const hookReadModel = {
    definitionGroups: [{
      behaviorId: 'codex-session-start-A', host: 'codex', lifecyclePoint: 'SessionStart', handlerKind: 'command',
      placements: [{ occurrenceId: 'occ-1', source: { label: 'AutoMemory' }, selectionState: 'selected' }],
    }],
    findings: [{
      findingId: 'dynamic-shell', code: 'dynamic-shell', title: 'Shell expansion needs review',
      explanation: 'This definition uses a shell wrapper, so expansion, working directory, and environment behavior need source-owner review.',
      affectedOccurrenceIds: ['occ-1'],
    }],
    observations: [],
  };
  const { inventory } = invoke({ footprint: {}, hookReadModel });
  const [placement] = inventory.placements;
  assert.deepEqual(placement.conditions, ['healthy']);
  assert.ok(placement.technicalDetails.some((line) => line.includes('need source-owner review')));
  assert.ok(placement.technicalDetails.some((line) => line === 'Diagnostic codes: dynamic-shell.'));
});

test('D7: two occurrences carrying the same verified behaviorFingerprint are duplicate-placement only (each has its own artifact)', () => {
  const hookReadModel = {
    definitionGroups: [{
      behaviorId: 'codex-session-start-A', host: 'codex', lifecyclePoint: 'SessionStart', handlerKind: 'command',
      placements: [
        { occurrenceId: 'occ-1', source: { label: 'AutoMemory' }, selectionState: 'selected' },
        { occurrenceId: 'occ-2', source: { label: 'AutoMemory' }, selectionState: 'selected' },
      ],
    }],
    findings: [], observations: [],
  };
  const { inventory } = invoke({ footprint: {}, hookReadModel });
  assert.equal(inventory.placements.length, 2);
  assert.deepEqual(inventory.placements.map((p) => p.conditions), [['healthy'], ['healthy']]);
  // Each occurrence carries its own occurrence-keyed artifact, so equal
  // content digest here is duplicate-placement's evidence, never
  // shared-artifact's — the two occurrences are not the same physical carrier.
  const kinds = inventory.conflictSets.map((c) => c.kind).sort();
  assert.deepEqual(kinds, ['duplicate-placement']);
});

test('a hook the host has not selected carries a disabled condition, not silence', () => {
  const hookReadModel = {
    definitionGroups: [{
      behaviorId: 'codex-off', host: 'codex', lifecyclePoint: 'SessionStart', handlerKind: 'command',
      placements: [{ occurrenceId: 'occ-2', source: { label: 'Off' }, selectionState: 'not-selected' }],
    }],
    findings: [], observations: [],
  };
  const { inventory } = invoke({ footprint: {}, hookReadModel });
  assert.deepEqual(inventory.placements[0].conditions, ['disabled']);
});

test('MNT-INV-008: model rows carry provider, digest, storage, consumers, and activeUse', () => {
  const modelSnapshot = {
    models: [{
      key: { host: 'ollama', provider: 'ollama', modelId: 'llama3.2:3b', scopeId: 'user', digest: 'sha256-llama' },
      identity: 'model-identity-1', displayName: 'llama3.2:3b',
    }],
    bindings: [{ identity: 'model-identity-1', consumer: 'route:implementation', consumerState: 'runtime-proven' }],
  };
  const { inventory } = invoke({
    footprint: {}, modelSnapshot,
    discovery: { modelStorage: { 'model-identity-1': { logicalBytes: 2_000_000_000, physicalBytes: 1_800_000_000, sharedBlobs: 1 } } },
  });
  const [placement] = inventory.placements;
  assert.equal(placement.kind, 'model');
  assert.equal(placement.versions.contentDigest, 'sha256-llama');
  assert.equal(placement.activeUse, true);
  assert.equal(placement.consumerBindingIds.length, 1);
  const artifact = inventory.artifacts.find((a) => a.artifactId === placement.artifactIds[0]);
  assert.equal(artifact.physicalBytes, 1_800_000_000);
});

test('MNT-CRD: credential readiness derives from presence only, never a value; mechanism only when supplied', () => {
  const { inventory } = invoke({
    footprint: {},
    providerDetections: { providers: { openai: { configured: true, reachable: null, credentialPresent: true } } },
  });
  const credentialPlacement = inventory.placements.find((p) => p.kind === 'credential-readiness');
  assert.equal(credentialPlacement.credentialReadiness, 'configured-not-checked');
  assert.deepEqual(credentialPlacement.conditions, ['credential-mechanism-not-checked']);
  assert.equal('credentialMechanism' in credentialPlacement, false);
  const configPlacement = inventory.placements.find((p) => p.kind === 'provider-configuration');
  const edge = inventory.dependencyEdges.find((e) => e.kind === 'requires-credential');
  assert.equal(edge.fromPlacementId, configPlacement.placementId);
});

test('credential mechanism renders only when the caller supplies it (never a value)', () => {
  const { inventory } = invoke({
    footprint: {},
    providerDetections: {
      providers: { anthropic: { configured: true, reachable: true, credentialPresent: true, credentialMechanism: 'keychain-entry' } },
    },
  });
  const credentialPlacement = inventory.placements.find((p) => p.kind === 'credential-readiness');
  assert.equal(credentialPlacement.credentialReadiness, 'ready');
  assert.equal(credentialPlacement.credentialMechanism, 'keychain-entry');
});

test('MNT-INV-009: a regenerable cache reclaimable becomes one root-summary placement', () => {
  const { inventory, privateLocators } = invoke({
    footprint: {
      storage: {
        reclaimables: [{
          id: 'cache:npx-stale', label: 'Stale npx cache', safety: 'regenerable', path: '/private/cache/npx',
          rationale: 'The owning tool refetches this on demand.',
        }],
      },
    },
  });
  const [placement] = inventory.placements;
  assert.deepEqual(privateLocators.get(placement.placementId), { path: '/private/cache/npx' });
  assert.ok(!JSON.stringify(inventory).includes('/private/cache/npx'));
  assert.equal(placement.kind, 'cache');
  assert.deepEqual(placement.conditions, ['reproducible-cache']);
  assert.deepEqual(placement.technicalDetails, ['The owning tool refetches this on demand.']);
});

test('a "review" tier reclaimable becomes related-storage, not cache', () => {
  const { inventory } = invoke({
    footprint: { storage: { reclaimables: [{ id: 'worktree:x', label: 'Orphaned worktree', safety: 'review', rationale: 'Review individually.' }] } },
  });
  assert.equal(inventory.placements[0].kind, 'related-storage');
});

test('orphaned-process: a daemon whose workspace no longer exists is flagged, a live one is healthy', () => {
  const { inventory } = invoke({
    footprint: {
      runtime: {
        daemons: {
          entries: [
            { pid: 111, workspace: '/gone/workspace', workspaceExists: false, ageSecs: 999 },
            { pid: 222, workspace: '/here/workspace', workspaceExists: true, ageSecs: 5 },
          ],
        },
      },
    },
  });
  const orphaned = inventory.placements.find((p) => p.conditions.includes('orphaned-process'));
  const healthy = inventory.placements.find((p) => p.conditions.includes('healthy'));
  assert.ok(orphaned);
  assert.ok(healthy);
  assert.equal(inventory.resources.filter((r) => r.kind === 'executable' && r.displayName === 'ruflo daemon').length, 1);
});

test('MNT-INV-010: two projects sharing a basename get the shortest distinguishing breadcrumb', () => {
  const footprint = {
    projects: {
      projects: [
        { path: '/Users/dev/Development/ai/agentic-kit', label: 'agentic-kit', hosts: ['claude'], remote: null },
        { path: '/Users/dev/other/agentic-kit', label: 'agentic-kit', hosts: ['claude'], remote: null },
      ],
    },
  };
  const { inventory } = invoke({
    footprint: {}, discovery: {
      instructionFiles: [
        { projectPath: '/Users/dev/Development/ai/agentic-kit', host: 'claude', name: 'CLAUDE.md' },
        { projectPath: '/Users/dev/other/agentic-kit', host: 'claude', name: 'CLAUDE.md' },
      ],
    },
  });
  // Re-run with the projects section present (the instructionFiles above only
  // resolve a project entry when the project registry itself was populated).
  const withProjects = invoke({
    footprint,
    discovery: {
      instructionFiles: [
        { projectPath: '/Users/dev/Development/ai/agentic-kit', host: 'claude', name: 'CLAUDE.md' },
        { projectPath: '/Users/dev/other/agentic-kit', host: 'claude', name: 'CLAUDE.md' },
      ],
    },
  }).inventory;
  const breadcrumbs = withProjects.placements
    .filter((p) => p.kind === 'instruction-context-file')
    .map((p) => p.locationBreadcrumb.join('/'));
  assert.equal(new Set(breadcrumbs).size, 2, 'breadcrumbs must differ');
  assert.ok(inventory); // the first (no-projects) call still produced a valid inventory
});

test('MNT-INV-011: linked worktrees group under one repositoryId; an unrelated project does not', () => {
  const footprint = {
    projects: {
      projects: [
        { path: '/repo/main', label: 'kit', hosts: ['claude'], remote: { status: 'linked', webUrl: 'https://github.com/a/kit' } },
        { path: '/repo/feature-wt', label: 'kit', hosts: ['claude'], remote: { status: 'linked', webUrl: 'https://github.com/a/kit' } },
        { path: '/elsewhere/kit', label: 'kit', hosts: ['claude'], remote: null },
      ],
    },
  };
  const { inventory } = invoke({
    footprint,
    discovery: {
      instructionFiles: [
        { projectPath: '/repo/main', host: 'claude', name: 'CLAUDE.md' },
        { projectPath: '/repo/feature-wt', host: 'claude', name: 'CLAUDE.md' },
        { projectPath: '/elsewhere/kit', host: 'claude', name: 'CLAUDE.md' },
      ],
    },
  });
  const rows = inventory.placements.filter((p) => p.kind === 'instruction-context-file');
  const main = rows.find((r) => r.projectId && r.repositoryId);
  const lone = rows.find((r) => !r.repositoryId);
  assert.ok(main, 'a worktree member carries a repositoryId');
  assert.ok(lone, 'the unrelated project carries no repositoryId');
  const worktreeMembers = rows.filter((r) => r.repositoryId);
  assert.equal(worktreeMembers.length, 2);
  assert.equal(worktreeMembers[0].repositoryId, worktreeMembers[1].repositoryId);
});

// Grouping-defect fix: logical identity is kind + name + host + a bounded
// definition digest WHERE VERIFIED — never the administrative scope or
// project. Real-machine finding: a11y-ally rendered as five separate
// resources (one per project) instead of one resource with several
// placements. (Superseded the old, mislabeled "MNT-INV-005" test here — that
// requirement is actually about scope MEANINGS, not resource identity; see
// acceptance-criteria.md.)

test('grouping fix: two projects\' instruction files with no verified digest still group into ONE resource (no evidence to split them on)', () => {
  const footprint = {
    projects: { projects: [{ path: '/p1', label: 'p1', hosts: [], remote: null }, { path: '/p2', label: 'p2', hosts: [], remote: null }] },
  };
  const { inventory } = invoke({
    footprint,
    discovery: {
      instructionFiles: [
        { projectPath: '/p1', host: 'claude', name: 'CLAUDE.md' },
        { projectPath: '/p2', host: 'claude', name: 'CLAUDE.md' },
      ],
    },
  });
  const resources = inventory.resources.filter((r) => r.kind === 'instruction-context-file');
  assert.equal(resources.length, 1);
  assert.equal(resources[0].placementIds.length, 2);
  const placements = inventory.placements.filter((p) => p.kind === 'instruction-context-file');
  assert.equal(new Set(placements.map((p) => p.projectId)).size, 2, 'placements still carry their own exact project');
});

test('grouping fix: two projects\' instruction files with DIFFERENT verified digests stay two resources, linked by same-name-different-definition', () => {
  const footprint = {
    projects: { projects: [{ path: '/p1', label: 'p1', hosts: [], remote: null }, { path: '/p2', label: 'p2', hosts: [], remote: null }] },
  };
  const { inventory } = invoke({
    footprint,
    discovery: {
      instructionFiles: [
        { projectPath: '/p1', host: 'claude', name: 'CLAUDE.md', digest: 'sha256-p1' },
        { projectPath: '/p2', host: 'claude', name: 'CLAUDE.md', digest: 'sha256-p2' },
      ],
    },
  });
  const resources = inventory.resources.filter((r) => r.kind === 'instruction-context-file');
  assert.equal(resources.length, 2);
  for (const resource of resources) assert.equal(resource.placementIds.length, 1);
  const kinds = inventory.conflictSets.map((c) => c.kind);
  assert.deepEqual(kinds, ['same-name-different-definition']);
});

test('grouping fix: two projects\' instruction files with the SAME verified digest group into one resource', () => {
  const footprint = {
    projects: { projects: [{ path: '/p1', label: 'p1', hosts: [], remote: null }, { path: '/p2', label: 'p2', hosts: [], remote: null }] },
  };
  const { inventory } = invoke({
    footprint,
    discovery: {
      instructionFiles: [
        { projectPath: '/p1', host: 'claude', name: 'CLAUDE.md', digest: 'sha256-same' },
        { projectPath: '/p2', host: 'claude', name: 'CLAUDE.md', digest: 'sha256-same' },
      ],
    },
  });
  const resources = inventory.resources.filter((r) => r.kind === 'instruction-context-file');
  assert.equal(resources.length, 1);
  assert.equal(resources[0].placementIds.length, 2);
  // Equal digest across two DIFFERENT physical artifacts (each project's own
  // file) is duplicate-placement's own evidence too — the resource merge
  // does not suppress it, it is an independent lens over the same facts.
  assert.deepEqual(inventory.conflictSets.map((c) => c.kind), ['duplicate-placement']);
});

test('grouping fix/D9 (a11y-ally): five project copies + one user copy of one skill, equal digests, ONE resource with six placements', () => {
  const projectPaths = ['/repo/prompt-genie', '/repo/keel', '/repo/retirement-calculator', '/repo/finima', '/repo/agentic-kit'];
  const digest = { status: 'measured', value: 'sha256-a11y-ally' };
  const projectPresences = projectPaths.map((project, index) => ({
    host: 'claude', scope: 'project', project, itemPath: `${project}/.claude/skills/a11y-ally`,
    artifactId: `catalog-artifact-a11y-ally-${index}`, digest,
    consumer: { mechanism: 'claude-project-skills', enabled: true, configScope: 'project' },
  }));
  const footprint = {
    projects: { projects: projectPaths.map((path) => ({ path, label: path.split('/').pop(), hosts: ['claude'], remote: null })) },
    catalog: {
      items: [{
        canonicalId: 'skill::a11y-ally', kind: 'skill', name: 'a11y-ally', capabilityName: 'a11y-ally', pluginRef: null,
        presence: [
          ...projectPresences,
          {
            host: 'claude', scope: 'user', project: null, itemPath: '/home/.claude/skills/a11y-ally',
            artifactId: 'catalog-artifact-a11y-ally-user', digest,
            consumer: { mechanism: 'claude-user-skills', enabled: true, configScope: 'user' },
          },
        ],
      }],
    },
  };
  const { inventory } = invoke({ footprint });
  const resources = inventory.resources.filter((r) => r.kind === 'skill');
  assert.equal(resources.length, 1, 'one logical a11y-ally resource, not five (or six)');
  assert.equal(resources[0].placementIds.length, 6);
  const placements = inventory.placements.filter((p) => p.kind === 'skill');
  assert.equal(placements.length, 6);
  assert.equal(placements.filter((p) => p.administrativeScope === 'project').length, 5);
  assert.equal(placements.filter((p) => p.administrativeScope === 'user').length, 1);
  // Each placement still carries its own exact project/breadcrumb.
  assert.equal(new Set(placements.map((p) => p.projectId ?? 'user')).size, 6);
});

// ── gap 1/3: the authoritative discovery.projects registry ─────────────────

test('gap 1: discovery.projects[].instructionFiles closes instruction-context-file coverage without any footprint.projects row', () => {
  const { inventory } = invoke({
    footprint: {},
    discovery: {
      projects: [{
        projectId: 'prj_authoritativeone000000001', breadcrumb: ['Development', 'agentic-kit'],
        instructionFiles: [{ name: 'CLAUDE.md', host: 'claude' }, { name: 'AGENTS.md', host: 'codex' }],
      }],
    },
  });
  const rows = inventory.placements.filter((p) => p.kind === 'instruction-context-file');
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.administrativeScope, 'project');
    assert.equal(row.projectId, 'prj_authoritativeone000000001');
    assert.deepEqual(row.locationBreadcrumb, ['Development', 'agentic-kit']);
  }
});

test('gap 3: discovery.projects wins over lexical detection for a shared path — breadcrumb and repositoryKey replace guesses', () => {
  const footprint = {
    projects: { projects: [{ path: '/repo/main', label: 'kit', hosts: ['claude'], remote: null }] },
  };
  const { inventory } = invoke({
    footprint,
    discovery: {
      projects: [
        {
          projectId: 'prj_authoritativemain00000001', path: '/repo/main', breadcrumb: ['Authoritative', 'Main'],
          repositoryKey: 'repo:kit', instructionFiles: [{ name: 'CLAUDE.md', host: 'claude' }],
        },
        {
          projectId: 'prj_authoritativefeature000001', path: '/repo/feature', breadcrumb: ['Authoritative', 'Feature'],
          repositoryKey: 'repo:kit', worktree: 'feature', instructionFiles: [{ name: 'CLAUDE.md', host: 'claude' }],
        },
      ],
    },
  });
  const rows = inventory.placements.filter((p) => p.kind === 'instruction-context-file');
  assert.equal(rows.length, 2);
  const main = rows.find((r) => r.projectId === 'prj_authoritativemain00000001');
  const feature = rows.find((r) => r.projectId === 'prj_authoritativefeature000001');
  // The authoritative breadcrumb replaces the lexical one entirely.
  assert.deepEqual(main.locationBreadcrumb, ['Authoritative', 'Main']);
  assert.ok(main.repositoryId, 'two members sharing a repositoryKey are grouped');
  assert.equal(main.repositoryId, feature.repositoryId);
  assert.ok(feature.technicalDetails.includes('Worktree: feature'));
});

test('gap 3: a nested repository never joins its parent\'s worktree group even when it shares a repositoryKey', () => {
  const { inventory } = invoke({
    footprint: {},
    discovery: {
      projects: [
        { projectId: 'prj_parentrepo0000000000001', breadcrumb: ['Parent'], repositoryKey: 'repo:shared', instructionFiles: [{ name: 'CLAUDE.md', host: 'claude' }] },
        { projectId: 'prj_nestedrepo0000000000001', breadcrumb: ['Parent', 'vendor', 'nested'], repositoryKey: 'repo:shared', nested: true, instructionFiles: [{ name: 'CLAUDE.md', host: 'claude' }] },
      ],
    },
  });
  const rows = inventory.placements.filter((p) => p.kind === 'instruction-context-file');
  const nested = rows.find((r) => r.projectId === 'prj_nestedrepo0000000000001');
  assert.equal('repositoryId' in nested, false);
});

test('gap 3: submoduleOfProjectId derives a verified submodule-of edge between the two projects\' representative placements', () => {
  const { inventory } = invoke({
    footprint: {},
    discovery: {
      projects: [
        { projectId: 'prj_parentproject00000000001', breadcrumb: ['Parent'], instructionFiles: [{ name: 'CLAUDE.md', host: 'claude' }] },
        {
          projectId: 'prj_childsubmodule0000000001', breadcrumb: ['Parent', 'vendor', 'child'],
          submoduleOfProjectId: 'prj_parentproject00000000001', instructionFiles: [{ name: 'CLAUDE.md', host: 'claude' }],
        },
      ],
    },
  });
  const rows = inventory.placements.filter((p) => p.kind === 'instruction-context-file');
  const parent = rows.find((r) => r.projectId === 'prj_parentproject00000000001');
  const child = rows.find((r) => r.projectId === 'prj_childsubmodule0000000001');
  const edge = inventory.dependencyEdges.find((e) => e.kind === 'submodule-of');
  assert.ok(edge, 'a submodule-of edge is derived');
  assert.equal(edge.fromPlacementId, child.placementId);
  assert.equal(edge.toId, parent.placementId);
  assert.equal(edge.grade, 'verified');
});

test('gap 3: submoduleOfProjectId is never invented when the parent has no representative placement', () => {
  const { inventory } = invoke({
    footprint: {},
    discovery: {
      projects: [{
        projectId: 'prj_orphansubmodule000000001', breadcrumb: ['Orphan'],
        submoduleOfProjectId: 'prj_neverexisted0000000000001', instructionFiles: [{ name: 'CLAUDE.md', host: 'claude' }],
      }],
    },
  });
  assert.equal(inventory.dependencyEdges.filter((e) => e.kind === 'submodule-of').length, 0);
});

// ── gap 9: ranked storage consumers → related-storage root + breakdown ─────

test('gap 9: an eligible consumer root and its breakdown children map to one related-storage resource, several placements', () => {
  const { inventory } = invoke({
    footprint: {
      consumers: {
        rows: [
          { id: 'ai-toolchain-root', label: 'Claude cache', group: 'ai-toolchain', kind: 'root', containedBy: null, presence: 'present', bytes: { value: 5_000_000_000 }, accountingNote: null },
          { id: 'ai-toolchain-root:models', label: 'Model weights', group: 'ai-toolchain', kind: 'breakdown', containedBy: 'ai-toolchain-root', presence: 'present', bytes: { value: 3_000_000_000 }, accountingNote: 'Broken out of Claude cache.' },
          { id: 'system-root', label: 'Homebrew Cellar', group: 'system', kind: 'root', containedBy: null, presence: 'present', bytes: { value: 1_000_000_000 } },
        ],
      },
    },
  });
  const roots = inventory.placements.filter((p) => p.displayName === 'Claude cache');
  const children = inventory.placements.filter((p) => p.displayName === 'Model weights');
  assert.equal(roots.length, 1);
  assert.equal(children.length, 1);
  assert.equal(roots[0].resourceId, children[0].resourceId, 'root and breakdown share one logical resource');
  assert.equal(roots[0].kind, 'related-storage');
  assert.equal(roots[0].guidanceLane, null);
  assert.deepEqual(roots[0].versions, {});
  // The generic 'system' group is skipped entirely.
  assert.equal(inventory.placements.some((p) => p.displayName === 'Homebrew Cellar'), false);
});

test('gap 9: impact bytes appear only where actually measured', () => {
  const { inventory } = invoke({
    footprint: {
      consumers: {
        rows: [{ id: 'node-root', label: 'npm cache', group: 'node', kind: 'root', containedBy: null, presence: 'present', bytes: { value: null, status: 'unknown' } }],
      },
    },
  });
  const [placement] = inventory.placements;
  assert.equal('impact' in placement.evidenceScorecard, false);
});

test('gap 9: an absent consumer root produces no placement', () => {
  const { inventory } = invoke({
    footprint: {
      consumers: { rows: [{ id: 'gone-root', label: 'Gone', group: 'node', kind: 'root', containedBy: null, presence: 'absent', bytes: { value: 0 } }] },
    },
  });
  assert.equal(inventory.placements.length, 0);
});

test('MNT-DSC-014/source-scan-incomplete: an incomplete source adds the condition without claiming absence', () => {
  const environments = detectEnvironments({ platform: 'darwin' }, KEY);
  const { inventory } = invoke({
    environment: { platform: 'darwin' },
    sourceCoverage: [{
      sourceId: opaqueId('src', { s: 1 }, KEY), environmentId: environments[0].environmentId, state: 'paused',
      visited: 10, completedPartitions: 1, pendingPartitions: 1, limitingReason: 'work-slice',
    }],
  });
  assert.ok(inventory.placements[0].conditions.includes('source-scan-incomplete'));
  assert.ok(inventory.placements[0].technicalDetails.includes('Source scan incomplete'));
});

test('a complete source never adds source-scan-incomplete', () => {
  const environments = detectEnvironments({ platform: 'darwin' }, KEY);
  const { inventory } = invoke({
    sourceCoverage: [{
      sourceId: opaqueId('src', { s: 1 }, KEY), environmentId: environments[0].environmentId, state: 'complete',
      visited: 10, completedPartitions: 1, pendingPartitions: 0,
    }],
  });
  assert.equal(inventory.placements[0].conditions.includes('source-scan-incomplete'), false);
});

test('recovery-receipt-open: an unresolved receipt surfaces as a placement condition', () => {
  const { inventory } = invoke({});
  const [placement] = inventory.placements;
  const { inventory: withReceipt } = invoke({ receipts: [{ affectedPlacementId: placement.placementId }] });
  assert.ok(withReceipt.placements[0].conditions.includes('recovery-receipt-open'));
});

test('MNT-INV-012/windows-hosts-wsl: an executable observed in two WSL distros and Windows gets one resource, three placements, two edges', () => {
  const environments = detectEnvironments({ platform: 'win32', wslDistributions: ['Ubuntu', 'Debian'] }, KEY);
  const [windows, ubuntu, debian] = environments;
  const footprint = {
    install: {
      tools: [
        { tool: 'node', label: 'node', present: true, version: '22.12.0', environmentId: windows.environmentId },
        { tool: 'node', label: 'node', present: true, version: '22.12.0', environmentId: ubuntu.environmentId },
        { tool: 'node', label: 'node', present: true, version: '22.12.0', environmentId: debian.environmentId },
      ],
    },
  };
  const { inventory } = invoke({ footprint, environment: { platform: 'win32', wsl: ['Ubuntu', 'Debian'] } });
  const nodeResources = inventory.resources.filter((r) => r.kind === 'executable' && r.displayName === 'node');
  assert.equal(nodeResources.length, 1);
  assert.equal(nodeResources[0].placementIds.length, 3);
  const wslEdges = inventory.dependencyEdges.filter((e) => e.kind === 'windows-hosts-wsl');
  assert.equal(wslEdges.length, 2);
  const windowsPlacement = inventory.placements.find((p) => p.environmentId === windows.environmentId);
  for (const edge of wslEdges) assert.equal(edge.toId, windowsPlacement.placementId);
});

test('no filesystem, process, or clock access: buildManagementInventory is pure over its inputs', () => {
  const first = invoke().inventory;
  const second = invoke().inventory;
  assert.deepEqual(first.placements, second.placements);
});

test('language policy: no placement or resource displayName is a prohibited label', () => {
  const { inventory } = invoke();
  for (const placement of inventory.placements) assert.equal(isProhibitedLabel(placement.displayName), false);
  for (const resource of inventory.resources) assert.doesNotThrow(() => assertLabelAllowed(resource.displayName));
});

test('the built inventory passes assertManagementInventory unchanged', () => {
  const { inventory } = invoke();
  assert.doesNotThrow(() => assertManagementInventory(inventory));
});

test('buildManagementInventory requires an installationKey and environment.platform', () => {
  assert.throws(() => buildManagementInventory({ environment: { platform: 'darwin' } }), TypeError);
  assert.throws(() => buildManagementInventory({ installationKey: KEY }), TypeError);
});

test('D7/MNT-INV-004/J2: one placement with two bindings on one artifact IS a shared-artifact set with one placement', () => {
  const { inventory } = invoke();
  const [placement] = inventory.placements;
  assert.equal(inventory.conflictSets.length, 1);
  const [conflict] = inventory.conflictSets;
  assert.equal(conflict.kind, 'shared-artifact');
  assert.deepEqual(conflict.placementIds, [placement.placementId]);
  assert.deepEqual(conflict.artifactIds, placement.artifactIds);
  assert.equal(conflict.consumerBindingIds.length, 2);
});

// ── conflicts.mjs ────────────────────────────────────────────────────────

function placement(fields) {
  return {
    placementId: fields.placementId, kind: fields.kind, displayName: fields.displayName,
    versions: fields.versions ?? {}, consumerHosts: fields.consumerHosts ?? [],
    administrativeScope: fields.administrativeScope ?? 'user', transportKey: fields.transportKey ?? null,
    artifactIds: fields.artifactIds ?? [],
  };
}

function binding(fields) {
  return {
    bindingId: fields.bindingId, placementId: fields.placementId, artifactId: fields.artifactId,
    consumerKind: fields.consumerKind ?? 'host', consumerLabel: fields.consumerLabel ?? null,
  };
}

// D7: shared-artifact and duplicate-placement must be disjoint by
// construction — a real-footprint QE defect found BOTH firing for the same
// group (1,201 pairs on the smoke-tested machine), keyed on ">1 consumer
// host" instead of ">1 binding on ONE artifact".

test('D7/a11y-ally shape: different artifacts, equal digests, two consumer hosts each — duplicate-placement only', () => {
  // Mirrors the real defect exactly: a skill placed in two separate
  // projects, each placement its own physical artifact, both with the same
  // verified content digest, each consumed by two hosts.
  const placements = [
    placement({
      placementId: 'plc_a11y_project_a', kind: 'skill', displayName: 'a11y-ally',
      versions: { contentDigest: 'sha256-a11y' }, consumerHosts: ['claude', 'opencode'],
      artifactIds: ['art_project_a'],
    }),
    placement({
      placementId: 'plc_a11y_project_b', kind: 'skill', displayName: 'a11y-ally',
      versions: { contentDigest: 'sha256-a11y' }, consumerHosts: ['claude', 'opencode'],
      artifactIds: ['art_project_b'],
    }),
  ];
  const conflicts = classifyConflicts({ placements, dependencyEdges: [] }, { installationKey: KEY });
  assert.deepEqual(conflicts.map((c) => c.kind), ['duplicate-placement']);
  assert.deepEqual([...conflicts[0].placementIds].sort(), ['plc_a11y_project_a', 'plc_a11y_project_b']);
});

test('D7: one artifact reached by two placements\' bindings — shared-artifact only, never also duplicate-placement', () => {
  const placements = [
    placement({
      placementId: 'plc_a', kind: 'skill', displayName: 'shared-skill',
      versions: { contentDigest: 'sha256-shared' }, artifactIds: ['art_one_physical_copy'],
    }),
    placement({
      placementId: 'plc_b', kind: 'skill', displayName: 'shared-skill',
      versions: { contentDigest: 'sha256-shared' }, artifactIds: ['art_one_physical_copy'],
    }),
  ];
  const consumerBindings = [
    binding({ bindingId: 'bnd_a', placementId: 'plc_a', artifactId: 'art_one_physical_copy' }),
    binding({ bindingId: 'bnd_b', placementId: 'plc_b', artifactId: 'art_one_physical_copy' }),
  ];
  const conflicts = classifyConflicts({ placements, dependencyEdges: [], consumerBindings }, { installationKey: KEY });
  // Same artifact on both placements also gives them equal digest and only
  // ONE distinct artifact between them, so duplicatePlacementGroups
  // correctly declines to fire — there is no second physical copy here.
  assert.deepEqual(conflicts.map((c) => c.kind), ['shared-artifact']);
  assert.deepEqual([...conflicts[0].placementIds].sort(), ['plc_a', 'plc_b']);
  assert.deepEqual(conflicts[0].artifactIds, ['art_one_physical_copy']);
  assert.deepEqual([...conflicts[0].consumerBindingIds].sort(), ['bnd_a', 'bnd_b']);
});

test('D7/MNT-INV-004/J2: one placement with two bindings on one artifact is a shared-artifact set with ONE placement', () => {
  const placements = [placement({
    placementId: 'plc_solo', kind: 'skill', displayName: 'clarity', versions: { contentDigest: 'sha256-x' },
    consumerHosts: ['claude', 'codex'], artifactIds: ['art_solo'],
  })];
  const consumerBindings = [
    binding({ bindingId: 'bnd_claude', placementId: 'plc_solo', artifactId: 'art_solo', consumerLabel: 'Claude' }),
    binding({ bindingId: 'bnd_codex', placementId: 'plc_solo', artifactId: 'art_solo', consumerLabel: 'Codex' }),
  ];
  const conflicts = classifyConflicts({ placements, dependencyEdges: [], consumerBindings }, { installationKey: KEY });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].kind, 'shared-artifact');
  assert.deepEqual(conflicts[0].placementIds, ['plc_solo']);
  assert.deepEqual(conflicts[0].artifactIds, ['art_solo']);
  assert.deepEqual([...conflicts[0].consumerBindingIds].sort(), ['bnd_claude', 'bnd_codex']);
  assert.equal(placements[0].consumerHosts.length, 2);
});

test('D7: no consumerBindings input means no shared-artifact set can fire, however many placements share an artifactId', () => {
  const placements = [
    placement({ placementId: 'plc_a', kind: 'skill', displayName: 'x', artifactIds: ['art_x'] }),
    placement({ placementId: 'plc_b', kind: 'skill', displayName: 'x', artifactIds: ['art_x'] }),
  ];
  assert.deepEqual(classifyConflicts({ placements, dependencyEdges: [] }, { installationKey: KEY }), []);
});

test('conflicts: same-name-different-definition requires equal names but different verified digests', () => {
  const placements = [
    placement({ placementId: 'plc_a', kind: 'skill', displayName: 'clarity', versions: { contentDigest: 'sha256-x' } }),
    placement({ placementId: 'plc_b', kind: 'skill', displayName: 'clarity', versions: { contentDigest: 'sha256-y' } }),
  ];
  const conflicts = classifyConflicts({ placements, dependencyEdges: [] }, { installationKey: KEY });
  assert.deepEqual(conflicts.map((c) => c.kind), ['same-name-different-definition']);
});

test('conflicts: equivalent-transport-registration fires only for equal verified MCP transport', () => {
  const placements = [
    placement({ placementId: 'plc_a', kind: 'mcp-registration', displayName: 'a', transportKey: 'mcp:t1' }),
    placement({ placementId: 'plc_b', kind: 'mcp-registration', displayName: 'b', transportKey: 'mcp:t1' }),
    placement({ placementId: 'plc_c', kind: 'mcp-registration', displayName: 'c', transportKey: 'mcp:t2' }),
  ];
  const conflicts = classifyConflicts({ placements, dependencyEdges: [] }, { installationKey: KEY });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].kind, 'equivalent-transport-registration');
  assert.deepEqual([...conflicts[0].placementIds].sort(), ['plc_a', 'plc_b']);
});

test('conflicts: shadowed-override fires only across scopes for one verified host', () => {
  const placements = [
    placement({ placementId: 'plc_project', kind: 'skill', displayName: 'clarity', consumerHosts: ['claude'], administrativeScope: 'project' }),
    placement({ placementId: 'plc_user', kind: 'skill', displayName: 'clarity', consumerHosts: ['claude'], administrativeScope: 'user' }),
  ];
  const conflicts = classifyConflicts({ placements, dependencyEdges: [] }, { installationKey: KEY });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].kind, 'shadowed-override');
  // Narrower scope (project) is listed first: it is the one that shadows.
  assert.deepEqual(conflicts[0].placementIds, ['plc_project', 'plc_user']);
});

test('conflicts: shadowed-override never fires across two different hosts (no cross-host precedence is inferred)', () => {
  const placements = [
    placement({ placementId: 'plc_a', kind: 'skill', displayName: 'clarity', consumerHosts: ['claude'], administrativeScope: 'project' }),
    placement({ placementId: 'plc_b', kind: 'skill', displayName: 'clarity', consumerHosts: ['codex'], administrativeScope: 'user' }),
  ];
  const conflicts = classifyConflicts({ placements, dependencyEdges: [] }, { installationKey: KEY });
  assert.equal(conflicts.length, 0);
});

test('conflicts: version-requirement-divergence fires when verified consumers require different ranges', () => {
  const edges = deriveDependencyEdges({
    installationKey: KEY,
    descriptors: [
      { fromPlacementId: 'plc_a', toId: 'res_runtime', kind: 'requires-runtime', requirement: '>=20' },
      { fromPlacementId: 'plc_b', toId: 'res_runtime', kind: 'requires-runtime', requirement: '>=22' },
    ],
  });
  const conflicts = classifyConflicts({ placements: [], dependencyEdges: edges }, { installationKey: KEY });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].kind, 'version-requirement-divergence');
  assert.deepEqual([...conflicts[0].placementIds].sort(), ['plc_a', 'plc_b']);
});

test('conflicts: dependency-resolution-collision fires only when the resolved target is itself a known placement', () => {
  const twoPlacements = [
    placement({ placementId: 'plc_a', kind: 'skill', displayName: 'a' }),
    placement({ placementId: 'plc_b', kind: 'skill', displayName: 'b' }),
  ];
  const unresolvableEdges = deriveDependencyEdges({
    installationKey: KEY,
    descriptors: [{
      fromPlacementId: 'plc_a', toId: 'res_unplaced', declaredToId: 'plc_b', kind: 'resolves-through',
    }],
  });
  const unresolved = classifyConflicts({ placements: twoPlacements, dependencyEdges: unresolvableEdges }, { installationKey: KEY });
  // The resolved target ('res_unplaced') is a bare resource, not a placement —
  // there is no second verified placement to name, so nothing is claimed.
  assert.equal(unresolved.length, 0);

  const resolvableEdges = deriveDependencyEdges({
    installationKey: KEY,
    descriptors: [{ fromPlacementId: 'plc_a', toId: 'plc_b', declaredToId: 'plc_a', kind: 'resolves-through' }],
  });
  const resolved = classifyConflicts({ placements: twoPlacements, dependencyEdges: resolvableEdges }, { installationKey: KEY });
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].kind, 'dependency-resolution-collision');
  assert.deepEqual([...resolved[0].placementIds].sort(), ['plc_a', 'plc_b']);
});

test('classifyConflicts is deterministic: identical evidence yields identical conflictIds', () => {
  const placements = [
    placement({ placementId: 'plc_a', kind: 'skill', displayName: 'clarity', versions: { contentDigest: 'sha256-x' } }),
    placement({ placementId: 'plc_b', kind: 'skill', displayName: 'clarity', versions: { contentDigest: 'sha256-x' } }),
  ];
  const first = classifyConflicts({ placements, dependencyEdges: [] }, { installationKey: KEY });
  const second = classifyConflicts({ placements, dependencyEdges: [] }, { installationKey: KEY });
  assert.deepEqual(first, second);
});

test('classifyConflicts on an empty inventory returns no conflicts', () => {
  assert.deepEqual(classifyConflicts({ placements: [], dependencyEdges: [] }, { installationKey: KEY }), []);
});

// ── D1 release-blocker regressions (real-footprint QE smoke) ───────────────
// Realistic shapes, not the sentinel fixtures — reproducing the exact real-
// machine conditions the QE repro scripts found: an agent-managed worktree
// the project census never walks, a catalog.sourceStamps object (not the
// array the earlier unit tests used), and a consumers accountingNote that
// names a home-relative path.

test('D1(a): a project-scoped presence whose path is absent from the project registry never gets a null projectId', () => {
  const repoRoot = '/Users/dev/Development/active/ai/emailibrium';
  const worktreePath = `${repoRoot}/.claude/worktrees/agent-a940e1661237474ba`;
  const footprint = {
    projects: { projects: [{ path: repoRoot, label: 'emailibrium', hosts: ['claude'], remote: null }] },
    catalog: {
      items: [{
        canonicalId: 'mcpServer::agent-worktree-server', kind: 'mcpServer', name: 'agent-worktree-server',
        capabilityName: 'agent-worktree-server', pluginRef: null,
        presence: [{
          host: 'claude', scope: 'project', project: worktreePath, itemPath: null,
          artifactId: 'catalog-artifact-agent-worktree-mcp', digest: null,
          consumer: { mechanism: 'claude-project-mcp', enabled: true, configScope: 'project' },
        }],
      }],
    },
  };
  const { inventory } = invoke({ footprint });
  assert.doesNotThrow(() => assertManagementInventory(inventory));
  const [placement] = inventory.placements;
  assert.equal(placement.administrativeScope, 'project');
  assert.ok(placement.projectId, 'a project placement always carries a projectId');
  assert.ok(isOpaqueId(placement.projectId, 'prj'));
  // Never the same registry entry as the (registered) parent repository.
  const registeredParent = invoke({
    footprint: { projects: footprint.projects, catalog: { items: [] } },
    discovery: { instructionFiles: [{ projectPath: repoRoot, host: 'claude', name: 'CLAUDE.md' }] },
  }).inventory.placements.find((p) => p.kind === 'instruction-context-file');
  assert.notEqual(placement.projectId, registeredParent.projectId);
});

test('D1(a): two unregistered presences under the SAME missing path get the same fallback projectId (deterministic, not per-call random)', () => {
  const worktreePath = '/Users/dev/repo/.claude/worktrees/agent-xyz';
  const footprint = {
    catalog: {
      items: [
        {
          canonicalId: 'mcpServer::one', kind: 'mcpServer', name: 'one', capabilityName: 'one', pluginRef: null,
          presence: [{ host: 'claude', scope: 'project', project: worktreePath, artifactId: 'art-one', digest: null, consumer: { mechanism: 'claude-project-mcp', enabled: true, configScope: 'project' } }],
        },
        {
          canonicalId: 'mcpServer::two', kind: 'mcpServer', name: 'two', capabilityName: 'two', pluginRef: null,
          presence: [{ host: 'claude', scope: 'project', project: worktreePath, artifactId: 'art-two', digest: null, consumer: { mechanism: 'claude-project-mcp', enabled: true, configScope: 'project' } }],
        },
      ],
    },
  };
  const { inventory } = invoke({ footprint });
  assert.equal(inventory.placements.length, 2);
  assert.equal(inventory.placements[0].projectId, inventory.placements[1].projectId);
});

test('D1(b): a real-shaped catalog.sourceStamps object (carrying a home path) never leaks into sourceFingerprint', () => {
  const footprint = {
    catalog: {
      sourceStamps: {
        entries: [{ path: '/Users/dev/.agents/skills', present: true, kind: 'dir', bytes: 4096, mtimeMs: 1_700_000_000_000 }],
        partial: false, observedPaths: 1, totalCandidatePaths: 1, limitation: null,
      },
      items: [],
    },
  };
  const { inventory } = invoke({ footprint });
  assert.ok(!inventory.sourceFingerprint.includes('/Users'));
  assert.ok(!inventory.sourceFingerprint.includes('~'));
  assert.match(inventory.sourceFingerprint, /^[0-9a-f]{64}$/);
});

test('D1(c): a related-storage accountingNote naming a home-relative path is dropped, not carried into technicalDetails', () => {
  const { inventory } = invoke({
    footprint: {
      consumers: {
        rows: [{
          id: 'codex-state-root', label: 'Codex state', group: 'ai-toolchain', kind: 'root', containedBy: null,
          presence: 'present', bytes: { value: 2_000_000_000 },
          accountingNote: 'Everything under ~/.codex: rollouts, ledgers, plugin cache and snapshots.',
        }],
      },
    },
  });
  assert.doesNotThrow(() => assertManagementInventory(inventory));
  const [placement] = inventory.placements;
  assert.deepEqual(placement.technicalDetails, []);
});

test('D1(c): an absolute-path technical detail from any source is also dropped, not just accountingNote', () => {
  const { inventory } = invoke({
    footprint: {
      storage: {
        reclaimables: [{
          id: 'cache:leaky', label: 'Leaky cache', safety: 'regenerable',
          rationale: 'Located at /Users/dev/.cache/leaky and refetched on demand.',
        }],
      },
    },
  });
  const [placement] = inventory.placements;
  assert.deepEqual(placement.technicalDetails, []);
  assert.doesNotThrow(() => assertManagementInventory(inventory));
});


test('model Hosts come from observed route bindings, never the inventory owner', () => {
  const modelSnapshot={models:[{key:{host:'ollama',provider:'ollama',modelId:'demo',scopeId:'user'},identity:'demo-id',displayName:'demo'}],bindings:[]};
  assert.deepEqual(invoke({footprint:{},modelSnapshot}).inventory.placements[0].consumerHosts,[]);
  modelSnapshot.bindings=[{identity:'demo-id',consumer:'route:implementation',host:'codex',consumerState:'runtime-proven'},{identity:'demo-id',consumer:'integration:review',host:'claude',consumerState:'configured'}];
  assert.deepEqual(invoke({footprint:{},modelSnapshot}).inventory.placements[0].consumerHosts,['codex','claude']);
});


test('classification metadata preserves catalog-only project and placement identities', () => {
  const footprint=baseFootprint();
  footprint.projects={projects:[]};
  for(const item of footprint.catalog.items)for(const presence of item.presence){presence.project='/work/catalog-only';presence.scope='project';}
  const before=invoke({footprint}).inventory;
  footprint.catalog.projectMetadata=[{path:'/work/catalog-only',projectKind:'folder'}];
  const after=invoke({footprint}).inventory;
  assert.deepEqual(after.placements.map(p=>[p.projectId,p.placementId]),before.placements.map(p=>[p.projectId,p.placementId]));
  assert.ok(after.placements.every(p=>p.projectKind==='folder'));
});
