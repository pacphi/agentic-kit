import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { configDir } from '../paths.mjs';
import {
  MODEL_INVENTORY_SCHEMA_VERSION, isCompleteStableSnapshot, normalizeSnapshot,
} from './contracts.mjs';

export const MODEL_STORE_SCHEMA_VERSION = 1;
export const MAX_MODEL_SNAPSHOTS = 32;
export const MODEL_SNAPSHOT_RETENTION_MS = 90 * 86_400_000;

export const modelInventoryPath = () => path.join(configDir(), 'model-inventory.json');
export const modelScopeKeyPath = () => path.join(configDir(), 'model-scope.key');

export function readOrCreateModelScopeKey({
  file = modelScopeKeyPath(), fsImpl = fs, randomBytesFn = randomBytes,
} = {}) {
  try {
    const existing = String(fsImpl.readFileSync(file, 'utf8')).trim();
    if (/^[a-f0-9]{64}$/i.test(existing)) return existing.toLowerCase();
  } catch { /* create a new key below */ }
  const value = randomBytesFn(32).toString('hex');
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new TypeError('invalid generated model scope key');
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fsImpl.writeFileSync(tmp, `${value}\n`, { mode: 0o600, flag: 'wx' });
    fsImpl.renameSync(tmp, file);
    try { fsImpl.chmodSync(file, 0o600); } catch { /* best effort */ }
  } catch (error) {
    try { fsImpl.rmSync(tmp, { force: true }); } catch { /* preserve original */ }
    throw error;
  }
  return value;
}

const emptyStore = () => ({
  schemaVersion: MODEL_STORE_SCHEMA_VERSION,
  inventorySchemaVersion: MODEL_INVENTORY_SCHEMA_VERSION,
  updatedAt: null,
  baselineByScope: {},
  snapshots: [],
});

function normalizeStore(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== MODEL_STORE_SCHEMA_VERSION
    || value.inventorySchemaVersion !== MODEL_INVENTORY_SCHEMA_VERSION
    || !Array.isArray(value.snapshots)) return emptyStore();
  const snapshots = [];
  for (const raw of value.snapshots) {
    try { snapshots.push(normalizeSnapshot(raw)); } catch { /* one bad record does not hide valid history */ }
  }
  const known = new Set(snapshots.map(({ snapshotId }) => snapshotId));
  const baselineByScope = Object.fromEntries(Object.entries(value.baselineByScope ?? {})
    .filter(([scope, id]) => typeof scope === 'string' && typeof id === 'string' && known.has(id)));
  return {
    schemaVersion: MODEL_STORE_SCHEMA_VERSION,
    inventorySchemaVersion: MODEL_INVENTORY_SCHEMA_VERSION,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
    baselineByScope,
    snapshots,
  };
}

export function readModelStore({ file = modelInventoryPath(), fsImpl = fs } = {}) {
  try {
    return normalizeStore(JSON.parse(fsImpl.readFileSync(file, 'utf8')));
  } catch {
    return emptyStore();
  }
}

function pruneStore(store, now) {
  const cutoff = now - MODEL_SNAPSHOT_RETENTION_MS;
  const byScope = new Map();
  for (const snapshot of store.snapshots
    .filter((entry) => Date.parse(entry.capturedAt) >= cutoff)
    .sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt))) {
    const scope = snapshot.scope.fingerprint;
    const values = byScope.get(scope) ?? [];
    values.push(snapshot);
    byScope.set(scope, values.slice(-MAX_MODEL_SNAPSHOTS));
  }
  const snapshots = [...byScope.values()].flat()
    .sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
  const ids = new Set(snapshots.map(({ snapshotId }) => snapshotId));
  const baselineByScope = Object.fromEntries(Object.entries(store.baselineByScope)
    .filter(([, snapshotId]) => ids.has(snapshotId)));
  return { ...store, snapshots, baselineByScope };
}

export function writeModelStore(value, {
  file = modelInventoryPath(), fsImpl = fs, now = Date.now(),
} = {}) {
  const store = pruneStore(normalizeStore(value), now);
  store.updatedAt = new Date(now).toISOString();
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${now}.tmp`;
  try {
    fsImpl.writeFileSync(tmp, JSON.stringify(store), { mode: 0o600 });
    fsImpl.renameSync(tmp, file);
    try { fsImpl.chmodSync(file, 0o600); } catch { /* best effort on filesystems without modes */ }
  } catch (error) {
    try { fsImpl.rmSync(tmp, { force: true }); } catch { /* preserve the original error */ }
    throw error;
  }
  return store;
}

export function appendModelSnapshot(value, options = {}) {
  const snapshot = normalizeSnapshot(value);
  const now = options.now ?? Date.now();
  const store = readModelStore(options);
  store.snapshots = store.snapshots.filter(({ snapshotId }) => snapshotId !== snapshot.snapshotId);
  store.snapshots.push(snapshot);
  if (isCompleteStableSnapshot(snapshot)) {
    store.baselineByScope[snapshot.scope.fingerprint] = snapshot.snapshotId;
  }
  return writeModelStore(store, { ...options, now });
}

export function snapshotById(store, snapshotId) {
  return store?.snapshots?.find((snapshot) => snapshot.snapshotId === snapshotId) ?? null;
}

export function baselineFor(store, scopeFingerprint) {
  const id = store?.baselineByScope?.[scopeFingerprint];
  return id ? snapshotById(store, id) : null;
}

/** Return the most recent earlier baseline-eligible snapshot in the same scope. */
export function previousSnapshot(store, snapshot) {
  if (!snapshot) return null;
  const snapshots = store?.snapshots ?? [];
  const targetIndex = snapshots.findIndex(({ snapshotId }) => snapshotId === snapshot.snapshotId);
  const capturedAt = Date.parse(snapshot.capturedAt);
  return snapshots
    .filter((entry, index) => entry.snapshotId !== snapshot.snapshotId
      && entry.scope.fingerprint === snapshot.scope.fingerprint
      && isCompleteStableSnapshot(entry)
      && (targetIndex >= 0 ? index < targetIndex : Date.parse(entry.capturedAt) < capturedAt))
    .at(-1) ?? null;
}

/** @param {any} store @param {{scopeFingerprint?: string}} [options] */
export function latestSnapshot(store, options = {}) {
  const { scopeFingerprint } = options;
  const values = (store?.snapshots ?? [])
    .filter((snapshot) => !scopeFingerprint || snapshot.scope.fingerprint === scopeFingerprint);
  return values.reduce((latest, snapshot) => !latest
    || Date.parse(snapshot.capturedAt) > Date.parse(latest.capturedAt) ? snapshot : latest, null);
}
