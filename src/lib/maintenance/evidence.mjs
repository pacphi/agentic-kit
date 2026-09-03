import { createHash } from 'node:crypto';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort()
    .map((key) => [key, canonical(value[key])]));
}

export const stableJson = (value) => JSON.stringify(canonical(value));
export const sha256 = (value) => createHash('sha256').update(stableJson(value)).digest('hex');
export const projectReference = (project) => textValue(project)
  ? `maintenance-project-${sha256(String(project)).slice(0, 20)}`
  : null;

const finite = (value) => (Number.isFinite(value) ? value : null);
const array = (value) => (Array.isArray(value) ? value : []);
const textValue = (value) => typeof value === 'string' && value.length > 0;

function measurementIdentity(measurement) {
  return {
    status: measurement?.status ?? 'unknown',
    value: measurement?.value ?? null,
    partial: measurement?.partial === true,
    asOf: finite(measurement?.asOf),
  };
}

/**
 * Hash the source facts needed to detect drift. Sensitive values are allowed
 * inside this one-way input, but only the digest leaves this module.
 */
export function sourceFingerprint(footprint = {}) {
  const catalog = footprint?.catalog;
  const storage = footprint?.storage;
  const source = {
    snapshot: {
      present: footprint?.snapshot?.present === true,
      asOf: finite(footprint?.snapshot?.asOf),
      completeness: footprint?.snapshot?.completeness ?? null,
    },
    catalog: catalog ? {
      asOf: finite(catalog.asOf),
      complete: catalog.complete === true,
      sourceStamps: catalog.sourceStamps ?? null,
      items: array(catalog.items).map((item) => ({
        id: item?.canonicalId ?? item?.key ?? item?.name ?? null,
        kind: item?.kind ?? null,
        lifecycle: item?.maintenance ?? item?.lifecycle ?? null,
        presence: array(item?.presence).map((presence) => ({
          host: presence?.host ?? null,
          scope: presence?.scope ?? null,
          project: presence?.project ?? null,
          path: presence?.sourceFile ?? presence?.itemPath ?? presence?.path ?? null,
          provider: presence?.provider ? {
            ref: presence.provider.ref ?? null,
            version: presence.provider.version ?? null,
            cacheGeneration: presence.provider.cacheGeneration ?? null,
            enabled: presence.provider.enabled ?? null,
          } : null,
          digest: measurementIdentity(presence?.digest),
        })),
      })),
    } : null,
    storage: storage ? {
      asOf: finite(storage.asOf),
      reclaimables: array(storage.reclaimables).map((row) => ({
        id: row?.id ?? null,
        kind: row?.kind ?? null,
        path: row?.path ?? null,
        safety: row?.safety ?? null,
        bytes: measurementIdentity(row?.bytes),
        files: measurementIdentity(row?.files),
      })),
    } : null,
  };
  return sha256(source);
}

function sectionGaps(section, name) {
  if (!section || typeof section !== 'object') return [`${name} not measured`];
  const gaps = [];
  for (const key of ['degraded', 'truncated', 'partial']) {
    for (const value of array(section[key])) gaps.push(`${name}:${key}:${String(value)}`);
  }
  if (name === 'catalog' && section.complete !== true) gaps.push('catalog completeness not proven');
  return gaps;
}

export function footprintEvidence(footprint = {}, now = Date.now()) {
  const gaps = [
    ...sectionGaps(footprint?.catalog, 'catalog'),
    ...sectionGaps(footprint?.storage, 'storage'),
  ];
  const times = [
    footprint?.snapshot?.asOf,
    footprint?.catalog?.asOf,
    footprint?.storage?.asOf,
  ].filter(Number.isFinite);
  const asOf = times.length ? Math.min(...times) : null;
  const stale = footprint?.snapshot?.stale === true;
  return {
    status: asOf === null ? 'unknown' : (stale ? 'stale' : 'fresh'),
    asOf: asOf === null ? null : new Date(asOf).toISOString(),
    ageMs: asOf === null ? null : Math.max(0, now - asOf),
    completeness: gaps.length ? 'partial' : 'complete',
    gaps: [...new Set(gaps)].sort(),
  };
}

export function measurementEvidence(measurement, sectionEvidence) {
  const measured = ['measured', 'carried-forward'].includes(measurement?.status)
    && Number.isFinite(measurement.value);
  const complete = measured && measurement.partial !== true
    && sectionEvidence.completeness === 'complete';
  const gaps = [...sectionEvidence.gaps];
  if (!measured) gaps.push(measurement?.reason ?? 'measurement unavailable');
  if (measurement?.partial === true) gaps.push('measurement is a lower bound');
  return {
    sources: ['system-footprint'],
    asOf: Number.isFinite(measurement?.asOf)
      ? new Date(measurement.asOf).toISOString()
      : sectionEvidence.asOf,
    freshness: sectionEvidence.status,
    completeness: complete ? 'complete' : 'partial',
    gaps: [...new Set(gaps)].sort(),
  };
}
