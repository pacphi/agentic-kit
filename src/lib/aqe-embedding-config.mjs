// Persist intent, never credentials. Legacy installs stay unmanaged until setup.
import path from 'node:path';

export const LOCAL_AQE_ENDPOINT = 'http://127.0.0.1:11434';
export const AQE_EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const OLLAMA_EMBEDDING_MODEL = 'all-minilm:22m';

export function isLoopbackEndpoint(endpoint) {
  try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(endpoint).hostname); }
  catch { return false; }
}

export function validateEmbeddingEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length > 2048 || (/\s/.test(endpoint) || [...endpoint].some(char => char.charCodeAt(0) < 32))) {
    throw new TypeError('AQE embedding endpoint must be a bounded URL or absolute Unix socket');
  }
  if (endpoint.startsWith('unix:')) {
    const socket = endpoint.slice(5);
    if (!path.isAbsolute(socket) || socket.split(/[\\/]/).includes('..')) throw new TypeError('AQE Unix socket must be absolute without traversal');
    return endpoint;
  }
  let url;
  try { url = new URL(endpoint); } catch { throw new TypeError('Invalid AQE embedding endpoint'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.search || url.hash || url.pathname !== '/' || (url.protocol === 'http:' && !isLoopbackEndpoint(endpoint))) {
    throw new TypeError('AQE endpoint requires HTTPS or loopback HTTP, without credentials, path, query or fragment');
  }
  return endpoint;
}

/** @typedef {{mode: string, endpoint?: string, provisioning?: string}} AqeEmbeddingIntent */
/** @param {AqeEmbeddingIntent} [intent] @returns {AqeEmbeddingIntent} */
export function validateAqeEmbeddingIntent(intent = { mode: 'unmanaged' }) {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)
    || !['unmanaged', 'endpoint', 'in-process'].includes(intent.mode)
    || Object.keys(intent).some(k => !['mode', 'endpoint', 'provisioning'].includes(k))) {
    throw new TypeError('aqeEmbedding requires mode unmanaged, endpoint, or in-process; credentials are environment-only');
  }
  if (intent.mode !== 'endpoint') {
    if (intent.endpoint !== undefined || intent.provisioning !== undefined) throw new TypeError('Only endpoint mode accepts endpoint/provisioning');
    return intent;
  }
  validateEmbeddingEndpoint(intent.endpoint);
  if (intent.provisioning !== undefined && !['external', 'ollama'].includes(intent.provisioning)) {
    throw new TypeError('aqeEmbedding provisioning must be external or ollama');
  }
  if (intent.provisioning === 'ollama' && (!intent.endpoint.startsWith('http:') || !isLoopbackEndpoint(intent.endpoint))) {
    throw new TypeError('Ollama provisioning requires a loopback HTTP endpoint');
  }
  return intent;
}

/** Explicit setup selection; never called implicitly by status/sync. */
export function selectAqeEmbeddingIntent(cfg, env = process.env) {
  const existing = validateAqeEmbeddingIntent(cfg.aqeEmbedding);
  if (cfg.aqeEmbedding !== undefined) return { ...existing };
  if (env.AQE_EMBEDDER_ENDPOINT) return validateAqeEmbeddingIntent({
    mode: 'endpoint', endpoint: env.AQE_EMBEDDER_ENDPOINT, provisioning: 'external',
  });
  return { mode: 'endpoint', endpoint: LOCAL_AQE_ENDPOINT, provisioning: 'ollama' };
}

/** Selected Kit intent wins only for Kit children; callers can report ambient drift. */
export function resolveAqeEmbedding(cfg, env = process.env) {
  const intent = validateAqeEmbeddingIntent(cfg.aqeEmbedding);
  const childEnv = { ...env };
  if (intent.mode === 'endpoint') childEnv.AQE_EMBEDDER_ENDPOINT = intent.endpoint;
  if (intent.mode === 'in-process') childEnv.AQE_EMBEDDER_ENDPOINT = '';
  return { ...intent, env: childEnv,
    ambientConflict: intent.mode !== 'unmanaged' && !!env.AQE_EMBEDDER_ENDPOINT
      && childEnv.AQE_EMBEDDER_ENDPOINT !== env.AQE_EMBEDDER_ENDPOINT };
}
