import { createClaudePluginProvider } from './providers/claude-plugin.mjs';
import { createCodexMcpProvider } from './providers/codex-mcp.mjs';
import { createCodexPluginProvider } from './providers/codex-plugin.mjs';

const ID = /^[a-z][a-z0-9.-]{1,63}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const KIND = /^[A-Za-z][A-Za-z0-9.-]{0,63}$/;
const OPERATION = /^[a-z][a-z0-9-]{1,47}$/;

function validateProvider(provider) {
  if (!provider || !ID.test(provider.id ?? '') || !VERSION.test(provider.version ?? '')) {
    throw new TypeError('invalid maintenance provider identity');
  }
  if (!Array.isArray(provider.resourceKinds) || !provider.resourceKinds.length
      || provider.resourceKinds.some((kind) => !KIND.test(kind))) {
    throw new TypeError(`invalid resource kinds for maintenance provider: ${provider.id}`);
  }
  if (!Array.isArray(provider.operations) || !provider.operations.length
      || provider.operations.some((operation) => !OPERATION.test(operation))) {
    throw new TypeError(`invalid operation for maintenance provider: ${provider.id}`);
  }
  for (const method of ['detect', 'actionFor', 'preflight', 'apply', 'verify']) {
    if (typeof provider[method] !== 'function') throw new TypeError(`maintenance provider lacks ${method}: ${provider.id}`);
  }
  if (provider.rollback?.includes('reversible')
      && (typeof provider.undo !== 'function' || typeof provider.verifyUndo !== 'function')) {
    throw new TypeError(`reversible maintenance provider lacks undo verification: ${provider.id}`);
  }
}

export function createMaintenanceProviderRegistry(providers = []) {
  const registry = new Map();
  for (const provider of providers) {
    validateProvider(provider);
    if (registry.has(provider.id)) throw new TypeError(`duplicate maintenance provider: ${provider.id}`);
    registry.set(provider.id, provider);
  }
  return registry;
}

const UNSUPPORTED = Object.freeze([
  Object.freeze({
    id: 'opencode-mcp', version: null, host: 'opencode', resourceKinds: ['mcpServer'],
    operations: [], rollback: [], status: 'unsupported',
    reason: 'OpenCode does not expose a verified native maintenance adapter.',
  }),
  Object.freeze({
    id: 'opencode-plugin', version: null, host: 'opencode', resourceKinds: ['plugin'],
    operations: [], rollback: [], status: 'unsupported',
    reason: 'OpenCode does not expose a verified native maintenance adapter.',
  }),
]);

export function createDefaultMaintenanceProviderRegistry(options = {}) {
  return createMaintenanceProviderRegistry([
    createClaudePluginProvider(options.claudePlugin),
    createCodexPluginProvider(options.codexPlugin),
    createCodexMcpProvider(options.codexMcp),
  ]);
}

export function publicMaintenanceProviders(registry, { includeUnsupported = false } = {}) {
  const available = [...(registry?.values?.() ?? [])].map((provider) => ({
    id: provider.id,
    version: provider.version,
    ...(provider.host ? { host: provider.host } : {}),
    resourceKinds: [...provider.resourceKinds],
    operations: [...provider.operations],
    rollback: [...(provider.rollback ?? [])],
    status: provider.status ?? 'available',
  }));
  return [
    ...available,
    ...(includeUnsupported ? UNSUPPORTED.map((item) => ({ ...item })) : []),
  ].sort((a, b) => a.id.localeCompare(b.id));
}
