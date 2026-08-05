// Fail-closed, backup-first atomic replacement for user-owned text files.
// A promised recovery copy is part of the write contract: if it cannot be
// created or is not a regular file, the target is left byte-identical.
import fs from 'node:fs';
import path from 'node:path';

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
