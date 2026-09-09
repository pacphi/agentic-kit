import fs from 'node:fs';
import path from 'node:path';

import { writePrivateFileAtomic } from '../file-write.mjs';
import { sha256 } from './evidence.mjs';

export const MAINTENANCE_SCAN_SCHEMA = 'maintenance-scan/v1';
const MAX_SCAN_BYTES = 8 * 1024 * 1024;

function scanFile(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw new TypeError('maintenance scan root must be a dedicated absolute directory');
  }
  const resolved = path.normalize(root);
  if (path.dirname(resolved) === resolved) throw new TypeError('maintenance scan root must be a dedicated absolute directory');
  return path.join(resolved, 'latest-scan.json');
}

function safeRoot(root, fsImpl, { create = false } = {}) {
  const file = scanFile(root);
  const dir = path.dirname(file);
  if (create) fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
  else if (!fsImpl.existsSync(dir)) return null;
  const stat = fsImpl.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('maintenance scan root is unsafe');
  if (create) fsImpl.chmodSync?.(dir, 0o700);
  return file;
}

function payload(envelope) {
  const { integrity: _integrity, ...value } = envelope;
  return value;
}

/** Persist the latest content-free Maintenance result. This is a derived scan
 * cache, not an authority receipt; a later explicit scan replaces it. */
export function writeMaintenanceScan(root, model, { fsImpl = fs } = {}) {
  const file = safeRoot(root, fsImpl, { create: true });
  const base = { schemaVersion: MAINTENANCE_SCAN_SCHEMA, model };
  const envelope = { ...base, integrity: { algorithm: 'sha256', digest: sha256(base) } };
  const bytes = `${JSON.stringify(envelope)}\n`;
  if (Buffer.byteLength(bytes) > MAX_SCAN_BYTES) throw new Error('maintenance scan exceeds size limit');
  writePrivateFileAtomic(file, bytes, { fsImpl });
  return file;
}

/** Read the latest scan without creating state or running any collector. */
export function readMaintenanceScan(root, { fsImpl = fs } = {}) {
  let file;
  try { file = safeRoot(root, fsImpl); } catch { return { status: 'unavailable', model: null }; }
  if (!file) return { status: 'not-scanned', model: null };
  let stat;
  try { stat = fsImpl.lstatSync(file); } catch (error) {
    return { status: error?.code === 'ENOENT' ? 'not-scanned' : 'unavailable', model: null };
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SCAN_BYTES) {
    return { status: 'unavailable', model: null };
  }
  try {
    const envelope = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    const base = payload(envelope);
    if (envelope.schemaVersion !== MAINTENANCE_SCAN_SCHEMA
        || envelope.integrity?.algorithm !== 'sha256'
        || envelope.integrity.digest !== sha256(base)
        || !envelope.model || typeof envelope.model !== 'object') {
      return { status: 'unavailable', model: null };
    }
    return { status: 'available', model: envelope.model };
  } catch {
    return { status: 'unavailable', model: null };
  }
}
