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
