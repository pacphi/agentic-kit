import { runNativeCommand } from '../native-command.mjs';
import {
  baseAction, commandFailure, executableSafetyClass, parseNativeJson, sha256, unavailable, validPluginRef,
} from './shared.mjs';

function fingerprint(plugin) {
  return sha256({ ref: plugin.ref, version: plugin.version, enabled: plugin.enabled, installed: plugin.installed });
}

function normalize(raw) {
  if (!raw || !Array.isArray(raw.installed)) return null;
  const plugins = [];
  for (const item of raw.installed) {
    if (!validPluginRef(item?.pluginId) || typeof item.version !== 'string') return null;
    plugins.push({
      ref: item.pluginId, version: item.version,
      installed: item.installed === true, enabled: item.enabled === true,
    });
  }
  return plugins.sort((a, b) => a.ref.localeCompare(b.ref));
}

export function createCodexPluginProvider({ run = runNativeCommand } = {}) {
  async function detect() {
    const parsed = parseNativeJson(await run('codex', ['plugin', 'list', '--json']));
    if (!parsed.ok) return { ...unavailable(parsed.reason), plugins: [] };
    const plugins = normalize(parsed.value);
    if (!plugins) return { ...unavailable('native-inventory-invalid-shape'), plugins: [] };
    return { status: 'available', complete: true, authority: 'native-inventory', asOf: new Date().toISOString(), plugins };
  }

  function actionFor(finding, facts) {
    const resource = finding?.resource ?? finding?.resourceIdentity;
    const ref = resource?.providerRef;
    if (resource?.kind !== 'plugin' || resource.host !== 'codex' || !validPluginRef(ref)
        || finding?.nextAction?.operation !== 'remove'
        || finding?.ownership?.authority !== 'native-inventory' || finding?.ownership?.managed !== true
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

  return {
    id: 'codex-plugin', version: 'v1', resourceKinds: ['plugin'], operations: ['remove'],
    rollback: ['irreversible'], detect, actionFor, preflight, apply, verify,
  };
}
