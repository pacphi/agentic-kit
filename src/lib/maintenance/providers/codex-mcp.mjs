import { runNativeCommand } from '../native-command.mjs';
import {
  baseAction, commandFailure, executableSafetyClass, parseNativeJson, sha256, unavailable, validResourceName,
} from './shared.mjs';

function fingerprint(raw) {
  return sha256({
    name: raw.name, enabled: raw.enabled,
    transport: raw.transport, startupTimeout: raw.startup_timeout_sec,
    toolTimeout: raw.tool_timeout_sec, authStatus: raw.auth_status,
  });
}

function normalize(raw) {
  if (!Array.isArray(raw)) return null;
  const servers = [];
  for (const item of raw) {
    if (!validResourceName(item?.name) || typeof item.enabled !== 'boolean') return null;
    servers.push({
      name: item.name,
      registered: true,
      configured: Boolean(item.transport),
      enabled: item.enabled,
      reachable: 'unknown',
      healthy: 'unknown',
      authenticated: item.auth_status === 'authenticated'
        ? true : (item.auth_status === 'unauthenticated' ? false : 'unknown'),
      authorized: 'unknown',
      configurationFingerprint: fingerprint(item),
    });
  }
  return servers.sort((a, b) => a.name.localeCompare(b.name));
}

export function createCodexMcpProvider({ run = runNativeCommand } = {}) {
  async function detect() {
    const parsed = parseNativeJson(await run('codex', ['mcp', 'list', '--json']));
    if (!parsed.ok) return { ...unavailable(parsed.reason), servers: [] };
    const servers = normalize(parsed.value);
    if (!servers) return { ...unavailable('native-inventory-invalid-shape'), servers: [] };
    return { status: 'available', complete: true, authority: 'native-inventory', asOf: new Date().toISOString(), servers };
  }

  function actionFor(finding, facts) {
    const resource = finding?.resource ?? finding?.resourceIdentity;
    if (resource?.kind !== 'mcpServer' || resource.host !== 'codex' || !validResourceName(resource.name)
        || finding?.nextAction?.operation !== 'remove'
        || finding?.ownership?.authority !== 'native-inventory' || finding?.ownership?.managed !== true
        || !executableSafetyClass(finding?.safetyClass)) return null;
    const server = facts?.complete && facts.servers?.find((item) => item.name === resource.name);
    if (!server) return null;
    return baseAction(finding, {
      providerId: 'codex-mcp', providerVersion: 'v1', operation: 'remove',
      sourceFingerprint: server.configurationFingerprint,
      rollback: 'irreversible', restart: 'required',
    });
  }

  async function preflight(action) {
    const facts = await detect();
    const server = facts.complete && facts.servers.find((item) => item.name === action?.resourceIdentity?.name);
    return { ok: Boolean(server) && server.configurationFingerprint === action?.sourceFingerprint,
      sourceFingerprint: server?.configurationFingerprint ?? null };
  }

  async function apply(action) {
    const name = action?.resourceIdentity?.name;
    if (!validResourceName(name) || action.operation !== 'remove') return { status: 'unknown', summary: 'Provider action identity is invalid.' };
    const result = await run('codex', ['mcp', 'remove', name]);
    return result.ok
      ? { status: 'applied', postFingerprint: `absent:${sha256(name)}`, summary: 'Codex MCP manager accepted removal.' }
      : commandFailure(result);
  }

  async function verify(action, outcome) {
    const facts = await detect();
    const name = action?.resourceIdentity?.name;
    const absent = facts.complete && !facts.servers.some((item) => item.name === name);
    const postFingerprint = absent ? `absent:${sha256(name)}` : null;
    return { ok: Boolean(absent) && postFingerprint === outcome?.postFingerprint, postFingerprint };
  }

  return {
    id: 'codex-mcp', version: 'v1', resourceKinds: ['mcpServer'], operations: ['remove'],
    rollback: ['irreversible'], detect, actionFor, preflight, apply, verify,
  };
}
