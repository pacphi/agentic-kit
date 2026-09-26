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

// TEMPORARY (remove once fixed upstream; tracked by pacphi/agentic-kit#240): on a live
// RVF lock, agentic-qe <= 3.14.3 logs the busy warning, then falls through to a create
// attempt that fails with FsyncFailed; store and lock are untouched (agentic-qe#574,
// partial fix in PR #719). Only that exact sequence is contention. The middle line is
// emitted solely by AQE's live-owner quarantine refusal, so a bare FsyncFailed, or a
// lock warning plus FsyncFailed without it, still fails below. Remove this rule and
// its test when the AQE release carrying #719 (or an equivalent fix) is the kit floor.
const LIVE_OWNER_CONTENTION = [
  /is locked by a live process/,
  /is unusable but its lock is held by a live process/,
  /FsyncFailed|0x0303/,
];

export function classifyAqeStartup(result) {
  if (result.code !== 0) return { status: 'failed', reason: 'AQE command failed' };
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const contention = LIVE_OWNER_CONTENTION.every(line => line.test(output));
  if (!contention && /FsyncFailed|0x0303/.test(output)) return { status: 'failed', reason: 'RVF backend failed' };
  if (/prewarm failed|Transformer initialization previously failed|Embedding model failed|semantic embedding unavailable/i.test(output)) {
    return { status: 'degraded', reason: 'Embedding initialization failed' };
  }
  if (contention) {
    return { status: 'busy', reason: 'RVF is held by another live process; its FsyncFailed came from an AQE create attempt during contention (agentic-qe#574), not a storage error; SQLite fallback observed; owner health and RVF integrity unverified' };
  }
  if (/locked by a live process|lock is held by a live process/.test(output)) {
    return { status: 'busy', reason: 'RVF is held by another live process; SQLite fallback observed; owner health and RVF integrity unverified' };
  }
  return { status: 'observed', reason: 'Command completed; embedding and fleet readiness require separate proofs' };
}

export async function probeAqeBrowser({ runner }) {
  const cli = await runner('vibium', ['--version'], { timeout: 5_000 });
  if (cli.code !== 0) return { status: 'unavailable' };
  const payload = await runner('vibium', ['is-installed'], { timeout: 5_000 });
  return { status: payload.code === 0 ? 'payload-present' : 'missing-payload' };
}
