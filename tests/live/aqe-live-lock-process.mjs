import { spawn } from 'node:child_process';
import { acquireRunRootHold, releaseRunRootHold } from '../../scripts/run-roots.mjs';
import { envValue } from '../kit/helpers/home-sandbox.mjs';

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

export function createProcessScope(signal, { closeLimitMs = CLOSE_LIMIT_MS, platform = process.platform,
  maxOutputBytes = 2 * 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 16 * 1024 * 1024) {
    throw Error('invalid process-scope output limit');
  }
  // Register uncertainty with the enclosing guarded runner before any child starts.
  const hold = acquireRunRootHold();
  const runs = new Set();
  let closed = false;
  let closing = false;
  const killLive = () => {
    for (const run of runs) if (!run.closed) run.child.kill('SIGKILL');
  };
  signal.addEventListener('abort', killLive, { once: true });

  function launch(command, args, options, { pipeInput = false } = {}) {
    if (closing || signal.aborted) throw Error('cannot launch after process scope closing or aborted');
    if (!options?.env || typeof options.env !== 'object' || Array.isArray(options.env)) {
      throw Error('call-owned child requires an explicit sandbox env');
    }
    const env = options.env;
    const missing = (key) => {
      const value = envValue(env, key, platform);
      return typeof value !== 'string' || !value;
    };
    const required = ['HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'XDG_CONFIG_HOME',
      'XDG_STATE_HOME', 'APPDATA', 'LOCALAPPDATA'];
    if (required.some(missing)) {
      throw Error('call-owned child requires sandbox home, temp, and state env');
    }
    if (platform === 'win32' && ['SystemRoot', 'ComSpec', 'PATHEXT'].some(missing)) {
      throw Error('call-owned child requires Windows process env');
    }
    const child = spawn(command, args, { ...options, env, stdio: [pipeInput ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    const run = { child, closed: false, error: null, inputError: null, stdout: '', stderr: '',
      outputBytes: 0, outputLimitExceeded: false, done: null, result: null };
    // A child may exit before the parent closes/writes its protocol pipe.
    // Retain that error for the caller instead of an unhandled stream error.
    if (child.stdin) child.stdin.on('error', (error) => { run.inputError = error; });
    runs.add(run);
    const capture = (channel, chunk) => {
      const raw = Buffer.from(chunk);
      const remaining = maxOutputBytes - run.outputBytes;
      const accepted = raw.subarray(0, remaining);
      run[channel] += accepted.toString('utf8');
      run.outputBytes += accepted.length;
      if (raw.length > remaining) {
        run.outputLimitExceeded = true;
        child.kill('SIGKILL');
      }
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => capture('stdout', chunk));
    child.stderr.on('data', (chunk) => capture('stderr', chunk));
    // Resolve on close even after spawn error. The caller can inspect error immediately
    // while polling readiness, and no delayed rejection can go unhandled.
    run.done = new Promise((resolve) => {
      child.once('error', (error) => { run.error = error; });
      child.once('close', (code, childSignal) => {
        run.closed = true;
        run.result = { code, signal: childSignal, stdout: run.stdout, stderr: run.stderr,
          outputLimitExceeded: run.outputLimitExceeded };
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

  async function stop(run, grace = CLOSE_LIMIT_MS, { closeInput = false } = {}) {
    if (!runs.has(run)) throw Error('cannot stop a child outside this process scope');
    if (closeInput && !run.closed && !run.child.stdin) throw Error('cooperative stop requires a piped input');
    let stopMethod = run.closed ? 'already-closed' : closeInput ? 'stdin-eof' : 'sigterm';
    if (!run.closed) {
      if (closeInput) run.child.stdin.end();
      else run.child.kill('SIGTERM');
    }
    let timer;
    try {
      await Promise.race([
        run.done,
        new Promise((resolve) => { timer = setTimeout(resolve, grace); }),
      ]);
    } finally {
      clearTimeout(timer);
      if (!run.closed) {
        stopMethod = 'sigkill';
        run.child.kill('SIGKILL');
      }
    }
    return { ...await closedWithin(run, CLOSE_LIMIT_MS), stopMethod };
  }

  async function closeAll() {
    if (closed) return;
    closing = true;
    killLive();
    // A failed close keeps the caller's temporary root intact for diagnosis.
    await Promise.all([...runs].map((run) => closedWithin(run, closeLimitMs)));
    releaseRunRootHold(hold);
    closed = true;
    signal.removeEventListener('abort', killLive);
  }

  return { launch, wait, stop, closeAll };
}
