// Test-only spawn ledger, meant to be loaded via `node --import`. Side-effect
// free unless AK_SPAWN_LEDGER_FILE is set, so it is always safe to preload.
//
// A spawn ledger must cover every spawn path: a proposed seam
// inside src/lib/exec.mjs's run(), but a repo-wide `grep -rln "child_process"
// src/` found ~30 files that spawn directly, not through exec.mjs. A ledger
// there would under-count and let a zero-spawn test pass vacuously on any
// check that spawns a different way. This module instead patches Node's own
// node:child_process before the target script's own imports run, so it
// catches every spawn path regardless of which module makes it.
//
// A named import of a built-in module is a read-only binding
// (`import cp from 'node:child_process'; cp.spawn = x` throws "Cannot assign
// to property ... of [object Module]"). createRequire's CJS view resolves to
// the same underlying module.exports object every ESM named import reads
// through a live getter, so mutating it here through require() is visible to
// every later `import { spawn } from 'node:child_process'` in the process,
// however that import was written — PROVIDED the ESM facade's own snapshot of
// each export is taken after the patch. `syncBuiltinESMExports()` forces that
// resync explicitly rather than relying on load-order timing between this
// preload and the facade's own (undocumented) construction point.
import fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';

const ledgerFile = process.env.AK_SPAWN_LEDGER_FILE;

if (ledgerFile) {
  const require = createRequire(import.meta.url);
  const cp = require('node:child_process');

  const append = (cmd, args) => {
    try {
      fs.appendFileSync(ledgerFile, `${JSON.stringify({
        cmd,
        args: Array.isArray(args) ? args : undefined,
        at: new Date().toISOString(),
      })}\n`);
    } catch {
      // Never let a ledger-append failure (e.g. an unwritable path) crash the
      // wrapped call — the original spawn still has to happen.
    }
  };

  // Wrap spawn, execFile, execFileSync, spawnSync, execSync and fork.
  // `exec` already routes through `execFile` internally, so it needs
  // no separate wrapper, but `execSync` and `fork` call module-internal
  // implementations that bypass the four-function wrap even after
  // syncBuiltinESMExports() — confirmed nothing under src/ calls either
  // today, but wrapping them too is zero-cost and matches Ruling C's "every
  // spawn path, regardless of which module makes it."
  for (const name of ['spawn', 'execFile', 'execFileSync', 'spawnSync', 'execSync', 'fork']) {
    const original = cp[name];
    cp[name] = function patched() {
      append(arguments[0], arguments[1]);
      return original.apply(this, arguments);
    };
  }
  syncBuiltinESMExports();
}
