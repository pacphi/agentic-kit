// Fixture for tests/kit/dashboard-status-inprocess.test.mjs and
// tests/kit/dashboard-status-cost.test.mjs. Runs inside a child Node process
// launched with `--import` of tests/helpers/spawn-guard.mjs and a sandboxed
// HOME/XDG/PATH environment (mirroring tests/fixtures/status-zero-spawn-child.mjs),
// so every child_process spawn the dashboard server's real, un-injected
// /api/status path triggers lands in the ledger the parent test reads back.
//
// Unlike status-zero-spawn-child.mjs (which drives collect() directly and
// controls call timing itself), the requests here come from the PARENT over
// real HTTP — this script only starts the server and reports where it is
// listening; the parent marks ledger call boundaries itself by appending
// directly to the same ndjson file between requests.
import { startDashboard } from '../../src/lib/dashboard-server.mjs';

const [, , cwd] = process.argv;

const { port, token } = await startDashboard({ port: 0, cwd });
// Unbuffered, single line, parsed by the parent — printed only once the
// server is actually accepting connections.
process.stdout.write(`READY ${port} ${token}\n`);
