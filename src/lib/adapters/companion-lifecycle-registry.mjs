import { MANAGED_COMPANION_REGISTRY } from './companion-registry.mjs';
import { validateLifecycleAdapter } from './lifecycle.mjs';
import { DEJA_VU_LIFECYCLE_ADAPTER } from './deja-vu.mjs';

const ADAPTERS = new Map();

export function registerBuiltinCompanionLifecycle(id, adapter, {
  companions = MANAGED_COMPANION_REGISTRY,
} = {}) {
  if (!companions.some((entry) => entry.id === id)) {
    throw new TypeError(`companion lifecycle registry: unknown companion id '${id}'`);
  }
  validateLifecycleAdapter(adapter);
  if (adapter.id !== id) throw new TypeError('companion lifecycle adapter id must match registry id');
  ADAPTERS.set(id, adapter);
  return adapter;
}

registerBuiltinCompanionLifecycle('deja-vu', DEJA_VU_LIFECYCLE_ADAPTER);

export function companionLifecycleFor(id) {
  return ADAPTERS.get(id) ?? null;
}

export function companionsWithLifecycle() {
  return MANAGED_COMPANION_REGISTRY.filter(({ id }) => ADAPTERS.has(id)).map(({ id }) => id);
}
