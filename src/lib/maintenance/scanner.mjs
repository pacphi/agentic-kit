import {
  FINDING_STATES, VERSION_AXES, deepFreeze,
} from './model.mjs';
import {
  footprintEvidence, measurementEvidence, projectReference, sha256, sourceFingerprint,
} from './evidence.mjs';
import path from 'node:path';

const array = (value) => (Array.isArray(value) ? value : []);
const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

function findingId(stable) {
  return `maintenance-finding-${sha256(stable).slice(0, 20)}`;
}

function versionAxes(values = {}) {
  return Object.fromEntries(VERSION_AXES.map((key) => [key, text(values[key])]));
}

function ownership({ owner = null, authority = 'observed', managed = false } = {}) {
  return { owner: text(owner), authority, managed };
}

function nextAction({ operation, label, providerId, safetyClass, rollback = 'compensating' }) {
  return {
    operation,
    label,
    providerId,
    providerVersion: '1',
    safetyClass,
    rollback,
    restart: 'unknown',
    executable: false,
    recommendation: label,
    steps: [
      'Inspect the evidence and confirm the owning source.',
      'Use the owning provider or project workflow for the proposed change.',
      'Run a deep System rescan and verify the finding is resolved.',
    ],
    preserved: ['Resources outside this finding'],
    blockedReason: 'No provider-authorized executable action is attached to this finding.',
  };
}

const relationshipCopy = Object.freeze({
  'redundant-project-override': {
    label: 'Decide whether to archive the project copy',
    headline: 'Project and shared definitions are identical',
    explanation: 'The complete observed definitions match. Host selection and ownership are not proven, so both copies are preserved.',
    recommendation: 'If the project does not intentionally override the shared resource, archive or remove the project copy after confirming the host uses the shared source.',
    impact: 'Only the project-local copy would be removed; the shared source, other projects, and repository history remain.',
    steps: [
      'Confirm the shared source is available to this host and project.',
      'Back up or commit the project copy before changing it.',
      'Remove only the project copy, then run a deep System rescan.',
    ],
    blockedReason: 'Observed equality does not prove host selection, ownership, or rollback authority.',
  },
  'same-name-different-definition': {
    label: 'Choose which definition should be authoritative',
    headline: 'Project and shared definitions differ',
    explanation: 'The resources share a name, but their complete observed definitions differ. Agentic Kit cannot infer which behavior you intend.',
    recommendation: 'Compare the project and shared definitions. Keep the intended source, or rename the project resource if both behaviors are required.',
    impact: 'The unintended project definition would be removed or renamed only after you choose the source of truth; shared sources remain.',
    steps: [
      'Compare the project copy with each observed shared source.',
      'Choose the intended source of truth for this project.',
      'Remove the unintended copy or rename the project copy, then rescan.',
    ],
    blockedReason: 'Choosing between different definitions is an intent decision, not a safe automatic cleanup.',
  },
  'tracked-source-copy': {
    label: 'Resolve the tracked copy through a pull request',
    headline: 'An identical project copy is tracked by Git',
    explanation: 'The complete observed definition matches a shared source, but the project copy is repository content rather than disposable cache.',
    recommendation: 'If the repository should inherit the shared resource, remove the tracked project copy through the normal review and pull-request workflow.',
    impact: 'The repository change would remove only the tracked project copy; shared sources, other projects, and Git history remain.',
    steps: [
      'Confirm contributors and automation can use the shared source.',
      'Create a repository change that removes only the tracked project copy.',
      'Run project tests and a deep System rescan before merging.',
    ],
    blockedReason: 'Removing tracked source is a repository change and requires project review.',
  },
  'legacy-equivalent-transport': {
    label: 'Retire the legacy transport after verifying the canonical one',
    headline: 'A canonical and legacy transport have identical configuration',
    explanation: 'Both registrations reach the same observed transport. Scope and provider ownership still determine whether retirement is safe.',
    recommendation: 'Verify the canonical registration is healthy, then remove only the legacy registration with the host-native MCP workflow at its reported scope.',
    impact: 'Only the legacy registration at the reported scope would be removed; the canonical registration and other scopes remain.',
    steps: [
      'Verify the canonical registration is present and healthy at an equal or broader scope.',
      'Use the host-native MCP command to remove only the legacy registration.',
      'Restart the affected host if required and run a deep System rescan.',
    ],
    blockedReason: 'No provider has yet proved scoped removal, canonical health, exact verification, and rollback for this finding.',
  },
});

const definitionDigest = (presence) => ['measured', 'carried-forward'].includes(presence?.definition?.status)
  && presence?.definition?.partial !== true && presence?.definition?.value
  ? presence.definition.value : null;

function relationshipMember(presence, role) {
  const tracking = presence?.tracking ?? {};
  const providerRef = text(presence?.provider?.ref) ?? text(presence?.plugin?.ref);
  return {
    role,
    label: role === 'project-copy' ? 'Observed project copy'
      : (role === 'canonical' ? 'Canonical transport'
        : (role === 'legacy' ? 'Legacy transport' : 'Observed shared copy')),
    host: text(presence?.host), scope: text(presence?.scope), providerRef,
    projectRef: projectReference(presence?.project),
    projectLabel: text(presence?.project) ? path.basename(presence.project) : null,
    ownership: providerRef ? 'plugin-owned' : (presence?.scope === 'user' ? 'user-owned' : 'unknown'),
    tracking: tracking.tracked === true ? 'tracked' : (tracking.tracked === false ? 'untracked' : 'unknown'),
    workingTree: ['clean', 'changed'].includes(tracking.workingTree) ? tracking.workingTree : 'unknown',
  };
}

function relationshipFinding({ classification, kind, name, host, project, projectPresence, shared, evidence }) {
  const copy = relationshipCopy[classification];
  const members = [relationshipMember(projectPresence,
    classification === 'legacy-equivalent-transport' ? 'legacy' : 'project-copy')]
    .concat(shared.map((presence) => relationshipMember(presence,
      classification === 'legacy-equivalent-transport' ? 'canonical' : 'shared-copy')));
  const stable = { classification, kind, name, host, projectRef: projectReference(project),
    definitions: [definitionDigest(projectPresence), ...shared.map(definitionDigest)].sort() };
  const action = nextAction({
    operation: 'review', label: copy.label, providerId: 'maintenance.read-only',
    safetyClass: 'never-automatic', rollback: 'reversible',
  });
  Object.assign(action, {
    recommendation: copy.recommendation, steps: copy.steps,
    preserved: ['The shared source', 'Other projects', 'Current repository history'],
    blockedReason: copy.blockedReason,
  });
  return makeFinding({
    state: 'ambiguous', bucket: 'needsReview', classification, safetyClass: 'never-automatic',
    statusLabel: classification === 'tracked-source-copy' ? 'Tracked project copy'
      : (classification === 'same-name-different-definition' ? 'Copies differ'
        : (classification === 'legacy-equivalent-transport' ? 'Legacy transport' : 'Definitions match')),
    headline: copy.headline, explanation: copy.explanation,
    resource: {
      id: `relationship:${sha256(stable).slice(0, 24)}`, kind, name, host,
      scope: 'project + shared', projectRef: projectReference(project),
    },
    ownership: ownership({ owner: 'project and shared sources', authority: 'observed', managed: false }),
    evidence: {
      sources: ['system-catalog'], asOf: evidence.asOf, freshness: evidence.status,
      completeness: 'complete', gaps: [],
    },
    observedUsage: { status: 'not-measured', statement: 'Host selection and usage were not used as action authority.' },
    impact: {
      summary: copy.impact, bytes: null, files: null,
      dependencies: 'unknown', preserved: action.preserved,
    },
    relationship: {
      kind: classification,
      basis: classification === 'same-name-different-definition' ? 'different-definition'
        : (classification === 'legacy-equivalent-transport' ? 'provider-equivalent' : 'same-definition'),
      resolution: 'not-reported', memberCount: members.length, truncated: false, members,
    },
    versions: versionAxes(), nextAction: action,
  });
}

function capabilityGroups(catalog) {
  const groups = new Map();
  for (const item of array(catalog?.items)) for (const presence of array(item?.presence)) {
    const logical = text(item?.capabilityName) ?? text(item?.name);
    if (!logical || !text(presence?.host)) continue;
    const key = `${presence.host}::${item.kind}::${logical.toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ item, presence, logical });
  }
  return groups;
}

function sameNameRelationships(catalog, evidence) {
  const findings = [];
  const coveredItems = new Set();
  for (const occurrences of capabilityGroups(catalog).values()) {
    const shared = occurrences.filter(({ presence }) => ['user', 'plugin'].includes(presence.scope));
    const projects = occurrences.filter(({ presence }) => presence.scope === 'project' && presence.project);
    if (!shared.length || !projects.length) continue;
    for (const projectOccurrence of projects) {
      const projectDigest = definitionDigest(projectOccurrence.presence);
      const sharedDigests = shared.map(({ presence }) => definitionDigest(presence));
      if (!projectDigest || sharedDigests.some((value) => !value)) continue;
      const allDigests = new Set([projectDigest, ...sharedDigests]);
      const classification = allDigests.size > 1 ? 'same-name-different-definition'
        : (projectOccurrence.presence?.tracking?.tracked === true
          ? 'tracked-source-copy' : 'redundant-project-override');
      findings.push(relationshipFinding({
        classification, kind: projectOccurrence.item.kind, name: projectOccurrence.logical,
        host: projectOccurrence.presence.host, project: projectOccurrence.presence.project,
        projectPresence: projectOccurrence.presence, shared: shared.map(({ presence }) => presence), evidence,
      }));
      coveredItems.add(projectOccurrence.item.key);
      shared.forEach(({ item }) => coveredItems.add(item.key));
    }
  }
  return { findings, coveredItems };
}

function mcpGroups(catalog) {
  const mcpByHost = new Map();
  for (const item of array(catalog?.items).filter((row) => row?.kind === 'mcpServer')) {
    for (const presence of array(item.presence)) {
      if (!mcpByHost.has(presence.host)) mcpByHost.set(presence.host, []);
      mcpByHost.get(presence.host).push({ item, presence });
    }
  }
  return mcpByHost;
}

function legacyTransportRelationships(catalog, evidence) {
  const findings = [];
  const coveredItems = new Set();
  const aliases = new Set(['ruflo', 'claude-flow']);
  for (const occurrences of mcpGroups(catalog).values()) {
    for (const projectOccurrence of occurrences.filter(({ presence }) => presence.scope === 'project' && presence.project)) {
      const name = String(projectOccurrence.item.capabilityName ?? projectOccurrence.item.name).toLowerCase();
      if (!aliases.has(name)) continue;
      const counterpart = name === 'ruflo' ? 'claude-flow' : 'ruflo';
      const digest = definitionDigest(projectOccurrence.presence);
      const matching = occurrences.filter(({ item, presence }) => (
        ['user', 'plugin'].includes(presence.scope)
        && String(item.capabilityName ?? item.name).toLowerCase() === counterpart
        && digest && definitionDigest(presence) === digest
      ));
      if (!matching.length) continue;
      findings.push(relationshipFinding({
        classification: 'legacy-equivalent-transport', kind: 'mcpServer',
        name: name === 'ruflo' ? 'ruflo / claude-flow' : 'claude-flow / ruflo',
        host: projectOccurrence.presence.host, project: projectOccurrence.presence.project,
        projectPresence: projectOccurrence.presence, shared: matching.map(({ presence }) => presence), evidence,
      }));
      coveredItems.add(projectOccurrence.item.key);
      matching.forEach(({ item }) => coveredItems.add(item.key));
    }
  }
  return { findings, coveredItems };
}

function capabilityRelationships(catalog, evidence) {
  const sameName = sameNameRelationships(catalog, evidence);
  const legacy = legacyTransportRelationships(catalog, evidence);
  return {
    findings: [...sameName.findings, ...legacy.findings],
    coveredItems: new Set([...sameName.coveredItems, ...legacy.coveredItems]),
  };
}

function makeFinding(fields) {
  const stable = {
    state: fields.state,
    resource: fields.resource,
    classification: fields.classification,
    safetyClass: fields.safetyClass,
    evidence: fields.evidence,
  };
  return {
    id: findingId(stable),
    ...fields,
  };
}

function storageFinding(row, sharedEvidence) {
  if (!row?.id) return null;
  const evidence = measurementEvidence(row.bytes, sharedEvidence);
  const ageOnly = ['aged-transcripts', 'orphaned-transcripts'].includes(row.kind);
  const usableEvidence = evidence.completeness === 'complete' && evidence.freshness === 'fresh';
  const safe = row.safety === 'regenerable' && usableEvidence;
  const unusableEvidence = !usableEvidence;
  const state = unusableEvidence
    ? 'unreadable-partial'
    : (safe ? 'orphaned-cache' : (row.kind === 'runtime-version' ? 'superseded-version' : 'ambiguous'));
  const safetyClass = unusableEvidence
    ? 'never-automatic'
    : (safe ? 'safe-automatic' : 'approval-required');
  const bucket = safe ? 'safeCleanup' : 'needsReview';
  const label = safe ? 'Prepare owner-managed cleanup' : 'Review and preserve unless explicitly approved';
  return makeFinding({
    state,
    bucket,
    classification: safe ? 'reproducible-storage-candidate' : 'advisory-storage-candidate',
    safetyClass,
    resource: {
      id: String(row.id),
      kind: text(row.kind) ?? 'storage',
      name: text(row.label) ?? String(row.id),
      host: 'agentic-kit',
      scope: 'machine',
    },
    versions: versionAxes(),
    ownership: ownership({ owner: 'source owner', authority: 'system-advisory', managed: false }),
    evidence,
    observedUsage: {
      status: ageOnly ? 'not-proof-of-disuse' : 'not-measured',
      statement: ageOnly
        ? 'No observed activity is incomplete evidence and does not prove disuse.'
        : 'Usage was not used as action authority.',
    },
    impact: {
      summary: safe ? 'The owning tool can reproduce the measured data.' : 'Unique or live data may be affected.',
      bytes: row.bytes?.status === 'measured' ? row.bytes.value : null,
      files: row.files?.status === 'measured' ? row.files.value : null,
      dependencies: 'unknown',
    },
    nextAction: nextAction({
      operation: safe ? 'clean' : 'review',
      label,
      providerId: 'maintenance.read-only',
      safetyClass,
      rollback: safe ? 'compensating' : 'irreversible',
    }),
  });
}

const STATE_MAP = Object.freeze({
  current: 'current-healthy',
  healthy: 'current-healthy',
  'update-available': 'update-available',
  'stale-configuration': 'stale-configuration',
  'superseded-version': 'superseded-version',
  unsupported: 'unsupported-incompatible',
  incompatible: 'unsupported-incompatible',
  modified: 'modified',
  ambiguous: 'ambiguous',
  partial: 'unreadable-partial',
  unreadable: 'unreadable-partial',
});

function lifecycleOf(item, presence) {
  const candidate = item?.maintenance ?? item?.lifecycle
    ?? presence?.provider?.lifecycle ?? presence?.plugin?.lifecycle;
  if (!candidate || typeof candidate !== 'object') return null;
  const state = STATE_MAP[candidate.state];
  return state && FINDING_STATES.includes(state) ? { ...candidate, state } : null;
}

function hasLocalAmbiguity(item) {
  const variants = item?.variantCount > 1 || item?.digestCoverage?.unique > 1;
  if (!variants) return false;
  const scopes = new Set(array(item?.sourceScopes));
  if (scopes.has('plugin') || scopes.has('user')) return true;
  const projects = new Set(array(item?.presence)
    .filter((presence) => presence?.scope === 'project' && text(presence?.project))
    .map((presence) => presence.project));
  return projects.size <= 1;
}

function catalogDisposition(item, lifecycle, sharedEvidence) {
  const ambiguous = hasLocalAmbiguity(item);
  const itemPartial = item?.digestCoverage?.partial === true;
  // Digest absence is normal for commands, agents, plugins and MCP rows. It is
  // section evidence, not 400 individual problems. Only a lifecycle or variant
  // signal earns a resource-specific finding; global gaps get one scan finding.
  if (!lifecycle && !ambiguous) return null;
  const partial = sharedEvidence.completeness !== 'complete'
    || itemPartial;
  const stale = sharedEvidence.status !== 'fresh';
  const unsafeEvidence = partial || stale;
  const state = partial ? 'unreadable-partial' : (lifecycle?.state ?? 'ambiguous');
  const unsupported = state === 'unsupported-incompatible';
  const update = state === 'update-available';
  return {
    state,
    partial,
    stale,
    update,
    bucket: unsafeEvidence ? 'needsReview'
      : (unsupported ? 'unsupportedOrBlocked' : (update ? 'updatesReady' : 'needsReview')),
    safetyClass: unsafeEvidence ? 'never-automatic'
      : (unsupported ? 'upstream-required' : 'approval-required'),
  };
}

function catalogVersions(provider, lifecycle, presence) {
  return versionAxes({
    installed: provider?.version,
    recommended: lifecycle?.recommendedVersion,
    producer: provider?.version,
    sourceRevision: lifecycle?.sourceRevision,
    cacheGeneration: provider?.cacheGeneration,
    contentDigest: presence?.digest?.status === 'measured' ? presence.digest.value : null,
  });
}

function catalogResource(item, presence, provider) {
  const resourceId = item?.canonicalId ?? item?.key
    ?? `${item?.kind ?? 'resource'}:${item?.name ?? 'unknown'}`;
  return {
    id: String(resourceId),
    kind: text(item?.kind) ?? 'resource',
    name: text(item?.name) ?? String(resourceId),
    host: text(presence?.host),
    scope: text(provider?.scope) ?? text(presence?.plugin?.scope) ?? text(presence?.scope) ?? 'unknown',
    providerRef: text(provider?.ref),
    projectRef: projectReference(presence?.project),
  };
}

function lifecycleOperation(lifecycle, disposition) {
  if (disposition.update) return 'update';
  return ['disable', 'remove'].includes(lifecycle?.operation) ? lifecycle.operation : 'review';
}

function catalogFinding(item, sharedEvidence) {
  const presence = array(item?.presence)[0];
  const lifecycle = lifecycleOf(item, presence);
  const disposition = catalogDisposition(item, lifecycle, sharedEvidence);
  if (!disposition) return null;
  const provider = presence?.provider;
  const operation = lifecycleOperation(lifecycle, disposition);
  return makeFinding({
    state: disposition.state,
    bucket: disposition.bucket,
    classification: disposition.partial
      ? 'catalog-evidence-incomplete'
      : (disposition.stale ? 'catalog-evidence-stale' : (lifecycle?.state ?? 'multiple-observed-revisions')),
    safetyClass: disposition.safetyClass,
    resource: catalogResource(item, presence, provider),
    versions: catalogVersions(provider, lifecycle, presence),
    ownership: ownership({
      owner: provider?.ref,
      authority: provider?.evidence?.status ?? 'observed',
      managed: Boolean(provider?.ref),
    }),
    evidence: {
      sources: ['system-catalog'],
      asOf: sharedEvidence.asOf,
      freshness: sharedEvidence.status,
      completeness: disposition.partial ? 'partial' : 'complete',
      gaps: disposition.partial ? [...sharedEvidence.gaps, 'catalog item evidence incomplete'] : [],
    },
    observedUsage: {
      status: 'not-measured',
      statement: 'Usage was not used as action authority.',
    },
    impact: {
      summary: 'Dependent capabilities require review before change.',
      bytes: null,
      files: null,
      dependencies: array(item?.components).length || 'unknown',
    },
    nextAction: nextAction({
      operation,
      label: disposition.update ? 'Review compatible update'
        : (operation === 'review' ? 'Review evidence with the owning provider' : `Review ${operation} with the owning provider`),
      providerId: text(provider?.ref) ?? 'maintenance.read-only',
      safetyClass: disposition.safetyClass,
      rollback: 'compensating',
    }),
  });
}

function missingEvidenceFinding(evidence) {
  return makeFinding({
    state: 'unreadable-partial',
    bucket: 'needsReview',
    classification: 'system-evidence-incomplete',
    safetyClass: 'never-automatic',
    resource: {
      id: 'system:maintenance-evidence', kind: 'system-evidence',
      name: 'Maintenance evidence', host: 'agentic-kit', scope: 'machine',
    },
    versions: versionAxes(),
    ownership: ownership({ owner: 'agentic-kit', authority: 'system', managed: true }),
    evidence: {
      sources: ['system-footprint'], asOf: evidence.asOf,
      freshness: evidence.status, completeness: 'partial', gaps: evidence.gaps,
    },
    observedUsage: { status: 'not-measured', statement: 'Usage evidence is unavailable.' },
    impact: {
      summary: 'No remediation can be classified safely until evidence is complete.',
      bytes: null, files: null, dependencies: 'unknown',
    },
    nextAction: nextAction({
      operation: 'scan', label: 'Run an explicit deep scan',
      providerId: 'system.deep-scan', safetyClass: 'never-automatic', rollback: 'reversible',
    }),
  });
}

/** Project the existing System footprint into content-free Maintenance findings.
 * @param {{ footprint?: any, now?: () => number }} [options] */
export function scanMaintenanceFindings({ footprint = {}, now = Date.now } = {}) {
  const currentTime = now();
  const evidence = footprintEvidence(footprint, currentTime);
  const relationships = capabilityRelationships(footprint?.catalog, evidence);
  const findings = [
    ...array(footprint?.storage?.reclaimables)
      .map((row) => storageFinding(row, evidence)).filter(Boolean),
    ...array(footprint?.catalog?.items).filter((item) => !relationships.coveredItems.has(item.key))
      .map((item) => catalogFinding(item, evidence)).filter(Boolean),
    ...relationships.findings,
  ];
  if (evidence.completeness !== 'complete') findings.push(missingEvidenceFinding(evidence));
  findings.sort((a, b) => a.id.localeCompare(b.id));
  return deepFreeze({
    sourceFingerprint: sourceFingerprint(footprint),
    evidence,
    findings,
  });
}
