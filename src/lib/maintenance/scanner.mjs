import {
  FINDING_STATES, VERSION_AXES, deepFreeze,
} from './model.mjs';
import {
  footprintEvidence, measurementEvidence, projectReference, sha256, sourceFingerprint,
} from './evidence.mjs';

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
  const state = partial ? 'unreadable-partial' : (lifecycle?.state ?? 'ambiguous');
  const unsupported = state === 'unsupported-incompatible';
  const update = state === 'update-available';
  return {
    state,
    partial,
    update,
    bucket: unsupported ? 'unsupportedOrBlocked' : (update ? 'updatesReady' : 'needsReview'),
    safetyClass: partial ? 'never-automatic'
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
    scope: text(presence?.scope) ?? 'unknown',
    providerId: text(provider?.ref),
    projectRef: projectReference(presence?.project),
  };
}

function catalogFinding(item, sharedEvidence) {
  const presence = array(item?.presence)[0];
  const lifecycle = lifecycleOf(item, presence);
  const disposition = catalogDisposition(item, lifecycle, sharedEvidence);
  if (!disposition) return null;
  const provider = presence?.provider;
  return makeFinding({
    state: disposition.state,
    bucket: disposition.bucket,
    classification: disposition.partial
      ? 'catalog-evidence-incomplete'
      : (lifecycle?.state ?? 'multiple-observed-revisions'),
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
      operation: disposition.update ? 'update' : 'review',
      label: disposition.update ? 'Review compatible update' : 'Review evidence with the owning provider',
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
  const findings = [
    ...array(footprint?.storage?.reclaimables)
      .map((row) => storageFinding(row, evidence)).filter(Boolean),
    ...array(footprint?.catalog?.items)
      .map((item) => catalogFinding(item, evidence)).filter(Boolean),
  ];
  if (evidence.completeness !== 'complete') findings.push(missingEvidenceFinding(evidence));
  findings.sort((a, b) => a.id.localeCompare(b.id));
  return deepFreeze({
    sourceFingerprint: sourceFingerprint(footprint),
    evidence,
    findings,
  });
}
