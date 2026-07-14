// x daemon-gc — list (default) or reap (--kill) stale ruflo daemons.
// Stale = workspace gone OR older than RUFLO_DAEMON_TTL_SECS (default 12h).
import { listDaemons, staleDaemons, reap } from '../../lib/daemons.mjs';
import { ok, warn, dim } from '../../lib/output.mjs';

export const options = {
  kill: { type: 'boolean', default: false },
  quiet: { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
};

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
