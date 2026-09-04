import { runNativeCommand } from '../native-command.mjs';
import {
  baseAction, catalogDependencyCount, commandFailure, executableSafetyClass,
  parseNativeJson, providerFinding, sha256, unavailable, validPluginRef,
} from './shared.mjs';

function fingerprint(plugin) {
  return sha256({ ref: plugin.ref, version: plugin.version, enabled: plugin.enabled, installed: plugin.installed });
}

function normalize(raw) {
  if (!raw || !Array.isArray(raw.installed) || !Array.isArray(raw.available)) return null;
  const available = [];
  for (const item of raw.available) {
    if (!validPluginRef(item?.pluginId) || typeof item.version !== 'string' || !item.version) return null;
    available.push({ ref: item.pluginId, version: item.version });
  }
  const plugins = [];
  for (const item of raw.installed) {
    if (!validPluginRef(item?.pluginId) || typeof item.version !== 'string') return null;
    plugins.push({
      ref: item.pluginId, version: item.version,
      installed: item.installed === true, enabled: item.enabled === true,
      candidates: available.filter((row) => row.ref === item.pluginId).map((row) => row.version),
    });
  }
  return plugins.sort((a, b) => a.ref.localeCompare(b.ref));
}

export function createCodexPluginProvider({ run = runNativeCommand } = {}) {
  async function detect() {
    const parsed = parseNativeJson(await run('codex', ['plugin', 'list', '--available', '--json']));
    if (!parsed.ok) return { ...unavailable(parsed.reason), plugins: [] };
    const plugins = normalize(parsed.value);
    if (!plugins) return { ...unavailable('native-inventory-invalid-shape'), plugins: [] };
    return { status: 'available', complete: true, authority: 'native-inventory', asOf: new Date().toISOString(), plugins };
  }

  /** @param {any} facts @param {any} context */
  function findings(facts, context = {}) {
    const { footprint } = context;
    if (facts?.status !== 'available' || facts.complete !== true) return [];
    return facts.plugins.flatMap((plugin) => {
      if (!plugin.installed || plugin.candidates.length === 0
          || (plugin.candidates.length === 1 && plugin.candidates[0] === plugin.version)) return [];
      const ambiguous = plugin.candidates.length !== 1;
      return [providerFinding({
        providerId: 'codex-plugin', stableKey: `${plugin.ref}:update-candidate`,
        state: ambiguous ? 'ambiguous' : 'update-available',
        bucket: ambiguous ? 'needsReview' : 'unsupportedOrBlocked',
        classification: ambiguous ? 'host-candidate-ambiguous' : 'host-reported-update-candidate',
        safetyClass: ambiguous ? 'never-automatic' : 'upstream-required',
        resource: {
          id: `plugin:codex:${plugin.ref}`, kind: 'plugin', name: plugin.ref,
          host: 'codex', scope: 'user', providerRef: plugin.ref,
        },
        versions: { installed: plugin.version,
          recommended: ambiguous ? null : plugin.candidates[0], producer: plugin.version },
        ownership: { owner: plugin.ref, authority: 'native-inventory', managed: true },
        evidence: { sources: ['codex-plugin-native-inventory'], asOf: facts.asOf,
          freshness: 'fresh', completeness: 'complete', gaps: [] },
        impact: { summary: 'Codex reports a candidate, but no exact per-plugin update verb is available.',
          dependencies: catalogDependencyCount(footprint, plugin.ref, 'codex') },
        operation: 'review', label: `Upgrade ${plugin.ref} to ${plugin.candidates[0]} with Codex`,
        recommendation: 'Codex reports this version, but this dashboard cannot invoke a per-plugin update.',
        steps: [
          `Check Codex plugin help for an update or reinstall workflow for ${plugin.ref}.`,
          `Use that workflow to select ${plugin.candidates[0]}, then restart Codex and deep-rescan.`,
        ],
        preserved: ['Current plugin until Codex completes the upgrade', 'Other Codex plugins'],
        blockedReason: 'Codex does not expose an exact per-plugin update action to this dashboard.',
        rollback: 'irreversible', restart: 'unknown', executable: false,
      })];
    });
  }

  function actionFor(finding, facts) {
    const resource = finding?.resource ?? finding?.resourceIdentity;
    const ref = resource?.providerRef;
    if (resource?.kind !== 'plugin' || resource.host !== 'codex' || !validPluginRef(ref)
        || finding?.nextAction?.operation !== 'remove'
        || !executableSafetyClass(finding?.safetyClass)) return null;
    const plugin = facts?.complete && facts.plugins?.find((item) => item.ref === ref && item.installed);
    if (!plugin) return null;
    return {
      ...baseAction(finding, {
        providerId: 'codex-plugin', providerVersion: 'v1', operation: 'remove',
        sourceFingerprint: fingerprint(plugin), rollback: 'irreversible', restart: 'required',
      }),
      expectedVersion: plugin.version,
    };
  }

  async function preflight(action) {
    const facts = await detect();
    const plugin = facts.complete && facts.plugins.find((item) => item.ref === action?.resourceIdentity?.providerRef && item.installed);
    return { ok: Boolean(plugin) && fingerprint(plugin) === action?.sourceFingerprint,
      sourceFingerprint: plugin ? fingerprint(plugin) : null };
  }

  async function apply(action) {
    const ref = action?.resourceIdentity?.providerRef;
    if (!validPluginRef(ref) || action.operation !== 'remove') return { status: 'unknown', summary: 'Provider action identity is invalid.' };
    const result = await run('codex', ['plugin', 'remove', ref, '--json']);
    return result.ok
      ? { status: 'applied', postFingerprint: `absent:${sha256(ref)}`, summary: 'Codex plugin manager accepted removal.' }
      : commandFailure(result);
  }

  async function verify(action, outcome) {
    const facts = await detect();
    const ref = action?.resourceIdentity?.providerRef;
    const absent = facts.complete && !facts.plugins.some((item) => item.ref === ref && item.installed);
    const postFingerprint = absent ? `absent:${sha256(ref)}` : null;
    return { ok: Boolean(absent) && postFingerprint === outcome?.postFingerprint, postFingerprint };
  }

  async function inspectCurrent(entry) {
    const facts = await detect();
    const ref = entry?.resourceIdentity?.providerRef;
    const plugin = facts.complete && facts.plugins.find((item) => item.ref === ref && item.installed);
    return {
      complete: facts.complete === true,
      postFingerprint: plugin ? fingerprint(plugin) : `absent:${sha256(ref)}`,
    };
  }

  return {
    id: 'codex-plugin', version: 'v1', host: 'codex', status: 'native-detection-required',
    resourceKinds: ['plugin'], operations: ['remove'],
    rollback: ['irreversible'], detect, findings, actionFor, preflight, apply, verify, inspectCurrent,
  };
}
