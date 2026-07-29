// Supervised subprocess adapters for the hosts whose native CLIs already offer
// non-interactive structured output. The runner owns timeout policy; this module
// owns only one direct child process and never invokes a shell or bypass mode.
import { spawn as nodeSpawn } from 'node:child_process';
import { have } from '../exec.mjs';
import { validateExecutionAdapter, validateWorkerResult } from './schema.mjs';

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
    status = 'timed_out'; exitCategory = 'timeout'; failure = { reason: 'timeout' };
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
    provider: host, providerProvenance: 'configured', configuredModel: state.worker.configuredModel ?? null,
    observedModel: null, sessionId: null, transcriptRefs: [], failure, usage: null,
  });
}

async function terminate(state) {
  if (state.finished) return { type: 'cancelled' };
  try {
    if (!state.child?.kill?.('SIGTERM')) return { type: 'orphaned' };
    return { type: 'cancelled' };
  } catch { return { type: 'orphaned' }; }
}

/** Build a lifecycle adapter for one host's structured non-interactive CLI.
 * `argumentsFor` must return a fixed argv vector; prompts never pass through a
 * shell. Permission modes are deliberately absent from this generic layer.
 * @param {{id:string, host:string, command:string, argumentsFor:(worker:any, cwd:string)=>string[],
 *   spawnFn?:typeof nodeSpawn, haveFn?:typeof have, clock?:()=>string}} options */
export function createSubprocessExecutionAdapter({
  id, host, command, argumentsFor, spawnFn = nodeSpawn, haveFn = have, clock = nowIso,
} = /** @type {any} */ ({})) {
  if (!id || !host || !command || typeof argumentsFor !== 'function') throw new TypeError('subprocess adapter requires id, host, command, and argumentsFor');
  const adapter = {
    id,
    async readiness() {
      const installed = await haveFn(command);
      return installed ? { ready: true } : { ready: false, exitCategory: 'cli_unavailable' };
    },
    async prepare({ worker, cwd = process.cwd() } = /** @type {{worker?:any, cwd?:string}} */ ({})) {
      if (worker?.host !== host) throw new TypeError(`${host} adapter requires a ${host} worker`);
      if (typeof worker?.prompt !== 'string' || !worker.prompt.trim()) throw new TypeError(`${host} worker.prompt is required`);
      return { worker, cwd, args: argumentsFor(worker, cwd), startedAt: clock() };
    },
    async launch(state) {
      const child = spawnFn(command, state.args, { cwd: state.cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
      if (!child?.once) throw new Error(`${host} process did not expose child lifecycle events`);
      const stdout = capture(child.stdout);
      const stderr = capture(child.stderr);
      const completion = waitForChild(child, stdout, stderr);
      const next = { ...state, child, completion, finished: false };
      completion.then(() => { next.finished = true; });
      return next;
    },
    async observe(state) { return state.completion; },
    interpret(state, observation) { return resultFor(state, observation, host, clock); },
    async cancel(state) { return terminate(state); },
    async cleanup(state) { return terminate(state); },
  };
  return validateExecutionAdapter(adapter);
}
