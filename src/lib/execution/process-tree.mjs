// Cross-platform termination for supervised host workers. Windows npm shims
// add a PowerShell wrapper, so killing only the direct child cannot prove that
// the underlying Node CLI stopped. taskkill /T owns that process tree.
import { run } from '../exec.mjs';
import { isWindows } from '../paths.mjs';

/**
 * @param {any} child
 * @param {'SIGTERM'|'SIGKILL'} signal
 * @param {{windows?:boolean,runFn?:typeof run,processKill?:typeof process.kill}} [options]
 */
export async function signalProcessTree(child, signal, {
  windows = isWindows,
  runFn = run,
  processKill = process.kill,
} = {}) {
  if (!windows) {
    // Subprocess workers are spawned detached on POSIX, making the direct
    // child a process-group leader. A negative pid reaches that whole group,
    // including MCP servers or other descendants started by the host CLI.
    if (Number.isInteger(child?.pid) && child.pid > 0) {
      try {
        processKill(-child.pid, signal);
        return true;
      } catch { /* non-detached/custom child — fall through to direct signal */ }
    }
    return !!child?.kill?.(signal);
  }
  if (!Number.isInteger(child?.pid) || child.pid < 1) return false;
  // Windows has no portable TERM for arbitrary console trees. /F is used for
  // both rungs; /T is the required descendant-ownership guarantee.
  const result = await runFn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
    timeout: 10_000,
  });
  return result.code === 0;
}
