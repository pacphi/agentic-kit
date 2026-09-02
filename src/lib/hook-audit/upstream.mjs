import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { publicSource, readJsonSource } from './common.mjs';

const defaultFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'config', 'agentic-dependency-constraints.json');
const ISSUE_STATES = new Set(['open-at-last-verification', 'closed-at-last-verification']);

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function affectedBy(version, ranges) {
  if (typeof version !== 'string' || !version || version === 'unknown') return null;
  return ranges.some((range) => range === version
    || (/^\d+\.x$/.test(range) && version.startsWith(`${range.slice(0, -1)}`)));
}

export function loadUpstreamConstraints({
  file = defaultFile, observedVersions = {}, now = () => new Date(),
} = {}) {
  const source = readJsonSource(file, path.dirname(file), { kind: 'upstream-constraints' });
  if (!source || source.status !== 'valid') {
    return { status: source?.status ?? 'absent', source: source ? publicSource(source) : { file, status: 'absent' }, constraints: [], errors: [source?.error ?? 'constraint registry is absent'] };
  }
  const document = source.document;
  const errors = [];
  const asOf = now();
  if (document?.schemaVersion !== 2) errors.push('unsupported upstream constraint schema');
  if (!Array.isArray(document?.constraints)) errors.push('constraints must be an array');
  if (!Array.isArray(document?.dependencyPolicies)) errors.push('dependencyPolicies must be an array');
  if (!validDate(document?.lastVerifiedAt)) errors.push('lastVerifiedAt must be an ISO date');
  if (validDate(document?.lastVerifiedAt)
      && Date.parse(`${document.lastVerifiedAt}T00:00:00Z`) > asOf.getTime()) {
    errors.push('lastVerifiedAt cannot be in the future');
  }
  if (!Number.isInteger(document?.recheckPolicy?.staleAfterDays) || document.recheckPolicy.staleAfterDays <= 0) {
    errors.push('recheckPolicy.staleAfterDays must be a positive integer');
  }
  const policyNames = new Set();
  const dependencyPolicies = Array.isArray(document?.dependencyPolicies)
    ? document.dependencyPolicies.filter((entry, index) => {
      const valid = entry && typeof entry === 'object'
        && typeof entry.dependency === 'string' && typeof entry.owner === 'string'
        && entry.issuePublication === 'explicit-user-approval-required'
        && Array.isArray(entry.evidenceRequired)
        && typeof entry.workaroundPolicy === 'string'
        && typeof entry.retestPolicy === 'string'
        && typeof entry.removalProof === 'string';
      if (valid && policyNames.has(entry.dependency)) errors.push(`dependency policy ${index} duplicates ${entry.dependency}`);
      if (valid) policyNames.add(entry.dependency);
      if (!valid) errors.push(`dependency policy ${index} is invalid`);
      return valid;
    }) : [];
  const constraintIds = new Set();
  const constraints = Array.isArray(document?.constraints) ? document.constraints.filter((entry, index) => {
    const valid = entry && typeof entry === 'object'
      && typeof entry.id === 'string' && typeof entry.dependency === 'string' && typeof entry.kind === 'string'
      && Array.isArray(entry.affected) && typeof entry.strategy === 'string'
      && typeof entry.primaryEvidence === 'string' && typeof entry.versionGate === 'string'
      && typeof entry.issue === 'string' && /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/.test(entry.issue)
      && ISSUE_STATES.has(entry.issueState)
      && typeof entry.expiryPolicy === 'string' && validDate(entry.nextRetestAt)
      && typeof entry.sunsetWhen === 'string'
      && entry.notification?.status === 'draft-only'
      && Array.isArray(entry.notification?.requiredFields);
    if (valid && constraintIds.has(entry.id)) errors.push(`constraint ${index} duplicates ${entry.id}`);
    if (valid) constraintIds.add(entry.id);
    if (valid && !policyNames.has(entry.dependency)) errors.push(`constraint ${index} has no dependency policy for ${entry.dependency}`);
    if (valid && validDate(document?.lastVerifiedAt)
        && Date.parse(`${entry.nextRetestAt}T00:00:00Z`) < Date.parse(`${document.lastVerifiedAt}T00:00:00Z`)) {
      errors.push(`constraint ${index} nextRetestAt precedes lastVerifiedAt`);
    }
    if (!valid) errors.push(`constraint ${index} is invalid`);
    return valid;
  }) : [];
  const lastVerified = validDate(document?.lastVerifiedAt) ? Date.parse(`${document.lastVerifiedAt}T00:00:00Z`) : NaN;
  const staleAfterMs = Number(document?.recheckPolicy?.staleAfterDays) * 86_400_000;
  const registryStale = Number.isFinite(lastVerified) && Number.isFinite(staleAfterMs)
    ? asOf.getTime() - lastVerified > staleAfterMs : true;
  const projected = constraints.map((entry) => {
    const observedVersion = observedVersions[entry.dependency] ?? null;
    const applicability = affectedBy(observedVersion, entry.affected);
    const retestOverdue = asOf.getTime() > Date.parse(`${entry.nextRetestAt}T23:59:59Z`);
    return {
      ...entry,
      evidence: {
        status: retestOverdue || registryStale ? 'stale' : 'current',
        observedVersion,
        applicability: applicability === null ? 'unresolved' : applicability ? 'affected' : 'not-affected',
        reason: applicability === null
          ? 'No installed dependency version was supplied; registry shape is not applicability proof.'
          : 'Applicability is bound to the supplied installed version and the declared affected range.',
      },
      notificationDraft: {
        status: 'draft-only', approvalRequired: true, dependency: entry.dependency,
        constraintId: entry.id, requiredFields: entry.notification.requiredFields,
      },
    };
  });
  const evidenceStatus = projected.some((entry) => entry.evidence.status === 'stale') ? 'stale' : 'current';
  return {
    status: errors.length ? 'invalid' : evidenceStatus === 'stale' ? 'stale' : 'valid',
    registryStatus: errors.length ? 'invalid' : 'valid', evidenceStatus,
    source: publicSource(source),
    lastVerifiedAt: document?.lastVerifiedAt ?? null,
    recheckPolicy: document?.recheckPolicy ?? null,
    dependencyPolicies, constraints: projected, errors,
  };
}
