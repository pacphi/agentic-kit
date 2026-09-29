import fs from 'node:fs';
import { tempDir } from './temp-dir.mjs';
import { acquireRunRootHold, releaseRunRootHold } from '../../../scripts/run-roots.mjs';

export function childGone(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

export async function until(check, description, timeout = 5000, signal) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const result = check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw Error(`timed out waiting for ${description}`);
}

async function stopPid(pid) {
  if (childGone(pid)) return;
  try { await until(() => childGone(pid), 'private child exit', 2000); return; } catch { /* Escalate exact PID only. */ }
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    if (childGone(pid)) return;
    try { process.kill(pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    try { await until(() => childGone(pid), 'signaled child exit', 2000); return; } catch { /* Retain on uncertainty. */ }
  }
  throw Error(`cannot prove owned child ${pid} exited`);
}

/** One hook owns process shutdown and conditional directory deletion. */
export function interruptionScope(t, { beforeRemove = () => {} } = {}) {
  const hold = acquireRunRootHold();
  const home = tempDir('ak-interrupt', undefined, { manual: true });
  const entries = [];
  let cleaning;
  let stopping = false;
  const active = () => {
    t.signal.throwIfAborted();
    if (stopping) throw Error('fixture cleanup has started');
  };
  const cleanup = () => {
    stopping = true;
    cleaning ??= (async () => {
      const results = await Promise.allSettled(entries.map(async (entry) => {
        if (entry.stop) fs.writeFileSync(entry.stop, 'exit');
        if (entry.handshake && !(entry.launchError && !entry.child.pid)) {
          const data = await until(() => fs.existsSync(entry.handshake)
            && JSON.parse(fs.readFileSync(entry.handshake, 'utf8')), 'owned child identity', 2000);
          if (!Number.isSafeInteger(data.pid) || data.pid <= 0) throw Error('invalid owned child identity');
          await stopPid(data.pid);
        }
        if (!entry.closed) {
          try { await until(() => entry.closed, 'runner close', 2000); } catch {
            entry.child.kill('SIGTERM');
            try { await until(() => entry.closed, 'runner termination', 2000); } catch {
              entry.child.kill('SIGKILL');
              await until(() => entry.closed, 'runner forced close', 2000);
            }
          }
        }
        if (entry.child.pid && !childGone(entry.child.pid)) throw Error('owned runner PID remains');
      }));
      const errors = results.filter(r => r.status === 'rejected').map(r => r.reason);
      if (errors.length) throw new AggregateError(errors, 'owned process exit uncertain; retaining fixture and run root');
      releaseRunRootHold(hold);
    })();
    return cleaning;
  };
  const abort = () => { void cleanup().catch(() => {}); };
  t.after(async () => {
    t.signal.removeEventListener('abort', abort);
    await cleanup();
    beforeRemove(home);
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  });
  t.signal.addEventListener('abort', abort, { once: true });
  return {
    home, cleanup, active,
    wait: (check, description, timeout) => until(check, description, timeout, t.signal),
    launch(start, { handshake, stop } = {}) {
      active();
      const child = start();
      const entry = { child, handshake, stop, closed: false, launchError: null };
      child.on('error', error => { entry.launchError = error; });
      child.once('close', () => { entry.closed = true; });
      entries.push(entry);
      return child;
    },
  };
}
