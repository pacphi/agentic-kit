import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const MAINTENANCE_RECEIPT_SCHEMA = 'maintenance-receipt/v1';
const RECEIPT_ID = /^mnt-[A-Za-z0-9._-]{1,120}$/;
const MAX_RECEIPT_BYTES = 1024 * 1024;
const UNFINISHED = new Set([
  'prepared', 'applying', 'verifying', 'refreshing-catalog', 'undoing', 'failed', 'partial',
  'partial-recovery-required', 'outcome-unknown',
]);

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function withoutIntegrity(receipt) {
  const { integrity: _integrity, ...payload } = receipt;
  return payload;
}

function assertSafeRoot(root, fsImpl, { create = true } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw new TypeError('maintenance transaction root must be a dedicated absolute directory');
  }
  const resolved = path.normalize(root);
  if (path.dirname(resolved) === resolved) {
    throw new TypeError('maintenance transaction root must be a dedicated absolute directory');
  }
  if (create) fsImpl.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  else if (!fsImpl.existsSync(resolved)) return null;
  const stat = fsImpl.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('maintenance transaction root is unsafe');
  if (!create && process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error('maintenance transaction root is not private');
  }
  if (create) fsImpl.chmodSync?.(resolved, 0o700);
  return resolved;
}

function assertReceiptId(id) {
  if (!RECEIPT_ID.test(String(id ?? ''))) throw new TypeError('invalid maintenance receipt id');
}

function syncDirectory(dir, fsImpl) {
  if (!fsImpl.openSync || !fsImpl.fsyncSync || !fsImpl.closeSync) return;
  let fd;
  try { fd = fsImpl.openSync(dir, 'r'); fsImpl.fsyncSync(fd); } finally { if (fd !== undefined) fsImpl.closeSync(fd); }
}

export function createMaintenanceTransaction(transactionsRoot, {
  fsImpl = fs, now = () => new Date(), nonce = () => randomBytes(12).toString('hex'),
} = {}) {
  const root = assertSafeRoot(transactionsRoot, fsImpl);
  const stamp = now().toISOString().replace(/[-:.]/g, '');
  const id = `mnt-${stamp}-${String(nonce()).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 32)}`;
  assertReceiptId(id);
  const dir = path.join(root, id);
  fsImpl.mkdirSync(dir, { mode: 0o700 });
  fsImpl.chmodSync?.(dir, 0o700);
  syncDirectory(root, fsImpl);
  return { id, dir, file: path.join(dir, 'receipt.json') };
}

export function writeMaintenanceReceipt(file, receipt, { fsImpl = fs } = {}) {
  if (!receipt || receipt.schemaVersion !== MAINTENANCE_RECEIPT_SCHEMA) {
    throw new TypeError('invalid maintenance receipt schema');
  }
  assertReceiptId(receipt.id);
  const dir = path.dirname(path.resolve(file));
  const dirStat = fsImpl.lstatSync(dir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw new Error('maintenance receipt directory is unsafe');
  const payload = withoutIntegrity(receipt);
  const sealed = { ...payload, integrity: { algorithm: 'sha256', digest: digest(payload) } };
  const bytes = `${JSON.stringify(sealed, null, 2)}\n`;
  if (Buffer.byteLength(bytes) > MAX_RECEIPT_BYTES) throw new Error('maintenance receipt exceeds size limit');
  const tmp = path.join(dir, `.receipt-${process.pid}-${randomBytes(6).toString('hex')}.tmp`);
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
    try { fsImpl.unlinkSync(tmp); } catch { /* absent or already renamed */ }
    throw error;
  }
  return sealed;
}

export function readMaintenanceReceipt(transactionsRoot, id, { fsImpl = fs, createRoot = true } = {}) {
  assertReceiptId(id);
  const root = assertSafeRoot(transactionsRoot, fsImpl, { create: createRoot });
  if (!root) throw new Error('maintenance transaction root is absent');
  const dir = path.join(root, id);
  const file = path.join(dir, 'receipt.json');
  const dirStat = fsImpl.lstatSync(dir);
  const fileStat = fsImpl.lstatSync(file);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()
      || !fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error('maintenance receipt path is unsafe');
  if (fileStat.size > MAX_RECEIPT_BYTES) throw new Error('maintenance receipt exceeds size limit');
  const receipt = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
  if (receipt.schemaVersion !== MAINTENANCE_RECEIPT_SCHEMA || receipt.id !== id) {
    throw new Error('maintenance receipt identity mismatch');
  }
  const payload = withoutIntegrity(receipt);
  if (receipt.integrity?.algorithm !== 'sha256' || receipt.integrity.digest !== digest(payload)) {
    throw new Error('maintenance receipt integrity check failed');
  }
  return { receipt, dir, file };
}

export function listMaintenanceReceipts(transactionsRoot, { fsImpl = fs } = {}) {
  const root = assertSafeRoot(transactionsRoot, fsImpl);
  return fsImpl.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && RECEIPT_ID.test(entry.name))
    .flatMap((entry) => {
      try {
        const { receipt } = readMaintenanceReceipt(root, entry.name, { fsImpl, createRoot: false });
        return [receipt];
      } catch (error) {
        return [{ id: entry.name, status: 'unknown-recovery-required', error: error.message }];
      }
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Read existing journals without materializing the control plane. Integrity
 * failures are returned as recovery state; their raw errors never leave the
 * application service. */
export function listMaintenanceReceiptsReadOnly(transactionsRoot, { fsImpl = fs } = {}) {
  let root;
  try {
    root = assertSafeRoot(transactionsRoot, fsImpl, { create: false });
  } catch {
    return [{ id: 'mnt-state-recovery-required', status: 'unknown-recovery-required' }];
  }
  if (!root) return [];
  return fsImpl.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && RECEIPT_ID.test(entry.name))
    .flatMap((entry) => {
      try {
        const { receipt } = readMaintenanceReceipt(root, entry.name, { fsImpl, createRoot: false });
        return [receipt];
      } catch {
        return [{ id: entry.name, status: 'unknown-recovery-required' }];
      }
    })
    .sort((a, b) => b.id.localeCompare(a.id));
}

export function listUnfinishedMaintenanceReceipts(transactionsRoot, { fsImpl = fs } = {}) {
  return listMaintenanceReceipts(transactionsRoot, { fsImpl })
    .filter((receipt) => UNFINISHED.has(receipt.status) || receipt.status === 'unknown-recovery-required');
}
