// Fail-closed, backup-first atomic replacement for user-owned text files.
// A promised recovery copy is part of the write contract: if it cannot be
// created or is not a regular file, the target is left byte-identical.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

let sequence = 0;

function backupState(file, fsImpl) {
  try {
    const stat = fsImpl.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`refusing unusable backup path: ${file}`);
    }
    return 'present';
  } catch (error) {
    if (error?.code === 'ENOENT') return 'absent';
    throw error;
  }
}

/**
 * Replace `file` atomically after preserving its first pre-managed state.
 * Existing regular `.bak` files are never overwritten; symlinks and other
 * non-regular backup paths fail closed.
 */
export function writeFileWithBackup(file, content, { fsImpl = fs } = {}) {
  const dir = path.dirname(file);
  fsImpl.mkdirSync(dir, { recursive: true });
  const existed = fsImpl.existsSync(file);
  let mode = 0o600;
  if (existed) {
    mode = fsImpl.statSync(file).mode & 0o777;
    const backup = `${file}.bak`;
    if (backupState(backup, fsImpl) === 'absent') {
      fsImpl.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
    }
  }

  const tmp = `${file}.${process.pid}.${sequence++}.tmp`;
  let renamed = false;
  try {
    fsImpl.writeFileSync(tmp, content, { mode });
    fsImpl.renameSync(tmp, file);
    renamed = true;
  } finally {
    if (!renamed) {
      try { fsImpl.rmSync(tmp, { force: true }); } catch { /* cleanup must not mask the write error */ }
    }
  }
}

/**
 * Atomic replacement for a PRIVATE, kit-owned store: no backup, no mode
 * preservation, 0600 throughout. Private kit-owned stores, including the usage
 * index cache, share this implementation.
 *
 * Security review SEC-6 (LOW): those hand copies used
 * `fs.writeFileSync(tmp, …, { mode: 0o600 })`, whose implicit `'w'` flag
 * FOLLOWS SYMLINKS and ignores `mode` on an existing path. The review verified
 * the consequence mechanically: pre-creating the predictable
 * `<store>.<pid>.tmp` path as a symlink to a victim file caused the victim to
 * be overwritten with the store JSON, after which the rename moved the symlink
 * into place and the chmod re-permissioned the victim to 0600. Two changes
 * close it:
 *
 *   - `'wx'` sets O_EXCL, which refuses an existing path outright — a symlink
 *     included, without following it.
 *   - the suffix is random rather than the PID, so the path a would-be
 *     attacker must pre-create is not one they can predict.
 *
 * Exploiting it needed write access to the config dir, which is why the review
 * ranked it LOW — but that becomes real under `umask 000`, a shared
 * XDG_CONFIG_HOME, or a leftover tmp from a crashed run. The `finally` below
 * also removes the tmp on a failed write, so crashes stop leaving those behind.
 *
 * Throws on failure. Callers that can tolerate a failed write (the derivable
 * index cache) catch; callers that cannot (the ledger, whose whole point is
 * durable dismissal state) deliberately do not.
 */
export function writePrivateFileAtomic(file, content, { fsImpl = fs } = {}) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  let fd;
  let renamed = false;
  try {
    fd = fsImpl.openSync(tmp, 'wx', 0o600);
    fsImpl.writeFileSync(fd, content);
    fsImpl.closeSync(fd);
    fd = undefined;
    fsImpl.renameSync(tmp, file);
    renamed = true;
  } finally {
    if (fd !== undefined) {
      try { fsImpl.closeSync(fd); } catch { /* cleanup must not mask the write error */ }
    }
    if (!renamed) {
      try { fsImpl.rmSync(tmp, { force: true }); } catch { /* same */ }
    }
  }
  // Unconditional, not umask-dependent: 0o600 at creation is already 0600 for
  // any normal umask, and this covers the exotic ones too.
  try { fsImpl.chmodSync(file, 0o600); } catch { /* best effort on exotic filesystems */ }
}
