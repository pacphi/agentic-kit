// agentic-qe#754: does AQE's RVF pattern index bind to the configured embedder?
// Only the shipped bundle can answer. Importing AQE's unbundled dist modules
// (as the embedder probe does) leaves the native RVF binding unavailable, so
// AQE silently falls back to its in-memory index and such a probe fails on
// every release. This probe runs the installed `aqe` command instead: it
// learns one pattern and searches for it in a disposable project, so nothing
// is written to the user's project.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from './exec.mjs';
import { cmpVersions } from './versions.mjs';

/** @typedef {{status:'passed'}|{status:'failed'|'unavailable'|'invalid-config',reason:string}} PatternIndexResult */

/** First agentic-qe release containing the fix (upstream PR 768). */
export const PATTERN_INDEX_FIX_VERSION = '3.14.5';

const PATTERN_NAME = 'ak-pattern-index-probe';
const PATTERN_TEXT = 'ak live check for agentic-qe#754: the RVF pattern index binds to the configured embedder';
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_TIMEOUT_MS = 30_000;

function installedAqe(packageRoot) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.aqe;
    if (typeof pkg.version !== 'string' || typeof bin !== 'string') return null;
    const file = path.join(packageRoot, bin);
    return fs.statSync(file).isFile() ? { version: pkg.version, bin: file } : null;
  } catch { return null; }
}

/** The command's JSON document: the whole output, or what follows the last bare
 *  `{` line (AQE prints runtime warnings before pretty-printed JSON). */
function jsonOutput(stdout) {
  const attempt = (text) => { try { return JSON.parse(text); } catch { return null; } };
  const whole = attempt(stdout.trim());
  if (whole) return whole;
  const lines = stdout.split('\n');
  const start = lines.findLastIndex((line) => line === '{');
  return start < 0 ? null : attempt(lines.slice(start).join('\n'));
}

const timedOut = (result) => /timed out after/.test(result.stderr ?? '');

/**
 * @param {{packageRoot?:string,env?:NodeJS.ProcessEnv,timeoutMs?:number,runner?:typeof run}} options
 * @returns {Promise<PatternIndexResult>}
 */
export async function probeAqePatternIndex({ packageRoot, env = process.env, timeoutMs = 10_000, runner = run } = {}) {
  const request = checkRequest({ packageRoot, env, timeoutMs });
  if ('status' in request) return request;
  const { aqe } = request;
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-aqe-pattern-index-'));
  const options = {
    cwd: project, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES,
    env: { ...Object.fromEntries(Object.keys(process.env).map((key) => [key, undefined])),
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: project, USERPROFILE: project,
      AQE_PROJECT_ROOT: project, AQE_EMBEDDER_ENDPOINT: env.AQE_EMBEDDER_ENDPOINT, AQE_EMBEDDER_TOKEN: env.AQE_EMBEDDER_TOKEN },
  };
  try {
    return await learnThenSearch((...args) => runner(process.execPath, [aqe.bin, ...args], options));
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
}

/** The installed AQE to run, or the result that refuses the request before anything runs.
 * @returns {{aqe:{version:string,bin:string}}|PatternIndexResult} */
function checkRequest({ packageRoot, env, timeoutMs }) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    return { status: 'invalid-config', reason: 'timeout-must-be-between-1-and-30000-ms' };
  }
  if (!env.AQE_EMBEDDER_ENDPOINT) return { status: 'unavailable', reason: 'backend-not-endpoint' };
  const aqe = typeof packageRoot === 'string' && path.isAbsolute(packageRoot) ? installedAqe(packageRoot) : null;
  if (!aqe) return { status: 'unavailable', reason: 'aqe-package-unavailable' };
  if (cmpVersions(aqe.version, PATTERN_INDEX_FIX_VERSION) < 0) return { status: 'unavailable', reason: 'version-below-fix' };
  return { aqe };
}

/** @param {(...args:string[]) => Promise<{code:number,stdout:string,stderr:string}>} aqeCommand @returns {Promise<PatternIndexResult>} */
async function learnThenSearch(aqeCommand) {
  const learn = await aqeCommand('hooks', 'learn', '--json', '--name', PATTERN_NAME, '--description', PATTERN_TEXT);
  if (learn.code !== 0) return { status: 'failed', reason: timedOut(learn) ? 'timeout' : 'learn-failed' };
  const learned = jsonOutput(learn.stdout);
  if (learned?.success === false) return { status: 'failed', reason: 'learn-failed' };
  const id = learned?.pattern?.id;
  if (learned?.success !== true || typeof id !== 'string') return { status: 'failed', reason: 'invalid-output' };

  const search = await aqeCommand('hooks', 'search', '--json', '--query', PATTERN_TEXT, '--limit', '5');
  if (search.code !== 0) return { status: 'failed', reason: timedOut(search) ? 'timeout' : 'search-failed' };
  const found = jsonOutput(search.stdout);
  if (!Array.isArray(found?.patterns)) return { status: 'failed', reason: 'invalid-output' };
  const match = found.patterns.find((pattern) => pattern?.id === id);
  if (!match) return { status: 'failed', reason: 'pattern-not-retrieved' };
  return match.matchType === 'vector' ? { status: 'passed' } : { status: 'failed', reason: 'lexical-fallback' };
}
