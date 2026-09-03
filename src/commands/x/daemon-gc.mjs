// x daemon-gc — list or reap stale daemons plus provable stdio MCP orphans.
// Stale = workspace gone OR older than RUFLO_DAEMON_TTL_SECS (default 12h).
import {
  listDaemons, staleDaemons, reap, listMcpTransports, orphanedMcpTransports,
  reapMcpTransports,
} from '../../lib/daemons.mjs';
import { ok, warn, dim } from '../../lib/output.mjs';

export const options = {
  kill: { type: 'boolean', default: false },
  mcp: { type: 'boolean', default: false },
  quiet: { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
};

export const help = `ak x daemon-gc — list or reap stale ruflo daemons and MCP orphans

Stale = the daemon's workspace is gone, OR it's older than RUFLO_DAEMON_TTL_SECS
(default 12h). Ruflo MCP transports are listed separately; only same-user,
PPID-1 transports are cleanup candidates, and require --mcp --kill.

Usage: ak x daemon-gc [options]

Options:
  --kill    stop the stale daemons (default is list-only)
  --mcp     include provably orphaned Ruflo MCP stdio transports in the action
  --quiet   print nothing when there's nothing stale
  --json    emit the daemon list + stale PIDs as JSON

Examples:
  ak x daemon-gc          show stale daemons
  ak x daemon-gc --kill   reap stale background daemons
  ak x daemon-gc --mcp --kill  also reap same-user PPID-1 MCP orphans`;

export async function run({ flags }) {
  const daemons = await listDaemons();
  const stale = staleDaemons(daemons);
  const mcpTransports = await listMcpTransports();
  const mcpOrphans = orphanedMcpTransports(mcpTransports);
  if (flags.json) {
    console.log(JSON.stringify({
      daemons,
      stale: stale.map((d) => d.pid),
      mcpTransports,
      mcpOrphans: mcpOrphans.map((entry) => entry.pid),
    }, null, 2));
    return 0;
  }
  if (stale.length && flags.kill) {
    for (const r of reap(stale)) {
      if (r.killed) ok(`stopped stale daemon pid=${r.pid} ${dim(r.workspace ?? '')}`);
      else warn(`could not stop pid=${r.pid} (already exited?)`);
    }
  } else if (stale.length) {
    for (const d of stale) {
      warn(`stale daemon pid=${d.pid} ${dim(d.workspace ?? '(unknown workspace)')} ${dim(d.workspaceExists ? `age ${d.ageSecs}s > TTL` : 'workspace gone')}`);
    }
    console.log(`run: ak x daemon-gc --kill`);
  }

  if (flags.mcp && flags.kill) {
    for (const result of reapMcpTransports(mcpOrphans)) {
      if (result.killed) ok(`stopped orphaned Ruflo MCP pid=${result.pid}`);
      else warn(`could not stop MCP pid=${result.pid} (identity or orphan proof changed)`);
    }
  } else if (flags.mcp) {
    for (const entry of mcpOrphans) warn(`orphaned Ruflo MCP pid=${entry.pid} ${dim('PPID 1, same user')}`);
    if (mcpOrphans.length) console.log('run: ak x daemon-gc --mcp --kill');
  } else if (mcpOrphans.length) {
    warn(`${mcpOrphans.length} orphaned Ruflo MCP transport(s) found; inspect with: ak x daemon-gc --mcp`);
  }

  if (!stale.length && !mcpOrphans.length && !flags.quiet) {
    ok(`no stale daemons or MCP orphans (${daemons.length} daemon(s), ${mcpTransports.length} MCP transport(s))`);
  }
  return 0;
}
