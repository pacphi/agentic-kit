import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { MAX_AUDIT_SOURCE_BYTES, sha256, stableJson } from '../hook-audit/common.mjs';

export const HOOK_HEAL_RECEIPT_SCHEMA = 'hook-heal-receipt/v1';
const RECEIPT_ID = /^tx-[0-9TZ.-]+-[a-f0-9]{16}$/;
const BACKUP_RELATIVE = /^backups[/\\][0-9]{4}\.bin$/;
const RECEIPT_STATUSES = new Set([
  'prepared', 'applying', 'verifying', 'committed', 'rolled-back',
  'undoing', 'failed', 'failed-before-write', 'failed-before-prepared-receipt',
  'partial', 'partial-recovery-required',
]);
const SHA256 = /^[a-f0-9]{64}$/;
const ACTION_CLASSES = new Set(['safe-automatic', 'approval-required']);
const ACTION_STATES = new Set([
  'prepared', 'applied', 'verified', 'rolled-back', 'rollback-drift-refused', 'rollback-failed',
]);

function receiptBody(receipt) {
  const body = { ...receipt };
  delete body.receiptDigest;
  return body;
}

export function sealHookReceipt(receipt) {
  const body = receiptBody(receipt);
  return { ...body, receiptDigest: sha256(stableJson(body)) };
}

function ensureTransactionsRoot(transactionsRoot, fsImpl) {
  if (!path.isAbsolute(transactionsRoot)) throw new TypeError('transactions root must be absolute');
  if (path.resolve(transactionsRoot) === path.parse(path.resolve(transactionsRoot)).root) {
    throw new Error('filesystem root cannot be used as the transactions root');
  }
  let created = false;
  try {
    const stat = fsImpl.lstatSync(transactionsRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('transactions root must be a non-symlink directory');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const missing = [];
    let cursor = transactionsRoot;
    while (true) {
      try {
        const ancestor = fsImpl.lstatSync(cursor);
        if (!ancestor.isDirectory() || ancestor.isSymbolicLink()) {
          throw new Error(`transactions root ancestor is unsafe: ${cursor}`);
        }
        break;
      } catch (ancestorError) {
        if (ancestorError?.code !== 'ENOENT') throw ancestorError;
        missing.push(cursor);
        const parent = path.dirname(cursor);
        if (parent === cursor) throw new Error('could not find a safe transactions root ancestor');
        cursor = parent;
      }
    }
    for (const directory of missing.reverse()) {
      fsImpl.mkdirSync(directory, { mode: 0o700 });
      fsyncDirectoryStrict(path.dirname(directory), fsImpl);
      fsyncDirectoryStrict(directory, fsImpl);
    }
    created = true;
  }
  const final = fsImpl.lstatSync(transactionsRoot);
  if (!final.isDirectory() || final.isSymbolicLink()) throw new Error('transactions root creation was unsafe');
  if (process.platform !== 'win32' && (final.mode & 0o077) !== 0) {
    throw new Error(`transactions root must already be private (mode 0700): ${transactionsRoot}`);
  }
  if (typeof process.getuid === 'function' && typeof final.uid === 'number' && final.uid !== process.getuid()) {
    throw new Error(`transactions root must be owned by the current user: ${transactionsRoot}`);
  }
  return { created, stat: final, realPath: fsImpl.realpathSync(transactionsRoot) };
}

export function createHookTransactionDir(transactionsRoot, { fsImpl = fs, now = () => new Date() } = {}) {
  ensureTransactionsRoot(transactionsRoot, fsImpl);
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const stamp = now().toISOString().replaceAll(':', '-');
    const id = `tx-${stamp}-${randomBytes(8).toString('hex')}`;
    const dir = path.join(transactionsRoot, id);
    try {
      fsImpl.mkdirSync(dir, { mode: 0o700 });
      fsyncDirectoryStrict(transactionsRoot, fsImpl);
      return { id, dir, receiptFile: path.join(dir, 'receipt.json') };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('could not allocate a unique hook transaction directory');
}

function writeAll(fsImpl, descriptor, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = fsImpl.writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
    if (written <= 0) throw new Error('receipt write made no progress');
    offset += written;
  }
}

function fsyncDirectoryStrict(directory, fsImpl) {
  if (typeof fsImpl.fsyncSync !== 'function') throw new Error('receipt durability requires fsync support');
  let descriptor;
  try {
    descriptor = fsImpl.openSync(directory, fs.constants.O_RDONLY);
    fsImpl.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fsImpl.closeSync(descriptor);
  }
}

function writeReceiptAtomic(receiptFile, bytes, fsImpl) {
  if (!path.isAbsolute(receiptFile) || path.basename(receiptFile) !== 'receipt.json') {
    throw new TypeError('receipt path must be an absolute transaction receipt.json path');
  }
  const directory = path.dirname(receiptFile);
  const id = path.basename(directory);
  if (!RECEIPT_ID.test(id)) throw new Error('receipt transaction directory name is invalid');
  const directoryStat = fsImpl.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('receipt transaction directory is unsafe');
  if (process.platform !== 'win32' && (directoryStat.mode & 0o077) !== 0) throw new Error('receipt transaction directory is not private');
  const realDirectory = fsImpl.realpathSync(directory);
  const realRoot = fsImpl.realpathSync(path.dirname(directory));
  if (path.dirname(realDirectory) !== realRoot || path.basename(realDirectory) !== id) {
    throw new Error('receipt transaction directory escapes its transactions root');
  }
  let prior = null;
  try {
    prior = fsImpl.lstatSync(receiptFile);
    if (!prior.isFile() || prior.isSymbolicLink()) throw new Error('existing receipt is unsafe');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const temporary = path.join(directory, `.receipt.${randomBytes(12).toString('hex')}.tmp`);
  let descriptor;
  let renamed = false;
  try {
    descriptor = fsImpl.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    writeAll(fsImpl, descriptor, bytes);
    if (typeof fsImpl.fsyncSync !== 'function') throw new Error('receipt durability requires fsync support');
    fsImpl.fsyncSync(descriptor);
    fsImpl.closeSync(descriptor);
    descriptor = undefined;
    const currentDirectory = fsImpl.lstatSync(directory);
    if (currentDirectory.dev !== directoryStat.dev || currentDirectory.ino !== directoryStat.ino) {
      throw new Error('receipt transaction directory changed before commit');
    }
    if (prior) {
      const currentReceipt = fsImpl.lstatSync(receiptFile);
      if (!currentReceipt.isFile() || currentReceipt.isSymbolicLink()
          || currentReceipt.dev !== prior.dev || currentReceipt.ino !== prior.ino) {
        throw new Error('receipt changed before commit');
      }
    }
    fsImpl.renameSync(temporary, receiptFile);
    renamed = true;
    fsyncDirectoryStrict(directory, fsImpl);
  } finally {
    if (descriptor !== undefined) fsImpl.closeSync(descriptor);
    if (!renamed) {
      try { fsImpl.rmSync(temporary, { force: true }); } catch { /* cleanup must not mask the failure */ }
    }
  }
}

export function writeHookReceipt(receiptFile, receipt, { fsImpl = fs } = {}) {
  const sealed = sealHookReceipt(receipt);
  const bytes = Buffer.from(`${JSON.stringify(sealed, null, 2)}\n`);
  if (bytes.length > MAX_AUDIT_SOURCE_BYTES) throw new Error('receipt exceeds the bounded receipt size limit');
  writeReceiptAtomic(receiptFile, bytes, fsImpl);
  return sealed;
}

export function backupFileForReceiptAction(transactionDir, action) {
  if (!BACKUP_RELATIVE.test(action?.backup?.relative ?? '')) throw new Error('receipt backup path is invalid');
  const file = path.resolve(transactionDir, action.backup.relative);
  const relative = path.relative(path.resolve(transactionDir), file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('receipt backup escapes its transaction');
  return file;
}

function contained(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function validImage(image, { preimage = false } = {}) {
  return image && typeof image === 'object' && SHA256.test(image.sha256)
    && Number.isSafeInteger(image.size) && image.size >= 0
    && typeof image.modeSupported === 'boolean'
    && (image.mode === null || (Number.isInteger(image.mode) && image.mode >= 0 && image.mode <= 0o777))
    && (!preimage || (
      (image.uid === null || Number.isInteger(image.uid))
      && (image.gid === null || Number.isInteger(image.gid))
      && Number.isInteger(image.specialMode) && image.specialMode >= 0 && image.specialMode <= 0o7000
      && path.isAbsolute(image.parent?.realPath ?? '')
      && Number.isInteger(image.parent?.dev) && Number.isInteger(image.parent?.ino)
    ));
}

function validateReceipt(receipt, receiptId, transactionDir) {
  if (receipt.schemaVersion !== HOOK_HEAL_RECEIPT_SCHEMA) throw new Error('unsupported hook receipt schema');
  if (receipt.id !== receiptId || !Array.isArray(receipt.actions)) throw new Error('receipt identity is invalid');
  if (!RECEIPT_STATUSES.has(receipt.status) || !Number.isFinite(Date.parse(receipt.createdAt))) throw new Error('receipt state is invalid');
  if (!SHA256.test(receipt.planDigest ?? '') || typeof receipt.auditId !== 'string') throw new Error('receipt plan identity is invalid');
  const ids = new Set();
  const targets = new Set();
  for (const action of receipt.actions) {
    if (!action || typeof action !== 'object' || typeof action.id !== 'string' || ids.has(action.id)) throw new Error('receipt action identity is invalid');
    ids.add(action.id);
    if (!ACTION_CLASSES.has(action.classification) || typeof action.host !== 'string' || typeof action.hostVersion !== 'string'
        || typeof action.recipeId !== 'string' || typeof action.profileId !== 'string'
        || !ACTION_STATES.has(action.state)) throw new Error('receipt action policy is invalid');
    if (!path.isAbsolute(action.target ?? '') || !path.isAbsolute(action.containmentRoot ?? '')) throw new Error('receipt action paths must be absolute');
    const target = path.resolve(action.target);
    const root = path.resolve(action.containmentRoot);
    if (target !== action.target || root !== action.containmentRoot || root === path.parse(root).root || !contained(root, target)) throw new Error('receipt action target escapes its bounded root');
    if (targets.has(target)) throw new Error('receipt contains duplicate targets');
    targets.add(target);
    if (!validImage(action.preimage, { preimage: true }) || !validImage(action.postimage)) throw new Error('receipt action image is invalid');
    if (!action.backup || !SHA256.test(action.backup.sha256 ?? '') || action.backup.sha256 !== action.preimage.sha256
        || action.backup.size !== action.preimage.size) throw new Error('receipt backup metadata is invalid');
    backupFileForReceiptAction(transactionDir, action);
  }
  const authorized = receipt.authorization?.actionIds;
  if (!Array.isArray(authorized) || new Set(authorized).size !== authorized.length
      || authorized.some((id) => typeof id !== 'string')
      || [...authorized].sort().join('\0') !== [...ids].sort().join('\0')) {
    throw new Error('receipt authorization does not match its actions');
  }
  if (receipt.actions.length && (receipt.authorization.mechanism !== 'explicit-action-selection'
      || receipt.authorization.trustMutationAuthorized !== false)) {
    throw new Error('receipt authorization policy is invalid');
  }
}

function readReceiptDescriptor(file, realRoot, fsImpl) {
  const before = fsImpl.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_AUDIT_SOURCE_BYTES) throw new Error('receipt must be a bounded regular non-symlink file');
  const realFile = fsImpl.realpathSync(file);
  if (!contained(realRoot, realFile)) throw new Error('receipt escapes its transaction root');
  let descriptor;
  try {
    descriptor = fsImpl.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fsImpl.fstatSync(descriptor);
    if (!opened.isFile() || opened.size > MAX_AUDIT_SOURCE_BYTES || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('receipt identity changed while opening');
    if (fsImpl.realpathSync(file) !== realFile) throw new Error('receipt path changed while opening');
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fsImpl.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== bytes.length) throw new Error('receipt changed while reading');
    return JSON.parse(bytes.toString('utf8'));
  } finally {
    if (descriptor !== undefined) fsImpl.closeSync(descriptor);
  }
}

export function readHookReceipt(transactionsRoot, receiptId, { fsImpl = fs } = {}) {
  if (!path.isAbsolute(transactionsRoot)) throw new TypeError('transactions root must be absolute');
  if (!RECEIPT_ID.test(receiptId)) throw new TypeError('invalid hook receipt id');
  const rootStat = fsImpl.lstatSync(transactionsRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('transactions root is unsafe');
  if (process.platform !== 'win32' && (rootStat.mode & 0o077) !== 0) throw new Error('transactions root is not private');
  if (typeof process.getuid === 'function' && typeof rootStat.uid === 'number' && rootStat.uid !== process.getuid()) {
    throw new Error('transactions root is not owned by the current user');
  }
  const realRoot = fsImpl.realpathSync(transactionsRoot);
  const dir = path.join(transactionsRoot, receiptId);
  const file = path.join(dir, 'receipt.json');
  const dirStat = fsImpl.lstatSync(dir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw new Error('transaction directory is unsafe');
  const realDir = fsImpl.realpathSync(dir);
  const relativeDir = path.relative(realRoot, realDir);
  if (relativeDir.startsWith('..') || path.isAbsolute(relativeDir)) throw new Error('transaction escapes its root');
  const receipt = readReceiptDescriptor(file, realRoot, fsImpl);
  validateReceipt(receipt, receiptId, dir);
  const expected = sha256(stableJson(receiptBody(receipt)));
  if (receipt.receiptDigest !== expected) throw new Error('hook receipt integrity check failed');
  return { dir, file, receipt };
}

export function lastHookReceiptId(transactionsRoot, { fsImpl = fs } = {}) {
  let entries;
  try { entries = fsImpl.readdirSync(transactionsRoot, { withFileTypes: true }); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !RECEIPT_ID.test(entry.name)) continue;
    try {
      const { receipt } = readHookReceipt(transactionsRoot, entry.name, { fsImpl });
      candidates.push(receipt);
    } catch { /* invalid receipts are not eligible for implicit --last */ }
  }
  candidates.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id));
  return candidates.at(-1)?.id ?? null;
}

export function unfinishedHookReceipts(transactionsRoot, { fsImpl = fs } = {}) {
  let entries;
  try { entries = fsImpl.readdirSync(transactionsRoot, { withFileTypes: true }); } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return entries.filter((entry) => entry.isDirectory() && RECEIPT_ID.test(entry.name)).flatMap((entry) => {
    try {
      const { receipt } = readHookReceipt(transactionsRoot, entry.name, { fsImpl });
      return ['prepared', 'applying', 'verifying', 'undoing', 'partial', 'failed',
        'failed-before-write', 'failed-before-prepared-receipt', 'partial-recovery-required'].includes(receipt.status) ? [receipt] : [];
    } catch (error) {
      return [{
        id: entry.name, status: 'unknown-recovery-required', createdAt: null,
        error: error?.message ?? String(error),
      }];
    }
  }).sort((a, b) => a.id.localeCompare(b.id));
}
