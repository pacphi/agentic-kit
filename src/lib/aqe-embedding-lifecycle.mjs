// Provision only the explicitly selected local service. No daemon installation,
// model replacement, implicit endpoint discovery or corpus migration.
import { aqeRoot } from './paths.mjs';
import { probeAqeEmbeddings } from './aqe-embedding-probe.mjs';
import { resolveAqeEmbedding, AQE_EMBEDDING_MODEL, OLLAMA_EMBEDDING_MODEL } from './aqe-embedding-config.mjs';
import { aqeEmbeddingConfiguration } from './aqe-readiness.mjs';
import { have } from './exec.mjs';

const AQE_EMBEDDING_ALTERNATIVES = 'Alternatives: select an existing compatible endpoint, explicitly opt into in-process transformers, or leave semantic learning unmanaged. No hash fallback is substituted.';
export const AQE_EMBEDDING_COACHING = `Recommended: local Ollama + MiniLM (no API key). Install Ollama from https://ollama.com/download and start it (ollama serve), then retry. ${AQE_EMBEDDING_ALTERNATIVES}`;

// Printing the endpoint is safe: Ollama provisioning accepts only loopback HTTP
// without credentials, query or fragment (ADR-0055).
const ollamaNotRunning = endpoint => `Ollama is installed but not running at ${endpoint}. Start it (open the Ollama app, or run: ollama serve), then retry. ${AQE_EMBEDDING_ALTERNATIVES}`;

// Node's fetch rejects a refused connection with TypeError('fetch failed'); its cause
// (an AggregateError when `localhost` resolves to two addresses) carries the code.
const connectionRefused = error => error?.cause?.code === 'ECONNREFUSED';

/** Guidance for an unreachable selected local Ollama: "not running" only when the
 * `ollama` command is installed, otherwise the install text. The install check
 * runs only on this path, never for other failures or external endpoints. */
async function unreachableCoaching(resolved, ollamaInstalled) {
  return resolved.provisioning === 'ollama' && await ollamaInstalled()
    ? ollamaNotRunning(resolved.endpoint) : AQE_EMBEDDING_COACHING;
}

async function ollamaRequest(endpoint, route, body) {
  const response = await fetch(new URL(route, endpoint), {
    method: body ? 'POST' : 'GET', redirect: 'error',
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(route === '/api/pull' ? 180_000 : 10_000),
  });
  if (!response.ok) throw new Error('local-service-request-failed');
  const reader = response.body?.getReader();
  const chunks = [];
  let bytes = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 1_000_000) { await reader.cancel(); throw new Error('local-service-response-too-large'); }
      chunks.push(Buffer.from(value));
    }
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const data = text ? JSON.parse(text) : {};
  if (data.error) throw new Error('local-service-reported-error');
  return data;
}

async function prepareLocalModel(request) {
  const tags = await request('/api/tags');
  if (!Array.isArray(tags.models)) throw new Error('invalid-model-inventory');
  const names = new Set(tags.models.map(model => model.name));
  if (names.has(AQE_EMBEDDING_MODEL) || names.has(`${AQE_EMBEDDING_MODEL}:latest`)) return false;
  if (!names.has(OLLAMA_EMBEDDING_MODEL)) {
    await request('/api/pull', { model: OLLAMA_EMBEDDING_MODEL, stream: false });
  }
  // Re-read immediately before creating the alias: never replace a foreign one.
  // The service owns atomicity; this is not a distributed compare-and-swap claim.
  const fresh = await request('/api/tags');
  if (!Array.isArray(fresh.models)) throw new Error('invalid-model-inventory');
  if (fresh.models.some(model => [AQE_EMBEDDING_MODEL, `${AQE_EMBEDDING_MODEL}:latest`].includes(model.name))) return true;
  await request('/api/copy', { source: OLLAMA_EMBEDDING_MODEL, destination: AQE_EMBEDDING_MODEL });
  return true;
}

/** Explicit setup/sync mutation boundary, injectable external operations for tests.
 * @param {any} cfg
 * @param {{env?:NodeJS.ProcessEnv,packageRoot?:string,provision?:boolean,request?:(route:string,body?:any)=>Promise<any>,probe?:typeof probeAqeEmbeddings,ollamaInstalled?:()=>Promise<boolean>}} [options] */
export async function prepareAqeEmbedding(cfg, {
  env = process.env, packageRoot = aqeRoot(), provision = true,
  request, probe = probeAqeEmbeddings, ollamaInstalled = () => have('ollama'),
} = {}) {
  const resolved = resolveAqeEmbedding(cfg, env);
  if (!provision && resolved.mode === 'unmanaged') {
    const observed = aqeEmbeddingConfiguration({ packageRoot, env });
    if (env.AQE_EMBEDDER_ENDPOINT) resolved.mode = 'endpoint';
    else if (observed.backend === 'in-process') resolved.mode = 'in-process';
  }
  if (cfg.aqe === false || resolved.mode === 'unmanaged') {
    return { ok: true, changed: false, status: 'skipped', detail: 'embeddings unmanaged; semantic readiness not established' };
  }
  let changed = false;
  if (provision && resolved.provisioning === 'ollama') {
    try {
      changed = await prepareLocalModel(request ?? ((route, body) => ollamaRequest(resolved.endpoint, route, body)));
    } catch (error) {
      // Only the refused-connection code is read; raw service text is never reflected.
      const coaching = connectionRefused(error) ? await unreachableCoaching(resolved, ollamaInstalled) : AQE_EMBEDDING_COACHING;
      return { ok: false, changed, status: 'failed', detail: `Local embedding setup incomplete. ${coaching}` };
    }
  }
  const evidence = await probe({ packageRoot, env: resolved.env, backend: resolved.mode });
  if (evidence.status === 'passed') {
    return { ok: true, changed, status: 'ok', evidence,
      detail: 'synthetic embedding probe passed (384 dimensions); existing corpus compatibility remains separate' };
  }
  const coaching = evidence.reason === 'endpoint-unreachable'
    ? await unreachableCoaching(resolved, ollamaInstalled) : AQE_EMBEDDING_COACHING;
  return { ok: false, changed, status: 'failed', evidence,
    detail: `Embedding setup incomplete: ${evidence.reason ?? evidence.status}. ${coaching}` };
}
