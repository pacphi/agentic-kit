// x daemon-gc — list (default) or reap (--kill) stale ruflo daemons.
// Stale = workspace gone OR older than RUFLO_DAEMON_TTL_SECS (default 12h).
import { listDaemons, staleDaemons, reap } from '../../lib/daemons.mjs';
import { ok, warn, dim } from '../../lib/output.mjs';

export const options = {
  kill: { type: 'boolean', default: false },
  quiet: { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
};

export const help = `ak x daemon-gc — list or reap stale ruflo daemons

Stale = the daemon's workspace is gone, OR it's older than RUFLO_DAEMON_TTL_SECS
(default 12h). Lists by default; --kill actually stops them.

Usage: ak x daemon-gc [options]

Options:
  --kill    stop the stale daemons (default is list-only)
  --quiet   print nothing when there's nothing stale
  --json    emit the daemon list + stale PIDs as JSON

Examples:
  ak x daemon-gc          show stale daemons
  ak x daemon-gc --kill    reap them`;

export async function run({ flags }) {
  const daemons = await listDaemons();
  const stale = staleDaemons(daemons);
  if (flags.json) {
    console.log(JSON.stringify({ daemons, stale: stale.map((d) => d.pid) }, null, 2));
    return 0;
  }
  if (stale.length === 0) {
    if (!flags.quiet) ok(`no stale daemons (${daemons.length} running, all healthy)`);
    return 0;
  }
  if (flags.kill) {
    for (const r of reap(stale)) {
      if (r.killed) ok(`stopped stale daemon pid=${r.pid} ${dim(r.workspace ?? '')}`);
      else warn(`could not stop pid=${r.pid} (already exited?)`);
    }
  } else {
    for (const d of stale) {
      warn(`stale daemon pid=${d.pid} ${dim(d.workspace ?? '(unknown workspace)')} ${dim(d.workspaceExists ? `age ${d.ageSecs}s > TTL` : 'workspace gone')}`);
    }
    console.log(`run: ak x daemon-gc --kill`);
  }
  return 0;
}
