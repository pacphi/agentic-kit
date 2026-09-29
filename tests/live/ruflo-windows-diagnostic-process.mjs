// Test-only exact-environment launcher. Every attempt contributes independently
// to the scope's cleanup receipt; uncertainty is sticky until handoff.
import { spawn } from 'node:child_process';
import { acquireRunRootHold, releaseRunRootHold } from '../../scripts/run-roots.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createDiagnosticScope({ spawnFn = spawn, platform = process.platform,
  killTimeoutMs = 3000, closeTimeoutMs = 5000,
  acquireHold = acquireRunRootHold, releaseHold = releaseRunRootHold } = {}) {
  const hold = acquireHold();
  const receipts = [];
  let released = false;

  async function launch(spec, { cwd, env, timeoutMs, input = '', endInput = true,
    until = () => false, tree = true }) {
    if (released) throw Error('diagnostic scope already released');
    if (!env || typeof env !== 'object') throw Error('explicit diagnostic environment required');
    const result = { code: null, signal: null, stdout: '', stderr: '', error: null,
      timedOut: false, overflow: false, matched: false, cleanupComplete: false, elapsedMs: 0 };
    receipts.push(result);
    let child;
    let closed = false;
    let bytes = 0;
    const started = Date.now();
    const live = () => child?.pid && child.exitCode === null && child.signalCode === null;
    const capture = (key, chunk) => {
      bytes += chunk.length;
      result.overflow ||= bytes > 65536;
      result[key] = (result[key] + chunk.toString('utf8')).slice(0, 16384);
    };
    const waitClose = async () => {
      const deadline = Date.now() + closeTimeoutMs;
      while (!closed && Date.now() < deadline) await delay(10);
    };
    try {
      child = spawnFn(spec.command, spec.args, {
        cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
        detached: tree && platform !== 'win32',
      });
      child.on('error', (e) => { result.error = e.message; });
      child.once('close', (code, signal) => {
        closed = true; result.code = code; result.signal = signal;
      });
      child.stdout.on('data', (chunk) => capture('stdout', chunk));
      child.stderr.on('data', (chunk) => capture('stderr', chunk));
      child.stdin.on('error', (e) => { result.error = e.message; });
      child.stdin.write(input);
      if (endInput) child.stdin.end();
      while (!closed && !result.error && !result.overflow && Date.now() - started < timeoutMs) {
        result.matched = until(result.stdout);
        if (result.matched) break;
        await delay(10);
      }
      result.matched ||= until(result.stdout);
      result.timedOut = !closed && !result.matched && !result.error && !result.overflow;
    } catch (error) {
      result.error = error.message;
    } finally {
      // Never throw before cleanup. Failed tree termination is uncertainty even
      // if the direct-child fallback subsequently closes its own pipes.
      let treeStopped = closed || !child;
      if (child && !closed) {
        if (live()) {
          if (tree && platform === 'win32') {
            const killed = await launch({ command: 'taskkill.exe', args: ['/PID', String(child.pid), '/T', '/F'] },
              { cwd, env, timeoutMs: killTimeoutMs, tree: false });
            treeStopped = killed.cleanupComplete && killed.code === 0 && !killed.timedOut && !killed.error;
          } else {
            try {
              if (tree) process.kill(-child.pid, 'SIGKILL');
              else child.kill('SIGKILL');
              treeStopped = true;
            } catch { treeStopped = false; }
          }
          if (!treeStopped && live()) {
            try { child.kill('SIGKILL'); } catch { /* preserve uncertainty */ }
          }
        }
        await waitClose();
      }
      result.cleanupComplete = treeStopped && (closed || !child);
      if (child && !closed) {
        // Close local handles and release event-loop references without claiming
        // the process tree exited. The scope hold remains active.
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        child.unref();
      }
      result.elapsedMs = Date.now() - started;
    }
    return result;
  }

  function release() {
    if (receipts.some((receipt) => !receipt.cleanupComplete)) return false;
    if (!released) releaseHold(hold);
    released = true;
    return true;
  }
  return { launch, release, receipts };
}
