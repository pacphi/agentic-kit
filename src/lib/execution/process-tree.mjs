// Cross-platform termination for supervised host workers. Windows npm shims
// add a PowerShell wrapper, so killing only the direct child cannot prove that
// the underlying Node CLI stopped. taskkill /T owns that process tree.
import { run } from '../exec.mjs';
import { isWindows } from '../paths.mjs';

/**
 * @param {any} child
 * @param {'SIGTERM'|'SIGKILL'} signal
 * @param {{windows?:boolean,runFn?:typeof run}} [options]
 */
export async function signalProcessTree(child, signal, {
  windows = isWindows,
  runFn = run,
} = {}) {
  if (!windows) return !!child?.kill?.(signal);
  if (!Number.isInteger(child?.pid) || child.pid < 1) return false;
  // Windows has no portable TERM for arbitrary console trees. /F is used for
  // both rungs; /T is the required descendant-ownership guarantee.
  const result = await runFn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
    timeout: 10_000,
  });
  return result.code === 0;
}
