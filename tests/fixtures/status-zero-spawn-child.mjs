// Fixture for tests/kit/status-zero-spawn.test.mjs. Runs inside a child Node
// process launched with `--import` of tests/helpers/spawn-guard.mjs and a
// sandboxed HOME/XDG/PATH environment, so every child_process spawn
// collect() triggers (however deep, whichever module makes it) lands in the
// ledger the parent test reads back. `process.exit(0)` forces a deterministic
// exit regardless of any lingering handle a probe may leave open — the
// parent test only cares about the ledger file's contents, not this
// process's own exit code.
import { collect } from '../../src/commands/status.mjs';

const [, , pkgRoot, cwd] = process.argv;
await collect({ pkgRoot, cwd, refresh: false });
process.exit(0);
