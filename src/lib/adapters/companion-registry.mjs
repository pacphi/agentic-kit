import {
  assertId,
  assertRecord,
  assertStringArray,
  immutable,
  registryFrom,
} from './schema.mjs';
import { HOST_REGISTRY } from './registries.mjs';

function validateManagedCompanion(value, { hosts = HOST_REGISTRY } = {}) {
  assertRecord(value, 'managed companion');
  assertId(value.id, 'managed companion.id');
  if (typeof value.configKey !== 'string' || !/^[a-z][A-Za-z0-9]*$/.test(value.configKey)) {
    throw new TypeError('managed companion.configKey must be camelCase');
  }
  if (typeof value.label !== 'string' || !value.label) {
    throw new TypeError('managed companion.label is required');
  }
  if (typeof value.enabledByDefault !== 'boolean') {
    throw new TypeError('managed companion.enabledByDefault must be boolean');
  }
  assertStringArray(value.modes, 'managed companion.modes', { allowEmpty: false });
  assertStringArray(value.hosts, 'managed companion.hosts', { allowEmpty: false });
  const knownHosts = new Set(hosts.map(({ id }) => id));
  for (const host of value.hosts) {
    if (!knownHosts.has(host)) {
      throw new TypeError(`managed companion.hosts contains unknown host '${host}'`);
    }
  }
  assertRecord(value.install, 'managed companion.install');
  for (const field of ['bin', 'npmPackage', 'minimumVersion']) {
    if (typeof value.install[field] !== 'string' || !value.install[field]) {
      throw new TypeError(`managed companion.install.${field} is required`);
    }
  }
  return immutable(structuredClone(value));
}

const COMPANION_MAP = registryFrom([
  {
    id: 'deja-vu',
    configKey: 'dejaVu',
    label: 'deja-vu',
    enabledByDefault: false,
    modes: ['mcp', 'auto'],
    hosts: ['claude', 'codex', 'opencode'],
    install: {
      bin: 'deja',
      npmPackage: '@vshulcz/deja-vu',
      minimumVersion: '0.19.0',
    },
  },
], validateManagedCompanion, 'managed companion');

export const MANAGED_COMPANION_REGISTRY = immutable(Object.values(COMPANION_MAP));

export const managedCompanionIds = () => MANAGED_COMPANION_REGISTRY.map(({ id }) => id);

export function managedCompanionFor(id) {
  return COMPANION_MAP[id] ?? null;
}
