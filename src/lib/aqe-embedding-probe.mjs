// Observe AQE's installed runtime without writing the project's memory stores.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { run } from './exec.mjs';

const CHILD = fileURLToPath(new URL('./aqe-embedding-probe-child.mjs', import.meta.url));
const REASONS = new Set(['dimension-mismatch', 'semantic-smoke-failed', 'invalid-vectors',
  'runtime-identity-unavailable', 'authentication-failed', 'model-unavailable', 'endpoint-unreachable',
  'endpoint-timeout', 'local-model-unavailable', 'backend-unavailable', 'embedding-probe-failed']);

function validEndpoint(endpoint) {
  try {
    if (endpoint.startsWith('unix:')) return endpoint.slice(5).startsWith('/') && !endpoint.includes('\0');
    const url = new URL(endpoint);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      && !url.search && !url.hash && url.pathname === '/';
  } catch { return false; }
}

function validEvidence(evidence) {
  return evidence.status === 'passed' && evidence.dimension === 384
    && /^[a-f0-9]{16}$/.test(evidence.fingerprint) && /^[a-f0-9]{64}$/.test(evidence.spaceId)
    && Number.isFinite(evidence.relatedSimilarity) && Number.isFinite(evidence.unrelatedSimilarity);
}

/** @param {{packageRoot?:string,env?:NodeJS.ProcessEnv,timeoutMs?:number,backend?:string,allowDownload?:boolean,corpusPath?:string,modelCacheDir?:string}} options */
export async function probeAqeEmbeddings({ packageRoot, env = process.env, timeoutMs = 30_000,
  backend = 'endpoint', allowDownload = false, corpusPath, modelCacheDir }) {
  const endpoint = env.AQE_EMBEDDER_ENDPOINT;
  if (backend === 'endpoint' && !endpoint) return { status: 'not-configured', reason: 'embedding-endpoint-not-configured' };
  if (!['endpoint', 'in-process'].includes(backend)) return { status: 'invalid-config', reason: 'unsupported-backend' };
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) {
    return { status: 'invalid-config', reason: 'timeout-must-be-between-1-and-30000-ms' };
  }
  if (backend === 'endpoint' && !validEndpoint(endpoint)) return { status: 'invalid-config', reason: 'embedding-endpoint-invalid' };
  if ([corpusPath, modelCacheDir].some(value => value !== undefined && (typeof value !== 'string' || !path.isAbsolute(value)))) {
    return { status: 'invalid-config', reason: 'probe-path-must-be-absolute' };
  }
  if (typeof packageRoot !== 'string' || !path.isAbsolute(packageRoot)) return { status: 'unavailable', reason: 'aqe-package-root-unavailable' };
  if (!fs.existsSync(path.join(packageRoot, 'dist/learning/real-embeddings.js'))) return { status: 'unavailable', reason: 'aqe-embedding-runtime-unavailable' };
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-aqe-probe-'));
  const started = Date.now();
  try {
    const result = await run(process.execPath, [CHILD], {
      input: JSON.stringify({ packageRoot, endpoint, token: env.AQE_EMBEDDER_TOKEN,
        backend, allowDownload, corpusPath, modelCacheDir }),
      cwd: temporary, timeout: timeoutMs, maxBuffer: 64 * 1024,
      env: { ...Object.fromEntries(Object.keys(process.env).map(key => [key, undefined])),
        PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: temporary,
        USERPROFILE: temporary, AQE_MEMORY_PATH: path.join(temporary, 'memory.db') },
    });
    const elapsedMs = Date.now() - started;
    if (result.code !== 0) return { status: 'failed', reason: 'probe-process-failed-or-timed-out', elapsedMs };
    try {
      const line = result.stdout.split('\n').findLast(row => row.startsWith('AK_EMBEDDING_PROBE='));
      const evidence = JSON.parse(line.slice('AK_EMBEDDING_PROBE='.length));
      let outcome;
      if (validEvidence(evidence)) {
        outcome = { status: 'passed', dimension: 384, fingerprint: evidence.fingerprint, spaceId: evidence.spaceId,
          relatedSimilarity: evidence.relatedSimilarity, unrelatedSimilarity: evidence.unrelatedSimilarity, elapsedMs };
      } else outcome = { status: 'failed', reason: REASONS.has(evidence.reason) ? evidence.reason : 'invalid-probe-result', elapsedMs };
      if (corpusPath && evidence.corpus) outcome.corpus = evidence.corpus;
      return outcome;
    } catch { return { status: 'failed', reason: 'invalid-probe-result', elapsedMs }; }
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
