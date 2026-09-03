import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MAINTENANCE_LOCK_SCHEMA = 'maintenance-mutation-lock/v1';
const OWNER_FILE = 'owner.json';
const RECLAIM_FILE = '.reclaim';
const MAX_OWNER_BYTES = 16 * 1024;

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function safeMachineId(value) {
  const result = String(value ?? '');
  const hasControl = Array.from(result).some((character) => {
    const code = character.codePointAt(0);
    return code <= 31 || code === 127;
  });
  if (!result || result.length > 256 || hasControl) {
    throw new TypeError('maintenance lock machine identity is invalid');
  }
  return result;
}

function safeRoot(transactionsRoot, fsImpl, currentUid) {
  if (typeof transactionsRoot !== 'string' || !path.isAbsolute(transactionsRoot)) {
    throw new TypeError('maintenance transaction root must be an absolute directory');
  }
  const root = path.normalize(transactionsRoot);
  if (path.dirname(root) === root) throw new TypeError('maintenance transaction root must be dedicated');
  fsImpl.mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = fsImpl.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('maintenance transaction root is unsafe');
  if (currentUid != null && stat.uid !== currentUid) throw new Error('maintenance transaction root owner is unsafe');
  fsImpl.chmodSync?.(root, 0o700);
  return root;
}

function ownerPayload({ pid, machineId, currentUid, now, nonce }) {
  const payload = {
    schemaVersion: MAINTENANCE_LOCK_SCHEMA,
    machineId: safeMachineId(machineId),
    pid,
    uid: currentUid ?? null,
    createdAt: new Date(now()).toISOString(),
    nonce: String(nonce()).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 96),
  };
  if (!Number.isSafeInteger(payload.pid) || payload.pid <= 0 || !payload.nonce
      || !Number.isFinite(Date.parse(payload.createdAt))) {
    throw new TypeError('maintenance lock owner metadata is invalid');
  }
  return { ...payload, integrity: { algorithm: 'sha256', digest: digest(payload) } };
}

function writeOwner(lock, owner, fsImpl) {
  const file = path.join(lock, OWNER_FILE);
  const bytes = `${JSON.stringify(owner, null, 2)}\n`;
  let fd;
  try {
    fd = fsImpl.openSync(file, 'wx', 0o600);
    fsImpl.writeFileSync(fd, bytes, 'utf8');
    fsImpl.fsyncSync?.(fd);
    fsImpl.closeSync(fd);
    fd = undefined;
    fsImpl.chmodSync?.(file, 0o600);
  } catch (error) {
    if (fd !== undefined) { try { fsImpl.closeSync(fd); } catch { /* best effort */ } }
    try { fsImpl.unlinkSync(file); } catch { /* absent */ }
    throw error;
  }
}

function privateOwned(stat, currentUid, kind) {
  const typeMatches = kind === 'directory' ? stat.isDirectory() : stat.isFile();
  return typeMatches && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0
    && (currentUid == null || stat.uid === currentUid);
}

function validOwnerPayload(payload, integrity, currentUid) {
  const keys = Object.keys(payload).sort().join(',');
  return keys === 'createdAt,machineId,nonce,pid,schemaVersion,uid'
    && payload.schemaVersion === MAINTENANCE_LOCK_SCHEMA
    && Number.isSafeInteger(payload.pid) && payload.pid > 0
    && typeof payload.machineId === 'string' && payload.machineId.length > 0
    && payload.uid === (currentUid ?? null)
    && typeof payload.nonce === 'string' && payload.nonce.length > 0
    && Number.isFinite(Date.parse(payload.createdAt))
    && integrity?.algorithm === 'sha256' && integrity.digest === digest(payload);
}

function readOwner(lock, fsImpl, currentUid) {
  try {
    const lockStat = fsImpl.lstatSync(lock);
    if (!privateOwned(lockStat, currentUid, 'directory')) return null;
    const names = fsImpl.readdirSync(lock).sort();
    if (names.some((name) => name !== OWNER_FILE && name !== RECLAIM_FILE)) return null;
    const file = path.join(lock, OWNER_FILE);
    const stat = fsImpl.lstatSync(file);
    if (!privateOwned(stat, currentUid, 'file') || stat.size > MAX_OWNER_BYTES) return null;
    const owner = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    const { integrity, ...payload } = owner;
    if (!validOwnerPayload(payload, integrity, currentUid)) return null;
    return owner;
  } catch {
    return null;
  }
}

function observedProcessStatus(pidStatus, pid) {
  try {
    const status = pidStatus(pid);
    return ['absent', 'live', 'unknown'].includes(status) ? status : 'unknown';
  } catch {
    return 'unknown';
  }
}

function processStatus(pid) {
  try {
    process.kill(pid, 0);
    return 'live';
  } catch (error) {
    return error?.code === 'ESRCH' ? 'absent' : 'unknown';
  }
}

function removeExactLock(lock, owner, fsImpl, currentUid) {
  const current = readOwner(lock, fsImpl, currentUid);
  if (!current || current.nonce !== owner.nonce || current.integrity.digest !== owner.integrity.digest) return false;
  if (fsImpl.existsSync(path.join(lock, RECLAIM_FILE))) return false;
  fsImpl.unlinkSync(path.join(lock, OWNER_FILE));
  fsImpl.rmdirSync(lock);
  return true;
}

function reclaimDeadLock(lock, root, expectedMachine, fsImpl, currentUid, pidStatus, reclaimNonce) {
  if (!Number.isInteger(currentUid) || currentUid < 0) return false;
  const owner = readOwner(lock, fsImpl, currentUid);
  if (!owner || owner.machineId !== expectedMachine
      || observedProcessStatus(pidStatus, owner.pid) !== 'absent') return false;
  const marker = path.join(lock, RECLAIM_FILE);
  let fd;
  try {
    fd = fsImpl.openSync(marker, 'wx', 0o600);
    fsImpl.writeFileSync(fd, owner.integrity.digest, 'utf8');
    fsImpl.closeSync(fd);
    fd = undefined;
  } catch {
    if (fd !== undefined) { try { fsImpl.closeSync(fd); } catch { /* best effort */ } }
    return false;
  }
  const confirmed = readOwner(lock, fsImpl, currentUid);
  if (!confirmed || confirmed.integrity.digest !== owner.integrity.digest
      || observedProcessStatus(pidStatus, owner.pid) !== 'absent') {
    try { fsImpl.unlinkSync(marker); } catch { /* fail closed */ }
    return false;
  }
  const suffix = String(reclaimNonce()).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64);
  if (!suffix) return false;
  const tombstone = path.join(root, `.mutation-lock.reclaimed-${suffix}`);
  try {
    fsImpl.renameSync(lock, tombstone);
    const stat = fsImpl.lstatSync(tombstone);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    fsImpl.unlinkSync(path.join(tombstone, RECLAIM_FILE));
    fsImpl.unlinkSync(path.join(tombstone, OWNER_FILE));
    fsImpl.rmdirSync(tombstone);
    return true;
  } catch {
    return false;
  }
}

/** Acquire the process-wide Maintenance mutation lock. A dead lock is only
 * reclaimed when its sealed owner is local, privately owned, and the recorded
 * PID is provably absent. Unknown evidence remains busy. */
export function acquireMaintenanceLock(transactionsRoot, {
  fsImpl = fs,
  pid = process.pid,
  machineId = os.hostname(),
  currentUid = typeof process.getuid === 'function' ? process.getuid() : null,
  pidStatus = processStatus,
  now = Date.now,
  nonce = () => randomBytes(12).toString('hex'),
} = {}) {
  const machine = safeMachineId(machineId);
  const root = safeRoot(transactionsRoot, fsImpl, currentUid);
  const lock = path.join(root, '.mutation-lock');
  const create = () => {
    try { fsImpl.mkdirSync(lock, { mode: 0o700 }); } catch (error) {
      if (error?.code === 'EEXIST') return null;
      throw error;
    }
    const owner = ownerPayload({ pid, machineId: machine, currentUid, now, nonce });
    try { writeOwner(lock, owner, fsImpl); } catch (error) {
      try { fsImpl.rmdirSync(lock); } catch { /* retained malformed lock fails closed */ }
      throw error;
    }
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        removeExactLock(lock, owner, fsImpl, currentUid);
      },
    };
  };
  let acquired = create();
  if (acquired) return acquired;
  if (!reclaimDeadLock(lock, root, machine, fsImpl, currentUid, pidStatus, nonce)) return null;
  acquired = create();
  return acquired;
}
