import { spawn } from 'node:child_process';

const CLOSE_LIMIT_MS = 10_000;

function closedWithin(run, ms) {
  if (run.closed) return Promise.resolve(run.result);
  let timer;
  return Promise.race([
    run.done,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`call-owned child ${run.child.pid ?? 'unspawned'} did not close`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function createProcessScope(signal) {
  const runs = new Set();
  const killLive = () => {
    for (const run of runs) if (!run.closed) run.child.kill('SIGKILL');
  };
  signal.addEventListener('abort', killLive, { once: true });

  function launch(command, args, options) {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    const run = { child, closed: false, error: null, stdout: '', stderr: '', done: null, result: null };
    runs.add(run);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (s) => { run.stdout += s; });
    child.stderr.on('data', (s) => { run.stderr += s; });
    // Resolve on close even after spawn error. The caller can inspect error immediately
    // while polling readiness, and no delayed rejection can go unhandled.
    run.done = new Promise((resolve) => {
      child.once('error', (error) => { run.error = error; });
      child.once('close', (code, childSignal) => {
        run.closed = true;
        run.result = { code, signal: childSignal, stdout: run.stdout, stderr: run.stderr };
        resolve(run.result);
      });
    });
    if (signal.aborted) child.kill('SIGKILL');
    return run;
  }

  async function wait(run, limit) {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (!run.closed) run.child.kill('SIGKILL');
    }, limit);
    try {
      const result = await closedWithin(run, limit + CLOSE_LIMIT_MS);
      if (run.error) throw run.error;
      return { ...result, timedOut };
    } finally { clearTimeout(timer); }
  }

  async function stop(run, grace = CLOSE_LIMIT_MS) {
    if (!run.closed) run.child.kill('SIGTERM');
    let timer;
    try {
      await Promise.race([
        run.done,
        new Promise((resolve) => { timer = setTimeout(resolve, grace); }),
      ]);
    } finally {
      clearTimeout(timer);
      if (!run.closed) run.child.kill('SIGKILL');
    }
    return closedWithin(run, CLOSE_LIMIT_MS);
  }

  async function closeAll() {
    killLive();
    // A failed close keeps the caller's temporary root intact for diagnosis.
    await Promise.all([...runs].map((run) => closedWithin(run, CLOSE_LIMIT_MS)));
    signal.removeEventListener('abort', killLive);
  }

  return { launch, wait, stop, closeAll };
}
