// Host-neutral execution coordinator. It owns scheduling, deadlines, and
// lifecycle cleanup; adapters own each host's transport and protocol details.
import { validateExecutionAdapter, validateWorkerResult } from './schema.mjs';
import { executionAdapterFor } from './adapters.mjs';
import {
  HANDOFF_REQUEST,
  normalizeHandoff,
  renderDependencyHandoffs,
} from './handoff.mjs';

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

function timeoutError(phase) {
  return Object.assign(new Error(`${phase} exceeded the worker deadline`), {
    code: 'ETIMEDOUT',
    phase,
  });
}

function handoffProtocolError(message) {
  return Object.assign(new TypeError(message), { code: 'HANDOFF_PROTOCOL' });
}

async function beforeDeadline(phase, deadline, controller, operation) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    controller.abort();
    throw timeoutError(phase);
  }
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(Math.max(1, Math.ceil(remaining)))),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(timeoutError(phase));
        }, remaining);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

async function executeWorkerAttempt(worker, adapter, {
  cwd = process.cwd(), timeoutMs = 120_000, clock = nowIso,
  requireHandoff = false,
} = /** @type {{cwd?:string, timeoutMs?:number, clock?:()=>string,requireHandoff?:boolean}} */ ({})) {
  const startedAt = clock();
  const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120_000;
  const deadline = Date.now() + budget;
  const controller = new AbortController();
  let state = null;
  let result;
  let summary = null;
  try {
    const ready = await beforeDeadline('readiness', deadline, controller, (remaining) => (
      adapter.readiness({ worker, cwd, signal: controller.signal, timeoutMs: remaining })
    ));
    if (!ready?.ready) {
      result = workerFailure(worker, {
        exitCategory: ready?.exitCategory ?? 'cli_unavailable',
        failure: { reason: 'host is not ready' },
        startedAt,
        clock,
      });
    } else {
      state = await beforeDeadline('prepare', deadline, controller, (remaining) => (
        adapter.prepare({
          worker, cwd, signal: controller.signal, timeoutMs: remaining,
        })
      ));
      const launched = await beforeDeadline('launch', deadline, controller, (remaining) => (
        adapter.launch(state, { signal: controller.signal, timeoutMs: remaining })
      ));
      if (launched !== undefined && launched !== null) state = launched;
      const observation = await beforeDeadline('observe', deadline, controller, (remaining) => (
        adapter.observe(state, { signal: controller.signal, timeoutMs: remaining })
      ));
      result = validateWorkerResult(adapter.interpret(state, observation));
      if (requireHandoff && result.status === 'succeeded') {
        const handoff = adapter.summarize(state, observation);
        if (handoff && typeof handoff.then === 'function') {
          throw handoffProtocolError('executionAdapter.summarize must return synchronously');
        }
        if (!handoff) throw handoffProtocolError('required worker handoff was missing');
        try { summary = normalizeHandoff(handoff); } catch (error) {
          throw handoffProtocolError(error?.message ?? 'required worker handoff was malformed');
        }
      }
    }
  } catch (error) {
    const timedOut = error?.code === 'ETIMEDOUT' || controller.signal.aborted;
    if (timedOut && state) {
      const timeoutReason = boundedFailure(error).reason;
      let terminal = /** @type {{type:string,reason?:string}} */ ({
        type: 'timeout',
        reason: timeoutReason,
      });
      try {
        const cancelled = await adapter.cancel(state);
        if (cancelled?.orphaned) terminal = { type: 'orphaned' };
      } catch {
        terminal = { type: 'orphaned' };
      }
      try { result = validateWorkerResult(adapter.interpret(state, terminal)); } catch (interpretError) {
        result = workerFailure(worker, {
          status: 'failed',
          exitCategory: 'protocol_error',
          failure: boundedFailure(interpretError),
          startedAt,
          clock,
        });
      }
    } else {
      result = workerFailure(worker, {
        status: timedOut ? 'timed_out' : error?.code === 'HANDOFF_PROTOCOL' ? 'blocked' : 'failed',
        exitCategory: timedOut ? 'timeout' : 'protocol_error',
        failure: boundedFailure(error), startedAt, clock,
      });
    }
  } finally {
    if (state) {
      try {
        const cleaned = await adapter.cleanup(state);
        if (cleaned?.orphaned) {
          try { result = validateWorkerResult(adapter.interpret(state, { type: 'orphaned' })); } catch {
            result = workerFailure(worker, {
              status: 'failed',
              exitCategory: 'orphaned',
              failure: { reason: 'worker cleanup could not prove resource termination' },
              startedAt,
              clock,
            });
          }
          summary = null;
        }
      } catch {
        try { result = validateWorkerResult(adapter.interpret(state, { type: 'orphaned' })); } catch {
          result = workerFailure(worker, {
            status: 'failed',
            exitCategory: 'orphaned',
            failure: { reason: 'worker cleanup could not prove resource termination' },
            startedAt,
            clock,
          });
        }
        summary = null;
      }
    }
  }
  return { result, summary };
}

/** Execute one worker and guarantee cleanup after every prepared state. */
export async function executeWorker(worker, adapter, options = {}) {
  return (await executeWorkerAttempt(worker, adapter, options)).result;
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

// W1-B: an omitted `adapters` option resolves through the built-in merge
// seam (executionAdapterFor) instead of a raw Map reference, so a future
// externally-admitted adapter joins this same lookup without callers here
// changing. Explicit injection (tests, callers with their own registry)
// still takes a Map or plain object, unchanged. Only `undefined` selects the
// built-in seam: an explicit `null` disables ALL adapters (every worker
// degrades cli_unavailable) rather than meaning "use defaults" — fail-safe,
// but don't pass null expecting the built-ins.
function adapterFor(adapters, host) {
  const adapter = adapters === undefined
    ? executionAdapterFor(host)
    : adapters instanceof Map ? adapters.get(host) : adapters?.[host];
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
async function executeWorkerWithEscalation(worker, adapters, {
  cwd, timeoutMs, clock, escalate = false, requireHandoff = false,
}) {
  const ladder = escalate ? [...(worker.escalate ?? [])] : [];
  const attempts = [];
  let current = worker;
  let result;
  let summary;
  for (;;) {
    const adapter = adapterFor(adapters, current.host);
    if (adapter) {
      const attempt = await executeWorkerAttempt(current, adapter, {
        cwd, timeoutMs, clock, requireHandoff,
      });
      result = attempt.result;
      summary = attempt.summary;
    } else {
      result = workerFailure(current, {
        exitCategory: 'cli_unavailable',
        failure: { reason: `no execution adapter for host "${current.host}"` },
        clock,
      });
      summary = null;
    }
    attempts.push(compactAttempt(current, result));
    if (!escalatable(result)) break;
    const rung = ladder.shift();
    if (!rung) break;
    current = { ...current, host: rung.host, configuredModel: rung.model ?? null };
  }
  if (attempts.length > 1) result = validateWorkerResult({ ...result, attempts });
  return { result, summary: result.status === 'succeeded' ? summary : null };
}

/** Run a materialized routing plan as a bounded-concurrency dependency DAG.
 * A failed dependency blocks descendants; independent branches keep running.
 * `escalate: true` enables bounded per-worker ladder retries (ADR-0019). */
export async function executeRunPlan(plan, {
  adapters, cwd = process.cwd(), maxConcurrent = 4, timeoutMs, clock = nowIso, escalate = false,
} = /** @type {{adapters?:Record<string, any>|Map<string, any>, cwd?:string, maxConcurrent?:number, timeoutMs?:number, clock?:()=>string, escalate?:boolean}} */ ({})) {
  validatePlan(plan);
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) throw new TypeError('maxConcurrent must be a positive integer');
  const pending = new Map(plan.workers.map((worker) => [worker.id, worker]));
  const results = new Map();
  const summaries = new Map();
  const running = new Map();
  const mustSummarize = new Set(plan.workers.flatMap((worker) => worker.dependsOn ?? []));

  const start = (worker) => {
    const dependencies = (worker.dependsOn ?? []).map((id) => ({ id, handoff: summaries.get(id) }));
    let runtimePrompt = worker.prompt;
    const wantsHandoff = mustSummarize.has(worker.id);
    try {
      runtimePrompt += renderDependencyHandoffs(dependencies);
      if (wantsHandoff) {
        // ADR-0034: an adapter whose transport enforces the handoff schema on
        // the final message supplies its own instruction; the tagged-block
        // request stays the host-neutral default. An escalation rung that
        // switches hosts keeps the original instruction — parseHandoffText
        // accepts both forms on every schema-native host, so the summary
        // still validates.
        const adapter = adapterFor(adapters, worker.host);
        runtimePrompt += typeof adapter?.handoffRequestFor === 'function'
          ? adapter.handoffRequestFor(worker)
          : HANDOFF_REQUEST;
      }
    } catch (error) {
      results.set(worker.id, workerFailure(worker, {
        status: 'blocked',
        exitCategory: 'protocol_error',
        failure: boundedFailure(error),
        clock,
      }));
      pending.delete(worker.id);
      return;
    }
    // `requiresHandoff` rides the runtime worker so an adapter can add its
    // schema-output flags only for workers whose summary a dependent needs.
    const runtimeWorker = { ...worker, prompt: runtimePrompt, requiresHandoff: wantsHandoff };
    const promise = executeWorkerWithEscalation(runtimeWorker, adapters, {
      cwd,
      timeoutMs,
      clock,
      escalate,
      requireHandoff: wantsHandoff,
    });
    running.set(worker.id, promise.then((outcome) => ({ id: worker.id, ...outcome })));
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
      } else {
        const missing = deps.filter((id) => !summaries.has(id));
        if (missing.length) {
          results.set(worker.id, workerFailure(worker, {
            status: 'blocked',
            exitCategory: 'protocol_error',
            failure: { reason: 'dependency_handoff_missing', dependencies: missing },
            clock,
          }));
          pending.delete(worker.id);
        } else start(worker);
      }
    }
    if (!running.size) {
      if (pending.size) throw new Error('execution plan contains a dependency cycle');
      break;
    }
    const { id, result, summary } = await Promise.race(running.values());
    running.delete(id);
    results.set(id, result);
    if (summary) summaries.set(id, summary);
  }
  return plan.workers.map((worker) => results.get(worker.id));
}
