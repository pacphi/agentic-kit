// The ONLY way an external adapter's code ever executes: a supervised,
// short-lived subprocess. Adapters are untrusted code with an explicit exit
// door, not co-processes we trust to clean up after themselves — no shell,
// a minimal environment, bounded captured output, and the whole process
// group dies the instant a timeout fires.
//
// Deliberately simpler than execution/subprocess.mjs: one shot, no streaming
// summary capture, no graceful-then-forced two-step shutdown. A timed-out
// adapter hook gets no cleanup grace period; it already spent its budget.
import { spawn as nodeSpawn, execFile as nodeExecFile } from 'node:child_process';
import { isAbsolute as pathIsAbsolute } from 'node:path';
import { verifyAdapterContent } from './integrity.mjs';

const DEFAULT_TIMEOUT_MS = 30_000;
const OUTPUT_CAP_BYTES = 256 * 1024;
const BYTE_COUNT_SATURATION = OUTPUT_CAP_BYTES + 1;
const MAX_RECEIPT_DURATION_MS = 24 * 60 * 60 * 1000;
const TRUNCATION_MARKER = `\n…[truncated: adapter hook output exceeded ${OUTPUT_CAP_BYTES} bytes]`;
const STDERR_SEPARATOR = '\n--- stderr ---\n';
// Bounded wait for the process to actually report closed after a kill signal
// is sent. SIGKILL is not a promise the OS keeps synchronously; this is a
// safety net so a stuck kernel-blocked process can't hang the caller forever.
const KILL_GRACE_MS = 2_000;
const isWindows = process.platform === 'win32';
const TIMEOUT_SENTINEL = Symbol('adapter-hook-timeout');

/** Min-wins: whichever side asked for the tighter budget governs. A hook
 * cannot escalate past a caller-imposed ceiling, and a caller cannot force a
 * hook to run longer than the hook itself declared it needs. Neither side
 * specifying a timeout falls back to the 30s default. */
function resolveTimeout(paramTimeoutMs, hookTimeoutMs) {
  const candidates = [paramTimeoutMs, hookTimeoutMs].filter(
    (value) => Number.isFinite(value) && value > 0,
  );
  return candidates.length ? Math.min(...candidates) : DEFAULT_TIMEOUT_MS;
}

/** PATH, HOME, plus caller-passed entries only — never the full
 * process.env. Adapters must not inherit ak's secrets. */
function minimalEnv(extra) {
  const env = {};
  if (typeof process.env.PATH === 'string') env.PATH = process.env.PATH;
  if (typeof process.env.HOME === 'string') env.HOME = process.env.HOME;
  if (extra && typeof extra === 'object') {
    for (const [key, value] of Object.entries(extra)) {
      if (typeof key === 'string' && key && typeof value === 'string') env[key] = value;
    }
  }
  return env;
}

/** Accumulate chunks up to a hard byte ceiling, then silently drop the rest,
 * remembering that a drop happened. Bounds memory during the run itself —
 * the final combined-stream cap (and truncation marker) is applied
 * separately once both streams are known, but a stream truncated on its own
 * must still be reported as truncated even if it lands exactly at the cap. */
function boundedCollector(capBytes) {
  let buffer = Buffer.alloc(0);
  let truncated = false;
  let bytesSeen = 0;
  return {
    write(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytesSeen = Math.min(BYTE_COUNT_SATURATION, bytesSeen + bytes.length);
      if (buffer.length >= capBytes) {
        if (bytes.length > 0) truncated = true;
        return;
      }
      const next = Buffer.concat([buffer, bytes]);
      if (next.length > capBytes) {
        truncated = true;
        buffer = next.subarray(0, capBytes);
      } else {
        buffer = next;
      }
    },
    text() { return buffer.toString('utf8'); },
    wasTruncated() { return truncated; },
    bytesSeen() { return bytesSeen; },
  };
}

function monotonicNowMs() {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

/** Add a sanitized, bounded execution receipt to every process-level result.
 * Byte counts saturate one byte above the capture ceiling: callers can tell
 * that output exceeded the cap without retaining an attacker-controlled
 * unbounded count. Duration is likewise finite, integral, and capped. */
function withReceipt(result, {
  startedAtMs, effectiveTimeoutMs, stdoutCollector = null, stderrCollector = null,
}) {
  const rawDurationMs = Math.max(0, Math.ceil(monotonicNowMs() - startedAtMs));
  return {
    ...result,
    timeoutMs: effectiveTimeoutMs,
    durationMs: Math.min(rawDurationMs, MAX_RECEIPT_DURATION_MS),
    durationTruncated: rawDurationMs > MAX_RECEIPT_DURATION_MS,
    stdoutBytes: stdoutCollector?.bytesSeen() ?? 0,
    stderrBytes: stderrCollector?.bytesSeen() ?? 0,
  };
}

/** stdout first, then stderr folded in after a separator, then the whole
 * thing capped at OUTPUT_CAP_BYTES with a truncation marker appended if
 * anything was cut — whether that happened while collecting a single
 * oversized stream, or only once the two streams were combined. Never
 * unbounded. */
function mergeCapture(stdout, stderr) {
  const combined = stderr.text ? `${stdout.text}${STDERR_SEPARATOR}${stderr.text}` : stdout.text;
  const combinedBytes = Buffer.byteLength(combined, 'utf8');
  const overflow = combinedBytes > OUTPUT_CAP_BYTES;
  if (!stdout.truncated && !stderr.truncated && !overflow) return combined;
  const kept = overflow
    ? Buffer.from(combined, 'utf8').subarray(0, OUTPUT_CAP_BYTES).toString('utf8')
    : combined;
  return `${kept}${TRUNCATION_MARKER}`;
}

/** stderr alone, with the same per-stream truncation marker `mergeCapture`
 * would append — never folded into `stdout`. F-4: a caller that parses
 * `stdout` as a structured payload (e.g. the admitted execution adapter)
 * must never see raw stderr promoted into that parse; this is the field it
 * reads instead when it needs the process's diagnostic chatter. */
function boundedText({ text, truncated }) {
  return truncated ? `${text}${TRUNCATION_MARKER}` : text;
}

function describeFailure(hostId, verb, error) {
  const reason = error?.code ? `${error.code} (${error.message ?? 'no message'})` : (error?.message ?? String(error));
  return `${hostId}:${verb} adapter hook failed to start: ${reason}`;
}

function raceTimeout(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); });
  });
}

/** Best-effort kill of the whole process group/tree, not just the direct
 * child — a timed-out adapter hook may have spawned descendants of its own.
 * POSIX: the child was spawned detached so its pid is also its process group
 * id; signalling `-pid` reaches the whole group. Windows has no portable
 * signal for arbitrary console trees, so `taskkill /T /F` owns it there.
 * F-2: this cannot PROVE a double-forked or re-`setsid`'d grandchild died —
 * a signal sent is not a death confirmed. Callers that need that proof (the
 * admitted execution adapter's cancel path) must treat an unresolved launch
 * as honestly unproven (`orphaned`), not assume this function's return means
 * the tree is gone. */
async function killGroup(child) {
  if (!Number.isInteger(child?.pid)) return;
  if (isWindows) {
    await new Promise((resolve) => {
      nodeExecFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], () => resolve(undefined));
    });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch { /* process already gone */ }
  }
}

// ── runAdapterHook decomposition ─────────────────────────────────────────
// Each helper below reproduces one slice of the original sequential body
// verbatim, in the same order, so runAdapterHook itself just sequences
// them and its own complexity stays with the orchestration, not the
// process-lifecycle mechanics.

/** Every early-failure result shares this shape (no output was ever
 * captured, or none survives to report) — extracted so the three call
 * sites that used to spell it out stay byte-identical by construction. */
const EMPTY_HOOK_RESULT = Object.freeze({
  stdout: '', stdoutText: '', stderrText: '', stdoutTruncated: false, stderrTruncated: false,
});

/** Throws synchronously for malformed call arguments only — never for a
 * process-level failure (that's what `ok:false` + `detail` is for). */
function assertRunAdapterHookArgs({
  hook, hostId, verb, cwd,
}) {
  if (!hook || !Array.isArray(hook.command) || hook.command.length === 0
    || !hook.command.every((part) => typeof part === 'string' && part.length > 0)) {
    throw new TypeError('runAdapterHook requires hook.command as a non-empty array of non-empty strings');
  }
  if (typeof hostId !== 'string' || !hostId) throw new TypeError('runAdapterHook requires a hostId');
  if (typeof verb !== 'string' || !verb) throw new TypeError('runAdapterHook requires a verb');
  // F-1: a relative cwd would resolve against wherever the ak process
  // happens to be running, defeating the whole point of pinning the child to
  // the adapter's own directory — refused synchronously, same class as the
  // arg-shape checks above, never silently reinterpreted as "inherit".
  if (cwd !== undefined && (typeof cwd !== 'string' || !cwd || !pathIsAbsolute(cwd))) {
    throw new TypeError('runAdapterHook requires cwd to be an absolute path when provided');
  }
}

/**
 * Adrian's trust-gap finding: the manifest-only hash is not enough when a
 * hook points at mutable files. Re-read the declared bytes immediately
 * before spawn and fail closed if the content identity no longer matches
 * the admitted/consented identity. The check is optional for direct
 * unit-level callers that do not represent an admitted adapter; production
 * registration always supplies all three values. Returns a failure result,
 * or null when there's nothing to verify or verification passes.
 */
function verifyHookIntegrityOrFailure(manifest, integrity, baseDir, hostId, verb) {
  if (!manifest && !integrity) return null;
  try {
    verifyAdapterContent(manifest, integrity, { baseDir });
    return null;
  } catch (error) {
    return {
      ok: false, ...EMPTY_HOOK_RESULT, exitCode: null,
      outcome: 'integrity-rejected', timedOut: false,
      detail: `${hostId}:${verb} adapter hook integrity check failed: ${error?.message ?? String(error)}`,
    };
  }
}

/** Spawn the child, isolated so a synchronous spawn throw (ENOENT-class)
 * becomes the same `{failure}` shape a later async 'error' event does. */
function spawnAdapterChild({
  argv0, args, childEnv, cwd, wantsStdin, hostId, verb,
}) {
  try {
    const child = nodeSpawn(argv0, args, {
      env: childEnv,
      shell: false,
      stdio: [wantsStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      detached: !isWindows,
      // Absent cwd falls through to Node's own default (inherit
      // process.cwd()) — today's behavior for callers that don't pass one
      // yet (B2 threads the real adapter-base-dir cwd through this wave).
      ...(cwd === undefined ? {} : { cwd }),
    });
    return { child };
  } catch (error) {
    return { failure: {
      ok: false, ...EMPTY_HOOK_RESULT, exitCode: null,
      outcome: 'spawn-failed', timedOut: false,
      detail: describeFailure(hostId, verb, error),
    } };
  }
}

/** Write `stdin` (when the caller declared one) and swallow both the async
 * EPIPE-class error and any synchronous throw from an already-closed
 * stream — a child that exits before (or without) reading stdin is a
 * normal outcome (the process's own exit code already reports what
 * happened), never a reason to crash or reject runAdapterHook's promise. */
function wireAdapterStdin(child, wantsStdin, stdin) {
  if (!wantsStdin) return;
  child.stdin?.on('error', () => {});
  try {
    child.stdin?.end(stdin);
  } catch {
    // Synchronous throw from an already-closed stream — same non-fatal
    // treatment as the async 'error' event above.
  }
}

/** Race the child's close against the timeout budget. Returns
 * `{closeResult, getSpawnError}` — `getSpawnError()` reads the 'error'-event
 * value (if any); only meaningful to call once `closeResult` (or the
 * timeout race over it) has settled. */
function awaitAdapterClose(child) {
  let settled = false;
  let spawnError = null;
  const closeResult = new Promise((resolve) => {
    child.once('error', (error) => {
      spawnError = error;
      if (!settled) { settled = true; resolve({ code: null, signal: null }); }
    });
    child.once('close', (code, signal) => {
      if (!settled) { settled = true; resolve({ code, signal }); }
    });
  });
  return { closeResult, getSpawnError: () => spawnError };
}

/** The timed-out-and-killed result shape, capturing whatever output had
 * already accumulated before the kill. */
async function buildAdapterTimeoutResult({
  child, effectiveTimeoutMs, stdoutCollector, stderrCollector, closeResult, hostId, verb,
}) {
  await killGroup(child);
  await raceTimeout(closeResult, KILL_GRACE_MS); // best-effort; result unused
  const stdoutCaptured = { text: stdoutCollector.text(), truncated: stdoutCollector.wasTruncated() };
  const stderrCaptured = { text: stderrCollector.text(), truncated: stderrCollector.wasTruncated() };
  return {
    ok: false,
    exitCode: null,
    outcome: 'timed-out',
    timedOut: true,
    stdout: mergeCapture(stdoutCaptured, stderrCaptured),
    stdoutText: boundedText(stdoutCaptured),
    stderrText: boundedText(stderrCaptured),
    stdoutTruncated: stdoutCaptured.truncated,
    stderrTruncated: stderrCaptured.truncated,
    detail: `${hostId}:${verb} adapter hook timed out after ${effectiveTimeoutMs}ms and was killed`,
  };
}

/** The normal-completion result shape (child closed before the timeout).
 * F-4/R-1: stdout stays the combined stream for diagnostics/back-compat,
 * but a caller parsing stdout as a structured payload (the admitted
 * execution adapter) must read stdoutText instead — stdout has stderr
 * folded in after a separator, which breaks JSON.parse the instant the
 * hook writes anything to stderr at all. stderrText is diagnostics-only. */
function buildAdapterCloseResult(code, signal, stdoutCollector, stderrCollector, hostId, verb) {
  const stdoutCaptured = { text: stdoutCollector.text(), truncated: stdoutCollector.wasTruncated() };
  const stderrCaptured = { text: stderrCollector.text(), truncated: stderrCollector.wasTruncated() };
  const stdout = mergeCapture(stdoutCaptured, stderrCaptured);
  const stdoutText = boundedText(stdoutCaptured);
  const stderrText = boundedText(stderrCaptured);
  return code === 0
    ? {
      ok: true, stdout, stdoutText, stderrText,
      stdoutTruncated: stdoutCaptured.truncated,
      stderrTruncated: stderrCaptured.truncated,
      exitCode: 0, outcome: 'success', timedOut: false, detail: null,
    }
    : Number.isInteger(code) ? {
      ok: false, stdout, stdoutText, stderrText,
      stdoutTruncated: stdoutCaptured.truncated,
      stderrTruncated: stderrCaptured.truncated,
      exitCode: code, outcome: 'nonzero-exit', timedOut: false,
      detail: `${hostId}:${verb} adapter hook exited with code ${code}`,
    } : {
      ok: false, stdout, stdoutText, stderrText,
      stdoutTruncated: stdoutCaptured.truncated,
      stderrTruncated: stderrCaptured.truncated,
      exitCode: null, outcome: 'signal-exit', timedOut: false,
      detail: `${hostId}:${verb} adapter hook exited after signal ${signal ?? 'unknown'}`,
    };
}

/**
 * Run one adapter hook as a supervised subprocess and report what happened.
 * Never throws for process failures (ENOENT, timeout, non-zero exit) — those
 * are reported via `ok:false` and `detail`. Only malformed call arguments
 * (missing/invalid `hook`, `hostId`, or `verb`) throw synchronously.
 *
 * @param {{hook:{command:string[], timeoutMs?:number}, hostId:string,
 *   verb:string, timeoutMs?:number, env?:Record<string,string>, stdin?:string,
 *   cwd?:string, manifest?:object, integrity?:{hash:string}, baseDir?:string|null}} options
 * @returns {Promise<{ok:boolean, stdout:string, stdoutText:string, stderrText:string,
 *   stdoutTruncated:boolean, stderrTruncated:boolean, stdoutBytes:number, stderrBytes:number,
 *   durationMs:number, durationTruncated:boolean, timeoutMs:number, timedOut:boolean,
 *   outcome:string, exitCode:number|null, detail:string|null}>}
 */
export async function runAdapterHook({
  hook, hostId, verb, timeoutMs, env, stdin, cwd, manifest, integrity, baseDir,
} = /** @type {any} */ ({})) {
  assertRunAdapterHookArgs({
    hook, hostId, verb, cwd,
  });

  const effectiveTimeoutMs = resolveTimeout(timeoutMs, hook.timeoutMs);
  const startedAtMs = monotonicNowMs();
  const [argv0, ...args] = hook.command;
  const childEnv = minimalEnv(env);

  const integrityFailure = verifyHookIntegrityOrFailure(manifest, integrity, baseDir, hostId, verb);
  if (integrityFailure) return withReceipt(integrityFailure, { startedAtMs, effectiveTimeoutMs });

  const wantsStdin = typeof stdin === 'string';
  const spawned = spawnAdapterChild({
    argv0, args, childEnv, cwd, wantsStdin, hostId, verb,
  });
  if (spawned.failure) return withReceipt(spawned.failure, { startedAtMs, effectiveTimeoutMs });
  const { child } = spawned;

  const stdoutCollector = boundedCollector(OUTPUT_CAP_BYTES);
  const stderrCollector = boundedCollector(OUTPUT_CAP_BYTES);
  child.stdout?.on('data', (chunk) => stdoutCollector.write(chunk));
  child.stderr?.on('data', (chunk) => stderrCollector.write(chunk));

  wireAdapterStdin(child, wantsStdin, stdin);

  const { closeResult, getSpawnError } = awaitAdapterClose(child);
  const raced = await raceTimeout(closeResult, effectiveTimeoutMs);
  if (raced === TIMEOUT_SENTINEL) {
    const result = await buildAdapterTimeoutResult({
      child, effectiveTimeoutMs, stdoutCollector, stderrCollector, closeResult, hostId, verb,
    });
    return withReceipt(result, {
      startedAtMs, effectiveTimeoutMs, stdoutCollector, stderrCollector,
    });
  }

  const spawnError = getSpawnError();
  if (spawnError) {
    return withReceipt({
      ok: false, ...EMPTY_HOOK_RESULT, exitCode: null,
      outcome: 'spawn-failed', timedOut: false,
      detail: describeFailure(hostId, verb, spawnError),
    }, { startedAtMs, effectiveTimeoutMs, stdoutCollector, stderrCollector });
  }

  return withReceipt(
    buildAdapterCloseResult(raced.code, raced.signal, stdoutCollector, stderrCollector, hostId, verb),
    { startedAtMs, effectiveTimeoutMs, stdoutCollector, stderrCollector },
  );
}
