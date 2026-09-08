// Pure projection of measured plugin evidence. No registry/network work on reads.
import { assertion } from './evidence.mjs';

function version(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9.+_-]{0,99}$/.test(value) ? value : null;
}
function parsedVersion(value) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value ?? '');
  return match ? { core: match.slice(1, 4).map(BigInt), pre: match[4]?.split('.') ?? [] } : null;
}
function compareIdentifier(a, b) {
  if (a === b) return 0;
  const numericA = /^\d+$/.test(a), numericB = /^\d+$/.test(b);
  if (numericA && numericB) return BigInt(a) > BigInt(b) ? 1 : -1;
  if (numericA !== numericB) return numericA ? -1 : 1;
  return a > b ? 1 : -1;
}
function newer(candidate, installed) {
  const a = parsedVersion(candidate), b = parsedVersion(installed);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i];
  if (!a.pre.length || !b.pre.length) return !a.pre.length && Boolean(b.pre.length);
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (a.pre[i] === undefined) return false;
    if (b.pre[i] === undefined) return true;
    const result = compareIdentifier(a.pre[i], b.pre[i]);if (result) return result > 0;
  }
  return false;
}
function pluginObservation(first, group, ref, facts) {
  if (facts?.status !== 'available' || facts.complete !== true) return null;
  const scoped = (facts.plugins ?? []).filter((p) => p.ref === ref &&
    (first.host === 'claude' ? p.scope === (first.plugin?.scope ?? group.scope) : group.scope === 'user' || group.scope === 'plugin'));
  return scoped.length === 1 ? scoped[0] : null;
}
function candidateVersions(versions, observed, first, installed) {
  if (!observed) return versions;
  const candidates = first.host === 'claude'
    ? (observed.candidateStatus === 'exact' ? [observed.availableVersion] : [])
    : observed.candidates ?? [];
  if (observed.candidateStatus === 'ambiguous' || candidates.length > 1) {
    versions.updateStatus = 'Multiple candidates';return versions;
  }
  const candidate = candidates.length === 1 ? version(candidates[0]) : null;
  if (!candidate) { versions.updateStatus = 'No candidate reported';return versions; }
  if (candidate === installed) { versions.updateStatus = 'Up to date in this source';return versions; }
  if (newer(candidate, installed) === false) { versions.updateStatus = 'No newer release reported';return versions; }
  versions.candidate = candidate;
  versions.updateStatus = newer(candidate, installed) === true ? 'Update available' : 'Different release reported';
  versions.compatibility = 'Not verified';
  return versions;
}

function pluginReference(item, first) {
  return first.provider?.ref ?? first.plugin?.ref ?? item.pluginRef ?? (item.kind === 'plugin' ? item.name : null);
}
function observedRelease(first, observed) { return version(observed?.version ?? first.plugin?.version ?? first.provider?.version); }

export function catalogVersions({ item, first, group, pluginEvidence = {}, measuredAt = null }) {
  const plugin = item.kind === 'plugin';
  const ref = pluginReference(item, first);
  const versions = /** @type {Record<string, string>} */ ({ updateStatus: 'No update source' });
  const facts = pluginEvidence[first.host];
  const observed = pluginObservation(first, group, ref, facts);
  const installed = observedRelease(first, observed);
  if (Number.isFinite(measuredAt)) versions.measuredAt = new Date(measuredAt).toISOString();
  if (observed?.version && facts.asOf) versions.measuredAt = facts.asOf;
  if (plugin && installed) versions.installed = installed;
  if (!plugin && ref) {
    versions.providedBy = ref;
    if (installed) versions.producer = installed;
  }
  const generation = version(first.provider?.cacheGeneration);
  if (generation) versions.cacheGeneration = generation;
  if (!installed) versions.installedStatus = 'Not measured';
  if (ref && ['claude', 'codex'].includes(first.host)) {
    versions.updateStatus = 'Not checked';
    versions.source = first.host === 'claude' ? 'Claude plugin inventory' : 'Codex plugin inventory';
    if (facts?.asOf) versions.checkedAt = facts.asOf;
  }
  return candidateVersions(versions, observed, first, installed);
}

export function addReleaseObservations(builder, placementId, versions, { now, scope }) {
  for (const axis of ['installed', 'producer', 'candidate', 'cacheGeneration']) {
    if (!versions[axis]) continue;
    builder.addVersion({ ...assertion({
      subjectId: placementId, field: axis === 'candidate' ? 'candidateSource' : 'installedVersion',
      value: versions[axis], grade: 'verified', authority: versions.source ?? 'catalog metadata',
      sourceRef: 'plugin-inventory', capturedAt: (axis === 'candidate' ? versions.checkedAt : versions.measuredAt) ?? new Date(now()).toISOString(), scope,
    }), axis });
  }
}
