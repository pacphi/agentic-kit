import { createHash } from 'node:crypto';

const PLUGIN_REF = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}@[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RESOURCE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SCOPES = new Set(['user', 'project', 'local']);

export function sha256(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export const validPluginRef = (value) => PLUGIN_REF.test(value ?? '');
export const validResourceName = (value) => RESOURCE_NAME.test(value ?? '');
export const validScope = (value) => SCOPES.has(value);
export const executableSafetyClass = (value) => ['safe-automatic', 'approval-required'].includes(value);

export function commandFailure(result) {
  return {
    status: result?.timedOut || result?.signal ? 'unknown' : 'unknown',
    summary: result?.timedOut ? 'Native provider timed out; current state must be inspected.'
      : 'Native provider did not prove that the operation completed.',
    ...(Number.isInteger(result?.exitCode) ? { exitCode: result.exitCode } : {}),
    ...(result?.timedOut ? { timedOut: true } : {}),
  };
}

export function unavailable(reason = 'native-command-failed') {
  return {
    status: 'unavailable', complete: false, authority: 'native-inventory',
    reason, asOf: new Date().toISOString(),
  };
}

export function parseNativeJson(result) {
  if (!result?.ok) return { ok: false, reason: result?.timedOut ? 'native-command-timeout' : 'native-command-failed' };
  try { return { ok: true, value: JSON.parse(result.stdout) }; } catch { return { ok: false, reason: 'native-inventory-invalid-json' }; }
}

export function baseAction(finding, {
  providerId, providerVersion, operation, sourceFingerprint, rollback, restart,
}) {
  const resource = finding.resource ?? finding.resourceIdentity;
  const identity = Object.fromEntries(['id', 'kind', 'name', 'host', 'scope', 'providerRef']
    .flatMap((key) => (resource?.[key] == null ? [] : [[key, String(resource[key])]])));
  const action = {
    providerId, providerVersion, operation, resourceIdentity: identity,
    classification: finding.safetyClass,
    findingClassification: finding.classification ?? finding.state,
    rollback, restart, executable: true, sourceFingerprint,
  };
  return { id: `maintenance-action-${sha256(action).slice(0, 20)}`, ...action };
}

const VERSION_KEYS = [
  'installed', 'recommended', 'producer', 'sourceRevision', 'cacheGeneration', 'contentDigest',
];

/** Construct the public, content-free finding contract from provider-owned facts. */
export function providerFinding({
  providerId, providerVersion = 'v1', stableKey, state, bucket, classification, safetyClass,
  resource, versions = {}, ownership, evidence, impact, operation, label,
  rollback = 'irreversible', restart = 'unknown', executable = false,
}) {
  const normalizedVersions = Object.fromEntries(VERSION_KEYS.map((key) => [key,
    typeof versions[key] === 'string' && versions[key] ? versions[key] : null]));
  const nextAction = {
    operation, label, providerId, providerVersion, safetyClass,
    rollback, restart, executable: executable === true,
  };
  const stable = {
    providerId, stableKey, state, classification, safetyClass, resource,
    versions: normalizedVersions, ownership, operation,
  };
  return {
    id: `maintenance-finding-${sha256(stable).slice(0, 20)}`,
    state, bucket, classification, safetyClass, resource,
    versions: normalizedVersions,
    ownership,
    evidence: {
      sources: [...new Set(evidence?.sources ?? [`maintenance-provider:${providerId}`])].sort(),
      asOf: evidence?.asOf ?? null,
      freshness: evidence?.freshness ?? 'fresh',
      completeness: evidence?.completeness ?? 'complete',
      gaps: [...new Set(evidence?.gaps ?? [])].sort(),
    },
    observedUsage: {
      status: 'not-measured', statement: 'Usage was not used as action authority.',
    },
    impact: {
      summary: impact?.summary ?? 'Dependent capabilities require review before change.',
      bytes: Number.isFinite(impact?.bytes) ? impact.bytes : null,
      files: Number.isFinite(impact?.files) ? impact.files : null,
      dependencies: Number.isInteger(impact?.dependencies) ? impact.dependencies : 'unknown',
    },
    nextAction,
  };
}

export function catalogDependencyCount(footprint, providerRef, host = null) {
  const counts = [];
  for (const item of Array.isArray(footprint?.catalog?.items) ? footprint.catalog.items : []) {
    const exact = item?.pluginRef === providerRef
      || (Array.isArray(item?.presence) && item.presence.some((presence) => (
        (!host || presence?.host === host) && presence?.provider?.ref === providerRef
      )));
    if (exact) counts.push(Array.isArray(item.components) ? item.components.length : 0);
  }
  return counts.length ? Math.max(...counts) : 'unknown';
}
