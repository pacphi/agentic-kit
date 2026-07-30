// Host-neutral execution coordinator. It owns scheduling, deadlines, and
// lifecycle cleanup; adapters own each host's transport and protocol details.
import { validateExecutionAdapter, validateWorkerResult } from './schema.mjs';
import { EXECUTION_ADAPTERS } from './adapters.mjs';

const nowIso = () => new Date().toISOString();

function workerFailure(worker, /** @type {{status?:string, exitCategory?:string, failure?:any, startedAt?:string, clock?:()=>string}} */
  { status = 'failed', exitCategory = 'worker_error', failure = null, startedAt, clock = nowIso } = {}) {
  const endedAt = clock();
  return validateWorkerResult({
    workerId: worker.id, activity: worker.activity, role: worker.role, host: worker.host,
    status, exitCategory, startedAt: startedAt ?? endedAt, endedAt,
    durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt ?? endedAt)),
    provider: null, providerProvenance: 'unknown', configuredModel: worker.configuredModel ?? null,
    observedModel: null, sessionId: null, transcriptRefs: [], failure, usage: null,
  });
}

function boundedFailure(error) {
  return { reason: String(error?.message ?? error ?? 'execution failed').slice(0, 240) };
}

async function observeBeforeDeadline(adapter, state, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return { timedOut: false, observation: await adapter.observe(state) };
  let timer;
  try {
    return await Promise.race([
      adapter.observe(state).then((observation) => ({ timedOut: false, observation })),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

/** Execute one worker and guarantee cleanup after every prepared state. */
export async function executeWorker(worker, adapter, {
  cwd = process.cwd(), timeoutMs = 120_000, clock = nowIso,
} = /** @type {{cwd?:string, timeoutMs?:number, clock?:()=>string}} */ ({})) {
  const startedAt = clock();
  let state = null;
  try {
    const ready = await adapter.readiness({ worker, cwd });
    if (!ready?.ready) return workerFailure(worker, {
      exitCategory: ready?.exitCategory ?? 'cli_unavailable', failure: { reason: 'host is not ready' }, startedAt, clock,
    });
    state = await adapter.prepare({ worker, cwd, timeoutMs });
    state = await adapter.launch(state, { timeoutMs });
    const watched = await observeBeforeDeadline(adapter, state, timeoutMs);
    if (watched.timedOut) {
      const cancelled = await adapter.cancel(state);
      // Schema validation applies to EVERY terminal interpret(), not only the
      // success path — the timeout branch is exactly where a malformed result
      // would otherwise ship unbounded into `ak run --json` (qe-court A2).
      return validateWorkerResult(adapter.interpret(state, { type: cancelled?.orphaned ? 'orphaned' : 'timeout' }));
    }
    return validateWorkerResult(adapter.interpret(state, watched.observation));
  } catch (error) {
    const timedOut = error?.code === 'ETIMEDOUT';
    return workerFailure(worker, {
      status: timedOut ? 'timed_out' : 'failed',
      exitCategory: timedOut ? 'timeout' : 'protocol_error',
      failure: boundedFailure(error), startedAt, clock,
    });
  } finally {
    if (state) {
      try { await adapter.cleanup(state); } catch { /* terminal result is already authoritative */ }
    }
  }
}

function validatePlan(plan) {
  if (!plan || !Array.isArray(plan.workers)) throw new TypeError('execution plan requires workers');
  const ids = new Set();
  for (const worker of plan.workers) {
    if (!worker || typeof worker !== 'object' || typeof worker.id !== 'string' || !worker.id
      || typeof worker.activity !== 'string' || typeof worker.role !== 'string' || typeof worker.host !== 'string') {
      throw new TypeError('execution worker requires id, activity, role, and host');
    }
    if (ids.has(worker.id)) throw new Error(`execution plan has duplicate worker id "${worker.id}"`);
    ids.add(worker.id);
  }
  for (const worker of plan.workers) {
    for (const dependency of worker.dependsOn ?? []) {
      if (!ids.has(dependency)) throw new Error(`worker "${worker.id}" depends on unknown worker "${dependency}"`);
      if (dependency === worker.id) throw new Error(`worker "${worker.id}" cannot depend on itself`);
    }
  }
}

function adapterFor(adapters, host) {
  const adapter = adapters instanceof Map ? adapters.get(host) : adapters?.[host];
  return adapter ? validateExecutionAdapter(adapter) : null;
}

// ── bounded escalation (ADR-0019) ───────────────────────────────────────────
// A non-success worker result may advance ONE rung of the route's ladder
// (host+model), bounded by the ladder's length — never the whole-pipeline
// retry the legacy dual wrapper did. What may NOT advance, ever:
//   - blocked/cancelled results (dependency state, not a worker failure);
//   - permission_required (a consent boundary — escalating around it would be
//     a safety violation, exactly the opencode abort contract);
//   - orphaned (execution state is uncertain; a retry risks a double run).
const ESCALATABLE_STATUSES = new Set(['failed', 'timed_out']);
const BLOCKING_CATEGORIES = new Set(['permission_required', 'cancelled', 'orphaned']);

const escalatable = (result) => ESCALATABLE_STATUSES.has(result.status) && !BLOCKING_CATEGORIES.has(result.exitCategory);

/** Compact one attempt for the result's trail: which rung, what verdict, how
 *  long, and (on failure) why — bounded like every other failure surface. */
function compactAttempt(worker, result) {
  const attempt = {
    host: worker.host, model: worker.configuredModel ?? null,
    status: result.status, exitCategory: result.exitCategory,
    durationMs: result.durationMs,
  };
  const reason = result.failure?.reason;
  if (result.status !== 'succeeded' && typeof reason === 'string') attempt.reason = reason;
  return attempt;
}

/** Execute a worker, advancing one ladder rung per escalatable failure when
 *  `escalate` is on. The final result carries an `attempts` trail ONLY when
 *  more than one attempt ran — a single attempt is indistinguishable from a
 *  run with escalation off, and emitting one would fabricate an event that
 *  did not happen. */
async function executeWorkerWithEscalation(worker, adapters, { cwd, timeoutMs, clock, escalate = false }) {
  const ladder = escalate ? [...(worker.escalate ?? [])] : [];
  const attempts = [];
  let current = worker;
  let result;
  for (;;) {
    const adapter = adapterFor(adapters, current.host);
    result = adapter
      ? await executeWorker(current, adapter, { cwd, timeoutMs, clock })
      : workerFailure(current, { exitCategory: 'cli_unavailable', failure: { reason: `no execution adapter for host "${current.host}"` }, clock });
    attempts.push(compactAttempt(current, result));
    if (!escalatable(result)) break;
    const rung = ladder.shift();
    if (!rung) break;
    current = { ...current, host: rung.host, configuredModel: rung.model ?? null };
  }
  if (attempts.length <= 1) return result;
  return validateWorkerResult({ ...result, attempts });
}

/** Run a materialized routing plan as a bounded-concurrency dependency DAG.
 * A failed dependency blocks descendants; independent branches keep running.
 * `escalate: true` enables bounded per-worker ladder retries (ADR-0019). */
export async function executeRunPlan(plan, {
  adapters = EXECUTION_ADAPTERS, cwd = process.cwd(), maxConcurrent = 4, timeoutMs, clock = nowIso, escalate = false,
} = /** @type {{adapters?:Record<string, any>|Map<string, any>, cwd?:string, maxConcurrent?:number, timeoutMs?:number, clock?:()=>string, escalate?:boolean}} */ ({})) {
  validatePlan(plan);
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) throw new TypeError('maxConcurrent must be a positive integer');
  const pending = new Map(plan.workers.map((worker) => [worker.id, worker]));
  const results = new Map();
  const running = new Map();

  const start = (worker) => {
    const promise = executeWorkerWithEscalation(worker, adapters, { cwd, timeoutMs, clock, escalate });
    running.set(worker.id, promise.then((result) => ({ id: worker.id, result })));
    pending.delete(worker.id);
  };

  while (pending.size || running.size) {
    for (const worker of pending.values()) {
      if (running.size >= maxConcurrent) break;
      const deps = worker.dependsOn ?? [];
      if (!deps.every((id) => results.has(id))) continue;
      const failed = deps.filter((id) => results.get(id).status !== 'succeeded');
      if (failed.length) {
        results.set(worker.id, workerFailure(worker, {
          status: 'blocked', exitCategory: 'worker_error', failure: { reason: 'dependency_failed', dependencies: failed }, clock,
        }));
        pending.delete(worker.id);
      } else start(worker);
    }
    if (!running.size) {
      if (pending.size) throw new Error('execution plan contains a dependency cycle');
      break;
    }
    const { id, result } = await Promise.race(running.values());
    running.delete(id);
    results.set(id, result);
  }
  return plan.workers.map((worker) => results.get(worker.id));
}
