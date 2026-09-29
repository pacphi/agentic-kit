// tests/kit/helpers/temp-dir.mjs
// A temp folder that removes itself. 59 test files left 700+ folders behind per
// run (Branch 2 probe); this is the one way to make one.
import { after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Create `<os.tmpdir()>/<prefix>-XXXXXX` and remove it when the test (or, without
 * `t`, the file) finishes, unless manual cleanup is requested. A caller that
 * chdir-ed into it must chdir out first.
 * @param {string} prefix
 * @param {import('node:test').TestContext} [t]
 * @param {{manual?:boolean}} [options] Caller owns removal when manual is true.
 * @returns {string} the real path of the new folder
 */
export function tempDir(prefix, t, { manual = false } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`)));
  const remove = () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  if (!manual) {
    if (t) t.after(remove); else after(remove);
  }
  return dir;
}
