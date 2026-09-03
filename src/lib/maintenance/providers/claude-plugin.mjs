import { runNativeCommand } from '../native-command.mjs';
import {
  baseAction, commandFailure, executableSafetyClass, parseNativeJson, sha256, unavailable, validPluginRef, validScope,
} from './shared.mjs';

function pluginFingerprint(plugin) {
  return sha256({
    ref: plugin.ref, version: plugin.version, scope: plugin.scope, enabled: plugin.enabled,
    availableVersion: plugin.availableVersion ?? null,
  });
}

function normalize(raw) {
  if (!Array.isArray(raw)) return null;
  const plugins = [];
  for (const item of raw) {
    if (!validPluginRef(item?.id) || typeof item.version !== 'string'
        || !validScope(item.scope) || typeof item.enabled !== 'boolean') return null;
    plugins.push({
      ref: item.id, version: item.version, scope: item.scope, enabled: item.enabled,
      availableVersion: typeof item.availableVersion === 'string' && item.availableVersion
        ? item.availableVersion : null,
    });
  }
  return plugins.sort((a, b) => a.ref.localeCompare(b.ref));
}

function actionableRequest(finding) {
  const resource = finding?.resource ?? finding?.resourceIdentity;
  const operation = finding?.nextAction?.operation;
  const eligible = resource?.kind === 'plugin'
    && resource.host === 'claude'
    && validPluginRef(resource.providerRef)
    && validScope(resource.scope)
    && executableSafetyClass(finding?.safetyClass)
    && ['disable', 'update'].includes(operation);
  return eligible ? { resource, ref: resource.providerRef, operation } : null;
}

export function createClaudePluginProvider({ run = runNativeCommand } = {}) {
  async function detect() {
    const parsed = parseNativeJson(await run('claude', ['plugin', 'list', '--json']));
    if (!parsed.ok) return { ...unavailable(parsed.reason), plugins: [] };
    const plugins = normalize(parsed.value);
    if (!plugins) return { ...unavailable('native-inventory-invalid-shape'), plugins: [] };
    return {
      status: 'available', complete: true, authority: 'native-inventory',
      asOf: new Date().toISOString(), plugins,
    };
  }

  function actionFor(finding, facts) {
    const request = actionableRequest(finding);
    if (!request) return null;
    const { resource, ref, operation } = request;
    const plugin = facts?.complete && facts.plugins?.find((item) => item.ref === ref && item.scope === resource.scope);
    if (!plugin || (operation === 'disable' && !plugin.enabled)) return null;
    const recommended = finding?.versions?.recommended;
    if (operation === 'update' && (typeof recommended !== 'string' || !recommended
        || recommended === plugin.version || plugin.availableVersion !== recommended)) return null;
    return {
      ...baseAction(finding, {
        providerId: 'claude-plugin', providerVersion: 'v1', operation,
        sourceFingerprint: pluginFingerprint(plugin),
        rollback: operation === 'disable' ? 'reversible' : 'irreversible', restart: 'required',
      }),
      expectedVersion: plugin.version,
      recommendedVersion: operation === 'update' ? recommended : plugin.version,
    };
  }

  async function preflight(action) {
    const facts = await detect();
    const ref = action?.resourceIdentity?.providerRef;
    const plugin = facts.complete && facts.plugins.find((item) => item.ref === ref
      && item.scope === action.resourceIdentity.scope);
    return { ok: Boolean(plugin) && pluginFingerprint(plugin) === action.sourceFingerprint,
      sourceFingerprint: plugin ? pluginFingerprint(plugin) : null };
  }

  async function apply(action) {
    const ref = action?.resourceIdentity?.providerRef;
    const scope = action?.resourceIdentity?.scope;
    if (!validPluginRef(ref) || !validScope(scope) || !['disable', 'update'].includes(action.operation)) {
      return { status: 'unknown', summary: 'Provider action identity is invalid.' };
    }
    const args = action.operation === 'disable'
      ? ['plugin', 'disable', '--scope', scope, ref]
      : ['plugin', 'update', '--scope', scope, '--yes', ref];
    const result = await run('claude', args);
    if (!result.ok) return commandFailure(result);
    const expected = {
      ref, scope, enabled: action.operation !== 'disable',
      version: action.operation === 'update' ? action.recommendedVersion : action.expectedVersion,
    };
    return { status: 'applied', postFingerprint: pluginFingerprint(expected), summary: 'Claude plugin manager accepted the operation.' };
  }

  async function verify(action, outcome) {
    const facts = await detect();
    const ref = action?.resourceIdentity?.providerRef;
    const plugin = facts.complete && facts.plugins.find((item) => item.ref === ref
      && item.scope === action.resourceIdentity.scope);
    const postFingerprint = plugin ? pluginFingerprint(plugin) : null;
    return { ok: Boolean(plugin) && postFingerprint === outcome?.postFingerprint, postFingerprint };
  }

  async function undo(entry) {
    if (entry?.operation !== 'disable') return { status: 'unknown', summary: 'This plugin operation has no automatic undo.' };
    const ref = entry.resourceIdentity?.providerRef;
    const scope = entry.resourceIdentity?.scope;
    if (!validPluginRef(ref) || !validScope(scope)) return { status: 'unknown', summary: 'Receipt identity is invalid.' };
    const result = await run('claude', ['plugin', 'enable', '--scope', scope, ref]);
    return result.ok
      ? { status: 'restored', sourceFingerprint: entry.sourceFingerprint, summary: 'Claude plugin manager restored enablement.' }
      : commandFailure(result);
  }

  async function verifyUndo(entry) {
    const facts = await detect();
    const plugin = facts.complete && facts.plugins.find((item) => item.ref === entry.resourceIdentity?.providerRef
      && item.scope === entry.resourceIdentity?.scope);
    const sourceFingerprint = plugin ? pluginFingerprint(plugin) : null;
    return { ok: Boolean(plugin) && sourceFingerprint === entry.sourceFingerprint, sourceFingerprint };
  }

  async function inspectCurrent(entry) {
    const facts = await detect();
    const plugin = facts.complete && facts.plugins.find((item) => item.ref === entry.resourceIdentity?.providerRef
      && item.scope === entry.resourceIdentity?.scope);
    return { postFingerprint: plugin ? pluginFingerprint(plugin) : null };
  }

  return {
    id: 'claude-plugin', version: 'v1', host: 'claude', status: 'native-detection-required', resourceKinds: ['plugin'],
    operations: ['disable', 'update'], rollback: ['reversible', 'irreversible'],
    detect, actionFor, preflight, apply, verify, undo, verifyUndo, inspectCurrent,
  };
}
