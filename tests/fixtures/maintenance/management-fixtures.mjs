// Shared ADR-0048 sentinel-journey fixtures. Every slice (projection, query,
// guidance, discovery, API, UI, CLI) tests against these exact inventories so
// the swarm cannot drift apart on shape. Fixtures are privacy-projected: they
// carry no local paths, credential values, or private registry URLs.
import {
  MANAGEMENT_INVENTORY_SCHEMA, MANAGEMENT_SCHEMA_VERSION, assertManagementInventory, deepFreeze,
  opaqueId,
} from '../../../src/lib/maintenance/management/model.mjs';

export const FIXTURE_KEY = 'fixture-installation-key-0123456789abcdef';
export const FIXTURE_NOW = '2026-09-05T12:00:00.000Z';
export const id = (prefix, material) => opaqueId(prefix, material, FIXTURE_KEY);

const evidence = (subjectId, field, value, {
  grade = 'verified', authority = 'catalog-v4', sourceRef = 'catalog:claude-user-mcp',
  freshness = 'fresh', completeness = 'complete', scope = 'user', extra = {},
} = {}) => ({
  subjectId, field, value, grade, authority, sourceRef, capturedAt: FIXTURE_NOW,
  freshness, completeness, scope, ...extra,
});

export const ENV_MAC = deepFreeze({
  environmentId: id('env', { kind: 'macos', host: 'fixture-mac' }), kind: 'macos', osFamily: 'darwin',
  osVersionFamily: '25', architecture: 'arm64', displayLabel: 'This Mac',
});
export const ENV_WIN = deepFreeze({
  environmentId: id('env', { kind: 'windows', host: 'fixture-win' }), kind: 'windows', osFamily: 'windows',
  osVersionFamily: '11', architecture: 'x64', displayLabel: 'Windows host',
});
export const ENV_WSL_UBUNTU = deepFreeze({
  environmentId: id('env', { kind: 'wsl', host: 'fixture-win', distro: 'Ubuntu' }), kind: 'wsl',
  osFamily: 'linux', osVersionFamily: 'ubuntu-24.04', architecture: 'x64',
  parentEnvironmentId: ENV_WIN.environmentId, displayLabel: 'WSL · Ubuntu',
});
export const ENV_WSL_DEBIAN = deepFreeze({
  environmentId: id('env', { kind: 'wsl', host: 'fixture-win', distro: 'Debian' }), kind: 'wsl',
  osFamily: 'linux', osVersionFamily: 'debian-12', architecture: 'x64',
  parentEnvironmentId: ENV_WIN.environmentId, displayLabel: 'WSL · Debian',
});

const PROJECT_KIT = id('prj', { repo: 'agentic-kit', worktree: 'main' });
const PROJECT_KIT_WT = id('prj', { repo: 'agentic-kit', worktree: 'feature' });
const PROJECT_OTHER_KIT = id('prj', { repo: 'other/agentic-kit' });

function coverage(sourceId, environmentId, state, extra = {}) {
  return {
    sourceId, environmentId, state, visited: 128, estimated: null,
    completedPartitions: state === 'complete' ? 4 : 2, pendingPartitions: state === 'complete' ? 0 : 2,
    limitingReason: state === 'complete' ? null : 'work-slice',
    lastCompletedAt: state === 'complete' ? FIXTURE_NOW : null, label: 'Claude user configuration',
    ...extra,
  };
}

/** J1 — dangling Lightpanda MCP registration (missing executable) plus
 *  J2 — one physical skill tree consumed by Claude and Codex, plus
 *  J9 — a remedy-free verified condition, plus a healthy plugin. */
export function baseInventory() {
  const env = ENV_MAC.environmentId;
  const srcClaude = id('src', { automatic: 'claude-user' });
  const srcCodex = id('src', { automatic: 'codex-user' });
  const srcProjects = id('src', { automatic: 'projects' });

  const lightpandaRes = id('res', { kind: 'mcp-registration', host: 'claude', name: 'lightpanda' });
  const lightpandaPlc = id('plc', { res: lightpandaRes, env, scope: 'user' });
  const lightpandaArt = id('art', { selector: 'mcpServers.lightpanda', file: 'claude-json' });
  const lightpandaBnd = id('bnd', { plc: lightpandaPlc, consumer: 'claude' });
  const lightpandaExeRes = id('res', { kind: 'executable', name: 'lightpanda' });

  const skillRes = id('res', { kind: 'skill', name: 'clarity' });
  const skillPlc = id('plc', { res: skillRes, env, scope: 'user' });
  const skillArt = id('art', { tree: 'skills/clarity' });
  const skillBndClaude = id('bnd', { plc: skillPlc, consumer: 'claude' });
  const skillBndCodex = id('bnd', { plc: skillPlc, consumer: 'codex' });

  const pluginRes = id('res', { kind: 'plugin', host: 'claude', name: 'frontend-design@claude-plugins' });
  const pluginPlc = id('plc', { res: pluginRes, env, scope: 'user' });
  const pluginArt = id('art', { package: 'frontend-design@claude-plugins' });
  const pluginBnd = id('bnd', { plc: pluginPlc, consumer: 'claude' });

  const hookRes = id('res', { kind: 'hook', host: 'codex', name: 'SessionStart AutoMemory' });
  const hookPlc = id('plc', { res: hookRes, env, scope: 'user' });
  const hookArt = id('art', { selector: 'hooks.SessionStart[0]', file: 'codex-hooks' });
  const hookBnd = id('bnd', { plc: hookPlc, consumer: 'codex' });

  const projectSkillRes = id('res', { kind: 'skill', name: 'clarity', scope: 'project' });
  const projectSkillPlc = id('plc', { res: projectSkillRes, env, scope: 'project', project: PROJECT_KIT });
  const projectSkillArt = id('art', { tree: 'project/.claude/skills/clarity' });
  const projectSkillBnd = id('bnd', { plc: projectSkillPlc, consumer: 'claude' });

  const credRes = id('res', { kind: 'credential-readiness', provider: 'openai' });
  const credPlc = id('plc', { res: credRes, env, scope: 'user' });
  const credArt = id('art', { mechanism: 'environment-variable', provider: 'openai' });
  const credBnd = id('bnd', { plc: credPlc, consumer: 'codex' });

  const guidanceSteps = id('gid', { plc: lightpandaPlc, lane: 'steps' });
  const guidanceDecision = id('gid', { plc: lightpandaPlc, lane: 'decision' });
  const guidanceApply = id('gid', { plc: pluginPlc, lane: 'apply' });

  const inventory = {
    schemaVersion: MANAGEMENT_SCHEMA_VERSION,
    schema: MANAGEMENT_INVENTORY_SCHEMA,
    inventoryId: id('inv', { fixture: 'base', fingerprint: 'fp-base' }),
    capturedAt: FIXTURE_NOW,
    sourceFingerprint: 'fp-base',
    environments: [ENV_MAC],
    sourceCoverage: [
      coverage(srcClaude, env, 'complete'),
      coverage(srcCodex, env, 'complete', { label: 'Codex user configuration' }),
      coverage(srcProjects, env, 'complete', { label: 'Projects', visited: 84231 }),
    ],
    resources: [
      { resourceId: lightpandaRes, kind: 'mcp-registration', displayName: 'Lightpanda', namespace: 'claude', placementIds: [lightpandaPlc] },
      { resourceId: lightpandaExeRes, kind: 'executable', displayName: 'lightpanda', placementIds: [] },
      { resourceId: skillRes, kind: 'skill', displayName: 'clarity', placementIds: [skillPlc] },
      { resourceId: projectSkillRes, kind: 'skill', displayName: 'clarity', placementIds: [projectSkillPlc] },
      { resourceId: pluginRes, kind: 'plugin', displayName: 'frontend-design', namespace: 'claude-plugins', publisher: 'claude-plugins', placementIds: [pluginPlc] },
      { resourceId: hookRes, kind: 'hook', displayName: 'SessionStart AutoMemory', namespace: 'codex', placementIds: [hookPlc] },
      { resourceId: credRes, kind: 'credential-readiness', displayName: 'OpenAI credential', placementIds: [credPlc] },
    ],
    artifacts: [
      { artifactId: lightpandaArt, carrier: 'config-selector', label: 'Claude configuration' },
      { artifactId: skillArt, carrier: 'directory-tree', label: 'User skills directory', digest: 'sha256-clarity-tree' },
      { artifactId: projectSkillArt, carrier: 'directory-tree', label: 'Project skills directory', digest: 'sha256-clarity-tree' },
      { artifactId: pluginArt, carrier: 'package-record', label: 'Claude plugin cache' },
      { artifactId: hookArt, carrier: 'config-selector', label: 'Codex hooks configuration' },
      { artifactId: credArt, carrier: 'config-selector', label: 'Environment variable' },
    ],
    consumerBindings: [
      { bindingId: lightpandaBnd, placementId: lightpandaPlc, artifactId: lightpandaArt, consumerKind: 'host', consumerLabel: 'Claude', mechanism: 'claude-json-mcp', enabled: true, effectiveScope: 'user', grade: 'verified', affectedByProposedAction: true },
      { bindingId: skillBndClaude, placementId: skillPlc, artifactId: skillArt, consumerKind: 'host', consumerLabel: 'Claude', mechanism: 'claude-user-skills', enabled: true, effectiveScope: 'user', grade: 'verified', affectedByProposedAction: false },
      { bindingId: skillBndCodex, placementId: skillPlc, artifactId: skillArt, consumerKind: 'host', consumerLabel: 'Codex', mechanism: 'codex-agents-skills', enabled: true, effectiveScope: 'user', grade: 'verified', affectedByProposedAction: false },
      { bindingId: projectSkillBnd, placementId: projectSkillPlc, artifactId: projectSkillArt, consumerKind: 'host', consumerLabel: 'Claude', mechanism: 'claude-project-skills', enabled: true, effectiveScope: 'project', grade: 'verified', affectedByProposedAction: false },
      { bindingId: pluginBnd, placementId: pluginPlc, artifactId: pluginArt, consumerKind: 'host', consumerLabel: 'Claude', mechanism: 'claude-plugin-cli', enabled: true, effectiveScope: 'user', grade: 'verified', affectedByProposedAction: true },
      { bindingId: hookBnd, placementId: hookPlc, artifactId: hookArt, consumerKind: 'host', consumerLabel: 'Codex', mechanism: 'codex-hooks', enabled: true, effectiveScope: 'user', grade: 'verified', affectedByProposedAction: false },
      { bindingId: credBnd, placementId: credPlc, artifactId: credArt, consumerKind: 'host', consumerLabel: 'Codex', mechanism: 'environment-variable', enabled: null, effectiveScope: 'user', grade: 'verified', affectedByProposedAction: false },
    ],
    placements: [
      {
        placementId: lightpandaPlc, resourceId: lightpandaRes, environmentId: env, administrativeScope: 'user',
        locationBreadcrumb: ['Claude', 'User configuration', 'MCP servers'], artifactIds: [lightpandaArt],
        consumerBindingIds: [lightpandaBnd], conditions: ['missing-verified-dependency'],
        evidenceScorecard: { identity: 'verified', placement: 'verified', consumers: 'verified', dependencies: 'verified', remedy: 'verified' },
        displayName: 'Lightpanda', kind: 'mcp-registration', hostNamespace: 'claude', consumerHosts: ['claude'],
        versions: {}, guidanceLane: 'steps', technicalDetails: ['Command dependency: lightpanda'],
        recentlyChangedAt: null,
      },
      {
        placementId: skillPlc, resourceId: skillRes, environmentId: env, administrativeScope: 'user',
        locationBreadcrumb: ['User', 'Skills'], artifactIds: [skillArt],
        consumerBindingIds: [skillBndClaude, skillBndCodex], conditions: ['healthy'],
        evidenceScorecard: { identity: 'verified', placement: 'verified', consumers: 'verified', installedVersion: 'verified' },
        displayName: 'clarity', kind: 'skill', consumerHosts: ['claude', 'codex'],
        versions: { contentDigest: 'sha256-clarity-tree' }, guidanceLane: null, technicalDetails: [],
        recentlyChangedAt: null,
      },
      {
        placementId: projectSkillPlc, resourceId: projectSkillRes, environmentId: env, administrativeScope: 'project',
        projectId: PROJECT_KIT, locationBreadcrumb: ['Development', 'ai', 'agentic-kit', '.claude', 'skills'],
        artifactIds: [projectSkillArt], consumerBindingIds: [projectSkillBnd], conditions: ['healthy'],
        evidenceScorecard: { identity: 'verified', placement: 'verified', consumers: 'verified', installedVersion: 'verified' },
        displayName: 'clarity', kind: 'skill', consumerHosts: ['claude'],
        versions: { contentDigest: 'sha256-clarity-tree' }, guidanceLane: null, technicalDetails: [],
        recentlyChangedAt: null,
      },
      {
        placementId: pluginPlc, resourceId: pluginRes, environmentId: env, administrativeScope: 'user',
        locationBreadcrumb: ['Claude', 'Plugins'], artifactIds: [pluginArt],
        consumerBindingIds: [pluginBnd], conditions: ['healthy'],
        evidenceScorecard: { identity: 'verified', placement: 'verified', consumers: 'verified', installedVersion: 'verified', provenance: 'verified', impact: 'verified', remedy: 'verified' },
        displayName: 'frontend-design', kind: 'plugin', hostNamespace: 'claude', consumerHosts: ['claude'],
        versions: { installed: '0.3.1', producer: 'claude-plugins' }, guidanceLane: 'apply', technicalDetails: [],
        recentlyChangedAt: null,
      },
      {
        placementId: hookPlc, resourceId: hookRes, environmentId: env, administrativeScope: 'user',
        locationBreadcrumb: ['Codex', 'Hooks'], artifactIds: [hookArt],
        consumerBindingIds: [hookBnd], conditions: ['definitions-differ'],
        evidenceScorecard: { identity: 'verified', placement: 'verified', consumers: 'verified' },
        displayName: 'SessionStart AutoMemory', kind: 'hook', hostNamespace: 'codex', consumerHosts: ['codex'],
        versions: {}, guidanceLane: null, technicalDetails: ['Occurrence differs from the managed template; no verified procedure applies.'],
        recentlyChangedAt: null,
      },
      {
        placementId: credPlc, resourceId: credRes, environmentId: env, administrativeScope: 'user',
        locationBreadcrumb: ['Codex', 'Credentials'], artifactIds: [credArt],
        consumerBindingIds: [credBnd], conditions: ['credential-mechanism-not-checked'],
        evidenceScorecard: { identity: 'verified', placement: 'verified' },
        displayName: 'OpenAI credential', kind: 'credential-readiness', consumerHosts: ['codex'],
        versions: {}, guidanceLane: null, technicalDetails: [], credentialReadiness: 'configured-not-checked',
        credentialMechanism: 'environment-variable', recentlyChangedAt: null,
      },
    ],
    provenanceAssertions: [
      evidence(pluginPlc, 'provenance', { kind: 'plugin-marketplace', label: 'claude-plugins marketplace' }, { authority: 'claude plugin CLI', sourceRef: 'claude:plugin-list' }),
    ],
    versionObservations: [
      { ...evidence(pluginPlc, 'installedVersion', '0.3.1', { authority: 'claude plugin CLI', sourceRef: 'claude:plugin-list' }), axis: 'installed' },
      { ...evidence(pluginPlc, 'candidateSource', '0.4.0', { grade: 'provider-declared', authority: 'claude-plugins marketplace', sourceRef: 'claude:marketplace' }), axis: 'candidate' },
    ],
    dependencyEdges: [
      { edgeId: id('edg', { from: lightpandaPlc, kind: 'requires-executable' }), fromPlacementId: lightpandaPlc, toId: lightpandaExeRes, kind: 'requires-executable', requirement: 'lightpanda', grade: 'verified', satisfied: false, authority: 'claude configuration + PATH probe' },
    ],
    conflictSets: [
      {
        conflictId: id('cfl', { kind: 'shared-artifact', art: skillArt }), kind: 'shared-artifact',
        placementIds: [skillPlc], artifactIds: [skillArt], consumerBindingIds: [skillBndClaude, skillBndCodex],
        proves: 'Several consumers intentionally use one physical artifact.',
        doesNotProve: 'This is not a duplicate and grants no removal authority.',
      },
      {
        conflictId: id('cfl', { kind: 'duplicate-placement', a: skillPlc, b: projectSkillPlc }), kind: 'duplicate-placement',
        placementIds: [skillPlc, projectSkillPlc],
        proves: 'Separate placements have equivalent verified definitions.',
        doesNotProve: 'Equality does not prove one is disposable.',
      },
    ],
    guidanceEntries: [
      {
        guidanceId: guidanceSteps, placementId: lightpandaPlc, lane: 'steps',
        outcome: 'Reinstall the lightpanda executable', verifiedPremises: ['placement', 'missing-verified-dependency'],
        impact: { summary: 'Installs lightpanda through Homebrew; the registration is unchanged.' },
        preserved: ['The MCP registration', 'Claude configuration'], procedureId: id('rcp', { recipe: 'brew-install-lightpanda' }),
        dispositionIdentity: `${lightpandaPlc}:missing-verified-dependency:lightpanda`,
      },
      {
        guidanceId: guidanceDecision, placementId: lightpandaPlc, lane: 'decision',
        outcome: 'Decide how to resolve the missing lightpanda dependency', verifiedPremises: ['placement', 'missing-verified-dependency'],
        impact: { summary: 'Each choice changes only the exact registration or its dependency.' },
        preserved: ['Other MCP registrations'],
        choices: [
          { choiceId: 'repair-registration', label: 'Repair command path', changes: 'The exact registration command', keeps: 'The registration and its environment', grounded: false, reason: 'No verified alternative executable placement was found.' },
          { choiceId: 'relink-dependency', label: 'Relink dependency', changes: 'The dependency binding', keeps: 'The registration', grounded: false, reason: 'No verified compatible dependency was found.' },
          { choiceId: 'reinstall', label: 'Reinstall dependency', changes: 'Installs lightpanda', keeps: 'The registration', grounded: true },
          { choiceId: 'remove', label: 'Remove MCP registration', changes: 'Removes the exact Claude user-scope registration', keeps: 'Every other registration', grounded: false, reason: 'No Claude MCP removal provider is registered.' },
        ],
        dispositionIdentity: `${lightpandaPlc}:missing-verified-dependency:decision`,
      },
      {
        guidanceId: guidanceApply, placementId: pluginPlc, lane: 'apply',
        outcome: 'Disable Claude plugin', verifiedPremises: ['placement', 'installedVersion', 'consumers', 'impact'],
        impact: { summary: 'Claude stops loading frontend-design until it is enabled again.' },
        preserved: ['Plugin data', 'Other plugins'], providerCapabilityId: 'claude-plugin:v1:disable:user',
        verb: 'disable', dispositionIdentity: `${pluginPlc}:disable`,
      },
    ],
  };
  return deepFreeze(assertManagementInventory(inventory));
}

/** J7 — Windows host plus two WSL distributions carrying the same tool name. */
export function wslInventory() {
  const envs = [ENV_WIN, ENV_WSL_UBUNTU, ENV_WSL_DEBIAN];
  const res = id('res', { kind: 'executable', name: 'node' });
  const placements = envs.map((environment) => {
    const placementId = id('plc', { res, env: environment.environmentId });
    const artifactId = id('art', { exe: 'node', env: environment.environmentId });
    const bindingId = id('bnd', { plc: placementId, consumer: 'codex' });
    return { environment, placementId, artifactId, bindingId };
  });
  const inventory = {
    schemaVersion: MANAGEMENT_SCHEMA_VERSION,
    schema: MANAGEMENT_INVENTORY_SCHEMA,
    inventoryId: id('inv', { fixture: 'wsl' }),
    capturedAt: FIXTURE_NOW,
    sourceFingerprint: 'fp-wsl',
    environments: envs,
    sourceCoverage: envs.map((environment) => coverage(id('src', { automatic: 'runtimes', env: environment.environmentId }), environment.environmentId, 'complete', { label: 'Runtimes' })),
    resources: [{ resourceId: res, kind: 'executable', displayName: 'node', placementIds: placements.map((entry) => entry.placementId) }],
    artifacts: placements.map((entry) => ({ artifactId: entry.artifactId, carrier: 'executable', label: `node on ${entry.environment.displayLabel}` })),
    consumerBindings: placements.map((entry) => ({
      bindingId: entry.bindingId, placementId: entry.placementId, artifactId: entry.artifactId, consumerKind: 'host',
      consumerLabel: 'Codex', mechanism: 'PATH', enabled: true, effectiveScope: 'machine', grade: 'verified', affectedByProposedAction: false,
    })),
    placements: placements.map((entry) => ({
      placementId: entry.placementId, resourceId: res, environmentId: entry.environment.environmentId,
      administrativeScope: 'machine', locationBreadcrumb: [entry.environment.displayLabel, 'Executables'],
      artifactIds: [entry.artifactId], consumerBindingIds: [entry.bindingId], conditions: ['healthy'],
      evidenceScorecard: { identity: 'verified', placement: 'verified', installedVersion: 'verified', consumers: 'verified' },
      displayName: 'node', kind: 'executable', consumerHosts: ['codex'], versions: { installed: '22.12.0' },
      guidanceLane: null, technicalDetails: [], recentlyChangedAt: null,
    })),
    provenanceAssertions: [],
    versionObservations: placements.map((entry) => ({
      ...evidence(entry.placementId, 'installedVersion', '22.12.0', { authority: 'node --version', sourceRef: 'probe:node', scope: 'machine' }), axis: 'installed',
    })),
    dependencyEdges: placements.slice(1).map((entry) => ({
      edgeId: id('edg', { from: entry.placementId, kind: 'windows-hosts-wsl' }), fromPlacementId: entry.placementId,
      toId: placements[0].placementId, kind: 'windows-hosts-wsl', grade: 'verified', environmentRelation: 'windows-host', authority: 'wsl.exe --list',
    })),
    conflictSets: [],
    guidanceEntries: [],
  };
  return deepFreeze(assertManagementInventory(inventory));
}

/** J10 — one source stopped at a hard entry ceiling after finding verified resources. */
export function incompleteSourceInventory() {
  const env = ENV_MAC.environmentId;
  const src = id('src', { collection: 'big-monorepo' });
  const res = id('res', { kind: 'instruction-context-file', name: 'AGENTS.md', project: 'monorepo' });
  const plc = id('plc', { res, env, project: PROJECT_OTHER_KIT });
  const art = id('art', { file: 'AGENTS.md', project: 'monorepo' });
  const bnd = id('bnd', { plc, consumer: 'codex' });
  const inventory = {
    schemaVersion: MANAGEMENT_SCHEMA_VERSION,
    schema: MANAGEMENT_INVENTORY_SCHEMA,
    inventoryId: id('inv', { fixture: 'incomplete' }),
    capturedAt: FIXTURE_NOW,
    sourceFingerprint: 'fp-incomplete',
    environments: [ENV_MAC],
    sourceCoverage: [{
      sourceId: src, environmentId: env, state: 'stopped', visited: 250000, estimated: null,
      completedPartitions: 3, pendingPartitions: 5, limitingReason: 'safety-ceiling', ceiling: 'entries',
      lastCompletedAt: null, label: 'Collection root',
    }],
    resources: [{ resourceId: res, kind: 'instruction-context-file', displayName: 'AGENTS.md', placementIds: [plc] }],
    artifacts: [{ artifactId: art, carrier: 'file', label: 'Project instruction file' }],
    consumerBindings: [{ bindingId: bnd, placementId: plc, artifactId: art, consumerKind: 'host', consumerLabel: 'Codex', mechanism: 'codex-agents-md', enabled: true, effectiveScope: 'project', grade: 'verified', affectedByProposedAction: false }],
    placements: [{
      placementId: plc, resourceId: res, environmentId: env, administrativeScope: 'project', projectId: PROJECT_OTHER_KIT,
      locationBreadcrumb: ['other', 'agentic-kit'], artifactIds: [art], consumerBindingIds: [bnd],
      conditions: ['healthy', 'source-scan-incomplete'],
      evidenceScorecard: { identity: 'verified', placement: 'verified', consumers: 'verified' },
      displayName: 'AGENTS.md', kind: 'instruction-context-file', consumerHosts: ['codex'], versions: {},
      guidanceLane: null, technicalDetails: ['Source scan incomplete'], recentlyChangedAt: null,
    }],
    provenanceAssertions: [],
    versionObservations: [],
    dependencyEdges: [],
    conflictSets: [],
    guidanceEntries: [],
  };
  return deepFreeze(assertManagementInventory(inventory));
}

/** Two worktrees of one repository plus an equal-basename project elsewhere (MNT-INV-010/011). */
export function projectsInventory() {
  const env = ENV_MAC.environmentId;
  const src = id('src', { automatic: 'projects' });
  const rows = [
    { project: PROJECT_KIT, crumb: ['Development', 'ai', 'agentic-kit'], worktree: 'main' },
    { project: PROJECT_KIT_WT, crumb: ['Development', 'ai', 'agentic-kit-feature'], worktree: 'feature' },
    { project: PROJECT_OTHER_KIT, crumb: ['other', 'agentic-kit'], worktree: null },
  ].map((row) => {
    const res = id('res', { kind: 'instruction-context-file', name: 'CLAUDE.md', project: row.project });
    const plc = id('plc', { res, env, project: row.project });
    const art = id('art', { file: 'CLAUDE.md', project: row.project });
    const bnd = id('bnd', { plc, consumer: 'claude' });
    return { ...row, res, plc, art, bnd };
  });
  const repoRes = id('res', { kind: 'related-storage', repo: 'agentic-kit' });
  const inventory = {
    schemaVersion: MANAGEMENT_SCHEMA_VERSION,
    schema: MANAGEMENT_INVENTORY_SCHEMA,
    inventoryId: id('inv', { fixture: 'projects' }),
    capturedAt: FIXTURE_NOW,
    sourceFingerprint: 'fp-projects',
    environments: [ENV_MAC],
    sourceCoverage: [coverage(src, env, 'complete', { label: 'Projects' })],
    resources: [
      ...rows.map((row) => ({ resourceId: row.res, kind: 'instruction-context-file', displayName: 'CLAUDE.md', placementIds: [row.plc] })),
      { resourceId: repoRes, kind: 'related-storage', displayName: 'agentic-kit repository', placementIds: [] },
    ],
    artifacts: rows.map((row) => ({ artifactId: row.art, carrier: 'file', label: 'Project instruction file' })),
    consumerBindings: rows.map((row) => ({ bindingId: row.bnd, placementId: row.plc, artifactId: row.art, consumerKind: 'host', consumerLabel: 'Claude', mechanism: 'claude-project-md', enabled: true, effectiveScope: 'project', grade: 'verified', affectedByProposedAction: false })),
    placements: rows.map((row) => ({
      placementId: row.plc, resourceId: row.res, environmentId: env, administrativeScope: 'project', projectId: row.project,
      locationBreadcrumb: row.crumb, artifactIds: [row.art], consumerBindingIds: [row.bnd], conditions: ['healthy'],
      evidenceScorecard: { identity: 'verified', placement: 'verified', consumers: 'verified' },
      displayName: 'CLAUDE.md', kind: 'instruction-context-file', consumerHosts: ['claude'], versions: {},
      guidanceLane: null, technicalDetails: row.worktree ? [`Worktree: ${row.worktree}`] : [], recentlyChangedAt: null,
      repositoryId: row.worktree ? repoRes : null,
    })),
    provenanceAssertions: [],
    versionObservations: [],
    dependencyEdges: [],
    conflictSets: [],
    guidanceEntries: [],
  };
  return deepFreeze(assertManagementInventory(inventory));
}

/** J6 — an inactive Ollama model with complete consumers and storage evidence, and an active one. */
export function modelsInventory() {
  const env = ENV_MAC.environmentId;
  const src = id('src', { automatic: 'ollama' });
  const make = (name, digest, active) => {
    const res = id('res', { kind: 'model', provider: 'ollama', name });
    const plc = id('plc', { res, env, digest });
    const art = id('art', { blob: digest });
    const bnd = id('bnd', { plc, consumer: 'route:implementation' });
    return { name, digest, active, res, plc, art, bnd };
  };
  const models = [make('llama3.2:3b', 'sha256-llama32', false), make('qwen2.5-coder:7b', 'sha256-qwen', true)];
  const guidance = id('gid', { plc: models[0].plc, lane: 'apply', verb: 'remove' });
  const inventory = {
    schemaVersion: MANAGEMENT_SCHEMA_VERSION,
    schema: MANAGEMENT_INVENTORY_SCHEMA,
    inventoryId: id('inv', { fixture: 'models' }),
    capturedAt: FIXTURE_NOW,
    sourceFingerprint: 'fp-models',
    environments: [ENV_MAC],
    sourceCoverage: [coverage(src, env, 'complete', { label: 'Ollama' })],
    resources: models.map((model) => ({ resourceId: model.res, kind: 'model', displayName: model.name, publisher: 'ollama', placementIds: [model.plc] })),
    artifacts: models.map((model) => ({ artifactId: model.art, carrier: 'model-revision', label: 'Ollama model blob', digest: model.digest, logicalBytes: 2_000_000_000, physicalBytes: 1_800_000_000, sharedBlobs: 1 })),
    consumerBindings: models.map((model) => ({ bindingId: model.bnd, placementId: model.plc, artifactId: model.art, consumerKind: 'route', consumerLabel: 'implementation route', mechanism: 'kit-routing', enabled: model.active, effectiveScope: 'user', grade: 'verified', affectedByProposedAction: true })),
    placements: models.map((model) => ({
      placementId: model.plc, resourceId: model.res, environmentId: env, administrativeScope: 'user',
      locationBreadcrumb: ['Ollama', 'Models'], artifactIds: [model.art], consumerBindingIds: [model.bnd],
      conditions: ['healthy'],
      evidenceScorecard: { identity: 'verified', placement: 'verified', consumers: 'verified', installedVersion: 'verified', impact: 'verified', remedy: model.active ? 'inferred' : 'verified' },
      displayName: model.name, kind: 'model', consumerHosts: ['agentic-kit'], versions: { contentDigest: model.digest },
      guidanceLane: model.active ? null : 'apply', technicalDetails: model.active ? ['Loaded in the Ollama runtime'] : [],
      recentlyChangedAt: null, activeUse: model.active,
    })),
    provenanceAssertions: models.map((model) => evidence(model.plc, 'provenance', { kind: 'provider-owned-configuration', label: 'Ollama library' }, { authority: 'ollama list', sourceRef: 'ollama-api-tags' })),
    versionObservations: models.map((model) => ({ ...evidence(model.plc, 'installedVersion', model.digest, { authority: 'ollama show', sourceRef: 'ollama-api-show' }), axis: 'contentDigest' })),
    dependencyEdges: [],
    conflictSets: [],
    guidanceEntries: [{
      guidanceId: guidance, placementId: models[0].plc, lane: 'apply', outcome: 'Remove model',
      verifiedPremises: ['placement', 'consumers', 'impact', 'installedVersion'],
      impact: { summary: 'Removes one Ollama model. Reclaims about 1.8 GB physically; shared blobs are not counted twice.', irreversible: true, redownloadRequired: true },
      preserved: ['Every other model', 'Ollama configuration'], providerCapabilityId: 'ollama-model:v1:remove:user', verb: 'remove',
      dispositionIdentity: `${models[0].plc}:remove`,
    }],
  };
  return deepFreeze(assertManagementInventory(inventory));
}

/** J5 — an integrity-valid receipt interrupted after provider dispatch. */
export const INTERRUPTED_RECEIPT = deepFreeze({
  id: 'mnt-20260905T110000000Z-fixture01', schemaVersion: 'maintenance-receipt/v1', status: 'applying',
  createdAt: '2026-09-05T11:00:00.000Z', updatedAt: '2026-09-05T11:00:03.000Z',
  planId: 'maintenance-plan-fixture', planDigest: 'a'.repeat(64), sourceFingerprint: 'fp-base',
  actions: [{
    actionId: 'maintenance-action-fixture', providerId: 'owned-npx-cache', providerVersion: '1', operation: 'clean-cache',
    resourceIdentity: { kind: 'stale-npx-env', id: 'npx:stale-1', name: 'stale npx environment', host: 'agentic-kit', scope: 'user' },
    classification: 'approval-required', rollback: 'irreversible', restart: 'not-required', state: 'applying',
    preimageFingerprint: 'pre-fixture', outcome: null, verification: null,
  }],
});

export const SENTINEL_FIXTURES = Object.freeze({
  base: baseInventory, wsl: wslInventory, incomplete: incompleteSourceInventory,
  projects: projectsInventory, models: modelsInventory,
});
