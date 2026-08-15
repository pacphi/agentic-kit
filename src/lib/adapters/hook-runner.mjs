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

const DEFAULT_TIMEOUT_MS = 30_000;
const OUTPUT_CAP_BYTES = 256 * 1024;
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
  return {
    write(chunk) {
      if (buffer.length >= capBytes) {
        if (chunk.length > 0) truncated = true;
        return;
      }
      const next = Buffer.concat([buffer, chunk]);
      if (next.length > capBytes) {
        truncated = true;
        buffer = next.subarray(0, capBytes);
      } else {
        buffer = next;
      }
    },
    text() { return buffer.toString('utf8'); },
    wasTruncated() { return truncated; },
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
 * signal for arbitrary console trees, so `taskkill /T /F` owns it there. */
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

/**
 * Run one adapter hook as a supervised subprocess and report what happened.
 * Never throws for process failures (ENOENT, timeout, non-zero exit) — those
 * are reported via `ok:false` and `detail`. Only malformed call arguments
 * (missing/invalid `hook`, `hostId`, or `verb`) throw synchronously.
 *
 * @param {{hook:{command:string[], timeoutMs?:number}, hostId:string,
 *   verb:string, timeoutMs?:number, env?:Record<string,string>}} options
 * @returns {Promise<{ok:boolean, stdout:string, exitCode:number|null, detail:string|null}>}
 */
export async function runAdapterHook({ hook, hostId, verb, timeoutMs, env } = /** @type {any} */ ({})) {
  if (!hook || !Array.isArray(hook.command) || hook.command.length === 0
    || !hook.command.every((part) => typeof part === 'string' && part.length > 0)) {
    throw new TypeError('runAdapterHook requires hook.command as a non-empty array of non-empty strings');
  }
  if (typeof hostId !== 'string' || !hostId) throw new TypeError('runAdapterHook requires a hostId');
  if (typeof verb !== 'string' || !verb) throw new TypeError('runAdapterHook requires a verb');

  const effectiveTimeoutMs = resolveTimeout(timeoutMs, hook.timeoutMs);
  const [argv0, ...args] = hook.command;
  const childEnv = minimalEnv(env);

  let child;
  try {
    child = nodeSpawn(argv0, args, {
      env: childEnv,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: !isWindows,
    });
  } catch (error) {
    return { ok: false, stdout: '', exitCode: null, detail: describeFailure(hostId, verb, error) };
  }

  const stdoutCollector = boundedCollector(OUTPUT_CAP_BYTES);
  const stderrCollector = boundedCollector(OUTPUT_CAP_BYTES);
  child.stdout?.on('data', (chunk) => stdoutCollector.write(chunk));
  child.stderr?.on('data', (chunk) => stderrCollector.write(chunk));

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

  const raced = await raceTimeout(closeResult, effectiveTimeoutMs);
  if (raced === TIMEOUT_SENTINEL) {
    await killGroup(child);
    await raceTimeout(closeResult, KILL_GRACE_MS); // best-effort; result unused
    return {
      ok: false,
      exitCode: null,
      stdout: mergeCapture(
        { text: stdoutCollector.text(), truncated: stdoutCollector.wasTruncated() },
        { text: stderrCollector.text(), truncated: stderrCollector.wasTruncated() },
      ),
      detail: `${hostId}:${verb} adapter hook timed out after ${effectiveTimeoutMs}ms and was killed`,
    };
  }

  if (spawnError) {
    return { ok: false, stdout: '', exitCode: null, detail: describeFailure(hostId, verb, spawnError) };
  }

  const { code } = raced;
  const stdout = mergeCapture(
    { text: stdoutCollector.text(), truncated: stdoutCollector.wasTruncated() },
    { text: stderrCollector.text(), truncated: stderrCollector.wasTruncated() },
  );
  return code === 0
    ? { ok: true, stdout, exitCode: 0, detail: null }
    : { ok: false, stdout, exitCode: code, detail: `${hostId}:${verb} adapter hook exited with code ${code}` };
}
