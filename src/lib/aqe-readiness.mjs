// Cheap capability observations. Configuration is never a live readiness proof.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { aqeRoot } from './paths.mjs';

export function aqeEmbeddingConfiguration({ packageRoot = aqeRoot(), env = process.env } = {}) {
  if (!fs.existsSync(path.join(packageRoot, 'package.json'))) return { status: 'unavailable', backend: null };
  if (typeof env.AQE_EMBEDDER_ENDPOINT === 'string' && env.AQE_EMBEDDER_ENDPOINT.trim()) {
    const endpoint = env.AQE_EMBEDDER_ENDPOINT;
    try {
      if (endpoint.startsWith('unix:')) {
        if (!path.isAbsolute(endpoint.slice(5))) throw new Error('invalid endpoint');
      } else {
        const url = new URL(endpoint);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid endpoint');
      }
      return { status: 'configured-unverified', backend: 'endpoint' };
    } catch { return { status: 'invalid-endpoint', backend: 'endpoint' }; }
  }
  try {
    createRequire(path.join(packageRoot, 'package.json')).resolve('@huggingface/transformers');
    return { status: 'configured-unverified', backend: 'in-process' };
  } catch { return { status: 'missing-backend', backend: null }; }
}

export function classifyAqeStartup(result) {
  if (result.code !== 0) return { status: 'failed', reason: 'AQE command failed' };
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (/locked by a live process|lock is held by a live process/.test(output)) {
    return { status: 'degraded', reason: 'RVF is held by another live process; this probe used SQLite fallback (no corruption inferred)' };
  }
  if (/FsyncFailed|0x0303/.test(output)) return { status: 'failed', reason: 'RVF backend failed' };
  if (/prewarm failed|Transformer initialization previously failed|Embedding model failed|semantic embedding unavailable/i.test(output)) {
    return { status: 'degraded', reason: 'Embedding initialization failed' };
  }
  return { status: 'observed', reason: 'Command completed; embedding and fleet readiness require separate proofs' };
}

export async function probeAqeBrowser({ runner }) {
  const cli = await runner('vibium', ['--version'], { timeout: 5_000 });
  if (cli.code !== 0) return { status: 'unavailable' };
  const payload = await runner('vibium', ['is-installed'], { timeout: 5_000 });
  return { status: payload.code === 0 ? 'payload-present' : 'missing-payload' };
}
