import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { sha256 } from './evidence.mjs';
import { assertExecutableMaintenancePlanIntegrity } from './planner.mjs';

export const MAINTENANCE_PLAN_ENVELOPE_SCHEMA = 'maintenance-plan-envelope/v1';
const PLAN_ID = /^maintenance-plan-[a-f0-9]{20}$/;
const MAX_PLAN_BYTES = 512 * 1024;
const FORBIDDEN_KEYS = /^(?:argv|command|cwd|env|headers|path|token|secret|credential)$/i;

export function ensurePrivateMaintenanceRoot(root, { fsImpl = fs } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw new TypeError('maintenance plan root must be a dedicated absolute directory');
  }
  const resolved = path.normalize(root);
  if (path.dirname(resolved) === resolved) throw new TypeError('maintenance plan root must be a dedicated absolute directory');
  fsImpl.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const stat = fsImpl.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('maintenance plan root is unsafe');
  fsImpl.chmodSync?.(resolved, 0o700);
  return resolved;
}

function planFile(root, planId) {
  if (!PLAN_ID.test(String(planId ?? ''))) throw new TypeError('invalid maintenance plan id');
  return path.join(root, `${planId}.json`);
}

function contentSafe(value, key = '') {
  if (FORBIDDEN_KEYS.test(key)) return false;
  if (Array.isArray(value)) return value.every((item) => contentSafe(item));
  if (value && typeof value === 'object') {
    return Object.entries(value).every(([childKey, child]) => contentSafe(child, childKey));
  }
  return typeof value !== 'string' || (!value.includes('\0') && !value.includes('\r') && !value.includes('\n'));
}

function payload(envelope) {
  const { integrity: _integrity, ...rest } = envelope;
  return rest;
}

function syncDirectory(dir, fsImpl) {
  if (!fsImpl.openSync || !fsImpl.fsyncSync || !fsImpl.closeSync) return;
  let fd;
  try { fd = fsImpl.openSync(dir, 'r'); fsImpl.fsyncSync(fd); } finally { if (fd !== undefined) fsImpl.closeSync(fd); }
}

export function writeMaintenancePlanEnvelope(root, plan, {
  fsImpl = fs, now = Date.now,
} = {}) {
  assertExecutableMaintenancePlanIntegrity(plan, { now });
  if (!contentSafe(plan)) throw new Error('maintenance plan contains unsafe content');
  const dir = ensurePrivateMaintenanceRoot(root, { fsImpl });
  const file = planFile(dir, plan.planId);
  const base = {
    schemaVersion: MAINTENANCE_PLAN_ENVELOPE_SCHEMA,
    plan,
  };
  const envelope = { ...base, integrity: { algorithm: 'sha256', digest: sha256(base) } };
  const bytes = `${JSON.stringify(envelope, null, 2)}\n`;
  if (Buffer.byteLength(bytes) > MAX_PLAN_BYTES) throw new Error('maintenance plan exceeds size limit');
  const tmp = path.join(dir, `.plan-${process.pid}-${randomBytes(6).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fsImpl.openSync(tmp, 'wx', 0o600);
    fsImpl.writeFileSync(fd, bytes, 'utf8');
    fsImpl.fsyncSync?.(fd);
    fsImpl.closeSync(fd);
    fd = undefined;
    fsImpl.renameSync(tmp, file);
    fsImpl.chmodSync?.(file, 0o600);
    syncDirectory(dir, fsImpl);
  } catch (error) {
    if (fd !== undefined) { try { fsImpl.closeSync(fd); } catch { /* best effort */ } }
    try { fsImpl.unlinkSync(tmp); } catch { /* absent or renamed */ }
    throw error;
  }
  return file;
}

export function readMaintenancePlanEnvelope(root, planId, {
  fsImpl = fs, now = Date.now,
} = {}) {
  const dir = ensurePrivateMaintenanceRoot(root, { fsImpl });
  const file = planFile(dir, planId);
  let stat;
  try { stat = fsImpl.lstatSync(file); } catch { throw new Error('maintenance plan envelope is unavailable'); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('maintenance plan path is unsafe');
  if (stat.size > MAX_PLAN_BYTES) throw new Error('maintenance plan exceeds size limit');
  const envelope = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
  const base = payload(envelope);
  if (envelope.schemaVersion !== MAINTENANCE_PLAN_ENVELOPE_SCHEMA
      || envelope.plan?.planId !== planId) throw new Error('maintenance plan envelope identity mismatch');
  if (envelope.integrity?.algorithm !== 'sha256' || envelope.integrity.digest !== sha256(base)) {
    throw new Error('maintenance plan envelope integrity check failed');
  }
  if (!contentSafe(envelope.plan)) throw new Error('maintenance plan contains unsafe content');
  assertExecutableMaintenancePlanIntegrity(envelope.plan, { now });
  return { plan: envelope.plan, file };
}
