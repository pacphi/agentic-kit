// Supervised subprocess adapters for the hosts whose native CLIs already offer
// non-interactive structured output. The runner owns timeout policy; this module
// owns only one direct child process and never invokes a shell or bypass mode.
import { spawn as nodeSpawn } from 'node:child_process';
import { have, resolveShim } from '../exec.mjs';
import { validateExecutionAdapter, validateWorkerResult } from './schema.mjs';
import { signalProcessTree } from './process-tree.mjs';

const nowIso = () => new Date().toISOString();
const OUTPUT_LIMIT = 256 * 1024;

function capture(stream) {
  let text = '';
  stream?.on?.('data', (chunk) => { text = `${text}${String(chunk)}`.slice(-OUTPUT_LIMIT); });
  return () => text;
}

function waitForChild(child, stdout, stderr) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve({ ...result, stdout: stdout(), stderr: stderr() });
    };
    child.once?.('error', (error) => finish({ code: null, signal: null, error }));
    child.once?.('close', (code, signal) => finish({ code, signal, error: null }));
  });
}

function categoryFor(completion) {
  const detail = `${completion.stderr}\n${completion.stdout}\n${completion.error?.message ?? ''}`;
  if (/auth(?:entication)?|login|required api key|unauthorized/i.test(detail)) return 'auth_required';
  if (/model .*(not found|unavailable)|unknown model|model_not_found/i.test(detail)) return 'model_unavailable';
  return 'worker_error';
}

function failureFor(completion) {
  const detail = (completion.stderr || completion.stdout || completion.error?.message || 'host process failed').trim();
  return { reason: detail.slice(0, 240) };
}

function resultFor(state, observation, host, clock) {
  const endedAt = clock();
  const durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(state.startedAt));
  const terminal = observation?.type;
  let status = 'succeeded';
  let exitCategory = 'success';
  let failure = null;
  if (terminal === 'timeout') {
    status = 'timed_out'; exitCategory = 'timeout'; failure = { reason: observation?.reason ?? 'timeout' };
  } else if (terminal === 'cancelled') {
    status = 'cancelled'; exitCategory = 'cancelled'; failure = { reason: 'cancelled' };
  } else if (terminal === 'orphaned') {
    status = 'failed'; exitCategory = 'orphaned'; failure = { reason: 'host process did not terminate' };
  } else if (!observation || observation.code !== 0 || observation.error) {
    status = 'failed'; exitCategory = categoryFor(observation ?? {}); failure = failureFor(observation ?? {});
  }
  return validateWorkerResult({
    workerId: state.worker.id, activity: state.worker.activity, role: state.worker.role, host,
    status, exitCategory, startedAt: state.startedAt, endedAt, durationMs,
    // ADR-0018's invariant: a host or its provider/model selector NEVER proves
    // the inference provider. The subprocess adapters observe exit codes, not
    // billing identity (a claude session may be Anthropic, OpenRouter, or
    // Ollama-served) — record unknown, not `provider: host` (qe-court B6).
    provider: null, providerProvenance: 'unknown', configuredModel: state.worker.configuredModel ?? null,
    observedModel: null, sessionId: null, transcriptRefs: [], failure, usage: null,
  });
}

async function waitForFinished(state, timeoutMs) {
  if (state.finished) return true;
  let timer;
  try {
    return await Promise.race([
      state.completion.then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

/** Stop the direct child and prove it actually exited. A successful `kill()`
 * call means only that the signal was sent, not that the process terminated
 * (qe-court B5). TERM therefore gets one bounded grace period, followed by one
 * bounded KILL fallback; a survivor is explicit orphan evidence. */
async function terminate(state, { terminationGraceMs, forceGraceMs, signalFn }) {
  if (state.finished) return { type: 'cancelled' };
  try {
    if (!await signalFn(state.child, 'SIGTERM')) return { type: 'cancelled', orphaned: true };
    if (await waitForFinished(state, terminationGraceMs)) return { type: 'cancelled' };
    if (!await signalFn(state.child, 'SIGKILL')) return { type: 'cancelled', orphaned: true };
    return await waitForFinished(state, forceGraceMs)
      ? { type: 'cancelled' }
      : { type: 'cancelled', orphaned: true };
  } catch { return { type: 'cancelled', orphaned: true }; }
}

/** Build a lifecycle adapter for one host's structured non-interactive CLI.
 * `argumentsFor` must return a fixed argv vector; prompts never pass through a
 * shell. Permission modes are deliberately absent from this generic layer.
 * @param {{id:string, host:string, command:string, argumentsFor:(worker:any, cwd:string)=>string[],
 *   summaryFor:(observation:any)=>any,
 *   spawnFn?:typeof nodeSpawn, haveFn?:typeof have, resolveFn?:typeof resolveShim,
 *   signalFn?:typeof signalProcessTree,
 *   clock?:()=>string, terminationGraceMs?:number, forceGraceMs?:number}} options */
export function createSubprocessExecutionAdapter({
  id, host, command, argumentsFor, summaryFor, spawnFn = nodeSpawn, haveFn = have,
  resolveFn = resolveShim, signalFn = signalProcessTree,
  clock = nowIso, terminationGraceMs = 1_500, forceGraceMs = 1_500,
} = /** @type {any} */ ({})) {
  if (!id || !host || !command || typeof argumentsFor !== 'function' || typeof summaryFor !== 'function') {
    throw new TypeError('subprocess adapter requires id, host, command, argumentsFor, and summaryFor');
  }
  if (!Number.isInteger(terminationGraceMs) || terminationGraceMs < 1) throw new TypeError('terminationGraceMs must be a positive integer');
  if (!Number.isInteger(forceGraceMs) || forceGraceMs < 1) throw new TypeError('forceGraceMs must be a positive integer');
  const adapter = {
    id,
    async readiness({ signal, timeoutMs } = /** @type {{signal?:AbortSignal,timeoutMs?:number}} */ ({})) {
      signal?.throwIfAborted?.();
      const installed = await haveFn(command, { signal, timeout: timeoutMs });
      signal?.throwIfAborted?.();
      return installed ? { ready: true } : { ready: false, exitCategory: 'cli_unavailable' };
    },
    async prepare({ worker, cwd = process.cwd() } = /** @type {{worker?:any, cwd?:string}} */ ({})) {
      if (worker?.host !== host) throw new TypeError(`${host} adapter requires a ${host} worker`);
      if (typeof worker?.prompt !== 'string' || !worker.prompt.trim()) throw new TypeError(`${host} worker.prompt is required`);
      return { worker, cwd, args: argumentsFor(worker, cwd), startedAt: clock() };
    },
    async launch(state, { signal } = /** @type {{signal?:AbortSignal}} */ ({})) {
      signal?.throwIfAborted?.();
      // Native Windows executables run directly. Package-manager .cmd shims
      // are represented by a shell-free PowerShell -File invocation instead.
      const invocation = resolveFn(command, state.args);
      if (typeof invocation?.command !== 'string' || !Array.isArray(invocation.args)) {
        throw new TypeError(`${host} command resolver returned an invalid invocation`);
      }
      if (invocation.resolved === false) {
        throw new Error(`${host} command has no safe Windows invocation`);
      }
      const child = spawnFn(invocation.command, invocation.args, { cwd: state.cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
      if (!child?.once) throw new Error(`${host} process did not expose child lifecycle events`);
      // Register the acquired child on runner-owned state before any future
      // await so a launch deadline can still cancel and clean it up.
      state.child = child;
      const stdout = capture(child.stdout);
      const stderr = capture(child.stderr);
      const completion = waitForChild(child, stdout, stderr);
      state.completion = completion;
      state.finished = false;
      completion.then(() => { state.finished = true; });
      return state;
    },
    async observe(state, { signal } = /** @type {{signal?:AbortSignal}} */ ({})) {
      signal?.throwIfAborted?.();
      return state.completion;
    },
    interpret(state, observation) { return resultFor(state, observation, host, clock); },
    summarize(_state, observation) { return summaryFor(observation); },
    async cancel(state) { return terminate(state, { terminationGraceMs, forceGraceMs, signalFn }); },
    async cleanup(state) { return terminate(state, { terminationGraceMs, forceGraceMs, signalFn }); },
  };
  return validateExecutionAdapter(adapter);
}
