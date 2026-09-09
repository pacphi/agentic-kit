// Run AQE's installed endpoint client in a bounded child. No ReasoningBank,
// database, local model import, or fallback participates in this check.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { run } from './exec.mjs';

const CHILD = `
let client;
let result;
try {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const cfg = JSON.parse(input);
  const { EmbedderEndpointClient } = await import(cfg.module);
  client = new EmbedderEndpointClient({ endpoint: cfg.endpoint, token: cfg.token,
    model: 'Xenova/all-MiniLM-L6-v2', expectedDim: 384,
    connectTimeoutMs: Math.min(5000, cfg.timeoutMs), requestTimeoutMs: Math.min(10000, cfg.timeoutMs) });
  const identity = await client.probe();
  const vectors = await client.embed([
    'The cat is sitting on the mat.',
    'A kitten rests on a rug.',
    'Database transactions require atomic commit guarantees.',
  ]);
  if (identity.dim !== 384) throw Error('dim mismatch');
  if (!Array.isArray(vectors) || vectors.length !== 3
      || vectors.some(v => !Array.isArray(v) || v.length !== 384
        || v.some(n => !Number.isFinite(n)) || !v.some(n => n !== 0))) throw Error('invalid vectors');
  const cosine = (a, b) => a.reduce((s, n, i) => s + n * b[i], 0)
    / Math.sqrt(a.reduce((s, n) => s + n*n, 0) * b.reduce((s, n) => s + n*n, 0));
  const relatedSimilarity = cosine(vectors[0], vectors[1]);
  const unrelatedSimilarity = cosine(vectors[0], vectors[2]);
  if (relatedSimilarity <= unrelatedSimilarity + 0.05) throw Error('semantic smoke failed');
  if (!/^[a-f0-9]{16}$/.test(identity.fingerprint)) throw Error('invalid identity');
  result = { status: 'passed', dimension: 384, fingerprint: identity.fingerprint,
    relatedSimilarity, unrelatedSimilarity };
} catch (error) {
  const text = String(error?.message ?? '');
  result = { status: 'failed', reason: /dim(ension)? mismatch/i.test(text) ? 'dimension-mismatch'
    : /semantic smoke failed/.test(text) ? 'semantic-smoke-failed' : 'endpoint-probe-failed' };
} finally {
  try { client?.close(); } catch {}
}
process.stdout.write('AK_EMBEDDING_PROBE=' + JSON.stringify(result) + '\\n');
`;

/** Explicit endpoint only. Return bounded evidence, never raw subprocess errors. */
/** @param {{packageRoot:string,env?:NodeJS.ProcessEnv,timeoutMs?:number}} options */
export async function probeAqeEmbeddings({ packageRoot, env = process.env, timeoutMs = 30_000 }) {
  const endpoint = env.AQE_EMBEDDER_ENDPOINT;
  if (!endpoint) return { status: 'not-configured', reason: 'embedding-endpoint-not-configured' };
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) {
    return { status: 'invalid-config', reason: 'timeout-must-be-between-1-and-30000-ms' };
  }
  try {
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
        || url.search || url.hash || url.pathname !== '/') throw Error('invalid endpoint');
  } catch {
    return { status: 'invalid-config', reason: 'embedding-endpoint-must-be-an-http-origin-without-credentials' };
  }
  if (typeof packageRoot !== 'string' || !path.isAbsolute(packageRoot)) {
    return { status: 'unavailable', reason: 'aqe-package-root-unavailable' };
  }
  const moduleFile = path.join(packageRoot, 'dist', 'learning', 'embedder-endpoint-client.js');
  if (!fs.existsSync(moduleFile)) return { status: 'unavailable', reason: 'aqe-endpoint-client-unavailable' };
  const started = Date.now();
  const result = await run(process.execPath, ['--input-type=module', '-e', CHILD], {
    input: JSON.stringify({ module: pathToFileURL(moduleFile).href, endpoint,
      token: env.AQE_EMBEDDER_TOKEN, timeoutMs }),
    timeout: timeoutMs, maxBuffer: 64 * 1024,
    // No inherited NODE_OPTIONS preload or unrelated credentials enter this probe.
    env: { ...Object.fromEntries(Object.keys(process.env).map(key => [key, undefined])),
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
  });
  const elapsedMs = Date.now() - started;
  if (result.code !== 0) return { status: 'failed', reason: 'probe-process-failed-or-timed-out', elapsedMs };
  try {
    const line = result.stdout.split('\n').findLast(row => row.startsWith('AK_EMBEDDING_PROBE='));
    const evidence = JSON.parse(line.slice('AK_EMBEDDING_PROBE='.length));
    // Child output is allowlisted: upstream logs and endpoint strings stay private.
    if (evidence.status === 'passed' && evidence.dimension === 384
        && /^[a-f0-9]{16}$/.test(evidence.fingerprint)
        && Number.isFinite(evidence.relatedSimilarity) && Number.isFinite(evidence.unrelatedSimilarity)) {
      return { status: 'passed', dimension: 384, fingerprint: evidence.fingerprint,
        relatedSimilarity: evidence.relatedSimilarity, unrelatedSimilarity: evidence.unrelatedSimilarity, elapsedMs };
    }
    const reasons = ['dimension-mismatch', 'semantic-smoke-failed', 'endpoint-probe-failed'];
    return { status: 'failed', reason: reasons.includes(evidence.reason) ? evidence.reason : 'invalid-probe-result', elapsedMs };
  } catch {
    return { status: 'failed', reason: 'invalid-probe-result', elapsedMs };
  }
}
