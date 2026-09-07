// ADR-0048 cross-view parity, golden schema, privacy, determinism, and
// identity-separation property tests for the management projection. This
// file constructs one realistic, production-shaped footprint fixture
// (Catalog v4 + install + storage + runtime + projects sections, a hook read
// model, a model snapshot, and provider detections) exercising J1 (Lightpanda,
// missing dependency), J7 (WSL), and J9 (hook definitions-differ), then
// verifies every Catalog v4 artifact surfaces exactly once at the correct
// grain.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assertManagementInventory, isProhibitedLabel } from '../../src/lib/maintenance/management/model.mjs';
import { detectEnvironments } from '../../src/lib/maintenance/management/environments.mjs';
import { buildManagementInventory } from '../../src/lib/maintenance/management/projection.mjs';

const KEY = 'parity-installation-key-0123456789abcdef';
const NOW = () => Date.parse('2026-09-05T12:00:00.000Z');

/** A production-shaped CatalogInventory v4 slice: J1 Lightpanda (missing
 *  executable), J2 one physical skill shared by Claude and Codex, a plugin,
 *  and a project-scoped skill sharing the same skill's content digest under
 *  a DIFFERENT physical artifact (exercising duplicate-placement — D7: never
 *  also shared-artifact, since the two copies are not the same carrier). */
function realisticCatalog() {
  return {
    sourceStamps: [{ id: 'claude-user-mcp', value: 'inv-a' }, { id: 'codex-mcp', value: 'inv-b' }],
    items: [
      {
        canonicalId: 'mcpserver::lightpanda', kind: 'mcpServer', name: 'lightpanda', capabilityName: 'lightpanda',
        pluginRef: null,
        presence: [{
          host: 'claude', scope: 'user', project: null, itemPath: null,
          artifactId: 'catalog-artifact-lightpanda-abc123', digest: null,
          consumer: { mechanism: 'claude-json-mcp', enabled: true, configScope: 'user' },
        }],
      },
      {
        canonicalId: 'skill::clarity', kind: 'skill', name: 'clarity', capabilityName: 'clarity', pluginRef: null,
        presence: [
          {
            host: 'claude', scope: 'user', project: null, itemPath: '/private/home/.claude/skills/clarity',
            artifactId: 'catalog-artifact-clarity-tree-def456', digest: { status: 'measured', value: 'sha256-clarity-tree' },
            consumer: { mechanism: 'claude-user-skills', enabled: true, configScope: 'user' },
          },
          {
            host: 'codex', scope: 'user', project: null, itemPath: '/private/home/.agents/skills/clarity',
            artifactId: 'catalog-artifact-clarity-tree-def456', digest: { status: 'measured', value: 'sha256-clarity-tree' },
            consumer: { mechanism: 'codex-agents-skills', enabled: true, configScope: 'user' },
          },
        ],
      },
      {
        canonicalId: 'skill::clarity::project', kind: 'skill', name: 'clarity', capabilityName: 'clarity', pluginRef: null,
        presence: [{
          host: 'claude', scope: 'project', project: '/private/home/dev/agentic-kit',
          itemPath: '/private/home/dev/agentic-kit/.claude/skills/clarity',
          artifactId: 'catalog-artifact-clarity-project-ghi789', digest: { status: 'measured', value: 'sha256-clarity-tree' },
          consumer: { mechanism: 'claude-project-skills', enabled: true, configScope: 'project' },
        }],
      },
      {
        canonicalId: 'plugin::frontend-design@claude-plugins', kind: 'plugin', name: 'frontend-design@claude-plugins',
        capabilityName: 'frontend-design', pluginRef: 'frontend-design@claude-plugins',
        presence: [{
          host: 'claude', scope: 'user', project: null, itemPath: null,
          artifactId: 'catalog-artifact-plugin-jkl012', digest: { status: 'measured', value: '0.3.1' },
          provider: { ref: 'frontend-design@claude-plugins' },
          consumer: { mechanism: 'claude-plugin-cli', enabled: true, configScope: 'user' },
        }],
      },
    ],
  };
}

function realisticFootprint() {
  return {
    catalog: realisticCatalog(),
    install: {
      tools: [
        { tool: 'ruflo', label: 'ruflo', present: true, version: '3.38.8', installMethod: 'npm' },
        { tool: 'lightpanda', label: 'lightpanda', present: false },
      ],
    },
    storage: {
      reclaimables: [{
        id: 'cache:npx-stale-env', label: 'Stale npx environment', safety: 'regenerable',
        rationale: 'The owning tool refetches this on demand.',
      }],
    },
    runtime: {
      daemons: { entries: [{ pid: 4242, workspace: '/private/home/dev/gone-project', workspaceExists: false, ageSecs: 86_400 }] },
    },
    projects: {
      projects: [{
        path: '/private/home/dev/agentic-kit', label: 'agentic-kit', hosts: ['claude'],
        remote: { status: 'linked', webUrl: 'https://github.com/example/agentic-kit' },
      }],
    },
  };
}

function realisticHookReadModel() {
  // Two competing definitions for the same (host, lifecyclePoint) slot — a
  // real, field-based definitions-differ signal from the read model's own
  // grouping keys (see projection.mjs `hookDefinitionKeyGroups`), not a
  // title/prose heuristic.
  return {
    definitionGroups: [
      {
        behaviorId: 'codex-session-start-automemory-current', host: 'codex', lifecyclePoint: 'SessionStart', handlerKind: 'command',
        placements: [{ occurrenceId: 'occ-automemory-1', source: { label: 'AutoMemory' }, selectionState: 'selected' }],
      },
      {
        behaviorId: 'codex-session-start-automemory-legacy', host: 'codex', lifecyclePoint: 'SessionStart', handlerKind: 'command',
        placements: [{ occurrenceId: 'occ-automemory-legacy-1', source: { label: 'AutoMemory (legacy)' }, selectionState: 'selected' }],
      },
    ],
    findings: [{
      findingId: 'legacy-ruflo-project-hook', code: 'legacy-ruflo-project-hook', title: 'Legacy helper is incompatible with this host',
      explanation: 'The audit recognized a legacy Ruflo Claude helper projection in Codex. Retirement requires exact source and replacement evidence.',
      affectedOccurrenceIds: ['occ-automemory-legacy-1'],
    }],
    observations: [],
  };
}

function realisticInputs(overrides = {}) {
  return {
    footprint: realisticFootprint(),
    hookReadModel: realisticHookReadModel(),
    discovery: {
      instructionFiles: [{ projectPath: '/private/home/dev/agentic-kit', host: 'claude', name: 'CLAUDE.md' }],
      dependencyProbes: [{
        subjectKind: 'mcp-registration', subjectSelector: 'lightpanda', host: 'claude', requirement: 'lightpanda',
        requirementKind: 'executable', satisfied: false, authority: 'claude configuration + PATH probe',
      }],
    },
    environment: { platform: 'darwin' },
    installationKey: KEY,
    now: NOW,
    ...overrides,
  };
}

function withCompleteSourceCoverage(inputs) {
  const environments = detectEnvironments({
    platform: inputs.environment.platform, release: inputs.environment.release, arch: inputs.environment.arch,
    wslDistributions: inputs.environment.wsl ?? [],
  }, inputs.installationKey);
  return {
    ...inputs,
    sourceCoverage: environments.map((entry, index) => ({
      sourceId: `src_${'a'.repeat(20)}${index}`, environmentId: entry.environmentId, state: 'complete',
      visited: 1, completedPartitions: 1, pendingPartitions: 0,
    })),
  };
}

// ── golden / schema ──────────────────────────────────────────────────────

test('golden: a realistic production-shaped footprint projects into a schema-valid inventory', () => {
  const { inventory } = buildManagementInventory(withCompleteSourceCoverage(realisticInputs()));
  assert.doesNotThrow(() => assertManagementInventory(inventory));
  assert.ok(inventory.placements.length >= 6);
  assert.ok(inventory.resources.length >= 6);
});

// ── cross-view parity (MNT-INV-003/004) ─────────────────────────────────

test('parity: every Catalog v4 physical artifact appears exactly once at the correct grain', () => {
  const { inventory } = buildManagementInventory(withCompleteSourceCoverage(realisticInputs()));
  const catalogArtifactIds = new Set();
  for (const item of realisticCatalog().items) {
    for (const presence of item.presence) catalogArtifactIds.add(presence.artifactId);
  }
  // clarity (user) and clarity (project) share one content digest but are
  // observed via two DIFFERENT physical locators, so they remain two
  // distinct management artifacts — never collapsed, never duplicated.
  assert.equal(catalogArtifactIds.size, 4);
  // Plus one artifact each for: the ruflo executable, the storage cache
  // object, the orphaned daemon process, the project instruction file, and
  // one per hook occurrence (two, competing for one SessionStart slot) —
  // none of which is a Catalog v4 artifact.
  assert.equal(inventory.artifacts.length, catalogArtifactIds.size + 6);
});

test('parity/MNT-INV-004: the shared clarity skill is one placement with two bindings, not two placements', () => {
  const { inventory } = buildManagementInventory(withCompleteSourceCoverage(realisticInputs()));
  const clarityUser = inventory.placements.filter((p) => (
    p.kind === 'skill' && p.displayName === 'clarity' && p.administrativeScope === 'user'
  ));
  assert.equal(clarityUser.length, 1);
  assert.equal(clarityUser[0].consumerBindingIds.length, 2);
  assert.deepEqual([...clarityUser[0].consumerHosts].sort(), ['claude', 'codex']);
});

test('D7/parity: the user-scope clarity copy is shared-artifact (J2); the project-scope copy makes it ALSO duplicate-placement, with different member lists', () => {
  const { inventory } = buildManagementInventory(withCompleteSourceCoverage(realisticInputs()));
  const skillPlacements = inventory.placements.filter((p) => p.kind === 'skill' && p.displayName === 'clarity');
  assert.equal(skillPlacements.length, 2);
  assert.equal(new Set(skillPlacements.map((p) => p.artifactIds[0])).size, 2, 'the two copies are different physical artifacts');
  const userScope = skillPlacements.find((p) => p.administrativeScope === 'user');
  const projectScope = skillPlacements.find((p) => p.administrativeScope === 'project');

  const kinds = inventory.conflictSets.map((c) => c.kind).sort();
  assert.deepEqual(kinds, ['duplicate-placement', 'shared-artifact']);

  const shared = inventory.conflictSets.find((c) => c.kind === 'shared-artifact');
  // J2: the user-scope copy alone (claude + codex bindings on one artifact)
  // is its own shared-artifact set — one placement.
  assert.deepEqual(shared.placementIds, [userScope.placementId]);
  assert.deepEqual(shared.artifactIds, [userScope.artifactIds[0]]);
  assert.equal(shared.consumerBindingIds.length, 2);

  const duplicate = inventory.conflictSets.find((c) => c.kind === 'duplicate-placement');
  // The SAME user-scope placement also names the larger duplicate-placement
  // set together with the project copy — a different member list, so both
  // conflicts stand (D7: no two DIFFERENT kinds share one EXACT member list;
  // this is not that — the lists differ).
  assert.deepEqual([...duplicate.placementIds].sort(), [projectScope.placementId, userScope.placementId].sort());
});

test('J1: Lightpanda projects to one placement, a missing-verified-dependency condition, and omits provenance', () => {
  const { inventory } = buildManagementInventory(withCompleteSourceCoverage(realisticInputs()));
  const lightpanda = inventory.placements.find((p) => p.displayName === 'lightpanda');
  assert.ok(lightpanda);
  assert.deepEqual(lightpanda.conditions, ['missing-verified-dependency']);
  assert.equal('provenance' in lightpanda.evidenceScorecard, false);
  const provenanceForLightpanda = inventory.provenanceAssertions.filter((a) => a.subjectId === lightpanda.placementId);
  assert.equal(provenanceForLightpanda.length, 0);
  const edge = inventory.dependencyEdges.find((e) => e.fromPlacementId === lightpanda.placementId);
  assert.equal(edge.kind, 'requires-executable');
  assert.equal(edge.satisfied, false);
});

test('J7: WSL — one executable resource carries three environment-qualified placements and two windows-hosts-wsl edges', () => {
  const environments = detectEnvironments({ platform: 'win32', wslDistributions: ['Ubuntu', 'Debian'] }, KEY);
  const [windows, ubuntu, debian] = environments;
  const inputs = withCompleteSourceCoverage(realisticInputs({
    footprint: {
      install: {
        tools: [
          { tool: 'git', label: 'git', present: true, version: '2.45.0', environmentId: windows.environmentId },
          { tool: 'git', label: 'git', present: true, version: '2.45.0', environmentId: ubuntu.environmentId },
          { tool: 'git', label: 'git', present: true, version: '2.45.0', environmentId: debian.environmentId },
        ],
      },
    },
    hookReadModel: null,
    discovery: {},
    environment: { platform: 'win32', wsl: ['Ubuntu', 'Debian'] },
  }));
  const { inventory } = buildManagementInventory(inputs);
  const gitResource = inventory.resources.find((r) => r.kind === 'executable' && r.displayName === 'git');
  assert.equal(gitResource.placementIds.length, 3);
  const gitPlacements = inventory.placements.filter((p) => p.resourceId === gitResource.resourceId);
  assert.deepEqual([...new Set(gitPlacements.map((p) => p.environmentId))].sort(), [windows, ubuntu, debian].map((e) => e.environmentId).sort());
  const wslEdges = inventory.dependencyEdges.filter((e) => e.kind === 'windows-hosts-wsl');
  assert.equal(wslEdges.length, 2);
});

test('J9: two competing hook occurrences stay inventory-only evidence — a condition, no guidance, no elevated status', () => {
  const { inventory } = buildManagementInventory(withCompleteSourceCoverage(realisticInputs()));
  const hookPlacements = inventory.placements.filter((p) => p.kind === 'hook');
  assert.equal(hookPlacements.length, 2);
  for (const hookPlacement of hookPlacements) {
    assert.deepEqual(hookPlacement.conditions, ['definitions-differ']);
    assert.equal(hookPlacement.guidanceLane, null);
  }
  assert.equal(inventory.guidanceEntries.length, 0);
});

test('J10-adjacent: an orphaned daemon and a reproducible cache remain calm inventory evidence', () => {
  const { inventory } = buildManagementInventory(withCompleteSourceCoverage(realisticInputs()));
  const daemon = inventory.placements.find((p) => p.conditions.includes('orphaned-process'));
  const cache = inventory.placements.find((p) => p.kind === 'cache');
  assert.ok(daemon);
  assert.ok(cache);
  assert.deepEqual(cache.conditions, ['reproducible-cache']);
});

// ── privacy ────────────────────────────────────────────────────────────

const LOCAL_PATH_LIKE = /(?:^|[\s"'([{=:])(?:file:\/\/\/?|~[\\/]|[A-Za-z]:[\\/]|\\\\|\/(?!\/))/u;

function walkForPaths(value, trail = '$') {
  if (typeof value === 'string') {
    assert.equal(LOCAL_PATH_LIKE.test(value), false, `local-path-shaped string at ${trail}: ${value}`);
    return;
  }
  if (Array.isArray(value)) { value.forEach((entry, i) => walkForPaths(entry, `${trail}[${i}]`)); return; }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) walkForPaths(entry, `${trail}.${key}`);
  }
}

test('privacy: a path-bearing footprint yields an inventory with no local path string anywhere', () => {
  const inputs = withCompleteSourceCoverage(realisticInputs());
  const { inventory, privateLocators } = buildManagementInventory(inputs);
  assert.doesNotThrow(() => assertManagementInventory(inventory));
  walkForPaths(inventory);
  // The real paths DO exist, but only in the owner-private, out-of-band map —
  // never inside the returned inventory.
  assert.ok(privateLocators.size > 0);
  for (const locator of privateLocators.values()) assert.ok(typeof locator.path === 'string' && locator.path.length > 0);
});

test('privacy: no exactLocatorRef field ever appears on a placement', () => {
  const { inventory } = buildManagementInventory(withCompleteSourceCoverage(realisticInputs()));
  for (const placement of inventory.placements) assert.equal('exactLocatorRef' in placement, false);
});

test('privacy: no credential value or account identifier appears anywhere, only mechanism names', () => {
  const inputs = withCompleteSourceCoverage(realisticInputs({
    providerDetections: {
      providers: {
        openai: { configured: true, reachable: true, credentialPresent: true, credentialMechanism: 'environment-variable' },
      },
    },
  }));
  const { inventory } = buildManagementInventory(inputs);
  const serialized = JSON.stringify(inventory);
  assert.ok(!serialized.includes('sk-'), 'no token-shaped string leaked');
  const credential = inventory.placements.find((p) => p.kind === 'credential-readiness');
  assert.equal(credential.credentialMechanism, 'environment-variable');
});

// ── language policy ──────────────────────────────────────────────────────

test('language policy: nothing in the realistic inventory carries a prohibited label', () => {
  const { inventory } = buildManagementInventory(withCompleteSourceCoverage(realisticInputs()));
  for (const placement of inventory.placements) {
    assert.equal(isProhibitedLabel(placement.displayName), false);
    for (const detail of placement.technicalDetails) assert.equal(isProhibitedLabel(detail), false);
  }
  for (const conflict of inventory.conflictSets) {
    assert.equal(isProhibitedLabel(conflict.proves), false);
    assert.equal(isProhibitedLabel(conflict.doesNotProve), false);
  }
});

// ── determinism ──────────────────────────────────────────────────────────

test('determinism: identical input yields identical inventory ids and ordering', () => {
  const inputs = withCompleteSourceCoverage(realisticInputs());
  const first = buildManagementInventory(inputs).inventory;
  const second = buildManagementInventory(withCompleteSourceCoverage(realisticInputs())).inventory;
  assert.equal(first.inventoryId, second.inventoryId);
  assert.deepEqual(first.placements.map((p) => p.placementId), second.placements.map((p) => p.placementId));
  assert.deepEqual(first.resources.map((r) => r.resourceId), second.resources.map((r) => r.resourceId));
  assert.deepEqual(first.conflictSets.map((c) => c.conflictId), second.conflictSets.map((c) => c.conflictId));
});

test('determinism: a different installation key yields different opaque ids for the same facts', () => {
  const a = buildManagementInventory(withCompleteSourceCoverage(realisticInputs())).inventory;
  const b = buildManagementInventory(withCompleteSourceCoverage(realisticInputs({ installationKey: `${KEY}-other` }))).inventory;
  assert.notEqual(a.placements[0]?.placementId, b.placements[0]?.placementId);
});

// ── property-style: identity separation over randomized placements ──────

function mulberry32(seed) {
  let state = seed;
  return () => {
    state |= 0; state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('property: randomized catalog placements — equal identity tuples always agree, unequal tuples never collide', () => {
  const random = mulberry32(20260905);
  const scopes = ['user', 'project'];
  const projects = ['/repo/a', '/repo/b', null];
  const names = ['clarity', 'brainstorming', 'writing-plans'];
  // Every independent inventory build below is deterministic (identity.mjs is
  // a pure HMAC over material), so the same (name, scope, project, artifact)
  // tuple recurring across iterations is EXPECTED to reproduce the same id —
  // that is the property under test, not a collision. What must never happen
  // is two DIFFERENT tuples landing on the same id, or one tuple landing on
  // two different ids.
  const placementIdByTuple = new Map();
  const tupleByPlacementId = new Map();
  const seenResourceIds = new Map(); // resourceId -> the (name, scope, project) tuple that produced it
  for (let i = 0; i < 200; i += 1) {
    const name = names[Math.floor(random() * names.length)];
    const scope = scopes[Math.floor(random() * scopes.length)];
    const project = scope === 'project' ? projects[Math.floor(random() * (projects.length - 1))] : null;
    const artifactSuffix = Math.floor(random() * 3); // occasional distinct physical copies of the same name+scope
    const inputs = withCompleteSourceCoverage(realisticInputs({
      footprint: {
        catalog: {
          items: [{
            canonicalId: `skill::${name}`, kind: 'skill', name, capabilityName: name, pluginRef: null,
            presence: [{
              host: 'claude', scope, project,
              itemPath: `/generated/${name}/${artifactSuffix}`,
              artifactId: `catalog-artifact-${name}-${scope}-${project ?? 'none'}-${artifactSuffix}`,
              digest: { status: 'measured', value: `sha256-${name}` },
              consumer: { mechanism: 'claude-user-skills', enabled: true, configScope: scope },
            }],
          }],
        },
      },
      hookReadModel: null,
      discovery: project ? { instructionFiles: [], dependencyProbes: [] } : {},
      environment: { platform: 'darwin' },
    }));
    // A project-scoped placement needs a project entry in the registry to
    // receive a projectId; supply one via the projects footprint section.
    if (project) {
      inputs.footprint.projects = { projects: [{ path: project, label: project, hosts: [], remote: null }] };
    }
    const { inventory } = buildManagementInventory(inputs);
    for (const placement of inventory.placements) {
      const tuple = `${name} ${scope} ${project ?? 'none'} ${artifactSuffix}`;
      const priorId = placementIdByTuple.get(tuple);
      if (priorId) {
        assert.equal(placement.placementId, priorId, 'an equal identity tuple must always reproduce the same placementId');
      } else {
        placementIdByTuple.set(tuple, placement.placementId);
      }
      const priorTuple = tupleByPlacementId.get(placement.placementId);
      if (priorTuple) {
        assert.equal(priorTuple, tuple, 'two different identity tuples must never collide on one placementId');
      } else {
        tupleByPlacementId.set(placement.placementId, tuple);
      }
    }
    // Logical identity is kind + name + verified digest — NEVER scope or
    // project (the grouping-defect fix). This fixture's digest is a pure
    // function of `name` (`sha256-${name}`), so every iteration sharing a
    // name — regardless of scope, project, or artifactSuffix — must resolve
    // to the SAME resourceId; a different name must never collide with it.
    for (const resource of inventory.resources) {
      assert.equal(resource.kind, 'skill');
      const priorName = seenResourceIds.get(resource.resourceId);
      if (priorName) {
        assert.equal(priorName, name, 'equal resourceId must always come from an equal (kind, name, digest) tuple');
      } else {
        seenResourceIds.set(resource.resourceId, name);
      }
    }
  }
  // Exactly one resourceId per distinct name: three names, three resources,
  // however many (scope, project, artifactSuffix) placements landed under
  // each one across the 200 random iterations.
  assert.equal(seenResourceIds.size, 3, 'exactly one resourceId per distinct name');
  assert.deepEqual([...new Set(seenResourceIds.values())].sort(), ['brainstorming', 'clarity', 'writing-plans']);
});

// ── D1 broad guard: every mapper at once, in the exact realistic shapes the
// real-server QE smoke found breaking (an unregistered project worktree, a
// catalog.sourceStamps OBJECT rather than an array, and free-text notes
// naming home-relative paths). This is deliberately NOT built from the
// sentinel fixtures — every field here mirrors what the real footprint
// collectors and adapters actually produce.

function d1BroadFootprint() {
  const repoRoot = '/Users/dev/Development/active/ai/emailibrium';
  const worktreePath = `${repoRoot}/.claude/worktrees/agent-a940e1661237474ba`;
  return {
    catalog: {
      sourceStamps: {
        entries: [
          { path: '/Users/dev/.agents/skills', present: true, kind: 'dir', bytes: 4096, mtimeMs: 1_700_000_000_000 },
          { path: '/Users/dev/.claude/skills', present: true, kind: 'dir', bytes: 8192, mtimeMs: 1_700_000_500_000 },
        ],
        partial: false, observedPaths: 2, totalCandidatePaths: 2, limitation: null,
      },
      items: [
        {
          canonicalId: 'skill::clarity', kind: 'skill', name: 'clarity', capabilityName: 'clarity', pluginRef: null,
          presence: [{
            host: 'claude', scope: 'user', project: null, itemPath: '/Users/dev/.claude/skills/clarity',
            artifactId: 'catalog-artifact-clarity', digest: { status: 'measured', value: 'sha256-clarity' },
            consumer: { mechanism: 'claude-user-skills', enabled: true, configScope: 'user' },
          }],
        },
        {
          // The exact real-world shape that broke D1(a): a project-scoped
          // presence pointing at an agent-managed worktree the project
          // census never discovered.
          canonicalId: 'mcpServer::agent-worktree-server', kind: 'mcpServer', name: 'agent-worktree-server',
          capabilityName: 'agent-worktree-server', pluginRef: null,
          presence: [{
            host: 'claude', scope: 'project', project: worktreePath, itemPath: null,
            artifactId: 'catalog-artifact-agent-worktree-mcp', digest: null,
            consumer: { mechanism: 'claude-project-mcp', enabled: true, configScope: 'project' },
          }],
        },
      ],
    },
    install: {
      tools: [{ tool: 'ruflo', label: 'ruflo', present: true, version: '3.38.8', installMethod: 'npm' }],
    },
    storage: {
      reclaimables: [{
        id: 'cache:npx-stale-env', label: 'Stale npx environment', safety: 'regenerable',
        rationale: 'Located at /Users/dev/.cache/npx and refetched on demand.',
      }],
    },
    consumers: {
      rows: [{
        id: 'codex-state-root', label: 'Codex state', group: 'ai-toolchain', kind: 'root', containedBy: null,
        presence: 'present', bytes: { value: 2_000_000_000 },
        accountingNote: 'Everything under ~/.codex: rollouts, ledgers, plugin cache and snapshots.',
      }],
    },
    projects: {
      projects: [{ path: repoRoot, label: 'emailibrium', hosts: ['claude'], remote: null }],
    },
  };
}

function d1BroadHookReadModel() {
  return {
    definitionGroups: [{
      behaviorId: 'codex-session-start-A', host: 'codex', lifecyclePoint: 'SessionStart', handlerKind: 'command',
      placements: [{ occurrenceId: 'occ-1', source: { label: 'AutoMemory' }, selectionState: 'selected' }],
    }],
    findings: [], observations: [],
  };
}

function d1BroadModelSnapshot() {
  return {
    models: [{
      key: { host: 'ollama', provider: 'ollama', modelId: 'llama3.2:3b', scopeId: 'user', digest: 'sha256-llama' },
      identity: 'model-identity-1', displayName: 'llama3.2:3b',
    }],
    bindings: [{ identity: 'model-identity-1', consumer: 'route:implementation', consumerState: 'runtime-proven' }],
  };
}

test('D1 broad guard: every mapper together, from realistic (non-sentinel) shapes, still passes assertManagementInventory', () => {
  const footprint = d1BroadFootprint();
  const inputs = withCompleteSourceCoverage({
    footprint, hookReadModel: d1BroadHookReadModel(), modelSnapshot: d1BroadModelSnapshot(),
    discovery: { instructionFiles: [{ projectPath: footprint.projects.projects[0].path, host: 'claude', name: 'CLAUDE.md' }] },
    environment: { platform: 'darwin' }, installationKey: KEY, now: NOW,
  });
  const { inventory } = buildManagementInventory(inputs);
  assert.doesNotThrow(() => assertManagementInventory(inventory));

  const projectPlacementsMissingId = inventory.placements.filter((p) => p.administrativeScope === 'project' && !p.projectId);
  assert.equal(projectPlacementsMissingId.length, 0);

  assert.ok(!inventory.sourceFingerprint.includes('/Users'));
  assert.match(inventory.sourceFingerprint, /^[0-9a-f]{64}$/);

  walkForPaths(inventory);

  const kinds = new Set(inventory.placements.map((p) => p.kind));
  for (const expected of ['skill', 'mcp-registration', 'executable', 'cache', 'related-storage', 'model', 'instruction-context-file']) {
    assert.ok(kinds.has(expected), `expected a ${expected} placement in the mixed guard inventory`);
  }
});
