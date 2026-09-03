import fs from 'node:fs';
import path from 'node:path';

export function acquireMaintenanceLock(transactionsRoot, { fsImpl = fs } = {}) {
  if (typeof transactionsRoot !== 'string' || !path.isAbsolute(transactionsRoot)) {
    throw new TypeError('maintenance transaction root must be an absolute directory');
  }
  const root = path.normalize(transactionsRoot);
  if (path.dirname(root) === root) throw new TypeError('maintenance transaction root must be dedicated');
  fsImpl.mkdirSync(root, { recursive: true, mode: 0o700 });
  const lock = path.join(root, '.mutation-lock');
  try { fsImpl.mkdirSync(lock, { mode: 0o700 }); } catch (error) {
    if (error?.code === 'EEXIST') return null;
    throw error;
  }
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      fsImpl.rmdirSync(lock);
    },
  };
}
