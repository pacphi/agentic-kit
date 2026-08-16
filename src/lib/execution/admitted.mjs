// Derived execution adapter for an ADMITTED external host (P2, ADR-0031).
// This is the ONLY place an admitted manifest's execution.run.hook ever runs:
// a single-shot supervised subprocess through hook-runner.mjs — no in-process
// third-party code, ever. Deliberately simpler than opencode.mjs: one spawn,
// no server lifecycle, no streaming — launch() completes when the child exits.
import path from 'node:path';
import { runAdapterHook } from '../adapters/hook-runner.mjs';
import { resetAdmitted } from '../adapters/admitted.mjs';
import { have } from '../exec.mjs';
import { validateExecutionAdapter, validateWorkerResult } from './schema.mjs';
import { redactHandoffData } from './handoff.mjs';

const DEFAULT_TIMEOUT_MS = 120_000;
// hook-runner's own inner timeout is what actually kills the child; the
// runner's outer phase deadline must never race it. Both timers would be
// registered for the same duration if we handed hook-runner the raw
// remaining budget, but hook-runner's timer starts a beat later (spawn
// overhead) — so it would lose that race. Shaving a small margin off what we
// hand the hook keeps the inner kill strictly first.
const LAUNCH_TIMEOUT_MARGIN_MS = 250;
const REASON_MAX_BYTES = 240;
const PROVIDER_MAX_CHARS = 64;
// Wave B security review (F-6): reserved hook exit codes give an admitted
// host an honest consent/auth boundary instead of a silent re-run — part of
// the adapter contract, alongside stdin/env/exit-0 in the module header.
// 77 -> the hook needs interactive/out-of-band consent it does not have
//        (mirrors sysexits.h EX_NOPERM in spirit): status 'blocked',
//        exitCategory 'permission_required' — already non-escalating
//        (runner.mjs's BLOCKING_CATEGORIES).
// 78 -> the hook needs authentication it does not have: status 'failed',
//        exitCategory 'auth_required'.
const EXIT_PERMISSION_REQUIRED = 77;
const EXIT_AUTH_REQUIRED = 78;

const nowIso = () => new Date().toISOString();

function boundedReason(text, maxBytes = REASON_MAX_BYTES) {
  const value = typeof text === 'string' ? text : String(text ?? '');
  return value.length > maxBytes ? `${value.slice(0, maxBytes - 1)}…` : value;
}

function execError(reason, message) {
  return Object.assign(new Error(message), { reason });
}

// F-1: a relative hook command resolves against whatever `cwd` the child
// spawns with. With no anchored adapter base directory (a remote npm/https
// source has no persistent local bundle), that would fall back to the
// OPERATOR's process.cwd() when `ak run` was invoked — arbitrary-code-
// execution by planting a same-named file, with the consent hash unchanged.
// A bare interpreter/binary name found through PATH (node, hermes) is
// unaffected by cwd and stays legal; only a path-separator-bearing or
// script-looking bare token is refused.
const SCRIPT_LIKE_RE = /\.(?:mjs|cjs|js|ts|py|rb|sh|pl)$/i;

function looksRelative(token) {
  if (typeof token !== 'string' || !token) return false;
  if (path.isAbsolute(token)) return false;
  if (token.includes('/') || token.includes('\\')) return true;
  return SCRIPT_LIKE_RE.test(token);
}

// R-3: EVERY arg is inspected, not just non-flag ones — a `--flag=value`
// token starts with '-' but its value half can still be a relative path
// (`--import=./evil.mjs`), and looksRelative's own `.includes('/')` check
// already catches that once the whole token is examined (no separate '='
// split needed: the token as a whole still contains '/'). Skipping
// '-'-prefixed args entirely (the pre-R-3 shape) let exactly this slip past
// with a null baseDir. A bare flag with no path-like value (`--verbose`,
// `-v`) is unaffected — it matches neither check and stays legal.
function commandIsUnanchorable(command) {
  const [argv0, ...args] = command;
  if (looksRelative(argv0)) return true;
  return args.some((arg) => looksRelative(arg));
}

/** stdout is EITHER a JSON object with optional {summary, observedModel,
 *  provider, usage} — read when the whole trimmed `stdoutText` (R-1: the
 *  UNMERGED stdout hook-runner reports; never `stdout`, which folds stderr
 *  in after a separator and would break JSON.parse the instant the hook
 *  writes anything to stderr at all) parses as a JSON object — OR plain
 *  text, treated as the summary capture (ADR-0029 §2).
 *  F-4: `stderrText` gates ONLY the plain-text path — a hook that wrote to
 *  stderr (warnings, a crash trace, interpreter noise) never has that text
 *  silently promoted into the cross-vendor dependency handoff. A genuine
 *  JSON payload parses and is trusted REGARDLESS of stderr (R-1: a stray
 *  deprecation warning must not blank out an otherwise-valid summary and
 *  cascade into "required worker handoff was missing" for every dependent).
 *  F-7: a self-declared `provider` is bounded (a payload cannot claim an
 *  unbounded-length vendor name). */
function parseStdout(stdoutText, stderrText) {
  const trimmed = typeof stdoutText === 'string' ? stdoutText.trim() : '';
  const hasStderr = typeof stderrText === 'string' && stderrText.trim() !== '';
  if (!trimmed) return { summary: null, observedModel: null, provider: null, usage: null };
  let parsed;
  try { parsed = JSON.parse(trimmed); } catch { parsed = undefined; }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return {
      summary: typeof parsed.summary === 'string' ? parsed.summary : null,
      observedModel: typeof parsed.observedModel === 'string' ? parsed.observedModel : null,
      provider: typeof parsed.provider === 'string' ? parsed.provider.slice(0, PROVIDER_MAX_CHARS) : null,
      usage: parsed.usage && typeof parsed.usage === 'object' && !Array.isArray(parsed.usage) ? parsed.usage : null,
    };
  }
  if (hasStderr) return { summary: null, observedModel: null, provider: null, usage: null };
  return { summary: trimmed, observedModel: null, provider: null, usage: null };
}

/**
 * Build a host-neutral execution adapter for one admitted manifest declaring
 * `execution.run.hook`. `runHook`/`haveFn`/`clock` are injectable for tests;
 * production defaults spawn the real subprocess. `baseDir` (F-1) is the
 * adapter's own directory — derived by the caller (admission.mjs) from the
 * manifest's `source` at registration time, `null` for a source with no
 * persistent local bundle (npm/https) — never process.cwd().
 */
export function buildAdmittedExecutionAdapter(manifest, {
  runHook = runAdapterHook, haveFn = have, clock = nowIso, baseDir = null,
} = {}) {
  if (!manifest || typeof manifest !== 'object') throw new TypeError('buildAdmittedExecutionAdapter requires a manifest');
  const hostId = manifest.host?.id;
  if (typeof hostId !== 'string' || !hostId) throw new TypeError('buildAdmittedExecutionAdapter requires manifest.host.id');
  // F-8 (defence-in-depth, INEXPRESSIBLE-not-refused doctrine): the manifest
  // schema already couples execution -> canRouteActivities (manifest.mjs's
  // 'execution-not-routable'), but this is the construction site that
  // actually wires a subprocess spawn — it re-asserts the invariant itself
  // rather than trusting every caller to have validated upstream.
  if (manifest.host?.capabilities?.canRouteActivities !== true) {
    throw execError('not-routable', `'${hostId}' execution adapter requires host.capabilities.canRouteActivities:true`);
  }
  // F-5 (ADR-0029 §2): a manifest that never declared the cli-subprocess
  // driving surface gets no cli-subprocess execution adapter — refused, not
  // silently downgraded. Re-checked here even though the bootstrap filter
  // (admission.mjs) already screens candidates, so no other caller can skip it.
  if (!Array.isArray(manifest.driving?.surfaces) || !manifest.driving.surfaces.includes('cli-subprocess')) {
    throw execError('surface-unsupported', `'${hostId}' execution adapter requires driving.surfaces to include 'cli-subprocess'`);
  }
  const hook = manifest.execution?.run?.hook;
  if (!hook || !Array.isArray(hook.command) || hook.command.length === 0) {
    throw new TypeError(`buildAdmittedExecutionAdapter requires manifest.execution.run.hook for '${hostId}'`);
  }
  const detectionBin = manifest.detection?.bin;
  if (typeof detectionBin !== 'string' || !detectionBin) {
    throw new TypeError(`buildAdmittedExecutionAdapter requires manifest.detection.bin for '${hostId}'`);
  }
  if (baseDir == null && commandIsUnanchorable(hook.command)) {
    throw execError('execution-unanchored',
      `'${hostId}' declares a relative execution.run.hook.command with no anchored adapter base directory `
      + '(a remote npm/https source has no persistent local bundle) — use an absolute path or a PATH binary');
  }

  function terminalResult(state, base) {
    return validateWorkerResult({
      workerId: state.worker.id, activity: state.worker.activity, role: state.worker.role, host: hostId,
      startedAt: state.startedAt, endedAt: clock(),
      durationMs: Math.max(0, Date.parse(clock()) - Date.parse(state.startedAt)),
      provider: null, providerProvenance: 'unknown', configuredModel: state.worker.configuredModel ?? null,
      observedModel: null, sessionId: null, transcriptRefs: [], failure: null, usage: null,
      ...base,
    });
  }

  const adapter = {
    id: `${hostId}-adapter`,

    async readiness({ signal, timeoutMs } = /** @type {{signal?:AbortSignal,timeoutMs?:number}} */ ({})) {
      signal?.throwIfAborted?.();
      const ready = await haveFn(detectionBin, { signal, timeout: timeoutMs });
      signal?.throwIfAborted?.();
      return ready ? { ready: true } : { ready: false, exitCategory: 'cli_unavailable' };
    },

    async prepare({ worker, cwd = process.cwd() } = /** @type {{worker?:any,cwd?:string}} */ ({})) {
      if (!worker || worker.host !== hostId) throw new TypeError(`${hostId} adapter requires a ${hostId} worker`);
      // R-2: state.cwd doubles as the fallback spawn cwd (below) AND rides
      // in AK_WORKER_CWD — runAdapterHook itself throws on a non-absolute
      // cwd, so this assertion (mirroring opencode.mjs's own worker-cwd
      // check) is what makes that downstream guarantee hold, not an
      // incidental duplicate of it.
      if (!path.isAbsolute(cwd)) throw new TypeError(`${hostId} worker cwd must be absolute`);
      return { worker, cwd, prompt: worker.prompt, startedAt: clock() };
    },

    async launch(state, { timeoutMs, signal } = /** @type {{timeoutMs?:number,signal?:AbortSignal}} */ ({})) {
      signal?.throwIfAborted?.();
      const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
      const innerTimeoutMs = Math.max(1, budget - LAUNCH_TIMEOUT_MARGIN_MS);
      const env = {
        AK_WORKER_ID: state.worker.id,
        AK_WORKER_ACTIVITY: state.worker.activity,
        AK_WORKER_ROLE: state.worker.role,
        AK_WORKER_MODEL: state.worker.configuredModel ?? '',
        // R-2: F-1's cwd pin (below) took away the hook's only implicit
        // channel for learning which repo it's working on — the spawn cwd is
        // now the adapter's own baseDir, not the caller's. Told explicitly
        // instead, so a hook that needs the target repo can still find it
        // without reopening F-1 by spawning there.
        AK_WORKER_CWD: state.cwd,
      };
      state.hookResult = await runHook({
        hook, hostId, verb: 'run', timeoutMs: innerTimeoutMs, env, stdin: state.prompt,
        // R-2: the spawn cwd is uniform and explicit, never Node's own
        // "inherit ak's process.cwd()" default (runAdapterHook's own
        // fallback for an omitted cwd) — baseDir anchors a relative script
        // to the adapter's own directory when one was declared (F-1);
        // otherwise the construction-time check above already proved the
        // command has no relative component that a cwd could redirect, so
        // falling back to the repo cwd (state.cwd) here is safe (only bare
        // PATH binaries reach this branch) and gives the hook a normal
        // "run me from the target repo" default.
        cwd: baseDir ?? state.cwd,
      });
      return state;
    },

    async observe(state) {
      const result = state.hookResult;
      if (!result) throw new Error(`${hostId} adapter observed before launch completed`);
      return {
        type: 'exit', ok: result.ok, stdout: result.stdout,
        // R-1: stdoutText is the UNMERGED stdout — see parseStdout's header
        // comment for why the payload must never be parsed from `stdout`.
        stdoutText: result.stdoutText ?? '',
        exitCode: result.exitCode, detail: result.detail,
        stderrText: result.stderrText ?? result.stderr ?? '',
      };
    },

    interpret(state, observation) {
      // Runner-injected terminal events (outer phase deadline aborting
      // launch/observe before our own {type:'exit'} observation lands, or an
      // unexpected cancel/cleanup failure). See LAUNCH_TIMEOUT_MARGIN_MS above
      // for why the 'exit' path is the expected one in practice.
      if (observation?.type === 'timeout') {
        return terminalResult(state, { status: 'timed_out', exitCategory: 'timeout', failure: { reason: boundedReason(observation.reason ?? 'timeout') } });
      }
      if (observation?.type === 'orphaned') {
        return terminalResult(state, { status: 'failed', exitCategory: 'orphaned', failure: { reason: 'admitted host subprocess did not terminate' } });
      }
      if (observation?.type !== 'exit') {
        return terminalResult(state, { status: 'failed', exitCategory: 'protocol_error', failure: { reason: 'unrecognized observation from admitted host adapter' } });
      }

      const {
        ok, exitCode, stdout, stdoutText, detail, stderrText,
      } = observation;
      if (ok && exitCode === 0) {
        const parsed = parseStdout(stdoutText, stderrText);
        return terminalResult(state, {
          status: 'succeeded', exitCategory: 'success', failure: null,
          observedModel: parsed.observedModel,
          provider: parsed.provider,
          // F-7: a payload's self-declared provider is NEVER 'observed' — the
          // hook asserted it, ak didn't verify it against anything.
          providerProvenance: parsed.provider ? 'inferred' : 'unknown',
          usage: parsed.usage,
        });
      }
      // F-6: reserved hook exit codes (see module header) — checked ahead of
      // the generic non-zero-exit fallback below.
      if (exitCode === EXIT_PERMISSION_REQUIRED) {
        return terminalResult(state, {
          status: 'blocked', exitCategory: 'permission_required',
          failure: { reason: boundedReason(detail ?? 'adapter hook requires consent it does not have (exit 77)') },
        });
      }
      if (exitCode === EXIT_AUTH_REQUIRED) {
        return terminalResult(state, {
          status: 'failed', exitCategory: 'auth_required',
          failure: { reason: boundedReason(detail ?? 'adapter hook requires authentication it does not have (exit 78)') },
        });
      }
      if (exitCode === null && typeof detail === 'string' && /timed out/i.test(detail)) {
        return terminalResult(state, { status: 'timed_out', exitCategory: 'timeout', failure: { reason: boundedReason(detail) } });
      }
      if (exitCode === null) {
        return terminalResult(state, { status: 'failed', exitCategory: 'cli_unavailable', failure: { reason: boundedReason(detail ?? 'adapter hook failed to start') } });
      }
      // F-3: the stdout tail folded into a worker_error reason is untrusted
      // hook output — it may itself contain a `<AK_HANDOFF_V1>` block (or
      // other private-protocol payload) that must never leak through a
      // public WorkerResult's failure.reason. Redact before bounding, same
      // as subprocess.mjs's failureFor.
      const tail = typeof stdout === 'string' ? stdout.trim().slice(-200) : '';
      const raw = tail ? `${detail} — ${tail}` : (detail ?? `adapter hook exited with code ${exitCode}`);
      return terminalResult(state, { status: 'failed', exitCategory: 'worker_error', failure: { reason: boundedReason(redactHandoffData(raw)) } });
    },

    // The hook script's own protocol is simpler than the tagged-block one
    // LLM-driven built-in hosts use: a JSON payload's `summary` field (or
    // plain-text stdout, when stderr is empty) IS the outcome, verbatim — no
    // `<AK_HANDOFF_V1>` parsing. Wrap it into normalizeHandoff's exact
    // accepted shape rather than returning the bare `{summary}` it was read
    // from.
    summarize(_state, observation) {
      if (observation?.type !== 'exit' || !observation.ok || observation.exitCode !== 0) return null;
      const { summary } = parseStdout(observation.stdoutText, observation.stderrText);
      if (!summary) return null;
      return { outcome: summary, artifacts: [], decisions: [], risks: [] };
    },

    // hook-runner owns the kill (group SIGKILL on its own inner timeout);
    // launch() only resolves once the subprocess has already exited, so by
    // the time cancel/cleanup can run there is normally no live resource
    // left to terminate. The one exception (F-2): if the runner's OUTER
    // phase deadline fires WHILE launch() is still pending — state.hookResult
    // never got set — the subprocess may still be alive and its termination
    // is unproven. Reporting plain 'cancelled' there would let the runner's
    // escalation ladder treat this as an ordinary escalatable timed_out and
    // fire a SECOND attempt against a worker that might still be running.
    // 'orphaned' is honest (uncertain, non-escalating) and matches
    // runner.mjs's own BLOCKING_CATEGORIES.
    async cancel(state) {
      if (!state?.hookResult) return { type: 'cancelled', orphaned: true };
      return { type: 'cancelled' };
    },
    async cleanup() { return { cleaned: true }; },
  };

  return validateExecutionAdapter(adapter);
}

// ── overlay registry (mirrors adapters/admitted.mjs's discipline) ──────────
// Module-level Map, not the built-in EXECUTION_ADAPTERS Map: an admitted
// external host's adapter is DERIVED from its manifest at bootstrap time, not
// hand-authored in-tree. A second register for the same host id replaces the
// first (re-admission, or a test re-registering); production populates this
// only from bootstrapHostAdapters (admission.mjs).
let admittedExecutionAdapters = new Map();

/** Build and register an execution adapter for an admitted manifest. Returns
 *  the built adapter. Throws (uncaught) on a manifest with no execution
 *  block or a malformed one — callers (bootstrap) are expected to guard this
 *  per-adapter and treat a throw as a non-fatal warning, not a crash. */
export function registerAdmittedExecution(manifest, options) {
  const adapter = buildAdmittedExecutionAdapter(manifest, options);
  admittedExecutionAdapters.set(manifest.host.id, adapter);
  return adapter;
}

/** Test-only reset back to the unregistered, built-ins-only state. */
export function resetAdmittedExecution() {
  admittedExecutionAdapters = new Map();
}

/** One admitted host's execution adapter, or null when none is registered —
 *  never throws, mirroring executionAdapterFor's degrade-one-worker posture. */
export function admittedExecutionAdapterFor(hostId) {
  return admittedExecutionAdapters.get(hostId) ?? null;
}

// F-9: the host overlay (adapters/admitted.mjs) and this execution overlay
// are two independently-mutable module singletons that a caller could reset
// out of step (e.g. a test resetting only one), leaving the other stale — an
// admitted-but-execution-orphaned or execution-registered-but-unadmitted
// state neither overlay's own reset guards against alone. Pairing them here
// (rather than reaching into adapters/admitted.mjs to add an upward
// dependency on this module) keeps that file untouched.
export function resetAllAdmitted() {
  resetAdmittedExecution();
  resetAdmitted();
}
