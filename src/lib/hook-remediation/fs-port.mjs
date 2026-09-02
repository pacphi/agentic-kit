import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { MAX_AUDIT_SOURCE_BYTES, sha256 } from '../hook-audit/common.mjs';

export const MAX_HOOK_TARGET_BYTES = MAX_AUDIT_SOURCE_BYTES;

function normalizedForPlatform(value, platform) {
  return platform === 'win32' ? value.toLowerCase() : value;
}

function contained(root, file, platform = process.platform) {
  const normalizedRoot = normalizedForPlatform(root, platform);
  const normalizedFile = normalizedForPlatform(file, platform);
  const relative = path.relative(normalizedRoot, normalizedFile);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function readDescriptor(fsImpl, descriptor, size) {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = fsImpl.readSync(descriptor, bytes, offset, size - offset, offset);
    if (count === 0) break;
    offset += count;
  }
  if (offset !== size) throw new Error('target changed while it was read');
  return bytes;
}

export function inspectHookTarget(file, containmentRoot, {
  fsImpl = fs, platform = process.platform, maxBytes = MAX_HOOK_TARGET_BYTES,
} = {}) {
  if (!path.isAbsolute(file) || !path.isAbsolute(containmentRoot)) {
    throw new TypeError('hook target and containment root must be absolute paths');
  }
  let descriptor;
  try {
    const stat = fsImpl.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('target must be a regular non-symlink file');
    if (stat.size > maxBytes) throw new Error(`target exceeds ${maxBytes} byte limit`);
    const realRoot = fsImpl.realpathSync(containmentRoot);
    const realFile = fsImpl.realpathSync(file);
    if (!contained(realRoot, realFile, platform)) throw new Error('target escapes its containment root');
    descriptor = fsImpl.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fsImpl.fstatSync(descriptor);
    if (!opened.isFile() || opened.size > maxBytes) throw new Error('opened target is not a bounded regular file');
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) {
      throw new Error('target identity changed between inspection and open');
    }
    const reopened = fsImpl.realpathSync(file);
    if (reopened !== realFile || !contained(realRoot, reopened, platform)) {
      throw new Error('target path changed between inspection and open');
    }
    const bytes = readDescriptor(fsImpl, descriptor, opened.size);
    const parent = path.dirname(realFile);
    const parentStat = fsImpl.statSync(parent);
    return {
      file: path.resolve(file), containmentRoot: path.resolve(containmentRoot),
      realFile, realRoot, bytes, sha256: sha256(bytes), size: bytes.length,
      mode: platform === 'win32' ? null : opened.mode & 0o777,
      modeSupported: platform !== 'win32', mtimeMs: opened.mtimeMs,
      uid: typeof opened.uid === 'number' ? opened.uid : null,
      gid: typeof opened.gid === 'number' ? opened.gid : null,
      specialMode: platform === 'win32' ? 0 : opened.mode & 0o7000,
      parent: { realPath: parent, dev: parentStat.dev, ino: parentStat.ino },
    };
  } finally {
    if (descriptor !== undefined) fsImpl.closeSync(descriptor);
  }
}

function exclusiveWrite(file, bytes, mode, fsImpl) {
  let descriptor;
  try {
    descriptor = fsImpl.openSync(file, 'wx', mode);
    fsImpl.writeFileSync(descriptor, bytes);
    if (typeof fsImpl.fsyncSync === 'function') fsImpl.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fsImpl.closeSync(descriptor);
  }
}

function fsyncDirectory(directory, fsImpl) {
  if (typeof fsImpl.fsyncSync !== 'function') throw new Error('durable hook mutation requires directory fsync support');
  let descriptor;
  try {
    descriptor = fsImpl.openSync(directory, fs.constants.O_RDONLY);
    fsImpl.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fsImpl.closeSync(descriptor);
  }
}

export function writeHookBackup(transactionDir, index, snapshot, { fsImpl = fs } = {}) {
  const backupsDir = path.join(transactionDir, 'backups');
  try {
    const existing = fsImpl.lstatSync(backupsDir);
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new Error('backup directory must be a non-symlink directory');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    fsImpl.mkdirSync(backupsDir, { mode: 0o700 });
  }
  const backupDirectory = fsImpl.lstatSync(backupsDir);
  if (!backupDirectory.isDirectory() || backupDirectory.isSymbolicLink()) {
    throw new Error('backup directory became unsafe');
  }
  fsyncDirectory(transactionDir, fsImpl);
  const relative = path.join('backups', `${String(index).padStart(4, '0')}.bin`);
  const file = path.join(transactionDir, relative);
  exclusiveWrite(file, snapshot.bytes, 0o600, fsImpl);
  fsyncDirectory(backupsDir, fsImpl);
  const saved = inspectHookTarget(file, transactionDir, { fsImpl });
  if (saved.sha256 !== snapshot.sha256) throw new Error(`backup verification failed for ${snapshot.file}`);
  return { relative, sha256: saved.sha256, size: saved.size };
}

export function atomicReplaceHookTarget(snapshot, bytes, desiredMode = snapshot.mode, {
  fsImpl = fs, platform = process.platform,
} = {}) {
  if (platform === 'win32') {
    throw new Error('hook mutation is unsupported on Windows until replace-existing atomicity is proven');
  }
  const current = inspectHookTarget(snapshot.file, snapshot.containmentRoot, { fsImpl, platform });
  if (current.sha256 !== snapshot.sha256
      || current.modeSupported !== snapshot.modeSupported
      || (current.modeSupported && current.mode !== snapshot.mode)
      || current.uid !== snapshot.uid || current.gid !== snapshot.gid
      || current.specialMode !== snapshot.specialMode) {
    throw new Error(`target changed immediately before replacement: ${snapshot.file}`);
  }
  const currentParent = fsImpl.statSync(path.dirname(current.realFile));
  if (current.parent.realPath !== snapshot.parent.realPath
      || currentParent.dev !== snapshot.parent.dev || currentParent.ino !== snapshot.parent.ino) {
    throw new Error(`target parent changed immediately before replacement: ${snapshot.file}`);
  }
  const suffix = randomBytes(12).toString('hex');
  const temporary = path.join(path.dirname(snapshot.file), `.${path.basename(snapshot.file)}.${suffix}.tmp`);
  let renamed = false;
  try {
    exclusiveWrite(temporary, bytes, snapshot.modeSupported ? desiredMode : 0o600, fsImpl);
    if (snapshot.modeSupported) fsImpl.chmodSync(temporary, desiredMode);
    fsImpl.renameSync(temporary, snapshot.file);
    renamed = true;
    fsyncDirectory(path.dirname(snapshot.file), fsImpl);
  } finally {
    if (!renamed) {
      try { fsImpl.rmSync(temporary, { force: true }); } catch { /* cleanup must not mask the failure */ }
    }
  }
  return inspectHookTarget(snapshot.file, snapshot.containmentRoot, { fsImpl, platform });
}
