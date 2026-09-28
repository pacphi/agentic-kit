// Fixture for tests/kit/status-zero-spawn.test.mjs. Runs inside a child Node
// process launched with `--import` of tests/helpers/spawn-guard.mjs and a
// sandboxed HOME/XDG/PATH environment, so every child_process spawn
// collect() triggers (however deep, whichever module makes it) lands in the
// ledger the parent test reads back. `process.exit(0)` forces a deterministic
// exit regardless of any lingering handle a probe may leave open — the
// parent test only cares about the ledger file's contents, not this
// process's own exit code.
//
// Three calls, in the SAME process (so the evidence the first call writes is
// on disk for the second read — the evidence store is keyed by state
// directory, not by process): a cold-cache call (Ruling A: probes once per
// gated kind), a warm-cache call (the enforced zero-spawn assertion), and a
// `refresh: true` call (Ruling A/B: always probes, even with a warm cache).
// A `__CALL_BOUNDARY_*__` marker line is appended to the ledger after each
// call so the parent test can slice the ledger per call without needing its
// own separate child processes (which would each start with a cold cache).
import fs from 'node:fs';
import { collect } from '../../src/commands/status.mjs';

const [, , pkgRoot, cwd] = process.argv;

function mark(label) {
  const ledgerFile = process.env.AK_SPAWN_LEDGER_FILE;
  if (!ledgerFile) return;
  try {
    fs.appendFileSync(ledgerFile, `${JSON.stringify({ cmd: `__CALL_BOUNDARY_${label}__`, at: new Date().toISOString() })}\n`);
  } catch {
    // Best-effort marker; a lost boundary just makes the parent test's slice
    // assertion fail loudly rather than silently mis-attribute a spawn.
  }
}

await collect({
  pkgRoot, cwd, refresh: false, record: true,
});
mark('first');
await collect({
  pkgRoot, cwd, refresh: false, record: true,
});
mark('second');
await collect({
  pkgRoot, cwd, refresh: true, record: true,
});
mark('third');
process.exit(0);
