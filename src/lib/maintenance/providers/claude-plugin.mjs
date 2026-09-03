import { runNativeCommand } from '../native-command.mjs';
import {
  baseAction, catalogDependencyCount, commandFailure, executableSafetyClass,
  parseNativeJson, providerFinding, sha256, unavailable, validPluginRef, validScope,
} from './shared.mjs';

const installedFingerprint = (plugin) => sha256({
  ref: plugin.ref, version: plugin.version, scope: plugin.scope, enabled: plugin.enabled,
});

const actionFingerprint = (plugin, operation, recommended = null) => sha256({
  installed: installedFingerprint(plugin),
  ...(operation === 'update' ? { hostCandidate: recommended } : {}),
});

function refOf(item) {
  return validPluginRef(item?.pluginId) ? item.pluginId : (validPluginRef(item?.id) ? item.id : null);
}

function normalize(raw) {
  const installed = Array.isArray(raw) ? raw : raw?.installed;
  const availableInput = Array.isArray(raw) ? [] : raw?.available;
  if (!Array.isArray(installed) || !Array.isArray(availableInput)) return null;
  const available = [];
  for (const item of availableInput) {
    const ref = refOf(item);
    if (!ref || typeof item.version !== 'string' || !item.version) return null;
    available.push({ ref, version: item.version });
  }
  const plugins = [];
  for (const item of installed) {
    const ref = refOf(item);
    if (!ref || typeof item.version !== 'string' || !item.version
        || !validScope(item.scope) || typeof item.enabled !== 'boolean') return null;
    const candidates = available.filter((row) => row.ref === ref);
    plugins.push({
      ref, version: item.version, scope: item.scope, enabled: item.enabled,
      candidateStatus: candidates.length > 1 ? 'ambiguous' : (candidates.length === 1 ? 'exact' : 'absent'),
      availableVersion: candidates.length === 1 ? candidates[0].version : null,
    });
  }
  return plugins.sort((a, b) => `${a.ref}:${a.scope}`.localeCompare(`${b.ref}:${b.scope}`));
}

function actionableRequest(finding) {
  const resource = finding?.resource ?? finding?.resourceIdentity;
  const operation = finding?.nextAction?.operation;
  const eligible = resource?.kind === 'plugin'
    && resource.host === 'claude'
    && validPluginRef(resource.providerRef)
    && validScope(resource.scope)
    && executableSafetyClass(finding?.safetyClass)
    && ['disable', 'update', 'remove'].includes(operation);
  return eligible ? { resource, ref: resource.providerRef, operation } : null;
}

function exactBase(baseFindings, plugin) {
  return (baseFindings ?? []).find((finding) => finding?.resource?.kind === 'plugin'
    && finding.resource.host === 'claude'
    && finding.resource.providerRef === plugin.ref
    && finding.resource.scope === plugin.scope
    && ['disable', 'remove'].includes(finding.nextAction?.operation));
}

export function createClaudePluginProvider({ run = runNativeCommand } = {}) {
  async function detect() {
    const parsed = parseNativeJson(await run('claude', ['plugin', 'list', '--available', '--json']));
    if (!parsed.ok) return { ...unavailable(parsed.reason), plugins: [] };
    const plugins = normalize(parsed.value);
    if (!plugins) return { ...unavailable('native-inventory-invalid-shape'), plugins: [] };
    return {
      status: 'available', complete: true, authority: 'native-inventory',
      asOf: new Date().toISOString(), plugins,
    };
  }

  /** @param {any} facts @param {any} context */
  function findings(facts, context = {}) {
    const { footprint, baseFindings, evidence } = context;
    if (facts?.status !== 'available' || facts.complete !== true) return [];
    const rows = [];
    for (const plugin of facts.plugins) {
      const base = exactBase(baseFindings, plugin);
      const operation = base?.nextAction?.operation;
      const exactLifecycle = base && evidence?.status === 'fresh' && evidence?.completeness === 'complete';
      let state; let bucket; let classification; let safetyClass; let selectedOperation;
      let label; let rollback; let executable; let recommended = null;
      if (exactLifecycle) {
        ({ state } = base);
        bucket = 'needsReview';
        classification = `native-explicit-${operation}`;
        safetyClass = 'approval-required';
        selectedOperation = operation;
        label = operation === 'remove' ? 'Uninstall exact plugin and preserve its data' : 'Disable exact plugin';
        rollback = operation === 'disable' ? 'reversible' : 'irreversible';
        executable = operation !== 'disable' || plugin.enabled;
      } else if (plugin.candidateStatus === 'ambiguous') {
        state = 'ambiguous'; bucket = 'needsReview'; classification = 'host-candidate-ambiguous';
        safetyClass = 'never-automatic'; selectedOperation = 'review';
        label = 'Review ambiguous host-reported candidates'; rollback = 'irreversible'; executable = false;
      } else if (plugin.candidateStatus === 'exact' && plugin.availableVersion !== plugin.version) {
        state = 'update-available'; bucket = 'updatesReady'; classification = 'host-reported-update-candidate';
        safetyClass = 'approval-required'; selectedOperation = 'update';
        label = 'Update to the exact host-reported candidate'; rollback = 'irreversible'; executable = true;
        recommended = plugin.availableVersion;
      } else {
        continue;
      }
      const resource = base?.resource ?? {
        id: `plugin:claude:${plugin.ref}:${plugin.scope}`, kind: 'plugin', name: plugin.ref,
        host: 'claude', scope: plugin.scope, providerRef: plugin.ref,
      };
      rows.push(providerFinding({
        providerId: 'claude-plugin', stableKey: `${plugin.ref}:${plugin.scope}:${selectedOperation}`,
        state, bucket, classification, safetyClass, resource,
        versions: { installed: plugin.version, recommended, producer: plugin.version },
        ownership: { owner: plugin.ref, authority: 'native-inventory', managed: true },
        evidence: { sources: ['claude-plugin-native-inventory'], asOf: facts.asOf,
          freshness: 'fresh', completeness: 'complete', gaps: [] },
        impact: { summary: 'Exact plugin capabilities may change.',
          dependencies: catalogDependencyCount(footprint, plugin.ref, 'claude') },
        operation: selectedOperation, label, rollback, restart: 'required', executable,
      }));
    }
    return rows;
  }

  function actionFor(finding, facts) {
    const request = actionableRequest(finding);
    if (!request || facts?.status !== 'available' || facts.complete !== true) return null;
    const { resource, ref, operation } = request;
    const plugin = facts.plugins?.find((item) => item.ref === ref && item.scope === resource.scope);
    if (!plugin || (operation === 'disable' && !plugin.enabled)) return null;
    const recommended = finding?.versions?.recommended;
    if (operation === 'update' && (typeof recommended !== 'string' || !recommended
        || recommended === plugin.version || plugin.candidateStatus !== 'exact'
        || plugin.availableVersion !== recommended)) return null;
    return {
      ...baseAction(finding, {
        providerId: 'claude-plugin', providerVersion: 'v1', operation,
        sourceFingerprint: actionFingerprint(plugin, operation, recommended),
        rollback: operation === 'disable' ? 'reversible' : 'irreversible', restart: 'required',
      }),
      expectedVersion: plugin.version,
      recommendedVersion: operation === 'update' ? recommended : plugin.version,
    };
  }

  async function preflight(action) {
    const facts = await detect();
    const plugin = facts.complete && facts.plugins.find((item) => item.ref === action?.resourceIdentity?.providerRef
      && item.scope === action.resourceIdentity.scope);
    const fingerprint = plugin ? actionFingerprint(plugin, action.operation, action.recommendedVersion) : null;
    return { ok: Boolean(plugin) && fingerprint === action.sourceFingerprint, sourceFingerprint: fingerprint };
  }

  async function apply(action) {
    const ref = action?.resourceIdentity?.providerRef;
    const scope = action?.resourceIdentity?.scope;
    if (!validPluginRef(ref) || !validScope(scope) || !['disable', 'update', 'remove'].includes(action.operation)) {
      return { status: 'unknown', summary: 'Provider action identity is invalid.' };
    }
    const args = action.operation === 'disable'
      ? ['plugin', 'disable', '--scope', scope, ref]
      : (action.operation === 'update'
        ? ['plugin', 'update', '--scope', scope, '--yes', ref]
        : ['plugin', 'uninstall', '--scope', scope, '--keep-data', '--yes', ref]);
    const result = await run('claude', args);
    if (!result.ok) return commandFailure(result);
    if (action.operation === 'remove') {
      return { status: 'applied', postFingerprint: `absent:${sha256(ref)}`,
        summary: 'Claude plugin manager accepted exact uninstall with data preservation.' };
    }
    const expected = {
      ref, scope, enabled: action.operation !== 'disable',
      version: action.operation === 'update' ? action.recommendedVersion : action.expectedVersion,
    };
    return { status: 'applied', postFingerprint: installedFingerprint(expected),
      summary: 'Claude plugin manager accepted the operation.' };
  }

  async function verify(action, outcome) {
    const facts = await detect();
    const ref = action?.resourceIdentity?.providerRef;
    const plugin = facts.complete && facts.plugins.find((item) => item.ref === ref
      && item.scope === action.resourceIdentity.scope);
    const postFingerprint = action.operation === 'remove'
      ? (plugin ? null : `absent:${sha256(ref)}`)
      : (plugin ? installedFingerprint(plugin) : null);
    return { ok: postFingerprint === outcome?.postFingerprint, postFingerprint };
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
    const sourceFingerprint = plugin ? actionFingerprint(plugin, 'disable') : null;
    return { ok: Boolean(plugin) && sourceFingerprint === entry.sourceFingerprint, sourceFingerprint };
  }

  async function inspectCurrent(entry) {
    const facts = await detect();
    const ref = entry?.resourceIdentity?.providerRef;
    const plugin = facts.complete && facts.plugins.find((item) => item.ref === ref
      && item.scope === entry.resourceIdentity?.scope);
    const postFingerprint = entry?.operation === 'remove'
      ? (plugin ? installedFingerprint(plugin) : `absent:${sha256(ref)}`)
      : (plugin ? installedFingerprint(plugin) : null);
    return { complete: facts.complete === true, postFingerprint };
  }

  return {
    id: 'claude-plugin', version: 'v1', host: 'claude', status: 'native-detection-required', resourceKinds: ['plugin'],
    operations: ['disable', 'update', 'remove'], rollback: ['reversible', 'irreversible'],
    limitations: [{ operation: 'prune', status: 'unsupported',
      reason: 'Global plugin prune has no exact machine-readable target set.' }],
    detect, findings, actionFor, preflight, apply, verify, undo, verifyUndo, inspectCurrent,
  };
}
