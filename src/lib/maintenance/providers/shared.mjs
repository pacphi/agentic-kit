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
    impact: normalizedImpact(finding?.impact),
  };
  return { id: `maintenance-action-${sha256(action).slice(0, 20)}`, ...action };
}

const VERSION_KEYS = [
  'installed', 'recommended', 'producer', 'sourceRevision', 'cacheGeneration', 'contentDigest',
];

const normalizedVersions = (versions) => Object.fromEntries(VERSION_KEYS.map((key) => [key,
  typeof versions[key] === 'string' && versions[key] ? versions[key] : null]));

function normalizedEvidence(evidence, providerId) {
  return {
    sources: [...new Set(evidence?.sources ?? [`maintenance-provider:${providerId}`])].sort(),
    asOf: evidence?.asOf ?? null,
    freshness: evidence?.freshness ?? 'fresh',
    completeness: evidence?.completeness ?? 'complete',
    gaps: [...new Set(evidence?.gaps ?? [])].sort(),
  };
}

function normalizedImpact(impact) {
  const labels = (value) => Array.isArray(value)
    ? value.filter((item) => typeof item === 'string' && item && !/[\0\r\n]/.test(item)).slice(0, 12)
    : [];
  return {
    summary: impact?.summary ?? 'Dependent capabilities require review before change.',
    bytes: Number.isFinite(impact?.bytes) ? impact.bytes : null,
    files: Number.isFinite(impact?.files) ? impact.files : null,
    dependencies: Number.isInteger(impact?.dependencies) ? impact.dependencies : 'unknown',
    capabilities: labels(impact?.capabilities),
    projects: labels(impact?.projects),
    preserved: labels(impact?.preserved),
  };
}

function providerNextAction({
  operation, label, providerId, providerVersion, safetyClass,
  rollback, restart, executable, recommendation, steps, preserved, blockedReason,
}) {
  const defaults = {
    update: {
      steps: ['Preview the update for this resource.', 'Confirm the target version and affected capabilities.', 'Apply the update, restart if required, then deep-rescan.'],
      preserved: ['Other installed resources', 'Project files'],
    },
    remove: {
      steps: ['Preview the uninstall for this resource.', 'Confirm the named resource and retained data.', 'Uninstall it, restart if required, then deep-rescan.'],
      preserved: ['Other installed resources', 'Project files'],
    },
    disable: {
      steps: ['Preview the disable operation.', 'Confirm the affected capabilities.', 'Disable the resource, restart if required, then deep-rescan.'],
      preserved: ['Installed resource data', 'Other installed resources'],
    },
    clean: {
      steps: ['Preview the cleanup for this cache.', 'Confirm no installed resource or project file is included.', 'Clear it, then deep-rescan.'],
      preserved: ['Other cache environments', 'Installed resources', 'Project files'],
    },
    archive: {
      steps: ['Preview the archive for this resource.', 'Confirm the archive can restore the complete resource.', 'Archive it, restart if required, then deep-rescan.'],
      preserved: ['Restorable archive', 'Other resources', 'Project files'],
    },
    terminate: {
      steps: ['Preview the exact process termination.', 'Confirm the process identity is still orphaned.', 'Stop it, then deep-rescan.'],
      preserved: ['Other live processes', 'MCP configuration', 'Project files'],
    },
    review: {
      steps: ['Follow the named corrective action in the owning host.', 'Run a deep System rescan and inspect the replacement finding.'],
      preserved: ['Current resource until the host completes the change'],
    },
  }[operation] ?? { steps: ['Run a deep System rescan before changing this resource.'], preserved: ['Current resource'] };
  return {
    operation, label, providerId, providerVersion, safetyClass,
    rollback, restart, executable: executable === true,
    recommendation: recommendation ?? label,
    steps: steps ?? defaults.steps,
    preserved: preserved ?? defaults.preserved,
    ...(executable === true ? {} : {
      blockedReason: blockedReason ?? 'This dashboard has no exact provider action for the named change.',
    }),
  };
}

/** Construct the public, content-free finding contract from provider-owned facts. */
export function providerFinding({
  providerId, providerVersion = 'v1', stableKey, state, bucket, classification, safetyClass,
  resource, versions = {}, ownership, evidence, impact, operation, label,
  rollback = 'irreversible', restart = 'unknown', executable = false,
  recommendation = null, steps = null, preserved = null, blockedReason = null,
}) {
  const normalized = normalizedVersions(versions);
  const nextAction = providerNextAction({
    operation, label, providerId, providerVersion, safetyClass,
    rollback, restart, executable, recommendation, steps, preserved, blockedReason,
  });
  const stable = {
    providerId, stableKey, state, classification, safetyClass, resource,
    versions: normalized, ownership, operation,
  };
  return {
    id: `maintenance-finding-${sha256(stable).slice(0, 20)}`,
    state, bucket, classification, safetyClass, resource,
    versions: normalized,
    ownership,
    evidence: normalizedEvidence(evidence, providerId),
    observedUsage: {
      status: 'not-measured', statement: 'Usage was not used as action authority.',
    },
    impact: normalizedImpact(impact),
    nextAction,
  };
}

export function catalogDependencyCount(footprint, providerRef, host = null) {
  const nestedCounts = [];
  let contributed = 0;
  for (const item of Array.isArray(footprint?.catalog?.items) ? footprint.catalog.items : []) {
    const byPresence = Array.isArray(item?.presence) && item.presence.some((presence) => (
        presence?.consumer?.enabled !== false
        && (!host || presence?.host === host) && presence?.provider?.ref === providerRef
      ));
    const identityHost = !host || item?.hosts?.includes(host)
      || (Array.isArray(item?.presence) && item.presence.some((presence) => (
        presence?.consumer?.enabled !== false && presence?.host === host
      )));
    const byIdentity = item?.pluginRef === providerRef && identityHost;
    if (!byIdentity && !byPresence) continue;
    const nested = Array.isArray(item.components) ? item.components.length : 0;
    if (nested) nestedCounts.push(nested);
    if (byPresence && item.kind !== 'plugin') contributed++;
  }
  const measured = Math.max(contributed, ...nestedCounts, 0);
  return measured || 'unknown';
}

/** Bounded, content-free removal/update blast radius for one provider-owned plugin. */
export function catalogDependencyImpact(footprint, providerRef, host = null) {
  const items = Array.isArray(footprint?.catalog?.items) ? footprint.catalog.items : [];
  const belongs = (item) => Array.isArray(item?.presence) && item.presence.some((presence) => (
    presence?.consumer?.enabled !== false && (!host || presence?.host === host)
    && presence?.provider?.ref === providerRef
  ));
  const contributed = items.filter((item) => item?.kind !== 'plugin' && belongs(item));
  const names = contributed.map((item) => `${item.kind} ${item.capabilityName ?? item.name}`);
  const preserved = [];
  for (const item of contributed) {
    const logical = String(item.capabilityName ?? item.name ?? '').toLowerCase();
    const alternatives = items.filter((candidate) => candidate !== item
      && String(candidate?.capabilityName ?? candidate?.name ?? '').toLowerCase() === logical
      && Array.isArray(candidate?.presence) && candidate.presence.some((presence) => (
        presence?.consumer?.enabled !== false && presence?.provider?.ref !== providerRef
      )));
    if (alternatives.length) preserved.push(`Other installed ${item.kind} ${item.capabilityName ?? item.name}`);
  }
  return {
    dependencies: catalogDependencyCount(footprint, providerRef, host),
    capabilities: names.slice(0, 12),
    preserved: [...new Set(preserved)].slice(0, 12),
  };
}
