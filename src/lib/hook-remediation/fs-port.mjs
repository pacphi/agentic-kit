import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { sha256 } from '../hook-audit/common.mjs';

function contained(root, file, platform = process.platform) {
  const normalize = (value) => platform === 'win32' ? value.toLowerCase() : value;
  const canonicalRoot = normalize(root);
  const canonicalFile = normalize(file);
  return canonicalFile === canonicalRoot || canonicalFile.startsWith(`${canonicalRoot}${path.sep}`);
}

export function inspectHookTarget(file, containmentRoot, { fsImpl = fs, platform = process.platform } = {}) {
  let descriptor;
  try {
    const stat = fsImpl.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('target must be a regular non-symlink file');
    const realRoot = fsImpl.realpathSync(containmentRoot);
    const realFile = fsImpl.realpathSync(file);
    if (!contained(realRoot, realFile, platform)) throw new Error('target escapes its containment root');
    descriptor = fsImpl.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fsImpl.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
      throw new Error('target identity changed between inspection and open');
    }
    const reopened = fsImpl.realpathSync(file);
    if (reopened !== realFile || !contained(realRoot, reopened, platform)) {
      throw new Error('target path changed between inspection and open');
    }
    const bytes = fsImpl.readFileSync(descriptor);
    return {
      file, containmentRoot, bytes, sha256: sha256(bytes), size: bytes.length,
      mode: platform === 'win32' ? null : opened.mode & 0o777,
      modeSupported: platform !== 'win32', mtimeMs: opened.mtimeMs,
      device: opened.dev, inode: opened.ino,
    };
  } finally {
    if (descriptor !== undefined) fsImpl.closeSync(descriptor);
  }
}

export function assertHookTargetUnchanged(snapshot, options = {}) {
  const current = inspectHookTarget(snapshot.file, snapshot.containmentRoot, options);
  const sameMode = current.modeSupported === snapshot.modeSupported
    && (!current.modeSupported || current.mode === snapshot.mode);
  if (current.sha256 !== snapshot.sha256 || current.device !== snapshot.device
    || current.inode !== snapshot.inode || !sameMode) {
    throw new Error(`target changed after preflight: ${snapshot.file}`);
  }
  return current;
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

function syncDirectory(dir, fsImpl, platform = process.platform) {
  if (platform === 'win32' || typeof fsImpl.fsyncSync !== 'function') return;
  let descriptor;
  try {
    descriptor = fsImpl.openSync(dir, 'r');
    fsImpl.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fsImpl.closeSync(descriptor);
  }
}

export function writeHookBackup(transactionDir, index, snapshot, { fsImpl = fs } = {}) {
  const backupsDir = path.join(transactionDir, 'backups');
  fsImpl.mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
  const relative = path.join('backups', `${String(index).padStart(4, '0')}.bin`);
  const file = path.join(transactionDir, relative);
  exclusiveWrite(file, snapshot.bytes, 0o600, fsImpl);
  syncDirectory(backupsDir, fsImpl);
  const saved = inspectHookTarget(file, transactionDir, { fsImpl });
  if (saved.sha256 !== snapshot.sha256) throw new Error(`backup verification failed for ${snapshot.file}`);
  return { relative, sha256: saved.sha256, size: saved.size };
}

export function atomicReplaceHookTarget(snapshot, bytes, desiredMode = snapshot.mode, {
  fsImpl = fs, platform = process.platform,
} = {}) {
  const options = { fsImpl, platform };
  assertHookTargetUnchanged(snapshot, options);
  const suffix = randomBytes(12).toString('hex');
  const temporary = path.join(path.dirname(snapshot.file), `.${path.basename(snapshot.file)}.${suffix}.tmp`);
  let renamed = false;
  try {
    exclusiveWrite(temporary, bytes, snapshot.modeSupported ? desiredMode : 0o600, fsImpl);
    if (snapshot.modeSupported) fsImpl.chmodSync(temporary, desiredMode);
    assertHookTargetUnchanged(snapshot, options);
    fsImpl.renameSync(temporary, snapshot.file);
    renamed = true;
    if (snapshot.modeSupported) fsImpl.chmodSync(snapshot.file, desiredMode);
    syncDirectory(path.dirname(snapshot.file), fsImpl, platform);
  } finally {
    if (!renamed) {
      try { fsImpl.rmSync(temporary, { force: true }); } catch { /* cleanup must not mask the failure */ }
    }
  }
  return inspectHookTarget(snapshot.file, snapshot.containmentRoot, options);
}
