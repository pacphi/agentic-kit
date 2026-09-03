import { spawnSync } from 'node:child_process';

const BINARY = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_ARG_BYTES = 4096;
const MAX_OUTPUT_BYTES = 256 * 1024;

export async function runNativeCommand(binary, args, {
  spawnSyncImpl = spawnSync, timeoutMs = 30_000, env = process.env,
} = {}) {
  if (!BINARY.test(binary ?? '')) throw new TypeError('native command binary is invalid');
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string'
      || Buffer.byteLength(arg) > MAX_ARG_BYTES || arg.includes('\0'))) {
    throw new TypeError('native command arguments are invalid');
  }
  const result = spawnSyncImpl(binary, args, {
    encoding: 'utf8', shell: false, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES,
    env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    ok: result.status === 0 && !result.error && !result.signal,
    exitCode: Number.isInteger(result.status) ? result.status : null,
    timedOut: /** @type {NodeJS.ErrnoException|undefined} */ (result.error)?.code === 'ETIMEDOUT',
    signal: result.signal ?? null,
    stdout: String(result.stdout ?? '').slice(0, MAX_OUTPUT_BYTES),
    stderr: String(result.stderr ?? '').slice(0, MAX_OUTPUT_BYTES),
  };
}
